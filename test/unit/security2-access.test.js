'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sec2-'));

const cidr = require('../../server/core/cidr');
const allowlist = require('../../server/features/ip-allowlist');
const passkeys = require('../../server/features/passkeys');
const oidc = require('../../server/features/oidc');
const crypto = require('crypto');

const makeStore = (extra = {}) => ({ state: { settings: {}, users: [{ id: 'a', username: 'admin', role: 'admin' }, { id: 'u', username: 'bob', role: 'user' }], ...extra }, save() {}, addEvent() {} });

test('CIDR parsing and matching for IPv4 and IPv6', () => {
  assert.strictEqual(cidr.parseCidr('10.1.2.3/8').text, '10.0.0.0/8');
  assert.strictEqual(cidr.parseCidr('1.2.3.4/33'), null);
  assert.strictEqual(cidr.parseCidr('nope'), null);
  assert.ok(cidr.matchesAny(['10.0.0.0/8'], '10.9.9.9'));
  assert.ok(!cidr.matchesAny(['10.0.0.0/8'], '11.0.0.1'));
  assert.ok(cidr.matchesAny(['2001:db8::/32'], '2001:db8:1::5'));
  assert.ok(cidr.matchesAny(['10.0.0.0/8'], '::ffff:10.1.1.1'));
  assert.ok(cidr.isLoopback('::1') && cidr.isLoopback('127.0.0.5'));
  assert.ok(cidr.isPrivate('192.168.1.1') && cidr.isPrivate('fe80::1') && !cidr.isPrivate('8.8.8.8'));
  assert.strictEqual(cidr.normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
});

test('the allowlist: loopback always, roles, per-account lists, and refusing to lock the requester out', () => {
  const store = makeStore();
  const admin = store.state.users[0];
  // Turning it on from an address that is not listed is refused.
  assert.throws(() => allowlist.update(store, admin, '203.0.113.9', { enabled: true, cidrs: ['198.51.100.0/24'] }), /lock you out/);
  assert.throws(() => allowlist.update(store, admin, '203.0.113.9', { enabled: true, cidrs: ['bogus'] }), /valid address/);
  allowlist.update(store, admin, '203.0.113.9', { enabled: true, cidrs: ['203.0.113.0/24'] });
  const cfg = allowlist.config(store);
  assert.ok(allowlist.allowed(cfg, admin, '203.0.113.50'));
  assert.ok(!allowlist.allowed(cfg, admin, '198.51.100.1'));
  assert.ok(allowlist.allowed(cfg, admin, '127.0.0.1'), 'loopback is always allowed');
  assert.throws(() => allowlist.checkSignIn(store, admin, '198.51.100.1'), /not allowed/);

  // Only administrators: other accounts are unrestricted.
  allowlist.update(store, admin, '203.0.113.9', { roles: ['admin'] });
  assert.ok(allowlist.allowed(allowlist.config(store), store.state.users[1], '198.51.100.1'));

  // A per-account list replaces the shared one, and cannot lock out its own editor.
  assert.throws(() => allowlist.setAccount(store, admin, '203.0.113.9', 'a', ['198.51.100.0/24']), /lock you out/);
  assert.strictEqual(admin.allowedIps, undefined);
  allowlist.setAccount(store, admin, '203.0.113.9', 'u', ['192.0.2.0/24']);
  allowlist.update(store, admin, '203.0.113.9', { roles: ['admin', 'user'] });
  assert.ok(allowlist.allowed(allowlist.config(store), store.state.users[1], '192.0.2.4'));
  assert.ok(!allowlist.allowed(allowlist.config(store), store.state.users[1], '203.0.113.4'));

  // Offline recovery switches it off.
  allowlist.reset(store.state, { accounts: true });
  assert.ok(allowlist.allowed(allowlist.config(store), admin, '198.51.100.1'));
  assert.strictEqual(store.state.users[1].allowedIps, undefined);
});

test('passkey options: this device vs security key', () => {
  const auth = { users: [{ id: 'u1', username: 'alice', role: 'admin' }], checkPassword() {} };
  const store = { state: { settings: {} }, save() {} };
  const req = { headers: { origin: 'https://panel.example.com' } };
  const platform = passkeys.registerOptions(auth, store, { id: 'u1' }, req, 'x', 'platform').options.authenticatorSelection;
  assert.strictEqual(platform.authenticatorAttachment, 'platform');
  assert.strictEqual(platform.residentKey, 'required');
  assert.strictEqual(platform.userVerification, 'required');
  const key = passkeys.registerOptions(auth, store, { id: 'u1' }, req, 'x', 'security-key').options.authenticatorSelection;
  assert.strictEqual(key.authenticatorAttachment, 'cross-platform');
  const any = passkeys.registerOptions(auth, store, { id: 'u1' }, req, 'x').options.authenticatorSelection;
  assert.strictEqual(any.authenticatorAttachment, undefined, 'the browser may offer both');
  assert.strictEqual(any.residentKey, 'required');
  assert.throws(() => passkeys.registerOptions(auth, store, { id: 'u1' }, req, 'x', 'weird'), /Unknown passkey type/);
});

/* ------------------------------------------------------------------ OIDC */

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signer(alg = 'RS256') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg };
  const entry = { doc: { issuer: 'https://idp.example.com' }, jwks: { keys: [jwk] }, jwksFetched: Date.now() };
  const make = (claims, header = {}) => {
    const h = b64({ alg, kid: 'k1', ...header });
    const p = b64(claims);
    const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  return { entry, make };
}
const good = () => ({ iss: 'https://idp.example.com', aud: 'panel', sub: 'user-1', nonce: 'n1', exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000) });

