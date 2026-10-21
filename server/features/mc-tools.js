'use strict';

/**
 * Minecraft Java tools that sit beside the game:
 *
 *   Plugin updates   what is in plugins/ (read from each jar's plugin.yml), which of it has a newer
 *                    release on Modrinth (matched by file hash, so exact), Hangar or SpigotMC (matched by name,
 *                    so "check it is the same plugin" is on the person).
 *   World border     the border and spawn from level.dat, the regions already generated, and a way to change
 *                    the border (commands while running, level.dat while stopped).
 *   Switch check     before changing server type or version: which installed mods and plugins have a release for
 *                    the target, which only need an update, and which have nothing for it.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { fail, logger } = require('../core/util');
const { containedPath } = require('./files');
const safefs = require('../core/safefs');
const nbt = require('../core/nbt');
const { readZip } = require('./zip');
const { getJson, postJson } = require('./mods/http');
const compat = require('./mods/compat');

const isMinecraft = (server) => /^minecraft-(?!bedrock$)/.test(String(server.templateId || ''));
const must = (server) => {
  if (!isMinecraft(server)) fail(400, 'This is for Minecraft Java servers');
  return server;
};

const sha1 = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

/* ------------------------------------------------------- plugin updates -- */

/** name, version and main class out of a plugin.yml / paper-plugin.yml / bungee.yml text. */
function parsePluginYml(text) {
  const pick = (key) => text.match(new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n#]+?)['"]?\\s*(?:#.*)?$`, 'm'))?.[1]?.trim() || null;
  return { name: pick('name'), version: pick('version'), main: pick('main'), api: pick('api-version') };
}

async function readJar(file) {
  try {
    const buf = await fsp.readFile(file);
    if (buf.length > 60 * 1024 * 1024) return null;
    const zip = readZip(buf);
    const entries = zip.entries || zip;
    const find = (names) => {
      for (const n of names) {
        const e = (Array.isArray(entries) ? entries : []).find((x) => x.path === n);
        if (e) return e;
      }
      return null;
    };
    const entry = find(['plugin.yml', 'paper-plugin.yml', 'bungee.yml']);
    if (!entry) return null;
    const data = typeof entry.data === 'function' ? entry.data() : entry.data || zip.read?.(entry.name);
    return parsePluginYml(Buffer.from(data).toString('utf8'));
  } catch {
    return null;
  }
}

const dotted = (v) => String(v || '').replace(/^v/i, '').match(/\d+(\.\d+)*/)?.[0] || null;
function newer(latest, current) {
  const a = dotted(latest);
  const b = dotted(current);
  if (!a || !b) return String(latest) !== String(current);
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

const pluginDir = (server, template) => compat.modDir(server, template);

async function scanPlugins(server, template) {
  const dir = containedPath(server.dir, pluginDir(server, template));
  let names = [];
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && /\.jar$/i.test(e.name)).map((e) => e.name);
  } catch {
    return { dir, jars: [] };
  }
  const jars = [];
  for (const file of names.slice(0, 300)) {
    const full = path.join(dir, file);
    const meta = await readJar(full);
    jars.push({ file, name: meta?.name || file.replace(/\.jar$/i, ''), version: meta?.version || null, hash: await sha1(full).catch(() => null), plugin: Boolean(meta) });
  }
  return { dir, jars };
}

async function mapLimit(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const at = i++;
        out[at] = await fn(items[at]).catch(() => null);
      }
    })
  );
  return out;
}

async function byHangar(name) {
  const slug = encodeURIComponent(name.replace(/\s+/g, ''));
  const project = await getJson(`https://hangar.papermc.io/api/v1/projects/${slug}`);
  const latest = await getJson(`https://hangar.papermc.io/api/v1/projects/${slug}/latestrelease`).catch(() => null);
  const version = typeof latest === 'string' ? latest : latest?.name;
  if (!version) return null;
  return { source: 'hangar', latest: version, url: `https://hangar.papermc.io/${project.namespace.owner}/${project.namespace.slug}`, name: project.name };
}

