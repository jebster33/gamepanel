'use strict';

/**
 * Small per-game tools that work on the files a game keeps:
 *
 *   FiveM          resources (folders with a manifest) and which ones server.cfg starts
 *   DayZ           types.xml, the loot table: how many of each item spawn and how long they last
 *   Valheim        world modifiers (-modifier / -setkey launch arguments)
 *   Factorio       saves: list, choose the one the server loads, delete
 *   Unturned       RocketMod / OpenMod install from their GitHub releases
 *   Arma Reforger  the scenario and the mod list in config.json
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fail } = require('../core/util');
const { containedPath } = require('./files');
const safefs = require('../core/safefs');

const must = (server, ...ids) => {
  if (!ids.includes(server.templateId)) fail(400, 'This game does not have that feature');
};
const read = (server, rel, max = 8 * 1024 * 1024) => safefs.readText(containedPath(server.dir, rel), max);
const write = (server, rel, text) => {
  const file = containedPath(server.dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/* -------------------------------------------------------------- FiveM -- */

const RES_NAME = /^[A-Za-z0-9_.\-]{1,64}$/;

function luaField(text, name) {
  const m = text.match(new RegExp(`${name}\\s*(?:=|\\s)\\s*['"]([^'"\\n]{1,200})['"]`, 'i'));
  return m ? m[1] : null;
}

/** Resources found under server-data/resources, including inside [category] folders. */
function scanResources(server) {
  const root = containedPath(server.dir, 'server-data/resources');
  const out = [];
  const walk = (dir, category, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (/^\[.+\]$/.test(e.name) && depth < 3) {
        walk(full, e.name, depth + 1);
        continue;
      }
      const manifest = ['fxmanifest.lua', '__resource.lua'].map((f) => path.join(full, f)).find((f) => fs.existsSync(f));
      let meta = {};
      if (manifest) {
        try {
          const text = safefs.readText(manifest, 256 * 1024);
          meta = { author: luaField(text, 'author'), version: luaField(text, 'version'), description: luaField(text, 'description') };
        } catch {
          /* unreadable manifest: still list the folder */
        }
      }
      out.push({ name: e.name, category, hasManifest: Boolean(manifest), ...meta });
    }
  };
  walk(root, '', 0);
  return out;
}

const ENSURE = /^\s*(ensure|start|restart)\s+([^\s#]+)\s*(?:#.*)?$/i;

function cfgState(text) {
  const on = new Set();
  const off = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(ENSURE);
    if (m) on.add(m[2]);
    const c = line.match(/^\s*#\s*(ensure|start)\s+([^\s#]+)\s*$/i);
    if (c) off.add(c[2]);
  }
  return { on, off };
}

function fivemResources(server) {
  must(server, 'fivem');
  let cfg = '';
  try {
    cfg = read(server, 'server-data/server.cfg');
  } catch {
    /* no config yet: the framework installer writes it on first start */
  }
  const { on, off } = cfgState(cfg);
  const items = scanResources(server).map((r) => ({ ...r, enabled: on.has(r.name), disabledInConfig: !on.has(r.name) && off.has(r.name) }));
  return {
    items: items.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
    hasConfig: Boolean(cfg),
    txadmin: server.vars?.FRAMEWORK !== 'vanilla',
    txadminPort: server.ports?.txadmin || null,
    note: server.vars?.FRAMEWORK !== 'vanilla' ? 'This server runs under txAdmin, which keeps its own copy of server.cfg in its profile. Use txAdmin to start or stop resources there.' : null,
  };
}

/** Turn one resource on or off in server.cfg. Off comments the line out so it can be turned back on. */
function fivemToggle(server, name, enabled) {
  must(server, 'fivem');
  if (!RES_NAME.test(String(name))) fail(400, 'That is not a resource name');
  if (!scanResources(server).some((r) => r.name === name)) fail(404, 'No resource has that name');
  const rel = 'server-data/server.cfg';
  let text;
  try {
    text = read(server, rel);
  } catch {
    return fail(409, 'There is no server.cfg yet. Start the server once so it is created.');
  }
  const lines = text.split(/\r?\n/);
  let found = false;
  const out = lines.map((line) => {
    const on = line.match(ENSURE);
    if (on && on[2] === name) {
      found = true;
      return enabled ? line : `# ${line.trim()}`;
    }
    const off = line.match(/^\s*#\s*((?:ensure|start)\s+([^\s#]+))\s*$/i);
    if (off && off[2] === name) {
      found = true;
      return enabled ? off[1] : line;
    }
    return line;
  });
  if (!found && enabled) out.push(`ensure ${name}`);
  write(server, rel, out.join('\n'));
  return fivemResources(server);
}

/* --------------------------------------------------------------- DayZ -- */

const TYPE_FIELDS = ['nominal', 'lifetime', 'restock', 'min', 'quantmin', 'quantmax', 'cost'];

function typesPath(server) {
  must(server, 'dayz');
  const mission = String(server.vars?.MISSION || 'dayzOffline.chernarusplus').replace(/[^A-Za-z0-9_.\-]/g, '');
  return `mpmissions/${mission}/db/types.xml`;
}

/** Every <type> in the file, with the numbers people tune. */
function parseTypes(xml) {
  const out = [];
  const re = /<type\s+name="([^"]+)"\s*>([\s\S]*?)<\/type>/g;
  let m;
  while ((m = re.exec(xml))) {
    const item = { name: m[1] };
    for (const f of TYPE_FIELDS) {
      const v = m[2].match(new RegExp(`<${f}>\\s*(-?\\d+)\\s*</${f}>`));
      item[f] = v ? Number(v[1]) : null;
    }
    item.category = m[2].match(/<category\s+name="([^"]+)"/)?.[1] || null;
    out.push(item);
  }
  return out;
}

