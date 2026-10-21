'use strict';

/**
 * Editing a Minecraft (Java) player's inventory, armour, off-hand and ender
 * chest in <world>/playerdata/<uuid>.dat. The file is read with the typed NBT
 * reader and written back with every tag the panel does not understand left
 * alone: only the fields the editor shows (id, count, damage, custom name,
 * enchantments, slot) are touched. Allowed only while the player is offline,
 * the old file is always copied to .gamepanel/player-rollbacks first, and the
 * new one is checked and renamed into place atomically.
 *
 * Slot numbers follow the game: 0-8 hotbar, 9-35 main, 100 feet, 101 legs,
 * 102 chest, 103 head, -106 off-hand; ender chest 0-26.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail } = require('../core/util');
const nbt = require('../core/nbt');
const safefs = require('../core/safefs');
const { containedPath } = require('./files');
const pd = require('./player-data');

const ITEM_ID = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]{1,64}$/;
const ARMOR = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head' };
const EQUIP_SLOT = { feet: 100, legs: 101, chest: 102, head: 103, offhand: -106 };
const INV_SLOTS = new Set([...Array(36).keys(), 100, 101, 102, 103, -106]);
const T = nbt.TYPES;

const withNs = (id) => (String(id).includes(':') ? String(id) : `minecraft:${id}`);
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const types = (obj) => (obj[T] ||= {});

/** How this file stores items: 'new' (1.20.5+ components) or 'legacy' (tag), and where armour lives. */
function formatOf(data) {
  const dv = Number(data.DataVersion || 0);
  const sample = [...(data.Inventory || []), ...(data.EnderItems || [])][0];
  const isNew = sample ? Boolean(sample.components || sample.count !== undefined) : dv >= 3837;
  return { dataVersion: dv, items: isNew ? 'new' : 'legacy', flatEnchants: dv >= 4325, equipment: Boolean(data.equipment) || dv >= 4325, plainName: dv >= 4325 };
}

/** The editor's view of one item: full ids, plain-text name. */
function itemFields(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const comp = raw.components || {};
  const tag = raw.tag || {};
  const ench = [];
  const fromMap = (m) => {
    const levels = m && typeof m === 'object' ? m.levels || m : null;
    for (const [k, v] of Object.entries(levels || {})) if (k !== 'show_in_tooltip' && typeof v !== 'object') ench.push({ id: withNs(k), level: Number(v) });
  };
  fromMap(comp['minecraft:enchantments']);
  fromMap(comp['minecraft:stored_enchantments']);
  for (const e of [...(tag.Enchantments || []), ...(tag.StoredEnchantments || [])]) ench.push({ id: withNs(e.id), level: Number(e.lvl) });
  return {
    id: withNs(raw.id),
    count: Number(raw.count ?? raw.Count ?? 1),
    damage: Number(comp['minecraft:damage'] ?? tag.Damage ?? 0) || 0,
    name: pd.plainText(comp['minecraft:custom_name'] ?? tag.display?.Name) || '',
    enchants: ench,
  };
}

function editorView(data) {
  const inventory = [];
  for (const raw of data.Inventory || []) {
    const slot = Number(raw.Slot);
    const f = itemFields(raw);
    if (f && INV_SLOTS.has(slot)) inventory.push({ slot, ...f });
  }
  for (const [k, raw] of Object.entries(data.equipment || {})) {
    const f = itemFields(raw);
    if (f && k in EQUIP_SLOT) inventory.push({ slot: EQUIP_SLOT[k], ...f });
  }
  const ender = [];
  for (const raw of data.EnderItems || []) {
    const f = itemFields(raw);
    if (f) ender.push({ slot: Number(raw.Slot), ...f });
  }
  return { inventory, ender };
}

/* --------------------------------------------------------- building items -- */

function cleanEntry(e, box) {
  if (!e || typeof e !== 'object') fail(400, 'Bad item');
  const slot = Number(e.slot);
  if (!Number.isInteger(slot) || !(box === 'ender' ? slot >= 0 && slot <= 26 : INV_SLOTS.has(slot))) fail(400, `Slot ${e.slot} does not exist`);
  const id = String(e.id || '').trim().toLowerCase();
  if (!ITEM_ID.test(id)) fail(400, `"${id}" is not an item id`);
  const count = Math.round(Number(e.count));
  if (!Number.isFinite(count) || count < 1 || count > 99) fail(400, 'Count must be 1 to 99');
  const damage = Math.max(0, Math.min(32767, Math.round(Number(e.damage) || 0)));
  const name = String(e.name || '').slice(0, 100);
  if (/[\u0000-\u001f\u007f]/.test(name)) fail(400, 'Names cannot contain control characters');
  const enchants = (Array.isArray(e.enchants) ? e.enchants : []).slice(0, 40).map((x) => {
    const eid = String(x?.id || '').trim().toLowerCase();
    if (!ITEM_ID.test(eid)) fail(400, `"${eid}" is not an enchantment id`);
    const level = Math.round(Number(x.level));
    if (!Number.isFinite(level) || level < 1 || level > 255) fail(400, 'Enchantment levels are 1 to 255');
    return { id: withNs(eid), level };
  });
  let from = null;
  if (e.from && typeof e.from === 'object' && ['inventory', 'ender'].includes(e.from.box) && Number.isInteger(Number(e.from.slot))) from = { box: e.from.box, slot: Number(e.from.slot) };
  return { slot, id: withNs(id), count, damage, name, enchants, from };
}

