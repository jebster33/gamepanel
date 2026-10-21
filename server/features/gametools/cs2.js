'use strict';

/**
 * Counter-Strike 2 tools: game-mode presets (competitive, arms race, deathmatch,
 * lineup/practice), a map pool with an end-of-match map vote, and one-click
 * installs of Metamod and CounterStrikeSharp.
 *
 * Map voting uses the game's own end-of-match vote (mp_endmatch_votenextmap):
 * it offers the maps of the server's map group, which the panel writes to
 * game/csgo/gamemodes_server.txt, and the server loads the group with
 * +mapgroup {{MAPGROUP}}. No plugin is needed. A community plugin
 * (MapChooserSharp) can be installed on top for nominations and revotes.
 *
 * Presets only ever write the cvars listed here. The skin changer is never
 * switched on by a preset (see cs2-skins.js).
 */

const fs = require('fs');
const path = require('path');
const { fail } = require('../../core/util');
const files = require('../files');
const http = require('../mods/http');
const common = require('./common');

const CFG_DIR = 'game/csgo/cfg';
const PRESET_CFG = `${CFG_DIR}/gamepanel-preset.cfg`;
const GROUPS_FILE = 'game/csgo/gamemodes_server.txt';
const MAPCYCLE_FILE = 'game/csgo/mapcycle.txt';
const GAMEINFO = 'game/csgo/gameinfo.gi';
const GROUP_NAME = 'mg_gamepanel';

const OFFICIAL_MAPS = [
  'de_dust2', 'de_mirage', 'de_inferno', 'de_nuke', 'de_overpass', 'de_ancient', 'de_anubis', 'de_vertigo', 'de_train', 'de_cache',
  'cs_office', 'cs_italy', 'de_jura', 'de_grail', 'de_palais', 'ar_baggage', 'ar_shoots', 'ar_pool_day', 'ar_lunacy',
];
const MAP_NAME = /^(?:[a-z][a-z0-9_]{1,39}|workshop\/\d{5,12}\/[a-z][a-z0-9_]{1,39})$/i;

const VOTE_CVARS = (seconds) => ['mp_endmatch_votenextmap 1', `mp_endmatch_votenextleveltime ${seconds}`, 'mp_match_end_changelevel 1', 'mp_match_end_restart 0', 'mapcyclefile "mapcycle.txt"'];

/** game_type / game_mode pairs: classic 0, gun game 1, training 2, custom 3. */
const PRESETS = {
  competitive: {
    label: 'Competitive 5v5',
    description: 'Standard 5v5 match, 24 rounds, no cheats. Vote for the next map when it ends.',
    type: 0,
    mode: 1,
    bots: 0,
    cvars: ['sv_cheats 0', 'mp_maxrounds 24', 'mp_halftime 1', 'mp_overtime_enable 1', 'mp_autoteambalance 1', 'mp_limitteams 1'],
  },
  arms_race: {
    label: 'Arms race (gun game)',
    description: 'Everyone climbs a weapon ladder; first to the knife wins. Ends on a time limit.',
    type: 1,
    mode: 0,
    bots: 0,
    cvars: ['sv_cheats 0', 'mp_timelimit 15', 'mp_maxrounds 0', 'mp_respawn_on_death_t 1', 'mp_respawn_on_death_ct 1'],
  },
  deathmatch: {
    label: 'Deathmatch',
    description: 'Free-for-all style respawning with random weapons. Good for warm-ups and aim practice.',
    type: 1,
    mode: 2,
    bots: 0,
    cvars: ['sv_cheats 0', 'mp_timelimit 10', 'mp_maxrounds 0', 'mp_respawn_on_death_t 1', 'mp_respawn_on_death_ct 1', 'mp_teammates_are_enemies 0'],
  },
  practice: {
    label: 'Lineup / practice',
    description:
      'For learning grenade lineups: cheats ON, unlimited ammo and money, long rounds, grenade trajectory preview, impact markers. Only use on a private server.',
    type: 0,
    mode: 1,
    bots: 0,
    cheats: true,
    cvars: [
      'sv_cheats 1',
      'sv_infinite_ammo 1',
      'sv_grenade_trajectory_prac_pipreview 1',
      'sv_grenade_trajectory_prac_trailtime 6',
      'sv_showimpacts 1',
      'sv_showimpacts_time 8',
      'mp_roundtime 60',
      'mp_roundtime_defuse 60',
      'mp_roundtime_hostage 60',
      'mp_freezetime 0',
      'mp_buytime 9999',
      'mp_buy_anywhere 1',
      'mp_maxmoney 60000',
      'mp_startmoney 60000',
      'mp_afterroundmoney 60000',
      'mp_respawn_on_death_t 1',
      'mp_respawn_on_death_ct 1',
      'mp_warmup_pausetimer 1',
      'mp_warmup_start',
      'mp_death_drop_gun 0',
      'mp_maxrounds 0',
      'ammo_grenade_limit_total 5',
      'sv_regeneration_force_on 1',
    ],
  },
};

