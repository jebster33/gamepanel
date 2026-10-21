'use strict';

/**
 * Log retention: delete logs older than N days, gzip logs older than N days, and keep a log
 * folder under a size cap. Rules are global (Settings) with an optional per-server override.
 * Runs once a day, and every run can be previewed first (dry run).
 *
 * Only known log places are looked at, never the whole server folder:
 *   logs/  crash-reports/  Logs/  oxide/logs/  carbon/logs/  ShooterGame/Saved/Logs/  Saved/Logs/
 *   and *.log / output_log*.txt directly in the server folder (Rust output logs)
 * The panel's own logs (data/logs, the rotated audit log) follow the global rules too.
 *
 * Never touched: links, anything that is not a regular file, files changed in the last hour, the
 * newest file of each folder while the server runs (that is the one being written), latest.log,
 * and the live audit.log.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { config } = require('../core/config');
const safefs = require('../core/safefs');
const { logger } = require('../core/util');

const LOG_DIRS = ['logs', 'Logs', 'crash-reports', 'oxide/logs', 'carbon/logs', 'ShooterGame/Saved/Logs', 'Saved/Logs'];
const ROOT_FILE = /^(.+\.log(\.\d+)?|output_log.*\.txt)$/i;
const ACTIVE_NAMES = new Set(['latest.log', 'console.log', 'audit.log']);
const RECENT_MS = 60 * 60_000;
const DAY = 86_400_000;

const DEFAULTS = { enabled: false, deleteDays: 0, gzipDays: 0, maxMb: 0 };

function clean(input = {}) {
  const n = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  return { enabled: Boolean(input.enabled), deleteDays: n(input.deleteDays, 3650), gzipDays: n(input.gzipDays, 3650), maxMb: n(input.maxMb, 1_000_000) };
}

/** Per-server rules fall back to the global ones. */
function rulesFor(settings, server) {
  const own = server?.logRules;
  return clean(own && own.enabled !== undefined && own.override ? own : settings?.logRules || DEFAULTS);
}

