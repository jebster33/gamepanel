'use strict';

/**
 * Minecraft worlds: list them, pick which one the server loads, download or
 * import one, and reset (with a backup first, and optionally a new seed).
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 *
 * Java keeps worlds in the server folder (world, world_nether, world_the_end);
 * Bedrock keeps them under worlds/. Both name the active one in
 * server.properties as level-name.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { fail } = require('../core/util');
const { containedPath, extract } = require('../features/files');
const { patchKeyValue } = require('./config-files');

const NAME = /^[A-Za-z0-9 _.\-]{1,64}$/;
const DIMENSIONS = ['', '_nether', '_the_end'];
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const isBedrock = (server) => server.templateId === 'minecraft-bedrock';
const isMinecraft = (server) => String(server.templateId || '').startsWith('minecraft');
const worldsRel = (server) => (isBedrock(server) ? 'worlds' : '');

function validName(name) {
  const text = String(name || '').trim();
  if (!NAME.test(text) || text.startsWith('.') || text === '..') fail(400, 'World names can use letters, numbers, spaces, dots, dashes and underscores');
  return text;
}

async function folderSize(dir, budget = { files: 50_000 }) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (--budget.files < 0) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(full, budget);
    else if (entry.isFile()) total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Depth-limited search for the folder holding level.dat inside an unpacked archive. */
