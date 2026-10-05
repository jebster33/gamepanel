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

/** Download one item with SteamCMD into the server, in the server's own runtime. */
async function download(manager, server, ctx, item, dest) {
  const result = await manager.runTask(server, {
    label: `Downloading "${item.title}" from the Workshop`,
    steps: [{ type: 'workshop', appid: ctx.appId, item: item.id, dest }],
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
  const items = await resolveItems(input, ctx, integrations.steamApiKey);
  const names = items.map((i) => i.title);

  if (spec.strategy === 'list') {
    saveEntries(server, await strategy(server, ctx, spec, items, manager));
    return { ok: true, queued: false, items: names, message: `Added ${names.length} item(s). The server downloads them the next time it starts.` };
  }

  strategy(server, ctx, spec, items, manager)
    .then((entries) => {
      saveEntries(server, entries);
      manager.pushConsole(server, `Workshop: installed ${entries.map((e) => e.name).join(', ')}`, 'system');
      if (spec.strategy === 'zomboid') manager.pushConsole(server, 'The server downloads Workshop items itself when it next starts.', 'system');
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
  if (entry.strategy === 'zomboid') {
    editList(server, { ...spec, separator: ';' }, 'WorkshopItems', { remove: [entry.projectId] });
    editList(server, { ...spec, separator: ';' }, 'Mods', { remove: entry.modIds || [] });
  }
}

async function relist(server, template, entry) {
  const spec = strategyOf(template);
  if (entry.strategy === 'list') editList(server, spec, spec.key, { add: [entry.projectId] });
  if (entry.strategy === 'zomboid') {
    editList(server, { ...spec, separator: ';' }, 'WorkshopItems', { add: [entry.projectId] });
    editList(server, { ...spec, separator: ';' }, 'Mods', { add: entry.modIds || [] });
  }
}

/** Items whose Workshop page changed since we downloaded them. List-style games update themselves. */
async function checkUpdates(server, mods) {
  const ours = mods.filter((m) => m.provider === 'workshop' && m.file && !m.disabled);
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

module.exports = { installWorkshop, unlist, relist, checkUpdates, refresh, editList, readKey };
