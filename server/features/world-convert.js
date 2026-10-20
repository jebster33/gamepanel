'use strict';

/**
 * Turn a singleplayer world zip (or a Bedrock .mcworld) into a world a server
 * can load.
 *
 *  - finds the world inside the zip: the shallowest folder holding level.dat,
 *    however many wrapper folders the zip has;
 *  - unpacks it with the panel's own zip reader (no external tools): every
 *    name is checked against zip-slip, links are never created, and the file
 *    count, per-file size, total size and compression ratio are capped;
 *  - Java: singleplayer keeps the Nether and End inside the world folder
 *    (DIM-1, DIM1). Paper and Purpur used to want them as sibling worlds
 *    (world_nether/DIM-1, world_the_end/DIM1); "split" does that move, "single"
 *    keeps the vanilla layout (Vanilla, Fabric, Forge, NeoForge);
 *  - an existing world of the same name is backed up (whole-server backup) and
 *    moved aside, never overwritten silently;
 *  - optionally sets level-name so the server loads it on the next start.
 */

const fs = require('fs');
const path = require('path');
const zip = require('../core/zip');
const { fail } = require('../core/util');
const { containedPath } = require('./files');

const NAME = /^[A-Za-z0-9 _.\-]{1,64}$/;
const LIMITS = { files: 200_000, entry: 1024 * 1024 * 1024, total: 8 * 1024 * 1024 * 1024, ratio: 2000 };

const isBedrock = (server) => server.templateId === 'minecraft-bedrock';
const isMinecraft = (server) => String(server.templateId || '').startsWith('minecraft') && server.templateId !== 'minecraft-velocity';
/** Paper-family servers want the Nether and End as separate world folders. */
const wantsSplit = (server) => ['minecraft-paper', 'minecraft-purpur'].includes(server.templateId);

const norm = (name) => String(name).replace(/\\/g, '/');

/** Throws on any name that could land outside the folder it is unpacked into. */
function checkName(raw) {
  const name = norm(raw);
  if (name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((p) => p === '..')) fail(400, `Unsafe path in the zip: ${raw.slice(0, 80)}`);
  return name;
}

/**
 * Where the world is inside a list of zip entry names.
 * Returns { prefix, bedrock, nether, end } (prefix is '' or ends with '/'), or null.
 */
function detect(rawNames) {
  const names = rawNames.map(checkName);
  const levels = names.filter((n) => (n === 'level.dat' || n.endsWith('/level.dat')) && !n.split('/').includes('__MACOSX'));
  if (!levels.length) return null;
  const roots = levels.map((n) => n.slice(0, n.length - 'level.dat'.length)).filter((p) => p.split('/').length - 1 <= 4);
  if (!roots.length) return null;
  // Prefer a folder that looks like a world (region, db, DIM folders) over a stray level.dat, then the shallowest.
  const looks = (p) => names.some((n) => n.startsWith(`${p}region/`) || n.startsWith(`${p}db/`) || n.startsWith(`${p}DIM-1/`) || n.startsWith(`${p}dimensions/`));
  roots.sort((a, b) => Number(looks(b)) - Number(looks(a)) || a.split('/').length - b.split('/').length || a.localeCompare(b));
  const prefix = roots[0];
  const has = (sub) => names.some((n) => n.startsWith(`${prefix}${sub}`));
  const bedrock = has('db/') || has('levelname.txt');
  return { prefix, bedrock, nether: has('DIM-1/'), end: has('DIM1/'), modern: has('dimensions/') };
}

function open(server, rel) {
  const file = containedPath(server.dir, String(rel || ''));
  if (!fs.existsSync(file)) fail(404, 'The uploaded file is missing');
  try {
    return zip.open(file);
  } catch {
    fail(400, 'That is not a zip file. Singleplayer worlds are zipped from the .minecraft/saves folder; Bedrock worlds are .mcworld files.');
  }
}

/** What is in the upload, before anything is changed. */
function inspect(server, rel) {
  if (!isMinecraft(server)) fail(400, 'Only Minecraft servers have worlds');
  const z = open(server, rel);
  try {
    const found = detect(z.names);
    if (!found) fail(400, 'No level.dat in that zip, so it does not look like a Minecraft world');
    let size = 0;
    let files = 0;
    for (const n of z.names) {
      if (n.endsWith('/') || !norm(n).startsWith(found.prefix)) continue;
      files++;
      size += z.info(n)?.size || 0;
    }
    const suggested = (found.prefix.split('/').filter(Boolean).pop() || path.basename(String(rel)).replace(/\.[^.]+$/, '') || 'imported').replace(/[^A-Za-z0-9 _.\-]/g, '_').replace(/^\.+/, '').slice(0, 64) || 'imported';
    return {
      folder: found.prefix || '(top level)',
      bedrock: found.bedrock,
      serverIsBedrock: isBedrock(server),
      matches: found.bedrock === isBedrock(server),
      dimensions: { nether: found.nether, end: found.end },
      modernLayout: found.modern,
      files,
      size,
      suggestedName: suggested,
      layout: found.bedrock ? 'bedrock' : wantsSplit(server) ? 'split' : 'single',
    };
  } finally {
    z.close();
  }
}

