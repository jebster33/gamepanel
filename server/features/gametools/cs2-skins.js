'use strict';

/**
 * OPT-IN CS2 skin changer (WeaponPaints for CounterStrikeSharp).
 *
 * WARNING: Valve has banned Game Server Login Tokens (GSLT) of servers that use
 * skin changers. Nothing here is on by default and no preset turns it on; the
 * owner must accept the warning and uses it at their own risk.
 *
 * WeaponPaints keeps every player's choices in a MySQL/MariaDB database. Node
 * has no MySQL client without an npm dependency, so the panel:
 *   - keeps the picks itself (knife + gun skins, per SteamID64),
 *   - writes the plugin's config (database login, core.json switch),
 *   - generates the SQL for the picks, and
 *   - runs it through the `mysql` / `mariadb` command line client when one is installed
 *     (otherwise the SQL can be downloaded and run by hand).
 * The catalog comes from ByMykel/CSGO-API (skins.json) with a small bundled fallback.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { fail } = require('../../core/util');
const secrets = require('../../core/secrets');
const { config } = require('../../core/config');
const common = require('./common');
const cs2 = require('./cs2');

const CATALOG_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json';
const CACHE_MS = 7 * 24 * 3600 * 1000;
const MAX_CATALOG = 20 * 1024 * 1024;
const PLUGIN_CONFIG = 'game/csgo/addons/counterstrikesharp/configs/plugins/WeaponPaints/WeaponPaints.json';
const CORE_CONFIG = 'game/csgo/addons/counterstrikesharp/configs/core.json';

const WARNING =
  'Valve has banned server tokens (GSLT) of servers that use skin changers. If you turn this on, your server and its token can be banned. You use it entirely at your own risk.';

/** [defindex, weapon class, weapon name, paint index, skin name, rarity colour] */
const FALLBACK = [
  [7, 'weapon_ak47', 'AK-47', 282, 'Redline', '#d32ce6'],
  [7, 'weapon_ak47', 'AK-47', 302, 'Vulcan', '#d32ce6'],
  [7, 'weapon_ak47', 'AK-47', 44, 'Case Hardened', '#8847ff'],
  [7, 'weapon_ak47', 'AK-47', 801, 'Asiimov', '#d32ce6'],
  [9, 'weapon_awp', 'AWP', 344, 'Dragon Lore', '#eb4b4b'],
  [9, 'weapon_awp', 'AWP', 279, 'Asiimov', '#d32ce6'],
  [9, 'weapon_awp', 'AWP', 51, 'Lightning Strike', '#d32ce6'],
  [16, 'weapon_m4a1', 'M4A4', 309, 'Howl', '#eb4b4b'],
  [16, 'weapon_m4a1', 'M4A4', 255, 'Asiimov', '#d32ce6'],
  [60, 'weapon_m4a1_silencer', 'M4A1-S', 984, 'Printstream', '#d32ce6'],
  [1, 'weapon_deagle', 'Desert Eagle', 37, 'Blaze', '#d32ce6'],
  [1, 'weapon_deagle', 'Desert Eagle', 962, 'Printstream', '#d32ce6'],
  [61, 'weapon_usp_silencer', 'USP-S', 504, 'Kill Confirmed', '#eb4b4b'],
  [61, 'weapon_usp_silencer', 'USP-S', 653, 'Neo-Noir', '#d32ce6'],
  [4, 'weapon_glock', 'Glock-18', 38, 'Fade', '#d32ce6'],
  [4, 'weapon_glock', 'Glock-18', 353, 'Water Elemental', '#d32ce6'],
  [36, 'weapon_p250', 'P250', 551, 'Asiimov', '#d32ce6'],
  [500, 'weapon_bayonet', 'Bayonet', 415, 'Doppler', '#eb4b4b'],
  [500, 'weapon_bayonet', 'Bayonet', 38, 'Fade', '#eb4b4b'],
  [505, 'weapon_knife_flip', 'Flip Knife', 38, 'Fade', '#eb4b4b'],
  [507, 'weapon_knife_karambit', 'Karambit', 415, 'Doppler', '#eb4b4b'],
  [507, 'weapon_knife_karambit', 'Karambit', 38, 'Fade', '#eb4b4b'],
  [508, 'weapon_knife_m9_bayonet', 'M9 Bayonet', 12, 'Crimson Web', '#eb4b4b'],
  [508, 'weapon_knife_m9_bayonet', 'M9 Bayonet', 38, 'Fade', '#eb4b4b'],
  [515, 'weapon_knife_butterfly', 'Butterfly Knife', 38, 'Fade', '#eb4b4b'],
  [515, 'weapon_knife_butterfly', 'Butterfly Knife', 415, 'Doppler', '#eb4b4b'],
];

