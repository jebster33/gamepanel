'use strict';

/**
 * Off-site copies on another node. Optional: when it is on, every archive
 * backup made here is also sent to one of your nodes (another machine
 * running GamePanel), so a dead disk or a lost machine does not take the
 * backups with it. Like cloud copies, but with nothing to sign up for.
 *
 * Sending side (this panel):
 *   settings.nodeBackups = { enabled, nodeId, keep }
 * Receiving side (the node's panel), plain .tar.gz files in
 *   <data>/backups-from-nodes/<panel id>/<server id>/<name>
 * behind /api/backup-store (an administrator API key, as for everything else
 * between nodes).
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { config } = require('../core/config');
const { fail, uid, logger } = require('../core/util');
const backups = require('./backups');

const NAME_RE = /^[A-Za-z0-9._-]+\.tar\.gz$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* --------------------------------------------------- receiving: the store -- */

const storeRoot = () => path.join(config.dataDir, 'backups-from-nodes');

function storeDir(source, serverId) {
  if (!ID_RE.test(String(source)) || !ID_RE.test(String(serverId))) fail(400, 'Bad panel or server id');
  return path.join(storeRoot(), source, serverId);
}

function storeFile(source, serverId, name) {
  if (!NAME_RE.test(String(name))) fail(400, 'Invalid backup name');
  return path.join(storeDir(source, serverId), name);
}

function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

/** Take in one backup as a stream. Refuses when it would leave under 1 GB free. */
async function receive(req, source, serverId, name) {
  const file = storeFile(source, serverId, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const size = Number(req.headers['x-backup-size']) || 0;
  // The size is how a full disk is refused before it fills, and how a cut-off copy is noticed.
  if (!size) fail(400, 'Send the size of the backup in X-Backup-Size');
  if (fs.existsSync(file)) fail(409, 'That copy is already here; copies are never overwritten');
  if (freeBytes(path.dirname(file)) - size < 1024 ** 3) fail(507, 'Not enough free disk space on this node for that backup');
  const part = `${file}.part`;
  try {
    await pipeline(req, fs.createWriteStream(part));
    if (fs.statSync(part).size !== size) throw new Error('the copy arrived incomplete');
    fs.renameSync(part, file);
  } catch (err) {
    fs.rmSync(part, { force: true });
    fail(400, `Receiving the backup failed: ${err.message}`);
  }
  return { ok: true, size: fs.statSync(file).size };
}

function listStored(source, serverId) {
  const dir = storeDir(source, serverId);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => NAME_RE.test(n));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Everything kept for other panels, for this panel's own overview. */
function storedSummary() {
  const out = [];
  let sources = [];
  try {
    sources = fs.readdirSync(storeRoot());
  } catch {
    return out;
  }
  for (const source of sources) {
    for (const serverId of fs.readdirSync(path.join(storeRoot(), source)).filter((s) => ID_RE.test(s))) {
      const list = listStored(source, serverId);
      if (list.length) out.push({ source, serverId, count: list.length, bytes: list.reduce((n, b) => n + b.size, 0), newest: list[0].createdAt });
    }
  }
  return out;
}

/** A tar's member names: none absolute, none climbing out with "..". */
function assertArchiveNames(file) {
  return new Promise((resolve, reject) => {
    const proc = require('child_process').spawn('tar', ['-tzf', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let rest = '';
    let bad = null;
    proc.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const name of lines) if (!bad && (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split(/[/\\]/).includes('..'))) bad = name;
      if (bad) proc.kill();
    });
    proc.on('error', reject);
    proc.on('close', (code) => (bad ? reject(new Error(`the copy has a file that would unpack outside the server (${bad})`)) : code === 0 ? resolve() : reject(new Error('the copy is not a readable backup'))));
  });
}

/* ------------------------------------------------------- sending: copies -- */

const DEFAULTS = { enabled: false, nodeId: '', keep: 7 };

class NodeBackups {
  constructor(store, manager) {
    this.store = store;
    this.manager = manager;
    this.status = new Map(); // "<server>/<name>" -> queued | sending | failed: …
    this.chain = Promise.resolve();
    store.on('event', (event) => {
      // Incremental backups live in their vault and are not single files; like cloud copies, only archives go.
      if (event.type === 'backup.created' && event.backup && this.enabled && !backups.vault.isSnapshot(event.backup) && this.manager.servers.some((s) => s.id === event.serverId)) {
        this.queue(event.serverId, event.backup);
      }
    });
  }

  get settings() {
    return { ...DEFAULTS, ...(this.store.state.settings.nodeBackups || {}) };
  }

  /** This panel's id on the node, so several panels can keep copies on the same one. */
  get source() {
    const s = this.store.state.settings;
    if (!s.panelId) {
      s.panelId = uid(10).replace(/[^A-Za-z0-9]/g, 'x');
      this.store.save();
    }
    return s.panelId;
  }