function extractTo(z, found, destRoot) {
  const out = path.resolve(destRoot);
  let files = 0;
  let total = 0;
  for (const raw of z.names) {
    const name = checkName(raw);
    if (!name.startsWith(found.prefix) || name === found.prefix) continue;
    const rel = name.slice(found.prefix.length);
    if (name.split('/').includes('__MACOSX') || rel === 'session.lock') continue;
    const target = path.resolve(out, ...rel.split('/'));
    if (target !== out && !target.startsWith(out + path.sep)) fail(400, `Unsafe path in the zip: ${raw.slice(0, 80)}`);
    if (raw.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const info = z.info(raw);
    if (++files > LIMITS.files) fail(413, 'That zip has too many files');
    if (info.size > LIMITS.entry || info.compressed > LIMITS.entry) fail(413, `${rel} is too large to import`);
    total += info.size;
    if (total > LIMITS.total) fail(413, 'That world is larger than the import limit (8 GB unpacked)');
    if (info.size > 16 * 1024 * 1024 && info.size / Math.max(1, info.compressed) > LIMITS.ratio) fail(400, `${rel} has a suspicious compression ratio`);
    const data = z.read(raw, LIMITS.entry);
    if (!data) fail(400, `Could not read ${rel} from the zip (zip64 or an unsupported compression method)`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' }); // wx: a duplicate name in the zip fails instead of overwriting
  }
  if (!fs.existsSync(path.join(out, 'level.dat'))) fail(400, 'The zip has no level.dat in the world folder');
  return { files, total };
}

/**
 * Import the uploaded zip as world `name`.
 * `manager` is the ServerManager (isActive, setProperties, useWorld, logActivity), `backups` the backups feature.
 */
async function convert(manager, server, { path: rel, name, layout, use = true, replace = false } = {}, actor, { backups = require('./backups') } = {}) {
  if (!isMinecraft(server)) fail(400, 'Only Minecraft servers have worlds');
  if (manager.isActive(server.id)) fail(409, 'Stop the server before importing a world');
  const world = String(name || '').trim();
  if (!NAME.test(world) || world.startsWith('.')) fail(400, 'World names can use letters, numbers, spaces, dots, dashes and underscores');
  const z = open(server, rel);
  const scratchRel = `.gp-world-import-${Date.now()}`;
  const scratch = containedPath(server.dir, scratchRel);
  let result;
  try {
    const found = detect(z.names);
    if (!found) fail(400, 'No level.dat in that zip, so it does not look like a Minecraft world');
    if (found.bedrock !== isBedrock(server)) fail(400, found.bedrock ? 'That is a Bedrock world, but this is a Java server' : 'That is a Java world, but this is a Bedrock server');
    const mode = found.bedrock ? 'bedrock' : ['split', 'single'].includes(layout) ? layout : wantsSplit(server) ? 'split' : 'single';

    const baseRel = found.bedrock ? 'worlds' : '';
    const targets = found.bedrock ? [world] : [world, `${world}_nether`, `${world}_the_end`];
    const existing = targets.filter((t) => fs.existsSync(containedPath(server.dir, path.join(baseRel, t))));
    if (existing.length && !replace) fail(409, `A world called ${world} already exists. Pick another name, or choose to replace it (it is backed up first).`);

    fs.mkdirSync(path.join(scratch, 'w'), { recursive: true });
    const stats = extractTo(z, found, path.join(scratch, 'w'));

    // Reshape in the scratch folder, so a failure leaves the server's folders untouched.
    const placements = [[path.join(scratch, 'w'), world]];
    if (!found.bedrock && mode === 'split') {
      const nether = path.join(scratch, 'w', 'DIM-1');
      const end = path.join(scratch, 'w', 'DIM1');
      if (fs.existsSync(nether)) {
        fs.mkdirSync(path.join(scratch, 'n'));
        fs.renameSync(nether, path.join(scratch, 'n', 'DIM-1'));
        placements.push([path.join(scratch, 'n'), `${world}_nether`]);
      }
      if (fs.existsSync(end)) {
        fs.mkdirSync(path.join(scratch, 'e'));
        fs.renameSync(end, path.join(scratch, 'e', 'DIM1'));
        placements.push([path.join(scratch, 'e'), `${world}_the_end`]);
      }
    }

    let backup = null;
    if (existing.length) {
      manager.pushConsole?.(server, `Backing up before replacing ${world}…`, 'system');
      try {
        backup = (await backups.create(server, 'before-world-import'))?.name || null;
      } catch (err) {
        fail(500, `The backup failed, so nothing was changed: ${err.message}`);
      }
      const aside = containedPath(server.dir, `.gamepanel/world-previous/${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.mkdirSync(aside, { recursive: true });
      for (const t of existing) fs.renameSync(containedPath(server.dir, path.join(baseRel, t)), path.join(aside, t));
    }
    if (baseRel) fs.mkdirSync(containedPath(server.dir, baseRel), { recursive: true });
    for (const [from, to] of placements) fs.renameSync(from, containedPath(server.dir, path.join(baseRel, to)));
    result = { ok: true, world, layout: mode, files: stats.files, size: stats.total, folders: placements.map((p) => p[1]), replaced: existing, backup };
  } finally {
    z.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  try {
    fs.rmSync(containedPath(server.dir, String(rel)), { force: true });
  } catch {
    /* the upload is already gone */
  }
  if (use) {
    manager.setProperties(server, { 'level-name': world });
    result.levelName = world;
  }
  manager.logActivity?.(server.id, { type: 'world', text: `Imported singleplayer world ${world}`, by: actor });
  manager.store?.addEvent?.('server.settings', `${actor || 'Someone'} imported the world ${world} into ${server.name}`, { serverId: server.id });
  return result;
}

module.exports = { detect, inspect, convert, checkName, wantsSplit, LIMITS };
