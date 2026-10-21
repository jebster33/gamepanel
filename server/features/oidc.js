'use strict';

/**
 * Sign in with any OpenID Connect provider: Authentik, Keycloak, Authelia,
 * Microsoft Entra ID, Okta, Zitadel... An administrator gives the provider's
 * discovery address and a client id and secret (Settings, Sign-in providers).
 *
 * Same rules as Google/Discord/GitHub in oauth.js: accounts are never created
 * here. Someone signs in with their password once, links the SSO account on
 * the Account page, and from then on can use the button. Two-factor sign-in
 * still applies.
 *
 * What it checks: PKCE (S256), a signed state tied to this browser, a nonce
 * inside the id_token, and the id_token's own signature against the provider's
 * published keys (JWKS), plus issuer, audience and expiry.
 *
 * settings.oauth.oidc = { label, issuer, clientId, clientSecret (sealed), scopes, ssoOnly: [user ids] }
 * user.identities.oidc = { id (the "sub" claim), name }
 * The redirect URL to register is <panel address>/api/auth/oauth/oidc/callback.
 */

const crypto = require('crypto');
const { fail } = require('../core/util');
const secrets = require('../core/secrets');

const STATE_TTL_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const SKEW_S = 120;
const ALGS = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384', ES512: 'sha512', PS256: 'sha256', EdDSA: null };

const pending = new Map(); // state nonce -> { verifier, nonce, exp }
const cache = new Map(); // issuer -> { doc, jwks, fetched, jwksFetched }

const settings = (store) => store.state.settings?.oauth?.oidc || {};
const configured = (store) => {
  const s = settings(store);
  return Boolean(s.issuer && s.clientId && s.clientSecret);
};

/** The sign-in button for the login page, or nothing when not set up. */
const enabled = (store) => (configured(store) ? [{ id: 'oidc', label: String(settings(store).label || 'Single sign-on').slice(0, 40) }] : []);

/* ----------------------------------------------------------- discovery -- */

const discoveryUrl = (issuer) => (/\/\.well-known\/openid-configuration$/.test(issuer) ? issuer : `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);

function cleanIssuer(text) {
  let value = String(text || '').trim();
  if (!value) return '';
  value = value.replace(/\/\.well-known\/openid-configuration$/, '').replace(/\/+$/, '');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(400, 'The discovery address looks like https://auth.example.com/application/o/gamepanel/ (the provider shows it as "OpenID configuration URL" or "issuer")');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail(400, 'The discovery address must start with https:// (or http:// on a private network)');
  return value;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Accept: 'application/json', 'User-Agent': 'GamePanel', ...(init.headers || {}) }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `${new URL(url).hostname} answered ${res.status}`);
  return data;
}

/** The provider's "who and where" document, cached for a few minutes. */
async function discover(issuer) {
  const hit = cache.get(issuer);
  if (hit && Date.now() - hit.fetched < DISCOVERY_TTL_MS) return hit;
  const doc = await fetchJson(discoveryUrl(issuer));
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof doc[field] !== 'string') throw new Error(`The provider's discovery document has no ${field}`);
  }
  const base = issuer.replace(/\/\.well-known\/openid-configuration$/, '').replace(/\/+$/, '');
  // Entra's multi-tenant document names a {tenantid} template; everyone else must match what was typed.
  if (!doc.issuer.includes('{tenantid}') && doc.issuer.replace(/\/+$/, '') !== base) throw new Error(`The provider says it is ${doc.issuer}, not ${base}. Use the exact issuer address.`);
  const entry = { doc, jwks: null, fetched: Date.now(), jwksFetched: 0 };
  cache.set(issuer, entry);
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return entry;
}

