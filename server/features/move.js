'use strict';

/**
 * Moving a server to another node (or back here). The panel you are using
 * runs the move: it stops the server, streams its export from where it is to
 * where it goes (never storing it in between), and removes the original once
 * the copy has arrived, unless asked to keep it.
 *
 * Any direction works: this machine → node, node → this machine, node → node.
 * The new server gets free ports on its new machine, so players need the new
 * address.
 */

const http = require('http');
const https = require('https');
const { fail, logger } = require('../core/util');
const { STATUS } = require('../servers/constants');

const STOP_WAIT_MS = 3 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A streaming request to a node: `body` is a readable stream or nothing; resolves with the response stream. */
function nodeStream(node, method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, node.url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method,
      headers: { Authorization: `Bearer ${node.key}`, Accept: '*/*', ...(body ? { 'Content-Type': 'application/gzip', 'Transfer-Encoding': 'chunked' } : {}), ...extraHeaders },
    });
    // Big worlds take a while; only give up when nothing moves for 10 minutes.
    req.setTimeout(10 * 60_000, () => req.destroy(new Error('the node stopped answering')));
    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let message = `HTTP ${res.statusCode}`;
          try {
            message = JSON.parse(Buffer.concat(chunks).toString('utf8')).error || message;
          } catch {
            /* not JSON */
          }
          reject(new Error(`${node.name}: ${message}`));
        });
        return;
      }
      resolve(res);
    });
    req.on('error', (err) => reject(new Error(`${node.name}: ${err.message}`)));
    if (body) {
      body.on('error', (err) => req.destroy(err));
      body.pipe(req);
    } else req.end();
  });
}

const readJson = (res) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    res.on('error', reject);
  });

/** Where a server is: here, or on a node. */
function locate(app, id) {
  const remote = app.manager.nodes?.parseId(id);
  if (remote) return { node: remote.node, id: remote.remoteId };
  const server = app.manager.servers.find((s) => s.id === id);
  if (!server) fail(404, 'Server not found');
  return { node: null, id: server.id, server };
}

async function stopAndWait(app, where) {
  if (!where.node) {
    if (!app.manager.isActive(where.id)) return;
    await app.manager.stop(where.id);
    const until = Date.now() + STOP_WAIT_MS;
    while (app.manager.isActive(where.id) && Date.now() < until) await sleep(1000);
    if (app.manager.isActive(where.id)) fail(409, 'The server did not stop, so it was not moved');
    return;
  }
  const nodes = app.manager.nodes;
  const status = async () => (await nodes.request(where.node, 'GET', `/api/servers/${encodeURIComponent(where.id)}`)).data?.server?.status;
  if (![STATUS.RUNNING, STATUS.STARTING].includes(await status())) return;
  await nodes.request(where.node, 'POST', `/api/servers/${encodeURIComponent(where.id)}/power`, { action: 'stop' });
  const until = Date.now() + STOP_WAIT_MS;
  while (Date.now() < until) {
    await sleep(2000);
    if (![STATUS.RUNNING, STATUS.STARTING, STATUS.STOPPING].includes(await status())) return;
  }
  fail(409, 'The server did not stop, so it was not moved');
}

/** Start a move. Resolves when it is under way; the result arrives as an event. */
function start(app, { serverId, to, keepSource = false }, actor) {
  const from = locate(app, serverId);
  const nodes = app.manager.nodes;
  const target = to === 'local' ? null : nodes?.list.find((n) => n.id === to);
  if (to !== 'local' && !target) fail(400, 'Pick the node to move it to');
  if ((from.node?.id || null) === (target?.id || null)) fail(400, 'The server is already there');
  if (moving.has(serverId)) fail(409, 'This server is already being moved');
  const name = from.server?.name || nodes.remoteServers().find((s) => s.id === serverId)?.name || serverId;
  const where = target ? target.name : nodes?.localName || 'this machine';
  moving.add(serverId);
  run(app, { from, target, keepSource, name, where }, actor)
    .catch((err) => {
      logger.warn(`Moving ${name} failed: ${err.message}`);
      app.store.addEvent('server.move_failed', `Moving ${name} to ${where} failed: ${err.message}`, from.server ? { serverId: from.id } : {});
      if (from.server) {
        app.manager.setTask?.(from.server, null);
        app.manager.pushConsole(from.server, `Move to ${where} failed: ${err.message}. The server is still here.`, 'system');
      }
    })
    .finally(() => moving.delete(serverId));
  return { started: true, name, to: where };
}

const moving = new Set();

async function run(app, { from, target, keepSource, name, where }, actor) {
  const { manager, store } = app;
  const nodes = manager.nodes;
  const note = (text) => from.server && manager.pushConsole(from.server, text, 'system');
  if (from.server) manager.setTask?.(from.server, `Moving to ${where}`);

  note(`Moving to ${where}: stopping the server…`);
  await stopAndWait(app, from);

  // The export, as a stream: from this machine's tar, or from the node.
  note('Sending the files…');
  let source;
  let proc = null;
  if (from.node) source = await nodeStream(from.node, 'GET', `/api/servers/${encodeURIComponent(from.id)}/export?move=1`);
  else {
    ({ proc, stream: source } = await manager.exportStream(from.server, { unseal: true }));
  }

  let created;
  try {
    if (target) {
      const res = await nodeStream(target, 'POST', `/api/servers/receive?name=${encodeURIComponent(name)}`, source);
      created = { id: `${target.id}${require('./nodes').SEP}${(await readJson(res)).server.id}` };
    } else {
      const server = await manager.receiveServer(source, actor, { name });
      created = { id: server.id };
    }
  } catch (err) {
    proc?.kill();
    throw err;
  }

  // Arrived: retire the original.
  if (keepSource) {
    if (from.server) {
      manager.setTask?.(from.server, null);
      note(`Copied to ${where}. This one is kept, stopped.`);
    }
  } else if (from.node) {
    await nodes.request(from.node, 'DELETE', `/api/servers/${encodeURIComponent(from.id)}`).catch((err) => logger.warn(`Moved, but removing the original on ${from.node.name} failed: ${err.message}`));
  } else {
    manager.setTask?.(from.server, null);
    await manager.remove(from.id, true);
  }
  store.addEvent('server.moved', `${actor?.username || 'Someone'} moved ${name} to ${where}${keepSource ? ' (original kept)' : ''}`, { serverId: created.id });
  return created;
}

module.exports = { start, locate, nodeStream };
