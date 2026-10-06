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

function backupDirFor(serverId) {
  const dir = path.join(config.backupsDir, serverId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function list(serverId) {
  const dir = backupDirFor(serverId);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, createdAt: stat.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
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
  for (const b of removed) fs.rmSync(path.join(backupDirFor(serverId), b.name), { force: true });
  return removed.map((b) => b.name);
}

async function restore(server, name) {
  const file = resolve(server.id, name);
  await runTar(['-xzf', file, '-C', server.dir], server.dir);
  return { ok: true };
}

const MAX_ENTRIES = 50_000;

/** Every file and folder in a backup, with sizes, without unpacking it. */
function contents(serverId, name) {
  const file = resolve(serverId, name);
  return new Promise((ok, reject) => {
    const proc = spawn(TAR, ['-tvzf', file], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
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
        const m = line.match(/^([dl-])\S*\s+(?:\S+\s+)*?(\d+)\s+(?:[A-Za-z]{3}\s+\d{1,2}|\d{4}-\d{2}-\d{2})\s+(?:\d{1,2}:\d{2}(?::\d{2})?|\d{4})\s+(.+)$/);
        if (!m) continue;
        const path_ = m[3].replace(/ -> .*$/, '').replace(/^\.\//, '').replace(/\/$/, '');
        if (!path_ || path_ === '.') continue;
        entries.push({ path: path_, dir: m[1] === 'd', size: Number(m[2]) });
      }
    });
    proc.on('error', (err) => reject(new Error(`tar could not be run: ${err.message}`)));
    proc.on('close', () => ok({ entries, truncated }));
  });
}

/** Put chosen files or folders from a backup back, leaving everything else alone. */
async function restorePaths(server, name, paths) {
  const file = resolve(server.id, name);
  const wanted = [...new Set((Array.isArray(paths) ? paths : []).map((p) => String(p).replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')))];
  if (!wanted.length) fail(400, 'Pick at least one file or folder');
  if (wanted.length > 500) fail(400, 'Pick at most 500 files or folders at a time');
  if (wanted.some((p) => !p || p.split('/').some((part) => part === '..' || part === '') || /^[A-Za-z]:/.test(p))) fail(400, 'Invalid path');
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
  fs.unlinkSync(resolve(serverId, name));
  return { ok: true };
}

module.exports = { list, create, restore, restorePaths, contents, remove, resolve, prune, dirFor: backupDirFor };