let cache = null; // { at, source, items }

/** Compact entries the UI can show: d defindex, w weapon class, wn weapon name, p paint, n skin, c colour, i image, k knife. */
function normalise(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const weapon = s?.weapon;
    const paint = Number(s?.paint_index);
    if (!weapon || typeof weapon.id !== 'string' || !weapon.id.startsWith('weapon_') || !Number.isInteger(weapon.weapon_id) || !Number.isInteger(paint) || paint <= 0) continue;
    if (!/^weapon_[a-z0-9_]+$/.test(weapon.id)) continue;
    if (/gloves/.test(s.category?.id || '')) continue;
    const img = String(s.image || '');
    out.push({
      d: weapon.weapon_id,
      w: weapon.id,
      wn: String(weapon.name || weapon.id).slice(0, 40),
      p: paint,
      n: String(s.pattern?.name || s.name || '').slice(0, 60) + (s.phase ? ` (${String(s.phase).slice(0, 20)})` : ''),
      c: /^#[0-9a-f]{6}$/i.test(s.rarity?.color || '') ? s.rarity.color : '#b0c3d9',
      i: /^https:\/\/community\.[a-z.]*steamstatic\.com\//.test(img) ? img : '',
      k: weapon.weapon_id >= 500 && weapon.weapon_id < 600,
    });
  }
  return out;
}

const fallbackItems = () => FALLBACK.map(([d, w, wn, p, n, c]) => ({ d, w, wn, p, n, c, i: '', k: d >= 500 }));

const cacheFile = () => path.join(config.cacheDir, 'cs2-skins.json');

async function download() {
  const res = await fetch(CATALOG_URL, { headers: { 'User-Agent': 'GamePanel/2' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_CATALOG) throw new Error('catalog too large');
  return normalise(JSON.parse(text));
}

/** The catalog: fresh download (cached a week), the last cached copy, or the bundled list. */
async function catalog({ refresh = false } = {}) {
  if (cache && !refresh && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const stat = fs.existsSync(cacheFile()) ? fs.statSync(cacheFile()) : null;
    if (!refresh && stat && Date.now() - stat.mtimeMs < CACHE_MS) {
      const items = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      if (Array.isArray(items) && items.length) return (cache = { at: Date.now(), source: 'ByMykel/CSGO-API (cached)', items });
    }
  } catch {
    /* fall through to a download */
  }
  try {
    const items = await download();
    if (!items.length) throw new Error('no skins in the file');
    try {
      fs.mkdirSync(config.cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile(), JSON.stringify(items));
    } catch {
      /* the cache is optional */
    }
    return (cache = { at: Date.now(), source: 'ByMykel/CSGO-API', items });
  } catch (err) {
    return { at: Date.now(), source: 'bundled fallback (could not download the full catalog)', items: fallbackItems(), error: err.message };
  }
}

/* ---------------------------------------------------------------- state -- */

const sc = (server) => {
  const s = cs2.state(server);
  if (!s.skinchanger || typeof s.skinchanger !== 'object') s.skinchanger = { enabled: false };
  if (!s.skinchanger.picks) s.skinchanger.picks = {};
  return s.skinchanger;
};

const STEAMID = /^7656119\d{10}$/;
const checkSteamId = (id) => {
  if (!STEAMID.test(String(id || ''))) fail(400, 'That is not a SteamID64 (17 digits starting with 7656119)');
  return String(id);
};

function view(server) {
  const s = sc(server);
  const db = s.db || {};
  return {
    warning: WARNING,
    enabled: Boolean(s.enabled),
    acknowledgedBy: s.acknowledgedBy || null,
    acknowledgedAt: s.acknowledgedAt || null,
    db: { host: db.host || '', port: db.port || 3306, user: db.user || '', name: db.name || '', hasPassword: Boolean(db.password) },
    picks: s.picks,
    lastSync: s.lastSync || null,
  };
}

/** Opt in. Needs an explicit acknowledgement of the GSLT ban risk; never done by a preset. */
function enable(store, server, input, actor) {
  const s = sc(server);
  if (input?.enabled === false) {
    s.enabled = false;
    store.save();
    return view(server);
  }
  if (input?.acknowledge !== true) fail(400, `You must accept the warning first: ${WARNING}`);
  s.enabled = true;
  s.acknowledgedBy = String(actor || 'admin');
  s.acknowledgedAt = Date.now();
  store.save();
  return view(server);
}

function setDb(store, server, input = {}) {
  const s = sc(server);
  const host = String(input.host || '').trim();
  const user = String(input.user || '').trim();
  const name = String(input.name || '').trim();
  const port = Number(input.port || 3306);
  if (!/^[A-Za-z0-9.-]{1,100}$/.test(host)) fail(400, 'Database host can only hold letters, digits, dots and dashes');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(user)) fail(400, 'Database user can only hold letters, digits, dots, dashes and underscores');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) fail(400, 'Database name can only hold letters, digits and underscores');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, 'Invalid database port');
  const prev = s.db || {};
  let password = prev.password || '';
  if (typeof input.password === 'string' && input.password !== '') {
    if (input.password.length > 200 || /[\r\n\0]/.test(input.password)) fail(400, 'That password has characters the plugin config cannot hold');
    password = secrets.seal(input.password);
  }
  s.db = { host, port, user, name, password };
  store.save();
  return view(server);
}