async function bySpigot(name) {
  const found = await getJson(`https://api.spiget.org/v2/search/resources/${encodeURIComponent(name)}?field=name&size=3&sort=-downloads`);
  const hit = (Array.isArray(found) ? found : []).find((r) => String(r.name).toLowerCase().includes(name.toLowerCase()));
  if (!hit) return null;
  const v = await getJson(`https://api.spiget.org/v2/resources/${hit.id}/versions/latest`).catch(() => null);
  if (!v?.name) return null;
  return { source: 'spigot', latest: v.name, url: `https://www.spigotmc.org/resources/${hit.id}/`, name: hit.name, premium: Boolean(hit.premium) };
}

/** [{ file, name, version, source, latest, outdated, url, exact, oneClick }] */
async function pluginUpdates(manager, server) {
  must(server);
  const template = manager.template(server);
  if (!template?.mods) fail(400, 'This server type does not load plugins or mods');
  const ctx = compat.modContext(server, template, manager.rt(server.id).version);
  const { jars } = await scanPlugins(server, template);
  if (!jars.length) return { checked: 0, items: [], filter: `${ctx.loaderLabel || ctx.loader || ''} ${ctx.gameVersion || ''}`.trim() };

  // Exact: Modrinth knows these files by hash.
  const hashes = jars.map((j) => j.hash).filter(Boolean);
  let current = {};
  let latest = {};
  try {
    current = await postJson('https://api.modrinth.com/v2/version_files', { hashes, algorithm: 'sha1' });
    latest = await postJson('https://api.modrinth.com/v2/version_files/update', { hashes, algorithm: 'sha1', loaders: ctx.modrinthLoaders, ...(ctx.gameVersion ? { game_versions: [ctx.gameVersion] } : {}) });
  } catch (err) {
    logger.debug(`Plugin update check (Modrinth): ${err.message}`);
  }
  const items = await mapLimit(jars, 4, async (jar) => {
    const now = current[jar.hash];
    if (now) {
      const next = latest[jar.hash];
      const nextSha = next?.files?.find((f) => f.primary)?.hashes?.sha1 || next?.files?.[0]?.hashes?.sha1;
      return {
        file: jar.file,
        name: jar.name,
        version: now.version_number,
        source: 'modrinth',
        exact: true,
        latest: next?.version_number || now.version_number,
        outdated: Boolean(next && nextSha && nextSha !== jar.hash),
        url: `https://modrinth.com/project/${now.project_id}`,
        projectId: now.project_id,
      };
    }
    // Not on Modrinth by hash: look the name up on Hangar and SpigotMC.
    if (!jar.plugin) return { file: jar.file, name: jar.name, version: null, source: null, outdated: null };
    const found = (await byHangar(jar.name).catch(() => null)) || (await bySpigot(jar.name).catch(() => null));
    if (!found) return { file: jar.file, name: jar.name, version: jar.version, source: null, outdated: null };
    return { file: jar.file, name: jar.name, version: jar.version, source: found.source, exact: false, latest: found.latest, outdated: jar.version ? newer(found.latest, jar.version) : null, url: found.url, premium: found.premium };
  });
  const rows = items.filter(Boolean).sort((a, b) => Number(b.outdated === true) - Number(a.outdated === true) || a.name.localeCompare(b.name));
  return { checked: jars.length, items: rows, filter: `${ctx.loaderLabel || ctx.loader || ''} ${ctx.gameVersion || ''}`.trim() };
}

/* ---------------------------------------------------------- world border -- */

function levelName(server) {
  try {
    const text = safefs.readText(containedPath(server.dir, 'server.properties'), 1024 * 1024);
    return text.match(/^level-name\s*=\s*(.+)$/m)?.[1]?.trim() || 'world';
  } catch {
    return 'world';
  }
}

const numberOr = (v, d = 0) => (typeof v === 'bigint' ? Number(v) : Number.isFinite(Number(v)) ? Number(v) : d);