function dayzTypes(server, { q = '', page = 0, size = 60 } = {}) {
  const rel = typesPath(server);
  let xml;
  try {
    xml = read(server, rel, 16 * 1024 * 1024);
  } catch {
    return fail(404, `types.xml was not found (${rel}). Start the server once so the mission files exist.`);
  }
  const all = parseTypes(xml);
  const needle = String(q).trim().toLowerCase();
  const rows = needle ? all.filter((t) => t.name.toLowerCase().includes(needle) || (t.category || '').includes(needle)) : all;
  return { file: rel, total: all.length, matches: rows.length, page: Number(page) || 0, items: rows.slice((Number(page) || 0) * size, (Number(page) || 0) * size + size) };
}

/** Change numbers on one type. Everything else in the file (flags, usage, tags) is left as it was. */
function dayzSetType(server, name, fields) {
  const rel = typesPath(server);
  if (!/^[A-Za-z0-9_\-.]{1,80}$/.test(String(name))) fail(400, 'That is not an item class name');
  const xml = read(server, rel, 16 * 1024 * 1024);
  const re = new RegExp(`(<type\\s+name="${name.replace(/[.]/g, '\\.')}"\\s*>)([\\s\\S]*?)(</type>)`);
  const m = xml.match(re);
  if (!m) fail(404, 'No item has that name in types.xml');
  let body = m[2];
  for (const [f, v] of Object.entries(fields || {})) {
    if (!TYPE_FIELDS.includes(f)) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < -1 || n > 100000000) fail(400, `${f} must be a whole number`);
    if (new RegExp(`<${f}>`).test(body)) body = body.replace(new RegExp(`(<${f}>)\\s*-?\\d+\\s*(</${f}>)`), `$1${n}$2`);
    else body = `${body.replace(/\s*$/, '')}\n        <${f}>${n}</${f}>\n    `;
  }
  fs.copyFileSync(containedPath(server.dir, rel), `${containedPath(server.dir, rel)}.gamepanel-backup`);
  write(server, rel, xml.replace(re, `$1${body.replace(/\$/g, '$$$$')}$3`));
  return parseTypes(`<type name="${name}">${body}</type>`)[0];
}

/* ------------------------------------------------------------ Valheim -- */

const MODIFIERS = {
  combat: ['veryeasy', 'easy', 'hard', 'veryhard'],
  deathpenalty: ['casual', 'veryeasy', 'easy', 'hard', 'hardcore'],
  resources: ['muchless', 'less', 'more', 'muchmore', 'most'],
  raids: ['none', 'muchless', 'less', 'more', 'muchmore'],
  portals: ['casual', 'hard', 'veryhard'],
};
const KEYS = ['nobuildcost', 'playerevents', 'passivemobs', 'nomap'];

