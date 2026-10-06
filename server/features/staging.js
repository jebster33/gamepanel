'use strict';

/**
 * Staging copies: a copy of a server on its own ports to try plugin and mod
 * updates or config changes on, then push what changed to the live server.
 *
 * Pushing copies the chosen top-level folders and files from staging to
 * live (adding, replacing and removing files inside them), merges
 * server.properties without touching live's ports, and can bring over the
 * game version. Live keeps its own world, player lists, logs and panel data
 * unless the world is picked on purpose. A backup of live is always made
 * first, and live is stopped for the push and started again after.
 *
 * staging server: { stagingOf: <live id> }
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { fail, logger } = require('../core/util');
const backups = require('./backups');

// Never pushed, never listed: live's own data.
const NEVER = new Set(['.gamepanel', '.gamepanel-install.sh', '.steamcmd', 'logs', 'crash-reports', 'cache', 'usercache.json', 'usernamecache.json', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'session.lock', 'debug', 'eula.txt', 'gamepanel-server.json']);
// Pushed with "game version", not on their own.
const VERSION_DIRS = new Set(['libraries', 'versions', '.fabric', 'bundler']);
// server.properties keys that belong to live.
const KEEP_PROPS = new Set(['server-port', 'server-ip', 'query.port', 'rcon.port', 'rcon.password', 'level-name', 'motd', 'enable-query', 'enable-rcon']);
// Variables that belong to live (passwords, ports).
const KEEP_VARS = /PASSWORD|SECRET|TOKEN|KEY|PORT|GSLT/i;
const SAFE_EXT = /\.(ya?ml|toml|json5?|properties|conf|cfg|ini|txt|snbt|js|zs|lua)$/i;
const MAX_LIST = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMinecraft = (server) => /^minecraft-(?!bedrock$)/.test(String(server.templateId || ''));

/* ------------------------------------------------------- making a copy -- */

async function create(manager, store, liveId, { name, withWorld = true } = {}, actor) {
  const live = manager.require(liveId);
  if (live.stagingOf) fail(400, 'This is already a staging copy');
  const existing = manager.servers.find((s) => s.stagingOf === live.id);
  if (existing) fail(409, `${live.name} already has a staging copy: ${existing.name}`);
  const running = manager.isActive(live.id);
  const status = manager.rt?.(live.id)?.status;
  if (running && status && status !== 'running') fail(409, `Wait until ${live.name} has finished ${status === 'stopping' ? 'stopping' : 'starting'}`);
  // A running Minecraft server writes its world as it goes: flush and pause saving while copying.
  const pause = running && isMinecraft(live);
  if (pause) {
    await manager.sendCommand(live.id, 'save-off').catch(() => {});
    await manager.sendCommand(live.id, 'save-all flush').catch(() => {});
    await sleep(3000);
  }
  let result;
  try {
    // cloneServer refuses a running source; the copy here is made the same way, by hand.
    const copy = manager.create(
      {
        templateId: live.templateId,
        name: String(name || `${live.name} (staging)`).trim().slice(0, 60),
        ip: live.ip,
        vars: { ...live.vars },
        memory: live.memory,
        cpuLimit: live.cpuLimit,
        maxPlayers: live.maxPlayers,
        autoStart: false,
        autoRestart: false,
        startCommand: live.startCommand,
      },
      actor
    );
    const worlds = withWorld ? new Set() : worldNames(manager, live);
    await fsp.cp(live.dir, copy.dir, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
      filter: (src) => {
        const rel = path.relative(live.dir, src).split(path.sep);
        return !(rel[0] && (worlds.has(rel[0]) || rel[0] === '.gamepanel'));
      },
    });
    for (const key of ['javaOverride', 'resolvedVersion', 'gameVersion', 'loader', 'installedAt']) if (live[key] !== undefined) copy[key] = JSON.parse(JSON.stringify(live[key]));
    copy.stagingOf = live.id;
    copy.notes = `Staging copy of ${live.name}. Push changes to it from the banner at the top.`;
    store.save();
    manager.broadcastServers();
    manager.pushConsole(copy, `Staging copy of ${live.name}${withWorld ? '' : ' (without its world)'}. The game's ports are updated on first start.`, 'system');
    store.addEvent('server.staging', `${actor?.username || 'Someone'} made a staging copy of ${live.name}`, { serverId: live.id });
    result = { server: manager.publicServer(copy) };
  } finally {
    if (pause) await manager.sendCommand(live.id, 'save-on').catch(() => {});
  }
  return result;
}

