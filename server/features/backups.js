'use strict';

/**
 * Backups are plain .tar.gz archives of a server directory — restorable with
 * `tar` alone if the panel ever goes away.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('../core/config');
const { fail, uid, logger } = require('../core/util');
const vault = require('./vault');

function backupDirFor(serverId) {
  const dir = path.join(config.backupsDir, serverId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Archives and incremental snapshots together, newest first. */
function list(serverId) {
  const dir = backupDirFor(serverId);
  const archives = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, createdAt: stat.mtimeMs, kind: 'archive' };
    });
  return [...archives, ...vault.list(dir)].sort((a, b) => b.createdAt - a.createdAt);
}

const isWindows = process.platform === 'win32';
// Windows 10+ ships bsdtar as System32\tar.exe; it reads and writes the same .tar.gz.
const TAR = isWindows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

// Things that are rebuilt on demand and only bloat a backup.
const EXCLUDES = ['./.gamepanel-install.sh', './.gamepanel/downloads', './.gamepanel/steam-workshop', './.gamepanel/workshop', './.steamcmd'];

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(TAR, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('error', (err) =>
      reject(new Error(`tar is required for backups but could not be run: ${err.message}`))
    );
    proc.on('exit', (code) => {
      // tar exits 1 for "file changed as we read it", which is expected on a
      // live server and does not invalidate the archive.
      if (code === 0 || code === 1) resolve({ warnings: stderr.trim() });
      else reject(new Error(stderr.trim() || `tar exited with code ${code}`));
    });
  });
}

async function create(server, label = '') {
  const dir = backupDirFor(server.id);
  // Incremental mode (Backups tab): only what changed is stored, optionally encrypted.
  if (server.backupMode === 'incremental') return vault.create(dir, server, label, { encrypt: Boolean(server.backupEncrypt) });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  const name = `${stamp}${safeLabel ? '-' + safeLabel : ''}-${uid(4)}.tar.gz`;
  const target = path.join(dir, name);

  const args = ['-czf', target, ...(isWindows ? [] : ['--warning=no-file-changed']), ...EXCLUDES.map((e) => `--exclude=${e}`), '-C', server.dir, '.'];
  try {
    const result = await runTar(args, server.dir);
    if (result.warnings) logger.debug('tar warnings:', result.warnings);
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw err;
  }
  const stat = fs.statSync(target);
  return { name, size: stat.size, createdAt: stat.mtimeMs };
}

/** Keep the newest `keep` backups of a server (0 keeps everything). */
function prune(serverId, keep) {
  const n = Number(keep) || 0;
  if (n <= 0) return [];
  const removed = list(serverId).slice(n);
  const snaps = removed.filter((b) => vault.isSnapshot(b.name));
  for (const b of removed) if (!vault.isSnapshot(b.name)) fs.rmSync(path.join(backupDirFor(serverId), b.name), { force: true });
  // One at a time: each removal also clears the pieces nothing uses any more.
  if (snaps.length) {
    snaps
      .reduce((chain, b) => chain.then(() => vault.remove(backupDirFor(serverId), b.name)), Promise.resolve())
      .catch((err) => logger.warn(`Pruning incremental backups of ${serverId}: ${err.message}`));
  }
  return removed.map((b) => b.name);
}

async function restore(server, name) {
  if (vault.isSnapshot(name)) return vault.restore(backupDirFor(server.id), name, server.dir);
  const file = resolve(server.id, name);
  await runTar(['-xzf', file, '-C', server.dir], server.dir);
  return { ok: true };
}

const MAX_ENTRIES = 50_000;

