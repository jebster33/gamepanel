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

module.exports = { list, create, restore, remove, resolve, prune };
