'use strict';

/**
 * Incremental (and optionally encrypted) backups: the "vault" mode next to
 * the plain .tar.gz archives. Each server gets a vault folder of chunks:
 * every file is cut into 1 MiB pieces, each piece stored once, compressed,
 * under the hash of its content. A backup is a snapshot listing which pieces
 * make up which file, so the second backup of a 10 GB world only stores what
 * changed since the first. A file whose size and time did not change is not
 * even read again.
 *
 * Encryption (AES-256-GCM) uses a random key per vault, kept wrapped with a
 * key derived from the panel's backup passphrase (scrypt), so changing the
 * passphrase only rewraps that key. Chunk names are then an HMAC of the
 * content rather than a plain hash, so they reveal nothing about it.
 *
 *   <backups>/<server>/.vault/vault.json        settings, wrapped key, totals
 *   <backups>/<server>/.vault/chunks/ab/abcd…   one piece each
 *   <backups>/<server>/.vault/snapshots/<name>.snap
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { fail, uid } = require('../core/util');

const CHUNK = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9._-]+\.snap$/;
// Rebuilt on demand, and only bloat a backup (same list as the archives).
const EXCLUDES = ['.gamepanel-install.sh', '.gamepanel/downloads', '.gamepanel/steam-workshop', '.gamepanel/workshop', '.steamcmd'];

let passphraseOf = () => null;
/** Where the panel's backup passphrase comes from (Settings → Backups). */
function configure({ passphrase }) {
  passphraseOf = passphrase;
}

/* ----------------------------------------------------------------- keys -- */

const derive = (passphrase, salt) => crypto.scryptSync(String(passphrase), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

function open(key, sealed) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

/* ---------------------------------------------------------------- vault -- */

class Vault {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'vault.json');
    this.meta = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.keys = null;
  }

  /** Plain and encrypted backups live in separate vaults, so switching keeps the older ones restorable. */
  static dirFor(backupDir, encrypted = false) {
    return path.join(backupDir, encrypted ? '.vault-enc' : '.vault');
  }

  static exists(backupDir, encrypted = false) {
    return fs.existsSync(path.join(Vault.dirFor(backupDir, encrypted), 'vault.json'));
  }

  /** The vaults a server's backup folder has (plain, encrypted). */
  static all(backupDir) {
    return [false, true].filter((enc) => Vault.exists(backupDir, enc)).map((enc) => new Vault(Vault.dirFor(backupDir, enc)));
  }

  /** Open (or make) the vault of a server's backup folder. */
  static open(backupDir, { encrypt = false } = {}) {
    const dir = Vault.dirFor(backupDir, encrypt);
    if (!fs.existsSync(path.join(dir, 'vault.json'))) {
      fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
      const meta = { version: 1, chunkSize: CHUNK, encrypted: Boolean(encrypt), createdAt: Date.now(), stats: { chunks: 0, bytes: 0 } };
      if (encrypt) {
        const passphrase = passphraseOf();
        if (!passphrase) fail(400, 'Set a backup passphrase first (Settings → Backups) to encrypt backups');
        const salt = crypto.randomBytes(16);
        meta.salt = salt.toString('base64');
        meta.wrapped = seal(derive(passphrase, salt), crypto.randomBytes(32)).toString('base64');
      }
      fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
    }
    return new Vault(dir);
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.meta, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The vault's keys, unwrapped with the passphrase (encrypted vaults only). */
  unlock(passphrase = passphraseOf()) {
    if (!this.meta.encrypted || this.keys) return this.keys;
    if (!passphrase) fail(400, 'These backups are encrypted: set the backup passphrase under Settings → Backups');
    let master;
    try {
      master = open(derive(passphrase, Buffer.from(this.meta.salt, 'base64')), Buffer.from(this.meta.wrapped, 'base64'));
    } catch {
      fail(400, 'The backup passphrase does not open these backups. They were made with a different one.');
    }
    const sub = (label) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `gamepanel vault ${label}`, 32));
    this.keys = { enc: sub('chunks'), mac: sub('names') };
    return this.keys;
  }

  /** Wrap the vault key with a new passphrase (the old one must open it). */
  rewrap(oldPassphrase, newPassphrase) {
    if (!this.meta.encrypted) return false;
    const master = open(derive(oldPassphrase, Buffer.from(this.meta.salt, 'base64')), Buffer.from(this.meta.wrapped, 'base64'));
    const salt = crypto.randomBytes(16);
    this.meta.salt = salt.toString('base64');
    this.meta.wrapped = seal(derive(newPassphrase, salt), master).toString('base64');
    this.save();
    return true;
  }

  idOf(plain) {
    const keys = this.unlock();
    return keys ? crypto.createHmac('sha256', keys.mac).update(plain).digest('hex') : crypto.createHash('sha256').update(plain).digest('hex');
  }

  chunkPath(id) {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('bad chunk id');
    return path.join(this.dir, 'chunks', id.slice(0, 2), id);
  }

  encode(plain) {
    const packed = zlib.deflateRawSync(plain, { level: 6 });
    const keys = this.unlock();
    return keys ? seal(keys.enc, packed) : packed;
  }

  decode(stored) {
    const keys = this.unlock();
    return zlib.inflateRawSync(keys ? open(keys.enc, stored) : stored);
  }

  /** Store one piece unless it is already there. Returns [id, bytes written]. */
  async put(plain) {
    const id = this.idOf(plain);
    const file = this.chunkPath(id);
    if (fs.existsSync(file)) return [id, 0];
    const data = this.encode(plain);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${uid(4)}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
    return [id, data.length];
  }

  async get(id) {
    const plain = this.decode(await fsp.readFile(this.chunkPath(id)));
    if (this.idOf(plain) !== id) throw new Error(`piece ${id.slice(0, 12)} is damaged`);
    return plain;
  }

  snapshotPath(name) {
    if (!NAME_RE.test(String(name))) fail(400, 'Invalid backup name');
    return path.join(this.dir, 'snapshots', name);
  }

  async writeSnapshot(name, snap) {
    const file = this.snapshotPath(name);
    const data = this.encode(Buffer.from(JSON.stringify(snap)));
    await fsp.writeFile(`${file}.tmp`, data);
    await fsp.rename(`${file}.tmp`, file);
    return data.length;
  }

  readSnapshot(name) {
    const file = this.snapshotPath(name);
    if (!fs.existsSync(file)) fail(404, 'Backup not found');
    return JSON.parse(this.decode(fs.readFileSync(file)).toString('utf8'));
  }

  names() {
    try {
      return fs.readdirSync(path.join(this.dir, 'snapshots')).filter((n) => NAME_RE.test(n));
    } catch {
      return [];
    }
  }
}