/** "-modifier combat hard -setkey nomap" from a choice object. Only listed words get in. */
function modifierArgs(choice = {}) {
  const parts = [];
  for (const [k, options] of Object.entries(MODIFIERS)) {
    const v = choice.modifiers?.[k];
    if (!v) continue;
    if (!options.includes(v)) fail(400, `${k} cannot be "${String(v).slice(0, 20)}"`);
    parts.push(`-modifier ${k} ${v}`);
  }
  for (const k of choice.keys || []) {
    if (!KEYS.includes(k)) fail(400, `"${String(k).slice(0, 20)}" is not a world key`);
    parts.push(`-setkey ${k}`);
  }
  return parts.join(' ');
}

function parseModifierArgs(text = '') {
  const modifiers = {};
  const keys = [];
  for (const m of String(text).matchAll(/-modifier\s+(\w+)\s+(\w+)/g)) modifiers[m[1]] = m[2];
  for (const m of String(text).matchAll(/-setkey\s+(\w+)/g)) keys.push(m[1]);
  return { modifiers, keys };
}

function valheimView(server) {
  must(server, 'valheim');
  return { ...parseModifierArgs(server.vars?.WORLD_MODIFIERS), options: MODIFIERS, keyOptions: KEYS, preset: server.vars?.PRESET || 'normal' };
}

function valheimSet(manager, server, body, actor) {
  must(server, 'valheim');
  const args = modifierArgs(body || {});
  manager.update(server.id, { vars: { WORLD_MODIFIERS: args } }, { trusted: true, actor: actor || 'panel', source: 'world-modifiers' });
  return valheimView(server);
}

/* ------------------------------------------------------------ Factorio -- */

const SAVE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,80}$/;

function factorioSaves(server) {
  must(server, 'factorio');
  const dir = containedPath(server.dir, 'saves');
  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.zip'));
  } catch {
    /* no saves yet */
  }
  const active = server.vars?.SAVE_NAME || '';
  return {
    active,
    saves: files
      .map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        const name = e.name.slice(0, -4);
        return { name, size: st.size, modified: st.mtimeMs, active: name === active, autosave: /^_autosave/.test(name) };
      })
      .sort((a, b) => b.modified - a.modified),
  };
}

function factorioUse(manager, server, name, actor) {
  must(server, 'factorio');
  if (!SAVE_NAME.test(String(name))) fail(400, 'That is not a save name');
  if (!factorioSaves(server).saves.some((s) => s.name === name)) fail(404, 'No save has that name');
  if (manager.isActive(server.id)) fail(409, 'Stop the server first');
  manager.update(server.id, { vars: { SAVE_NAME: name } }, { trusted: true, actor: actor || 'panel', source: 'factorio-saves' });
  return factorioSaves(server);
}

/* ----------------------------------------------------------- Unturned -- */

const FRAMEWORKS = {
  openmod: { label: 'OpenMod', repo: 'openmod/openmod', asset: /OpenMod\.Unturned.*\.zip$/i, note: 'Modern framework. Plugins are NuGet packages installed with its commands.' },
  rocketmod: { label: 'RocketMod (LDM)', repo: 'SmartlyDressedGames/Legally-Distinct-Missile', asset: /Rocket\.Unturned.*\.zip$/i, note: 'The classic plugin framework, maintained as Legally Distinct Missile.' },
};

function unturnedFrameworks(server) {
  must(server, 'unturned');
  const has = (dir) => fs.existsSync(containedPath(server.dir, `Modules/${dir}`));
  return { frameworks: Object.entries(FRAMEWORKS).map(([id, f]) => ({ id, label: f.label, note: f.note, installed: has(id === 'openmod' ? 'OpenMod.Unturned' : 'Rocket.Unturned') })) };
}