function setKey(obj, key, value, type) {
  obj[key] = value;
  types(obj)[key] = type;
}

function dropKey(obj, key) {
  delete obj[key];
  if (obj[T]) delete obj[T][key];
}

/** Apply the editor's fields onto an item compound, leaving everything else in it alone. */
function applyFields(raw, f, fmt) {
  setKey(raw, 'id', f.id, 8);
  if (fmt.items === 'new') {
    setKey(raw, 'count', f.count, 3);
    dropKey(raw, 'Count');
    const comp = raw.components && typeof raw.components === 'object' ? raw.components : nbt.compound();
    if (f.damage > 0) setKey(comp, 'minecraft:damage', f.damage, 3);
    else dropKey(comp, 'minecraft:damage');
    if (f.name !== (pd.plainText(comp['minecraft:custom_name']) || '')) {
      if (f.name) setKey(comp, 'minecraft:custom_name', fmt.plainName ? f.name : JSON.stringify({ text: f.name }), 8);
      else dropKey(comp, 'minecraft:custom_name');
    }
    const book = f.id === 'minecraft:enchanted_book';
    const key = book ? 'minecraft:stored_enchantments' : 'minecraft:enchantments';
    dropKey(comp, book ? 'minecraft:enchantments' : 'minecraft:stored_enchantments');
    const old = comp[key];
    if (f.enchants.length) {
      const levels = nbt.compound(Object.fromEntries(f.enchants.map((e) => [e.id, e.level])), Object.fromEntries(f.enchants.map((e) => [e.id, 3])));
      const wrapped = old && typeof old === 'object' && old.levels ? true : !old && !fmt.flatEnchants;
      if (wrapped) {
        const holder = old && typeof old === 'object' && old.levels ? old : nbt.compound();
        setKey(holder, 'levels', levels, 10);
        setKey(comp, key, holder, 10);
      } else setKey(comp, key, levels, 10);
    } else dropKey(comp, key);
    if (Object.keys(comp).length) setKey(raw, 'components', comp, 10);
    else dropKey(raw, 'components');
  } else {
    setKey(raw, 'Count', f.count, 1);
    dropKey(raw, 'count');
    const tag = raw.tag && typeof raw.tag === 'object' ? raw.tag : nbt.compound();
    if (f.damage > 0) setKey(tag, 'Damage', f.damage, 3);
    else dropKey(tag, 'Damage');
    if (f.name !== (pd.plainText(tag.display?.Name) || '')) {
      if (f.name) {
        const display = tag.display && typeof tag.display === 'object' ? tag.display : nbt.compound();
        setKey(display, 'Name', JSON.stringify({ text: f.name }), 8);
        setKey(tag, 'display', display, 10);
      } else if (tag.display) {
        dropKey(tag.display, 'Name');
        if (!Object.keys(tag.display).length) dropKey(tag, 'display');
      }
    }
    const book = f.id === 'minecraft:enchanted_book';
    const key = book ? 'StoredEnchantments' : 'Enchantments';
    dropKey(tag, book ? 'Enchantments' : 'StoredEnchantments');
    if (f.enchants.length) {
      setKey(
        tag,
        key,
        nbt.list(
          f.enchants.map((e) => nbt.compound({ id: e.id, lvl: e.level }, { id: 8, lvl: 2 })),
          'compound'
        ),
        9
      );
    } else dropKey(tag, key);
    if (Object.keys(tag).length) setKey(raw, 'tag', tag, 10);
    else dropKey(raw, 'tag');
  }
}

function newItem(f, fmt) {
  const raw = nbt.compound({}, {});
  applyFields(raw, f, fmt);
  return raw;
}

/** Rebuild one container's item list. Existing items keep all their other tags; moved ones are found by `from`. */
function rebuild(entries, box, originals, fmt) {
  const used = new Set();
  return entries.map((entry) => {
    const f = cleanEntry(entry, box);
    const key = f.from ? `${f.from.box}:${f.from.slot}` : null;
    const old = key && !used.has(key) ? originals.get(key) : null;
    let item;
    if (old && withNs(old.id) === f.id) {
      used.add(key);
      item = old;
    } else item = nbt.compound({}, {});
    applyFields(item, f, fmt);
    setKey(item, 'Slot', f.slot, 1);
    return { f, item };
  });
}