/* ---------------------------------------------------------------- picks -- */

const TEAMS = { 0: 'both', 2: 'terrorists', 3: 'counter-terrorists' };

/**
 * Save a pick for a player. A pick is a weapon (defindex + class) with a paint;
 * for a knife it also sets which knife the player gets.
 */
async function pick(store, server, steamid, input = {}) {
  checkSteamId(steamid);
  const s = sc(server);
  const defindex = Number(input.defindex);
  const paint = Number(input.paint);
  const wear = input.wear === undefined || input.wear === '' ? 0.000001 : Number(input.wear);
  const seed = input.seed === undefined || input.seed === '' ? 0 : Number(input.seed);
  const team = input.team === undefined ? 0 : Number(input.team);
  if (!Number.isInteger(defindex) || defindex < 1 || defindex > 9999) fail(400, 'Unknown weapon');
  if (!Number.isInteger(paint) || paint < 0 || paint > 99999) fail(400, 'Unknown skin');
  if (!(wear >= 0 && wear <= 1)) fail(400, 'Wear must be between 0 and 1');
  if (!Number.isInteger(seed) || seed < 0 || seed > 1000) fail(400, 'Pattern seed must be 0 to 1000');
  if (!(team in TEAMS)) fail(400, 'Team must be 0 (both), 2 (T) or 3 (CT)');
  // The catalog is the allow-list: the weapon class and paint must belong together.
  const { items } = await catalog();
  const item = items.find((i) => i.d === defindex && i.p === paint);
  if (!item && paint !== 0) fail(400, 'That skin is not in the catalog for that weapon');
  const w = item?.w || String(input.weaponClass || '');
  if (!/^weapon_[a-z0-9_]+$/.test(w)) fail(400, 'Unknown weapon');
  const mine = (s.picks[steamid] ||= { knife: {}, weapons: {} });
  if (defindex >= 500 && defindex < 600) mine.knife[team] = w;
  mine.weapons[`${team}:${defindex}`] = { team, defindex, paint, wear, seed, name: item ? `${item.wn} | ${item.n}` : w };
  store.save();
  return mine;
}

function unpick(store, server, steamid, key) {
  checkSteamId(steamid);
  const mine = sc(server).picks[steamid];
  if (mine) {
    const hit = mine.weapons[key];
    delete mine.weapons[key];
    if (hit && hit.defindex >= 500) delete mine.knife[hit.team];
    if (!Object.keys(mine.weapons).length) delete sc(server).picks[steamid];
  }
  store.save();
  return sc(server).picks;
}

/* ------------------------------------------------- SQL and plugin config -- */

const intOf = (n) => String(Math.trunc(Number(n)));

