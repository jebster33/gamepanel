'use strict';

/**
 * Datapacks for any Minecraft Java server (vanilla, Paper, Fabric, Forge…):
 * what is in <world>/datapacks, whether each one is made for the server's
 * version (from its pack.mcmeta), turning them on and off, and installing
 * new ones from Modrinth or a zip.
 *
 * Turned off while the server is stopped: the file moves to
 * .gamepanel/datapacks-off/<world>/ (Minecraft only sees what is in the
 * folder). While it runs: /datapack disable, which the game remembers in
 * level.dat. New packs are picked up with /reload, so nobody has to restart.
 *
 * <server>/.gamepanel/datapacks.json = { [file]: { projectId, slug, name, icon, url, version, versionId } }
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { fail, logger } = require('../core/util');
const { containedPath } = require('./files');
const nbt = require('../core/nbt');
const safefs = require('../core/safefs');
const zip = require('../core/zip');
const compat = require('./mods/compat');
const modrinth = require('./mods/providers/modrinth');
const { downloadTo, safeFileName } = require('./mods/http');

const isJava = (server) => /^minecraft-(?!bedrock$|velocity$)/.test(String(server.templateId || ''));

/**
 * Data pack format per Minecraft version (the first version that used it).
 * Versions after the last row are not guessed: the check just says "unknown".
 */
const FORMATS = [
  ['1.13', 4],
  ['1.15', 5],
  ['1.16.2', 6],
  ['1.17', 7],
  ['1.18', 8],
  ['1.18.2', 9],
  ['1.19', 10],
  ['1.19.4', 12],
  ['1.20', 15],
  ['1.20.2', 18],
  ['1.20.3', 26],
  ['1.20.5', 41],
  ['1.21', 48],
  ['1.21.2', 57],
  ['1.21.4', 61],
  ['1.21.5', 71],
  ['1.21.6', 80],
  ['1.21.7', 81],
];
const UNKNOWN_FROM = '1.21.9';

