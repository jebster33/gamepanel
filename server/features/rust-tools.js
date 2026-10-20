'use strict';

/**
 * Rust extras on top of the plugins people usually run:
 *
 *   - loot multiplier presets for BetterLoot (1x, 2x, 3x, 5x or a number you pick)
 *   - stack size presets for StackSizeController (2x, 5x, 10x or per category)
 *   - day and night length (Rust's env.daylength / env.nightlength, in minutes)
 *
 * The plugins keep their settings in oxide/config/<Plugin>.json. The panel
 * never replaces that file: it reads it, changes only the multiplier numbers
 * and writes it back, so every other setting the owner made stays. A plugin
 * writes its config the first time it runs, so the server has to have started
 * once with the plugin installed before a preset can be applied.
 */

const fs = require('fs');
const { fail } = require('../core/util');
const { containedPath } = require('./files');
const { downloadTo } = require('./mods/http');

const PLUGINS = {
  loot: { name: 'BetterLoot', url: 'https://umod.org/plugins/BetterLoot.cs' },
  stack: { name: 'StackSizeController', url: 'https://umod.org/plugins/StackSizeController.cs' },
};

const LOOT_PRESETS = { '1x': 1, '2x': 2, '3x': 3, '5x': 5 };
const STACK_PRESETS = { '1x': 1, '2x': 2, '5x': 5, '10x': 10 };
const STACK_CATEGORIES = ['Ammunition', 'Attire', 'Component', 'Construction', 'Electrical', 'Food', 'Fun', 'Items', 'Medical', 'Misc', 'Resources', 'Tool', 'Traps', 'Weapon'];
const TIME_PRESETS = {
  default: { label: 'Rust default', day: null, night: null },
  long: { label: 'Long days, short nights', day: 60, night: 5 },
  short: { label: 'Quick days (20 / 10)', day: 20, night: 10 },
  bright: { label: 'Almost always day', day: 90, night: 2 },
  dark: { label: 'Long nights', day: 20, night: 30 },
};

/** The lengths the Rust template offers (templates/rust.json DAY_LENGTH and NIGHT_LENGTH). */
const TIME_VALUES = [2, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120, 180];

const num = (value, min, max, label) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `${label} must be a number from ${min} to ${max}`);
  return Math.round(n * 100) / 100;
};

/* ------------------------------------------------------- config merging -- */

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Set every number in an object (any depth) to `value`; returns the paths changed. */
function setAll(obj, value, trail, changed) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number') {
      obj[k] = value;
      changed.push([...trail, k].join('.'));
    } else if (isObj(v)) setAll(v, value, [...trail, k], changed);
  }
}

/** BetterLoot: the numbers under "Loot Multipliers", or anywhere a key says "multiplier". */
function applyLoot(config, multiplier) {
  const changed = [];
  const walk = (obj, trail) => {
    for (const [k, v] of Object.entries(obj)) {
      if (isObj(v) && /loot\s*multipliers?/i.test(k)) setAll(v, multiplier, [...trail, k], changed);
      else if (isObj(v)) walk(v, [...trail, k]);
      else if (typeof v === 'number' && /multiplier/i.test(k)) {
        obj[k] = multiplier;
        changed.push([...trail, k].join('.'));
      }
    }
  };
  walk(config, []);
  if (!changed.length) fail(409, 'BetterLoot\'s config has no loot multiplier settings the panel recognises. Open its file in Configs and set them by hand.');
  return changed;
}

const squash = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

/**
 * StackSizeController: the numbers under a "categories" object take `categories`
 * (name -> multiplier) and fall back to `all`; a number named "global" takes `all`.
 */
function applyStack(config, { all, categories = {} }) {
  const changed = [];
  const byName = new Map(Object.entries(categories).map(([k, v]) => [squash(k), v]));
  const walk = (obj, trail) => {
    for (const [k, v] of Object.entries(obj)) {
      if (isObj(v) && /categor/i.test(k)) {
        for (const [name, current] of Object.entries(v)) {
          if (typeof current !== 'number') continue;
          const next = byName.get(squash(name)) ?? all;
          if (next == null) continue;
          v[name] = next;
          changed.push([...trail, k, name].join('.'));
        }
      } else if (isObj(v)) walk(v, [...trail, k]);
      else if (typeof v === 'number' && /global/i.test(k) && all != null) {
        obj[k] = all;
        changed.push([...trail, k].join('.'));
      }
    }
  };
  walk(config, []);
  if (!changed.length) fail(409, 'StackSizeController\'s config has no stack multiplier settings the panel recognises. Open its file in Configs and set them by hand.');
  return changed;
}

/* ----------------------------------------------------------- plugin files -- */

const pluginFile = (key) => `oxide/plugins/${PLUGINS[key].name}.cs`;
const configFile = (key) => `oxide/config/${PLUGINS[key].name}.json`;
const oxideOn = (manager, server) => String(manager.vars(server).INSTALL_OXIDE) === 'true';
const exists = (server, rel) => {
  try {
    return fs.existsSync(containedPath(server.dir, rel));
  } catch {
    return false;
  }
};