/** SQL for every saved pick. Every value is a validated number, a SteamID64 or a weapon class name. */
function sql(server) {
  const out = ['-- Generated by GamePanel for the WeaponPaints plugin. Safe to run more than once.'];
  for (const [steamid, mine] of Object.entries(sc(server).picks)) {
    checkSteamId(steamid);
    for (const w of Object.values(mine.weapons)) {
      out.push(
        `INSERT INTO wp_player_skins (steamid, weapon_team, weapon_defindex, weapon_paint_id, weapon_wear, weapon_seed) VALUES ('${steamid}', ${intOf(w.team)}, ${intOf(w.defindex)}, ${intOf(w.paint)}, ${Number(w.wear).toFixed(6)}, ${intOf(w.seed)}) ON DUPLICATE KEY UPDATE weapon_paint_id = VALUES(weapon_paint_id), weapon_wear = VALUES(weapon_wear), weapon_seed = VALUES(weapon_seed);`
      );
    }
    for (const [team, cls] of Object.entries(mine.knife)) {
      if (!/^weapon_[a-z0-9_]+$/.test(cls)) continue;
      out.push(`INSERT INTO wp_player_knife (steamid, weapon_team, knife) VALUES ('${steamid}', ${intOf(team)}, '${cls}') ON DUPLICATE KEY UPDATE knife = VALUES(knife);`);
    }
  }
  return out.join('\n') + '\n';
}

function readJson(server, rel) {
  const text = common.readRel(server, rel, 1024 * 1024);
  if (text === null) return null;
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    fail(400, `${rel} is not valid JSON; fix or delete it first`);
  }
  return null;
}

/** Write the database login into WeaponPaints.json and switch off CounterStrikeSharp's guidelines mode. */
function writePluginConfig(manager, server) {
  common.requireStopped(manager, server, 'Writing the skin changer config');
  const s = sc(server);
  if (!s.enabled) fail(400, 'The skin changer is off');
  if (!s.db?.host) fail(400, 'Set the database details first');
  const cfg = readJson(server, PLUGIN_CONFIG) || { Version: 4 };
  Object.assign(cfg, { DatabaseHost: s.db.host, DatabasePort: s.db.port, DatabaseUser: s.db.user, DatabasePassword: secrets.open(s.db.password), DatabaseName: s.db.name });
  common.backupRel(server, PLUGIN_CONFIG);
  common.writeRel(server, PLUGIN_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  const core = readJson(server, CORE_CONFIG) || {};
  core.FollowCS2ServerGuidelines = false;
  common.backupRel(server, CORE_CONFIG);
  common.writeRel(server, CORE_CONFIG, JSON.stringify(core, null, 2) + '\n');
  return { ok: true, files: [PLUGIN_CONFIG, CORE_CONFIG], note: 'The database password is now stored in that plugin config file inside the server folder, as the plugin requires.' };
}

function runClient(bin, args, env, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { env, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

/** Run the SQL through a mysql/mariadb command line client if there is one. */
async function sync(server) {
  const s = sc(server);
  if (!s.enabled) fail(400, 'The skin changer is off');
  if (!s.db?.host) fail(400, 'Set the database details first');
  const text = sql(server);
  const args = ['-h', s.db.host, '-P', String(s.db.port), '-u', s.db.user, '--connect-timeout=8', s.db.name];
  const env = { ...process.env, MYSQL_PWD: secrets.open(s.db.password) };
  let lastErr = null;
  for (const bin of ['mariadb', 'mysql']) {
    try {
      await runClient(bin, args, env, text);
      s.lastSync = { at: Date.now(), ok: true };
      return { ok: true, client: bin, statements: text.split('\n').filter((l) => l.startsWith('INSERT')).length };
    } catch (err) {
      if (err.code === 'ENOENT') {
        lastErr = err;
        continue;
      }
      s.lastSync = { at: Date.now(), ok: false };
      // Never echo the client's output verbatim without bounds; it can include the host name only, never the password.
      fail(502, `The ${bin} client failed: ${String(err.stderr || err.message).trim().split('\n')[0].slice(0, 200)}. Is the WeaponPaints plugin loaded once (it creates the tables)?`);
    }
  }
  fail(501, `No mysql or mariadb command line client is installed on this machine${lastErr ? '' : ''}. Download the SQL and run it against your database by hand.`);
  return null;
}

module.exports = { WARNING, FALLBACK, catalog, normalise, view, enable, setDb, pick, unpick, sql, writePluginConfig, sync, checkSteamId, PLUGIN_CONFIG, CORE_CONFIG };