/** Every file and folder in a backup, with sizes, without unpacking it. */
function contents(serverId, name) {
  if (vault.isSnapshot(name)) return Promise.resolve(vault.contents(backupDirFor(serverId), name));
  const file = resolve(serverId, name);
  return new Promise((ok, reject) => {
    // GNU tar escapes non-ASCII names (caf\303\251) under the C locale unless told not to.
    const proc = spawn(TAR, [...(isWindows ? [] : ['--quoting-style=literal']), '-tvzf', file], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const entries = [];
    let rest = '';
    let truncated = false;
    proc.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        if (entries.length >= MAX_ENTRIES) {
          truncated = true;
          proc.kill();
          return;
        }
        // "-rw-r--r-- user/group  1234 2026-10-05 12:00 ./path/to/file" (GNU) or "... 1234 Oct  5 12:00 ./path" (bsdtar).
        const m = line.match(/^([dl-])\S*\s+(?:\S+\s+)*?(\d+)\s+([A-Za-z]{3}\s+\d{1,2}|\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?|\d{4})\s+(.+)$/);
        if (!m) continue;
        const path_ = m[5].replace(/ -> .*$/, '').replace(/^\.\//, '').replace(/\/$/, '');
        if (!path_ || path_ === '.') continue;
        // GNU tar prints local time to the minute; bsdtar's "Oct  5 12:00" is too vague to compare.
        const mtime = /^\d{4}-/.test(m[3]) ? new Date(`${m[3]}T${m[4].length === 4 ? `0${m[4]}` : m[4]}`).getTime() || null : null;
        entries.push({ path: path_, dir: m[1] === 'd', size: Number(m[2]), mtime });
      }
    });
    proc.on('error', (err) => reject(new Error(`tar could not be run: ${err.message}`)));
    proc.on('close', () => ok({ entries, truncated }));
  });
}

