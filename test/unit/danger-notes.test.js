'use strict';

/**
 * Destructive-action confirmation (2FA code) and server notes.
 * Runs a real API (routes, auth, manager) on a throwaway data folder.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-danger-'));

const { config } = require('../../server/core/config');
const { Store } = require('../../server/core/store');
const { Auth } = require('../../server/core/auth');
const { WebSocketServer } = require('../../server/core/ws');
const { TemplateRegistry } = require('../../server/games/templates');
const { ServerManager } = require('../../server/servers/manager');
const { Scheduler } = require('../../server/features/scheduler');
const { createApi } = require('../../server/api');
const { HttpError } = require('../../server/core/util');
const totp = require('../../server/core/totp');
const { isDangerous } = require('../../server/core/danger');

const store = new Store(config.stateFile);
const auth = new Auth(store, 'x'.repeat(48));
const wss = new WebSocketServer();
const templates = new TemplateRegistry();
const manager = new ServerManager(store, templates, wss);
const scheduler = new Scheduler(manager, store);
const api = createApi({ store, auth, manager, templates, scheduler, hostMetrics: {}, notifier: {}, bridge: { forgetServer() {} } });

const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-danger-srv-'));
const custom = {
  id: 'custom1',
  name: 'Custom',
  templateId: 'custom-command',
  platform: 'linux',
  dir: serverDir,
  ports: { game: 27015, extra: 27016 },
  vars: { INSTALL_SCRIPT: 'echo hi', LAUNCH_COMMAND: './start.sh', STOP_COMMAND: '', QUERY_TYPE: 'none', RCON_PASSWORD: 'hunter22secret' },
  schedules: [],
  memory: 1024,
};
const other = { ...custom, id: 'other1', name: 'Other', vars: { RCON_PASSWORD: 'otherpassword' }, schedules: [] };
manager.servers.push(custom, other);

const admin = auth.createUser({ username: 'boss', password: 'correct horse battery', role: 'admin' });
const sub = auth.createUser({ username: 'helper', password: 'another long passphrase', role: 'user', servers: ['custom1'], permissions: ['console'] });
const subRecord = auth.users.find((u) => u.id === sub.id);
const tokenOf = (username, password) => auth.login(username, password, '10.0.0.1').token;
const subToken = tokenOf('helper', 'another long passphrase');

let base;
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    await api.handle(req, res, url);
  } catch (err) {
    if (res.writableEnded) return;
    res.writeHead(err instanceof HttpError ? err.code : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

test.before(() => new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve((base = `http://127.0.0.1:${httpServer.address().port}`)))));
test.after(() => {
  httpServer.close();
  store.saveNow();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  fs.rmSync(serverDir, { recursive: true, force: true });
});

const call = (method, url, { token = subToken, body, headers = {} } = {}) =>
  fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });


const adminToken = tokenOf('boss', 'correct horse battery');
const adminRecord = auth.users.find((u) => u.id === admin.id);
// Codes cannot repeat and the server accepts one step of drift, so walk forward from a step ago.
let step = Math.floor(Date.now() / 30000) - 1;
const nextCode = () => totp.hotp(adminRecord.totp.secret, step++);
const nowOf = () => ({ 'x-confirm-code': nextCode() });

test('which requests count as destructive', () => {
  assert.ok(isDangerous('DELETE', '/api/servers/abc'));
  assert.ok(isDangerous('POST', '/api/servers/abc/wipe'));
  assert.ok(isDangerous('POST', '/api/servers/abc/safe-update/rollback'));
  assert.ok(isDangerous('POST', '/api/servers/abc/backups/x.tar.gz/restore'));
  assert.ok(isDangerous('DELETE', '/api/servers/abc/backups/x.tar.gz'));
  assert.ok(isDangerous('DELETE', '/api/servers/abc/files'));
  assert.ok(isDangerous('POST', '/api/servers/abc/trim', {}));
  assert.ok(!isDangerous('POST', '/api/servers/abc/trim', { dryRun: true }));
  assert.ok(!isDangerous('GET', '/api/servers/abc'));
  assert.ok(!isDangerous('POST', '/api/servers/abc/power'));
  assert.ok(!isDangerous('POST', '/api/servers/abc/install', {}));
  assert.ok(isDangerous('POST', '/api/servers/abc/install', { reinstall: true }));
  assert.ok(isDangerous('DELETE', '/api//servers/abc'));
});

test('without 2FA nothing extra is asked of the server', async () => {
  const res = await call('DELETE', '/api/servers/nope', { token: adminToken });
  assert.strictEqual(res.status, 404);
});

test('with 2FA a destructive action needs a fresh code, and one code covers the next minutes', async () => {
  adminRecord.totp = { secret: totp.generateSecret(), enabledAt: Date.now(), lastStep: -1, recovery: [] };
  let res = await call('DELETE', '/api/servers/other1/backups/a.tar.gz', { token: adminToken });
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).confirmRequired, true);
  res = await call('DELETE', '/api/servers/other1/backups/a.tar.gz', { token: adminToken, headers: { 'x-confirm-code': '000000' } });
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).confirmRequired, true);
  res = await call('DELETE', '/api/servers/other1/backups/a.tar.gz', { token: adminToken, headers: nowOf() });
  assert.notStrictEqual((await res.clone().json().catch(() => ({}))).confirmRequired, true, 'the code was accepted');
  // The next one is covered by the same confirmation.
  res = await call('DELETE', '/api/servers/other1/backups/b.tar.gz', { token: adminToken });
  assert.notStrictEqual((await res.json().catch(() => ({}))).confirmRequired, true);
  assert.ok(manager.servers.some((s) => s.id === 'other1'));
});

test('a code cannot be replayed', async () => {
  auth.dangerOk.clear();
  const code = nextCode();
  let res = await call('DELETE', '/api/servers/other1/backups/c.tar.gz', { token: adminToken, headers: { 'x-confirm-code': code } });
  assert.notStrictEqual((await res.json().catch(() => ({}))).confirmRequired, true);
  auth.dangerOk.clear();
  res = await call('DELETE', '/api/servers/other1/backups/c.tar.gz', { token: adminToken, headers: { 'x-confirm-code': code } });
  assert.strictEqual(res.status, 403, 'the same code twice');
});

test('API keys are not asked for a code', async () => {
  const key = auth.createScriptKey(admin.id, { name: 'cli' }).key;
  auth.dangerOk.clear();
  const res = await call('DELETE', '/api/servers/other1/backups/d.tar.gz', { token: key });
  assert.notStrictEqual((await res.json().catch(() => ({}))).confirmRequired, true);
});

test('notes: everyone with access reads, the settings permission edits', async () => {
  let res = await call('GET', '/api/servers/custom1/notes');
  assert.strictEqual(res.status, 200);
  let data = await res.json();
  assert.strictEqual(data.text, '');
  assert.strictEqual(data.canEdit, false);
  res = await call('PUT', '/api/servers/custom1/notes', { body: { notes: 'x' } });
  assert.strictEqual(res.status, 403);
  // No access to the other server at all.
  assert.strictEqual((await call('GET', '/api/servers/other1/notes')).status, 403);

  res = await call('PUT', '/api/servers/custom1/notes', { token: adminToken, body: { notes: '# Wipe plan\n- [ ] thursday', basedOn: null }});
  const saved = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(saved));
  assert.strictEqual(saved.updatedBy, 'boss');
  data = await (await call('GET', '/api/servers/custom1/notes')).json();
  assert.strictEqual(data.text, '# Wipe plan\n- [ ] thursday');
});

test('notes: a stale save is refused instead of overwriting', async () => {
  const res = await call('PUT', '/api/servers/custom1/notes', { token: adminToken, body: { notes: 'mine', basedOn: 1 } });
  assert.strictEqual(res.status, 409);
  const big = await call('PUT', '/api/servers/custom1/notes', { token: adminToken, body: { notes: 'x'.repeat(100_001), basedOn: (await (await call('GET', '/api/servers/custom1/notes')).json()).updatedAt } });
  assert.strictEqual(big.status, 400);
});

test('notes never appear in the audit log text', () => {
  const entries = fs.readFileSync(path.join(config.dataDir, 'audit.log'), 'utf8');
  assert.ok(!entries.includes('thursday'));
});
