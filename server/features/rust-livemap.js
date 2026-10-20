'use strict';

/**
 * Live map for Rust servers. A small Oxide plugin (rust-livemap/GamePanelMap.cs)
 * answers `gamepanel.map` over RCON with positions as JSON; the panel polls it,
 * keeps the slow parts (monuments, bases) cached, and serves the map picture:
 * the RustMaps render for the size and seed (needs the owner's RustMaps key),
 * the image of a custom map the panel generated, or a picture uploaded by hand.
 *
 * Positions are sensitive, so every route needs the server's console permission.
 */

const fs = require('fs');
const path = require('path');
const { fail, logger } = require('../core/util');
const secrets = require('../core/secrets');
const { containedPath } = require('./files');
const { rconAny } = require('../games/webrcon');

const PLUGIN_SOURCE = path.join(__dirname, 'rust-livemap', 'GamePanelMap.cs');
const PLUGIN_FILE = 'oxide/plugins/GamePanelMap.cs';
const IMAGE_DIR = 'custom-maps';
const MAX_IMAGE = 25 * 1024 * 1024;
const POLL_TTL = 3000;
const BASES_TTL = 30_000;
const MAX_PAGES = 12;

const cache = new Map(); // server id -> { at, data, info, bases }

const hasRcon = (manager, server) => Boolean(manager.template(server)?.rcon && manager.vars(server).RCON_PASSWORD);

function ask(manager, server, command) {
  const template = manager.template(server);
  return rconAny({ host: '127.0.0.1', port: server.ports[template.rcon.port || 'rcon'], password: manager.vars(server).RCON_PASSWORD, command });
}

/** The JSON object in an RCON answer (the game may add other lines around it). */
function parseReply(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** Every page of one plugin command, merged on `key`. */
async function pages(manager, server, what, key) {
  let out = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const reply = parseReply(await ask(manager, server, `gamepanel.map ${what} ${page}`));
    if (!reply) return out;
    if (!out) out = { ...reply, [key]: [] };
    out[key].push(...(reply[key] || []));
    if (!reply.more) break;
  }
  return out;
}

const pluginPath = (server) => containedPath(server.dir, PLUGIN_FILE);

function pluginState(server) {
  try {
    const have = fs.readFileSync(pluginPath(server), 'utf8');
    return have === fs.readFileSync(PLUGIN_SOURCE, 'utf8') ? 'installed' : 'outdated';
  } catch {
    return 'missing';
  }
}