/* ------------------------------------------------------------ snapshots -- */

const excluded = (rel) => EXCLUDES.some((e) => rel === e || rel.startsWith(`${e}/`));

/** Every file, folder and link under `root`, as [relative path, Dirent]. */
async function* walk(root, rel = '') {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (excluded(child)) continue;
    yield [child, e];
    if (e.isDirectory()) {
      // It may have been swapped for a link since the listing: never walk into one.
      const now = await fsp.lstat(path.join(root, child)).catch(() => null);
      if (now?.isDirectory()) yield* walk(root, child);
    }
  }
}

/** The newest snapshot, to reuse unchanged files from. */
function latest(vault) {
  const names = vault.names().sort();
  for (let i = names.length - 1; i >= 0; i--) {
    try {
      return vault.readSnapshot(names[i]);
    } catch {
      /* unreadable: try an older one */
    }
  }
  return null;
}

const locks = new Set();

/**
 * Make a snapshot of a server folder.
 * @returns {{ name, size, total, files, createdAt, kind, encrypted }}
 */
async function create(backupDir, server, label = '', { encrypt = false } = {}) {
  if (locks.has(backupDir)) fail(409, 'A backup of this server is already running');
  locks.add(backupDir);
  try {
    const vault = Vault.open(backupDir, { encrypt });
    vault.unlock();
    const previous = latest(vault);
    const before = new Map((previous?.entries || []).filter((e) => e.type === 'file').map((e) => [e.path, e]));
    const entries = [];
    let added = 0;
    let total = 0;
    let newChunks = 0;
    for await (const [rel, dirent] of walk(server.dir)) {
      const full = path.join(server.dir, rel);
      let st;
      try {
        st = await fsp.lstat(full);
      } catch {
        continue; // gone while we looked
      }
      if (dirent.isSymbolicLink()) {
        entries.push({ path: rel, type: 'link', target: await fsp.readlink(full).catch(() => '') });
        continue;
      }
      if (st.isDirectory()) {
        entries.push({ path: rel, type: 'dir', mode: st.mode & 0o7777 });
        continue;
      }
      if (!st.isFile()) continue;
      total += st.size;
      const old = before.get(rel);
      if (old && old.size === st.size && old.mtime === Math.round(st.mtimeMs)) {
        entries.push(old);
        continue;
      }
      const chunks = [];
      // O_NOFOLLOW: a file swapped for a link after the check above is skipped, not read.
      const fh = await fsp.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)).catch(() => null);
      if (!fh) continue;
      try {
        const real = await fsp.realpath(full).catch(() => null);
        const root = await fsp.realpath(server.dir).catch(() => null);
        if (!real || !root || !real.startsWith(root + path.sep)) continue; // its folder became a link to somewhere else
        const buf = Buffer.alloc(CHUNK);
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
          if (!bytesRead) break;
          const [id, written] = await vault.put(Buffer.from(buf.subarray(0, bytesRead)));
          chunks.push(id);
          if (written) {
            added += written;
            newChunks++;
          }
          if (bytesRead < CHUNK) break;
        }
      } finally {
        await fh.close();
      }
      entries.push({ path: rel, type: 'file', size: st.size, mode: st.mode & 0o7777, mtime: Math.round(st.mtimeMs), chunks });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    const name = `${stamp}${safeLabel ? `-${safeLabel}` : ''}-${uid(4)}.snap`;
    const createdAt = Date.now();
    const files = entries.filter((e) => e.type === 'file').length;
    const snapBytes = await vault.writeSnapshot(name, { version: 1, createdAt, server: { id: server.id, templateId: server.templateId }, added: added, total, entries });
    vault.meta.stats = { chunks: (vault.meta.stats?.chunks || 0) + newChunks, bytes: (vault.meta.stats?.bytes || 0) + added };
    // Sizes for the list, so it needs no decrypting (names and sizes only, no file names).
    vault.meta.index = { ...(vault.meta.index || {}), [name]: { added: added + snapBytes, total, files, createdAt } };
    vault.save();
    return { name, size: added + snapBytes, total, files, createdAt, kind: 'incremental', encrypted: vault.meta.encrypted };
  } finally {
    locks.delete(backupDir);
  }
}