/** Regular files in one folder, as { full, rel, name, size, mtime }. Links and others are left out. */
async function listDir(root, rel) {
  const dir = path.join(root, rel);
  let names;
  try {
    names = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of names) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    const st = await fsp.lstat(full).catch(() => null);
    if (st?.isFile()) out.push({ full, rel: rel ? `${rel}/${e.name}` : e.name, name: e.name, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

/** The log folders of a root that exist and really are inside it (a folder that is a link is skipped). */
async function logFolders(root, dirs) {
  const realRoot = await fsp.realpath(root).catch(() => null);
  if (!realRoot) return [];
  const out = [];
  const seen = new Set(); // 'logs' and 'Logs' are one folder on Windows and macOS
  for (const rel of dirs) {
    const full = path.join(root, rel);
    const st = await fsp.lstat(full).catch(() => null);
    if (!st?.isDirectory()) continue;
    const real = await fsp.realpath(full).catch(() => null);
    const key = process.platform === 'linux' ? real : real?.toLowerCase();
    if (real && !seen.has(key) && (real === realRoot || real.startsWith(realRoot + path.sep))) {
      seen.add(key);
      out.push(rel);
    }
  }
  return out;
}

/**
 * What the rules would do to one group of folders.
 * @returns {{ actions: {rel,full,action,size,reason}[], scanned, bytes }}
 */
async function plan(root, dirs, rules, { running = false, rootFiles = false, now = Date.now() } = {}) {
  const actions = [];
  let scanned = 0;
  let bytes = 0;
  const groups = [];
  for (const rel of await logFolders(root, dirs)) groups.push(await listDir(root, rel));
  if (rootFiles) groups.push((await listDir(root, '')).filter((f) => ROOT_FILE.test(f.name)));
  for (const files of groups) {
    scanned += files.length;
    bytes += files.reduce((n, f) => n + f.size, 0);
    const newest = files.reduce((a, f) => (!a || f.mtime > a.mtime ? f : a), null);
    const eligible = files.filter((f) => !ACTIVE_NAMES.has(f.name) && now - f.mtime > RECENT_MS && !(running && f === newest));
    const taken = new Set();
    const take = (f, action, reason) => {
      if (taken.has(f)) return;
      taken.add(f);
      actions.push({ rel: f.rel, full: f.full, action, size: f.size, reason });
    };
    if (rules.deleteDays) for (const f of eligible) if (now - f.mtime > rules.deleteDays * DAY) take(f, 'delete', `older than ${rules.deleteDays} days`);
    if (rules.gzipDays) for (const f of eligible) if (!/\.(gz|zip)$/i.test(f.name) && now - f.mtime > rules.gzipDays * DAY) take(f, 'gzip', `older than ${rules.gzipDays} days`);
    if (rules.maxMb) {
      // Over the cap: oldest first, counting what the earlier rules already free (gzip frees roughly 90%).
      let size = files.reduce((n, f) => n + f.size, 0);
      for (const a of actions) if (files.some((f) => f.full === a.full)) size -= a.action === 'delete' ? a.size : Math.round(a.size * 0.9);
      const cap = rules.maxMb * 1024 * 1024;
      for (const f of [...eligible].sort((a, b) => a.mtime - b.mtime)) {
        if (size <= cap) break;
        if (taken.has(f)) continue;
        take(f, 'delete', `folder is over ${rules.maxMb} MB`);
        size -= f.size;
      }
    }
  }
  return { actions, scanned, bytes };
}

/** Do the planned actions. Each file is looked at again first: still a regular file, still not recent. */
async function execute(actions, { now = Date.now() } = {}) {
  let deleted = 0;
  let gzipped = 0;
  let freed = 0;
  const errors = [];
  for (const a of actions) {
    try {
      const st = await fsp.lstat(a.full);
      if (!st.isFile() || now - st.mtimeMs <= RECENT_MS) continue;
      if (a.action === 'delete') {
        await fsp.unlink(a.full);
        deleted++;
        freed += st.size;
      } else if (a.action === 'gzip') {
        const fd = safefs.openRegular(a.full);
        fs.closeSync(fd);
        const target = `${a.full}.gz`;
        if (fs.existsSync(target)) continue;
        await pipeline(fs.createReadStream(a.full), zlib.createGzip({ level: 9 }), fs.createWriteStream(`${target}.tmp`, { flags: 'wx' }));
        await fsp.rename(`${target}.tmp`, target);
        await fsp.utimes(target, st.atime, st.mtime).catch(() => {});
        await fsp.unlink(a.full);
        const after = await fsp.stat(target);
        gzipped++;
        freed += Math.max(0, st.size - after.size);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push(`${path.basename(a.full)}: ${err.message}`);
    }
  }
  return { deleted, gzipped, freed, errors: errors.slice(0, 10) };
}

/** Plan (and unless dryRun, run) the rules for every server and the panel's own logs. */
async function run({ manager, store, dryRun = true, serverId = null, force = false, now = Date.now() }) {
  const settings = store.state.settings;
  const report = { dryRun, at: now, servers: [], panel: null, totals: { deleted: 0, gzipped: 0, freed: 0, planned: 0 } };
  const tally = async (label, id, p) => {
    report.totals.planned += p.actions.length;
    let result = null;
    if (!dryRun && p.actions.length) {
      result = await execute(p.actions, { now });
      report.totals.deleted += result.deleted;
      report.totals.gzipped += result.gzipped;
      report.totals.freed += result.freed;
    }
    return { id, name: label, scanned: p.scanned, bytes: p.bytes, actions: p.actions.slice(0, 200).map(({ rel, action, size, reason }) => ({ rel, action, size, reason })), more: Math.max(0, p.actions.length - 200), result };
  };
  for (const server of manager.servers) {
    if (serverId && server.id !== serverId) continue;
    const rules = rulesFor(settings, server);
    if (!rules.enabled && !serverId && !force) continue;
    if (!rules.deleteDays && !rules.gzipDays && !rules.maxMb) continue;
    const p = await plan(server.dir, LOG_DIRS, rules, { running: manager.isActive(server.id), rootFiles: true, now });
    report.servers.push(await tally(server.name, server.id, p));
  }
  const global = clean(settings.logRules || DEFAULTS);
  if (!serverId && (global.enabled || force) && (global.deleteDays || global.gzipDays || global.maxMb)) {
    const p = await plan(config.logsDir, ['.'], global, { running: true, now });
    // The rotated audit log (audit.log.1) is the only audit file that may go.
    const rotated = (await listDir(config.dataDir, '')).filter((f) => /^audit\.log\.\d+$/.test(f.name));
    const old = rotated.filter((f) => global.deleteDays && now - f.mtime > global.deleteDays * DAY && now - f.mtime > RECENT_MS).map((f) => ({ rel: f.rel, full: f.full, action: 'delete', size: f.size, reason: `older than ${global.deleteDays} days` }));
    const merged = { actions: [...p.actions, ...old], scanned: p.scanned + rotated.length, bytes: p.bytes + rotated.reduce((n, f) => n + f.size, 0) };
    report.panel = await tally("Panel's own logs", null, merged);
  }
  return report;
}

let timer = null;
/** Once a day (checked hourly): run the enabled rules. */
function start({ manager, store }) {
  const check = async () => {
    const s = store.state.settings;
    if (Date.now() - (s.logRulesLastRun || 0) < 23 * 3600_000) return;
    s.logRulesLastRun = Date.now();
    store.save();
    try {
      const report = await run({ manager, store, dryRun: false });
      s.logRulesLast = { at: report.at, ...report.totals };
      store.save();
      if (report.totals.deleted || report.totals.gzipped) logger.info(`Log rules: ${report.totals.deleted} deleted, ${report.totals.gzipped} compressed`);
    } catch (err) {
      logger.warn(`Log rules failed: ${err.message}`);
    }
  };
  timer = setInterval(check, 3600_000);
  timer.unref?.();
  setTimeout(check, 5 * 60_000).unref?.();
  return timer;
}

module.exports = { LOG_DIRS, clean, rulesFor, plan, execute, run, start, DEFAULTS };
