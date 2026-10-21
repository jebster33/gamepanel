'use strict';

/**
 * A LuckPerms editor inside the panel, for Minecraft servers that have the
 * plugin (Paper, Purpur, Spigot; Fabric/Forge/NeoForge builds keep their data
 * in config/luckperms).
 *
 * Reading: the running server is asked to `lp export <file>`; the plugin
 * writes a JSON file (gzipped) into its data folder, the panel parses it into
 * groups and users and deletes it again. The parser goes by the node keys
 * (group.x, weight.n, prefix.n.text, meta.k.v) so it does not depend on
 * details of the file layout.
 *
 * Writing: every change is one console command built from validated fields,
 * token by token. Nothing the user types is ever pasted into a command as-is.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fail } = require('../core/util');
const safefs = require('../core/safefs');
const { containedPath } = require('./files');

const GROUP = /^[a-z0-9_.-]{1,36}$/;
const USER = /^(?:[A-Za-z0-9_.]{1,32}|[0-9a-fA-F-]{32,36})$/;
const NODE = /^[A-Za-z0-9_.*:/-]{1,200}$/;
const CTX_KEY = /^[a-z0-9_.-]{1,32}$/i;
const CTX_VALUE = /^[A-Za-z0-9_.:/-]{1,64}$/;
const META_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const DURATION = /^[0-9]{1,6}[smhdwy]?$/;

const DIRS = ['plugins/LuckPerms', 'config/luckperms', 'plugins/luckperms'];

const isJava = (server) => /^minecraft-(?!bedrock$|velocity$)/.test(String(server.templateId || ''));

function dataDir(server) {
  for (const rel of DIRS) {
    const dir = containedPath(server.dir, rel);
    try {
      if (fs.statSync(dir).isDirectory()) return { rel, dir };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

function installed(server) {
  if (!isJava(server)) return { supported: false, installed: false };
  const found = dataDir(server);
  const jar = (folder) => {
    try {
      return fs.readdirSync(containedPath(server.dir, folder)).some((f) => /^luckperms.*\.jar$/i.test(f));
    } catch {
      return false;
    }
  };
  return { supported: true, installed: Boolean(found) || jar('plugins') || jar('mods'), dataFolder: found?.rel || null };
}

/* ------------------------------------------------------------- reading -- */

const text = (v) => String(v ?? '');

/** One exported node as { key, value, expiry, context }. Tolerates a few spellings. */
function nodeOf(n, fallbackValue = true) {
  if (typeof n === 'string') return { key: n, value: fallbackValue, expiry: 0, context: {} };
  if (!n || typeof n !== 'object') return null;
  const key = n.key ?? n.permission ?? n.node;
  if (!key) return null;
  return { key: text(key), value: n.value === undefined ? fallbackValue : Boolean(n.value), expiry: Number(n.expiry) || 0, context: n.context && typeof n.context === 'object' && !Array.isArray(n.context) ? n.context : {} };
}

function nodeList(entity) {
  const raw = entity?.nodes ?? entity?.permissions ?? [];
  if (Array.isArray(raw)) return raw.map((n) => nodeOf(n)).filter(Boolean);
  if (raw && typeof raw === 'object') return Object.entries(raw).map(([k, v]) => nodeOf({ key: k, value: v })).filter(Boolean);
  return [];
}

/** Split an entity's nodes into permissions, parents, weight, prefix/suffix and meta. */
function classify(entity) {
  const out = { permissions: [], parents: [], weight: null, prefixes: [], suffixes: [], meta: [], displayName: null };
  for (const n of nodeList(entity)) {
    const k = n.key;
    let m;
    if ((m = /^group\.(.+)$/i.exec(k)) && n.value) out.parents.push({ group: m[1].toLowerCase(), context: n.context, expiry: n.expiry });
    else if ((m = /^weight\.(-?\d+)$/i.exec(k))) out.weight = Number(m[1]);
    else if ((m = /^prefix\.(-?\d+)\.([\s\S]*)$/i.exec(k))) out.prefixes.push({ priority: Number(m[1]), text: m[2], context: n.context });
    else if ((m = /^suffix\.(-?\d+)\.([\s\S]*)$/i.exec(k))) out.suffixes.push({ priority: Number(m[1]), text: m[2], context: n.context });
    else if ((m = /^meta\.([^.]+)\.([\s\S]*)$/i.exec(k))) out.meta.push({ key: m[1], value: m[2], context: n.context });
    else if ((m = /^displayname\.([\s\S]*)$/i.exec(k))) out.displayName = m[1];
    else out.permissions.push({ node: k, value: n.value, context: n.context, expiry: n.expiry });
  }
  out.prefixes.sort((a, b) => b.priority - a.priority);
  out.suffixes.sort((a, b) => b.priority - a.priority);
  out.permissions.sort((a, b) => a.node.localeCompare(b.node));
  return out;
}