async function readLevel(server) {
  const file = containedPath(server.dir, `${levelName(server)}/level.dat`);
  const buf = await fsp.readFile(file).catch(() => null);
  if (!buf) return null;
  const root = nbt.read(buf);
  return { file, data: root?.Data || root };
}

async function listRegions(server) {
  const out = [];
  const dir = containedPath(server.dir, `${levelName(server)}/region`);
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const m = name.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/);
    if (m) out.push([Number(m[1]), Number(m[2])]);
    if (out.length >= 5000) break;
  }
  return out;
}

async function borderInfo(manager, server) {
  must(server);
  const level = await readLevel(server);
  const d = level?.data || {};
  // 1.21.x keeps these as flat keys; newer versions may nest them: look in both.
  const wb = d.world_border || d.WorldBorder || {};
  const pick = (flat, nested, dflt) => numberOr(d[flat] ?? wb[nested], dflt);
  const running = manager.isActive(server.id);
  return {
    level: levelName(server),
    found: Boolean(level),
    running,
    size: pick('BorderSize', 'size', 59999968),
    centerX: pick('BorderCenterX', 'center_x', 0),
    centerZ: pick('BorderCenterZ', 'center_z', 0),
    damage: pick('BorderDamagePerBlock', 'damage_per_block', 0.2),
    warning: pick('BorderWarningBlocks', 'warning_blocks', 5),
    spawnX: numberOr(d.SpawnX, 0),
    spawnZ: numberOr(d.SpawnZ, 0),
    regions: await listRegions(server),
    note: running ? 'Shown as of the last save. Changes are made with commands while the server runs.' : 'The server is stopped: changes are written to level.dat.',
  };
}

const BORDER_MAX = 59999968;
const CENTER_MAX = 29999984;

function cleanBorder(body) {
  const num = (v, name, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) fail(400, `${name} must be between ${min} and ${max}`);
    return n;
  };
  return {
    size: num(body.size, 'The size', 1, BORDER_MAX),
    centerX: num(body.centerX ?? 0, 'The centre X', -CENTER_MAX, CENTER_MAX),
    centerZ: num(body.centerZ ?? 0, 'The centre Z', -CENTER_MAX, CENTER_MAX),
    seconds: Math.max(0, Math.min(86400, Math.round(Number(body.seconds) || 0))),
    damage: body.damage === undefined ? undefined : num(body.damage, 'Damage per block', 0, 1000),
    warning: body.warning === undefined ? undefined : num(body.warning, 'Warning distance', 0, 100000),
  };
}

async function setBorder(manager, server, body) {
  must(server);
  const b = cleanBorder(body || {});
  if (manager.isActive(server.id)) {
    if (manager.rt(server.id).status !== 'running') fail(409, 'Wait until the server has finished starting');
    await manager.sendCommand(server.id, `worldborder center ${b.centerX} ${b.centerZ}`);
    await manager.sendCommand(server.id, `worldborder set ${b.size}${b.seconds ? ` ${b.seconds}` : ''}`);
    if (b.damage !== undefined) await manager.sendCommand(server.id, `worldborder damage amount ${b.damage}`);
    if (b.warning !== undefined) await manager.sendCommand(server.id, `worldborder warning distance ${b.warning}`);
    return { via: 'commands', ...(await borderInfo(manager, server)) };
  }
  const file = containedPath(server.dir, `${levelName(server)}/level.dat`);
  const buf = await fsp.readFile(file).catch(() => null);
  if (!buf) fail(404, 'There is no world yet. Start the server once so it makes one.');
  const root = nbt.readTyped(buf);
  const data = root.Data || root;
  if (data.world_border || data.WorldBorder) fail(409, 'This world stores its border in a newer format. Start the server and change it there.');
  await fsp.copyFile(file, `${file}.gamepanel-backup`);
  data.BorderSize = b.size;
  data.BorderCenterX = b.centerX;
  data.BorderCenterZ = b.centerZ;
  if (b.damage !== undefined) data.BorderDamagePerBlock = b.damage;
  if (b.warning !== undefined) data.BorderWarningBlocks = b.warning;
  // The size at the end of any growth/shrink must follow, or Minecraft animates from the old one.
  data.BorderSizeLerpTarget = b.size;
  data.BorderSizeLerpTime = 0n;
  await fsp.writeFile(file, nbt.writeGzip(root));
  return { via: 'level.dat', ...(await borderInfo(manager, server)) };
}

