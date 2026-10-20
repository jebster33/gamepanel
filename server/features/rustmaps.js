'use strict';

/**
 * RustMaps (rustmaps.com) for Rust servers:
 *
 *   - a preview link for the server's size and seed (no key needed)
 *   - custom maps with chosen monuments left out, generated through the
 *     RustMaps API with the owner's own key (a subscription with custom map
 *     access), then downloaded into custom-maps/ and selected as the map
 *
 * The key lives in settings.integrations.rustmapsKey, sealed (core/secrets.js).
 * RustMaps API: https://api.rustmaps.com/docs
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { fail, logger } = require('../core/util');
const secrets = require('../core/secrets');
const { containedPath } = require('./files');
const rustMaps = require('./rust-maps');

const API = 'https://api.rustmaps.com/v4';
const MAX_MAP_BYTES = 512 * 1024 * 1024;
const POLL_MS = 5000;
const GIVE_UP_MS = 45 * 60_000;
/** The groups of the default custom settings that hold monument types. */
const GROUPS = ['safezones', 'largeMonuments', 'smallMonuments', 'harbors', 'waterWells', 'caves', 'mountains', 'quarries', 'icebergs', 'iceLakes', 'ruins'];
const GROUP_LABELS = { safezones: 'Safe zones', largeMonuments: 'Large monuments', smallMonuments: 'Small monuments', harbors: 'Harbors', waterWells: 'Water wells', caves: 'Caves', mountains: 'Mountains', quarries: 'Quarries', icebergs: 'Icebergs', iceLakes: 'Ice lakes', ruins: 'Ruins' };

const jobs = new Map(); // server id -> { state, message, error, file }

const keyOf = (store) => secrets.open(store.state.settings.integrations?.rustmapsKey || '');

/** The RustMaps page for a size and seed. */
const previewUrl = (size, seed) => `https://rustmaps.com/map/${Number(size)}_${Number(seed)}`;

function describe(manager, store, server) {
  const vars = manager.vars(server);
  const size = Number(vars.WORLD_SIZE);
  const seed = Number(vars.WORLD_SEED);
  return {
    keySet: Boolean(keyOf(store)),
    preview: Number.isFinite(size) && Number.isFinite(seed) ? { size, seed, url: previewUrl(size, seed) } : null,
    job: jobs.get(server.id) || null,
  };
}

async function call(store, method, endpoint, body) {
  const key = keyOf(store);
  if (!key) fail(400, 'Add your RustMaps API key in Settings, Integrations first');
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: { 'X-API-Key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = typeof json.data === 'string' ? json.data : json.meta?.errors?.join?.(', ') || '';
    fail(res.status === 401 ? 400 : 502, `RustMaps answered ${res.status}${why ? `: ${why}` : ''}`);
  }
  return { status: res.status, data: json.data };
}