/** Parse the contents of an `lp export` file (gzipped or plain JSON). */
function parseExport(buf) {
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf, { maxOutputLength: 64 * 1024 * 1024 }) : buf;
  let json;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    fail(502, 'LuckPerms wrote an export the panel could not read. It may be an older format; update LuckPerms.');
  }
  const groups = Object.entries(json.groups || {})
    .map(([name, g]) => ({ name: name.toLowerCase(), ...classify(g) }))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.name.localeCompare(b.name));
  const users = Object.entries(json.users || {})
    .map(([uuid, u]) => ({ uuid, name: u.username || u.name || null, primaryGroup: u.primaryGroup || 'default', ...classify(u) }))
    .sort((a, b) => text(a.name || a.uuid).localeCompare(text(b.name || b.uuid)));
  const tracks = Object.entries(json.tracks || {}).map(([name, t]) => ({ name, groups: Array.isArray(t) ? t : t?.groups || [] }));
  return { groups, users: users.slice(0, 500), userCount: users.length, tracks };
}

/** Ask the server for an export and read it. The server must be running. */
async function read(manager, server, { wait = 12000 } = {}) {
  const info = installed(server);
  if (!info.supported) fail(400, 'LuckPerms is for Minecraft Java servers');
  if (!info.installed) fail(404, 'LuckPerms is not installed on this server. Add it on the Mods tab (search "LuckPerms") and restart.');
  if (manager.rt(server.id).status !== 'running') fail(409, 'Start the server to read LuckPerms (it keeps its data in a database the panel asks over the console).');
  const found = dataDir(server);
  if (!found) fail(409, 'LuckPerms has not created its folder yet. Start the server once with the plugin and try again.');
  const name = `gp-export-${Date.now().toString(36)}`;
  const files = [`${name}.json.gz`, `${name}.json`].map((f) => path.join(found.dir, f));
  await manager.sendCommand(server.id, `lp export ${name}`);
  const deadline = Date.now() + wait;
  let buf = null;
  while (Date.now() < deadline && !buf) {
    await new Promise((r) => setTimeout(r, 400));
    for (const f of files) {
      try {
        const candidate = safefs.readRegular(f, 64 * 1024 * 1024);
        // The file can still be growing: only trust one that parses.
        parseExport(candidate);
        buf = candidate;
        break;
      } catch (err) {
        if (err.status === 502 || err.code === 'Z_BUF_ERROR' || err.code === 'Z_DATA_ERROR') continue;
      }
    }
  }
  for (const f of files) fs.rmSync(f, { force: true });
  if (!buf) fail(504, 'LuckPerms did not produce an export in time. Check the console for a LuckPerms error.');
  return { ...parseExport(buf), dataFolder: found.rel };
}

/* ------------------------------------------------------------- writing -- */

function group(name) {
  const g = String(name || '').trim().toLowerCase();
  if (!GROUP.test(g)) fail(400, 'Group names use letters, numbers, dots, dashes and underscores (up to 36)');
  return g;
}

function userName(name) {
  const u = String(name || '').trim();
  if (!USER.test(u)) fail(400, 'Use a player name or a UUID');
  return u;
}

function nodeKey(node) {
  const n = String(node || '').trim();
  if (!NODE.test(n)) fail(400, 'Permission nodes use letters, numbers and . _ - * : /');
  return n;
}