  node() {
    const nodes = this.manager.nodes?.list || [];
    const node = nodes.find((n) => n.id === this.settings.nodeId);
    if (!node) fail(400, 'Pick the node that keeps the copies (Settings → Backups)');
    return node;
  }

  get enabled() {
    const s = this.settings;
    return Boolean(s.enabled && s.nodeId && (this.manager.nodes?.list || []).some((n) => n.id === s.nodeId));
  }

  publicSettings() {
    const nodes = (this.manager.nodes?.list || []).map((n) => ({ id: n.id, name: n.name }));
    return { ...this.settings, nodes };
  }

  update(body = {}) {
    const s = this.settings;
    if (body.nodeId !== undefined) s.nodeId = String(body.nodeId);
    if (body.keep !== undefined) s.keep = Math.max(0, Math.min(1000, Number(body.keep) || 0));
    if (body.enabled !== undefined) s.enabled = Boolean(body.enabled);
    if (s.enabled && !(this.manager.nodes?.list || []).some((n) => n.id === s.nodeId)) fail(400, 'Pick one of your nodes first. Add nodes on the Nodes page.');
    this.store.state.settings.nodeBackups = s;
    this.store.save();
    return this.publicSettings();
  }

  path(serverId, name = '') {
    return `/api/backup-store/${encodeURIComponent(this.source)}/${encodeURIComponent(serverId)}${name ? `/${encodeURIComponent(name)}` : ''}`;
  }

  /** One at a time, so a batch never saturates the link. */
  queue(serverId, name) {
    const id = `${serverId}/${name}`;
    if (['queued', 'sending'].includes(this.status.get(id))) return;
    this.status.set(id, 'queued');
    this.chain = this.chain.then(() => this.send(serverId, name)).catch(() => {});
  }

  async send(serverId, name) {
    const id = `${serverId}/${name}`;
    let file;
    try {
      file = backups.resolve(serverId, name);
    } catch {
      this.status.delete(id);
      return;
    }
    const server = this.manager.servers.find((s) => s.id === serverId);
    const label = server?.name || serverId;
    this.status.set(id, 'sending');
    const started = Date.now();
    try {
      const node = this.node();
      const { nodeStream } = require('./move');
      const size = fs.statSync(file).size;
      const res = await nodeStream(node, 'PUT', this.path(serverId, name), fs.createReadStream(file), { 'X-Backup-Size': String(size) });
      res.resume();
      this.status.delete(id);
      this.store.addEvent('backup.copied', `Backup of ${label} copied to ${node.name} (${Math.round((Date.now() - started) / 1000)}s)`, { serverId, backup: name });
      await this.prune(serverId).catch((err) => logger.warn(`Pruning node copies of ${label}: ${err.message}`));
    } catch (err) {
      this.status.set(id, `failed: ${err.message}`);
      this.store.addEvent('backup.copy_failed', `Copying a backup of ${label} to another node failed: ${err.message}`, { serverId, backup: name });
    }
  }

  async list(serverId) {
    const r = await this.manager.nodes.request(this.node(), 'GET', this.path(serverId));
    return (r.data?.backups || []).filter((b) => NAME_RE.test(b.name));
  }

  async prune(serverId) {
    const keep = this.settings.keep;
    if (!keep) return [];
    const old = (await this.list(serverId)).slice(keep);
    for (const b of old) await this.manager.nodes.request(this.node(), 'DELETE', this.path(serverId, b.name));
    return old.map((b) => b.name);
  }

  /** Bring a copy back here, where it restores like any backup. */
  async fetch(serverId, name) {
    if (!NAME_RE.test(String(name))) fail(400, 'Invalid backup name');
    const target = path.join(backups.dirFor(serverId), name);
    if (fs.existsSync(target)) return { ok: true, already: true };
    const part = `${target}.part`;
    try {
      const { nodeStream } = require('./move');
      const res = await nodeStream(this.node(), 'GET', this.path(serverId, name));
      await pipeline(res, fs.createWriteStream(part));
      // A copy coming back from another machine is only unpacked later, as a backup: no name may reach outside the folder.
      await assertArchiveNames(part);
      fs.renameSync(part, target);
    } catch (err) {
      fs.rmSync(part, { force: true });
      fail(502, `Could not bring the copy back: ${err.message}`);
    }
    return { ok: true };
  }

  async remove(serverId, name) {
    if (!NAME_RE.test(String(name))) fail(400, 'Invalid backup name');
    await this.manager.nodes.request(this.node(), 'DELETE', this.path(serverId, name));
    return { ok: true };
  }

  statusFor(serverId) {
    const out = {};
    for (const [id, st] of this.status) if (id.startsWith(`${serverId}/`)) out[id.slice(serverId.length + 1)] = st;
    return out;
  }
}

let instance = null;
function nodeBackups(store, manager) {
  if (!instance) instance = new NodeBackups(store, manager);
  return instance;
}

module.exports = { nodeBackups, NodeBackups, receive, listStored, storeFile, storedSummary };
