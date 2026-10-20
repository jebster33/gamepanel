'use strict';

/**
 * Passkeys: sign in with a fingerprint, face or security key instead of a
 * password. A passkey that checked who is holding it (fingerprint, PIN)
 * counts as two-factor sign-in on its own; one that only checked that
 * someone touched it still asks for the authenticator code when the account
 * has one.
 *
 * Browsers only offer passkeys on HTTPS (or localhost) and for a name, not an
 * IP address, so the panel must be opened at its domain.
 *
 * user.passkeys = [{ id, publicKey, signCount, name, createdAt, lastUsedAt, backedUp }]
 * user.webauthnId = random handle the passkey stores instead of the username
 */

const crypto = require('crypto');
const { fail } = require('../core/util');
const webauthn = require('../core/webauthn');

const TTL_MS = 5 * 60_000;
const MAX_PASSKEYS = 20;
const challenges = new Map(); // id -> { challenge, origin, rpId, userId?, exp }

function sweep() {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
  while (challenges.size > 5000) challenges.delete(challenges.keys().next().value);
}

/** The site the browser is on: passkeys belong to that name. */
function siteOf(req) {
  const origin = String(req.headers.origin || '');
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail(400, 'Your browser did not say which site this is');
  }
  const rpId = url.hostname;
  if (/^\d+(\.\d+){3}$/.test(rpId) || rpId.includes(':') || rpId.startsWith('[')) fail(400, 'Passkeys need the panel opened at a name (its domain, or localhost), not an IP address');
  if (url.protocol !== 'https:' && rpId !== 'localhost' && !rpId.endsWith('.localhost')) fail(400, 'Passkeys need HTTPS. Turn on HTTPS for the panel first (Settings → HTTPS).');
  return { origin: url.origin, rpId };
}

function newChallenge(entry) {
  sweep();
  const id = crypto.randomBytes(16).toString('base64url');
  const challenge = crypto.randomBytes(32).toString('base64url');
  challenges.set(id, { ...entry, challenge, exp: Date.now() + TTL_MS });
  return { id, challenge };
}

function takeChallenge(id) {
  const entry = challenges.get(String(id || ''));
  challenges.delete(String(id || ''));
  if (!entry || entry.exp < Date.now()) fail(400, 'That passkey request expired. Try again.');
  return entry;
}

/* ---------------------------------------------------------- registering -- */

const KINDS = ['any', 'platform', 'security-key'];
const TRANSPORTS = ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'];

/**
 * What to ask the browser for, by kind:
 *  - platform: this device (Windows Hello, Touch ID / Face ID, Android biometrics). Discoverable and verified.
 *  - security-key: a roaming USB/NFC key. Discoverable when the key has room for it, so sign-in without a username works.
 *  - any: let the browser offer both.
 */
