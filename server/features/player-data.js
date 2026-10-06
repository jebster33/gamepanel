'use strict';

/**
 * A Minecraft (Java) player's saved state: inventory, armour, off-hand,
 * ender chest, health, hunger, level and where they are, read from
 * <world>/playerdata/<uuid>.dat. The same file can be read out of any backup
 * and put back on its own, to undo one player's lost inventory or griefing
 * without rolling the whole world back.
 */

const fs = require('fs');
const path = require('path');
const { fail } = require('../core/util');
const nbt = require('../core/nbt');
const backups = require('./backups');
const { containedPath } = require('./files');
const lists = require('../games/player-lists');

const isJava = (template) => template?.query?.type === 'minecraft' && template.id !== 'minecraft-bedrock' && template.id !== 'minecraft-velocity';

/**
 * A name's UUID, so its player file can be found: usercache.json first, then
 * the name Paper and Spigot keep inside each player file, then the Mojang
 * (online) and offline UUIDs, whichever has a file.
 */
async function uuidOf(manager, server, name) {
  const lower = String(name).toLowerCase();
  try {
    const cache = JSON.parse(fs.readFileSync(containedPath(server.dir, 'usercache.json'), 'utf8'));
    const hit = cache.find((u) => String(u.name).toLowerCase() === lower);
    if (hit && /^[0-9a-f-]{36}$/i.test(hit.uuid)) return hit.uuid;
  } catch {
    /* no cache yet */
  }
  const dir = containedPath(server.dir, `${manager.activeWorld(server)}/playerdata`);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.dat$/i.test(f));
  } catch {
    files = [];
  }
  for (const f of files.slice(0, 3000)) {
    try {
      const known = nbt.read(fs.readFileSync(path.join(dir, f))).bukkit?.lastKnownName;
      if (known && String(known).toLowerCase() === lower) return f.slice(0, 36);
    } catch {
      /* unreadable: skip */
    }
  }
  const have = new Set(files.map((f) => f.slice(0, 36).toLowerCase()));
  const offline = lists.offlineUuid(name);
  if (have.has(offline)) return offline;
  try {
    const profile = await require('./mods/http').getJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
    if (profile?.id) {
      const id = profile.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
      if (have.has(id)) return id;
    }
  } catch {
    /* no Mojang account, or no internet */
  }
  return null;
}

function relPath(manager, server, uuid) {
  return `${manager.activeWorld(server)}/playerdata/${uuid}.dat`;
}

/* ------------------------------------------------------------- items -- */

