'use strict';

/**
 * The ARK give-item tool: a searchable catalog of items and the console command
 * that hands one to an online player.
 *
 * The catalog (ark-data/items.json, about 2000 items) comes from Project
 * Purlovia's data for ARK: Survival Evolved. Ascended keeps most of the same
 * blueprint paths; anything it lacks can be given with a custom blueprint path.
 *
 * The command is built from checked fields only: the blueprint comes from the
 * catalog (or a strictly shaped /Game/... path), numbers are numbers, and the
 * player must be online. Nothing a user types is pasted into the command.
 */

const { fail } = require('../core/util');

let cache = null;
function catalog() {
  if (cache) return cache;
  const raw = require('./ark-data/items.json');
  const items = raw.items.map(([name, path, cat, map]) => {
    const asset = path.slice(path.lastIndexOf('/') + 1);
    return { name, path, asset, cls: `${asset}_C`, category: raw.categories[cat], map: raw.maps[map], lower: name.toLowerCase(), pathLower: path.toLowerCase() };
  });
  cache = { items, byPath: new Map(items.map((i) => [i.path, i])), categories: raw.categories, source: raw.source };
  return cache;
}

const view = (i) => ({ name: i.name, path: i.path, cls: i.cls, category: i.category, map: i.map });

/** Items whose name (or blueprint) contains every word of the query, name matches first. */
function search({ query = '', category = '', limit = 50 } = {}) {
  const { items, categories } = catalog();
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const cap = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
  const scored = [];
  for (const i of items) {
    if (category && i.category !== category) continue;
    if (!words.every((w) => i.lower.includes(w) || i.pathLower.includes(w))) continue;
    const rank = !words.length ? 2 : i.lower === words.join(' ') ? 0 : i.lower.startsWith(words[0]) ? 1 : words.every((w) => i.lower.includes(w)) ? 2 : 3;
    scored.push([rank, i]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return { total: scored.length, items: scored.slice(0, cap).map(([, i]) => view(i)), categories };
}

/** ARK's quality ratings, as the number GiveItemToPlayer takes. "Ascended" is what players call Ascendant. */
const QUALITY_TIERS = [
  { id: 'primitive', label: 'Primitive', value: 0 },
  { id: 'ramshackle', label: 'Ramshackle', value: 1 },
  { id: 'apprentice', label: 'Apprentice', value: 2 },
  { id: 'journeyman', label: 'Journeyman', value: 3 },
  { id: 'mastercraft', label: 'Mastercraft', value: 4 },
  { id: 'ascendant', label: 'Ascendant (Ascended)', value: 5 },
];

const STYLES = {
  GiveItemToPlayer: { target: true, rcon: true },
  GiveItemNumToPlayer: { target: true, rcon: true, number: true },
  // These act on the admin's own character, so they only make sense typed into the game's console.
  giveitem: { target: false, rcon: false },
  GiveItemNum: { target: false, rcon: false, number: true },
};
const CUSTOM_PATH = /^\/Game\/[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+){0,12}$/;

function whole(label, v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
}

function qualityOf(input) {
  if (input.quality !== undefined && input.quality !== null && input.quality !== '') {
    const n = Number(input.quality);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) fail(400, 'Quality must be a number from 0 to 1,000,000');
    return Math.round(n * 100) / 100;
  }
  const tier = QUALITY_TIERS.find((t) => t.id === String(input.tier || 'primitive').toLowerCase().replace('ascended', 'ascendant'));
  if (!tier) fail(400, `Pick a quality tier (${QUALITY_TIERS.map((t) => t.label).join(', ')}) or type a number`);
  return tier.value;
}

/**
 * The command for these fields. `player` is the in-game player ID (a number);
 * the route has already checked the person is online.
 * Returns { command, send, style }.
 */
function build(input = {}) {
  const style = STYLES[input.style || 'GiveItemToPlayer'] ? input.style || 'GiveItemToPlayer' : fail(400, 'Unknown command style');
  const spec = STYLES[style];
  const quantity = whole('Quantity', input.quantity ?? 1, 1, 1000000);
  const quality = qualityOf(input);
  const blueprint = input.blueprint ? 1 : 0;
  const head = spec.target ? `${style} ${whole('Player ID', input.playerId, 1, 999999999999999)}` : style;
  let command;
  if (spec.number) {
    command = `${head} ${whole('Item number', input.itemNum, 0, 100000)} ${quantity} ${quality} ${blueprint}`;
  } else {
    let path = String(input.path || '');
    if (!catalog().byPath.has(path)) {
      if (!input.custom || !CUSTOM_PATH.test(path)) fail(400, 'Pick an item from the list, or turn on "custom blueprint path" and give a /Game/... path');
    }
    const asset = path.slice(path.lastIndexOf('/') + 1);
    command = `${head} "Blueprint'${path}.${asset}'" ${quantity} ${quality} ${blueprint}`;
  }
  return { command, send: spec.rcon, style, quality, quantity };
}

module.exports = { catalog, search, build, QUALITY_TIERS, STYLES };