/** The monument types RustMaps accepts, with the saved configs from the account's dashboard. */
async function monuments(store) {
  const { data: defaults } = await call(store, 'GET', '/maps/custom');
  const groups = GROUPS.filter((g) => Array.isArray(defaults?.[g]) && defaults[g].length).map((g) => ({
    group: g,
    label: GROUP_LABELS[g],
    types: defaults[g].map((m) => ({ type: m.type, blocked: Boolean(m.blocked) })),
  }));
  const saved = await call(store, 'GET', '/maps/custom/saved-configs').then((r) => (r.data || []).map((c) => c.name)).catch(() => []);
  return { groups, savedConfigs: saved };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(manager, store, server, { blocked, savedConfig }, job) {
  const vars = manager.vars(server);
  const mapParameters = { size: Number(vars.WORLD_SIZE), seed: Number(vars.WORLD_SEED), staging: false };
  let created;
  if (savedConfig) {
    created = await call(store, 'POST', '/maps/custom/saved-config', { mapParameters, configName: savedConfig });
  } else {
    // Start from RustMaps' own defaults so only what was picked changes.
    const { data: settings } = await call(store, 'GET', '/maps/custom');
    for (const g of GROUPS) for (const m of settings?.[g] || []) if (blocked.includes(m.type)) m.blocked = true;
    created = await call(store, 'POST', '/maps/custom', { mapParameters, customMapSettings: settings });
  }
  const mapId = typeof created.data === 'string' ? created.data : created.data?.mapId || created.data?.id;
  if (!mapId || !/^[A-Za-z0-9-]{4,64}$/.test(String(mapId))) throw new Error('RustMaps did not return a map id');

  const started = Date.now();
  let map = null;
  while (Date.now() - started < GIVE_UP_MS) {
    await sleep(POLL_MS);
    const status = await call(store, 'GET', `/maps/${mapId}/status`).then((r) => r.data, () => null);
    if (status?.state === 'Cancelled') throw new Error('RustMaps cancelled the map');
    job.message = status?.state === 'InQueue' ? `In the RustMaps queue${status.queuePosition ? ` (place ${status.queuePosition})` : ''}` : `Generating${status?.currentStep ? `: ${status.currentStep}` : ''}`;
    if (status && !['InQueue', 'Generating', 'Processing', 'Uploading'].includes(status.state)) {
      const got = await call(store, 'GET', `/maps/${mapId}`).catch(() => null);
      if (got?.status === 200) {
        if (!got.data?.downloadUrl) throw new Error('RustMaps made the map but offers no download; custom maps need a subscription with custom map access');
        map = got.data;
        break;
      }
    }
  }
  if (!map) throw new Error('RustMaps did not finish the map in time; check your RustMaps dashboard');

  job.message = 'Downloading the map';
  const url = new URL(map.downloadUrl);
  if (url.protocol !== 'https:') throw new Error('RustMaps gave a download link that is not https');
  const name = `rustmaps-${mapParameters.size}-${mapParameters.seed}-${crypto.randomBytes(3).toString('hex')}.map`;
  const dir = containedPath(server.dir, rustMaps.DIR);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`The map download answered ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_MAP_BYTES) throw new Error('The map is larger than 512 MB');
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));
    if (fs.statSync(target).size > MAX_MAP_BYTES) throw new Error('The map is larger than 512 MB');
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw err;
  }
  rustMaps.set(manager, store, server, { mode: 'file', file: name });
  // The picture for the live map; the map works without it.
  const picture = map.imageIconUrl || map.imageUrl;
  if (picture) await require('./rust-livemap').saveFromUrl(manager, server, picture, name).catch((err) => logger.debug(`Live map picture: ${err.message}`));
  return name;
}

/** Start generating in the background; progress is read with describe(). */
function generate(manager, store, server, input = {}) {
  if (jobs.get(server.id)?.state === 'running') fail(409, 'A map is already being generated for this server');
  const blocked = (Array.isArray(input.blocked) ? input.blocked : []).map(String).slice(0, 100);
  const savedConfig = input.savedConfig ? String(input.savedConfig).slice(0, 100) : '';
  if (!savedConfig && !blocked.length) fail(400, 'Pick at least one monument to leave out, or a saved config');
  if (!keyOf(store)) fail(400, 'Add your RustMaps API key in Settings, Integrations first');
  const job = { state: 'running', message: 'Asking RustMaps', startedAt: Date.now(), file: null, error: null };
  jobs.set(server.id, job);
  run(manager, store, server, { blocked, savedConfig }, job).then(
    (file) => {
      job.state = 'done';
      job.file = file;
      job.message = 'Done. Wipe to load the new map.';
      store.addEvent('server.rustmaps', `${server.name} got a custom RustMaps map (${file})`, { serverId: server.id });
    },
    (err) => {
      job.state = 'failed';
      job.error = err.message;
      logger.warn(`RustMaps map for ${server.name} failed: ${err.message}`);
    }
  );
  return job;
}

/** A picture of the generated map for a size and seed, if the key is set and RustMaps has it; else null. */
async function thumbnail(store, size, seed) {
  if (!keyOf(store)) return null;
  const { data } = await call(store, 'GET', `/maps/${Number(size)}/${Number(seed)}?staging=false`).catch(() => ({}));
  const image = data?.thumbnailUrl || data?.imageUrl || '';
  try {
    const url = new URL(image);
    return url.protocol === 'https:' && /(^|\.)rustmaps\.com$/.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/** A fresh random seed for the server; the preview link follows it. */
function randomSeed(manager, server) {
  const seed = crypto.randomInt(1, 2_147_483_647);
  manager.update(server.id, { vars: { WORLD_SEED: seed } });
  return seed;
}

module.exports = { describe, monuments, generate, randomSeed, previewUrl, thumbnail };
