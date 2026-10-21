'use strict';

/**
 * Housekeeping for incremental (vault) backups, on top of server/features/vault.js:
 *
 *   check      every snapshot opens, every piece it needs is there (and, with `deep`,
 *              still matches its name), and how many pieces nothing uses
 *   retention  keep the newest N snapshots and/or those younger than D days, delete
 *              the rest, then clear the pieces nobody uses any more
 *   export     one snapshot as a plain .tar.gz in the cache folder, for cloud upload
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('../core/config');
const { uid } = require('../core/util');
const vault = require('./vault');

const isWindows = process.platform === 'win32';
const TAR = isWindows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

async function check(backupDir, { deep = false } = {}) {
  const started = Date.now();
  const vaults = vault.Vault.all(backupDir);
  const out = { ok: true, deep, vaults: vaults.length, snapshots: 0, files: 0, pieces: 0, missing: [], damaged: [], unreadable: [], orphans: 0, orphanBytes: 0 };
  for (const v of vaults) {
    v.unlock();
    const used = new Set();
    for (const name of v.names()) {
      let snap;
      try {
        snap = v.readSnapshot(name);
      } catch (err) {
        out.unreadable.push({ snapshot: name, error: String(err.message).slice(0, 120) });
        continue;
      }
      out.snapshots++;
      for (const e of snap.entries) {
        if (e.type !== 'file') continue;
        out.files++;
        for (const id of e.chunks) used.add(id);
      }
    }
    for (const id of used) {
      out.pieces++;
      try {
        if (deep) await v.get(id);
        else await fsp.stat(v.chunkPath(id));
      } catch (err) {
        (err.code === 'ENOENT' ? out.missing : out.damaged).push(id.slice(0, 12));
      }
    }
    const base = path.join(v.dir, 'chunks');
    for (const sub of await fsp.readdir(base).catch(() => [])) {
      for (const id of await fsp.readdir(path.join(base, sub)).catch(() => [])) {
        if (used.has(id)) continue;
        const st = await fsp.stat(path.join(base, sub, id)).catch(() => null);
        if (st) {
          out.orphans++;
          out.orphanBytes += st.size;
        }
      }
    }
  }
  out.missing = out.missing.slice(0, 20);
  out.damaged = out.damaged.slice(0, 20);
  out.ok = !out.missing.length && !out.damaged.length && !out.unreadable.length;
  out.ms = Date.now() - started;
  return out;
}

/** Snapshots to delete under a policy. `keepLast` always wins: the newest N are never removed. */
function selectOld(list, { keepLast = 0, keepDays = 0 } = {}, now = Date.now()) {
  const last = Math.max(0, Number(keepLast) || 0);
  const days = Math.max(0, Number(keepDays) || 0);
  if (!last && !days) return [];
  const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
  return sorted.filter((b, i) => {
    if (last && i < last) return false;
    if (days) return now - b.createdAt > days * 86_400_000;
    return true; // only keepLast given: everything past it
  });
}

/** Apply a retention policy to the incremental snapshots of one server, then collect garbage. */
async function applyRetention(backupDir, snapshots, policy, protect = [], { dryRun = false } = {}) {
  const doomed = selectOld(snapshots.filter((b) => vault.isSnapshot(b.name)), policy).filter((b) => !protect.includes(b.name));
  if (dryRun) return { removed: doomed.map((b) => b.name), freed: 0, dryRun: true };
  let freed = 0;
  for (const b of doomed) freed += (await vault.remove(backupDir, b.name)).freed || 0;
  return { removed: doomed.map((b) => b.name), freed, dryRun: false };
}

/** A snapshot packed as a .tar.gz under the cache folder. Delete the file when done. Plain (unencrypted) vaults only. */
async function exportSnapshot(backupDir, name) {
  const holder = vault.Vault.all(backupDir).find((v) => v.names().includes(name));
  if (!holder) throw new Error('Backup not found');
  if (holder.meta.encrypted) throw new Error('Encrypted backups are not copied to the cloud in plain form. Download one and encrypt it yourself, or use archive backups for cloud copies.');
  const scratch = path.join(config.cacheDir, `export-${uid(6)}`);
  const file = path.join(config.cacheDir, `export-${uid(6)}.tar.gz`);
  await fsp.mkdir(scratch, { recursive: true });
  try {
    await vault.restore(backupDir, name, scratch);
    await new Promise((ok, reject) => {
      const proc = spawn(TAR, ['-czf', file, '-C', scratch, '.'], { stdio: 'ignore', windowsHide: true });
      proc.on('error', reject);
      proc.on('exit', (code) => (code === 0 ? ok() : reject(new Error(`tar exited with code ${code}`))));
    });
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { file, name: name.replace(/\.snap$/, '.tar.gz') };
}

module.exports = { check, selectOld, applyRetention, exportSnapshot };