/** A free-text value (prefix, meta) as one command argument: no control characters, no quotes, quoted when it holds spaces. */
function arg(value, label, max = 80) {
  const v = String(value ?? '');
  if (!v.length || v.length > max) fail(400, `${label} must be 1 to ${max} characters`);
  if (/[\u0000-\u001f\u007f"\\]/.test(v)) fail(400, `${label} cannot contain quotes, backslashes or control characters`);
  return /\s/.test(v) ? `"${v}"` : v;
}

function contexts(ctx) {
  const out = [];
  for (const [k, v] of Object.entries(ctx && typeof ctx === 'object' ? ctx : {}).slice(0, 4)) {
    if (!k && !v) continue;
    if (!CTX_KEY.test(k) || !CTX_VALUE.test(String(v))) fail(400, 'Contexts look like server=survival or world=world_nether');
    out.push(`${k}=${v}`);
  }
  return out;
}

const int = (v, label, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
};

/** Who an action is about: ['group', name] or ['user', name]. */
function holder(body) {
  if (body.type === 'group') return ['group', group(body.name)];
  if (body.type === 'user') return ['user', userName(body.name)];
  return fail(400, 'Pick a group or a user');
}

/**
 * One validated console command (an array of tokens, joined with spaces) for an action.
 * Throws 400 for anything not on the list.
 */
function build(body) {
  const action = String(body?.action || '');
  switch (action) {
    case 'group.create':
      return ['lp', 'creategroup', group(body.name)];
    case 'group.delete': {
      const g = group(body.name);
      if (g === 'default') fail(400, 'The default group cannot be deleted');
      return ['lp', 'deletegroup', g];
    }
    case 'permission.set': {
      const [kind, who] = holder(body);
      const cmd = ['lp', kind, who, 'permission', body.duration ? 'settemp' : 'set', nodeKey(body.node), body.value === false ? 'false' : 'true'];
      if (body.duration) {
        if (!DURATION.test(String(body.duration))) fail(400, 'Durations look like 7d, 12h or 30m');
        cmd.push(String(body.duration));
      }
      return [...cmd, ...contexts(body.context)];
    }
    case 'permission.unset': {
      const [kind, who] = holder(body);
      return ['lp', kind, who, 'permission', 'unset', nodeKey(body.node), ...contexts(body.context)];
    }
    case 'weight.set':
      return ['lp', 'group', group(body.name), 'setweight', String(int(body.weight, 'Weight', -100000, 100000))];
    case 'parent.add':
    case 'parent.remove':
    case 'parent.set': {
      const [kind, who] = holder(body);
      return ['lp', kind, who, 'parent', action.slice(7), group(body.parent), ...contexts(body.context)];
    }
    case 'prefix.set':
    case 'suffix.set': {
      const [kind, who] = holder(body);
      const which = action.slice(0, 6);
      return ['lp', kind, who, 'meta', `add${which}`, String(int(body.priority, 'Priority', -100000, 100000)), arg(body.text, 'The text'), ...contexts(body.context)];
    }
    case 'prefix.remove':
    case 'suffix.remove': {
      const [kind, who] = holder(body);
      const which = action.slice(0, 6);
      return ['lp', kind, who, 'meta', `remove${which}`, String(int(body.priority, 'Priority', -100000, 100000))];
    }
    case 'meta.set': {
      const [kind, who] = holder(body);
      if (!META_KEY.test(String(body.key || ''))) fail(400, 'Meta keys use letters, numbers and . _ -');
      return ['lp', kind, who, 'meta', 'set', String(body.key), arg(body.value, 'The value', 120), ...contexts(body.context)];
    }
    case 'meta.unset': {
      const [kind, who] = holder(body);
      if (!META_KEY.test(String(body.key || ''))) fail(400, 'Meta keys use letters, numbers and . _ -');
      return ['lp', kind, who, 'meta', 'unset', String(body.key)];
    }
    case 'user.primary': {
      return ['lp', 'user', userName(body.name), 'parent', 'set', group(body.parent)];
    }
    default:
      return fail(400, 'Unknown LuckPerms action');
  }
}

async function run(manager, server, body, actor) {
  const info = installed(server);
  if (!info.supported || !info.installed) fail(404, 'LuckPerms is not installed on this server');
  if (manager.rt(server.id).status !== 'running') fail(409, 'Start the server to change permissions');
  const command = build(body).join(' ');
  await manager.sendCommand(server.id, command);
  manager.logActivity?.(server.id, { type: 'permission', text: command, by: actor });
  return { ok: true, command };
}

module.exports = { installed, read, run, build, parseExport, classify, isJava };