/** Snapshots of a server, newest first, without reading their contents. */
function list(backupDir) {
  return Vault.all(backupDir)
    .flatMap((vault) =>
      vault.names().map((name) => {
        const known = vault.meta.index?.[name];
        const stat = known ? null : fs.statSync(vault.snapshotPath(name));
        return { name, size: known?.added ?? stat.size, total: known?.total ?? null, createdAt: known?.createdAt ?? stat.mtimeMs, kind: 'incremental', encrypted: Boolean(vault.meta.encrypted) };
      })
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** The vault's totals, for the Backups tab. */
function stats(backupDir) {
  const vaults = Vault.all(backupDir);
  if (!vaults.length) return null;
  const sum = (f) => vaults.reduce((n, v) => n + (v.meta.stats?.[f] || 0), 0);
  return { encrypted: vaults.some((v) => v.meta.encrypted), bytes: sum('bytes'), chunks: sum('chunks'), snapshots: vaults.reduce((n, v) => n + v.names().length, 0) };
}

/** The vault holding a snapshot, unlocked. */
function openExisting(backupDir, name) {
  const vault = Vault.all(backupDir).find((v) => v.names().includes(name));
  if (!vault) fail(404, 'Backup not found');
  vault.unlock();
  return vault;
}

/** Details of one snapshot (the logical size and file count are inside it). */
function info(backupDir, name) {
  const snap = openExisting(backupDir, name).readSnapshot(name);
  return { total: snap.total, added: snap.added, files: snap.entries.filter((e) => e.type === 'file').length };
}

function contents(backupDir, name) {
  const snap = openExisting(backupDir, name).readSnapshot(name);
  return { entries: snap.entries.map((e) => ({ path: e.path, dir: e.type === 'dir', size: e.size || 0, mtime: e.mtime || null })), truncated: false };
}

/** Write snapshot entries (all, or those under `paths`) into `target`. */
async function restore(backupDir, name, target, paths = null) {
  const vault = openExisting(backupDir, name);
  const snap = vault.readSnapshot(name);
  const wanted = paths ? paths.map((p) => String(p).replace(/^\/+|\/+$/g, '')) : null;
  const pick = (rel) => !wanted || wanted.some((w) => rel === w || rel.startsWith(`${w}/`));
  if (wanted) {
    const known = new Set(snap.entries.map((e) => e.path));
    const missing = wanted.find((p) => !known.has(p));
    if (missing) fail(404, `${missing} is not in this backup`);
  }
  const root = path.resolve(target);
  const realRoot = await fsp.realpath(root);
  const inside = (rel) => {
    if (rel.split('/').some((p) => p === '..' || p === '') || path.isAbsolute(rel)) throw new Error(`refusing to write ${rel}`);
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) throw new Error(`refusing to write ${rel}`);
    return full;
  };
  // A folder on the way that is now a link to somewhere else must not be written through.
  const parentIsInside = async (full) => {
    const parent = await fsp.realpath(path.dirname(full));
    if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) throw new Error(`refusing to write through a link: ${path.relative(root, full)}`);
  };
  // Make a folder, but only after the nearest folder that exists is checked to be inside the server:
  // mkdir -p through a link would create folders wherever it points.
  const ensureDirInside = async (dir) => {
    let probe = dir;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error(`refusing to write through a link: ${path.relative(root, dir)}`);
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        const up = path.dirname(probe);
        if (up === probe) break;
        probe = up;
      }
    }
    await fsp.mkdir(dir, { recursive: true });
  };
  let files = 0;
  let bytes = 0;
  for (const e of snap.entries) {
    if (!pick(e.path)) continue;
    const full = inside(e.path);
    if (e.type === 'dir') {
      await ensureDirInside(full);
      continue;
    }
    await ensureDirInside(path.dirname(full));
    await parentIsInside(full);
    if (e.type === 'link') {
      // Links that point outside the server folder are not put back.
      const resolved = path.resolve(path.dirname(full), e.target);
      if (!resolved.startsWith(root + path.sep)) continue;
      await fsp.rm(full, { force: true });
      await fsp.symlink(e.target, full).catch(() => {});
      continue;
    }
    // Replace rather than write through: never follow a link that is there now.
    await fsp.rm(full, { force: true, recursive: false }).catch(() => {});
    const fh = await fsp.open(full, 'wx', e.mode || 0o644);
    try {
      for (const id of e.chunks) {
        const piece = await vault.get(id);
        await fh.write(piece);
        bytes += piece.length;
      }
    } finally {
      await fh.close();
    }
    if (e.mtime) await fsp.utimes(full, new Date(e.mtime), new Date(e.mtime)).catch(() => {});
    files++;
  }
  return { ok: true, files, bytes, restored: wanted || undefined };
}