function installPlugin(manager, server) {
  const oxideOn = String(manager.vars(server).INSTALL_OXIDE) === 'true';
  const target = pluginPath(server);
  if (!oxideOn && !fs.existsSync(path.dirname(target))) fail(400, 'The live map needs uMod/Oxide. Turn on "Install uMod/Oxide" for this server and reinstall or update it first.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(PLUGIN_SOURCE, target);
  cache.delete(server.id);
  return pluginState(server);
}

/* --------------------------------------------------------------- image */

const imageMeta = (server) => server.liveMap?.image || null;

function sniff(buf) {
  if (buf.length > 8 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

function saveImage(manager, server, buf, meta) {
  const ext = sniff(buf);
  if (!ext) fail(400, 'That is not a PNG or JPEG picture');
  if (buf.length > MAX_IMAGE) fail(413, 'The picture is larger than 25 MB');
  const dir = containedPath(server.dir, IMAGE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const old of ['png', 'jpg']) fs.rmSync(path.join(dir, `live-map.${old}`), { force: true });
  fs.writeFileSync(path.join(dir, `live-map.${ext}`), buf);
  server.liveMap = { ...(server.liveMap || {}), image: { ...meta, file: `live-map.${ext}`, at: Date.now() } };
  manager.store.save();
  return server.liveMap.image;
}

async function downloadImage(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('The map picture link is not https');
  const res = await fetch(u, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`The map picture download answered ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_IMAGE) throw new Error('The map picture is larger than 25 MB');
  return Buffer.from(await res.arrayBuffer());
}

/** Keep the picture of a custom map the panel just generated (called from rustmaps.js). */
async function saveFromUrl(manager, server, url, key) {
  saveImage(manager, server, await downloadImage(url), { source: 'custom', key });
}

const procKey = (manager, server) => `${manager.vars(server).WORLD_SIZE}_${manager.vars(server).WORLD_SEED}`;
const fetching = new Map();

/** The RustMaps render for this size and seed, fetched once and cached on disk. */
async function fetchProcedural(manager, store, server) {
  if ((server.map?.mode || 'procedural') !== 'procedural') return;
  const key = procKey(manager, server);
  const have = imageMeta(server);
  if (have && (have.source === 'upload' || have.key === key)) return;
  const apiKey = secrets.open(store.state.settings.integrations?.rustmapsKey || '');
  if (!apiKey || fetching.has(server.id)) return;
  fetching.set(server.id, true);
  try {
    const [size, seed] = key.split('_');
    const res = await fetch(`https://api.rustmaps.com/v4/maps/${Number(size)}/${Number(seed)}`, { headers: { 'X-API-Key': apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    const json = await res.json().catch(() => ({}));
    const url = json.data?.imageIconUrl || json.data?.imageUrl;
    if (!res.ok || !url) throw new Error(res.status === 404 ? 'RustMaps has not rendered this seed yet' : `RustMaps answered ${res.status}`);
    saveImage(manager, server, await downloadImage(url), { source: 'rustmaps', key });
  } catch (err) {
    server.liveMap = { ...(server.liveMap || {}), imageError: err.message };
    logger.debug(`Live map picture for ${server.name}: ${err.message}`);
  } finally {
    fetching.delete(server.id);
  }
}

function uploadImage(manager, server, buf) {
  return saveImage(manager, server, buf, { source: 'upload', key: 'upload' });
}

function clearUploaded(manager, server) {
  if (server.liveMap?.image?.source === 'upload') {
    try {
      fs.rmSync(containedPath(server.dir, `${IMAGE_DIR}/${server.liveMap.image.file}`), { force: true });
    } catch {
      /* gone already */
    }
    delete server.liveMap.image;
    manager.store.save();
  }
}

function openImage(server) {
  const meta = imageMeta(server);
  if (!meta || !/^live-map\.(png|jpg)$/.test(meta.file || '')) return null;
  try {
    const file = containedPath(server.dir, `${IMAGE_DIR}/${meta.file}`);
    return { file, size: fs.statSync(file).size, type: meta.file.endsWith('png') ? 'image/png' : 'image/jpeg', at: meta.at };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ snapshot */

/** What the map page needs, polled every few seconds. */
async function snapshot(manager, store, server) {
  const out = { running: server.status === 'running', plugin: pluginState(server), size: Number(manager.vars(server).WORLD_SIZE) || 3500, image: null, imageError: server.liveMap?.imageError || null, oxide: String(manager.vars(server).INSTALL_OXIDE) === 'true' };
  const meta = imageMeta(server);
  if (meta) out.image = { source: meta.source, at: meta.at, stale: meta.source === 'rustmaps' && meta.key !== procKey(manager, server) };
  fetchProcedural(manager, store, server); // in the background; the next poll has it
  if (!out.running || !hasRcon(manager, server)) return { ...out, live: false };

  const entry = cache.get(server.id) || {};
  if (entry.data && Date.now() - entry.at < POLL_TTL) return { ...out, ...entry.data };
  const data = { live: false, players: [], events: [], monuments: entry.info?.monuments || [], bases: entry.bases?.list || [], sleepers: 0 };
  try {
    const players = await pages(manager, server, 'players', 'players');
    if (players) {
      data.live = true;
      data.sleepers = players.sleepers || 0;
      data.players = players.players.map(([id, name, x, z, hp, team]) => ({ id, name, x, z, hp, team }));
      if (!entry.info || entry.info.key !== procKey(manager, server)) {
        const info = await pages(manager, server, 'info', 'monuments');
        if (info) entry.info = { key: procKey(manager, server), size: info.size, monuments: info.monuments.map(([name, x, z]) => ({ name, x, z })) };
      }
      if (entry.info) {
        data.monuments = entry.info.monuments;
        if (entry.info.size) data.size = entry.info.size;
      }
      const events = parseReply(await ask(manager, server, 'gamepanel.map events'));
      data.events = (events?.events || []).map(([kind, x, z]) => ({ kind, x, z }));
      if (!entry.bases || Date.now() - entry.bases.at > BASES_TTL) {
        const bases = await pages(manager, server, 'bases', 'bases');
        if (bases) entry.bases = { at: Date.now(), list: bases.bases.map(([owner, name, x, z, members]) => ({ owner, name, x, z, members })) };
      }
      data.bases = entry.bases?.list || [];
    }
  } catch (err) {
    data.error = err.message;
  }
  if (!data.live && !data.error) data.error = 'The map plugin did not answer. Install it, or wait a moment after installing.';
  cache.set(server.id, { ...entry, at: Date.now(), data });
  return { ...out, ...data, size: data.size || out.size };
}

module.exports = { snapshot, installPlugin, pluginState, uploadImage, clearUploaded, openImage, saveFromUrl, parseReply, sniff };
