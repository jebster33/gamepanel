'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-afau-data-'));
const { makeApp, load } = require('./support/routes');
const { hashPassword, verifyPassword, needsRehash } = require('../../server/core/auth');
const passkeys = require('../../server/features/passkeys');
const totp = require('../../server/core/totp');
const crypto = require('crypto');

const PW = 'correct horse 42';
const fakeReq = (token) => ({ headers: token ? { cookie: `gp_session=${token}` } : {}, socket: { remoteAddress: '203.0.113.9' }, url: '/api/servers', method: 'GET' });
const fakeRes = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

function setup() {
  const app = makeApp();
  app.store.state.settings.geoLookup = false;
  app.auth.createUser({ username: 'boss', password: PW, role: 'admin' });
  const user = app.auth.users[0];
  return { app, user, auth: app.auth };
}

test('signing in sets the cookie and does not put the session token in the JSON', async () => {
  const { app } = setup();
  const api = load('auth', app);
  const res = fakeRes();
  const body = await api.call('POST', '/api/auth/login', { body: { username: 'boss', password: PW }, req: fakeReq(), res });
  assert.strictEqual(body.token, undefined);
  assert.strictEqual(body.user.username, 'boss');
  assert.match(res.headers['Set-Cookie'], /^gp_session=[\w.-]+; .*HttpOnly/);
});

test('logging out ends that session on the server, even if a copy of the token is kept', async () => {
  const { app, auth } = setup();
  const { token } = auth.login('boss', PW, '1.1.1.1');
  const other = auth.login('boss', PW, '1.1.1.1').token;
  assert.ok(auth.userFromRequest(fakeReq(token)));
  const api = load('auth', app);
  await api.call('POST', '/api/auth/logout', { req: fakeReq(token), res: fakeRes() });
  assert.strictEqual(auth.userFromRequest(fakeReq(token)), null, 'the signed-out token is dead');
  assert.strictEqual(auth.userFromToken(token), null);
  assert.ok(auth.userFromRequest(fakeReq(other)), 'other sessions are untouched');
  // The deny list keeps only tokens that could still be used.
  auth.store.state.revokedTokens.old = Date.now() - 1000;
  auth.revokeToken(other);
  assert.strictEqual(auth.store.state.revokedTokens.old, undefined);
  // A garbage cookie logs out quietly.
  await api.call('POST', '/api/auth/logout', { req: fakeReq('nonsense'), res: fakeRes() });
});

test('a password change or "sign out everywhere" also revokes API keys', async () => {
  const { app, auth, user } = setup();
  const key = auth.createApiKey(user.id, { name: 'script' }).key;
  assert.ok(auth.userFromApiKey(key));
  const api = load('auth', app);
  const res = fakeRes();
  const out = await api.call('POST', '/api/auth/sessions/revoke', { user, req: fakeReq(), res });
  assert.strictEqual(out.apiKeysRevoked, 1);
  assert.strictEqual(auth.userFromApiKey(key), null);

  const second = auth.createApiKey(user.id, { name: 'bot' }).key;
  const changed = await api.call('POST', '/api/auth/password', { user, body: { currentPassword: PW, newPassword: 'another horse 77' }, req: fakeReq(), res });
  assert.strictEqual(changed.apiKeysRevoked, 1);
  assert.strictEqual(auth.userFromApiKey(second), null);
  assert.deepStrictEqual(auth.listApiKeys(user.id), []);
});

test('passwords are hashed with more work, and an older hash is upgraded at the next sign-in', () => {
  assert.match(hashPassword('whatever1234'), /^scrypt\$32768\$8\$1\$/);
  // What the previous version stored.
  const salt = crypto.randomBytes(16);
  const legacy = `scrypt$16384$8$1$${salt.toString('base64')}$${crypto.scryptSync(PW, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  assert.ok(verifyPassword(PW, legacy));
  assert.ok(needsRehash(legacy));
  assert.ok(!needsRehash(hashPassword(PW)));

  const { auth, user } = setup();
  user.password = legacy;
  auth.login('boss', PW, '1.1.1.1');
  assert.ok(!needsRehash(user.password), 'rehashed');
  assert.ok(verifyPassword(PW, user.password));
  assert.throws(() => auth.login('boss', 'wrong password!', '1.1.1.1'), /Incorrect/);
});

test('a two-factor ticket is good once, and not after the account signed out everywhere', () => {
  const { auth, user } = setup();
  const secret = totp.generateSecret();
  user.totp = { secret, recovery: [] };
  const codeAt = (offset) => totp.hotp(secret, Math.floor(Date.now() / 30000) + offset);

  const { ticket } = auth.login('boss', PW, '1.1.1.1');
  assert.ok(auth.loginSecondFactor(ticket, codeAt(0), '1.1.1.1').token);
  // A different, valid code with the same ticket: the ticket has been used.
  assert.throws(() => auth.loginSecondFactor(ticket, codeAt(1), '1.1.1.1'), /took too long/);

  const fresh = auth.login('boss', PW, '1.1.1.1').ticket;
  auth.revokeSessions(user.id);
  assert.throws(() => auth.loginSecondFactor(fresh, codeAt(1), '1.1.1.1'), /took too long/, 'the password step is void once sessions were revoked');

  // A wrong code does not use the ticket up (the account lockout limits guessing instead).
  const again = auth.login('boss', PW, '1.1.1.1').ticket;
  assert.throws(() => auth.loginSecondFactor(again, '000000', '1.1.1.1'), /not right/);
  assert.ok(auth.loginSecondFactor(again, codeAt(1), '1.1.1.1').token);
});

test('adding or removing a passkey asks for the password, and guessing it counts against the account', () => {
  const { app, auth, user } = setup();
  const req = { headers: { origin: 'https://panel.example.com' } };
  assert.throws(() => passkeys.registerOptions(auth, app.store, user, req, undefined), /password is not right/);
  assert.throws(() => passkeys.registerOptions(auth, app.store, user, req, 'wrong'), /password is not right/);
  assert.ok(passkeys.registerOptions(auth, app.store, user, req, PW).requestId);

  user.passkeys = [{ id: 'a', name: 'Phone' }];
  assert.throws(() => passkeys.remove(auth, app.store, user, 'a'), /password is not right/);
  assert.strictEqual(user.passkeys.length, 1);
  passkeys.remove(auth, app.store, user, 'a', PW);
  assert.strictEqual(user.passkeys.length, 0);

  // Ten wrong guesses lock the checks (for a short while) even for the right password.
  for (let i = 0; i < 10; i++) assert.throws(() => auth.checkPassword(user, 'nope nope nope'), /not right/);
  assert.throws(() => auth.checkPassword(user, PW), /Too many failed attempts/);
});