function readConfig(server, key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(containedPath(server.dir, configFile(key)), 'utf8').replace(/^﻿/, ''));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Fetch the plugin from uMod into oxide/plugins unless it is there already. */
async function installPlugin(manager, server, key) {
  if (!PLUGINS[key]) fail(400, 'Unknown plugin');
  if (!oxideOn(manager, server)) fail(400, 'This needs uMod/Oxide. Turn on "Install uMod/Oxide" for this server and update it first.');
  if (exists(server, pluginFile(key))) return 'already installed';
  await downloadTo(PLUGINS[key].url, containedPath(server.dir, pluginFile(key)));
  return 'installed';
}

const saved = (server) => (server.rustTools = server.rustTools || {});

async function reload(manager, server, key) {
  if (!manager.isActive(server.id)) return false;
  try {
    await manager.sendCommand(server.id, `oxide.reload ${PLUGINS[key].name}`);
    return true;
  } catch {
    return false;
  }
}

async function applyPreset(manager, server, key, spec) {
  const file = containedPath(server.dir, configFile(key));
  const config = readConfig(server, key);
  if (!config) {
    fail(409, `${PLUGINS[key].name} has not made its config yet. Install it, start the server once, then apply the preset.`);
  }
  const changed = key === 'loot' ? applyLoot(config, spec.multiplier) : applyStack(config, spec);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  saved(server)[key] = { ...spec.record, at: Date.now() };
  manager.store.save();
  const reloaded = await reload(manager, server, key);
  return { changed: changed.length, reloaded, restartNeeded: key === 'stack' };
}

/** `preset` is one of 1x/2x/3x/5x, or "custom" with `multiplier`. */
function lootSpec(body = {}) {
  const preset = String(body.preset || 'custom');
  const multiplier = LOOT_PRESETS[preset] ?? num(body.multiplier, 0.1, 100, 'The loot multiplier');
  return { multiplier, record: { preset: LOOT_PRESETS[preset] ? preset : 'custom', multiplier } };
}

/** `preset` is 1x/2x/5x/10x, or "custom" with `all` and/or `categories`. */
function stackSpec(body = {}) {
  const preset = String(body.preset || 'custom');
  let all = STACK_PRESETS[preset] ?? null;
  const categories = {};
  if (all == null) {
    if (body.all != null && body.all !== '') all = num(body.all, 1, 1000, 'The stack multiplier');
    for (const [name, value] of Object.entries(isObj(body.categories) ? body.categories : {})) {
      if (value === '' || value == null) continue;
      if (!STACK_CATEGORIES.includes(name)) fail(400, `Unknown item category: ${String(name).slice(0, 30)}`);
      categories[name] = num(value, 1, 1000, `The ${name} multiplier`);
    }
    if (all == null && !Object.keys(categories).length) fail(400, 'Pick a preset or give at least one multiplier');
  }
  return { all, categories, record: { preset: STACK_PRESETS[preset] ? preset : 'custom', all, categories } };
}

/* -------------------------------------------------------------- day/night -- */

async function setTime(manager, server, body = {}) {
  const preset = TIME_PRESETS[body.preset];
  const clear = (v) => v === '' || v == null;
  const length = (v, label) => {
    const n = Number(v);
    if (!TIME_VALUES.includes(n)) fail(400, `${label} must be one of: ${TIME_VALUES.join(', ')} minutes`);
    return n;
  };
  const day = preset ? preset.day : clear(body.day) ? null : length(body.day, 'The day length');
  const night = preset ? preset.night : clear(body.night) ? null : length(body.night, 'The night length');
  server.vars = { ...(server.vars || {}), DAY_LENGTH: day == null ? '' : String(day), NIGHT_LENGTH: night == null ? '' : String(night) };
  manager.store.save();
  let live = false;
  if (manager.isActive(server.id)) {
    try {
      // Only numbers reach the console, never the request text.
      if (day != null) await manager.sendCommand(server.id, `env.daylength ${day}`);
      if (night != null) await manager.sendCommand(server.id, `env.nightlength ${night}`);
      live = day != null || night != null;
    } catch {
      live = false;
    }
  }
  return { day, night, live, restartNeeded: manager.isActive(server.id) && !live && (day != null || night != null) };
}

/* ------------------------------------------------------------------ view -- */

function view(manager, server) {
  const vars = manager.vars(server);
  const mine = server.rustTools || {};
  const status = (key) => ({
    plugin: PLUGINS[key].name,
    installed: exists(server, pluginFile(key)),
    configReady: Boolean(readConfig(server, key)),
    current: mine[key] || null,
  });
  return {
    oxide: oxideOn(manager, server),
    running: manager.isActive(server.id),
    loot: { ...status('loot'), presets: Object.keys(LOOT_PRESETS) },
    stack: { ...status('stack'), presets: Object.keys(STACK_PRESETS), categories: STACK_CATEGORIES },
    time: {
      day: vars.DAY_LENGTH === '' || vars.DAY_LENGTH == null ? null : Number(vars.DAY_LENGTH),
      night: vars.NIGHT_LENGTH === '' || vars.NIGHT_LENGTH == null ? null : Number(vars.NIGHT_LENGTH),
      values: TIME_VALUES,
      presets: Object.entries(TIME_PRESETS).map(([id, p]) => ({ id, ...p })),
    },
  };
}

module.exports = { TIME_VALUES, PLUGINS, LOOT_PRESETS, STACK_PRESETS, STACK_CATEGORIES, TIME_PRESETS, applyLoot, applyStack, lootSpec, stackSpec, applyPreset, installPlugin, setTime, view, readConfig };