const parts = (v) => String(v).split('.').map((n) => Number(n) || 0);
function cmp(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

function formatFor(gameVersion) {
  if (!gameVersion || cmp(gameVersion, UNKNOWN_FROM) >= 0 || cmp(gameVersion, FORMATS[0][0]) < 0) return null;
  let out = null;
  for (const [v, f] of FORMATS) if (cmp(gameVersion, v) >= 0) out = f;
  return out;
}

/**
 * The data pack format the server's own jar says it uses (version.json,
 * pack_version.data or data_major), so new versions need no table entry.
 */
const jarFormats = new Map(); // path -> { mtime, format }
function formatFromJar(server) {
  const candidates = ['server.jar'];
  const add = (rel) => {
    try {
      for (const f of fs.readdirSync(containedPath(server.dir, rel))) if (f.endsWith('.jar')) candidates.push(rel ? `${rel}/${f}` : f);
    } catch {
      /* not there */
    }
  };
  add('');
  try {
    for (const v of fs.readdirSync(containedPath(server.dir, 'versions'))) add(`versions/${v}`);
  } catch {
    /* not Paper */
  }
  add('cache');
  add('.fabric/server');
  for (const rel of [...new Set(candidates)].slice(0, 12)) {
    let full;
    let stat;
    try {
      full = containedPath(server.dir, rel);
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const hit = jarFormats.get(full);
    if (hit && hit.mtime === stat.mtimeMs) {
      if (hit.format) return hit.format;
      continue;
    }
    let format = null;
    try {
      const z = zip.open(full);
      try {
        const pv = JSON.parse(z.read('version.json')?.toString('utf8') || '{}').pack_version;
        format = Number(typeof pv === 'object' ? (pv.data ?? pv.data_major) : pv) || null;
      } finally {
        z.close();
      }
    } catch {
      /* not a zip, or no version.json */
    }
    jarFormats.set(full, { mtime: stat.mtimeMs, format });
    if (format) return format;
  }
  return null;
}

/** A chat component (string, object or list) as plain text, without § codes. */
function plain(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/§./g, '');
  if (Array.isArray(value)) return value.map(plain).join('');
  if (typeof value === 'object') return plain(value.text ?? value.translate ?? '') + (value.extra || []).map(plain).join('');
  return String(value);
}

const first = (v) => (Array.isArray(v) ? Number(v[0]) : Number(v));

/** The formats a pack says it supports: { format, min, max }. */
function readMcmeta(text) {
  const pack = JSON.parse(String(text).replace(/^﻿/, '')).pack || {};
  const format = Number(pack.pack_format ?? first(pack.min_format)) || null;
  let min = format;
  let max = format;
  const sf = pack.supported_formats;
  if (Array.isArray(sf)) [min, max] = [Number(sf[0]), Number(sf[1])];
  else if (sf && typeof sf === 'object') [min, max] = [Number(sf.min_inclusive), Number(sf.max_inclusive)];
  else if (Number.isFinite(Number(sf))) min = max = Number(sf);
  if (pack.min_format !== undefined) min = first(pack.min_format);
  if (pack.max_format !== undefined) max = first(pack.max_format);
  return { format, min, max, description: plain(pack.description).slice(0, 300) };
}

/** Does a pack fit the server? true, false, or null when the panel cannot tell. */
function fits(meta, expected) {
  if (!meta || !expected || !meta.min) return null;
  return expected >= meta.min && expected <= (meta.max || meta.min);
}

/** pack.mcmeta of a zip or a folder, or null; an error message when it is broken. */
function inspect(full, isDir) {
  try {
    if (isDir) return readMcmeta(safefs.readText(path.join(full, 'pack.mcmeta'), 1024 * 1024));
    const z = zip.open(full);
    try {
      const buf = z.read('pack.mcmeta');
      return buf ? readMcmeta(buf.toString('utf8')) : null;
    } finally {
      z.close();
    }
  } catch (err) {
    return { error: err.message };
  }
}

/* ------------------------------------------------------------- where -- */

function context(manager, server) {
  if (!isJava(server)) fail(400, 'Datapacks are for Minecraft Java servers');
  const world = manager.activeWorld(server);
  const template = manager.template(server);
  const ctx = compat.modContext(server, template, manager.rt(server.id).version);
  return {
    world,
    dir: containedPath(server.dir, `${world}/datapacks`),
    offDir: containedPath(server.dir, `.gamepanel/datapacks-off/${world}`),
    gameVersion: ctx.gameVersion || null,
    expected: formatFromJar(server) || formatFor(ctx.gameVersion),
    // Paper's "reload" is the risky Bukkit plugin reload; the vanilla one is minecraft:reload there.
    reload: ['paper', 'purpur', 'folia'].includes(ctx.loader) ? 'minecraft:reload' : 'reload',
    running: manager.rt(server.id).status === 'running',
  };
}

const manifestFile = (server) => containedPath(server.dir, '.gamepanel/datapacks.json');
/**
 * The record of what came from Modrinth lives in a file a files-user can edit:
 * only plain file names (no folders, no ..) are kept, so it can never point a delete elsewhere.
 */
function cleanManifest(data) {
  const out = {};
  for (const [file, m] of Object.entries(data && typeof data === 'object' ? data : {})) {
    if (path.basename(file) === file && /^[\w.+\- ]+\.zip$/i.test(file) && m && typeof m === 'object') out[file] = m;
  }
  return out;
}

function loadManifest(server) {
  try {
    return cleanManifest(JSON.parse(safefs.readText(manifestFile(server), 1024 * 1024)));
  } catch {
    return {};
  }
}
function saveManifest(server, data) {
  fs.mkdirSync(path.dirname(manifestFile(server)), { recursive: true });
  fs.writeFileSync(manifestFile(server), JSON.stringify(data, null, 2));
}

/** Packs the game itself has turned off (level.dat DataPacks.Disabled). */
function disabledInGame(server, world) {
  try {
    const data = nbt.read(safefs.readRegular(containedPath(server.dir, `${world}/level.dat`), 8 * 1024 * 1024));
    return new Set((data.Data?.DataPacks?.Disabled || []).filter((n) => String(n).startsWith('file/')).map((n) => String(n).slice(5)));
  } catch {
    return new Set();
  }
}

// What a running server was just told, until level.dat catches up on the next save.
const pending = new Map(); // serverId -> Map(name -> { on, at })

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isFile() && /\.zip$/i.test(e.name))));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- list -- */