/** Folders that hold a world: level-name and its _nether/_the_end, and anything with a level.dat. */
function worldNames(manager, server) {
  const out = new Set();
  if (isMinecraft(server)) {
    const level = manager.activeWorld(server);
    for (const n of [level, `${level}_nether`, `${level}_the_end`]) out.add(n);
  }
  try {
    for (const e of fs.readdirSync(server.dir, { withFileTypes: true })) {
      if (e.isDirectory() && (fs.existsSync(path.join(server.dir, e.name, 'level.dat')) || /^(saves?|worlds?)$/i.test(e.name))) out.add(e.name);
    }
  } catch {
    /* empty */
  }
  return out;
}

/* ------------------------------------------------------- what differs -- */

async function walk(root, rel = '', out = new Map(), limit = 50_000) {
  let list;
  try {
    list = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of list) {
    if (out.size >= limit) break;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, r, out, limit);
    else if (e.isFile()) {
      const st = await fsp.stat(path.join(root, r)).catch(() => null);
      if (st) out.set(r, st.size);
    }
  }
  return out;
}

async function sameFile(a, b, size) {
  if (size > 64 * 1024 * 1024) return true; // huge files of equal size: not worth reading twice
  const hash = async (f) => crypto.createHash('sha1').update(await fsp.readFile(f)).digest('hex');
  return (await hash(a)) === (await hash(b));
}

function props(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#!=\s][^=]*?)\s*=(.*)$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * In plugins/ and mods/ live keeps writing data of its own (databases,
 * caches) after the copy is made. There, only the jars at the top and config
 * files further down are pushed, and nothing below the top is deleted.
 */
const isJarFolder = (name) => /^(plugins|mods)$/i.test(name);
const pushable = (name, rel) => !isJarFolder(name) || (!rel.includes('/') ? /\.jar(\.disabled)?$/i.test(rel) : SAFE_EXT.test(rel));
const deletable = (name, rel) => !isJarFolder(name) || !rel.includes('/');

/** What each top-level folder or file would change on live. */
async function compareEntry(staging, live, name, isWorld) {
  const s = path.join(staging.dir, name);
  const l = path.join(live.dir, name);
  const sStat = await fsp.stat(s).catch(() => null);
  const lStat = await fsp.stat(l).catch(() => null);
  const files = [];
  let added = 0;
  let changed = 0;
  let removed = 0;
  if (sStat?.isFile() || lStat?.isFile()) {
    if (!lStat) added = 1;
    else if (!sStat) removed = 1;
    else if (sStat.size !== lStat.size || !(await sameFile(s, l, sStat.size))) changed = 1;
    if (added + changed + removed) files.push({ path: name, status: added ? 'added' : removed ? 'removed' : 'changed' });
    return { added, changed, removed, files, folder: false };
  }
  const [a, b] = await Promise.all([walk(s), walk(l)]);
  for (const [rel, size] of a) {
    if (!pushable(name, rel)) continue;
    if (!b.has(rel)) {
      added++;
      if (files.length < MAX_LIST) files.push({ path: `${name}/${rel}`, status: 'added' });
    } else if (b.get(rel) !== size || (!isWorld && !(await sameFile(path.join(s, rel), path.join(l, rel), size)))) {
      changed++;
      if (files.length < MAX_LIST) files.push({ path: `${name}/${rel}`, status: 'changed' });
    }
  }
  for (const rel of b.keys()) {
    if (a.has(rel) || !deletable(name, rel)) continue;
    removed++;
    if (files.length < MAX_LIST) files.push({ path: `${name}/${rel}`, status: 'removed' });
  }
  return { added, changed, removed, files, folder: true };
}

