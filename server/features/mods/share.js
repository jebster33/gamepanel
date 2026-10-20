'use strict';

/**
 * A public, read-only page for players: the mods they need on their own
 * computer to join a server. Off until an admin turns it on; it shows mod
 * names, versions and links (plus a .mrpack for Minecraft) and nothing else.
 *
 * settings.modShares[serverId] = { enabled, slug, notes, extras: [{ name, url, note }],
 *                                  collections: [{ id, title }] }
 */

const crypto = require('crypto');
const { fail } = require('../../core/util');
const compat = require('./compat');
const manifest = require('./manifest');
const modrinth = require('./providers/modrinth');
const steam = require('./providers/workshop');
const { mapLimit } = require('./http');
const zip = require('../../core/zip');

const MAX_EXTRAS = 30;
const MAX_MRPACK_FILES = 300;

const all = (store) => (store.state.settings.modShares ||= {});

function config(store, serverId) {
  return { enabled: false, slug: '', notes: '', extras: [], collections: [], ...(all(store)[serverId] || {}) };
}

function save(store, serverId, cfg) {
  all(store)[serverId] = cfg;
  store.save();
  return cfg;
}

function cleanUrl(value, label) {
  const url = String(value || '').trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(url) || url.length > 300) fail(400, `The ${label} link must start with https://`);
  return url;
}

/** Admin-facing settings, with the link the page lives at. */
function view(store, serverId) {
  return config(store, serverId);
}

function update(store, serverId, body) {
  const cfg = config(store, serverId);
  if (body.enabled !== undefined) cfg.enabled = Boolean(body.enabled);
  if (body.notes !== undefined) cfg.notes = String(body.notes).trim().slice(0, 600);
  if (Array.isArray(body.extras)) {
    cfg.extras = body.extras.slice(0, MAX_EXTRAS).map((e) => ({
      name: String(e?.name || '').trim().slice(0, 80) || fail(400, 'Every extra link needs a name'),
      url: cleanUrl(e?.url, 'extra'),
      note: String(e?.note || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 140),
    }));
  }
  if (body.newLink || !cfg.slug) cfg.slug = crypto.randomBytes(9).toString('base64url');
  return save(store, serverId, cfg);
}

/** Remember the Workshop collections a server was filled from, so players can subscribe in one click. */
async function addCollections(store, serverId, ids) {
  if (!ids?.length) return;
  const cfg = config(store, serverId);
  const fresh = [...new Set(ids.map(String))].filter((id) => !cfg.collections.some((c) => c.id === id));
  if (!fresh.length) return;
  const details = await steam.details(fresh).catch(() => []);
  for (const id of fresh) {
    const title = details.find((d) => d.id === id)?.title;
    cfg.collections.push({ id, title: String(title || `Collection ${id}`).slice(0, 120) });
  }
  cfg.collections = cfg.collections.slice(-20);
  save(store, serverId, cfg);
}

function removeCollection(store, serverId, id) {
  const cfg = config(store, serverId);
  cfg.collections = cfg.collections.filter((c) => c.id !== String(id));
  return save(store, serverId, cfg);
}

function forget(store, serverId) {
  delete all(store)[serverId];
}

/* ------------------------------------------------------- what players need -- */

const sideCache = new Map();

/** Modrinth says per project whether a client needs it; mods that came with a pack have no record, so ask. */
async function clientSides(mods) {
  const missing = mods.filter((m) => m.provider === 'modrinth' && !m.clientSide && !sideCache.has(m.projectId)).map((m) => m.projectId);
  if (missing.length) {
    const found = await modrinth.projects([...new Set(missing)]).catch(() => []);
    for (const p of found) sideCache.set(p.id, p.client_side);
  }
  return (m) => m.clientSide || sideCache.get(m.projectId) || null;
}

function loaderVersion(server) {
  return String(server.resolvedVersion || '').match(/(?:loader|forge|neoforge|quilt)\s+([\w.+-]+)/i)?.[1] || null;
}

