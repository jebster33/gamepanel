'use strict';

/**
 * ARK clusters: servers (maps) that share one cluster directory, so players can
 * upload a character, items or dinos at an obelisk or terminal on one map and
 * download them on another. Works for ARK: Survival Evolved and Ascended; the
 * two games cannot be mixed.
 *
 * Every server in a cluster is started with -clusterid and -ClusterDirOverride
 * (through the CLUSTER_ARGS variable of its start command). The shared
 * directory lives in the panel's data folder, so only servers on this machine
 * can be members; a server running in Docker gets it mounted at CLUSTER_MOUNT.
 * What may be transferred is written to each server's GameUserSettings.ini
 * before it starts.
 *
 * store.state.arkClusters = [{ id, name, templateId, servers: [serverId], options, createdAt, updatedAt }]
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { uid, fail, logger } = require('../core/util');
const { patchKeyValue } = require('../servers/config-files');
const { containedPath } = require('./files');

const TEMPLATES = { 'ark-survival-evolved': 'ARK: Survival Evolved', 'ark-survival-ascended': 'ARK: Survival Ascended' };
const CLUSTER_MOUNT = '/home/cluster';

// Transfer switches, as the game's ini keys: true = players may do it.
const SWITCHES = {
  uploadSurvivors: 'PreventUploadSurvivors',
  downloadSurvivors: 'PreventDownloadSurvivors',
  uploadItems: 'PreventUploadItems',
  downloadItems: 'PreventDownloadItems',
  uploadDinos: 'PreventUploadDinos',
  downloadDinos: 'PreventDownloadDinos',
};
// Optional timers in seconds; 0 leaves the game's default.
const TIMERS = {
  survivorExpirySeconds: 'TributeCharacterExpirationSeconds',
  itemExpirySeconds: 'TributeItemExpirationSeconds',
  dinoExpirySeconds: 'TributeDinoExpirationSeconds',
  dinoReuploadSeconds: 'MinimumDinoReuploadInterval',
};
const DEFAULTS = { ...Object.fromEntries(Object.keys(SWITCHES).map((k) => [k, true])), noTransferFromFiltering: true, ...Object.fromEntries(Object.keys(TIMERS).map((k) => [k, 0])) };

const listOf = (store) => (store.state.arkClusters ||= []);
const dirOf = (cluster) => path.join(config.dataDir, 'clusters', cluster.id);
const clusterIdOf = (cluster) => `gp${cluster.id}`;

function options(input = {}, current = DEFAULTS) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const v = input[key] ?? current[key] ?? DEFAULTS[key];
    if (typeof DEFAULTS[key] === 'boolean') out[key] = v === true || v === 'true';
    else {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 0 || n > 31536000) fail(400, 'Timers must be a number of seconds (0 keeps the game default)');
      out[key] = n;
    }
  }
  return out;
}

function check(manager, store, input, current = null) {
  const name = String(input.name ?? current?.name ?? '').trim().slice(0, 40);
  if (!name) fail(400, 'Name the cluster');
  const ids = [...new Set((input.servers ?? current?.servers ?? []).map(String))];
  if (!ids.length) fail(400, 'Add at least one server');
  let templateId = current?.templateId || null;
  for (const id of ids) {
    if (id.includes('~')) fail(400, 'Servers on another node cannot join a cluster: they would not share its folder');
    const server = manager.servers.find((s) => s.id === id);
    if (!server) fail(400, 'One of the servers no longer exists');
    if (!TEMPLATES[server.templateId]) fail(400, `${server.name} is not an ARK server`);
    templateId ||= server.templateId;
    if (server.templateId !== templateId) fail(400, 'ARK: Survival Evolved and Ascended servers cannot share a cluster');
    const other = listOf(store).find((c) => c.id !== current?.id && c.servers.includes(id));
    if (other) fail(409, `${server.name} is already in the cluster ${other.name}`);
  }
  return { name, templateId, servers: ids, options: options(input.options, current?.options) };
}

/* ------------------------------------------------------------- applying -- */

const clusterOf = (store, serverId) => listOf(store).find((c) => c.servers.includes(serverId));

/** Where the game sees the shared folder. */
const mountOf = (manager, server, cluster) => (manager.runtimeFor(server) === 'docker' ? CLUSTER_MOUNT : dirOf(cluster));

/** The CLUSTER_ARGS start-command variable. Empty for a server outside any cluster. */
function argsFor(manager, store, server) {
  const cluster = clusterOf(store, server.id);
  if (!cluster) return '';
  const args = [`-clusterid=${clusterIdOf(cluster)}`, `-ClusterDirOverride="${mountOf(manager, server, cluster)}"`];
  if (cluster.options.noTransferFromFiltering) args.push('-NoTransferFromFiltering');
  return args.join(' ');
}

/** The host folder a Docker server needs mounted, or null. */
function mountFor(manager, store, server) {
  const cluster = clusterOf(store, server.id);
  if (!cluster) return null;
  fs.mkdirSync(dirOf(cluster), { recursive: true });
  return { host: dirOf(cluster), container: CLUSTER_MOUNT };
}