const defaults = () => ({ preset: null, bots: 0, maps: [], vote: true, voteSeconds: 20, skinchanger: { enabled: false } });

function state(server) {
  if (!server.cs2 || typeof server.cs2 !== 'object') server.cs2 = defaults();
  return server.cs2;
}

const int = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/** The text of gamepanel-preset.cfg. Only whitelisted cvars and validated numbers go in. */
function presetCfg(id, bots, vote, voteSeconds) {
  const p = PRESETS[id];
  const lines = [`// Written by GamePanel: preset "${p.label}". Re-apply it from the CS2 tab; edits here are overwritten.`, ...p.cvars];
  lines.push(`bot_quota ${bots}`, `bot_quota_mode ${bots ? 'fill' : 'normal'}`);
  if (bots) lines.push('bot_difficulty 1');
  if (vote) lines.push(...VOTE_CVARS(voteSeconds));
  return lines.join('\n') + '\n';
}

function describe(manager, server) {
  const s = state(server);
  const read = (rel) => common.readRel(server, rel, 256 * 1024);
  const gameinfo = read(GAMEINFO);
  const has = (rel) => fs.existsSync(files.containedPath(server.dir, rel));
  return {
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, description: p.description, cheats: Boolean(p.cheats) })),
    preset: s.preset,
    bots: s.bots,
    vote: s.vote,
    voteSeconds: s.voteSeconds,
    maps: s.maps,
    officialMaps: OFFICIAL_MAPS,
    mapgroup: manager.vars?.(server)?.MAPGROUP || null,
    gameMode: { type: server.vars?.GAME_TYPE ?? null, mode: server.vars?.GAME_MODE ?? null },
    plugins: {
      metamod: has('game/csgo/addons/metamod') && /csgo\/addons\/metamod/.test(gameinfo || ''),
      metamodFiles: has('game/csgo/addons/metamod'),
      gameinfoPatched: /csgo\/addons\/metamod/.test(gameinfo || ''),
      css: has('game/csgo/addons/counterstrikesharp'),
      mapchooser: has('game/csgo/addons/counterstrikesharp/plugins/MapChooserSharp'),
      weaponpaints: has('game/csgo/addons/counterstrikesharp/plugins/WeaponPaints'),
    },
  };
}

/** Apply a preset: game type/mode variables, the cfg the launch line executes, bots. */
function applyPreset(manager, store, server, input = {}) {
  const id = String(input.preset || '');
  const p = PRESETS[id];
  if (!p) fail(400, 'Unknown preset');
  const s = state(server);
  const bots = int(input.bots, 0, 32, p.bots);
  s.preset = id;
  s.bots = bots;
  common.setVars(manager, store, server, { GAME_TYPE: String(p.type), GAME_MODE: String(p.mode), BOT_QUOTA: String(bots) });
  common.writeRel(server, PRESET_CFG, presetCfg(id, bots, s.vote, s.voteSeconds));
  store.save();
  return describe(manager, server);
}