async function keyFor(entry, kid, alg) {
  const find = () => (entry.jwks?.keys || []).find((k) => (!kid || k.kid === kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg));
  // The key list is fetched once, then again (at most once a minute) when a key we do not know turns up (key rotation).
  if (!entry.jwks || (!find() && Date.now() - entry.jwksFetched > 60_000)) {
    entry.jwks = await fetchJson(entry.doc.jwks_uri);
    entry.jwksFetched = Date.now();
  }
  const jwk = find();
  if (!jwk) throw new Error('The id_token is signed with a key the provider does not publish');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/* ------------------------------------------------------------ id_token -- */

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** Verify an id_token's signature and claims. Returns the claims. */
async function verifyIdToken(token, { entry, clientId, nonce, now = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('The provider did not send a valid id_token');
  let header;
  let claims;
  try {
    header = b64json(parts[0]);
    claims = b64json(parts[1]);
  } catch {
    throw new Error('The id_token is unreadable');
  }
  // Never "none", never a shared-secret algorithm: the signature must come from a published public key.
  if (!Object.hasOwn(ALGS, header.alg)) throw new Error(`The id_token uses an unsupported signature (${String(header.alg).slice(0, 12)})`);
  const key = await keyFor(entry, header.kid, header.alg);
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  let ok;
  if (header.alg === 'EdDSA') ok = crypto.verify(null, data, key, sig);
  else if (header.alg.startsWith('PS')) ok = crypto.verify(ALGS[header.alg], data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig);
  else if (header.alg.startsWith('ES')) ok = crypto.verify(ALGS[header.alg], data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  else ok = crypto.verify(ALGS[header.alg], data, key, sig);
  if (!ok) throw new Error('The id_token signature is not right');

  const issuer = entry.doc.issuer;
  const issOk = issuer.includes('{tenantid}')
    ? (() => {
        const [pre, post] = issuer.split('{tenantid}');
        return typeof claims.iss === 'string' && claims.iss.startsWith(pre) && claims.iss.endsWith(post) && claims.iss.length > pre.length + post.length;
      })()
    : claims.iss === issuer;
  if (!issOk) throw new Error('The id_token is from a different issuer');
  const aud = [].concat(claims.aud || []);
  if (!aud.includes(clientId)) throw new Error('The id_token was issued for a different app');
  if (aud.length > 1 && claims.azp !== clientId) throw new Error('The id_token was issued for a different app');
  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < nowS) throw new Error('The id_token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > nowS) throw new Error('The id_token is not valid yet');
  if (typeof claims.iat === 'number' && claims.iat - SKEW_S > nowS) throw new Error('The id_token is from the future (check the panel clock)');
  if (!claims.nonce || claims.nonce !== nonce) throw new Error('That sign-in was not started here (nonce mismatch). Try again.');
  if (!claims.sub || typeof claims.sub !== 'string') throw new Error('The provider did not say who you are');
  return claims;
}

/* ---------------------------------------------------------------- flow -- */

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  while (pending.size > 1000) pending.delete(pending.keys().next().value);
}

/** Where to send the browser, and the cookie tying the answer to it. */
async function start(store, auth, req, { linkUserId = null } = {}, { redirectUri, stateCookie, secure }) {
  if (!configured(store)) fail(400, 'Single sign-on is not set up. An administrator can add it under Settings.');
  const s = settings(store);
  let entry;
  try {
    entry = await discover(s.issuer);
  } catch (err) {
    fail(502, `Could not reach the sign-in provider: ${err.message}`);
  }
  sweep();
  const n = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  pending.set(n, { verifier, nonce, exp: Date.now() + STATE_TTL_MS });
  const state = auth.sign({ purpose: 'oauth', p: 'oidc', n, link: linkUserId, exp: Date.now() + STATE_TTL_MS });
  const scopes = new Set(String(s.scopes || 'openid profile email').split(/\s+/).filter(Boolean));
  scopes.add('openid');
  const params = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: [...scopes].join(' '),
    state,
    nonce,
    code_challenge: sha256(verifier),
    code_challenge_method: 'S256',
  });
  const cookie = [`${stateCookie}=${n}`, 'Path=/api/auth/oauth', 'HttpOnly', 'SameSite=Lax', `Max-Age=${STATE_TTL_MS / 1000}`, ...(secure ? ['Secure'] : [])].join('; ');
  const sep = entry.doc.authorization_endpoint.includes('?') ? '&' : '?';
  return { url: `${entry.doc.authorization_endpoint}${sep}${params}`, cookie };
}

