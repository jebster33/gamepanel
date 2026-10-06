'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = path.join(os.tmpdir(), `gp-alerts-${process.pid}`);
const alerts = require('../../server/servers/alerts');
const worlds = require('../../server/servers/worlds');

test('resource alerts wait two minutes, then cool down', () => {
  const events = [];
  const rt = { status: 'running', cpu: 250, memory: 0, diskBytes: 0 };
  const server = { id: 's1', name: 'SMP', memory: 1024, alerts: alerts.cleanAlerts({ cpu: 200, memory: 90 }) };
  const m = Object.assign({ servers: [server], rt: () => rt, store: { addEvent: (type, msg) => events.push(msg) } }, alerts);
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    m.checkAlerts();
    now += 60_000;
    m.checkAlerts();
    assert.strictEqual(events.length, 0);
    now += 61_000;
    m.checkAlerts();
    assert.strictEqual(events.length, 1);
    assert.match(events[0], /CPU has been at 250%/);
    now += 5 * 60_000;
    m.checkAlerts();
    assert.strictEqual(events.length, 1); // still cooling down
    rt.memory = 1000 * 1024 * 1024;
    m.checkAlerts();
    now += 121_000;
    m.checkAlerts();
    assert.strictEqual(events.length, 2);
    assert.match(events.at(-1), /Memory has been at 98%/);
  } finally {
    Date.now = realNow;
  }
});

test('worlds: list, switch and reset with a new seed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-worlds-'));
  for (const w of ['world', 'world_nether', 'creative']) {
    fs.mkdirSync(path.join(dir, w));
    fs.writeFileSync(path.join(dir, w, 'level.dat'), 'x');
  }
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=hi\nlevel-name=world\nlevel-seed=\n');
  const server = { id: 's1', name: 'SMP', dir, templateId: 'minecraft-paper' };
  const m = Object.assign(
    { require: () => server, isActive: () => false, pushConsole() {}, store: { addEvent() {} } },
    worlds
  );
  const list = await m.listWorlds(server);
  assert.deepStrictEqual(list.worlds.map((w) => [w.name, w.active, w.dimensions]), [
    ['world', true, 2],
    ['creative', false, 1],
  ]);
  await m.useWorld('s1', 'creative');
  assert.match(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), /^level-name=creative$/m);
  await m.resetWorld('s1', { name: 'world', seed: '42', backup: false });
  assert.ok(!fs.existsSync(path.join(dir, 'world')) && !fs.existsSync(path.join(dir, 'world_nether')));
  assert.match(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), /^level-seed=42$/m);
  await assert.rejects(m.useWorld('s1', '../etc'), /World names/);
});

test('API keys: read-only keys only read, and no key changes accounts', () => {
  const { Auth } = require('../../server/core/auth');
  const auth = new Auth({ state: { users: [] }, save() {}, addEvent() {} }, 'x'.repeat(32));
  auth.createUser({ username: 'chris', password: 'correct horse battery', role: 'admin' });
  const id = auth.users[0].id;
  const ro = auth.createApiKey(id, { name: 'bot', readOnly: true }).key;
  const full = auth.createApiKey(id, { name: 'script' }).key;
  const req = (method, url, key) => ({ method, url, headers: { authorization: `Bearer ${key}` } });
  assert.ok(auth.userFromRequest(req('GET', '/api/servers', ro)));
  assert.strictEqual(auth.userFromRequest(req('POST', '/api/servers/a/power', ro)), null);
  assert.ok(auth.userFromRequest(req('POST', '/api/servers/a/power', full)));
  assert.strictEqual(auth.userFromRequest(req('POST', '/api/auth/password', full)), null);
  assert.strictEqual(auth.userFromRequest(req('PATCH', '/api/users/x', full)), null);
  assert.ok(!JSON.stringify(auth.listApiKeys(id)).includes(full.slice(8)));
  auth.deleteApiKey(id, auth.listApiKeys(id)[1].id);
  assert.strictEqual(auth.userFromRequest(req('GET', '/api/servers', full)), null);
});

test('crossplay: Geyser port is patched only inside the bedrock block', () => {
  const { patchGeyserPort } = require('../../server/servers/crossplay');
  const text = 'bedrock:\n  address: 0.0.0.0\n  port: 19132\nremote:\n  port: 25565\n';
  assert.strictEqual(patchGeyserPort(text, 19133), 'bedrock:\n  address: 0.0.0.0\n  port: 19133\nremote:\n  port: 25565\n');
});

test('admins without two-factor only reach their account when it is required', () => {
  const { Auth } = require('../../server/core/auth');
  const store = { state: { users: [], settings: { requireAdmin2fa: true } }, save() {}, addEvent() {} };
  const auth = new Auth(store, 'x'.repeat(32));
  auth.createUser({ username: 'chris', password: 'correct horse battery', role: 'admin' });
  const { token } = auth.login('chris', 'correct horse battery', '1.1.1.1');
  const req = (url) => ({ method: 'GET', url, headers: { cookie: `gp_session=${token}`, authorization: `Bearer ${token}` } });
  assert.ok(auth.userFromRequest(req('/api/auth/me')));
  assert.throws(() => auth.userFromRequest(req('/api/servers')), /Two-factor sign-in is required/);
  store.state.settings.requireAdmin2fa = false;
  assert.ok(auth.userFromRequest(req('/api/servers')));
  const u = auth.users[0];
  assert.strictEqual(auth.noteSignInAddress(u, '1.1.1.1'), false);
  assert.strictEqual(auth.noteSignInAddress(u, '2.2.2.2'), true);
  assert.strictEqual(auth.noteSignInAddress(u, '1.1.1.1'), false);
});

test('rate limiter allows a burst, then refuses until the window ends', () => {
  const { RateLimiter } = require('../../server/core/ratelimit');
  const rl = new RateLimiter({ limit: 3, windowMs: 1000, maxKeys: 2 });
  assert.ok(rl.take('a', 0) && rl.take('a', 10) && rl.take('a', 20));
  assert.ok(!rl.take('a', 30));
  assert.ok(rl.take('b', 30));
  assert.ok(rl.take('a', 1000), 'a new window starts');
  rl.take('c', 1500);
  assert.ok(rl.hits.size <= 2, 'never grows past maxKeys');
});
