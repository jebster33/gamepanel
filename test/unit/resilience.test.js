'use strict';

// What happens when things go wrong: a cut-short state file, a full disk, a malformed URL.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../../server/core/store');
const { Router } = require('../../server/api/router');
const { HttpError } = require('../../server/core/util');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-resilience-'));

test('a cut-short state file is restored from the previous save, not replaced by an empty panel', () => {
  const dir = tmp();
  const file = path.join(dir, 'panel.json');
  const first = new Store(file);
  first.state.users.push({ id: 'u1', username: 'chris', role: 'admin' });
  first.saveNow();
  first.state.servers.push({ id: 's1', name: 'Survival' });
  first.saveNow();
  // A power cut mid-write used to leave this, and the panel came back with no accounts (first-run setup open again).
  fs.writeFileSync(file, '{"users": [{"id": "u1", "usern');
  const again = new Store(file);
  assert.equal(again.state.users[0]?.username, 'chris');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('panel.json.corrupt.')), 'the broken file is kept for a look');
});

test('a state file that is valid JSON but not an object is treated as broken', () => {
  const dir = tmp();
  const file = path.join(dir, 'panel.json');
  const first = new Store(file);
  first.state.users.push({ id: 'u1', username: 'chris', role: 'admin' });
  first.saveNow();
  first.saveNow();
  fs.writeFileSync(file, 'null');
  assert.equal(new Store(file).state.users.length, 1);
});

test('lists in a hand-edited state file are repaired so the rest of the panel can walk them', () => {
  const dir = tmp();
  const file = path.join(dir, 'panel.json');
  fs.writeFileSync(file, JSON.stringify({ users: {}, servers: null }));
  const store = new Store(file);
  assert.deepEqual(store.state.users, []);
  assert.deepEqual(store.state.servers, []);
});

test('a failed save is remembered for the health check and cleared by the next good one', () => {
  const dir = tmp();
  const file = path.join(dir, 'panel.json');
  const store = new Store(file);
  // Make the temp-file path a directory so the write fails the way a full or read-only disk would.
  fs.mkdirSync(store.tmp);
  store.saveNow();
  assert.ok(store.lastWriteError);
  fs.rmdirSync(store.tmp);
  store.saveNow();
  assert.equal(store.lastWriteError, null);
});

test('the state file and its backup are private to the panel account', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const file = path.join(dir, 'panel.json');
  const store = new Store(file);
  store.saveNow();
  store.saveNow();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file + '.bak').mode & 0o777, 0o600);
});

test('a malformed percent-escape in a route is a 400, not a server error', () => {
  const router = new Router();
  router.get('/api/servers/:id', () => ({}));
  assert.throws(
    () => router.match('GET', '/api/servers/%E0%A4%A'),
    (err) => err instanceof HttpError && err.code === 400
  );
});

test('files a game plants in its folder (pipes, links) cannot hang or mislead the panel', { skip: process.platform === 'win32' }, () => {
  const { spawnSync } = require('child_process');
  const dir = tmp();
  const srv = path.join(dir, 'srv');
  fs.mkdirSync(path.join(srv, 'crash-reports'), { recursive: true });
  spawnSync('mkfifo', [path.join(srv, 'server.properties')]);
  spawnSync('mkfifo', [path.join(srv, 'crash-reports', 'a.txt')]);
  // Run in a child with a timeout: before the fix these calls never returned.
  const code = `
    process.env.GP_DATA_DIR = ${JSON.stringify(path.join(dir, 'data'))};
    const server = { dir: ${JSON.stringify(srv)} };
    const { readMotd } = require(${JSON.stringify(path.join(__dirname, '../../server/features/status-page.js'))});
    const doctor = require(${JSON.stringify(path.join(__dirname, '../../server/servers/doctor.js'))});
    if (readMotd(server) !== null) process.exit(2);
    if (doctor.latestCrashReport(server) !== '') process.exit(3);
  `;
  const r = spawnSync(process.execPath, ['-e', code], { timeout: 8000 });
  assert.equal(r.status, 0, `exit ${r.status} ${r.signal || ''} ${r.stderr}`);
});

test('a session token with anything appended is not a session, and a cookie with a stray % does not throw', () => {
  const { Store: S } = require('../../server/core/store');
  const { Auth } = require('../../server/core/auth');
  const auth = new Auth(new S(), 'test-secret-test-secret-test-secret');
  const user = auth.createUser({ username: 'chris', password: 'correct horse battery', role: 'admin' });
  const { token } = auth.startSession(user, '127.0.0.1');
  assert.ok(auth.userFromToken(token));
  assert.equal(auth.userFromToken(token + '.x'), null);
  assert.doesNotThrow(() => auth.userFromRequest({ headers: { cookie: 'a=%E0%A4%A; b=1' }, method: 'GET', url: '/api/x' }));
});

test('RCON: a negative or silly packet size ends the call instead of spinning forever', async () => {
  const net = require('net');
  const { rconCommand } = require('../../server/games/rcon');
  const server = net.createServer((sock) => {
    sock.on('data', () => {
      const b = Buffer.alloc(12);
      b.writeInt32LE(-4, 0);
      b.writeInt32LE(1, 4);
      b.writeInt32LE(2, 8);
      sock.write(b);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await assert.rejects(rconCommand({ host: '127.0.0.1', port: server.address().port, password: 'x', command: 'list', timeout: 1000 }), /Malformed RCON/);
  server.close();
});

test('a body that is not a JSON object is a 400', async () => {
  const { readJson } = require('../../server/core/util');
  const { Readable } = require('stream');
  for (const text of ['null', '[]', '1', '"x"']) {
    const req = Readable.from([Buffer.from(text)]);
    req.headers = {};
    await assert.rejects(readJson(req), (e) => e.code === 400);
  }
});

test('removing a server twice at once leaves the other servers alone', async () => {
  const { ServerManager } = require('../../server/servers/manager');
  const m = Object.create(ServerManager.prototype);
  const mine = { id: 'a' };
  const other = { id: 'b' };
  m.store = { state: { servers: [mine, other] }, save() {}, addEvent() {} };
  m.require = (id) => m.store.state.servers.find((s) => s.id === id) || mine;
  m.isActive = () => false;
  m.killTree = () => {};
  m.dockerAvailable = true;
  m.cleanupContainers = () => new Promise((r) => setTimeout(r, 30));
  m.runtime = new Map();
  m.deleteHistory = m.dropMetricHistory = m.forgetServerEverywhere = m.broadcastServers = () => {};
  const results = await Promise.allSettled([m.remove('a', false), m.remove('a', false)]);
  assert.deepEqual(m.store.state.servers, [other]);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
});
