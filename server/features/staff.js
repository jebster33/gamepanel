'use strict';

/**
 * Staff tools: who moderated what (from the audit log, shared bans and player
 * notes), named ban/kick reason templates, role templates (bundles of
 * per-server permissions) and time-limited access grants.
 *
 * store.state.staff = { reasons: [{ id, name, reason, hours, appeal }],
 *   roles: [{ id, name, description, permissions }]   // overrides of the defaults and custom roles
 *   grants: [{ id, userId, serverId, expiresAt, by, at, roleId, permissions, prev }] }
 */

const { uid, fail } = require('../core/util');
const { sanitizePermissions } = require('../core/auth');
const audit = require('./audit');

const stateOf = (store) => (store.state.staff ||= { reasons: [], roles: [], grants: [] });
const MAX_REASONS = 50;
const MAX_ROLES = 40;
const MAX_GRANT_HOURS = 24 * 365;
const DAY = 86_400_000;

/* ------------------------------------------------------------- activity -- */

const KINDS = ['kick', 'ban', 'unban', 'note', 'appeal', 'moderation'];

/** What kind of moderation an audit entry was, or null when it was something else. */
function classify(entry) {
  const a = String(entry.action || '').toLowerCase();
  const path = String(entry.path || '').toLowerCase();
  if (/\bkick\b/.test(a)) return 'kick';
  if (/unban|^delete .*\bbans?\b/.test(a)) return 'unban';
  if (/appeal/.test(a)) return 'appeal';
  if (/ban/.test(a)) return 'ban';
  if (/players note/.test(a)) return 'note';
  if (/moderation|\bmute\b|whitelist|player-lists|\blists\b/.test(a) || /\/moderation|\/lists/.test(path)) return 'moderation';
  return null;
}

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
function weekKey(t) {
  const d = new Date(`${dayKey(t)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
}

/** Every moderation action, newest first: { at, user, kind, text, server }. */
function events({ store, auditList = audit.list, since = 0 }) {
  const out = [];
  for (const e of auditList({ limit: 50000 })) {
    if (e.at < since || (e.status && e.status >= 400) || !e.user || e.user === 'system') continue;
    const kind = classify(e);
    if (!kind) continue;
    const d = e.details || {};
    out.push({ at: e.at, user: e.user, kind, text: [e.action, d.name || d.player, d.reason].filter(Boolean).join(' · '), server: e.server || '' });
  }
  const near = (user, kind, at) => out.some((x) => x.user === user && x.kind === kind && Math.abs(x.at - at) < 60_000);
  // Shared bans and notes the audit log may have lost (rotated away) are added once.
  for (const b of store.state.bans?.list || []) {
    if (b.by && b.at >= since && !near(b.by, 'ban', b.at)) out.push({ at: b.at, user: b.by, kind: 'ban', text: `ban ${b.name}${b.reason ? ` · ${b.reason}` : ''}`, server: '' });
  }
  for (const [name, n] of Object.entries(store.state.playerNotes || {})) {
    if (n.by && n.at >= since && !near(n.by, 'note', n.at)) out.push({ at: n.at, user: n.by, kind: 'note', text: `note on ${name}`, server: '' });
  }
  return out.sort((a, b) => b.at - a.at);
}

const blank = (user, role) => ({ user, role, total: 0, last: null, kinds: {}, days: {}, weeks: {}, recent: [] });

/** Per-staff summary with counts per day (30 days) and week (12 weeks). */
function summary({ store, auth, now = Date.now(), auditList }) {
  const all = events({ store, auditList });
  const names = new Map(auth.users.map((u) => [u.username, u]));
  const people = new Map();
  for (const [username, u] of names) people.set(username, blank(username, u.role));
  for (const e of all) {
    if (!people.has(e.user)) people.set(e.user, blank(e.user, 'removed'));
    const p = people.get(e.user);
    p.total++;
    p.last = Math.max(p.last || 0, e.at);
    p.kinds[e.kind] = (p.kinds[e.kind] || 0) + 1;
    if (now - e.at <= 30 * DAY) p.days[dayKey(e.at)] = (p.days[dayKey(e.at)] || 0) + 1;
    if (now - e.at <= 84 * DAY) p.weeks[weekKey(e.at)] = (p.weeks[weekKey(e.at)] || 0) + 1;
    if (p.recent.length < 100) p.recent.push(e);
  }
  const staff = [...people.values()].sort((a, b) => b.total - a.total || a.user.localeCompare(b.user));
  return { staff, kinds: KINDS };
}

/* ------------------------------------------------------ reason templates -- */

const oneLine = (s, max) => String(s ?? '').replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, max);

function cleanReason(input) {
  const name = oneLine(input.name, 40);
  if (!name) fail(400, 'Give the template a name');
  const hours = Number(input.hours) || 0;
  if (hours < 0 || hours > MAX_GRANT_HOURS) fail(400, 'Duration must be between 0 (permanent) and 8760 hours');
  return { name, reason: oneLine(input.reason, 200), hours: Math.round(hours * 100) / 100, appeal: oneLine(input.appeal, 100) };
}

const reasonList = (store) => stateOf(store).reasons;

function saveReason(store, input, id) {
  const s = stateOf(store);
  const clean = cleanReason(input || {});
  if (s.reasons.some((r) => r.name.toLowerCase() === clean.name.toLowerCase() && r.id !== id)) fail(409, 'A template with that name already exists');
  if (id) {
    const t = s.reasons.find((r) => r.id === id);
    if (!t) fail(404, 'Template not found');
    Object.assign(t, clean);
    store.save();
    return t;
  }
  if (s.reasons.length >= MAX_REASONS) fail(400, 'Too many reason templates');
  const t = { id: uid(8), ...clean };
  s.reasons.push(t);
  store.save();
  return t;
}

function deleteReason(store, id) {
  const s = stateOf(store);
  if (!s.reasons.some((r) => r.id === id)) fail(404, 'Template not found');
  s.reasons = s.reasons.filter((r) => r.id !== id);
  store.save();
}

/**
 * Fill reason and duration from a template when one is named. Whatever the
 * caller typed wins; the appeal text is added to the end of the reason.
 */
function applyReason(store, { template, reason, hours } = {}) {
  if (!template) return { reason, hours };
  const t = reasonList(store).find((r) => r.id === template);
  if (!t) fail(400, 'That reason template no longer exists');
  const text = String(reason ?? '').trim() || t.reason;
  const full = [text, t.appeal].filter(Boolean).join(' - ').slice(0, 200);
  return { reason: full, hours: Number(hours) > 0 ? hours : t.hours, template: t.name };
}

/* -------------------------------------------------------- role templates -- */

const DEFAULT_ROLES = [
  { id: 'helper', name: 'Helper', description: 'Watches the console and can look at activity.', permissions: ['console', 'activity'] },
  { id: 'moderator', name: 'Moderator', description: 'Runs player commands (kick, ban, mute) and sees the console and activity.', permissions: ['console', 'command', 'activity'] },
  { id: 'builder', name: 'Builder', description: 'Manages files and mods but cannot restart the server.', permissions: ['console', 'files', 'files.write', 'mods'] },
  { id: 'operator', name: 'Operator', description: 'Starts, stops and backs up the server.', permissions: ['power', 'console', 'command', 'schedules', 'backups', 'activity'] },
  { id: 'manager', name: 'Manager', description: 'Everything on this server except restoring backups.', permissions: ['power', 'console', 'command', 'settings', 'schedules', 'files', 'files.write', 'mods', 'backups', 'activity'] },
];

function roles(store) {
  const custom = stateOf(store).roles;
  const out = DEFAULT_ROLES.map((r) => {
    const o = custom.find((c) => c.id === r.id);
    return o ? { ...o, builtin: true, modified: true } : { ...r, builtin: true, modified: false };
  });
  for (const c of custom) if (!DEFAULT_ROLES.some((r) => r.id === c.id)) out.push({ ...c, builtin: false, modified: false });
  return out;
}

const findRole = (store, id) => roles(store).find((r) => r.id === id);

function saveRole(store, input, id) {
  const s = stateOf(store);
  const name = oneLine(input?.name, 40);
  if (!name) fail(400, 'Give the role a name');
  if (!Array.isArray(input?.permissions)) fail(400, 'Choose the permissions');
  // Per-server bundles only: the panel-wide capabilities are never part of a role.
  const permissions = sanitizePermissions(input.permissions).filter((p) => p !== 'deploy' && p !== 'templates');
  const entry = { name, description: oneLine(input.description, 140), permissions };
  if (roles(store).some((r) => r.name.toLowerCase() === name.toLowerCase() && r.id !== id)) fail(409, 'A role with that name already exists');
  if (id) {
    if (!findRole(store, id)) fail(404, 'Role not found');
    const i = s.roles.findIndex((r) => r.id === id);
    if (i >= 0) s.roles[i] = { id, ...entry };
    else s.roles.push({ id, ...entry });
  } else {
    if (s.roles.length >= MAX_ROLES) fail(400, 'Too many role templates');
    id = uid(8);
    s.roles.push({ id, ...entry });
  }
  store.save();
  return findRole(store, id);
}

/** Deletes a custom role, or resets a changed built-in one to its default. */
function deleteRole(store, id) {
  const s = stateOf(store);
  const isDefault = DEFAULT_ROLES.some((r) => r.id === id);
  if (!s.roles.some((r) => r.id === id)) fail(isDefault ? 400 : 404, isDefault ? 'Built-in roles cannot be deleted, only changed' : 'Role not found');
  s.roles = s.roles.filter((r) => r.id !== id);
  store.save();
}

/** Write permissions onto a sub-user for one server, validated the way the Access tab does. */
function grantServer(target, serverId, permissions) {
  if (target.role === 'admin') fail(400, 'Administrators already have every server');
  target.servers = [...new Set([...(target.servers || []), serverId])];
  target.serverPerms = { ...(target.serverPerms || {}), [serverId]: sanitizePermissions(permissions) };
}

function revokeServer(target, serverId) {
  target.servers = (target.servers || []).filter((id) => id !== serverId);
  if (target.serverPerms) delete target.serverPerms[serverId];
}

function permissionsOf(store, { role, permissions }) {
  if (role) {
    const r = findRole(store, role);
    if (!r) fail(400, 'That role template does not exist');
    return r.permissions;
  }
  if (!Array.isArray(permissions)) fail(400, 'Pick a role template or some permissions');
  return permissions;
}

function applyRole(store, auth, serverId, userId, roleId) {
  const target = auth.users.find((u) => u.id === userId);
  if (!target) fail(404, 'User not found');
  const perms = permissionsOf(store, { role: roleId });
  grantServer(target, serverId, perms);
  store.save();
  return { user: target, permissions: sanitizePermissions(perms) };
}

/* ----------------------------------------------------------------- grants -- */

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function grantsFor(store, serverId, now = Date.now()) {
  return stateOf(store)
    .grants.filter((g) => g.expiresAt > now && (!serverId || g.serverId === serverId))
    .map(({ prev, ...g }) => g);
}

/** Give someone access to a server until a time: a role or a list of permissions. */
function createGrant(store, auth, { serverId, userId, role, permissions, hours, until }, now = Date.now(), by = '') {
  const target = auth.users.find((u) => u.id === userId);
  if (!target) fail(404, 'User not found');
  const expiresAt = until ? Number(new Date(until)) : now + Number(hours) * 3_600_000;
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 1000) fail(400, 'Choose a time in the future');
  if (expiresAt > now + MAX_GRANT_HOURS * 3_600_000) fail(400, 'Access can be granted for at most a year');
  const perms = sanitizePermissions(permissionsOf(store, { role, permissions }));
  if (!perms.length) fail(400, 'Choose at least one permission');
  if (target.role === 'admin') fail(400, 'Administrators already have every server');
  const s = stateOf(store);
  // Replace an earlier grant for the same person and server; keep what they held before the first one.
  const earlier = s.grants.find((g) => g.userId === userId && g.serverId === serverId);
  const prev = earlier ? earlier.prev : { had: (target.servers || []).includes(serverId), perms: target.serverPerms?.[serverId] || null };
  s.grants = s.grants.filter((g) => g !== earlier);
  grantServer(target, serverId, perms);
  const grant = { id: uid(8), userId, username: target.username, serverId, expiresAt, by, at: now, roleId: role || null, permissions: perms, prev };
  s.grants.push(grant);
  store.save();
  const { prev: _prev, ...pub } = grant;
  return pub;
}

/** Undo one grant: restore what they held before, unless an administrator changed it since. */
function endGrant(store, auth, grant, why, serverName = '') {
  const s = stateOf(store);
  s.grants = s.grants.filter((g) => g !== grant);
  const target = auth.users.find((u) => u.id === grant.userId);
  if (target && target.role !== 'admin') {
    const now = target.serverPerms?.[grant.serverId];
    // Someone an administrator already removed stays removed.
    if ((target.servers || []).includes(grant.serverId) && (!now || sameSet(sanitizePermissions(now), grant.permissions))) {
      if (grant.prev?.had) {
        target.serverPerms = { ...(target.serverPerms || {}) };
        if (grant.prev.perms) target.serverPerms[grant.serverId] = grant.prev.perms;
        else delete target.serverPerms[grant.serverId];
      } else revokeServer(target, grant.serverId);
    }
  }
  store.save();
  store.addEvent('user.updated', `Temporary access for ${grant.username} on ${serverName || grant.serverId} ${why}`, { serverId: grant.serverId });
  audit.record({ user: 'system', action: `access grant ${why}`, serverId: grant.serverId, server: serverName, details: { user: grant.username }, status: 200 });
}

const nameOf = (manager, id) => manager?.servers?.find((x) => x.id === id)?.name;

/** Remove every grant that has run out (every minute, and once at boot). */
function expireGrants(store, auth, manager, now = Date.now()) {
  const due = stateOf(store).grants.filter((g) => g.expiresAt <= now);
  for (const g of due) endGrant(store, auth, g, 'expired', nameOf(manager, g.serverId));
  return due.length;
}

function revokeGrant(store, auth, manager, serverId, grantId, by) {
  const g = stateOf(store).grants.find((x) => x.id === grantId && x.serverId === serverId);
  if (!g) fail(404, 'Grant not found');
  endGrant(store, auth, g, `ended early by ${by}`, nameOf(manager, serverId));
}

module.exports = {
  KINDS, classify, events, summary,
  reasonList, saveReason, deleteReason, applyReason,
  roles, DEFAULT_ROLES, saveRole, deleteRole, applyRole, grantServer,
  grantsFor, createGrant, expireGrants, revokeGrant,
};
