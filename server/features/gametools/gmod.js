'use strict';

/**
 * Garry's Mod gamemode switcher. Lists the gamemodes on disk (the base game's,
 * folders in addons, and ones packed inside Workshop .gma files, whose file
 * table is read without unpacking them) and the maps for each, then sets the
 * server's +gamemode and +map. A prefix preset per well-known gamemode filters
 * the map list (ttt_ for Trouble in Terrorist Town, rp_ for DarkRP, ...).
 */

const fs = require('fs');
const path = require('path');
const { fail } = require('../../core/util');
const { containedPath } = require('../files');
const safefs = require('../../core/safefs');
const common = require('./common');

const GAMEMODE = /^[a-z0-9_]{1,40}$/;
const MAP = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_GMA_HEAD = 4 * 1024 * 1024;
const MAX_GMAS = 300;

/** Map prefixes of well-known gamemodes. The list is a convenience; any map can still be typed. */
const PREFIXES = {
  sandbox: ['gm_'],
  darkrp: ['rp_'],
  terrortown: ['ttt_'],
  prop_hunt: ['ph_'],
  murder: ['md_', 'mu_'],
  deathrun: ['deathrun_', 'dr_'],
  jailbreak: ['jb_', 'ba_jail_'],
  zombiesurvival: ['zs_', 'zm_'],
  cinema: ['cinema_', 'theater_'],
  hideandseek: ['hns_', 'ph_'],
  basewars: ['bw_', 'gm_'],
  stopitslender: ['slender_'],
  melonracer: ['mr_'],
};

const PRESET_LABELS = {
  sandbox: 'Sandbox',
  darkrp: 'DarkRP',
  terrortown: 'Trouble in Terrorist Town (TTT)',
  prop_hunt: 'Prop Hunt',
  murder: 'Murder',
  deathrun: 'Deathrun',
  jailbreak: 'Jailbreak',
  zombiesurvival: 'Zombie Survival',
  cinema: 'Cinema',
  hideandseek: 'Hide and Seek',
  basewars: 'BaseWars',
  stopitslender: 'Stop it Slender',
  melonracer: 'Melon Racer',
};

const label = (id) => PRESET_LABELS[id] || id.replace(/_/g, ' ');