function findLevel(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'level.dat'))) return dir;
  if (depth >= 3) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '__MACOSX') continue;
    const found = findLevel(path.join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

module.exports = {
  readProperties(server) {
    try {
      return require('../core/safefs').readText(containedPath(server.dir, 'server.properties'), 1024 * 1024);
    } catch {
      return '';
    }
  },

  /**
   * The game's own per-player statistics (world/stats/<uuid>.json, Java
   * Edition 1.13+): deaths, kills, distance, most-mined blocks, advancements.
   * Returns null when the server or player has none.
   */
  playerStats(server, name) {
    if (isBedrock(server)) return null;
    const read = (rel) => {
      try {
        return JSON.parse(require('../core/safefs').readText(containedPath(server.dir, rel), 4 * 1024 * 1024));
      } catch {
        return null;
      }
    };
    const cache = read('usercache.json');
    const entry = Array.isArray(cache) && cache.find((u) => String(u.name).toLowerCase() === String(name).toLowerCase());
    if (!entry || !/^[0-9a-f-]{36}$/i.test(entry.uuid)) return null;
    const world = this.activeWorld(server);
    const data = read(path.join(world, 'stats', `${entry.uuid}.json`));
    if (!data?.stats) return null;
    const st = data.stats;
    const custom = st['minecraft:custom'] || {};
    const c = (k) => Number(custom[`minecraft:${k}`]) || 0;
    const nice = (k) => k.replace(/^minecraft:/, '').replace(/_/g, ' ');
    const top = (group, n = 5) =>
      Object.entries(st[group] || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => ({ name: nice(k), count: v }));
    const sum = (group) => Object.values(st[group] || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const cm = Object.entries(custom).reduce((a, [k, v]) => a + (k.endsWith('_one_cm') ? Number(v) || 0 : 0), 0);
    const adv = read(path.join(world, 'advancements', `${entry.uuid}.json`)) || {};
    const advancements = Object.entries(adv).filter(([k, v]) => !k.includes(':recipes/') && v?.done === true).length;
    return {
      uuid: entry.uuid,
      playSeconds: Math.round((c('play_time') || c('play_one_minute')) / 20),
      deaths: c('deaths'),
      mobKills: c('mob_kills'),
      playerKills: c('player_kills'),
      jumps: c('jump'),
      km: Math.round(cm / 1000) / 100,
      mined: sum('minecraft:mined'),
      used: sum('minecraft:used'),
      advancements,
      topMined: top('minecraft:mined'),
      topKilled: top('minecraft:killed'),
      killedBy: top('minecraft:killed_by', 3),
    };
  },

  /** Top three per stat across everyone who has played, for the status page. Cached 10 minutes. */
  leaderboards(server) {
    this.boardCache ||= new Map();
    const hit = this.boardCache.get(server.id);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    const names = (this.playerHistory?.(server.id)?.players || []).slice(0, 300).map((p) => p.name);
    const rows = names.map((name) => ({ name, st: this.playerStats(server, name) })).filter((r) => r.st);
    const board = (label, key, unit = '') =>
      ({
        label,
        top: rows
          .filter((r) => r.st[key] > 0)
          .sort((a, b) => b.st[key] - a.st[key])
          .slice(0, 3)
          .map((r) => ({ name: r.name, value: `${Number(r.st[key]).toLocaleString('en-US')}${unit}` })),
      });
    const value = rows.length ? [board('Mob kills', 'mobKills'), board('Player kills', 'playerKills'), board('Blocks mined', 'mined'), board('Travelled', 'km', ' km'), board('Deaths', 'deaths')].filter((b) => b.top.length) : [];
    this.boardCache.set(server.id, { at: Date.now(), value });
    return value;
  },

  activeWorld(server) {
    const m = this.readProperties(server).match(/^level-name=(.*)$/m);
    return (m && m[1].trim()) || (isBedrock(server) ? 'Bedrock level' : 'world');
  },

  setProperties(server, values) {
    const file = containedPath(server.dir, 'server.properties');
    fs.writeFileSync(file, patchKeyValue(this.readProperties(server), values));
  },

  async listWorlds(server) {
    if (!isMinecraft(server)) return { supported: false };
    const base = containedPath(server.dir, worldsRel(server));
    const active = this.activeWorld(server);
    const seed = (this.readProperties(server).match(/^level-seed=(.*)$/m) || [])[1] || '';
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, 'level.dat')));
    } catch {
      /* no worlds yet */
    }
    const names = new Set(entries.map((e) => e.name));
    // world_nether and world_the_end belong to "world" on Paper/Spigot.
    const roots = [...names].filter((n) => !DIMENSIONS.slice(1).some((d) => n.endsWith(d) && names.has(n.slice(0, -d.length))));
    const worlds = [];
    for (const name of roots) {
      const parts = DIMENSIONS.map((d) => name + d).filter((n) => names.has(n));
      let size = 0;
      for (const part of parts) size += await folderSize(path.join(base, part));
      const stat = fs.statSync(path.join(base, name, 'level.dat'));
      worlds.push({ name, active: name === active, size, modified: stat.mtimeMs, dimensions: parts.length });
    }
    worlds.sort((a, b) => Number(b.active) - Number(a.active) || b.modified - a.modified);
    return { supported: true, active, seed, bedrock: isBedrock(server), worlds, activeExists: names.has(active) };
  },

  /** Load another world (or a new one, generated on next start). */
  async useWorld(id, name, actor) {
    const server = this.require(id);
    if (!isMinecraft(server)) fail(400, 'Only Minecraft servers have worlds here');
    const world = validName(name);
    this.setProperties(server, { 'level-name': world });
    this.store.addEvent('server.settings', `${actor?.username || 'Someone'} set ${server.name} to load the world ${world}`, { serverId: id });
    this.logActivity?.(id, { type: 'world', text: `Switched to world ${world}`, by: actor?.username });
    return { ok: true, restartNeeded: this.isActive(id) };
  },

  /** Delete a world so the next start generates a fresh one, with a backup first. */
  async resetWorld(id, { name, seed, backup = true } = {}, actor) {
    const server = this.require(id);
    if (!isMinecraft(server)) fail(400, 'Only Minecraft servers have worlds here');
    if (this.isActive(id)) fail(409, 'Stop the server before resetting a world');
    const world = validName(name || this.activeWorld(server));
    if (seed !== undefined && seed !== null && !/^[^\r\n\\]{0,64}$/.test(String(seed))) fail(400, 'Seeds can be up to 64 characters');

    let made = null;
    if (backup) {
      this.pushConsole(server, `Backing up before resetting ${world}…`, 'system');
      try {
        made = await require('../features/backups').create(server, 'before-world-reset');
      } catch (err) {
        fail(500, `The backup failed, so nothing was deleted: ${err.message}`);
      }
    }
    const base = worldsRel(server);
    for (const part of DIMENSIONS.map((d) => world + d)) {
      const dir = containedPath(server.dir, path.join(base, part));
      if (fs.existsSync(path.join(dir, 'level.dat'))) await fsp.rm(dir, { recursive: true, force: true });
    }
    if (seed !== undefined && seed !== null) this.setProperties(server, { 'level-seed': String(seed).trim() });
    this.pushConsole(server, `World ${world} reset. A new one is generated on the next start.`, 'system');
    this.store.addEvent('server.world_reset', `${actor?.username || 'Someone'} reset the world ${world} on ${server.name}`, { serverId: id });
    this.logActivity?.(id, { type: 'world', text: `Reset world ${world}`, by: actor?.username });
    return { ok: true, backup: made?.name || null };
  },

  async deleteWorld(id, name, actor) {
    const server = this.require(id);
    const world = validName(name);
    if (world === this.activeWorld(server)) fail(400, 'That is the world the server loads. Reset it instead, or switch to another first.');
    return this.resetWorld(id, { name: world, backup: true }, actor);
  },

  /** Stream a world (with its nether and end) as a .tar.gz. */
  downloadWorld(server, name, res) {
    const world = validName(name);
    const base = containedPath(server.dir, worldsRel(server));
    const parts = DIMENSIONS.map((d) => world + d).filter((n) => fs.existsSync(path.join(containedPath(base, n), 'level.dat')));
    if (!parts.length) fail(404, 'No such world');
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${world.replace(/[^A-Za-z0-9._-]/g, '_')}.tar.gz"`,
    });
    const proc = spawn(TAR, ['-czf', '-', ...parts], { cwd: base, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    proc.stdout.pipe(res);
    proc.on('error', () => res.destroy());
    res.on('close', () => proc.kill());
  },

  /**
   * Turn an uploaded archive into a world folder: unpack it in a scratch
   * folder, find level.dat, move that folder into place, then tidy up.
   */
  async importWorld(id, { path: rel, name, use = false } = {}, actor) {
    const server = this.require(id);
    if (!isMinecraft(server)) fail(400, 'Only Minecraft servers have worlds here');
    const world = validName(name);
    const archive = containedPath(server.dir, String(rel || ''));
    if (!fs.existsSync(archive)) fail(404, 'The uploaded file is missing');
    const target = containedPath(server.dir, path.join(worldsRel(server), world));
    if (fs.existsSync(target)) fail(409, `A world called ${world} already exists`);

    const scratchRel = `.gp-world-import-${Date.now()}`;
    const scratch = containedPath(server.dir, scratchRel);
    fs.mkdirSync(scratch);
    try {
      const inside = path.join(scratch, path.basename(archive));
      fs.renameSync(archive, inside);
      await extract(server.dir, path.posix.join(scratchRel, path.basename(archive)));
      fs.rmSync(inside, { force: true });
      const found = findLevel(scratch);
      if (!found) fail(400, 'No level.dat in that archive, so it does not look like a Minecraft world');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(found, target);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    this.logActivity?.(id, { type: 'world', text: `Imported world ${world}`, by: actor?.username });
    this.store.addEvent('server.settings', `${actor?.username || 'Someone'} imported the world ${world} into ${server.name}`, { serverId: id });
    if (use) return this.useWorld(id, world, actor);
    return { ok: true };
  },
};
