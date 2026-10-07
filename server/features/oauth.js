'use strict';

/**
 * Sign in with Google, Discord or GitHub.
 *
 * Accounts are never created this way: someone signs in with their password
 * once, links their Google/Discord/GitHub account on the Account page, and
 * from then on can use that button instead. Two-factor sign-in still applies.
 *
 * An administrator registers the panel as an app with each service and pastes
 * the client id and secret in Settings. The redirect URL to register is
 * <panel address>/api/auth/oauth/<provider>/callback.
 *
 * settings.oauth = { publicUrl, google: { clientId, clientSecret }, discord: {…}, github: {…} }
 * user.identities = { google: { id, name }, … }
 */

const crypto = require('crypto');
const { fail } = require('../core/util');

const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    console: 'https://console.cloud.google.com/apis/credentials',
    async identity(token) {
      const me = await getJson('https://openidconnect.googleapis.com/v1/userinfo', token);
      if (!me.sub) throw new Error('Google did not say who you are');
      return { id: String(me.sub), name: me.email || me.name || me.sub };
    },
  },
  discord: {
    label: 'Discord',
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    scope: 'identify',
    console: 'https://discord.com/developers/applications',
    async identity(token) {
      const me = await getJson('https://discord.com/api/users/@me', token);
      if (!me.id) throw new Error('Discord did not say who you are');
      return { id: String(me.id), name: me.global_name ? `${me.global_name} (@${me.username})` : `@${me.username}` };
    },
  },
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user',
    console: 'https://github.com/settings/developers',
    async identity(token) {
      const me = await getJson('https://api.github.com/user', token);
      if (!me.id) throw new Error('GitHub did not say who you are');
      return { id: String(me.id), name: `@${me.login}` };
    },
  },
};

const STATE_COOKIE = 'gp_oauth';
const STATE_TTL_MS = 10 * 60_000;

async function getJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'GamePanel' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

const settings = (store) => store.state.settings.oauth || {};

function provider(id) {
  const p = PROVIDERS[id];
  if (!p) fail(404, 'Unknown sign-in provider');
  return p;
}

function configured(store, id) {
  const c = settings(store)[id];
  return Boolean(c?.clientId && c?.clientSecret);
}

/** Buttons for the sign-in screen. */
function enabled(store) {
  return Object.entries(PROVIDERS)
    .filter(([id]) => configured(store, id))
    .map(([id, p]) => ({ id, label: p.label }));
}

/** Where the provider sends people back to. */
function redirectUri(store, req, id) {
  const base = String(settings(store).publicUrl || '').replace(/\/+$/, '') || origin(req);
  return `${base}/api/auth/oauth/${id}/callback`;
}

function origin(req) {
  const { isSecure } = require('../api/helpers');
  const host = /^[A-Za-z0-9.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : 'localhost';
  return `${isSecure(req) ? 'https' : 'http'}://${host}`;
}

/**
 * The address to send the browser to, and the cookie that ties the answer to
 * this browser (so a link someone else started cannot sign you in as them).
 */
function start(store, auth, req, id, { linkUserId = null } = {}) {
  const p = provider(id);
  if (!configured(store, id)) fail(400, `Sign-in with ${p.label} is not set up. An administrator can add it under Settings.`);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const state = auth.sign({ purpose: 'oauth', p: id, n: nonce, link: linkUserId, exp: Date.now() + STATE_TTL_MS });
  const params = new URLSearchParams({
    client_id: settings(store)[id].clientId,
    redirect_uri: redirectUri(store, req, id),
    response_type: 'code',
    scope: p.scope,
    state,
    prompt: id === 'google' ? 'select_account' : 'consent',
  });
  const { isSecure } = require('../api/helpers');
  const cookie = [`${STATE_COOKIE}=${nonce}`, 'Path=/api/auth/oauth', 'HttpOnly', 'SameSite=Lax', `Max-Age=${STATE_TTL_MS / 1000}`, ...(isSecure(req) ? ['Secure'] : [])].join('; ');
  return { url: `${p.authorize}?${params}`, cookie };
}

/** Check the answer, swap the code for a token and find out who it is. */
async function finish(store, auth, req, id, query) {
  const p = provider(id);
  if (query.get('error')) throw new Error(query.get('error_description') || `${p.label} said: ${query.get('error')}`);
  const state = auth.verify(String(query.get('state') || ''));
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((c) => c.length === 2));
  if (!state || state.purpose !== 'oauth' || state.p !== id || !cookies[STATE_COOKIE] || cookies[STATE_COOKIE] !== state.n) {
    throw new Error('That sign-in link expired or was started in another browser. Try again.');
  }
  const c = settings(store)[id] || {};
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: require('../core/secrets').open(c.clientSecret || ''),
    code: String(query.get('code') || ''),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(store, req, id),
  });
  const res = await fetch(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `${p.label} refused the sign-in`);
  return { identity: await p.identity(data.access_token), linkUserId: state.link || null };
}

/** The account linked to this identity. */
function findUser(auth, id, identity) {
  return auth.users.find((u) => u.identities?.[id]?.id === identity.id) || null;
}

function link(store, auth, userId, id, identity) {
  const other = findUser(auth, id, identity);
  if (other && other.id !== userId) throw new Error(`That ${PROVIDERS[id].label} account is already linked to another panel account`);
  const user = auth.users.find((u) => u.id === userId);
  if (!user) throw new Error('Your panel account no longer exists');
  user.identities = { ...(user.identities || {}), [id]: { id: identity.id, name: identity.name, linkedAt: Date.now() } };
  store.save();
  return user;
}

function unlink(store, user, id) {
  provider(id);
  if (!user.identities?.[id]) fail(404, 'Not linked');
  delete user.identities[id];
  store.save();
}

/** Settings for the admin page: secrets are never sent back, only whether one is saved. */
function adminView(store, req) {
  const s = settings(store);
  return {
    publicUrl: s.publicUrl || '',
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      console: p.console,
      clientId: s[id]?.clientId || '',
      hasSecret: Boolean(s[id]?.clientSecret),
      redirectUri: redirectUri(store, req, id),
    })),
  };
}

function update(store, body) {
  const s = { ...settings(store) };
  if (body.publicUrl !== undefined) {
    const url = String(body.publicUrl || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s/]+$/i.test(url)) fail(400, 'The panel address looks like https://panel.example.com (no path)');
    s.publicUrl = url;
  }
  for (const id of Object.keys(PROVIDERS)) {
    const input = body[id];
    if (!input) continue;
    const current = s[id] || {};
    s[id] = {
      clientId: input.clientId !== undefined ? String(input.clientId).trim() : current.clientId || '',
      // An empty secret keeps the saved one; `clear` removes the provider.
      clientSecret: input.clear ? '' : input.clientSecret ? require('../core/secrets').seal(String(input.clientSecret).trim()) : current.clientSecret || '',
    };
    if (input.clear) s[id].clientId = '';
  }
  store.state.settings.oauth = s;
  store.save();
  return s;
}

module.exports = { PROVIDERS, STATE_COOKIE, enabled, start, finish, findUser, link, unlink, adminView, update, redirectUri };