async function unturnedInstall(manager, server, id) {
  must(server, 'unturned');
  const f = FRAMEWORKS[id];
  if (!f) fail(400, 'Pick OpenMod or RocketMod');
  if (manager.isActive(server.id)) fail(409, 'Stop the server first');
  const { getJson, downloadTo } = require('./mods/http');
  const release = await getJson(`https://api.github.com/repos/${f.repo}/releases/latest`);
  const asset = (release.assets || []).find((a) => f.asset.test(a.name));
  if (!asset) fail(502, `${f.label} has no download that the panel recognises in its latest release. Install it by hand from github.com/${f.repo}.`);
  const tmp = path.join(require('os').tmpdir(), `gp-${Date.now()}-${asset.name.replace(/[^\w.\-]/g, '_')}`);
  try {
    await downloadTo(asset.browser_download_url, tmp);
    const { readZip } = require('./zip');
    let wrote = 0;
    for (const entry of readZip(fs.readFileSync(tmp), { files: 5000, fileBytes: 200 * 1024 * 1024, totalBytes: 600 * 1024 * 1024 })) {
      // Release zips hold either Modules/... or the module folder itself.
      const rel = /^(Modules|Extras)\//.test(entry.path) ? entry.path : `Modules/${entry.path}`;
      write(server, rel, entry.data);
      wrote++;
    }
    return { ok: true, version: release.tag_name, files: wrote };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/* ------------------------------------------------------ Arma Reforger -- */

// Scenario ids from the game's own config reference.
const SCENARIOS = [
  { id: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf', name: 'Conflict: Everon' },
  { id: '{C41618FD18E9D494}Missions/23_Campaign_Arland.conf', name: 'Conflict: Arland' },
  { id: '{59AD59368755F41A}Missions/21_GM_Eden.conf', name: 'Game Master: Everon' },
  { id: '{2BBBE828037C6F4B}Missions/22_GM_Arland.conf', name: 'Game Master: Arland' },
];
const MOD_ID = /^[0-9A-F]{16}$/i;

function reforgerView(server) {
  must(server, 'arma-reforger');
  let mods = [];
  try {
    mods = JSON.parse(String(server.vars?.MODS_JSON || '[]'));
  } catch {
    mods = [];
  }
  return { scenario: server.vars?.SCENARIO || '', scenarios: SCENARIOS, mods: Array.isArray(mods) ? mods : [] };
}

function reforgerSet(manager, server, body, actor) {
  must(server, 'arma-reforger');
  const patch = {};
  if (body?.scenario !== undefined) {
    const s = String(body.scenario).trim();
    if (!/^\{[0-9A-F]{16}\}[\w\/.\-]{1,200}\.conf$/i.test(s)) fail(400, 'A scenario id looks like {ECC61978EDCC2B5A}Missions/23_Campaign.conf');
    patch.SCENARIO = s;
  }
  if (body?.mods !== undefined) {
    if (!Array.isArray(body.mods) || body.mods.length > 200) fail(400, 'Send the mods as a list of at most 200');
    const seen = new Set();
    const mods = body.mods.map((m) => {
      const modId = String(m?.modId || '').trim().toUpperCase();
      if (!MOD_ID.test(modId)) fail(400, `"${modId.slice(0, 20)}" is not a mod id (16 letters and digits, from the Workshop page)`);
      if (seen.has(modId)) fail(400, `${modId} is listed twice`);
      seen.add(modId);
      const out = { modId, name: String(m?.name || modId).replace(/[\r\n"\\]/g, ' ').trim().slice(0, 80) };
      const version = String(m?.version || '').trim();
      if (version) {
        if (!/^\d+\.\d+\.\d+$/.test(version)) fail(400, 'A mod version looks like 1.2.3');
        out.version = version;
      }
      return out;
    });
    patch.MODS_JSON = JSON.stringify(mods);
  }
  manager.update(server.id, { vars: patch }, { trusted: true, actor: actor || 'panel', source: 'reforger' });
  return reforgerView(server);
}

module.exports = {
  fivemResources, fivemToggle, scanResources,
  dayzTypes, dayzSetType, parseTypes,
  valheimView, valheimSet, modifierArgs, parseModifierArgs, MODIFIERS,
  factorioSaves, factorioUse,
  unturnedFrameworks, unturnedInstall,
  reforgerView, reforgerSet, SCENARIOS,
};