const nice = (id) =>
  String(id || '')
    .replace(/^minecraft:/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** A chat component (JSON string or compound) as plain text. */
function plainText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    try {
      return plainText(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(plainText).join('');
  if (typeof value === 'object') return `${value.text ?? ''}${(value.extra || []).map(plainText).join('')}`;
  return String(value);
}

/** One item, from either save format (1.20.5+ components, or the older tag). */
function item(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const comp = raw.components || {};
  const tag = raw.tag || {};
  const enchMap = comp['minecraft:enchantments']?.levels || comp['minecraft:enchantments'] || comp['minecraft:stored_enchantments']?.levels || comp['minecraft:stored_enchantments'];
  let enchants = [];
  if (enchMap && typeof enchMap === 'object' && !Array.isArray(enchMap)) {
    enchants = Object.entries(enchMap)
      .filter(([k]) => k !== 'show_in_tooltip')
      .map(([k, v]) => ({ id: nice(k), level: Number(v) }));
  } else {
    enchants = [...(tag.Enchantments || []), ...(tag.StoredEnchantments || [])].map((e) => ({ id: nice(e.id), level: Number(e.lvl) }));
  }
  const contents = comp['minecraft:container'] || tag.BlockEntityTag?.Items;
  return {
    id: String(raw.id).replace(/^minecraft:/, ''),
    name: plainText(comp['minecraft:custom_name'] ?? tag.display?.Name) || nice(raw.id),
    custom: Boolean(comp['minecraft:custom_name'] ?? tag.display?.Name),
    count: Number(raw.count ?? raw.Count ?? 1),
    damage: Number(comp['minecraft:damage'] ?? tag.Damage ?? 0) || 0,
    enchants,
    contains: Array.isArray(contents) ? contents.length : 0,
  };
}

const ARMOR_SLOTS = { 103: 'head', 102: 'chest', 101: 'legs', 100: 'feet' };

/** The parts of a player file the panel shows. */
function summarize(data) {
  const inventory = [];
  const armor = { head: null, chest: null, legs: null, feet: null };
  let offhand = null;
  for (const raw of data.Inventory || []) {
    const slot = Number(raw.Slot);
    const it = item(raw);
    if (!it) continue;
    if (ARMOR_SLOTS[slot]) armor[ARMOR_SLOTS[slot]] = it;
    else if (slot === -106) offhand = it;
    else if (slot >= 0 && slot <= 35) inventory.push({ slot, ...it });
  }
  // 1.21.5+ keeps armour and the off-hand in "equipment".
  for (const [k, raw] of Object.entries(data.equipment || {})) {
    const it = item(raw);
    if (!it) continue;
    if (k === 'offhand') offhand = it;
    else if (k in armor) armor[k] = it;
  }
  const ender = (data.EnderItems || []).map((raw) => ({ slot: Number(raw.Slot), ...item(raw) })).filter((x) => x.id);
  const pos = Array.isArray(data.Pos) ? data.Pos.map((n) => Math.round(Number(n) * 10) / 10) : null;
  const modes = ['Survival', 'Creative', 'Adventure', 'Spectator'];
  return {
    health: Math.round(Number(data.Health ?? 20) * 10) / 10,
    food: Number(data.foodLevel ?? 20),
    level: Number(data.XpLevel ?? 0),
    gamemode: modes[Number(data.playerGameType)] || null,
    dimension: String(data.Dimension ?? (data.Dimension === 0 ? 'overworld' : '')).replace(/^minecraft:/, '') || 'overworld',
    pos,
    inventory,
    armor,
    offhand,
    ender,
  };
}

/* --------------------------------------------------------------- the API -- */

async function target(manager, server, name) {
  if (!isJava(manager.template(server))) fail(400, 'Inventories can be read on Minecraft Java servers');
  const uuid = await uuidOf(manager, server, name);
  if (!uuid) fail(404, `${name} has no saved data on this server yet`);
  return { uuid, rel: relPath(manager, server, uuid) };
}

/** Now, or as it was in a backup. */
async function inventory(manager, server, name, { backup = null } = {}) {
  const { uuid, rel } = await target(manager, server, name);
  let buf;
  if (backup) {
    buf = await backups.readFile(server, backup, rel);
    if (!buf) fail(404, `${name} is not in that backup (they had not joined yet, or the world was different)`);
  } else {
    try {
      buf = fs.readFileSync(containedPath(server.dir, rel));
    } catch {
      fail(404, `${name} has no saved data on this server yet`);
    }
  }
  let data;
  try {
    data = nbt.read(buf);
  } catch (err) {
    fail(422, `Could not read ${name}'s player file: ${err.message}`);
  }
  const online = manager.isActive(server.id) && (manager.rt(server.id).playerList || []).some((p) => p.toLowerCase() === String(name).toLowerCase());
  return { uuid, name, backup, online, ...summarize(data) };
}

/** Put one player's file back from a backup. The current one is kept next to it. */
async function restore(manager, store, server, name, backup, actor) {
  const { uuid, rel } = await target(manager, server, name);
  const online = manager.isActive(server.id) && (manager.rt(server.id).playerList || []).some((p) => p.toLowerCase() === String(name).toLowerCase());
  // While they play, the game would write over it when they leave.
  if (online) fail(409, `${name} is online. Kick them (or wait until they leave), then restore.`);
  const buf = await backups.readFile(server, backup, rel);
  if (!buf) fail(404, `${name} is not in that backup`);
  nbt.read(buf); // refuse a damaged file before touching anything
  const file = containedPath(server.dir, rel);
  if (fs.existsSync(file)) {
    const keep = containedPath(server.dir, `.gamepanel/player-rollbacks/${uuid}-${new Date().toISOString().replace(/[:.]/g, '-')}.dat`);
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.copyFileSync(file, keep);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.gamepanel-tmp`, buf);
  fs.renameSync(`${file}.gamepanel-tmp`, file);
  manager.logActivity(server.id, { type: 'inventory', name, by: actor, text: backup });
  store.addEvent('player.restored', `${actor} put back ${name}'s inventory on ${server.name} from ${backup}`, { serverId: server.id });
  return { ok: true };
}

module.exports = { inventory, restore, summarize, item, uuidOf };