function pair(manager, stagingId) {
  const staging = manager.require(stagingId);
  if (!staging.stagingOf) fail(400, 'This server is not a staging copy');
  const live = manager.servers.find((s) => s.id === staging.stagingOf);
  if (!live) fail(404, 'The live server this was copied from is gone');
  return { staging, live };
}

async function diff(manager, stagingId) {
  const { staging, live } = pair(manager, stagingId);
  const worlds = new Set([...worldNames(manager, staging), ...worldNames(manager, live)]);
  const names = new Set();
  for (const dir of [staging.dir, live.dir]) {
    try {
      for (const n of fs.readdirSync(dir)) names.add(n);
    } catch {
      /* missing */
    }
  }
  const entries = [];
  for (const name of [...names].sort()) {
    if (NEVER.has(name) || VERSION_DIRS.has(name) || /\.jar$/i.test(name) || name === 'server.properties') continue;
    const isWorld = worlds.has(name);
    // Copied without its world: pushing would only delete live's.
    if (isWorld && !fs.existsSync(path.join(staging.dir, name))) continue;
    const d = await compareEntry(staging, live, name, isWorld);
    if (!d.added && !d.changed && !d.removed) continue;
    const kind = isWorld ? 'world' : /^(plugins|mods|datapacks|kubejs|scripts)$/i.test(name) ? 'mods' : /^(config|defaultconfigs|serverconfig)$/i.test(name) || SAFE_EXT.test(name) ? 'settings' : 'other';
    entries.push({ name, kind, ...d, push: kind === 'mods' || kind === 'settings' });
  }

  // server.properties, key by key, without live's ports and world.
  const [sp, lp] = await Promise.all([fsp.readFile(path.join(staging.dir, 'server.properties'), 'utf8').catch(() => null), fsp.readFile(path.join(live.dir, 'server.properties'), 'utf8').catch(() => null)]);
  const properties = [];
  if (sp !== null && lp !== null) {
    const a = props(sp);
    const b = props(lp);
    for (const [k, v] of a) if (!KEEP_PROPS.has(k) && b.get(k) !== v) properties.push({ key: k, live: b.get(k) ?? null, staging: v });
  }

  // The game version: the panel's own record of it, the variables that choose it, and the jars.
  const version = [];
  for (const k of ['resolvedVersion', 'gameVersion', 'loader']) if ((staging[k] ?? null) !== (live[k] ?? null)) version.push({ key: k, live: live[k] ?? null, staging: staging[k] ?? null });
  for (const [k, v] of Object.entries(staging.vars || {})) if (!KEEP_VARS.test(k) && (live.vars || {})[k] !== v) version.push({ key: k, live: live.vars?.[k] ?? null, staging: v });
  const jars = [];
  for (const name of [...names].filter((n) => /\.jar$/i.test(n) || VERSION_DIRS.has(n))) {
    const d = await compareEntry(staging, live, name, false);
    if (d.added + d.changed + d.removed) jars.push(name);
  }

  return {
    staging: { id: staging.id, name: staging.name, running: manager.isActive(staging.id) },
    live: { id: live.id, name: live.name, running: manager.isActive(live.id) },
    entries,
    properties,
    version: { settings: version, files: jars },
  };
}

/* --------------------------------------------------------------- push -- */

