'use strict';

/**
 * Minecraft networks: one Velocity proxy in front of several Paper or Purpur
 * servers (a lobby, survival, minigames). Players join the proxy's address
 * and move between servers with /server, without reconnecting.
 *
 * The panel writes both ends of Velocity's "modern" forwarding: the proxy's
 * [servers] list and secret, and on every server behind it online-mode=false
 * plus proxies.velocity in paper-global.yml. Those servers then refuse anyone
 * who did not come through the proxy with the secret, so they cannot be
 * joined directly in offline mode.
 *
 * store.state.networks = [{ id, name, proxyId, servers: [{ serverId, name }], secret (sealed), createdAt }]
 * The first server in the list is where players land (Velocity's "try" list).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uid, fail, logger } = require('../core/util');
const secrets = require('../core/secrets');
const forms = require('./config-forms');
const { patchKeyValue } = require('../servers/config-files');

const BACKENDS = ['minecraft-paper', 'minecraft-purpur'];
const PROXY = 'minecraft-velocity';
const NAME_RE = /^[a-z0-9_-]{1,32}$/;

const listOf = (store) => (store.state.networks ||= []);
const slug = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'server';

/** Where the proxy reaches a server: the host itself, or the host as seen from a container. */
function addressOf(manager, proxy, server) {
  const host = manager.runtimeFor(proxy) === 'docker' ? 'host.docker.internal' : '127.0.0.1';
  return `${host}:${server.ports.game}`;
}

function check(manager, store, input, current = null) {
  const name = String(input.name ?? current?.name ?? '').trim().slice(0, 40);
  if (!name) fail(400, 'Name the network');
  const proxy = manager.servers.find((s) => s.id === (input.proxyId ?? current?.proxyId));
  if (!proxy || proxy.templateId !== PROXY) fail(400, 'Pick a Velocity proxy server');
  const entries = (input.servers ?? current?.servers ?? []).map((e) => ({ serverId: String(e.serverId), name: slug(e.name || manager.servers.find((s) => s.id === e.serverId)?.name) }));
  if (!entries.length) fail(400, 'Add at least one server for players to land on');
  const seen = new Set();
  for (const e of entries) {
    const server = manager.servers.find((s) => s.id === e.serverId);
    if (!server) fail(400, 'One of the servers no longer exists');
    if (!BACKENDS.includes(server.templateId)) fail(400, `${server.name} is not a Paper or Purpur server; only those can sit behind Velocity here`);
    if (!NAME_RE.test(e.name) || seen.has(e.name)) fail(400, `Give each server a different short name (letters, numbers, - and _): "${e.name}"`);
    seen.add(e.name);
    const other = listOf(store).find((n) => n.id !== current?.id && n.servers.some((x) => x.serverId === e.serverId));
    if (other) fail(409, `${server.name} is already in the network ${other.name}`);
  }
  const busyProxy = listOf(store).find((n) => n.id !== current?.id && n.proxyId === proxy.id);
  if (busyProxy) fail(409, `That proxy already runs the network ${busyProxy.name}`);
  return { name, proxyId: proxy.id, servers: entries };
}

/* ------------------------------------------------------------- applying -- */

/** velocity.toml: the [servers] table, forwarding mode and the secret file. */
function writeProxy(manager, network, secret) {
  const proxy = manager.require(network.proxyId);
  const file = path.join(proxy.dir, 'velocity.toml');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!text) {
    manager.writeConfigFiles(proxy, manager.template(proxy), { overwrite: false });
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }
  text = patchKeyValue(text, { 'player-info-forwarding-mode': '"modern"', 'forwarding-secret-file': '"forwarding.secret"' });
  const lines = network.servers.map((e) => `${e.name} = "${addressOf(manager, proxy, manager.require(e.serverId))}"`);
  const block = ['[servers]', '# Managed by GamePanel (Networks page).', ...lines, `try = [${network.servers.slice(0, 1).map((e) => `"${e.name}"`).join(', ')}]`, ''].join('\n');
  // Replace the whole [servers] table, up to the next table.
  const re = /^\[servers\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/m;
  text = re.test(text) ? text.replace(re, `${block}\n`) : `${text.replace(/\s*$/, '\n\n')}${block}\n`;
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(proxy.dir, 'forwarding.secret'), secret, { mode: 0o600 });
}