test('OIDC id_token: signature, issuer, audience, nonce and expiry are all checked', async () => {
  const { entry, make } = signer();
  const ok = await oidc.verifyIdToken(make(good()), { entry, clientId: 'panel', nonce: 'n1' });
  assert.strictEqual(ok.sub, 'user-1');
  const bad = async (claims, re, header) => assert.rejects(oidc.verifyIdToken(make(claims, header), { entry, clientId: 'panel', nonce: 'n1' }), re);
  await bad({ ...good(), nonce: 'other' }, /nonce/);
  await bad({ ...good(), aud: 'someone-else' }, /different app/);
  await bad({ ...good(), iss: 'https://evil.example.com' }, /issuer/);
  await bad({ ...good(), exp: 1000 }, /expired/);
  await bad(good(), /unsupported/, { alg: 'none' });
  await bad(good(), /unsupported/, { alg: 'HS256' });
  // Tampered payload: the signature no longer matches.
  const parts = make(good()).split('.');
  parts[1] = b64({ ...good(), sub: 'admin' });
  await assert.rejects(oidc.verifyIdToken(parts.join('.'), { entry, clientId: 'panel', nonce: 'n1' }), /signature/);
});

test('OIDC: SSO-only accounts must be linked first and cannot use other sign-in methods', () => {
  const store = makeStore();
  store.state.settings.oauth = { oidc: { issuer: 'https://idp.example.com', clientId: 'panel', clientSecret: 'x' } };
  assert.throws(() => oidc.update(store, { ssoOnly: ['u'] }), /must link/);
  store.state.users[1].identities = { oidc: { id: 's', name: 'bob' } };
  oidc.update(store, { ssoOnly: ['u'] });
  assert.throws(() => oidc.checkMethod(store, store.state.users[1], 'password'), /single sign-on only/);
  assert.throws(() => oidc.checkMethod(store, store.state.users[1], 'passkey'), /single sign-on only/);
  oidc.checkMethod(store, store.state.users[1], 'sso');
  oidc.checkMethod(store, store.state.users[0], 'password');
  assert.throws(() => oidc.beforeUnlink(store, store.state.users[1]), /limited/);
  assert.strictEqual(oidc.cleanIssuer('https://a.example.com/x/.well-known/openid-configuration'), 'https://a.example.com/x');
  assert.throws(() => oidc.cleanIssuer('ftp://nope'), /https/);
});