/** The mods a player installs themselves. Server-only mods and plugins are left out. */
async function clientMods(server, template) {
  const ctx = compat.modContext(server, template);
  const entries = manifest.load(server).filter((m) => !m.disabled);
  const rows = [];
  const modded = ctx.projectType === 'mod';
  const sideOf = modded ? await clientSides(entries) : () => null;
  for (const m of entries) {
    if (m.provider === 'workshop') continue;
    const downloaded = (m.provider === 'modrinth' || m.provider === 'curseforge') && modded;
    if (!downloaded && m.provider !== 'factorio') continue;
    const side = m.provider === 'modrinth' ? sideOf(m) : null;
    if (side === 'unsupported') continue;
    rows.push({ key: m.key, provider: m.provider, name: m.name, version: m.version || null, url: m.url || null, icon: m.icon || null, side: side === 'optional' ? 'optional' : 'required' });
  }
  rows.sort((a, b) => (a.side === b.side ? a.name.localeCompare(b.name) : a.side === 'required' ? -1 : 1));
  const workshop = entries
    .filter((m) => m.provider === 'workshop')
    .map((m) => ({ name: m.name, url: m.url || `https://steamcommunity.com/sharedfiles/filedetails/?id=${m.projectId}`, icon: m.icon || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ctx, mods: rows, workshop };
}

const collectionUrl = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;

/** The public page's data. Nothing here goes beyond what the admin chose to share. */
async function publicView(store, manager, slug) {
  const hit = Object.entries(all(store)).find(([, c]) => c.enabled && c.slug && c.slug === slug);
  const server = hit && manager.servers.find((s) => s.id === hit[0]);
  if (!server) return null;
  const cfg = config(store, server.id);
  const template = manager.template(server);
  if (!template?.mods) return null;
  const { ctx, mods, workshop } = await clientMods(server, template);
  const minecraft = ctx.game === 'minecraft' && ctx.projectType === 'mod';
  return {
    title: store.state.settings.panelName || 'GamePanel',
    server: server.name,
    game: template.name,
    gameVersion: minecraft ? ctx.gameVersion || null : null,
    loader: minecraft ? ctx.loaderLabel : null,
    loaderVersion: minecraft ? loaderVersion(server) : null,
    notes: cfg.notes,
    mods,
    workshop: { items: workshop, collections: cfg.collections.map((c) => ({ title: c.title, url: collectionUrl(c.id) })) },
    extras: cfg.extras,
    pack: minecraft && mods.some((m) => m.provider === 'modrinth'),
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------- .mrpack -- */

const LOADER_KEY = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' };

/**
 * A Modrinth modpack (opens in the Modrinth app, Prism and other launchers)
 * holding the Modrinth mods players need. Other sources are links only: their
 * licences often forbid putting the files in someone else's pack.
 */
async function mrpack(store, manager, slug) {
  const hit = Object.entries(all(store)).find(([, c]) => c.enabled && c.slug && c.slug === slug);
  const server = hit && manager.servers.find((s) => s.id === hit[0]);
  const template = server && manager.template(server);
  if (!template?.mods) return null;
  const { ctx, mods } = await clientMods(server, template);
  if (ctx.game !== 'minecraft' || ctx.projectType !== 'mod') fail(400, 'Only modded Minecraft servers have a modpack download');
  const wanted = mods.filter((m) => m.provider === 'modrinth');
  if (!wanted.length) fail(404, 'No Modrinth mods to put in a pack');
  const versionIds = new Map(manifest.load(server).map((m) => [m.key, m.versionId]));

  const files = (
    await mapLimit(wanted.slice(0, MAX_MRPACK_FILES), 4, async (m) => {
      const v = await modrinth.version(versionIds.get(m.key)).catch(() => null);
      if (!v?.file?.url || !v.file.sha1 || !v.file.sha512) return null;
      return {
        path: `mods/${v.file.filename.replace(/[^\w.+\-()\[\] ]/g, '_')}`,
        hashes: { sha1: v.file.sha1, sha512: v.file.sha512 },
        env: { client: m.side, server: 'unsupported' },
        downloads: [v.file.url],
        fileSize: v.file.size,
      };
    })
  ).filter(Boolean);
  if (!files.length) fail(502, 'Could not look up the mod files on Modrinth. Try again in a moment.');

  const dependencies = { minecraft: ctx.gameVersion };
  const loaderKey = LOADER_KEY[ctx.loader];
  const loaderVer = loaderVersion(server);
  if (loaderKey && loaderVer) dependencies[loaderKey] = loaderVer;
  if (!ctx.gameVersion) fail(400, "This server's Minecraft version is not known yet; start it once first");

  const index = { formatVersion: 1, game: 'minecraft', versionId: new Date().toISOString().slice(0, 10), name: server.name.slice(0, 60), summary: `Mods for ${server.name}`, files, dependencies };
  return { filename: `${server.name.replace(/[^\w.-]+/g, '_').slice(0, 50) || 'server'}.mrpack`, data: zip.build({ 'modrinth.index.json': JSON.stringify(index, null, 2) }, { deflate: true }) };
}

module.exports = { view, update, publicView, mrpack, addCollections, removeCollection, forget, config };