/** The map group file. Every name is validated, so nothing can break out of the quotes. */
function groupsText(maps) {
  const q = (m) => `\t\t\t\t"${m}"\t\t""`;
  return `"GameModes_Server.txt"\n{\n\t"mapgroups"\n\t{\n\t\t"${GROUP_NAME}"\n\t\t{\n\t\t\t"name"\t"${GROUP_NAME}"\n\t\t\t"maps"\n\t\t\t{\n${maps.map(q).join('\n')}\n\t\t\t}\n\t\t}\n\t}\n}\n`;
}

function setPool(manager, store, server, input = {}) {
  const maps = [...new Set((Array.isArray(input.maps) ? input.maps : []).map((m) => String(m).trim()))];
  if (maps.length < 2) fail(400, 'Pick at least two maps so there is something to vote on');
  if (maps.length > 60) fail(400, 'That is a lot of maps; keep the pool to 60 or fewer');
  for (const m of maps) if (!MAP_NAME.test(m)) fail(400, `"${m.slice(0, 60)}" is not a valid map name (use names like de_dust2 or workshop/123456789/de_name)`);
  const s = state(server);
  s.maps = maps;
  s.vote = input.vote !== false;
  s.voteSeconds = int(input.voteSeconds, 10, 60, 20);
  common.backupRel(server, GROUPS_FILE);
  common.writeRel(server, GROUPS_FILE, groupsText(maps));
  common.writeRel(server, MAPCYCLE_FILE, maps.join('\n') + '\n');
  common.setVars(manager, store, server, { MAPGROUP: GROUP_NAME });
  if (s.preset) common.writeRel(server, PRESET_CFG, presetCfg(s.preset, s.bots, s.vote, s.voteSeconds));
  else if (s.vote) common.writeRel(server, PRESET_CFG, `// Written by GamePanel: map vote only.\n${VOTE_CVARS(s.voteSeconds).join('\n')}\n`);
  store.save();
  return describe(manager, server);
}

/* ------------------------------------------------------ plugin installs -- */

const WIN = process.platform === 'win32';
const OS = WIN ? 'windows' : 'linux';

/** GitHub releases the panel can install. `ext` is the folder the zip is unpacked into. */
const PLUGINS = {
  css: { label: 'CounterStrikeSharp', repo: 'roflmuffin/CounterStrikeSharp', asset: new RegExp(`^counterstrikesharp-with-runtime-${OS}-.*\\.zip$`, 'i'), into: 'game/csgo' },
  mapchooser: { label: 'MapChooserSharp', repo: 'fltuna/MapChooserSharp', asset: new RegExp(`^MapChooserSharp-${OS}.*with-dependencies\\.zip$`, 'i'), into: 'game/csgo/addons/counterstrikesharp', needs: 'css', unmaintained: true },
  weaponpaints: { label: 'WeaponPaints', repo: 'Nereziel/cs2-WeaponPaints', asset: /^WeaponPaints\.zip$/i, into: 'game/csgo', needs: 'css', skinchanger: true },
  'weaponpaints-playersettings': { label: 'PlayerSettings (WeaponPaints needs it)', repo: 'NickFox007/PlayerSettingsCS2', asset: /\.zip$/i, into: 'game/csgo', needs: 'css', skinchanger: true },
  'weaponpaints-anybase': { label: 'AnyBaseLibCS2 (WeaponPaints needs it)', repo: 'NickFox007/AnyBaseLibCS2', asset: /\.zip$/i, into: 'game/csgo', needs: 'css', skinchanger: true },
  'weaponpaints-menumanager': { label: 'MenuManagerCS2 (WeaponPaints needs it)', repo: 'NickFox007/MenuManagerCS2', asset: /\.zip$/i, into: 'game/csgo', needs: 'css', skinchanger: true },
};

