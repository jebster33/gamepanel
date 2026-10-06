'use strict';

/**
 * Getting Steam Workshop items onto a server, the way each game expects.
 * See providers/workshop.js for the strategies.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { fail, logger, safeJoin, interpolate } = require('../../core/util');
const { patchKeyValue } = require('../../servers/config-files');
const steam = require('./providers/workshop');
const manifest = require('./manifest');
const compat = require('./compat');

const STAGE = '.gamepanel/workshop';

function strategyOf(template) {
  const spec = template?.mods?.workshop || {};
  return { strategy: spec.strategy || 'copy', ...spec };
}

/* ------------------------------------------------- config list helpers -- */

function configPath(server, spec) {
  return safeJoin(server.dir, interpolate(spec.file, server.vars || {}));
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Read "key=a,b,c" (optionally inside [section]) from an ini/properties file. */
function readKey(text, key, section) {
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1];
      continue;
    }
    if (section && current !== section) continue;
    const m = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return '';
}

function splitList(value, separator) {
  return String(value || '')
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Add or remove values in a list-valued key of a game config file. */
function editList(server, spec, key, { add = [], remove = [] }) {
  const file = configPath(server, spec);
  const separator = spec.separator || (spec.format === 'json' ? null : ',');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (spec.format === 'json') {
    let data = {};
    try {
      data = JSON.parse(readText(file) || '{}');
    } catch {
      fail(500, `${spec.file} is not valid JSON; fix or delete it, then try again`);
    }
    const list = (Array.isArray(data[key]) ? data[key] : []).map(String).filter((v) => !remove.includes(v));
    for (const v of add) if (!list.includes(String(v))) list.push(String(v));
    data[key] = list.map((v) => (/^\d+$/.test(v) ? Number(v) : v));
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return list;
  }

  const text = readText(file);
  const list = splitList(readKey(text, key, spec.section), separator).filter((v) => !remove.includes(v));
  for (const v of add) if (!list.includes(String(v))) list.push(String(v));
  fs.writeFileSync(file, patchKeyValue(text, { [key]: list.join(separator) }, { section: spec.section }));
  return list;
}


/* ------------------------------------------------- per-game list helpers -- */

/** Files matching a path pattern such as "Instance/Saves/<star>/Sandbox_config.sbc" (a * matches within one segment). */
function globFiles(base, pattern) {
  let found = [base];
  for (const part of pattern.split('/').filter(Boolean)) {
    const next = [];
    for (const dir of found) {
      if (!part.includes('*')) {
        next.push(path.join(dir, part));
        continue;
      }
      const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      for (const e of safeReaddir(dir)) if (re.test(e)) next.push(path.join(dir, e));
    }
    found = next;
  }
  return found.filter((f) => fs.existsSync(f));
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Add or remove whole lines in a plain list file (Conan's modlist.txt). */
function editLines(file, { add = [], remove = [] }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = readText(file).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !remove.includes(l));
  for (const l of add) if (!lines.includes(l)) lines.push(l);
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Rewrite the first <Mods> block of a Space Engineers file. `entry(id, item)`
 * renders one mod; existing entries are found by their Workshop id.
 */
function editXmlMods(file, { add = [], remove = [] }, render, idOf) {
  const text = readText(file);
  if (!text) return false;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const block = text.match(/([ \t]*)<Mods\s*\/>|([ \t]*)<Mods>([\s\S]*?)<\/Mods>/);
  const indent = block ? block[1] ?? block[2] ?? '' : '  ';
  const inner = block?.[3] || '';
  const children = [...inner.matchAll(/<(\w+)[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g)].map((m) => m[0]);
  const keep = children.filter((c) => !remove.includes(idOf(c)));
  const have = new Set(keep.map(idOf));
  for (const item of add) if (!have.has(item.id)) keep.push(render(item));
  const body = keep.length ? `<Mods>${nl}${keep.map((c) => `${indent}  ${c.trim()}`).join(nl)}${nl}${indent}</Mods>` : '<Mods />';
  const next = block ? text.replace(block[0], () => `${indent}${body}`) : text;
  if (next !== text) fs.writeFileSync(file, next);
  return Boolean(block);
}

const SE = {
  /** SpaceEngineers-Dedicated.cfg: <Mods><unsignedLong>id</unsignedLong></Mods> */
  cfg: {
    render: (item) => `<unsignedLong>${item.id}</unsignedLong>`,
    idOf: (xml) => xml.match(/<unsignedLong>\s*(\d+)\s*</)?.[1],
  },
  /** A world's Sandbox_config.sbc / Sandbox.sbc: <ModItem> entries. */
  world: {
    render: (item) =>
      `<ModItem FriendlyName="${xmlEscape(item.title || item.name || item.id)}"><Name>${item.id}.sbm</Name><PublishedFileId>${item.id}</PublishedFileId><PublishedServiceName>Steam</PublishedServiceName></ModItem>`,
    idOf: (xml) => xml.match(/<PublishedFileId>\s*(\d+)\s*</)?.[1],
  },
};

/** Space Engineers keeps the mod list in the server config and in every saved world. */
function editSpaceEngineers(server, spec, change) {
  let touched = 0;
  for (const file of globFiles(server.dir, interpolate(spec.file, server.vars || {}))) {
    if (editXmlMods(file, change, SE.cfg.render, SE.cfg.idOf)) touched++;
  }
  for (const pattern of spec.worlds || []) {
    for (const file of globFiles(server.dir, interpolate(pattern, server.vars || {}))) {
      if (editXmlMods(file, change, SE.world.render, SE.world.idOf)) touched++;
    }
  }
  return touched;
}

/** Don't Starve Together: ServerModSetup lines plus an enabled entry in modoverrides.lua. */
function editDst(server, spec, { add = [], remove = [], disable = [] }) {
  const setup = safeJoin(server.dir, interpolate(spec.file, server.vars || {}));
  fs.mkdirSync(path.dirname(setup), { recursive: true });
  let text = readText(setup);
  for (const id of remove) text = text.replace(new RegExp(`^\\s*ServerModSetup\\(\\s*"${id}"\\s*\\)\\s*\\r?\\n?`, 'gm'), '');
  for (const id of add) if (!new RegExp(`ServerModSetup\\(\\s*"${id}"\\s*\\)`).test(text)) text = `${text.replace(/\s*$/, '')}${text.trim() ? '\n' : ''}ServerModSetup("${id}")\n`;
  fs.writeFileSync(setup, text);

  for (const pattern of spec.overrides || []) {
    const file = safeJoin(server.dir, interpolate(pattern, server.vars || {}));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lua = readText(file).trim() || 'return {\n}';
    for (const id of [...remove, ...disable]) lua = lua.replace(new RegExp(`^\\s*\\["workshop-${id}"\\]\\s*=\\s*\\{[^\\n]*\\},?\\s*\\r?\\n`, 'gm'), '');
    for (const id of add) {
      if (lua.includes(`["workshop-${id}"]`)) continue;
      const end = lua.lastIndexOf('}');
      if (end < 0) continue;
      const before = lua.slice(0, end).replace(/\s*$/, '');
      const comma = /[{,]$/.test(before) ? '' : ',';
      lua = `${before}${comma}\n  ["workshop-${id}"] = { enabled = true },\n${lua.slice(end)}`;
    }
    fs.writeFileSync(file, `${lua}\n`);
  }
}

/** Highest-versioned file whose name matches, e.g. tModLoader's 2024.x/Mod.tmod. */
function newest(files) {
  const version = (f) => (path.basename(path.dirname(f)).match(/^\d+(\.\d+)*$/) ? path.basename(path.dirname(f)).split('.').map(Number) : [0]);
  return files.sort((a, b) => {
    const va = version(a);
    const vb = version(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((va[i] || 0) !== (vb[i] || 0)) return (vb[i] || 0) - (va[i] || 0);
    return 0;
  })[0];
}

/** Arma and DayZ on Linux only find mod files with lowercase names. */
async function lowercaseTree(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    let full = path.join(dir, e.name);
    const lower = e.name.toLowerCase();
    if (lower !== e.name) {
      const target = path.join(dir, lower);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rename(full, target);
      full = target;
    }
    if (e.isDirectory()) await lowercaseTree(full);
  }
}

/** The -mod= value for Arma 3 and DayZ: every enabled Workshop mod folder, in install order. */
function modArgument(server) {
  return manifest
    .load(server)
    .filter((m) => m.provider === 'workshop' && m.strategy === 'bohemia' && m.folder && !m.disabled)
    .map((m) => m.folder)
    .join(';');
}

/* --------------------------------------------------------------- install -- */

/**
 * Resolve pasted input to Workshop items for this game: expands collections,
 * checks every item really belongs to this game, and adds the items they
 * require (when a Steam Web API key is set).
 */
async function resolveItems(input, ctx, apiKey) {
  const ids = [];
  for (const id of steam.parseIds(input)) {
    const children = await steam.collection(id).catch(() => null);
    ids.push(...(children || [id]));
  }
  const required = await steam.requiredItems(ids, apiKey);
  const all = [...new Set([...ids, ...[...required.values()].flat()])];
  const items = [];
  for (let i = 0; i < all.length; i += 100) items.push(...(await steam.details(all.slice(i, i + 100))));

  const allowed = new Set([ctx.appId, ...(ctx.workshop?.appIds || []).map(String)].filter(Boolean));
  const out = [];
  for (const item of items) {
    if (!item.ok) fail(404, `Workshop item ${item.id} does not exist or is not public`);
    if (allowed.size && item.appId && !allowed.has(item.appId)) {
      fail(400, `"${item.title}" is a Workshop item for a different game (app ${item.appId}), not this one.`);
    }
    const parent = [...required].find(([, kids]) => kids.includes(item.id))?.[0];
    out.push({ ...item, auto: !ids.includes(item.id), requiredBy: parent ? [manifest.keyOf('workshop', parent)] : [] });
  }
  return out;
}

function entryFor(item, extra = {}) {
  return {
    key: manifest.keyOf('workshop', item.id),
    provider: 'workshop',
    projectId: item.id,
    name: item.title,
    icon: item.icon,
    url: item.url,
    version: item.updated ? new Date(item.updated * 1000).toISOString().slice(0, 10) : null,
    updated: item.updated,
    size: item.size,
    auto: item.auto,
    requiredBy: item.requiredBy || [],
    installedAt: Date.now(),
    ...extra,
  };
}

function saveEntries(server, entries) {
  const mods = manifest.load(server);
  for (const entry of entries) {
    const i = mods.findIndex((m) => m.key === entry.key);
    if (i >= 0) mods[i] = { ...entry, auto: mods[i].auto && entry.auto };
    else mods.push(entry);
  }
  manifest.save(server, mods);
}

/**
 * Download one item with SteamCMD into the server, in the server's own runtime.
 * Some games (DayZ, Arma 3) only hand out Workshop files to an account that
 * owns the game: the template names that login in mods.workshop.login.
 */
function requireLogin(server, login) {
  if (login && !interpolate(login, server.vars || {}).trim()) {
    fail(400, 'This game needs a Steam account that owns it to download Workshop items. Set STEAM_USER and STEAM_PASSWORD on the server\'s Settings tab.');
  }
}

async function download(manager, server, ctx, item, dest) {
  const login = ctx.workshop?.login;
  requireLogin(server, login);
  const result = await manager.runTask(server, {
    label: `Downloading "${item.title}" from the Workshop`,
    steps: [{ type: 'workshop', appid: ctx.appId, item: item.id, dest, ...(login ? { login } : {}) }],
  });
  if (result.code !== 0) fail(502, result.error || `SteamCMD could not download "${item.title}"`);
}

async function findFiles(dir, test, depth = 6) {
  const out = [];
  const walk = async (d, level) => {
    if (level > depth) return;
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full, level + 1);
      else if (test(e.name)) out.push(full);
    }
  };
  await walk(dir, 0);
  return out;
}

/** tModLoader's Mods/enabled.json: a plain JSON array of mod names. */
function editEnabled(server, spec, { add = [], remove = [] }) {
  const file = configPath(server, spec);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let list = [];
  try {
    list = JSON.parse(readText(file) || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  list = list.filter((n) => !remove.includes(n));
  for (const n of add) if (!list.includes(n)) list.push(n);
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

const STRATEGIES = {
  /** The game downloads the item itself; just list it in its config. */
  async list(server, ctx, spec, items) {
    editList(server, spec, spec.key, { add: items.map((i) => i.id) });
    return items.map((i) => entryFor(i, { strategy: 'list' }));
  },

  /** Project Zomboid: WorkshopItems= plus the item's Mod IDs in Mods=. */
  async zomboid(server, ctx, spec, items, manager) {
    const entries = [];
    for (const item of items) {
      let modIds = steam.zomboidModIds(item.description);
      if (!modIds.length) {
        // Not in the description: download it and read its mod.info files.
        const stage = `${STAGE}/${item.id}`;
        await download(manager, server, ctx, item, stage);
        const infos = await findFiles(safeJoin(server.dir, stage), (n) => n === 'mod.info');
        modIds = [...new Set(infos.map((f) => readText(f).match(/^\s*id\s*=\s*(.+)$/m)?.[1]?.trim()).filter(Boolean))];
        await fsp.rm(safeJoin(server.dir, stage), { recursive: true, force: true });
      }
      if (!modIds.length) fail(400, `Could not find the Mod ID of "${item.title}". Add it to Mods= in ${spec.file} by hand.`);
      entries.push(entryFor(item, { strategy: 'zomboid', modIds }));
    }
    editList(server, { ...spec, separator: ';' }, 'WorkshopItems', { add: items.map((i) => i.id) });
    editList(server, { ...spec, separator: ';' }, 'Mods', { add: entries.flatMap((e) => e.modIds) });
    return entries;
  },

  /** Garry's Mod: the .gma goes straight into garrysmod/addons. */
  async gma(server, ctx, spec, items, manager) {
    const entries = [];
    for (const item of items) {
      const stage = `${STAGE}/${item.id}`;
      await download(manager, server, ctx, item, stage);
      const stageDir = safeJoin(server.dir, stage);
      const [gma] = await findFiles(stageDir, (n) => n.toLowerCase().endsWith('.gma'));
      if (!gma) {
        await fsp.rm(stageDir, { recursive: true, force: true });
        fail(400, `"${item.title}" uses the old Workshop format. Put it in a Workshop collection and set that collection on the server's settings page instead.`);
      }
      const file = `${item.id}.gma`;
      await fsp.mkdir(safeJoin(server.dir, ctx.dir), { recursive: true });
      await fsp.copyFile(gma, path.join(safeJoin(server.dir, ctx.dir), file));
      await fsp.rm(stageDir, { recursive: true, force: true });
      entries.push(entryFor(item, { strategy: 'gma', file }));
    }
    return entries;
  },

  /**
   * Arma 3 and DayZ: the item becomes an @mod folder, its signing keys go into
   * keys/, and the start command loads it through {{WORKSHOP_MODS}}.
   */
  async bohemia(server, ctx, spec, items, manager) {
    const entries = [];
    for (const item of items) {
      const folder = `@${item.id}`;
      const rel = ctx.dir && ctx.dir !== '.' ? `${ctx.dir}/${folder}` : folder;
      await download(manager, server, ctx, item, rel);
      const modDir = safeJoin(server.dir, rel);
      if (spec.lowercase && process.platform !== 'win32') await lowercaseTree(modDir);
      const keysDir = safeJoin(server.dir, spec.keys || 'keys');
      const keys = [];
      for (const key of await findFiles(modDir, (n) => n.toLowerCase().endsWith('.bikey'))) {
        await fsp.mkdir(keysDir, { recursive: true });
        const name = path.basename(key);
        await fsp.copyFile(key, path.join(keysDir, name));
        keys.push(name);
      }
      entries.push(entryFor(item, { strategy: 'bohemia', folder: rel, keys }));
    }
    return entries;
  },

  /** Conan Exiles: the .pak files go into Mods and are listed in modlist.txt. */
  async modlist(server, ctx, spec, items, manager) {
    const entries = [];
    for (const item of items) {
      const stage = `${STAGE}/${item.id}`;
      await download(manager, server, ctx, item, stage);
      const stageDir = safeJoin(server.dir, stage);
      const paks = await findFiles(stageDir, (n) => n.toLowerCase().endsWith('.pak'));
      if (!paks.length) {
        await fsp.rm(stageDir, { recursive: true, force: true });
        fail(400, `"${item.title}" has no .pak file, so it is not a server mod`);
      }
      await fsp.mkdir(safeJoin(server.dir, ctx.dir), { recursive: true });
      const names = [];
      for (const pak of paks) {
        await fsp.copyFile(pak, path.join(safeJoin(server.dir, ctx.dir), path.basename(pak)));
        names.push(path.basename(pak));
      }
      await fsp.rm(stageDir, { recursive: true, force: true });
      editLines(configPath(server, spec), { add: names });
      entries.push(entryFor(item, { strategy: 'modlist', paks: names }));
    }
    return entries;
  },

  /** tModLoader: the newest .tmod goes into Mods and is switched on in enabled.json. */
  async tmodloader(server, ctx, spec, items, manager) {
    const entries = [];
    for (const item of items) {
      const stage = `${STAGE}/${item.id}`;
      await download(manager, server, ctx, item, stage);
      const stageDir = safeJoin(server.dir, stage);
      const tmod = newest(await findFiles(stageDir, (n) => n.toLowerCase().endsWith('.tmod')));
      if (!tmod) {
        await fsp.rm(stageDir, { recursive: true, force: true });
        fail(400, `"${item.title}" has no .tmod file`);
      }
      const file = path.basename(tmod);
      await fsp.mkdir(safeJoin(server.dir, ctx.dir), { recursive: true });
      await fsp.copyFile(tmod, path.join(safeJoin(server.dir, ctx.dir), file));
      await fsp.rm(stageDir, { recursive: true, force: true });
      editEnabled(server, spec, { add: [file.replace(/\.tmod$/i, '')] });
      entries.push(entryFor(item, { strategy: 'tmodloader', file }));
    }
    return entries;
  },

  /** Space Engineers downloads mods itself; list them in its config and worlds. */
  async spaceengineers(server, ctx, spec, items) {
    if (!editSpaceEngineers(server, spec, { add: items })) {
      fail(409, 'Start the server once so it writes its config and world, then add mods.');
    }
    return items.map((i) => entryFor(i, { strategy: 'spaceengineers' }));
  },

  /** Don't Starve Together downloads mods itself; set them up and switch them on. */
  async dst(server, ctx, spec, items) {
    editDst(server, spec, { add: items.map((i) => i.id) });
    return items.map((i) => entryFor(i, { strategy: 'dst' }));
  },

  /** Everything else: the item's folder goes into the mod directory. */
  async copy(server, ctx, spec, items, manager) {
    const entries = [];
    for (const item of items) {
      await download(manager, server, ctx, item, `${ctx.dir}/${item.id}`);
      entries.push(entryFor(item, { strategy: 'copy', file: item.id }));
    }
    return entries;
  },
};

/** Strategies where the game downloads items itself, so installing finishes at once. */
const LISTED = new Set(['list', 'spaceengineers', 'dst']);

/**
 * Install Workshop items (or a whole collection). List-style games finish at
 * once; download-style ones run in the background and stream to the console.
 */
async function installWorkshop(server, template, manager, { input }, integrations = {}) {
  const ctx = compat.modContext(server, template);
  if (!ctx.appId) fail(400, 'This game has no Steam Workshop app id set in its template');
  const spec = strategyOf(template);
  const strategy = STRATEGIES[spec.strategy];
  if (!strategy) fail(500, `Unknown Workshop strategy "${spec.strategy}"`);
  requireLogin(server, spec.login);
  const items = await resolveItems(input, ctx, integrations.steamApiKey);
  const names = items.map((i) => i.title);

  if (LISTED.has(spec.strategy)) {
    saveEntries(server, await strategy(server, ctx, spec, items, manager));
    return { ok: true, queued: false, items: names, message: `Added ${names.length} item(s). The server downloads them the next time it starts.` };
  }

  strategy(server, ctx, spec, items, manager)
    .then((entries) => {
      saveEntries(server, entries);
      manager.pushConsole(server, `Workshop: installed ${entries.map((e) => e.name).join(', ')}`, 'system');
      if (spec.strategy === 'zomboid') manager.pushConsole(server, 'The server downloads Workshop items itself when it next starts.', 'system');
      if (spec.strategy === 'bohemia') manager.pushConsole(server, 'Restart the server to load the new mods.', 'system');
    })
    .catch((err) => {
      manager.pushConsole(server, `Workshop install failed: ${err.message}`, 'system');
      logger.warn(`Workshop install on ${server.name} failed: ${err.message}`);
    });
  return { ok: true, queued: true, items: names, message: 'Downloading with SteamCMD. Watch the console for progress.' };
}

/** Take an item off the game's list (used by remove and disable). */
async function unlist(server, template, entry) {
  const spec = strategyOf(template);
  if (entry.strategy === 'list') editList(server, spec, spec.key, { remove: [entry.projectId] });
  if (entry.strategy === 'modlist') editLines(configPath(server, spec), { remove: entry.paks || [] });
  if (entry.strategy === 'spaceengineers') editSpaceEngineers(server, spec, { remove: [entry.projectId] });
  if (entry.strategy === 'dst') editDst(server, spec, { disable: [entry.projectId] });
  // bohemia: {{WORKSHOP_MODS}} leaves out disabled entries on the next start.
  if (entry.strategy === 'zomboid') {
    editList(server, { ...spec, separator: ';' }, 'WorkshopItems', { remove: [entry.projectId] });
    editList(server, { ...spec, separator: ';' }, 'Mods', { remove: entry.modIds || [] });
  }
}

async function relist(server, template, entry) {
  const spec = strategyOf(template);
  if (entry.strategy === 'list') editList(server, spec, spec.key, { add: [entry.projectId] });
  if (entry.strategy === 'modlist') editLines(configPath(server, spec), { add: entry.paks || [] });
  if (entry.strategy === 'spaceengineers') editSpaceEngineers(server, spec, { add: [{ id: entry.projectId, title: entry.name }] });
  if (entry.strategy === 'dst') editDst(server, spec, { add: [entry.projectId] });
  if (entry.strategy === 'zomboid') {
    editList(server, { ...spec, separator: ';' }, 'WorkshopItems', { add: [entry.projectId] });
    editList(server, { ...spec, separator: ';' }, 'Mods', { add: entry.modIds || [] });
  }
}

/** After unlist on removal: delete what the item put on disk. */
async function purge(server, template, entry) {
  const spec = strategyOf(template);
  const ctx = compat.modContext(server, template);
  if (entry.strategy === 'bohemia' && entry.folder) {
    await fsp.rm(safeJoin(server.dir, entry.folder), { recursive: true, force: true });
    const stillUsed = new Set(manifest.load(server).filter((m) => m.key !== entry.key).flatMap((m) => m.keys || []));
    for (const key of entry.keys || []) {
      if (!stillUsed.has(key)) await fsp.rm(safeJoin(server.dir, `${spec.keys || 'keys'}/${key}`), { force: true });
    }
  }
  if (entry.strategy === 'modlist') {
    for (const pak of entry.paks || []) await fsp.rm(safeJoin(server.dir, `${ctx.dir}/${pak}`), { force: true });
  }
  if (entry.strategy === 'dst') editDst(server, spec, { remove: [entry.projectId] });
}

/** Items whose Workshop page changed since we downloaded them. List-style games update themselves. */
async function checkUpdates(server, mods) {
  const ours = mods.filter((m) => m.provider === 'workshop' && (m.file || m.folder || m.paks) && !m.disabled);
  if (!ours.length) return [];
  const details = await steam.details(ours.map((m) => m.projectId));
  return details
    .map((d) => {
      const mod = ours.find((m) => m.projectId === d.id);
      if (!mod || !d.updated || d.updated <= (mod.updated || 0)) return null;
      return { key: mod.key, name: mod.name, current: mod.version, latest: new Date(d.updated * 1000).toISOString().slice(0, 10), versionId: String(d.updated) };
    })
    .filter(Boolean);
}

async function refresh(server, template, mod, { manager, integrations } = {}) {
  if (!manager) fail(500, 'Workshop updates need the server manager');
  return installWorkshop(server, template, manager, { input: mod.projectId }, integrations);
}

module.exports = { installWorkshop, unlist, relist, purge, checkUpdates, refresh, editList, readKey, modArgument, editXmlMods, editDst, SE };