function list(manager, server) {
  const ctx = context(manager, server);
  const manifest = loadManifest(server);
  const offGame = disabledInGame(server, ctx.world);
  let levelAt = 0;
  try {
    levelAt = fs.statSync(containedPath(server.dir, `${ctx.world}/level.dat`)).mtimeMs;
  } catch {
    /* no world yet */
  }
  const told = pending.get(server.id) || new Map();
  const packs = [];
  for (const [dir, moved] of [
    [ctx.dir, false],
    [ctx.offDir, true],
  ]) {
    for (const e of entries(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !fs.existsSync(path.join(full, 'pack.mcmeta'))) continue;
      const meta = inspect(full, e.isDirectory());
      const stat = fs.statSync(full);
      let on = !moved && !offGame.has(e.name);
      const t = told.get(e.name);
      if (!moved && t && t.at > levelAt) on = t.on;
      const src = manifest[e.name] || null;
      packs.push({
        name: e.name,
        title: src?.name || e.name.replace(/\.zip$/i, ''),
        folder: e.isDirectory(),
        size: e.isDirectory() ? null : stat.size,
        modified: stat.mtimeMs,
        on,
        offInGame: !moved && !on,
        description: meta?.description || '',
        format: meta?.format || null,
        fits: meta?.error ? false : fits(meta, ctx.expected),
        broken: meta?.error ? `pack.mcmeta could not be read: ${meta.error}` : meta ? null : 'There is no pack.mcmeta at the top of this zip, so Minecraft ignores it',
        source: src ? { name: src.name, icon: src.icon, url: src.url, version: src.version } : null,
      });
    }
  }
  packs.sort((a, b) => Number(b.on) - Number(a.on) || a.title.localeCompare(b.title));
  return { world: ctx.world, gameVersion: ctx.gameVersion, format: ctx.expected, running: ctx.running, packs };
}

/* ----------------------------------------------------------- browse -- */

const browseCtx = (ctx) => ({ projectType: 'datapack', modrinthLoaders: ['datapack'], gameVersion: ctx.gameVersion || undefined });

async function search(manager, server, { query = '', page = 0 } = {}) {
  const ctx = context(manager, server);
  const result = await modrinth.search({ query, page, limit: 20, ctx: browseCtx(ctx) });
  const have = new Set(Object.values(loadManifest(server)).map((m) => m.projectId));
  for (const item of result.items) item.installed = have.has(item.id);
  return { ...result, gameVersion: ctx.gameVersion };
}

/* ---------------------------------------------------------- install -- */

/** After a change on a running server: pick up new packs without a restart. */
async function reload(manager, server, ctx, extra = []) {
  if (!ctx.running) return false;
  try {
    for (const cmd of extra) await manager.sendCommand(server.id, cmd);
    await manager.sendCommand(server.id, ctx.reload);
    return true;
  } catch (err) {
    logger.warn(`Datapack reload on ${server.name}: ${err.message}`);
    return false;
  }
}