/** Check the answer, swap the code for tokens and return who it is. */
async function finish(store, auth, req, query, { redirectUri, stateCookie }) {
  if (query.get('error')) throw new Error(query.get('error_description') || `The provider said: ${query.get('error')}`);
  const state = auth.verify(String(query.get('state') || ''));
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((c) => c.length === 2));
  if (!state || state.purpose !== 'oauth' || state.p !== 'oidc' || !cookies[stateCookie] || cookies[stateCookie] !== state.n) {
    throw new Error('That sign-in link expired or was started in another browser. Try again.');
  }
  const mine = pending.get(state.n);
  pending.delete(state.n); // a state is good once
  if (!mine || mine.exp < Date.now()) throw new Error('That sign-in link expired. Try again.');
  if (!configured(store)) throw new Error('Single sign-on is not set up');
  const s = settings(store);
  const entry = await discover(s.issuer);
  const secret = secrets.open(s.clientSecret || '');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(query.get('code') || ''), redirect_uri: redirectUri, code_verifier: mine.verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // client_secret_post unless the provider only offers HTTP basic.
  const methods = entry.doc.token_endpoint_auth_methods_supported;
  if (Array.isArray(methods) && !methods.includes('client_secret_post') && methods.includes('client_secret_basic')) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
  } else {
    form.set('client_id', s.clientId);
    form.set('client_secret', secret);
  }
  const res = await fetch(entry.doc.token_endpoint, { method: 'POST', headers: { ...headers, Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error(data.error_description || data.error || 'The provider refused the sign-in');
  const claims = await verifyIdToken(data.id_token, { entry, clientId: s.clientId, nonce: mine.nonce });
  const name = String(claims.preferred_username || claims.email || claims.name || claims.sub).slice(0, 80);
  return { identity: { id: claims.sub, name }, linkUserId: state.link || null };
}

/* ------------------------------------------------------ SSO-only rule -- */

const ssoOnlyIds = (store) => (Array.isArray(settings(store).ssoOnly) ? settings(store).ssoOnly : []);

/** Accounts on the "SSO only" list cannot sign in any other way. */
function checkMethod(store, user, method) {
  if (method === 'sso' || !user || !configured(store)) return;
  if (ssoOnlyIds(store).includes(user.id)) fail(403, 'This account signs in with single sign-on only. Use the single sign-on button.');
}

/** Unlinking the SSO account of someone limited to SSO would lock them out. */
function beforeUnlink(store, user) {
  if (ssoOnlyIds(store).includes(user.id)) fail(400, 'This account is limited to single sign-on. Ask an administrator to lift that first.');
}

/* ------------------------------------------------------------- settings -- */

function adminView(store, req) {
  const s = settings(store);
  const oauth = require('./oauth');
  return {
    label: s.label || '',
    issuer: s.issuer || '',
    clientId: s.clientId || '',
    hasSecret: Boolean(s.clientSecret),
    scopes: s.scopes || 'openid profile email',
    redirectUri: oauth.redirectUri(store, req, 'oidc'),
    ssoOnly: ssoOnlyIds(store),
    accounts: store.state.users.map((u) => ({ id: u.id, username: u.username, linked: Boolean(u.identities?.oidc), linkedName: u.identities?.oidc?.name || '' })),
  };
}

function update(store, body) {
  const s = { ...settings(store) };
  if (body.clear) {
    delete (store.state.settings.oauth || {}).oidc;
    for (const u of store.state.users) if (u.identities?.oidc) delete u.identities.oidc;
    store.save();
    return;
  }
  if (body.issuer !== undefined) s.issuer = cleanIssuer(body.issuer);
  if (body.label !== undefined) s.label = String(body.label).trim().slice(0, 40);
  if (body.clientId !== undefined) s.clientId = String(body.clientId).trim().slice(0, 300);
  if (body.clientSecret) s.clientSecret = secrets.seal(String(body.clientSecret).trim());
  if (body.scopes !== undefined) {
    const scopes = String(body.scopes).trim();
    if (!/^[\w.:/\- ]{0,200}$/.test(scopes)) fail(400, 'Scopes are words separated by spaces, like: openid profile email');
    s.scopes = scopes || 'openid profile email';
  }
  if (body.ssoOnly !== undefined) {
    const ids = [].concat(body.ssoOnly).map(String);
    const users = store.state.users.filter((u) => ids.includes(u.id));
    const unlinked = users.filter((u) => !u.identities?.oidc);
    // Without a linked SSO account the person would have no way in at all.
    if (unlinked.length) fail(400, `${unlinked.map((u) => u.username).join(', ')} must link their SSO account (Account page) before sign-in is limited to it`);
    s.ssoOnly = users.map((u) => u.id);
  }
  store.state.settings.oauth = { ...(store.state.settings.oauth || {}), oidc: s };
  cache.delete(s.issuer);
  store.save();
}

/** Admin "test" button: can the panel reach the provider and read its keys? */
async function test(store) {
  const s = settings(store);
  if (!s.issuer) fail(400, 'Enter the discovery address first');
  cache.delete(s.issuer);
  try {
    const entry = await discover(s.issuer);
    const jwks = await fetchJson(entry.doc.jwks_uri);
    if (!Array.isArray(jwks.keys) || !jwks.keys.length) throw new Error('The provider publishes no signing keys');
    return { ok: true, issuer: entry.doc.issuer, pkce: !entry.doc.code_challenge_methods_supported || entry.doc.code_challenge_methods_supported.includes('S256') };
  } catch (err) {
    fail(502, `Could not use that provider: ${err.message}`);
  }
}

module.exports = { configured, enabled, start, finish, verifyIdToken, checkMethod, beforeUnlink, adminView, update, test, discover, cleanIssuer, _pending: pending, _cache: cache };
