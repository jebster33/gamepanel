'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-afm-data-'));
const { checkPatch, inBareWord } = require('../../server/servers/untrusted');
const { hsts, addSubscription, MAX_SUBSCRIPTIONS } = require('../../server/api/helpers');
const { Nodes } = require('../../server/features/nodes');
const options = require('../../server/games/options');
const ssh = require('../../server/core/ssh');
const { makeApp } = require('./support/routes');

test('a setting that sits unquoted in the start command cannot carry extra game arguments', () => {
  const template = {
    startCommand: './game +map {{MAP}} -name "{{SERVER_NAME}}" -pw {{PASS}} -motd \'{{MOTD}}\'',
    variables: [{ name: 'MAP' }, { name: 'PASS' }, { name: 'MOTD' }, { name: 'NOTE' }],
  };
  assert.deepStrictEqual(['MAP', 'SERVER_NAME', 'PASS', 'MOTD', 'NOTE'].map((n) => inBareWord(template, n)), [true, false, true, false, false]);
  const base = { name: 'x', vars: {} };
  assert.throws(() => checkPatch(template, { vars: { MAP: 'de_dust2 +rcon_password hunter2' } }, base), /single argument/);
  assert.throws(() => checkPatch(template, { vars: { PASS: 'a b' } }, base), /single argument/);
  assert.doesNotThrow(() => checkPatch(template, { vars: { MAP: 'de_dust2' } }, base));
  // Quoted, or not on the command line at all: spaces are fine.
  assert.doesNotThrow(() => checkPatch(template, { name: 'My Survival World', vars: { MOTD: 'Hello there', NOTE: 'a b c' } }, base));
  // A bare server name is held to it as well.
  const bare = { startCommand: './game -name {{SERVER_NAME}}', variables: [] };
  assert.throws(() => checkPatch(bare, { name: 'My World' }, base), /single argument/);
  assert.doesNotThrow(() => checkPatch(bare, { name: 'MyWorld' }, base));
  // A Windows-only start command counts too.
  const win = { startCommand: 'x "{{A}}"', windows: { startCommand: 'g.exe {{A}}' }, variables: [{ name: 'A' }] };
  assert.strictEqual(inBareWord(win, 'A'), true);
});

test('Strict-Transport-Security goes out over HTTPS only', () => {
  assert.strictEqual(hsts({ socket: { encrypted: true }, headers: {} }), 'max-age=31536000');
  assert.strictEqual(hsts({ socket: {}, headers: {} }), null);
  // Behind a proxy it is only believed when the panel was told it is behind one (see isSecure).
  assert.strictEqual(hsts({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }), null);
});

test('a WebSocket connection cannot subscribe to topics without end', () => {
  const conn = { subscriptions: new Set(['servers', 'stats']) };
  let accepted = 0;
  for (let i = 0; i < 500; i++) if (addSubscription(conn, `console:${i}`)) accepted++;
  assert.strictEqual(conn.subscriptions.size, MAX_SUBSCRIPTIONS);
  assert.strictEqual(accepted, MAX_SUBSCRIPTIONS - 2);
  assert.strictEqual(addSubscription(conn, 'servers'), true, 'one it already has is fine');
  assert.strictEqual(addSubscription(conn, 'x'.repeat(500)), false);
  assert.strictEqual(addSubscription(conn, { a: 1 }), false);
  conn.subscriptions.delete('console:1');
  assert.strictEqual(addSubscription(conn, 'console:new'), true, 'room again after an unsubscribe');
});

test('the option-list cache stays bounded however many searches are made', () => {
  for (let i = 0; i < options.MAX_CACHED * 3; i++) options.remember(`modrinth:search ${i}`, { options: [] });
  assert.strictEqual(options.cacheSize(), options.MAX_CACHED);
  options.remember('modrinth:search 5', { options: [1] });
  assert.strictEqual(options.cacheSize(), options.MAX_CACHED, 'replacing one does not grow it');
});

/** A node that answers with JSON, chunked and without a length, and a panel in front of it. */
async function proxyOf(payload) {
  const remote = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    for (let i = 0; i < payload.length; i += 65536) res.write(payload.subarray(i, i + 65536));
    res.end();
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  const app = makeApp();
  const nodes = new Nodes({ store: app.store, manager: { servers: [] }, wss: {} });
  const node = { id: 'n1', name: 'Home', url: `http://127.0.0.1:${remote.address().port}`, key: 'gp_k' };
  const front = http.createServer((req, res) => nodes.proxy(req, res, node, '/api/servers/a'));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${front.address().port}/`);
  const body = Buffer.from(await res.arrayBuffer());
  remote.close();
  front.close();
  return { res, body };
}

test('the node proxy rewrites small JSON answers, and passes a huge one through instead of holding it', async () => {
  const small = Buffer.from(JSON.stringify({ server: { id: 'a', templateId: 't', status: 'running' } }));
  const out = await proxyOf(small);
  assert.strictEqual(JSON.parse(out.body).server.id, 'n1~a', 'the id now names its node');

  const big = Buffer.from(JSON.stringify({ blob: crypto.randomBytes(6 * 1024 * 1024).toString('base64') }));
  const huge = await proxyOf(big);
  assert.ok(huge.body.equals(big), 'every byte arrives, untouched');
  assert.strictEqual(huge.res.headers.get('content-length'), null, 'it was streamed on, not buffered into one answer');
});

test('connections that have not signed in cannot take every SFTP slot', async () => {
  const server = ssh.createServer({ hostKey: crypto.generateKeyPairSync('ed25519').privateKey, authenticate: async () => { throw new Error('no'); }, subsystem: () => null, maxUnauth: 4, maxUnauthPerIp: 2, maxTotal: 100 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const open = () => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('data', () => resolve({ socket, alive: true }));
    socket.on('close', () => resolve({ socket, alive: false }));
    socket.on('error', () => {});
  });
  try {
    const first = [await open(), await open()];
    assert.deepStrictEqual(first.map((c) => c.alive), [true, true]);
    const third = await open();
    assert.strictEqual(third.alive, false, 'a third idle connection from one address is turned away');
    // Closing one frees its place.
    first[0].socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const again = await open();
    assert.strictEqual(again.alive, true);
    again.socket.destroy();
    first[1].socket.destroy();
  } finally {
    server.close();
  }
});
