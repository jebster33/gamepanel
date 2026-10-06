'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const webauthn = require('../../server/core/webauthn');
const passkeys = require('../../server/features/passkeys');

/* A software authenticator, enough to play the browser's part. */

function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error('unsupported');
}

function authenticator(kind = 'ec') {
  const { publicKey, privateKey } = kind === 'ec' ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) : crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const cose =
    kind === 'ec'
      ? new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x, 'base64url')],
          [-3, Buffer.from(jwk.y, 'base64url')],
        ])
      : new Map([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, Buffer.from(jwk.x, 'base64url')],
        ]);
  const credId = crypto.randomBytes(16);
  let count = 0;
  const authData = (rpId, flags, withKey) => {
    const parts = [crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags]), Buffer.alloc(4)];
    parts[2].writeUInt32BE(count);
    if (withKey) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      parts.push(Buffer.alloc(16), len, credId, cbor(cose));
    }
    return Buffer.concat(parts);
  };
  return {
    credId: credId.toString('base64url'),
    create(options, origin) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(options.rp.id, 0x45, true)]]));
      return { id: credId.toString('base64url'), response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: attestationObject.toString('base64url') } };
    },
    get(options, origin, { flags = 0x05, userHandle, counter = true } = {}) {
      if (counter) count++;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
      const ad = authData(options.rpId, flags, false);
      const data = Buffer.concat([ad, crypto.createHash('sha256').update(clientDataJSON).digest()]);
      const signature = kind === 'ec' ? crypto.sign('sha256', data, privateKey) : crypto.sign(null, data, privateKey);
      return { id: credId.toString('base64url'), response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: ad.toString('base64url'), signature: signature.toString('base64url'), userHandle } };
    },
  };
}

function fakeAuth() {
  const users = [{ id: 'u1', username: 'alice', role: 'admin' }];
  return {
    users,
    failures: [],
    checkLockout() {},
    recordFailure(ip, message) {
      const err = new Error(message);
      err.status = 401;
      throw err;
    },
    startSession: (user) => ({ token: 'session', user: { id: user.id } }),
    loginLinked: (user) => (user.totp?.secret ? { twoFactor: true, ticket: 't' } : { token: 'session', user: { id: user.id } }),
  };
}
const store = { state: { settings: {} }, save() {} };
const req = (origin = 'https://panel.example.com') => ({ headers: { origin } });

for (const kind of ['ec', 'ed25519']) {
  test(`register and sign in with a ${kind} passkey`, () => {
    const auth = fakeAuth();
    const key = authenticator(kind);
    const reg = passkeys.registerOptions(auth, store, { id: 'u1' }, req());
    assert.strictEqual(reg.options.rp.id, 'panel.example.com');
    const saved = passkeys.register(auth, store, { id: 'u1' }, req(), { requestId: reg.requestId, credential: key.create(reg.options, 'https://panel.example.com'), name: 'Laptop' });
    assert.strictEqual(saved.name, 'Laptop');

    const opts = passkeys.loginOptions(req());
    const result = passkeys.login(auth, store, req(), '1.2.3.4', { requestId: opts.requestId, credential: key.get(opts.options, 'https://panel.example.com', { userHandle: auth.users[0].webauthnId }) });
    assert.strictEqual(result.token, 'session');
    assert.ok(auth.users[0].passkeys[0].lastUsedAt);

    // The same request cannot be used twice.
    assert.throws(() => passkeys.login(auth, store, req(), 'ip', { requestId: opts.requestId, credential: key.get(opts.options, 'https://panel.example.com') }), /expired/);
  });
}

test('refuses another site, a wrong signature, a backwards counter, and asks for the code without user verification', () => {
  const auth = fakeAuth();
  const key = authenticator('ec');
  const reg = passkeys.registerOptions(auth, store, { id: 'u1' }, req());
  passkeys.register(auth, store, { id: 'u1' }, req(), { requestId: reg.requestId, credential: key.create(reg.options, 'https://panel.example.com') });

  // Signed for a phishing site.
  let o = passkeys.loginOptions(req());
  assert.throws(() => passkeys.login(auth, store, req(), 'ip', { requestId: o.requestId, credential: key.get(o.options, 'https://evil.example') }), /used on https:\/\/evil/);

  // Tampered signature.
  o = passkeys.loginOptions(req());
  const bad = key.get(o.options, 'https://panel.example.com');
  const sig = Buffer.from(bad.response.signature, 'base64url');
  sig[sig.length - 1] ^= 1;
  bad.response.signature = sig.toString('base64url');
  assert.throws(() => passkeys.login(auth, store, req(), 'ip', { requestId: o.requestId, credential: bad }), /signature|not right/);

  // A good one moves the counter on; replaying an older count is refused.
  o = passkeys.loginOptions(req());
  passkeys.login(auth, store, req(), 'ip', { requestId: o.requestId, credential: key.get(o.options, 'https://panel.example.com') });
  auth.users[0].passkeys[0].signCount = 99;
  o = passkeys.loginOptions(req());
  assert.throws(() => passkeys.login(auth, store, req(), 'ip', { requestId: o.requestId, credential: key.get(o.options, 'https://panel.example.com') }), /copied/);
  auth.users[0].passkeys[0].signCount = 0;

  // Touched but not verified (no PIN): an account with codes still gets the code step.
  auth.users[0].totp = { secret: 'x' };
  o = passkeys.loginOptions(req());
  const r = passkeys.login(auth, store, req(), 'ip', { requestId: o.requestId, credential: key.get(o.options, 'https://panel.example.com', { flags: 0x01 }) });
  assert.strictEqual(r.twoFactor, true);
});

test('only on HTTPS at a name; the last passkey of a 2FA-required admin stays', () => {
  assert.throws(() => passkeys.loginOptions(req('http://panel.example.com')), /HTTPS/);
  assert.throws(() => passkeys.loginOptions(req('https://192.168.1.5:8080')), /IP address/);
  assert.ok(passkeys.loginOptions(req('http://localhost:8080')).options.rpId === 'localhost');

  const auth = fakeAuth();
  auth.users[0].passkeys = [{ id: 'a', name: 'Only one' }];
  const strict = { state: { settings: { requireAdmin2fa: true } }, save() {} };
  assert.throws(() => passkeys.remove(auth, strict, { id: 'u1' }, 'a'), /last passkey/);
  assert.strictEqual(auth.users[0].passkeys.length, 1);
});

test('CBOR decoding handles what authenticators send', () => {
  const m = webauthn.decode(cbor(new Map([['fmt', 'none'], [1, -7], ['b', Buffer.from([1, 2, 3])]])));
  assert.strictEqual(m.get('fmt'), 'none');
  assert.strictEqual(m.get(1), -7);
  assert.deepStrictEqual([...m.get('b')], [1, 2, 3]);
  assert.throws(() => webauthn.decode(Buffer.from([0x5f])), /indefinite/);
  assert.throws(() => webauthn.decode(Buffer.from([0x45, 1])), /ends early/);
});