/** Make `name` under live the same as under staging. */
async function syncEntry(staging, live, name) {
  const s = path.join(staging.dir, name);
  const l = path.join(live.dir, name);
  const sStat = await fsp.lstat(s).catch(() => null);
  if (!sStat) {
    await fsp.rm(l, { recursive: true, force: true });
    return;
  }
  if (!sStat.isDirectory()) {
    await fsp.rm(l, { recursive: true, force: true });
    await fsp.cp(s, l, { force: true, verbatimSymlinks: true });
    return;
  }
  // Remove what staging no longer has, then copy over everything it does.
  const [a, b] = await Promise.all([walk(s), walk(l)]);
  for (const rel of b.keys()) if (!a.has(rel) && deletable(name, rel)) await fsp.rm(path.join(l, rel), { force: true });
  for (const rel of a.keys()) {
    if (!pushable(name, rel)) continue;
    await fsp.mkdir(path.dirname(path.join(l, rel)), { recursive: true });
    await fsp.cp(path.join(s, rel), path.join(l, rel), { force: true, verbatimSymlinks: true });
  }
}

async function stopAndWait(manager, id, ms = 3 * 60_000) {
  await manager.stop(id).catch(() => {});
  const until = Date.now() + ms;
  while (manager.isActive(id)) {
    if (Date.now() > until) fail(504, 'The live server did not stop in time; nothing was pushed');
    await sleep(1000);
  }
}

async function push(manager, store, stagingId, { entries = [], properties = true, version = false } = {}, actor) {
  const { staging, live } = pair(manager, stagingId);
  const plan = await diff(manager, stagingId);
  const known = new Map(plan.entries.map((e) => [e.name, e]));
  const picked = [...new Set((Array.isArray(entries) ? entries : []).map(String))];
  for (const n of picked) if (!known.has(n)) fail(400, `${n} has nothing to push`);
  const doProps = Boolean(properties) && plan.properties.length > 0;
  const doVersion = Boolean(version) && (plan.version.settings.length > 0 || plan.version.files.length > 0);
  if (!picked.length && !doProps && !doVersion) fail(400, 'Pick something to push');

  const safety = await backups.create(live, 'before-push');
  store.addEvent('backup.created', `Backup ${safety.name} of ${live.name} made before a push from staging`, { serverId: live.id, backup: safety.name });
  const wasRunning = manager.isActive(live.id);
  if (wasRunning) {
    manager.pushConsole(live, `Stopping to take changes from ${staging.name}…`, 'system');
    await stopAndWait(manager, live.id);
  }
  try {
    for (const name of picked) await syncEntry(staging, live, name);
    if (doProps) {
      const s = props(await fsp.readFile(path.join(staging.dir, 'server.properties'), 'utf8'));
      const values = {};
      for (const p of plan.properties) values[p.key] = s.get(p.key);
      manager.setProperties(live, values);
    }
    if (doVersion) {
      for (const name of plan.version.files) await syncEntry(staging, live, name);
      for (const v of plan.version.settings) {
        if (['resolvedVersion', 'gameVersion', 'loader'].includes(v.key)) live[v.key] = staging[v.key];
        else live.vars = { ...(live.vars || {}), [v.key]: staging.vars[v.key] };
      }
      store.save();
    }
  } catch (err) {
    logger.error(`Push from ${staging.name} to ${live.name} failed: ${err.message}`);
    fail(500, `The push stopped halfway (${err.message}). Restore ${safety.name} on ${live.name} to undo it.`);
  }
  const what = [...picked, ...(doProps ? ['server.properties'] : []), ...(doVersion ? ['the game version'] : [])];
  store.addEvent('server.pushed', `${actor?.username || 'Someone'} pushed ${what.join(', ')} from ${staging.name} to ${live.name}`, { serverId: live.id });
  manager.pushConsole(live, `Took ${what.join(', ')} from ${staging.name}. Backup from before: ${safety.name}.`, 'system');
  if (wasRunning) await manager.start(live.id).catch((err) => manager.pushConsole(live, `Could not start again: ${err.message}`, 'system'));
  return { ok: true, pushed: what, backup: safety.name, restarted: wasRunning };
}

module.exports = { create, diff, push, worldNames, NEVER, KEEP_PROPS };
