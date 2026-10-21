'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-prefs-'));
const prefs = require('../../server/features/notify-prefs');
const notes = require('../../server/features/live-notifications');

test('events map to categories', () => {
  assert.strictEqual(prefs.categoryOf('server.crashed'), 'crashes');
  assert.strictEqual(prefs.categoryOf('backup.upload_failed'), 'backups');
  assert.strictEqual(prefs.categoryOf('user.lockout'), 'signins');
  assert.strictEqual(prefs.categoryOf('panel.disk_low'), 'resources');
  assert.strictEqual(prefs.categoryOf('something.new'), 'other');
});

test('muted categories and servers send nothing', () => {
  const p = prefs.sanitize({ mutedCategories: ['backups', 'bogus'], mutedServers: ['s2', 5] });
  assert.deepStrictEqual(p, { mutedCategories: ['backups'], mutedServers: ['s2'] });
  assert.ok(!prefs.allows(p, { type: 'backup.failed', serverId: 's1' }));
  assert.ok(!prefs.allows(p, { type: 'server.crashed', serverId: 's2' }));
  assert.ok(prefs.allows(p, { type: 'server.crashed', serverId: 's1' }));
  assert.ok(prefs.allows(undefined, { type: 'backup.failed' }));
});

test('a device list replaces the account list', () => {
  const store = { state: { userPrefs: { u: { notify: { mutedCategories: ['crashes'], mutedServers: [] } } } } };
  assert.ok(!prefs.allows(prefs.effective(store, { userId: 'u' }), { type: 'server.crashed' }));
  assert.ok(prefs.allows(prefs.effective(store, { userId: 'u', prefs: { mutedCategories: [], mutedServers: [] } }), { type: 'server.crashed' }));
});

test('the bell and live socket honour mutes', () => {
  const auth = { users: [{ id: 'a', role: 'admin' }], canAccessServer: () => true, can: () => true };
  const store = new EventEmitter();
  store.state = { events: [], userPrefs: { a: { notify: { mutedCategories: ['backups'], mutedServers: ['s9'] } } } };
  const sent = [];
  notes.start({ store, auth, wss: { clients: new Set([{ user: { id: 'a' }, send: (m) => sent.push(m.notification.id) }]) } });
  store.emit('event', { id: '1', type: 'backup.failed', message: 'x', serverId: 's1', at: 1 });
  store.emit('event', { id: '2', type: 'server.crashed', message: 'x', serverId: 's9', at: 2 });
  store.emit('event', { id: '3', type: 'server.crashed', message: 'x', serverId: 's1', at: 3 });
  assert.deepStrictEqual(sent, ['3']);
  store.state.events.push({ id: '1', type: 'backup.failed', serverId: 's1', at: 1 }, { id: '3', type: 'server.crashed', serverId: 's1', at: 3 });
  assert.deepStrictEqual(notes.list(store, auth, auth.users[0]).map((n) => n.id), ['3']);
});

test('action buttons only for people who may use them, tokens work once', () => {
  const event = { type: 'server.crashed', serverId: 's1' };
  const power = prefs.buttonsFor({ auth: { can: () => true }, user: { id: 'u' }, event });
  assert.deepStrictEqual(power.actions.map((a) => a.action), ['restart', 'console']);
  assert.ok(power.tokens.restart);
  const view = prefs.buttonsFor({ auth: { can: (u, c) => c === 'console' }, user: { id: 'u' }, event });
  assert.deepStrictEqual(view.actions.map((a) => a.action), ['console']);
  assert.deepStrictEqual(view.tokens, {});

  const claim = prefs.tokens.consume(power.tokens.restart);
  assert.deepStrictEqual(claim, { userId: 'u', serverId: 's1', action: 'restart' });
  assert.strictEqual(prefs.tokens.consume(power.tokens.restart), null, 'one time only');
  const again = prefs.buttonsFor({ auth: { can: () => true }, user: { id: 'u' }, event }).tokens.restart;
  const [body, sig] = again.split('.');
  assert.strictEqual(prefs.tokens.consume(`${body}.${sig.slice(0, -2)}xx`), null, 'forged signature');
  const t = new prefs.ActionTokens();
  const old = t.mint({ userId: 'u', serverId: 's', action: 'start' }, 0);
  assert.strictEqual(t.consume(old, 25 * 3600_000), null, 'expired');
});

test('the action endpoint checks the token, the session and current permission', async () => {
  const { makeApp, load } = require('./support/routes');
  const calls = [];
  const app = makeApp({ manager: { servers: [{ id: 's1', name: 'One' }], require() {}, find() {}, restart: async (id) => calls.push(id), start: async () => {} } });
  const admin = app.auth.createUser({ username: 'boss', password: 'correct horse battery', role: 'admin' });
  const helper = app.auth.createUser({ username: 'helper', password: 'another long passphrase', role: 'user', servers: ['s1'], permissions: ['console'] });
  const { call } = load('ext', app);
  const token = (u) => prefs.tokens.mint({ userId: u.id, serverId: 's1', action: 'restart' });
  const ctx = (body) => ({ body, req: { headers: {}, socket: { remoteAddress: '1.2.3.4' } } });

  await assert.rejects(call('POST', '/api/notify-actions/run', ctx({ token: 'garbage' })), /expired/);
  const t = token(admin);
  const ok = await call('POST', '/api/notify-actions/run', ctx({ token: t }));
  assert.match(ok.message, /Restarting One/);
  assert.deepStrictEqual(calls, ['s1']);
  await assert.rejects(call('POST', '/api/notify-actions/run', ctx({ token: t })), /expired|already used/);
  // A token for an account that lacks the power permission is refused when pressed.
  await assert.rejects(call('POST', '/api/notify-actions/run', ctx({ token: token(helper) })), /not allowed/);
  assert.deepStrictEqual(calls, ['s1']);
});