/** Quoted key/value pairs of a Source "KeyValues" file such as gamemodes/ttt/ttt.txt. */
function parseKv(text) {
  const out = {};
  for (const m of String(text).matchAll(/"([A-Za-z_]{1,30})"\s+"([^"\r\n]{0,200})"/g)) if (!(m[1].toLowerCase() in out)) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** Turn a simple "^ttt_|^ph_" maps pattern into prefixes. Anything fancier is ignored rather than run as a regex. */
function prefixesFromPattern(pattern) {
  const parts = String(pattern || '').split('|').map((p) => p.replace(/^\^/, '').replace(/\.?\*$/, ''));
  return parts.every((p) => /^[a-z0-9_]{1,30}$/i.test(p)) ? parts.map((p) => p.toLowerCase()) : [];
}

/**
 * The file table of a .gma (Garry's Mod addon): header, then entries of
 * { u32 index, name, i64 size, u32 crc } until index 0. Reads only the start of the file.
 */
function gmaEntries(file) {
  let fd;
  try {
    fd = safefs.openRegular(file);
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, MAX_GMA_HEAD));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.toString('latin1', 0, 4) !== 'GMAD') return null;
    let pos = 4 + 1 + 8 + 8; // magic, version, steamid, timestamp
    const str = () => {
      const end = buf.indexOf(0, pos);
      if (end < 0) throw new Error('truncated');
      const s = buf.toString('utf8', pos, end);
      pos = end + 1;
      return s;
    };
    if (buf[4] > 1) while (str() !== '') { /* required content */ }
    const title = str();
    str(); // description (JSON)
    str(); // author
    pos += 4; // addon version
    const names = [];
    for (let n = 0; n < 20000; n++) {
      if (pos + 4 > buf.length) break;
      const index = buf.readUInt32LE(pos);
      pos += 4;
      if (index === 0) return { title, files: names };
      names.push(str());
      pos += 8 + 4;
    }
    return { title, files: names };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function listDir(server, rel) {
  try {
    return fs.readdirSync(containedPath(server.dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
}

function readKvFor(server, rel) {
  try {
    return parseKv(safefs.readText(containedPath(server.dir, rel), 64 * 1024));
  } catch {
    return {};
  }
}

function gmaFiles(server) {
  const out = [];
  for (const e of listDir(server, 'garrysmod/addons')) if (e.isFile() && /\.gma$/i.test(e.name)) out.push(`garrysmod/addons/${e.name}`);
  for (const d of listDir(server, 'steamapps/workshop/content/4000')) {
    if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;
    for (const e of listDir(server, `steamapps/workshop/content/4000/${d.name}`)) if (e.isFile() && /\.gma$/i.test(e.name)) out.push(`steamapps/workshop/content/4000/${d.name}/${e.name}`);
  }
  return out.slice(0, MAX_GMAS);
}

/** Everything installed: { gamemodes: [{ id, title, source, prefixes }], maps: [{ name, source }] }. */
function scan(server) {
  const gamemodes = new Map();
  const maps = new Map();
  const addGamemode = (id, source, kv = {}) => {
    if (!GAMEMODE.test(id) || gamemodes.has(id)) return;
    const own = prefixesFromPattern(kv.maps);
    gamemodes.set(id, { id, title: kv.title || label(id), source, prefixes: own.length ? own : PREFIXES[id] || [] });
  };
  const addMap = (name, source) => {
    if (MAP.test(name) && !maps.has(name)) maps.set(name, { name, source });
  };

  for (const e of listDir(server, 'garrysmod/gamemodes')) if (e.isDirectory()) addGamemode(e.name, 'game', readKvFor(server, `garrysmod/gamemodes/${e.name}/${e.name}.txt`));
  for (const e of listDir(server, 'garrysmod/maps')) if (e.isFile() && /\.bsp$/i.test(e.name)) addMap(e.name.slice(0, -4), 'maps folder');
  for (const e of listDir(server, 'garrysmod/addons')) {
    if (!e.isDirectory()) continue;
    for (const g of listDir(server, `garrysmod/addons/${e.name}/gamemodes`)) if (g.isDirectory()) addGamemode(g.name, `addon ${e.name}`, readKvFor(server, `garrysmod/addons/${e.name}/gamemodes/${g.name}/${g.name}.txt`));
    for (const m of listDir(server, `garrysmod/addons/${e.name}/maps`)) if (m.isFile() && /\.bsp$/i.test(m.name)) addMap(m.name.slice(0, -4), `addon ${e.name}`);
  }
  for (const rel of gmaFiles(server)) {
    const gma = gmaEntries(containedPath(server.dir, rel));
    if (!gma) continue;
    const from = `Workshop ${path.basename(path.dirname(rel)) !== 'addons' ? path.basename(path.dirname(rel)) : path.basename(rel, '.gma')}`;
    for (const f of gma.files) {
      const gm = f.match(/^gamemodes\/([a-z0-9_]+)\/(?:info\.txt|\1\.txt)$/i);
      if (gm) addGamemode(gm[1].toLowerCase(), from, { title: gma.title });
      const mp = f.match(/^maps\/([A-Za-z0-9_-]+)\.bsp$/i);
      if (mp) addMap(mp[1], from);
    }
  }
  // Presets for gamemodes that are not installed still show, so the owner sees what to install.
  const known = Object.keys(PREFIXES).filter((id) => !gamemodes.has(id)).map((id) => ({ id, title: label(id), source: null, prefixes: PREFIXES[id] }));
  return { gamemodes: [...gamemodes.values(), ...known], maps: [...maps.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function describe(manager, server) {
  const vars = manager.vars(server);
  const found = scan(server);
  const current = String(vars.GAMEMODE || 'sandbox');
  return { current: { gamemode: current, map: String(vars.MAP || '') }, prefixes: PREFIXES, ...found };
}

function apply(manager, store, server, input = {}) {
  const gamemode = String(input.gamemode || '').trim();
  const map = String(input.map || '').trim();
  if (!GAMEMODE.test(gamemode)) fail(400, 'Gamemode names use lowercase letters, digits and underscores');
  if (map && !MAP.test(map)) fail(400, 'That is not a valid map name');
  const found = scan(server);
  const gm = found.gamemodes.find((g) => g.id === gamemode);
  const warnings = [];
  if (!gm || !gm.source) warnings.push(`${gamemode} does not look installed on this server. It will not load until its addon is installed.`);
  if (map) {
    if (!found.maps.some((m) => m.name === map)) warnings.push(`${map} was not found on disk. It must arrive with a Workshop collection or be uploaded.`);
    else if (gm?.prefixes.length && !gm.prefixes.some((p) => map.toLowerCase().startsWith(p))) warnings.push(`${map} does not start with ${gm.prefixes.join(' or ')}, so it may not suit ${gamemode}.`);
  }
  const vars = { GAMEMODE: gamemode };
  if (map) vars.MAP = map;
  common.setVars(manager, store, server, vars);
  return { ...describe(manager, server), warnings };
}

module.exports = { PREFIXES, scan, describe, apply, gmaEntries, parseKv, prefixesFromPattern };