/** Add "Game csgo/addons/metamod" to gameinfo.gi (a game update puts the original back, so this can be run again). */
function patchGameinfo(text) {
  if (/csgo\/addons\/metamod/.test(text)) return { text, changed: false };
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^\s*Game\s+csgo\s*\r?$/.test(l));
  if (at < 0) fail(400, 'Could not find the "Game csgo" line in gameinfo.gi. Add "Game csgo/addons/metamod" above it by hand.');
  const indent = lines[at].match(/^\s*/)[0];
  lines.splice(at, 0, `${indent}Game\tcsgo/addons/metamod`);
  return { text: lines.join('\n'), changed: true };
}

async function fetchArchive(server, url, rel) {
  const target = files.containedPath(server.dir, rel);
  await http.downloadTo(url, target);
  try {
    await files.extract(server.dir, rel);
  } finally {
    fs.rmSync(target, { force: true });
  }
}

async function installMetamod(manager, server) {
  const base = 'https://mms.alliedmods.net/mmsdrop/2.0/';
  let name;
  try {
    const res = await fetch(`${base}mmsource-latest-${OS}`, { headers: { 'User-Agent': http.UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    name = (await res.text()).trim();
  } catch (err) {
    fail(502, `Could not look up the latest Metamod build: ${err.message}`);
  }
  if (!/^mmsource-[0-9A-Za-z.-]+-(linux|windows)\.(tar\.gz|zip)$/.test(name)) fail(502, 'Metamod returned an unexpected file name');
  await fetchArchive(server, base + name, `game/csgo/.gp-metamod${name.endsWith('.zip') ? '.zip' : '.tar.gz'}`);
  const info = common.readRel(server, GAMEINFO, 256 * 1024);
  if (info === null) fail(400, 'game/csgo/gameinfo.gi was not found. Install the server files first.');
  const patched = patchGameinfo(info);
  if (patched.changed) {
    common.backupRel(server, GAMEINFO);
    common.writeRel(server, GAMEINFO, patched.text);
  }
  return { installed: name, gameinfoPatched: patched.changed };
}

async function installPlugin(manager, server, id, input = {}) {
  common.requireStopped(manager, server, 'Installing a plugin');
  if (id === 'metamod') return installMetamod(manager, server);
  if (id === 'gameinfo') {
    const info = common.readRel(server, GAMEINFO, 256 * 1024);
    if (info === null) fail(400, 'game/csgo/gameinfo.gi was not found');
    const patched = patchGameinfo(info);
    if (patched.changed) {
      common.backupRel(server, GAMEINFO);
      common.writeRel(server, GAMEINFO, patched.text);
    }
    return { gameinfoPatched: patched.changed };
  }
  const plugin = PLUGINS[id];
  if (!plugin) fail(400, 'Unknown plugin');
  if (plugin.skinchanger && !state(server).skinchanger?.enabled) fail(400, 'Turn the skin changer on first (and accept the warning) before installing its plugins');
  let release;
  try {
    release = await http.getJson(`https://api.github.com/repos/${plugin.repo}/releases/latest`, { Accept: 'application/vnd.github+json' });
  } catch (err) {
    fail(err.status || 502, `Could not read the ${plugin.label} release on GitHub: ${err.message}`);
  }
  const asset = (release.assets || []).find((a) => plugin.asset.test(a.name || ''));
  if (!asset) fail(404, `No ${OS} download matching ${plugin.label} was found in its latest release (${release.tag_name || 'unknown'})`);
  const url = String(asset.browser_download_url || '');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\//.test(url)) fail(502, 'Unexpected download address');
  await fetchArchive(server, url, `${plugin.into}/.gp-${id}.zip`);
  return { installed: `${plugin.label} ${release.tag_name || ''}`.trim() };
}

module.exports = { PRESETS, OFFICIAL_MAPS, PLUGINS, MAP_NAME, GROUP_NAME, state, describe, applyPreset, setPool, presetCfg, groupsText, patchGameinfo, installPlugin, defaults };
