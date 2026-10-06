'use strict';

/**
 * Multi-node: one panel controlling servers on several machines.
 *
 * Every machine runs its own GamePanel. On the main one you add the others
 * as nodes (a name, its address and an administrator API key from that
 * panel's Account page). Their servers then show up here next to the local
 * ones, with ids like "<node>~<server id>", and every request for them is
 * passed through to the node that owns them.
 */

const http = require('http');
const https = require('https');
const os = require('os');
const { fail, uid, logger } = require('../core/util');

const POLL_MS = 3000;
const TIMEOUT_MS = 8000;
const SEP = '~';

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

class Nodes {
  constructor({ store, manager, wss }) {
    this.store = store;
    this.manager = manager;
    this.wss = wss;
    this.live = new Map(); // node id -> { online, error, servers, host, version, seen }
    this.timer = null;
  }

  get list() {
    return (this.store.state.settings.nodes ||= []);
  }

  /** What this machine is called in the panel. */
  get localName() {
    return this.store.state.settings.nodeName || os.hostname();
  }

  start() {
    const tick = () => this.pollAll().catch(() => {});
    this.timer = setInterval(tick, POLL_MS);
    this.timer.unref?.();
    tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  /* --------------------------------------------------------- settings -- */

  publicNode(node) {
    const live = this.live.get(node.id) || {};
    return {
      id: node.id,
      name: node.name,
      url: node.url,
      online: Boolean(live.online),
      error: live.error || null,
      version: live.version || null,
      host: live.host || null,
      servers: (live.servers || []).length,
      running: (live.servers || []).filter((s) => s.status === 'running').length,
      seen: live.seen || null,
    };
  }

  overview() {
    return { local: { name: this.localName, servers: this.manager.servers.length }, nodes: this.list.map((n) => this.publicNode(n)) };
  }

  cleanUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url || '').trim());
    } catch {
      fail(400, 'Enter the node address, like http://192.168.1.20:8080');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) fail(400, 'The address must start with http:// or https://');
    return parsed.origin;
  }

  async add({ name, url, key }) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) fail(400, 'Give the node a name');
    if (!/^gp_/.test(String(key || ''))) fail(400, 'Paste an API key from the other panel (Account page, API keys). It starts with gp_.');
    const node = { id: uid(6).replace(/[^A-Za-z0-9]/g, 'x'), name, url: this.cleanUrl(url), key: String(key).trim() };
    await this.request(node, 'GET', '/api/servers').catch((err) => fail(400, `Could not reach ${node.url}: ${err.message}`));
    this.list.push(node);
    this.store.save();
    await this.poll(node).catch(() => {});
    return this.publicNode(node);
  }

  update(id, body) {
    const node = this.require(id);
    if (body.name !== undefined) node.name = String(body.name).trim().slice(0, 40) || node.name;
    if (body.url !== undefined) {
      const url = this.cleanUrl(body.url);
      // The stored key is only ever sent to the address it was given for.
      if (url !== node.url && !body.key) fail(400, 'Changing the address needs the node\'s API key again');
      node.url = url;
    }
    if (body.key) node.key = String(body.key).trim();
    this.store.save();
    return this.publicNode(node);
  }

  remove(id) {
    this.require(id);
    this.store.state.settings.nodes = this.list.filter((n) => n.id !== id);
    this.live.delete(id);
    this.store.save();
    this.manager.broadcastServers();
  }

  require(id) {
    const node = this.list.find((n) => n.id === id);
    if (!node) fail(404, 'No such node');
    return node;
  }

  /* ------------------------------------------------------------ polling -- */

  async pollAll() {
    if (!this.list.length) return;
    const before = JSON.stringify([...this.live].map(([id, l]) => [id, l.online, (l.servers || []).map((s) => s.id + s.status + s.name)]));
    await Promise.all(this.list.map((n) => this.poll(n).catch(() => {})));
    const after = JSON.stringify([...this.live].map(([id, l]) => [id, l.online, (l.servers || []).map((s) => s.id + s.status + s.name)]));
    // The server list only goes out when something changed; numbers go out every time.
    if (before !== after) this.manager.broadcastServers();
    const stats = this.remoteServers().map((s) => ({ ...s, memoryLimit: s.memoryLimit }));
    if (stats.length) this.wss.broadcast('stats', { servers: stats });
  }

  async poll(node) {
    const live = this.live.get(node.id) || {};
    try {
      const [servers, system] = await Promise.all([this.request(node, 'GET', '/api/servers?local=1'), this.request(node, 'GET', '/api/system').catch(() => null)]);
      live.servers = servers.data?.servers || [];
      live.host = system?.data?.host ? { cpu: system.data.host.cpu?.percent, memory: system.data.host.memory, platform: system.data.host.platform } : live.host;
      live.version = system?.data?.version || live.version;
      if (!live.online) logger.info(`Node ${node.name} is online`);
      live.online = true;
      live.error = null;
      live.seen = Date.now();
    } catch (err) {
      if (live.online) logger.warn(`Node ${node.name} went offline: ${err.message}`);
      live.online = false;
      live.error = err.message;
    }
    this.live.set(node.id, live);
  }

  /** Servers on other machines, shaped like local ones but with node-qualified ids. */
  remoteServers() {
    const out = [];
    for (const node of this.list) {
      const live = this.live.get(node.id);
      for (const s of live?.servers || []) out.push(this.wrap(node, s, live.online));
    }
    return out;
  }

  wrap(node, server, online = true) {
    return { ...server, id: `${node.id}${SEP}${server.id}`, remoteId: server.id, node: { id: node.id, name: node.name, host: hostOf(node.url) }, status: online ? server.status : 'offline' };
  }

  /** "<node>~<id>" -> { node, remoteId }, or null for a local id. */
  parseId(id) {
    const i = String(id).indexOf(SEP);
    if (i < 0) return null;
    const node = this.list.find((n) => n.id === id.slice(0, i));
    return node ? { node, remoteId: id.slice(i + 1) } : null;
  }

  /* -------------------------------------------------------------- proxy -- */

  request(node, method, path, body) {
    return new Promise((resolve, reject) => {
      const target = new URL(path, node.url);
      const lib = target.protocol === 'https:' ? https : http;
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = lib.request(
        target,
        {
          method,
          timeout: TIMEOUT_MS,
          headers: { Authorization: `Bearer ${node.key}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let data = null;
            try {
              data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              data = null;
            }
            if (res.statusCode >= 400) reject(new Error(data?.error || `HTTP ${res.statusCode}`));
            else resolve({ status: res.statusCode, data });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (err) => reject(new Error(err.code === 'ECONNREFUSED' ? 'connection refused' : err.message)));
      if (payload) req.end(payload);
      else req.end();
    });
  }

  /**
   * Pass a browser request through to a node, streaming both ways so file
   * uploads, downloads and backups work too. Small JSON answers get their
   * server ids rewritten so links keep pointing at the right node.
   */
  proxy(req, res, node, path) {
    return new Promise((resolve) => {
      const target = new URL(path, node.url);
      const lib = target.protocol === 'https:' ? https : http;
      const headers = { Authorization: `Bearer ${node.key}`, Accept: req.headers.accept || '*/*' };
      for (const h of ['content-type', 'content-length', 'x-filename', 'range']) if (req.headers[h]) headers[h] = req.headers[h];
      const upstream = lib.request(target, { method: req.method, headers, timeout: 60_000 }, (up) => {
        const type = String(up.headers['content-type'] || '');
        const length = Number(up.headers['content-length'] || 0);
        if (type.includes('application/json') && length < 4 * 1024 * 1024) {
          const chunks = [];
          up.on('data', (c) => chunks.push(c));
          up.on('end', () => {
            let text = Buffer.concat(chunks).toString('utf8');
            try {
              const data = JSON.parse(text);
              if (data?.server?.id) data.server = this.wrap(node, data.server);
              if (Array.isArray(data?.servers)) data.servers = data.servers.map((s) => (s?.id && s.templateId ? this.wrap(node, s) : s));
              text = JSON.stringify(data);
            } catch {
              /* not JSON after all: pass it on untouched */
            }
            res.writeHead(up.statusCode, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
            res.end(text);
            resolve();
          });
          return;
        }
        const pass = {};
        for (const h of ['content-type', 'content-length', 'content-disposition', 'cache-control']) if (up.headers[h]) pass[h] = up.headers[h];
        res.writeHead(up.statusCode, pass);
        up.pipe(res);
        up.on('end', resolve);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('The node took too long to answer')));
      upstream.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Node ${node.name} is not reachable: ${err.message}` }));
        } else res.destroy();
        resolve();
      });
      req.pipe(upstream);
    });
  }
}

module.exports = { Nodes, SEP };