/* ------------------------------------------------------------ the file -- */

function readFile(server, rel) {
  let buf;
  try {
    buf = safefs.readRegular(containedPath(server.dir, rel), 8 * 1024 * 1024);
  } catch {
    fail(404, 'That player has no saved data on this server yet');
  }
  let data;
  try {
    data = nbt.readTyped(buf);
  } catch (err) {
    fail(422, `Could not read the player file: ${err.message}`);
  }
  return { buf, data };
}

const isOnline = (manager, server, name) => manager.isActive(server.id) && (manager.rt(server.id).playerList || []).some((p) => p.toLowerCase() === String(name).toLowerCase());

async function view(manager, server, name) {
  const { uuid, rel } = await pd.target(manager, server, name);
  const { buf, data } = readFile(server, rel);
  const fmt = formatOf(data);
  const online = isOnline(manager, server, name);
  return {
    uuid,
    name,
    online,
    editable: !online,
    reason: online ? `${name} is online. The game writes their file when they leave, which would undo any change. Kick them or wait, then edit.` : null,
    version: sha(buf),
    format: fmt.items,
    dataVersion: fmt.dataVersion,
    ...editorView(data),
  };
}

/** Replace the inventory and/or ender chest with what the editor sends. */
async function save(manager, store, server, name, body, actor) {
  const { uuid, rel } = await pd.target(manager, server, name);
  if (isOnline(manager, server, name)) fail(409, `${name} is online. Kick them (or wait until they leave), then edit.`);
  const { buf, data } = readFile(server, rel);
  if (body.version && body.version !== sha(buf)) fail(409, 'The player file changed since you opened it. Reload and try again.');
  const fmt = formatOf(data);

  const originals = new Map();
  for (const raw of data.Inventory || []) originals.set(`inventory:${Number(raw.Slot)}`, raw);
  for (const [k, raw] of Object.entries(data.equipment || {})) if (k in EQUIP_SLOT) originals.set(`inventory:${EQUIP_SLOT[k]}`, raw);
  for (const raw of data.EnderItems || []) originals.set(`ender:${Number(raw.Slot)}`, raw);

  if (!Array.isArray(body.inventory) && !Array.isArray(body.ender)) fail(400, 'Nothing to save');
  const unique = (list, label) => {
    const slots = list.map((e) => Number(e?.slot));
    if (new Set(slots).size !== slots.length) fail(400, `Two items share a slot in the ${label}`);
  };
  const inv = Array.isArray(body.inventory) ? body.inventory.slice(0, 50) : null;
  const ender = Array.isArray(body.ender) ? body.ender.slice(0, 40) : null;
  if (inv) unique(inv, 'inventory');
  if (ender) unique(ender, 'ender chest');

  if (inv) {
    const built = rebuild(inv, 'inventory', originals, fmt);
    const special = (f) => fmt.equipment && (f.slot in ARMOR || f.slot === -106);
    setKey(data, 'Inventory', nbt.list(built.filter(({ f }) => !special(f)).map((b) => b.item), 'compound'), 9);
    if (fmt.equipment) {
      const eq = data.equipment && typeof data.equipment === 'object' ? data.equipment : nbt.compound();
      for (const k of Object.keys(EQUIP_SLOT)) dropKey(eq, k);
      for (const { f, item } of built) {
        if (!special(f)) continue;
        dropKey(item, 'Slot');
        setKey(eq, f.slot === -106 ? 'offhand' : ARMOR[f.slot], item, 10);
      }
      if (Object.keys(eq).length) setKey(data, 'equipment', eq, 10);
      else dropKey(data, 'equipment');
    }
  }
  if (ender) setKey(data, 'EnderItems', nbt.list(rebuild(ender, 'ender', originals, fmt).map((b) => b.item), 'compound'), 9);

  const out = nbt.writeGzip(data);
  nbt.read(out); // never rename an unreadable file into place
  const file = containedPath(server.dir, rel);
  const keep = containedPath(server.dir, `.gamepanel/player-rollbacks/${uuid}-${new Date().toISOString().replace(/[:.]/g, '-')}.dat`);
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.copyFileSync(file, keep);
  // A temp name nobody can have planted a link at (exclusive create), then an atomic rename over the file.
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, out, { flag: 'wx' });
  fs.renameSync(tmp, file);
  manager.logActivity?.(server.id, { type: 'inventory', name, by: actor, text: 'edited by hand' });
  store.addEvent('player.edited', `${actor} edited ${name}'s inventory on ${server.name}`, { serverId: server.id });
  return view(manager, server, name);
}

module.exports = { view, save, formatOf, editorView, applyFields, newItem, cleanEntry };