function iniPath(manager, server) {
  const side = process.platform === 'win32' && manager.runtimeFor(server) !== 'docker' ? 'WindowsServer' : 'LinuxServer';
  return containedPath(server.dir, `ShooterGame/Saved/Config/${side}/GameUserSettings.ini`);
}

/** Transfer switches and timers into one server's GameUserSettings.ini. */
function writeServer(manager, server, opts) {
  const values = {};
  for (const [key, ini] of Object.entries(SWITCHES)) values[ini] = opts && !opts[key] ? 'True' : 'False';
  for (const [key, ini] of Object.entries(TIMERS)) if (opts?.[key]) values[ini] = String(opts[key]);
  const file = iniPath(manager, server);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!existing && !opts) return; // nothing to undo
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, patchKeyValue(existing, values, { section: 'ServerSettings' }));
}

function apply(manager, store, cluster) {
  const kept = cluster.servers.filter((id) => manager.servers.some((s) => s.id === id));
  if (kept.length !== cluster.servers.length) {
    cluster.servers = kept;
    store.save();
  }
  if (!kept.length) return;
  fs.mkdirSync(dirOf(cluster), { recursive: true });
  for (const id of kept) writeServer(manager, manager.require(id), cluster.options);
}

function release(manager, serverId) {
  const server = manager.servers.find((s) => s.id === serverId);
  if (!server) return;
  try {
    writeServer(manager, server, null);
  } catch (err) {
    logger.warn(`Could not take ${server.name} out of its cluster: ${err.message}`);
  }
}

/** Write one server's settings again just before it starts (called from power.js). */
function prepare(manager, store, serverId) {
  const cluster = clusterOf(store, serverId);
  if (!cluster) return;
  try {
    apply(manager, store, cluster);
  } catch (err) {
    logger.warn(`Cluster ${cluster.name}: ${err.message}`);
  }
}

/** Running servers need a restart to pick the changes up. */
function needsRestart(manager, cluster) {
  const changed = cluster.updatedAt || cluster.createdAt || 0;
  return cluster.servers.filter((id) => manager.isActive(id) && (manager.rt(id).startedAt || 0) < changed);
}

/* --------------------------------------------------------------- the API -- */

function create(manager, store, input, actor) {
  const data = check(manager, store, input);
  const cluster = { id: uid(8), ...data, createdAt: Date.now(), updatedAt: Date.now() };
  listOf(store).push(cluster);
  store.save();
  apply(manager, store, cluster);
  store.addEvent('cluster.created', `${actor?.username || 'Someone'} linked ${cluster.servers.length} ARK server(s) as the cluster ${cluster.name}`);
  return view(manager, cluster);
}

function update(manager, store, id, input) {
  const cluster = listOf(store).find((c) => c.id === id);
  if (!cluster) fail(404, 'Cluster not found');
  const before = cluster.servers;
  Object.assign(cluster, check(manager, store, input, cluster), { updatedAt: Date.now() });
  store.save();
  for (const sid of before) if (!cluster.servers.includes(sid)) release(manager, sid);
  apply(manager, store, cluster);
  return view(manager, cluster);
}

function remove(manager, store, id) {
  const cluster = listOf(store).find((c) => c.id === id);
  if (!cluster) fail(404, 'Cluster not found');
  for (const sid of cluster.servers) release(manager, sid);
  store.state.arkClusters = listOf(store).filter((c) => c !== cluster);
  store.save();
  // The shared folder (uploaded characters and dinos) is kept in case the cluster is rebuilt.
  return { ok: true, restart: needsRestart(manager, cluster), keptFolder: dirOf(cluster) };
}

function view(manager, cluster) {
  return {
    id: cluster.id,
    name: cluster.name,
    templateId: cluster.templateId,
    game: TEMPLATES[cluster.templateId],
    options: cluster.options,
    servers: cluster.servers.map((id) => {
      const s = manager.servers.find((x) => x.id === id);
      return s ? { id: s.id, name: s.name, status: manager.rt(s.id).status, port: s.ports?.game, map: s.vars?.MAP || null } : { id, missing: true };
    }),
    restart: needsRestart(manager, cluster),
    createdAt: cluster.createdAt,
  };
}

function list(manager, store) {
  for (const cluster of listOf(store)) apply(manager, store, cluster);
  return {
    clusters: listOf(store).map((c) => view(manager, c)),
    servers: manager.servers.filter((s) => TEMPLATES[s.templateId]).map((s) => ({ id: s.id, name: s.name, templateId: s.templateId, map: s.vars?.MAP || null })),
    games: TEMPLATES,
    defaults: DEFAULTS,
  };
}

module.exports = { list, create, update, remove, argsFor, mountFor, prepare, listOf, dirOf, TEMPLATES, DEFAULTS, CLUSTER_MOUNT };
