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