/** Put chosen files or folders from a backup back, leaving everything else alone. */
async function restorePaths(server, name, paths) {
  const wanted = [...new Set((Array.isArray(paths) ? paths : []).map((p) => String(p).replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')))];
  if (!wanted.length) fail(400, 'Pick at least one file or folder');
  if (wanted.length > 500) fail(400, 'Pick at most 500 files or folders at a time');
  if (wanted.some((p) => !p || p.split('/').some((part) => part === '..' || part === '') || /^[A-Za-z]:/.test(p))) fail(400, 'Invalid path');
  if (vault.isSnapshot(name)) return { ...(await vault.restore(backupDirFor(server.id), name, server.dir, wanted)), restored: wanted };
  const file = resolve(server.id, name);
  const { entries } = await contents(server.id, name);
  const known = new Set(entries.map((e) => e.path));
  const missing = wanted.find((p) => !known.has(p));
  if (missing) fail(404, `${missing} is not in this backup`);
  // Members are stored as ./path. Folders bring everything under them.
  await runTar(['-xzf', file, '-C', server.dir, '--', ...wanted.map((p) => `./${p}`)], server.dir);
  return { ok: true, restored: wanted };
}

function resolve(serverId, name) {
  if (!/^[A-Za-z0-9._-]+\.tar\.gz$/.test(String(name))) fail(400, 'Invalid backup name');
  const file = path.join(backupDirFor(serverId), name);
  if (!fs.existsSync(file)) fail(404, 'Backup not found');
  return file;
}

function remove(serverId, name) {
  if (vault.isSnapshot(name)) return vault.remove(backupDirFor(serverId), name);
  fs.unlinkSync(resolve(serverId, name));
  return { ok: true };
}

/** One file out of a backup, as a Buffer (null when the backup does not have it). Up to 64 MB. */
async function readFile(server, name, rel) {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!clean || clean.split('/').some((p) => p === '..' || p === '')) fail(400, 'Invalid path');
  if (vault.isSnapshot(name)) {
    const scratch = path.join(config.cacheDir, `read-${server.id}-${uid(6)}`);
    fs.mkdirSync(scratch, { recursive: true });
    try {
      await vault.restore(backupDirFor(server.id), name, scratch, [clean]);
      return fs.readFileSync(path.join(scratch, clean));
    } catch (err) {
      if (err.status === 404 || err.code === 404 || err.code === 'ENOENT') return null;
      throw err;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  const file = resolve(server.id, name);
  return new Promise((ok, reject) => {
    const proc = spawn(TAR, ['-xzOf', file, `./${clean}`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks = [];
    let size = 0;
    proc.stdout.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) proc.kill();
      else chunks.push(c);
    });
    proc.on('error', reject);
    proc.on('close', (code) => ok(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
  });
}

/** An incremental backup as a plain .tar.gz download: put back into a scratch folder, then packed. */
async function downloadSnapshot(server, name, res) {
  const scratch = path.join(config.cacheDir, `download-${server.id}-${uid(6)}`);
  fs.mkdirSync(scratch, { recursive: true });
  try {
    await vault.restore(backupDirFor(server.id), name, scratch);
  } catch (err) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw err;
  }
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name.replace(/\.snap$/, '.tar.gz')}"` });
  const proc = spawn(TAR, ['-czf', '-', '-C', scratch, '.'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  proc.stdout.pipe(res);
  const tidy = () => fs.rmSync(scratch, { recursive: true, force: true });
  proc.on('close', tidy);
  proc.on('error', () => res.destroy());
  res.on('close', () => proc.kill());
}

/* -------------------------------------------------------------- checks -- */

// Results per backup, next to the archives: { name: { at, ok, mode, files, bytes, error } }.
const checksFile = (serverId) => path.join(backupDirFor(serverId), '.checks.json');

function checks(serverId) {
  try {
    return JSON.parse(fs.readFileSync(checksFile(serverId), 'utf8'));
  } catch {
    return {};
  }
}

function saveCheck(serverId, name, result) {
  const all = checks(serverId);
  const names = new Set(list(serverId).map((b) => b.name));
  for (const key of Object.keys(all)) if (!names.has(key)) delete all[key];
  all[name] = result;
  fs.writeFileSync(checksFile(serverId), JSON.stringify(all));
}

function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

function walk(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files++;
        bytes += fs.statSync(full).size;
      }
    }
  }
  return { files, bytes };
}

/**
 * Test-restore a backup: unpack it into a scratch folder and compare with
 * its own listing (every file there, every size right). Minecraft worlds
 * must have their level.dat. Without room for that, the archive is read end
 * to end instead, which still catches a corrupt or cut-off file.
 */
async function verify(server, name) {
  const started = Date.now();
  let result;
  if (vault.isSnapshot(name)) {
    try {
      result = await vault.verify(backupDirFor(server.id), name);
    } catch (err) {
      result = { ok: false, error: String(err.message).slice(0, 300) };
    }
    result = { ...result, at: Date.now(), ms: Date.now() - started };
    saveCheck(server.id, name, result);
    return result;
  }
  const file = resolve(server.id, name);
  try {
    const { entries, truncated } = await contents(server.id, name);
    const listed = entries.filter((e) => !e.dir);
    const expectedBytes = listed.reduce((n, e) => n + e.size, 0);
    if (!listed.length) throw new Error('The backup is empty');
    const scratch = path.join(config.cacheDir, `verify-${server.id}-${uid(6)}`);
    if (!truncated && freeBytes(config.cacheDir) > expectedBytes * 1.5 + 512 * 1024 * 1024) {
      fs.mkdirSync(scratch, { recursive: true });
      try {
        await runTar(['-xzf', file, '-C', scratch], scratch);
        const got = walk(scratch);
        if (got.files < listed.length) throw new Error(`Only ${got.files} of ${listed.length} files came back`);
        const wrong = listed.find((e) => {
          try {
            return fs.statSync(path.join(scratch, e.path)).size !== e.size;
          } catch {
            return true;
          }
        });
        if (wrong) throw new Error(`${wrong.path} did not come back intact`);
        const worlds = listed.filter((e) => /(^|\/)level\.dat$/.test(e.path));
        if (/^minecraft-(?!bedrock)/.test(server.templateId) && listed.some((e) => /(^|\/)region\//.test(e.path)) && !worlds.length) throw new Error('A Minecraft world is in the backup without its level.dat');
        result = { ok: true, mode: 'restored', files: got.files, bytes: got.bytes };
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    } else {
      // Reading every byte checks gzip's own checksums all the way through.
      await new Promise((ok, reject) => {
        const proc = spawn(TAR, ['-tzf', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let err = '';
        proc.stderr.on('data', (c) => (err += c));
        proc.on('error', reject);
        proc.on('exit', (code) => (code === 0 ? ok() : reject(new Error(err.trim() || `tar exited with code ${code}`))));
      });
      result = { ok: true, mode: 'read', files: listed.length, bytes: expectedBytes };
    }
  } catch (err) {
    result = { ok: false, error: String(err.message).slice(0, 300) };
  }
  result = { ...result, at: Date.now(), ms: Date.now() - started };
  saveCheck(server.id, name, result);
  return result;
}

module.exports = { EXCLUDES, list, create, restore, restorePaths, contents, remove, resolve, prune, dirFor: backupDirFor, verify, checks, downloadSnapshot, readFile, vault };