/** A zip must have pack.mcmeta at its top, or Minecraft skips it. */
function checkZip(file) {
  let z;
  try {
    z = zip.open(file);
  } catch {
    fail(400, 'That is not a zip file');
  }
  try {
    if (z.has('pack.mcmeta')) return readMcmeta(z.read('pack.mcmeta').toString('utf8'));
    const nested = z.names.find((n) => /^[^/]+\/pack\.mcmeta$/.test(n));
    if (nested) fail(400, `pack.mcmeta is inside the folder "${nested.split('/')[0]}" in this zip. Zip what is inside that folder instead, so pack.mcmeta is at the top.`);
    if (z.names.some((n) => /\.(class)$/.test(n) || n === 'fabric.mod.json' || n === 'META-INF/mods.toml')) fail(400, 'This is a mod, not a datapack. Put it on the Mods tab.');
    fail(400, 'This zip has no pack.mcmeta, so it is not a datapack');
  } catch (err) {
    if (err.code) throw err;
    fail(400, `pack.mcmeta could not be read: ${err.message}`);
  } finally {
    z.close();
  }
  return null;
}

async function install(manager, store, server, { projectId, versionId } = {}, actor) {
  const ctx = context(manager, server);
  if (!projectId) fail(400, 'Pick a datapack');
  const project = await modrinth.project(String(projectId));
  let version = versionId ? await modrinth.version(String(versionId)).catch(() => null) : null;
  if (version && version.projectId !== project.id) version = null;
  if (!version) version = await modrinth.best({ projectId: project.id, ctx: browseCtx(ctx) });
  if (!version?.file?.url) fail(404, `${project.name} has no datapack release for ${ctx.gameVersion || 'this server'}`);
  const filename = safeFileName(version.file.filename, `${project.slug}.zip`);
  if (!/\.zip$/i.test(filename)) fail(400, `${project.name} is not a zip datapack`);
  const temp = containedPath(server.dir, `.gamepanel/downloads/${crypto.randomBytes(4).toString('hex')}-${filename}`);
  const got = await downloadTo(version.file.url, temp);
  try {
    if (version.file.sha1 && got.sha1 !== version.file.sha1) fail(502, `The download of ${project.name} was corrupted. Try again.`);
    checkZip(temp);
    const manifest = loadManifest(server);
    // A newer release of the same pack replaces the old file (on or off).
    for (const [file, m] of Object.entries(manifest)) {
      if (m.projectId !== project.id || file === filename) continue;
      for (const d of [ctx.dir, ctx.offDir]) await fsp.rm(path.join(d, file), { force: true, recursive: true });
      delete manifest[file];
    }
    await fsp.mkdir(ctx.dir, { recursive: true });
    await fsp.rm(path.join(ctx.offDir, filename), { force: true });
    await fsp.rename(temp, path.join(ctx.dir, filename));
    manifest[filename] = { projectId: project.id, slug: project.slug, name: project.name, icon: project.icon, url: project.url, version: version.version, versionId: version.id };
    saveManifest(server, manifest);
  } finally {
    await fsp.rm(temp, { force: true });
  }
  const reloaded = await reload(manager, server, ctx, [`datapack enable "file/${filename}"`]);
  manager.logActivity?.(server.id, { type: 'datapack', text: `Datapack ${project.name} ${version.version} added`, by: actor });
  store.addEvent('mod.installed', `Datapack ${project.name} added to ${server.name}`, { serverId: server.id });
  return { ok: true, name: filename, title: project.name, version: version.version, reloaded, worldMissing: !fs.existsSync(containedPath(server.dir, `${ctx.world}/level.dat`)) };
}

/** A zip the user uploaded. */
async function upload(manager, store, server, name, buf, actor) {
  const ctx = context(manager, server);
  const filename = safeFileName(String(name || ''), 'datapack.zip');
  if (!/\.zip$/i.test(filename)) fail(400, 'Datapacks are .zip files');
  const temp = containedPath(server.dir, `.gamepanel/downloads/${crypto.randomBytes(4).toString('hex')}-${filename}`);
  await fsp.mkdir(path.dirname(temp), { recursive: true });
  await fsp.writeFile(temp, buf);
  try {
    checkZip(temp);
    await fsp.mkdir(ctx.dir, { recursive: true });
    await fsp.rm(path.join(ctx.offDir, filename), { force: true });
    await fsp.rename(temp, path.join(ctx.dir, filename));
  } finally {
    await fsp.rm(temp, { force: true });
  }
  const manifest = loadManifest(server);
  if (manifest[filename]) {
    delete manifest[filename]; // the upload replaced what came from Modrinth
    saveManifest(server, manifest);
  }
  const reloaded = await reload(manager, server, ctx, [`datapack enable "file/${filename}"`]);
  manager.logActivity?.(server.id, { type: 'datapack', text: `Datapack ${filename} uploaded`, by: actor });
  store.addEvent('mod.installed', `Datapack ${filename} added to ${server.name}`, { serverId: server.id });
  return { ok: true, name: filename, reloaded };
}

