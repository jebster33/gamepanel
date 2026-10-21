'use strict';

/**
 * The player portal: a public page where players (not panel accounts) sign
 * in to see their own play time, stats, bans and linked accounts.
 *
 * Who someone is:
 *  - "steam:<id>" or "discord:<id>" after signing in with that service, or
 *  - "name:<in-game name>" after proving the name with a code typed in chat.
 * A Steam or Discord sign-in says nothing about game names by itself, so a
 * player adds a name by saying a short one-time code in the game's chat; the
 * panel reads the chat line and links the name that said it.
 *
 * The session is a signed cookie (gp_portal) that only the portal routes
 * read. It is never a panel session and opens nothing but read-only data
 * about the player's own names.
 *
 * settings.portal = { enabled }  (the servers are the status page's)
 * store.state.portal = { claims: { <subject>: [{ serverId, name, at }] }, accounts: { <subject>: label } }
 */

const crypto = require('crypto');
const { fail } = require('../core/util');

const COOKIE = 'gp_portal';
const SESSION_MS = 7 * 24 * 3600_000;
const CODE_MS = 10 * 60_000;
const MAX_PENDING = 500;
const MAX_NAMES = 10;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /\bGP-([A-Z2-9]{6})\b/i;

// Codes waiting to be said in chat: ticket -> pending, code -> ticket.
const pending = new Map();
const byCode = new Map();

const settings = (store) => ({ enabled: false, ...(store.state.settings.portal || {}) });
const stateOf = (store) => (store.state.portal ||= { claims: {}, accounts: {} });

function update(store, body) {
  const s = settings(store);
  if (body.enabled !== undefined) s.enabled = Boolean(body.enabled);
  store.state.settings.portal = s;
  store.save();
  return s;
}

/** Servers the portal covers: the ones picked for the public status page. */
function servers(store, manager) {
  const picked = store.state.settings.statusPage?.servers || [];
  return picked.map((id) => manager.servers.find((s) => s.id === id)).filter(Boolean);
}

/* ------------------------------------------------------------ sessions -- */

