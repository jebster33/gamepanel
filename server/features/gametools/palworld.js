'use strict';

/**
 * Palworld player data reset. Each player has Pal/Saved/SaveGames/0/<world>/Players/<GUID>.sav
 * (GUID = 32 hex digits, the first 8 come from the Steam account). Deleting that file gives
 * the player a brand new character on their next join. The panel:
 *   - lists the files, with names where it can learn them (RCON ShowPlayers, the REST API,
 *     and names it saw before are remembered, since Level.sav is not parsed),
 *   - copies the file (and its _dps pal-box file) to gamepanel-backups/palworld/ first,
 *   - only works while the server is stopped,
 *   - can put a backup back.
 *
 * Level.sav still holds the player's pals, guild and bases: those are NOT touched.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { fail } = require('../../core/util');
const { containedPath } = require('../files');
const { rconCommand } = require('../../games/rcon');
const secrets = require('../../core/secrets');
const common = require('./common');

const SAVES = 'Pal/Saved/SaveGames/0';
const WORLD = /^[0-9A-Fa-f]{32}$/;
const GUID = /^[0-9A-F]{32}$/;
const BACKUP_ROOT = 'gamepanel-backups/palworld';
const STAMP = /^\d{14}$/;

const st = (server) => (server.palworld && typeof server.palworld === 'object' ? server.palworld : (server.palworld = { names: {} }));

function worlds(server) {
  try {
    return fs
      .readdirSync(containedPath(server.dir, SAVES), { withFileTypes: true })
      .filter((e) => e.isDirectory() && WORLD.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function worldDir(server, world) {
  const all = worlds(server);
  const pick = world || (all.length === 1 ? all[0] : null);
  if (!pick || !all.includes(pick)) fail(400, all.length > 1 ? 'Pick a world' : 'No Palworld world was found. Start the server once so it creates one.');
  return pick;
}

/** The 8-hex player id of an RCON ShowPlayers "playeruid" (decimal) as the file name stem. */
const guidFromUid = (uid) => (/^\d{1,10}$/.test(String(uid)) ? Number(uid).toString(16).toUpperCase().padStart(8, '0') + '0'.repeat(24) : null);
const guidFromId = (id) => {
  const g = String(id || '').replace(/-/g, '').toUpperCase();
  return GUID.test(g) ? g : null;
};

/** Parse "name,playeruid,steamid" CSV lines from ShowPlayers. */
function parseShowPlayers(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^(.*),(\d{1,10}),(\d{5,20}|None|)\s*$/);
    if (m && m[1] !== 'name') out.push({ guid: guidFromUid(m[2]), name: m[1].trim(), steamId: m[3] && m[3] !== 'None' ? m[3] : null });
  }
  return out.filter((p) => p.guid);
}

function restPlayers(server, password) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: 8212, path: '/v1/api/players', auth: `admin:${password}`, timeout: 3000 },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size < 1024 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(
              (json.players || [])
                .map((p) => ({ guid: guidFromId(p.playerId), name: String(p.name || p.accountName || '').slice(0, 60), steamId: String(p.userId || '').replace(/^steam_/, '') || null }))
                .filter((p) => p.guid)
            );
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => req.destroy());
  });
}

/** Names of online players, via RCON then the REST API. Quietly empty when the server is off. */
async function onlineNames(manager, server) {
  if (!manager.isActive(server.id)) return [];
  const template = manager.template(server);
  const vars = manager.vars(server);
  let players = [];
  if (template?.rcon && vars.RCON_PASSWORD) {
    try {
      players = parseShowPlayers(await rconCommand({ host: '127.0.0.1', port: server.ports[template.rcon.port || 'rcon'], password: vars.RCON_PASSWORD, command: 'ShowPlayers', timeout: 4000 }));
    } catch {
      players = [];
    }
  }
  if (!players.length && vars.ADMIN_PASSWORD) players = await restPlayers(server, secrets.open(vars.ADMIN_PASSWORD));
  return players;
}