/** server.properties and paper-global.yml on a server behind the proxy. */
function writeBackend(manager, server, secret, on) {
  const props = path.join(server.dir, 'server.properties');
  const existing = fs.existsSync(props) ? fs.readFileSync(props, 'utf8') : '';
  fs.writeFileSync(props, patchKeyValue(existing, { 'online-mode': on ? 'false' : 'true' }));

  const global = path.join(server.dir, 'config', 'paper-global.yml');
  const values = { 'proxies.velocity.enabled': on, 'proxies.velocity.online-mode': true, 'proxies.velocity.secret': on ? secret : '' };
  if (fs.existsSync(global)) {
    const text = fs.readFileSync(global, 'utf8');
    const fields = new Set(forms.parse(text, 'yaml').map((f) => f.id));
    if (Object.keys(values).every((k) => fields.has(k))) {
      fs.writeFileSync(global, forms.apply(text, 'yaml', values));
      return;
    }
    if (!on) return;
    logger.warn(`${server.name}: paper-global.yml has no proxies.velocity section; adding one`);
    fs.writeFileSync(global, `${text.replace(/\s*$/, '\n')}${velocityYaml(secret)}`);
    return;
  }
  if (!on) return;
  // Not started yet: Paper keeps these and fills in the rest on first start.
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.writeFileSync(global, velocityYaml(secret));
}

const velocityYaml = (secret) => `proxies:\n  velocity:\n    enabled: true\n    online-mode: true\n    secret: '${secret}'\n`;

function apply(manager, store, network) {
  // Servers deleted since are dropped from the network.
  const kept = network.servers.filter((e) => manager.servers.some((s) => s.id === e.serverId));
  if (kept.length !== network.servers.length) {
    network.servers = kept;
    store.save();
  }
  if (!manager.servers.some((s) => s.id === network.proxyId) || !kept.length) return;
  const secret = secrets.open(network.secret);
  writeProxy(manager, network, secret);
  for (const e of kept) writeBackend(manager, manager.require(e.serverId), secret, true);
}

/** Running servers need a restart to pick the changes up. */
function needsRestart(manager, network) {
  const changed = network.updatedAt || network.createdAt || 0;
  return [network.proxyId, ...network.servers.map((e) => e.serverId)].filter((id) => manager.isActive(id) && (manager.rt(id).startedAt || 0) < changed);
}

/* --------------------------------------------------------------- the API -- */

function create(manager, store, input, actor) {
  const data = check(manager, store, input);
  const network = { id: uid(8), ...data, secret: secrets.seal(crypto.randomBytes(24).toString('base64url')), createdAt: Date.now(), updatedAt: Date.now() };
  listOf(store).push(network);
  store.save();
  apply(manager, store, network);
  store.addEvent('network.created', `${actor?.username || 'Someone'} linked ${network.servers.length} server(s) behind ${manager.require(network.proxyId).name} as the network ${network.name}`);
  return view(manager, store, network);
}

function update(manager, store, id, input) {
  const network = listOf(store).find((n) => n.id === id);
  if (!network) fail(404, 'Network not found');
  const before = network.servers.map((e) => e.serverId);
  Object.assign(network, check(manager, store, input, network), { updatedAt: Date.now() });
  store.save();
  // Servers taken out go back to normal.
  for (const sid of before) if (!network.servers.some((e) => e.serverId === sid)) release(manager, sid);
  apply(manager, store, network);
  return view(manager, store, network);
}

function release(manager, serverId) {
  const server = manager.servers.find((s) => s.id === serverId);
  if (!server) return;
  try {
    writeBackend(manager, server, '', false);
  } catch (err) {
    logger.warn(`Could not take ${server.name} out of its network: ${err.message}`);
  }
}

function remove(manager, store, id) {
  const network = listOf(store).find((n) => n.id === id);
  if (!network) fail(404, 'Network not found');
  for (const e of network.servers) release(manager, e.serverId);
  store.state.networks = listOf(store).filter((n) => n !== network);
  store.save();
  return { ok: true, restart: needsRestart(manager, network) };
}

/** Write it all again, e.g. after a port changed. Called before the proxy starts too. */
function reapplyFor(manager, store, serverId) {
  for (const network of listOf(store)) {
    if (network.proxyId !== serverId && !network.servers.some((e) => e.serverId === serverId)) continue;
    try {
      apply(manager, store, network);
    } catch (err) {
      logger.warn(`Network ${network.name}: ${err.message}`);
    }
  }
}

function view(manager, store, network) {
  const server = (id) => {
    const s = manager.servers.find((x) => x.id === id);
    return s ? { id: s.id, name: s.name, status: manager.rt(s.id).status, port: s.ports?.game, templateId: s.templateId } : { id, missing: true };
  };
  return {
    id: network.id,
    name: network.name,
    proxy: server(network.proxyId),
    servers: network.servers.map((e) => ({ ...e, server: server(e.serverId) })),
    restart: needsRestart(manager, network),
    createdAt: network.createdAt,
  };
}

function list(manager, store) {
  return {
    networks: listOf(store).map((n) => view(manager, store, n)),
    proxies: manager.servers.filter((s) => s.templateId === PROXY).map((s) => ({ id: s.id, name: s.name })),
    backends: manager.servers.filter((s) => BACKENDS.includes(s.templateId)).map((s) => ({ id: s.id, name: s.name, templateId: s.templateId })),
  };
}

module.exports = { list, create, update, remove, reapplyFor, apply, BACKENDS, PROXY };
