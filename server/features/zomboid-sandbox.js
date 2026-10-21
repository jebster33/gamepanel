'use strict';

/**
 * Project Zomboid sandbox options (<servername>_SandboxVars.lua) as a form.
 *
 * The file is a Lua table:
 *
 *   SandboxVars = {
 *       VERSION = 5,
 *       Zombies = 4,
 *       ZombieLore = { Speed = 2, Strength = 2 },
 *   }
 *
 * It is never run. A small reader understands only table constructors with
 * numbers, strings, true/false and nested tables (and Lua comments); anything
 * else (a function call, an operator) makes the whole file "not understood"
 * and it is left alone. Saving replaces just the changed values inside the
 * original text, so comments, order and layout stay as they were.
 */

const fs = require('fs');
const crypto = require('crypto');
const { fail } = require('../core/util');
const { containedPath } = require('./files');

const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
const MAX_VALUES = 3000;
const DIR = 'Zomboid/Server';
const FILE_RE = /^[A-Za-z0-9_.-]{1,64}_SandboxVars\.lua$/;

/* ----------------------------------------------------------------- reader -- */

class LuaError extends Error {}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      const long = /^--\[(=*)\[/.exec(text.slice(i, i + 40));
      if (long) {
        const end = text.indexOf(`]${long[1]}]`, i);
        if (end === -1) throw new LuaError('A comment is never closed');
        i = end + long[1].length + 2;
      } else {
        const end = text.indexOf('\n', i);
        i = end === -1 ? n : end;
      }
      continue;
    }
    if ('{}=,;[]'.includes(c)) {
      tokens.push({ t: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < n && text[j] !== c) {
        if (text[j] === '\n') throw new LuaError('A string is not closed');
        if (text[j] === '\\') {
          const next = text[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
          if (!(next in map)) throw new LuaError('A string uses an escape the panel does not read');
          value += map[next];
          j += 2;
        } else value += text[j++];
      }
      if (j >= n) throw new LuaError('A string is not closed');
      tokens.push({ t: 'string', value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    const num = /^-?(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 40));
    if (num) {
      tokens.push({ t: 'number', value: Number(num[0]), raw: num[0], start: i, end: i + num[0].length });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 80));
    if (word) {
      tokens.push({ t: 'name', value: word[0], start: i, end: i + word[0].length });
      i += word[0].length;
      continue;
    }
    throw new LuaError(`Unexpected "${c}" (only plain tables of numbers, text and true/false are understood)`);
  }
  return tokens;
}

/**
 * Read `Name = { ... }`. Returns { name, values } where values is a flat list
 * of { path: string[], type: 'bool'|'number'|'string', value, start, end }
 * (start/end are the value's offsets in the text).
 */
function parse(text) {
  if (text.length > MAX_BYTES) throw new LuaError('The file is too big');
  const tokens = tokenize(text);
  let p = 0;
  const values = [];
  const peek = () => tokens[p];
  const take = (type) => {
    const tok = tokens[p];
    if (!tok || (type && tok.t !== type)) throw new LuaError(type ? `Expected ${type}` : 'The file ended early');
    p++;
    return tok;
  };

  function value(pathSoFar, depth) {
    const tok = peek();
    if (!tok) throw new LuaError('The file ended early');
    if (tok.t === '{') return table(pathSoFar, depth + 1);
    if (tok.t === 'number') {
      take();
      if (pathSoFar.length) values.push({ path: pathSoFar, type: 'number', value: tok.value, raw: tok.raw, start: tok.start, end: tok.end });
      return undefined;
    }
    if (tok.t === 'string') {
      take();
      if (pathSoFar.length) values.push({ path: pathSoFar, type: 'string', value: tok.value, start: tok.start, end: tok.end });
      return undefined;
    }
    if (tok.t === 'name' && (tok.value === 'true' || tok.value === 'false')) {
      take();
      if (pathSoFar.length) values.push({ path: pathSoFar, type: 'bool', value: tok.value === 'true', start: tok.start, end: tok.end });
      return undefined;
    }
    if (tok.t === 'name' && tok.value === 'nil') {
      take();
      return undefined;
    }
    throw new LuaError('A value that is not a number, text, true/false or table was found');
  }

  function table(pathSoFar, depth) {
    if (depth > MAX_DEPTH) throw new LuaError('Tables are nested too deeply');
    take('{');
    let positional = 0;
    for (;;) {
      const tok = peek();
      if (!tok) throw new LuaError('A table is never closed');
      if (tok.t === '}') {
        take();
        return undefined;
      }
      if (tok.t === ',' || tok.t === ';') {
        take();
        continue;
      }
      if (values.length > MAX_VALUES) throw new LuaError('The file has too many values');
      let key = null;
      if (tok.t === 'name' && tokens[p + 1]?.t === '=') {
        key = tok.value;
        p += 2;
      } else if (tok.t === '[' && (tokens[p + 1]?.t === 'string' || tokens[p + 1]?.t === 'number') && tokens[p + 2]?.t === ']' && tokens[p + 3]?.t === '=') {
        key = String(tokens[p + 1].value);
        p += 4;
      }
      if (key === null) {
        // A list entry: read it (so the file still parses) but it is not a field.
        positional++;
        value([], depth);
      } else {
        if (/^(__proto__|constructor|prototype)$/.test(key)) throw new LuaError('That key name is not allowed');
        value([...pathSoFar, key], depth);
      }
    }
  }

  const head = take('name');
  take('=');
  if (peek()?.t !== '{') throw new LuaError('Expected a table');
  table([], 0);
  if (p < tokens.length) throw new LuaError('There is more in the file than the sandbox table');
  return { name: head.value, values };
}

/* ----------------------------------------------------------------- writer -- */

const luaString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;

function luaValue(field, value) {
  if (field.type === 'bool') return value ? 'true' : 'false';
  if (field.type === 'number') return Number.isInteger(value) && /[.eE]/.test(field.raw || '') ? value.toFixed(1) : String(value);
  return luaString(value);
}

/** Put `changes` ({ "A.B": value }) into the text. Returns the new text. */
function applyChanges(text, parsed, changes) {
  const edits = [];
  for (const [dotted, value] of Object.entries(changes)) {
    const field = parsed.values.find((v) => v.path.join('.') === dotted);
    if (!field) fail(400, `${dotted} is not in this file`);
    edits.push({ start: field.start, end: field.end, text: luaValue(field, value) });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/* ----------------------------------------------------------------- schema -- */

const range = (from, labels) => labels.map((label, i) => [from + i, label]);
const SPEED = range(1, ['Very fast', 'Fast', 'Normal', 'Slow', 'Very slow']);
const LOOT = range(1, ['Extremely rare', 'Rare', 'Normal', 'Common', 'Abundant']);
const FREQ = range(1, ['Never', 'Extremely rare', 'Rare', 'Sometimes', 'Often', 'Very often']);

/** The options people change most, with plain labels. Everything else in the file still shows up, untyped by name. */
const SCHEMA = [
  { path: 'Zombies', group: 'Zombies', label: 'Zombie population', type: 'enum', options: range(1, ['Insane', 'Very high', 'High', 'Normal', 'Low', 'None']) },
  { path: 'Distribution', group: 'Zombies', label: 'Where zombies spawn', type: 'enum', options: [[1, 'Urban focused'], [2, 'Uniform']] },
  { path: 'ZombieLore.Speed', group: 'Zombies', label: 'Zombie speed', type: 'enum', options: [[1, 'Sprinters'], [2, 'Fast shamblers'], [3, 'Shamblers'], [4, 'Random']] },
  { path: 'ZombieLore.Strength', group: 'Zombies', label: 'Zombie strength', type: 'enum', options: [[1, 'Superhuman'], [2, 'Normal'], [3, 'Weak'], [4, 'Random']] },
  { path: 'ZombieLore.Toughness', group: 'Zombies', label: 'Zombie toughness', type: 'enum', options: [[1, 'Tough'], [2, 'Normal'], [3, 'Fragile'], [4, 'Random']] },
  { path: 'ZombieLore.Transmission', group: 'Zombies', label: 'How the infection spreads', type: 'enum', options: [[1, 'Blood and saliva'], [2, 'Saliva only'], [3, 'Everyone is infected'], [4, 'None']] },
  { path: 'ZombieLore.Mortality', group: 'Zombies', label: 'Time to die once infected', type: 'enum', options: [[1, 'Instant'], [2, '0 to 30 seconds'], [3, '0 to 1 minute'], [4, '0 to 12 hours'], [5, '2 to 3 days'], [6, '1 to 2 weeks'], [7, 'Never']] },
  { path: 'ZombieLore.Cognition', group: 'Zombies', label: 'Zombie intelligence', type: 'enum', options: [[1, 'Navigate and use doors'], [2, 'Navigate'], [3, 'Basic navigation'], [4, 'Random']] },
  { path: 'ZombieLore.Memory', group: 'Zombies', label: 'Zombie memory', type: 'enum', options: [[1, 'Long'], [2, 'Normal'], [3, 'Short'], [4, 'None'], [5, 'Random']] },
  { path: 'ZombieLore.Sight', group: 'Zombies', label: 'Zombie sight', type: 'enum', options: [[1, 'Eagle'], [2, 'Normal'], [3, 'Poor'], [4, 'Random']] },
  { path: 'ZombieLore.Hearing', group: 'Zombies', label: 'Zombie hearing', type: 'enum', options: [[1, 'Pinpoint'], [2, 'Normal'], [3, 'Poor'], [4, 'Random']] },
  { path: 'ZombieConfig.PopulationMultiplier', group: 'Zombies', label: 'Population multiplier', type: 'float', min: 0, max: 4, help: 'Fine control on top of the population setting. 1.0 is the normal amount.' },
  { path: 'ZombieConfig.RespawnHours', group: 'Zombies', label: 'Respawn after (hours)', type: 'float', min: 0, help: '0 turns zombie respawning off.' },

  { path: 'DayLength', group: 'World and time', label: 'Day length', type: 'enum', options: [[1, '15 minutes'], [2, '30 minutes'], [3, '1 hour'], [4, '2 hours'], [5, '3 hours'], [6, '4 hours'], [7, '5 hours'], [8, '6 hours']], help: 'Real time one in-game day takes. Larger values exist; the form shows what it knows.' },
  { path: 'StartMonth', group: 'World and time', label: 'Start month', type: 'int', min: 1, max: 12 },
  { path: 'StartDay', group: 'World and time', label: 'Start day', type: 'int', min: 1, max: 31 },
  { path: 'StartTime', group: 'World and time', label: 'Start time of day', type: 'enum', options: range(1, ['7 AM', '9 AM', '12 PM', '2 PM', '5 PM', '9 PM', '12 AM', '2 AM', '5 AM']) },
  { path: 'Temperature', group: 'World and time', label: 'Temperature', type: 'enum', options: range(1, ['Very cold', 'Cold', 'Normal', 'Hot']) },
  { path: 'Rain', group: 'World and time', label: 'Rain', type: 'enum', options: range(1, ['Very dry', 'Dry', 'Normal', 'Rainy', 'Very rainy']) },
  { path: 'ErosionSpeed', group: 'World and time', label: 'Nature takes over', type: 'enum', options: range(1, ['Very fast (20 days)', 'Fast (50 days)', 'Normal (100 days)', 'Slow (200 days)', 'Very slow (500 days)']) },
  { path: 'WaterShutModifier', group: 'World and time', label: 'Water shuts off (days)', type: 'int', min: -1, help: 'Days after the outbreak when water stops. -1 means it never does.' },
  { path: 'ElecShutModifier', group: 'World and time', label: 'Power shuts off (days)', type: 'int', min: -1, help: 'Days after the outbreak when power stops. -1 means it never does.' },

  { path: 'FoodLoot', group: 'Loot', label: 'Food', type: 'enum', options: LOOT },
  { path: 'CannedFoodLoot', group: 'Loot', label: 'Canned food', type: 'enum', options: LOOT },
  { path: 'WeaponLoot', group: 'Loot', label: 'Weapons', type: 'enum', options: LOOT },
  { path: 'RangedWeaponLoot', group: 'Loot', label: 'Guns', type: 'enum', options: LOOT },
  { path: 'AmmoLoot', group: 'Loot', label: 'Ammo', type: 'enum', options: LOOT },
  { path: 'MedicalLoot', group: 'Loot', label: 'Medical supplies', type: 'enum', options: LOOT },
  { path: 'OtherLoot', group: 'Loot', label: 'Everything else', type: 'enum', options: LOOT },
  { path: 'LiteratureLoot', group: 'Loot', label: 'Books and magazines', type: 'enum', options: LOOT },
  { path: 'ClothingLoot', group: 'Loot', label: 'Clothes', type: 'enum', options: LOOT },
  { path: 'LootRespawn', group: 'Loot', label: 'Loot respawn', type: 'enum', options: [[1, 'None'], [2, 'Every day'], [3, 'Every week'], [4, 'Every month'], [5, 'Every two months']] },
  { path: 'Alarm', group: 'Loot', label: 'House alarms', type: 'enum', options: FREQ },
  { path: 'LockedHouses', group: 'Loot', label: 'Locked houses', type: 'enum', options: FREQ },

  { path: 'XpMultiplier', group: 'Character', label: 'Experience multiplier', type: 'float', min: 0, max: 100 },
  { path: 'StarterKit', group: 'Character', label: 'Start with a starter kit', type: 'bool' },
  { path: 'Nutrition', group: 'Character', label: 'Weight and nutrition', type: 'bool', help: 'Turn off to stop weight gain and loss.' },
  { path: 'StatsDecrease', group: 'Character', label: 'Hunger and thirst speed', type: 'enum', options: range(1, ['Very fast', 'Fast', 'Normal', 'Slow', 'Very slow']) },
  { path: 'EndRegen', group: 'Character', label: 'Endurance recovery', type: 'enum', options: range(1, ['Very fast', 'Fast', 'Normal', 'Slow', 'Very slow']) },
  { path: 'FoodRotSpeed', group: 'Character', label: 'Food spoils', type: 'enum', options: SPEED },
  { path: 'FridgeFactor', group: 'Character', label: 'Fridge keeps food', type: 'enum', options: range(1, ['Very low', 'Low', 'Normal', 'High', 'Very high']) },
  { path: 'NatureAbundance', group: 'Character', label: 'Foraging', type: 'enum', options: range(1, ['Very poor', 'Poor', 'Normal', 'Abundant', 'Very abundant']) },

  { path: 'Helicopter', group: 'Events and vehicles', label: 'Helicopter event', type: 'enum', options: [[1, 'Never'], [2, 'Once'], [3, 'Sometimes'], [4, 'Often']] },
  { path: 'MetaEvent', group: 'Events and vehicles', label: 'Zombie noise events', type: 'enum', options: [[1, 'Never'], [2, 'Sometimes'], [3, 'Often']] },
  { path: 'SleepingEvent', group: 'Events and vehicles', label: 'Night attacks while sleeping', type: 'enum', options: [[1, 'Never'], [2, 'Sometimes'], [3, 'Often']] },
  { path: 'EnableVehicles', group: 'Events and vehicles', label: 'Vehicles', type: 'bool' },
  { path: 'CarSpawnRate', group: 'Events and vehicles', label: 'Car spawn rate', type: 'enum', options: [[1, 'None'], [2, 'Low'], [3, 'Normal'], [4, 'High']] },
  { path: 'GeneratorSpawning', group: 'Events and vehicles', label: 'Generator spawn rate', type: 'enum', options: [[1, 'Extremely rare'], [2, 'Rare'], [3, 'Uncommon'], [4, 'Common'], [5, 'Abundant']] },
  { path: 'AllowExteriorGenerator', group: 'Events and vehicles', label: 'Generators work outdoors', type: 'bool' },
];

const BY_PATH = new Map(SCHEMA.map((s) => [s.path.toLowerCase(), s]));

/**
 * Starting points built from the game's own difficulty names. They set
 * zombies, loot and the long-term clock the way those presets feel; they are
 * the panel's approximation, not a copy of the game's preset files.
 */
const PRESETS = [
  {
    id: 'builder',
    name: 'Builder',
    description: 'Few zombies and plenty of loot, for building a base in peace.',
    values: { Zombies: 5, 'ZombieLore.Speed': 3, 'ZombieLore.Strength': 3, 'ZombieLore.Toughness': 3, 'ZombieLore.Transmission': 2, FoodLoot: 5, CannedFoodLoot: 5, WeaponLoot: 4, OtherLoot: 5, MedicalLoot: 4, XpMultiplier: 2 },
  },
  {
    id: 'beginner',
    name: 'Beginner',
    description: 'Slow, weak zombies and kinder loot while you learn the game.',
    values: { Zombies: 5, 'ZombieLore.Speed': 3, 'ZombieLore.Strength': 3, 'ZombieLore.Toughness': 3, 'ZombieLore.Transmission': 4, 'ZombieLore.Mortality': 7, FoodLoot: 4, CannedFoodLoot: 4, WeaponLoot: 4, OtherLoot: 4, XpMultiplier: 1.5 },
  },
  {
    id: 'survivor',
    name: 'Survivor',
    description: 'The normal game: normal zombies, normal loot.',
    values: { Zombies: 4, 'ZombieLore.Speed': 2, 'ZombieLore.Strength': 2, 'ZombieLore.Toughness': 2, 'ZombieLore.Transmission': 1, 'ZombieLore.Mortality': 5, FoodLoot: 3, CannedFoodLoot: 3, WeaponLoot: 3, OtherLoot: 3, MedicalLoot: 3, XpMultiplier: 1 },
  },
  {
    id: 'apocalypse',
    name: 'Apocalypse',
    description: 'Many fast, strong zombies and scarce loot.',
    values: { Zombies: 2, 'ZombieLore.Speed': 2, 'ZombieLore.Strength': 1, 'ZombieLore.Toughness': 1, 'ZombieLore.Transmission': 1, 'ZombieLore.Mortality': 2, 'ZombieLore.Sight': 1, 'ZombieLore.Hearing': 1, FoodLoot: 2, CannedFoodLoot: 2, WeaponLoot: 2, OtherLoot: 2, MedicalLoot: 2, XpMultiplier: 1 },
  },
];

/* ------------------------------------------------------------------- files -- */

const versionOf = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

function listFiles(server) {
  try {
    return fs
      .readdirSync(containedPath(server.dir, DIR), { withFileTypes: true })
      .filter((e) => e.isFile() && FILE_RE.test(e.name))
      .map((e) => `${DIR}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

/** Only a sandbox file in the server folder is ever read or written. */
function fileOf(server, rel) {
  const name = String(rel || '').split('/').pop();
  if (rel !== `${DIR}/${name}` || !FILE_RE.test(name)) fail(400, 'That is not a sandbox options file');
  return { rel, file: containedPath(server.dir, rel) };
}

function fieldOf(v) {
  const dotted = v.path.join('.');
  const schema = BY_PATH.get(dotted.toLowerCase());
  const type = schema?.type || (v.type === 'bool' ? 'bool' : v.type === 'string' ? 'string' : /[.eE]/.test(v.raw || '') ? 'float' : 'int');
  return {
    path: dotted,
    label: schema?.label || v.path[v.path.length - 1].replace(/([a-z])([A-Z])/g, '$1 $2'),
    group: schema?.group || 'Other options',
    type,
    value: v.value,
    help: schema?.help,
    options: schema?.options?.map(([value, label]) => ({ value, label })),
    min: schema?.min,
    max: schema?.max,
    known: Boolean(schema),
  };
}

/** The file as a form. */
function form(server, rel) {
  const { file } = fileOf(server, rel);
  let text;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) fail(413, 'This file is too big for the form');
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') fail(404, 'That file does not exist yet. Start the server once so it creates it.');
    throw err;
  }
  let parsed;
  try {
    parsed = parse(text);
  } catch (err) {
    if (!(err instanceof LuaError)) throw err;
    return { path: rel, version: versionOf(text), fields: [], presets: [], error: `The panel could not read this file safely: ${err.message}. Edit it on the Files tab instead.` };
  }
  const fields = parsed.values.filter((v) => v.path.join('.').toUpperCase() !== 'VERSION').map(fieldOf);
  const known = new Set(fields.map((f) => f.path.toLowerCase()));
  return {
    path: rel,
    version: versionOf(text),
    fields,
    // A preset only offers the options this file has (a different game version names some differently).
    presets: PRESETS.map((p) => ({ ...p, values: Object.fromEntries(Object.entries(p.values).filter(([k]) => known.has(k.toLowerCase()))) })),
  };
}

/** Check one change against the field's type, and return the value to write. */
function checkValue(field, value) {
  if (field.type === 'bool') {
    if (typeof value !== 'boolean') fail(400, `${field.label} must be on or off`);
    return value;
  }
  if (field.type === 'string') {
    const text = String(value ?? '');
    if (text.length > 500 || /[\u0000-\u001f]/.test(text)) fail(400, `${field.label} is not valid text`);
    return text;
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (value === '' || value === null || !Number.isFinite(num) || Math.abs(num) > 1e9) fail(400, `${field.label} must be a number`);
  if (field.type !== 'float' && !Number.isInteger(num)) fail(400, `${field.label} must be a whole number`);
  if (field.options && !field.options.some((o) => o.value === num)) fail(400, `${field.label} is not one of the allowed choices`);
  if (field.min !== undefined && num < field.min) fail(400, `${field.label} cannot be below ${field.min}`);
  if (field.max !== undefined && num > field.max) fail(400, `${field.label} cannot be above ${field.max}`);
  return num;
}

/**
 * Save changed values. `version` is what the form was read from: when the
 * file changed since, nothing is written. Returns { path, before, after }.
 */
function save(server, rel, { version, changes }) {
  const { file } = fileOf(server, rel);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) fail(400, 'Nothing to save');
  if (Object.keys(changes).length > 500) fail(400, 'Too many changes at once');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fail(404, 'That file does not exist yet');
  }
  if (version && version !== versionOf(text)) fail(409, 'The file changed since you opened it. Reload and try again.');
  let parsed;
  try {
    parsed = parse(text);
  } catch (err) {
    if (err instanceof LuaError) fail(400, `The panel could not read this file safely: ${err.message}`);
    throw err;
  }
  const byPath = new Map(parsed.values.map((v) => [v.path.join('.').toLowerCase(), fieldOf(v)]));
  const clean = {};
  for (const [path, value] of Object.entries(changes)) {
    const field = byPath.get(String(path).toLowerCase());
    if (!field || field.path.toUpperCase() === 'VERSION') fail(400, `${path} is not an option in this file`);
    clean[field.path] = checkValue(field, value);
  }
  const after = applyChanges(text, parsed, clean);
  // The result must still be a file the reader accepts, with exactly the new values.
  try {
    const again = parse(after);
    for (const [path, value] of Object.entries(clean)) {
      if (again.values.find((v) => v.path.join('.') === path)?.value !== value) throw new LuaError('a value did not stay as written');
    }
  } catch (err) {
    fail(500, `The edited file would not be valid (${err.message}); nothing was written`);
  }
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, after, { flag: 'wx' });
  fs.renameSync(tmp, file);
  return { path: rel, before: text, after, version: versionOf(after) };
}

module.exports = { parse, applyChanges, listFiles, form, save, checkValue, SCHEMA, PRESETS, LuaError, FILE_RE, DIR };