function describe(server, online = []) {
  const s = st(server);
  for (const p of online) if (p.name) s.names[p.guid] = p.name;
  const out = [];
  for (const world of worlds(server)) {
    const dir = containedPath(server.dir, `${SAVES}/${world}/Players`);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const players = entries
      .filter((e) => e.isFile() && /^[0-9A-F]{32}\.sav$/i.test(e.name))
      .map((e) => {
        const guid = e.name.slice(0, 32).toUpperCase();
        const stat = fs.statSync(path.join(dir, e.name));
        return { guid, name: s.names[guid] || null, online: online.some((p) => p.guid === guid), size: stat.size, modified: stat.mtimeMs, hasPalBox: fs.existsSync(path.join(dir, `${guid}_dps.sav`)) };
      })
      .sort((a, b) => b.modified - a.modified);
    out.push({ world, players });
  }
  return { worlds: out, backups: backups(server) };
}

function backups(server) {
  const out = [];
  try {
    const root = containedPath(server.dir, BACKUP_ROOT);
    for (const world of fs.readdirSync(root)) {
      if (!WORLD.test(world)) continue;
      for (const stamp of fs.readdirSync(path.join(root, world))) {
        if (!STAMP.test(stamp)) continue;
        const files = fs.readdirSync(path.join(root, world, stamp)).filter((f) => /^[0-9A-F]{32}(_dps)?\.sav$/.test(f));
        const guid = files.map((f) => f.slice(0, 32)).find(Boolean);
        if (guid) out.push({ world, stamp, guid, name: st(server).names[guid] || null, files });
      }
    }
  } catch {
    /* none yet */
  }
  return out.sort((a, b) => b.stamp.localeCompare(a.stamp));
}

async function list(manager, server) {
  const online = await onlineNames(manager, server);
  const out = describe(server, online);
  manager.store?.save?.();
  return { ...out, running: manager.isActive(server.id) };
}

/** Back up and remove one player's save. */
function reset(manager, store, server, input = {}) {
  common.requireStopped(manager, server, 'Resetting a player');
  const guid = String(input.guid || '').toUpperCase();
  if (!GUID.test(guid)) fail(400, 'That is not a player id');
  if (input.confirm !== guid) fail(400, 'Type the player id to confirm the reset');
  const world = worldDir(server, input.world);
  const dir = containedPath(server.dir, `${SAVES}/${world}/Players`);
  const main = path.join(dir, `${guid}.sav`);
  if (!fs.existsSync(main)) fail(404, 'That player has no save file');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupDir = containedPath(server.dir, `${BACKUP_ROOT}/${world}/${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const targets = [`${guid}.sav`];
  if (input.includePalBox && fs.existsSync(path.join(dir, `${guid}_dps.sav`))) targets.push(`${guid}_dps.sav`);
  for (const f of targets) fs.copyFileSync(path.join(dir, f), path.join(backupDir, f), fs.constants.COPYFILE_EXCL);
  // Only after every copy succeeded.
  for (const f of targets) fs.rmSync(path.join(dir, f));
  store.save();
  return { ok: true, removed: targets, backup: `${BACKUP_ROOT}/${world}/${stamp}`, ...describe(server) };
}

function restore(manager, store, server, input = {}) {
  common.requireStopped(manager, server, 'Restoring a player');
  const { world, stamp } = input;
  if (!WORLD.test(String(world || '')) || !STAMP.test(String(stamp || ''))) fail(400, 'Unknown backup');
  const from = containedPath(server.dir, `${BACKUP_ROOT}/${world}/${stamp}`);
  if (!fs.existsSync(from)) fail(404, 'Backup not found');
  const dir = containedPath(server.dir, `${SAVES}/${worldDir(server, world)}/Players`);
  fs.mkdirSync(dir, { recursive: true });
  const restored = [];
  for (const f of fs.readdirSync(from).filter((n) => /^[0-9A-F]{32}(_dps)?\.sav$/.test(n))) {
    const target = path.join(dir, f);
    // The file a newly created character wrote in the meantime is kept beside it, not overwritten.
    if (fs.existsSync(target)) fs.renameSync(target, `${target}.before-restore-${stamp}`);
    fs.copyFileSync(path.join(from, f), target);
    restored.push(f);
  }
  store.save();
  return { ok: true, restored, ...describe(server) };
}

module.exports = { list, describe, reset, restore, parseShowPlayers, guidFromUid, guidFromId, worlds, backups, SAVES, BACKUP_ROOT };