/* ---------------------------------------------------------- switch check -- */

const LOADER_OF = { 'minecraft-paper': 'paper', 'minecraft-purpur': 'purpur', 'minecraft-fabric': 'fabric', 'minecraft-quilt': 'quilt', 'minecraft-forge': 'forge', 'minecraft-neoforge': 'neoforge', 'minecraft-vanilla': 'vanilla' };
const DIR_OF = { paper: 'plugins', purpur: 'plugins', fabric: 'mods', quilt: 'mods', forge: 'mods', neoforge: 'mods', vanilla: null };

/**
 * Which of the installed mods and plugins would work after switching to `templateId` at `version`.
 * ok: the installed file already lists that version and loader. update: a newer release of it does.
 * missing: Modrinth knows the project, but has nothing for the target. unknown: not on Modrinth (check by hand).
 */
async function switchCheck(manager, server, { templateId, version }) {
  must(server);
  const target = LOADER_OF[templateId || server.templateId];
  if (!target) fail(400, 'Pick a Minecraft server type');
  const targetVersion = compat.cleanVersion(version);
  const template = manager.template(server);
  const ctx = compat.modContext(server, template);
  const fromLoader = ctx.loader || LOADER_OF[server.templateId];
  const fromDir = DIR_OF[fromLoader];
  const toDir = DIR_OF[target];
  const spec = compat.MINECRAFT[target];

  const { jars } = fromDir ? await scanPlugins(server, template) : { jars: [] };
  const notes = [];
  if (fromDir && toDir && fromDir !== toDir) notes.push(`${fromDir === 'plugins' ? 'Plugins' : 'Mods'} for ${compat.MINECRAFT[fromLoader]?.label || fromLoader} do not load on ${spec.label}, which uses ${toDir}/. Nothing installed carries over.`);
  if (fromDir && !toDir) notes.push(`${spec.label} loads no plugins or mods; everything in ${fromDir}/ stays unused.`);
  const crossKind = fromDir && toDir && fromDir !== toDir;
  const hashes = jars.map((j) => j.hash).filter(Boolean);
  let current = {};
  let fits = {};
  if (hashes.length && toDir && !crossKind) {
    try {
      current = await postJson('https://api.modrinth.com/v2/version_files', { hashes, algorithm: 'sha1' });
      fits = await postJson('https://api.modrinth.com/v2/version_files/update', { hashes, algorithm: 'sha1', loaders: spec.modrinth, ...(targetVersion ? { game_versions: [targetVersion] } : {}) });
    } catch (err) {
      notes.push(`Could not reach Modrinth to check (${err.message}).`);
    }
  }
  const rows = jars.map((jar) => {
    if (crossKind || !toDir) return { file: jar.file, name: jar.name, status: 'wrong-kind' };
    const now = current[jar.hash];
    if (!now) return { file: jar.file, name: jar.name, status: 'unknown' };
    const next = fits[jar.hash];
    const sameLoader = now.loaders.some((l) => spec.modrinth.includes(l));
    const sameVersion = !targetVersion || now.game_versions.includes(targetVersion);
    if (sameLoader && sameVersion) return { file: jar.file, name: jar.name, status: 'ok', version: now.version_number };
    if (next) return { file: jar.file, name: jar.name, status: 'update', version: now.version_number, latest: next.version_number };
    return { file: jar.file, name: jar.name, status: 'missing', version: now.version_number };
  });
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    target: { type: target, label: spec.label, version: targetVersion },
    notes,
    rows,
    summary: { total: rows.length, ok: count('ok'), update: count('update'), missing: count('missing'), unknown: count('unknown'), wrongKind: count('wrong-kind') },
  };
}

module.exports = { pluginUpdates, borderInfo, setBorder, switchCheck, parsePluginYml, newer, cleanBorder, isMinecraft };
