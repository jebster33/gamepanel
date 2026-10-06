'use strict';

/**
 * Wipes: start a game's world over, the way survival servers do on a cycle.
 * A template describes which save files a wipe removes:
 *
 *   "wipe": { "dir": "server/gamepanel", "map": ["*.map", "*.sav*"],
 *             "blueprints": ["player.blueprints.*.db"], "seedVar": "WORLD_SEED" }
 *
 * A wipe stops the server, optionally updates the game first (Rust's forced
 * wipe comes with the monthly update), deletes the matching files, picks a new
 * seed if asked and starts it again. Everything else (configs, plugins,
 * player identities) is left alone.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail } = require('../core/util');
const { containedPath } = require('./files');

/** "*.sav*" → a RegExp for one file name (no folders). */
function glob(pattern) {
  return new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function specFor(manager, server) {
  const spec = manager.template(server)?.wipe;
  if (!spec?.dir || !spec.map?.length) fail(400, 'This game has no wipe set up in its template');
  return spec;
}

/** The files a wipe would delete, without deleting anything. */
function plan(manager, server, { blueprints = false } = {}) {
  const spec = specFor(manager, server);
  const dir = containedPath(server.dir, spec.dir);
  const patterns = [...spec.map, ...(blueprints ? spec.blueprints || [] : [])].map(glob);
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    names = [];
  }
  return { dir, files: names.filter((n) => patterns.some((p) => p.test(n))) };
}

/**
 * Wipe a server. `log` gets a line per step. The caller has already warned
 * the players (the scheduler's countdown) if it wanted to.
 */
async function wipe(manager, server, { blueprints = false, newSeed = false, updateFirst = false } = {}, log = () => {}) {
  const spec = specFor(manager, server);
  const wasRunning = manager.isActive(server.id);
  if (wasRunning) {
    log('Stopping for the wipe');
    await manager.stop(server.id);
    for (let i = 0; i < 120 && manager.isActive(server.id); i++) await new Promise((r) => setTimeout(r, 1000));
    if (manager.isActive(server.id)) fail(409, 'The server did not stop, so nothing was wiped');
  }
  if (updateFirst && manager.updateGame) {
    log('Updating the game first');
    const r = await manager.updateGame(server.id);
    if (r && r.ok === false) log(`Update failed (${r.error}); wiping anyway`);
  }
  const { dir, files } = plan(manager, server, { blueprints });
  for (const name of files) fs.rmSync(path.join(dir, name), { force: true });
  log(`Deleted ${files.length} save file${files.length === 1 ? '' : 's'}${blueprints ? ', blueprints included' : ''}`);
  let seed = null;
  let startError = null;
  if (newSeed && spec.seedVar) {
    seed = crypto.randomInt(1, 2_147_483_647);
    manager.update(server.id, { vars: { [spec.seedVar]: seed } });
    log(`New map seed: ${seed}`);
  }
  server.lastWipe = { at: Date.now(), blueprints: Boolean(blueprints), seed };
  manager.store.save();
  if (wasRunning || server.autoStart) {
    log('Starting on the fresh map');
    // The wipe itself is done; a server that will not start is reported, not undone.
    startError = await manager.start(server.id).then(() => null, (err) => err.message);
    if (startError) log(`Could not start it again: ${startError}`);
  }
  return { deleted: files.length, blueprints: Boolean(blueprints), seed, startError: startError || null };
}

/** The first given weekday of a month: day 1 to 7. */
const isFirstWeekOfMonth = (date) => date.getDate() <= 7;

module.exports = { wipe, plan, glob, isFirstWeekOfMonth };
