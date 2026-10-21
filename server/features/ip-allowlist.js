'use strict';

/**
 * IP allowlist for the panel: only listed addresses (CIDR ranges, IPv4 or
 * IPv6) may sign in or use the API.
 *
 *   settings.ipAllowlist = { enabled, cidrs: [..], roles: ['admin', 'user'] }
 *   user.allowedIps      = [..]   optional, replaces the shared list for that account
 *
 * Loopback (this machine) is always allowed, so the panel can always be
 * reached from its own host. Turning it on is refused if it would lock out
 * the person turning it on, and `node server/reset-allowlist.js` switches it
 * off from the command line when someone gets locked out anyway.
 *
 * The address is the one the panel resolves behind its proxies (clientIp).
 * Blocked attempts go in the audit log, a few per address so a flood cannot
 * fill it.
 */

const { fail } = require('../core/util');
const cidr = require('../core/cidr');
const { RateLimiter } = require('../core/ratelimit');
const audit = require('./audit');

const ROLES = ['admin', 'user'];
const MAX_ENTRIES = 100;
// Reachable even when the address is not allowed, so the page can say why.
const OPEN_PATHS = ['/api/status', '/api/auth/logout'];

const perAddress = new RateLimiter({ limit: 1, windowMs: 10 * 60_000 });
const overall = new RateLimiter({ limit: 60, windowMs: 60 * 60_000 });

const parsed = new Map();
/** Ranges for a list of texts, parsed once. */
function ranges(list) {
  const key = (list || []).join('|');
  let out = parsed.get(key);
  if (!out) {
    out = (list || []).map(cidr.parseCidr).filter(Boolean);
    if (parsed.size > 500) parsed.clear();
    parsed.set(key, out);
  }
  return out;
}

const config = (store) => {
  const c = store.state.settings.ipAllowlist || {};
  return { enabled: Boolean(c.enabled), cidrs: Array.isArray(c.cidrs) ? c.cidrs : [], roles: Array.isArray(c.roles) && c.roles.length ? c.roles.filter((r) => ROLES.includes(r)) : ROLES.slice() };
};

/** Is this address allowed for this account under the given settings? */
function allowed(settings, user, ip) {
  if (!settings.enabled) return true;
  if (cidr.isLoopback(ip)) return true;
  if (user?.allowedIps?.length) return cidr.matchesAny(ranges(user.allowedIps), ip);
  if (!settings.roles.includes(user?.role)) return true;
  return cidr.matchesAny(ranges(settings.cidrs), ip);
}

function logBlocked(who, ip, how, path) {
  if (!perAddress.take(ip) || !overall.take('all')) return;
  audit.record({ user: who || null, ip, action: `blocked by the IP allowlist (${how})`, path, status: 403, error: 'Address not allowed' });
}

const REFUSED = 'This address is not allowed to sign in to this panel. Ask an administrator to add it to the IP allowlist.';

/** Called after a password/passkey/SSO check passed, before a session starts. */
function checkSignIn(store, user, ip) {
  if (allowed(config(store), user, ip)) return;
  logBlocked(user?.username, ip, 'sign-in');
  fail(403, REFUSED);
}

/** Called for every signed-in request and WebSocket. */
function checkRequest(store, user, req) {
  const settings = config(store);
  if (!settings.enabled) return;
  const ip = require('../api/helpers').clientIp(req);
  if (allowed(settings, user, ip)) return;
  logBlocked(user?.username, ip, 'request', String(req.url || '').split('?')[0].slice(0, 120));
  fail(403, REFUSED);
}

/**
 * Public routes (sign-in, passkeys, SSO). Only when every account is covered
 * does the door close for strangers; otherwise the check happens once the
 * account is known.
 */
function checkPublic(store, req, pathname) {
  const settings = config(store);
  if (!settings.enabled || OPEN_PATHS.includes(pathname)) return;
  if (!ROLES.every((r) => settings.roles.includes(r))) return;
  const ip = require('../api/helpers').clientIp(req);
  if (cidr.isLoopback(ip) || cidr.matchesAny(ranges(settings.cidrs), ip)) return;
  // An account with its own list may come from outside the shared list.
  const own = store.state.users.some((u) => u.allowedIps?.length && cidr.matchesAny(ranges(u.allowedIps), ip));
  if (own) return;
  logBlocked(null, ip, 'sign-in page', pathname.slice(0, 120));
  fail(403, REFUSED);
}

/* ------------------------------------------------------------ settings -- */

function view(store, user, req) {
  const ip = require('../api/helpers').clientIp(req);
  const settings = config(store);
  return {
    ...settings,
    yourIp: ip,
    yourIpAllowed: allowed({ ...settings, enabled: true }, user, ip),
    loopback: cidr.isLoopback(ip),
    behindProxy: Boolean(require('../core/config').config.behindProxy),
    max: MAX_ENTRIES,
    accounts: store.state.users.map((u) => ({ id: u.id, username: u.username, role: u.role, allowedIps: u.allowedIps || [] })),
  };
}

function cleanList(items, what) {
  const { ranges: list, bad } = cidr.parseList(items);
  if (bad.length) fail(400, `Not a valid address or range in ${what}: ${bad.slice(0, 3).join(', ')}. Use forms like 203.0.113.7, 10.0.0.0/8 or 2001:db8::/32.`);
  if (list.length > MAX_ENTRIES) fail(400, `At most ${MAX_ENTRIES} entries`);
  return list;
}

/** body: { enabled, cidrs, roles }. Refuses a change that would lock the requester out. */
function update(store, requester, ip, body) {
  const current = config(store);
  const next = {
    enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
    cidrs: body.cidrs === undefined ? current.cidrs : cleanList(body.cidrs, 'the list'),
    roles: body.roles === undefined ? current.roles : [...new Set([].concat(body.roles).filter((r) => ROLES.includes(r)))],
  };
  if (!next.roles.length) fail(400, 'Choose at least one kind of account');
  if (next.enabled && !allowed(next, store.state.users.find((u) => u.id === requester.id) || requester, ip)) {
    fail(400, `That would lock you out: you are connecting from ${ip}, which the list does not include. Add it first (or your network's range), then turn the allowlist on.`);
  }
  store.state.settings.ipAllowlist = next;
  store.save();
  return next;
}

/** Replace (or clear, with an empty list) one account's own allowlist. */
function setAccount(store, requester, ip, userId, list) {
  const target = store.state.users.find((u) => u.id === userId);
  if (!target) fail(404, 'Account not found');
  const clean = cleanList(list, `${target.username}'s list`);
  const before = target.allowedIps;
  if (clean.length) target.allowedIps = clean;
  else delete target.allowedIps;
  if (target.id === requester.id && !allowed(config(store), target, ip)) {
    if (before) target.allowedIps = before;
    else delete target.allowedIps;
    fail(400, `That would lock you out: you are connecting from ${ip}, which is not in your own list.`);
  }
  store.save();
  return target;
}

/** For the offline recovery script: off, and every per-account list cleared if asked. */
function reset(state, { accounts = false } = {}) {
  if (state.settings.ipAllowlist) state.settings.ipAllowlist.enabled = false;
  if (accounts) for (const u of state.users) delete u.allowedIps;
}

module.exports = { ROLES, REFUSED, allowed, config, checkSignIn, checkRequest, checkPublic, view, update, setAccount, reset };