/** Read every piece a snapshot needs and check it against its name. */
async function verify(backupDir, name) {
  const vault = openExisting(backupDir, name);
  const snap = vault.readSnapshot(name);
  let files = 0;
  let bytes = 0;
  for (const e of snap.entries) {
    if (e.type !== 'file') continue;
    let size = 0;
    for (const id of e.chunks) size += (await vault.get(id)).length;
    if (size !== e.size) throw new Error(`${e.path} did not come back intact`);
    files++;
    bytes += size;
  }
  return { ok: true, mode: 'pieces', files, bytes };
}

/** Delete a snapshot, then every piece no other snapshot uses. */
async function remove(backupDir, name) {
  // Never while a backup of this server runs: its new pieces are not in any snapshot yet.
  if (locks.has(backupDir)) fail(409, 'A backup of this server is running. Try again when it is done.');
  locks.add(backupDir);
  try {
    const vault = openExisting(backupDir, name);
    await fsp.rm(vault.snapshotPath(name), { force: true });
    if (vault.meta.index) delete vault.meta.index[name];
    return await gc(vault);
  } finally {
    locks.delete(backupDir);
  }
}

async function gc(vault) {
  const used = new Set();
  for (const n of vault.names()) {
    for (const e of vault.readSnapshot(n).entries) if (e.type === 'file') for (const id of e.chunks) used.add(id);
  }
  let freed = 0;
  let chunks = 0;
  let bytes = 0;
  const base = path.join(vault.dir, 'chunks');
  for (const sub of await fsp.readdir(base).catch(() => [])) {
    for (const id of await fsp.readdir(path.join(base, sub)).catch(() => [])) {
      const file = path.join(base, sub, id);
      const st = await fsp.stat(file).catch(() => null);
      if (!st) continue;
      if (used.has(id)) {
        chunks++;
        bytes += st.size;
      } else {
        await fsp.rm(file, { force: true });
        freed += st.size;
      }
    }
  }
  vault.meta.stats = { chunks, bytes };
  vault.save();
  return { ok: true, freed };
}

/** A new passphrase: rewrap every server's vault key with it. */
function rewrapAll(backupsRoot, oldPassphrase, newPassphrase) {
  const vaults = [];
  let ids = [];
  try {
    ids = fs.readdirSync(backupsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    ids = [];
  }
  for (const id of ids) {
    if (!Vault.exists(path.join(backupsRoot, id), true)) continue;
    const vault = new Vault(Vault.dirFor(path.join(backupsRoot, id), true));
    // Check that every vault opens before changing any of them.
    try {
      vault.unlock(oldPassphrase);
    } catch {
      fail(400, `The current passphrase does not open the backups of ${id}, so the passphrase was not changed`);
    }
    vaults.push(vault);
  }
  for (const vault of vaults) vault.rewrap(oldPassphrase, newPassphrase);
  return vaults.length;
}

const isSnapshot = (name) => NAME_RE.test(String(name));

module.exports = { configure, create, list, stats, info, contents, restore, verify, remove, rewrapAll, isSnapshot, Vault, CHUNK };
