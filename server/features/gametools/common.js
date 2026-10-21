'use strict';

/** Small helpers shared by the per-game tools (CS2, Squad, Garry's Mod, Satisfactory, Palworld, Space Engineers). */

const fs = require('fs');
const path = require('path');
const { fail } = require('../../core/util');
const { containedPath } = require('../files');
const safefs = require('../../core/safefs');

/** The tools only touch files, so a running game would overwrite or ignore the change. */
function requireStopped(manager, server, what = 'This') {
  if (manager.isActive(server.id)) fail(409, `${what} needs the server to be stopped first. Stop it, make the change, then start it again.`);
}

function readRel(server, rel, max = 4 * 1024 * 1024) {
  try {
    return safefs.readText(containedPath(server.dir, rel), max);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Copy a file to <dir>/gamepanel-backups/<name>.<stamp>.bak before it is changed. Returns the relative backup path or null. */
function backupRel(server, rel) {
  const src = containedPath(server.dir, rel);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = `${path.basename(src)}.${stamp}.bak`;
  const relBackup = `gamepanel-backups/${name}`;
  const dest = containedPath(server.dir, relBackup);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  return relBackup;
}

function writeRel(server, rel, text) {
  const file = containedPath(server.dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.gp-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Server variables are plain strings in server.vars; set several and save. */
function setVars(manager, store, server, vars) {
  server.vars = { ...server.vars, ...vars };
  store.save();
  manager.broadcastServers?.();
}

module.exports = { requireStopped, readRel, writeRel, backupRel, setVars };
