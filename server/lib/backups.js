'use strict';

/**
 * Backups are plain .tar.gz archives of a server directory — restorable with
 * `tar` alone if the panel ever goes away.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('./config');
const { fail, uid, logger } = require('./util');

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

function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    // On Windows a drive letter looks like a remote host to GNU tar; harmless
    // to pass on Linux too, but only needed for local development.
    if (process.platform === 'win32') args = ['--force-local', ...args];
    const proc = spawn('tar', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
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

  const result = await runTar(
    ['-czf', target, '--warning=no-file-changed', '--exclude=./.gamepanel-install.sh', '-C', server.dir, '.'],
    server.dir
  );
  if (result.warnings) logger.debug('tar warnings:', result.warnings);
  const stat = fs.statSync(target);
  return { name, size: stat.size, createdAt: stat.mtimeMs };
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

module.exports = { list, create, restore, remove, resolve };
