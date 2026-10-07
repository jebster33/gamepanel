'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-authh-data-'));
const { Store } = require('../../server/core/store');
const { Auth } = require('../../server/core/auth');

function setup() {
  const store = new Store();
  const auth = new Auth(store, 'test-secret-test-secret-test-secret');
  const admin = auth.createUser({ username: 'boss', password: 'correct horse 42', role: 'admin' });
  const full = auth.createScriptKey(admin.id, { name: 'script' });
  const ro = auth.createScriptKey(admin.id, { name: 'status', readOnly: true });
  return { store, auth, admin, full: full.key || full, ro: ro.key || ro };
}
const req = (url, method, key, extra = {}) => ({ url, method, headers: { authorization: `Bearer ${key}`, ...(extra.headers || {}) }, socket: { remoteAddress: extra.addr || '203.0.113.9' } });

test('an API key cannot reach account routes with extra slashes in the path', () => {
  const { auth, full } = setup();
  assert.strictEqual(auth.userFromRequest(req('/api/auth/api-keys', 'POST', full)), null);
  for (const url of ['/api//auth/api-keys', '/api/auth//2fa/setup', '/api///users/x', '/api/servers/s1//access', '/api//servers/s1/access/u1']) {
    assert.strictEqual(auth.userFromRequest(req(url, 'POST', full)), null, url);
  }
  assert.ok(auth.userFromRequest(req('/api/servers', 'POST', full)), 'other routes still work');
  const r = req('/api/servers', 'GET', full);
  assert.ok(auth.userFromRequest(r));
  assert.deepStrictEqual(r.gpApiKey, { readOnly: false });
  const ro = req('/ws', 'GET', setup().ro);
  assert.strictEqual(auth.userFromRequest(ro), null, 'unknown key');
});

test('a read-only key is marked so websockets and account linking can refuse it', () => {
  const { auth, ro } = setup();
  const r = req('/ws', 'GET', ro);
  assert.ok(auth.userFromRequest(r));
  assert.deepStrictEqual(r.gpApiKey, { readOnly: true });
});

test('first-run setup needs the printed code unless it comes from this machine', () => {
  const store = new Store();
  const auth = new Auth(store, 'test-secret-test-secret-test-secret');
  const code = auth.setupCode();
  assert.match(code, /^[0-9a-f]{10}$/);
  assert.strictEqual(auth.setupCode(), code, 'stable until used');
  const remote = { socket: { remoteAddress: '198.51.100.7' }, headers: {} };
  assert.throws(() => auth.checkSetupCode(remote, ''), /setup code/);
  assert.throws(() => auth.checkSetupCode(remote, 'deadbeef00'), /setup code/);
  assert.doesNotThrow(() => auth.checkSetupCode(remote, code.toUpperCase()));
  assert.doesNotThrow(() => auth.checkSetupCode({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }, ''));
  // Behind a proxy, "from localhost" is the proxy: the code is needed.
  assert.throws(() => auth.checkSetupCode({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.7' } }, ''), /setup code/);
  auth.createUser({ username: 'first', password: 'correct horse 42', role: 'admin' });
  assert.strictEqual(auth.setupCode(), null);
});

test('with required 2FA, a password alone does not sign in an admin whose factor is a passkey', () => {
  const { store, auth, admin } = setup();
  store.state.settings.requireAdmin2fa = true;
  const record = auth.users.find((u) => u.id === admin.id);
  record.passkeys = [{ id: 'x' }];
  assert.throws(() => auth.loginLinked(record), /passkey/);
  record.totp = { secret: 'ABC' };
  assert.ok(auth.loginLinked(record).twoFactor);
  store.state.settings.requireAdmin2fa = false;
  record.totp = null;
  assert.ok(auth.loginLinked(record).token);
});

test('an existing authenticator cannot be replaced from a session; lockout counters survive a flood', () => {
  const { auth, admin } = setup();
  auth.users.find((u) => u.id === admin.id).totp = { secret: 'ABC' };
  assert.throws(() => auth.beginTwoFactor(admin.id), /already on/);
  auth.failures.clear();
  auth.noteAccountFailure('user:victim');
  auth.noteAccountFailure('user:victim');
  for (let i = 0; i < 5100; i++) auth.noteAccountFailure(`user:junk${i}`);
  assert.strictEqual(auth.failures.get('user:victim').count, 2);
});