function selection(kind) {
  if (kind === 'platform') return { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' };
  if (kind === 'security-key') return { authenticatorAttachment: 'cross-platform', residentKey: 'preferred', requireResidentKey: false, userVerification: 'preferred' };
  return { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' };
}

function registerOptions(auth, store, sessionUser, req, password, kind = 'any') {
  if (!KINDS.includes(kind)) fail(400, 'Unknown passkey type');
  const user = auth.users.find((u) => u.id === sessionUser.id);
  // A passkey is a way in that outlives the session that added it: whoever adds one proves they know the password.
  auth.checkPassword(user, password);
  const site = siteOf(req);
  if ((user.passkeys || []).length >= MAX_PASSKEYS) fail(400, `An account can have at most ${MAX_PASSKEYS} passkeys`);
  if (!user.webauthnId) {
    user.webauthnId = crypto.randomBytes(16).toString('base64url');
    store.save();
  }
  const { id, challenge } = newChallenge({ ...site, userId: user.id, purpose: 'register', kind });
  return {
    requestId: id,
    options: {
      challenge,
      rp: { name: store.state.settings.panelName || 'GamePanel', id: site.rpId },
      user: { id: user.webauthnId, name: user.username, displayName: user.username },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 120_000,
      attestation: 'none',
      authenticatorSelection: selection(kind),
      excludeCredentials: (user.passkeys || []).map((p) => ({ type: 'public-key', id: p.id, ...(p.transports?.length ? { transports: p.transports } : {}) })),
    },
  };
}

function register(auth, store, sessionUser, req, { requestId, credential, name }) {
  const entry = takeChallenge(requestId);
  if (entry.purpose !== 'register' || entry.userId !== sessionUser.id) fail(400, 'That passkey request was for someone else');
  const site = siteOf(req);
  if (site.origin !== entry.origin) fail(400, 'That passkey request was for another site');
  let result;
  try {
    result = webauthn.verifyRegistration(credential?.response || {}, entry);
  } catch (err) {
    fail(400, err.message);
  }
  // A "this device" passkey must have checked the person (Windows Hello PIN, fingerprint, face), or it is no better than a password.
  if (entry.kind === 'platform' && !result.uv) fail(400, 'This device did not check who you are. Set up Windows Hello, Touch ID or a screen lock, then try again.');
  if (auth.users.some((u) => (u.passkeys || []).some((p) => p.id === result.id))) fail(409, 'That passkey is already registered');
  const user = auth.users.find((u) => u.id === sessionUser.id);
  const passkey = {
    id: result.id,
    publicKey: result.publicKey,
    signCount: result.signCount,
    backedUp: result.backedUp,
    kind: KINDS.includes(entry.kind) ? entry.kind : 'any',
    uv: Boolean(result.uv),
    transports: (Array.isArray(credential?.response?.transports) ? credential.response.transports : []).filter((t) => TRANSPORTS.includes(t)),
    rpId: entry.rpId,
    name: String(name || '').trim().slice(0, 40) || 'Passkey',
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  user.passkeys = [...(user.passkeys || []), passkey];
  store.save();
  return passkey;
}

function rename(auth, store, sessionUser, id, name) {
  const user = auth.users.find((u) => u.id === sessionUser.id);
  const p = (user.passkeys || []).find((x) => x.id === id);
  if (!p) fail(404, 'Passkey not found');
  p.name = String(name || '').trim().slice(0, 40) || p.name;
  store.save();
  return p;
}

function remove(auth, store, sessionUser, id, password) {
  const user = auth.users.find((u) => u.id === sessionUser.id);
  auth.checkPassword(user, password);
  const rest = (user.passkeys || []).filter((p) => p.id !== id);
  if (rest.length === (user.passkeys || []).length) fail(404, 'Passkey not found');
  // The admin two-factor rule must still be met afterwards.
  if (user.role === 'admin' && store.state.settings.requireAdmin2fa && !user.totp?.secret && !rest.length) {
    fail(400, 'Administrators need two-factor sign-in here: set up an authenticator app before removing your last passkey');
  }
  user.passkeys = rest;
  store.save();
}

/* ------------------------------------------------------------- signing in -- */

function loginOptions(req) {
  const site = siteOf(req);
  const { id, challenge } = newChallenge({ ...site, purpose: 'login' });
  // No list of keys: the browser offers every passkey it has for this site (no username needed).
  return { requestId: id, options: { challenge, rpId: site.rpId, timeout: 120_000, userVerification: 'preferred', allowCredentials: [] } };
}

/** A passkey sign-in. Returns what auth.login returns: a session, or a ticket for the code step. */
function login(auth, store, req, ip, { requestId, credential }) {
  auth.checkLockout(ip);
  const entry = takeChallenge(requestId);
  if (entry.purpose !== 'login') fail(400, 'That passkey request was not a sign-in');
  const site = siteOf(req);
  if (site.origin !== entry.origin) fail(400, 'That passkey request was for another site');
  const credId = String(credential?.id || '');
  const user = auth.users.find((u) => (u.passkeys || []).some((p) => p.id === credId));
  const passkey = user?.passkeys.find((p) => p.id === credId);
  if (!user || !passkey) return auth.recordFailure(ip, 'This passkey is not registered here. Sign in with your password, then add it on the Account page.');
  const handle = credential.response?.userHandle;
  if (handle && handle !== user.webauthnId) return auth.recordFailure(ip, 'This passkey belongs to another account');
  let result;
  try {
    // The key answers for the site it was made for, which is not necessarily the name in this request's Origin.
    const rpId = passkey.rpId || entry.rpId;
    if (rpId !== entry.rpId && !entry.rpId.endsWith(`.${rpId}`)) throw new Error('This passkey was made for another site');
    result = webauthn.verifyAuthentication(credential.response || {}, passkey, { ...entry, rpId });
  } catch (err) {
    return auth.recordFailure(ip, err.message);
  }
  passkey.signCount = result.signCount;
  passkey.lastUsedAt = Date.now();
  store.save();
  // Only touched, not verified (no PIN or fingerprint): the authenticator code still applies.
  if (!result.uv && user.totp?.secret) return { ...auth.loginLinked(user, ip), passkey: passkey.name };
  return { ...auth.startSession(user, ip), passkey: passkey.name };
}

const publicList = (user) => (user.passkeys || []).map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, backedUp: Boolean(p.backedUp), kind: p.kind || 'any', verified: Boolean(p.uv) }));

module.exports = { KINDS, selection, registerOptions, register, rename, remove, loginOptions, login, publicList, siteOf };