function cookieFor(auth, subject, label, secure) {
  const token = auth.sign({ purpose: 'portal', sub: subject, label: String(label || '').slice(0, 80), exp: Date.now() + SESSION_MS });
  return [`${COOKIE}=${token}`, 'Path=/api/portal', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_MS / 1000}`, ...(secure ? ['Secure'] : [])].join('; ');
}

const clearCookie = () => `${COOKIE}=; Path=/api/portal; HttpOnly; SameSite=Lax; Max-Age=0`;

function sessionFrom(auth, req) {
  const raw = String(req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const data = auth.verify(raw.slice(COOKIE.length + 1));
  return data?.purpose === 'portal' && /^(steam|discord|name):.{1,64}$/.test(data.sub || '') ? { subject: data.sub, label: data.label || '' } : null;
}

/** The cookie for someone back from Steam or Discord. */
function loginCookie(store, auth, req, provider, identity) {
  const subject = `${provider}:${identity.id}`;
  signIn(store, subject, identity.name);
  return cookieFor(auth, subject, identity.name, require('../api/helpers').isSecure(req));
}

/** A person signed in with Steam or Discord. */
function signIn(store, subject, label) {
  stateOf(store).accounts[subject] = String(label || '').slice(0, 80);
  store.save();
}

/* --------------------------------------------------------------- codes -- */

function newCode() {
  for (;;) {
    const code = `GP-${Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('')}`;
    if (!byCode.has(code)) return code;
  }
}

function sweep(now) {
  for (const [ticket, p] of pending) {
    if (p.exp < now) {
      pending.delete(ticket);
      byCode.delete(p.code);
    }
  }
}

/**
 * Hand out a code. With a subject the name that says it is added to that
 * person; without one (name sign-in) only `name` may say it.
 */
function beginCode({ subject = null, name = null, now = Date.now() } = {}) {
  sweep(now);
  if (pending.size >= MAX_PENDING) fail(503, 'Too many sign-ins waiting. Try again in a few minutes.');
  let lower = null;
  if (!subject) {
    const clean = String(name || '').trim();
    if (!/^[A-Za-z0-9_. -]{2,32}$/.test(clean)) fail(400, 'Enter your in-game name (2 to 32 letters, numbers or _)');
    lower = clean;
  }
  const ticket = crypto.randomBytes(18).toString('base64url');
  const code = newCode();
  pending.set(ticket, { code, subject, name: lower, exp: now + CODE_MS, done: null });
  byCode.set(code, ticket);
  return { ticket, code, expiresIn: CODE_MS / 1000 };
}

/** Called for every chat line: a pending code said by the right name links that name. */
function onChat(manager, server, name, text, now = Date.now()) {
  if (!byCode.size) return;
  const m = CODE_RE.exec(String(text));
  if (!m) return;
  const code = `GP-${m[1].toUpperCase()}`;
  const p = pending.get(byCode.get(code));
  if (!p || p.done || p.exp < now) return;
  if (p.name && p.name.toLowerCase() !== String(name).toLowerCase()) return;
  p.done = { serverId: server.id, name: String(name) };
  byCode.delete(code);
  if (p.subject) addClaim(manager.store, p.subject, server.id, name, now);
}

function addClaim(store, subject, serverId, name, now = Date.now()) {
  const claims = (stateOf(store).claims[subject] ||= []);
  if (claims.some((c) => c.serverId === serverId && c.name.toLowerCase() === name.toLowerCase())) return;
  claims.push({ serverId, name, at: now });
  if (claims.length > MAX_NAMES) claims.shift();
  store.save();
}

/** Where a code stands. A verified name sign-in is handed over once. */
function codeStatus(store, ticket, now = Date.now()) {
  const p = pending.get(String(ticket));
  if (!p || p.exp < now) return { state: 'expired' };
  if (!p.done) return { state: 'waiting' };
  pending.delete(String(ticket));
  if (p.subject) return { state: 'verified', name: p.done.name, added: true };
  const subject = `name:${p.done.name.toLowerCase()}`;
  signIn(store, subject, p.done.name);
  addClaim(store, subject, p.done.serverId, p.done.name, now);
  return { state: 'verified', name: p.done.name, subject };
}

function removeClaim(store, subject, serverId, name) {
  const claims = stateOf(store).claims[subject] || [];
  const next = claims.filter((c) => !(c.serverId === serverId && c.name.toLowerCase() === String(name).toLowerCase()));
  if (next.length === claims.length) fail(404, 'That name is not linked');
  stateOf(store).claims[subject] = next;
  store.save();
}

/* ---------------------------------------------------------------- data -- */

/** Everything the portal shows one player. Names, play time, stats, their own bans: no admin data. */
function viewFor(store, manager, subject, now = Date.now()) {
  const state = stateOf(store);
  const covered = new Map(servers(store, manager).map((s) => [s.id, s]));
  const claims = (state.claims[subject] || []).filter((c) => covered.has(c.serverId));
  const [kind] = subject.split(':');
  const rank = (server, name) => {
    const all = manager.playerHistory(server.id).players.slice().sort((a, b) => b.seconds - a.seconds);
    const i = all.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    return i < 0 ? null : { place: i + 1, of: all.length };
  };
  const profiles = claims.map((c) => {
    const server = covered.get(c.serverId);
    const history = manager.playerHistory(server.id).players.find((p) => p.name.toLowerCase() === c.name.toLowerCase());
    let stats = null;
    try {
      stats = manager.playerStats?.(server, c.name) || null;
    } catch {
      stats = null;
    }
    return {
      name: c.name,
      server: { id: server.id, name: server.name, game: manager.template(server)?.name || server.templateId },
      linkedAt: c.at,
      online: Boolean(history?.online),
      firstSeen: history?.first || null,
      lastSeen: history?.last || null,
      hours: history ? Math.round(history.seconds / 360) / 10 : 0,
      sessions: history?.sessions || 0,
      rank: history ? rank(server, c.name) : null,
      stats: stats && { deaths: stats.deaths, mobKills: stats.mobKills, playerKills: stats.playerKills, mined: stats.mined, km: stats.km, advancements: stats.advancements },
    };
  });

  const names = new Set(claims.map((c) => c.name.toLowerCase()));
  const bs = store.state.bans || { list: [], appeals: [] };
  const bans = bs.list
    .filter((b) => names.has(String(b.name).toLowerCase()))
    .map((b) => {
      const appeal = (bs.appeals || []).filter((a) => a.banId === b.id).sort((x, y) => y.at - x.at)[0];
      return { name: b.name, reason: b.reason || '', at: b.at, until: b.until || null, active: !b.until || b.until > now, appeal: appeal ? { status: appeal.status, reply: appeal.reply || '', at: appeal.at } : null };
    });

  const accounts = [];
  if (kind === 'steam' || kind === 'discord') accounts.push({ kind, label: state.accounts[subject] || subject });
  for (const c of claims) accounts.push({ kind: 'game', label: c.name, server: covered.get(c.serverId).name });
  return { subject: kind, profiles, bans, accounts, appeals: Boolean(store.state.settings.appeals?.enabled), updatedAt: now };
}

module.exports = { PROVIDERS: ['steam', 'discord'], loginCookie, COOKIE, settings, update, servers, cookieFor, clearCookie, sessionFrom, signIn, beginCode, onChat, codeStatus, addClaim, removeClaim, viewFor, _pending: pending, _byCode: byCode };