/* ----------------------------------------------------------- on / off -- */

function locate(ctx, name) {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name) fail(400, 'Bad datapack name');
  for (const [dir, moved] of [
    [ctx.dir, false],
    [ctx.offDir, true],
  ]) {
    if (fs.existsSync(path.join(dir, safe))) return { full: path.join(dir, safe), moved, safe };
  }
  fail(404, 'That datapack is not there any more');
}

async function toggle(manager, server, name, on, actor) {
  const ctx = context(manager, server);
  const { full, moved, safe } = locate(ctx, name);
  const told = pending.get(server.id) || new Map();
  pending.set(server.id, told);
  if (on) {
    if (moved) {
      await fsp.mkdir(ctx.dir, { recursive: true });
      await fsp.rename(full, path.join(ctx.dir, safe));
    }
    if (ctx.running) {
      // enable covers a pack the game turned off; reload one it has not seen yet.
      await manager.sendCommand(server.id, `datapack enable "file/${safe}"`);
      await manager.sendCommand(server.id, ctx.reload);
      told.set(safe, { on: true, at: Date.now() });
    } else if (!moved && disabledInGame(server, ctx.world).has(safe)) {
      fail(409, 'This one was turned off in the game. Start the server, then turn it on here.');
    }
  } else if (ctx.running) {
    if (moved) return { ok: true };
    await manager.sendCommand(server.id, `datapack disable "file/${safe}"`);
    told.set(safe, { on: false, at: Date.now() });
  } else if (!moved) {
    await fsp.mkdir(ctx.offDir, { recursive: true });
    await fsp.rename(full, path.join(ctx.offDir, safe));
  }
  manager.logActivity?.(server.id, { type: 'datapack', text: `Datapack ${safe} turned ${on ? 'on' : 'off'}`, by: actor });
  return { ok: true, live: ctx.running };
}

async function remove(manager, store, server, name, actor) {
  const ctx = context(manager, server);
  const { full, moved, safe } = locate(ctx, name);
  if (ctx.running && !moved) await manager.sendCommand(server.id, `datapack disable "file/${safe}"`).catch(() => {});
  await fsp.rm(full, { recursive: true, force: true });
  const manifest = loadManifest(server);
  if (manifest[safe]) {
    delete manifest[safe];
    saveManifest(server, manifest);
  }
  pending.get(server.id)?.delete(safe);
  manager.logActivity?.(server.id, { type: 'datapack', text: `Datapack ${safe} removed`, by: actor });
  store.addEvent('mod.removed', `Datapack ${safe} removed from ${server.name}`, { serverId: server.id });
  return { ok: true };
}

/* ----------------------------------------------------------- updates -- */

async function updates(manager, server) {
  const ctx = context(manager, server);
  const out = [];
  for (const [file, m] of Object.entries(loadManifest(server))) {
    try {
      const best = await modrinth.best({ projectId: m.projectId, ctx: browseCtx(ctx) });
      if (best && best.id !== m.versionId) out.push({ name: file, title: m.name, current: m.version, latest: best.version, projectId: m.projectId, versionId: best.id });
    } catch {
      /* gone from Modrinth, or offline */
    }
  }
  return { updates: out };
}

module.exports = { list, search, install, upload, toggle, remove, updates, formatFor, readMcmeta, fits, isJava };
