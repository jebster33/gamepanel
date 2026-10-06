'use strict';

/**
 * Per-user quotas. Accounts with the "Create their own servers" permission can
 * deploy servers themselves, up to a number of servers, an amount of memory
 * and an amount of disk. The servers they create are theirs: they get full
 * access to them and can delete them.
 *
 * A field of 0 means no limit for that field.
 */

const { fail } = require('../core/util');

const DEFAULT_QUOTA = { servers: 1, memoryMb: 4096, diskGb: 20 };

// What the owner of a server can do on it (everything a server has, nothing panel-wide).
const OWNER_PERMISSIONS = ['power', 'console', 'command', 'settings', 'schedules', 'files', 'files.write', 'mods', 'backups', 'backups.restore'];

function quotaFor(user) {
  return { ...DEFAULT_QUOTA, ...(user?.quota || {}) };
}

function cleanQuota(input = {}) {
  const n = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  return { servers: n(input.servers, 1000), memoryMb: n(input.memoryMb, 4 * 1024 * 1024), diskGb: n(input.diskGb, 1024 * 1024) };
}

function owned(manager, user) {
  return manager.servers.filter((s) => s.ownerId && s.ownerId === user.id);
}

function usage(manager, user) {
  const mine = owned(manager, user);
  return {
    servers: mine.length,
    memoryMb: mine.reduce((sum, s) => sum + (Number(s.memory) || 0), 0),
    diskBytes: mine.reduce((sum, s) => sum + (manager.rt(s.id).diskBytes || 0), 0),
  };
}

const GB = 1024 ** 3;

/** Refuse a new server that would go over any of the account's limits. */
function checkCreate(manager, user, memoryMb) {
  const q = quotaFor(user);
  const u = usage(manager, user);
  if (q.servers && u.servers + 1 > q.servers) fail(403, `Your account can have ${q.servers} server${q.servers === 1 ? '' : 's'}. Delete one first, or ask an administrator for more.`);
  if (q.memoryMb && u.memoryMb + memoryMb > q.memoryMb) fail(403, `That needs ${memoryMb} MB of memory, and your account has ${Math.max(0, q.memoryMb - u.memoryMb)} MB of its ${q.memoryMb} MB left.`);
  if (q.diskGb && u.diskBytes >= q.diskGb * GB) fail(403, `Your servers already use all of the ${q.diskGb} GB of disk your account has. Free some space first.`);
}

/** Raising one server's memory counts against the account too. */
function checkMemory(manager, user, server, memoryMb) {
  const q = quotaFor(user);
  if (!q.memoryMb || server.ownerId !== user.id) return;
  const others = usage(manager, user).memoryMb - (Number(server.memory) || 0);
  if (others + memoryMb > q.memoryMb) fail(403, `Your account has ${q.memoryMb} MB of memory in total; ${Math.max(0, q.memoryMb - others)} MB is free for this server.`);
}

/** A server whose owner is over their disk quota does not start. */
function checkDisk(manager, server, users) {
  if (!server.ownerId) return;
  const owner = users.find((u) => u.id === server.ownerId);
  if (!owner || owner.role === 'admin') return;
  const q = quotaFor(owner);
  if (q.diskGb && usage(manager, owner).diskBytes > q.diskGb * GB) fail(403, `The owner's servers use more than their ${q.diskGb} GB of disk. Delete files or backups, or ask an administrator for more space.`);
}

/**
 * Names and variables are filled into the game's start command, which runs in
 * a shell. Anyone who is not an administrator may only use characters that
 * cannot end the quoted value or start another command.
 */
const UNSAFE = /["'`$\\;&|<>(){}\r\n\u0000%^!]/;

function assertShellSafe(label, value) {
  if (UNSAFE.test(String(value ?? ''))) fail(400, `${label} cannot contain quotes or any of these: $ \\ ; & | < > ( ) { } % ^ !`);
}

/**
 * Only values that change are checked, so what an administrator set can be
 * saved back as it is; the template's own defaults and listed choices are fine too.
 */
function assertSafeInput({ name, vars } = {}, current = null, template = null) {
  if (name !== undefined && name !== current?.name) assertShellSafe('The server name', name);
  for (const [key, value] of Object.entries(vars || {})) {
    if (current && String(current.vars?.[key] ?? '') === String(value ?? '')) continue;
    const def = (template?.variables || []).find((v) => v.name === key);
    const preset = def ? [def.default, ...(def.options || []).map((o) => (typeof o === 'object' ? o.value : o))] : [];
    if (preset.some((p) => p !== undefined && String(p) === String(value ?? ''))) continue;
    assertShellSafe(`The value for ${key}`, value);
  }
}

module.exports = { DEFAULT_QUOTA, OWNER_PERMISSIONS, quotaFor, cleanQuota, usage, checkCreate, checkMemory, checkDisk, assertSafeInput, assertShellSafe };
