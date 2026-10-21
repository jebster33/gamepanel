'use strict';

/**
 * Backup test-restore checks, weekly or on demand.
 *
 * A backup nobody has ever restored is a guess. This takes a server's newest
 * backup (or a named one) and proves it: backups.verify unpacks it into a
 * scratch folder (archives) or reads every piece (incremental/vault backups,
 * encrypted ones included), compares file counts and sizes, then the checks
 * here look at the game's own files:
 *
 *   Minecraft (Java): level.dat is readable (gzip + NBT start), region files
 *                     have a header and a whole number of 4 KB sectors.
 *   Rust:             a save (.sav) and a map are present and not empty.
 *
 * Disk use is bounded: the scratch folder is only made when there is room for
 * it (otherwise the archive is read end to end), it is always removed, one
 * test runs at a time, and only the last 60 results are kept.
 *
 * settings.backupTest = { weekly: bool }; state.backupTests = [result]
 */

const zlib = require('zlib');
const backups = require('./backups');
const { fail, logger } = require('../core/util');

const KEEP = 60;
const WEEK_MS = 7 * 24 * 3600_000;
const CHECK_MS = 3600_000;

let queue = Promise.resolve();
let timer = null;

const history = (store) => (Array.isArray(store.state.backupTests) ? store.state.backupTests : (store.state.backupTests = []));

/** Game-specific checks. entries: [{path, size, dir}]; read(rel) -> Buffer|null. Returns [{ name, ok, note }]. */
async function gameChecks(server, entries, read) {
  const files = entries.filter((e) => !e.dir);
  const out = [];
  const id = String(server.templateId || '');
  if (/^minecraft-(?!bedrock)/.test(id) || files.some((e) => /(^|\/)level\.dat$/.test(e.path))) {
    const levels = files.filter((e) => /(^|\/)level\.dat$/.test(e.path)).slice(0, 3);
    const regions = files.filter((e) => /(^|\/)region\/[^/]+\.mca$/.test(e.path));
    if (!levels.length && regions.length) out.push({ name: 'level.dat', ok: false, note: 'A world is in the backup without its level.dat' });
    for (const level of levels) {
      const data = await read(level.path).catch(() => null);
      let ok = false;
      try {
        ok = Boolean(data) && zlib.gunzipSync(data).length > 8;
      } catch {
        ok = false;
      }
      out.push({ name: level.path, ok, note: ok ? 'readable' : 'level.dat is missing or does not unpack' });
    }
    for (const region of regions.filter((r) => r.size > 0).sort((a, b) => a.size - b.size).slice(0, 3)) {
      const bad = region.size < 8192 || region.size % 4096 !== 0;
      out.push({ name: region.path, ok: !bad, note: bad ? 'region file is cut short' : 'header and sectors look right' });
    }
  }
  if (/^rust/.test(id)) {
    const saves = files.filter((e) => /\.sav$/.test(e.path));
    const maps = files.filter((e) => /\.map$/.test(e.path));
    out.push({ name: 'save file', ok: saves.some((e) => e.size > 0), note: saves.length ? `${saves.length} save file(s)` : 'No Rust .sav file in the backup' });
    out.push({ name: 'map', ok: maps.some((e) => e.size > 0), note: maps.length ? 'present' : 'No .map file in the backup' });
  }
  return out;
}

/** Run one test now. Resolves with the stored result. */
function run(store, manager, server, name, { manual = false } = {}) {
  const job = queue.then(() => execute(store, manager, server, name, manual));
  queue = job.catch(() => {});
  return job;
}

async function execute(store, manager, server, name, manual) {
  const all = backups.list(server.id);
  const target = name ? all.find((b) => b.name === name) : all[0];
  if (!target) {
    if (manual) fail(404, name ? 'Backup not found' : 'This server has no backups to test yet');
    return null;
  }
  const result = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, serverId: server.id, serverName: server.name, backup: target.name, kind: target.kind || 'archive', size: target.size, at: Date.now(), manual, checks: [] };
  try {
    const base = await backups.verify(server, target.name);
    Object.assign(result, { ok: base.ok, mode: base.mode, files: base.files, bytes: base.bytes, error: base.error });
    if (base.ok) {
      const { entries } = await backups.contents(server.id, target.name);
      result.checks = await gameChecks(server, entries, (rel) => backups.readFile(server, target.name, rel));
      const failed = result.checks.find((c) => !c.ok);
      if (failed) {
        result.ok = false;
        result.error = `${failed.name}: ${failed.note}`;
      }
    }
  } catch (err) {
    result.ok = false;
    result.error = String(err.message || err).slice(0, 300);
  }
  const list = history(store);
  list.unshift(result);
  if (list.length > KEEP) list.length = KEEP;
  store.save();
  if (!result.ok) store.addEvent('backup.test_failed', `Test restore of ${server.name}'s backup ${target.name} failed: ${result.error}`, { serverId: server.id });
  return result;
}

/** Hourly: test each server's newest backup when its last test is over a week old. */
async function weeklyPass(store, manager) {
  if (!store.state.settings.backupTest?.weekly) return;
  const recent = history(store);
  for (const server of manager.servers) {
    const last = recent.find((r) => r.serverId === server.id);
    if (last && Date.now() - last.at < WEEK_MS) continue;
    if (!backups.list(server.id).length) continue;
    await run(store, manager, server, null).catch((err) => logger.debug(`Weekly backup test of ${server.name}: ${err.message}`));
  }
}

function start({ store, manager }) {
  if (timer) return;
  timer = setInterval(() => weeklyPass(store, manager).catch(() => {}), CHECK_MS);
  timer.unref?.();
}

function view(store, manager) {
  return { weekly: Boolean(store.state.settings.backupTest?.weekly), results: history(store).filter((r) => manager.servers.some((s) => s.id === r.serverId)), servers: manager.servers.map((s) => ({ id: s.id, name: s.name, backups: backups.list(s.id).length })) };
}

module.exports = { run, start, view, gameChecks, weeklyPass, KEEP };
