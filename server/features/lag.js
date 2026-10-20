'use strict';

/**
 * Lag reports: one click to find out what is slowing a server down.
 *
 *   Minecraft   runs the spark profiler (installed as a plugin or mod) and
 *               shows the link to its report: where the time goes, by
 *               plugin, mod and method. Or its quick health report.
 *   Rust        asks the server for its frame rate (a Rust server's tick is
 *               its frame) and sets it beside the plugins it loads. Oxide has
 *               no profiler of its own, so this is a snapshot, not a trace.
 *   Others      the snapshot alone.
 *
 * Every report also records a snapshot of what the panel already knows (CPU,
 * memory, players, TPS, "can't keep up" lines), so a link can be read later
 * against how the server was doing. Reports are kept in the server folder
 * (.gamepanel/lag.json), so they travel with backups.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail, logger } = require('../core/util');
const safefs = require('../core/safefs');
const compat = require('./mods/compat');
const { containedPath } = require('./files');

const FILE = path.join('.gamepanel', 'lag.json');
const KEEP = 20;
const SPARK_URL = /https:\/\/spark\.lucko\.me\/[A-Za-z0-9]+/;
const SPARK_MISSING = /Unknown (?:or incomplete )?command|Unknown command/i;
const SPARK_BUSY = /profiler is already running/i;
const POLL_MS = 2000;
const MIN_SECONDS = 10;
const MAX_SECONDS = 600;

/** Running reports, by server id. */
const active = new Map();

/* ---------------------------------------------------------------- support -- */

/** What kind of lag report this server can make. */
function kindOf(server, template) {
  const ctx = compat.modContext(server, template);
  if (ctx.game === 'minecraft' && template?.id !== 'minecraft-bedrock' && ctx.loader && ctx.loader !== 'vanilla') return 'spark';
  if (ctx.game === 'rust') return 'rust';
  return 'snapshot';
}

function sparkInstalled(server, template) {
  const ctx = compat.modContext(server, template);
  try {
    const dir = containedPath(server.dir, ctx.dir);
    return fs.readdirSync(dir).some((f) => /^spark[-_.].*\.jar(\.disabled)?$/i.test(f) && !f.endsWith('.disabled'));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ the record -- */

function load(server) {
  try {
    const data = JSON.parse(safefs.readText(containedPath(server.dir, FILE), 2 * 1024 * 1024));
    return Array.isArray(data.reports) ? data.reports.filter((r) => r && typeof r === 'object').slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

function save(server, reports) {
  const target = containedPath(server.dir, FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, reports }, null, 2), { flag: 'wx' });
  fs.renameSync(tmp, target);
}

function remove(server, id) {
  const reports = load(server);
  const kept = reports.filter((r) => r.id !== id);
  if (kept.length === reports.length) fail(404, 'No such report');
  save(server, kept);
}

/* --------------------------------------------------------------- snapshot -- */

/** How the server has been doing for the last quarter hour, from what the panel already measures. */
function snapshot(manager, server) {
  const rt = manager.rt(server.id);
  const points = manager.getHistory(server.id, '1h').filter((p) => p.t >= Date.now() - 15 * 60_000);
  const avg = (key) => (points.length ? points.reduce((n, p) => n + (p[key] || 0), 0) / points.length : null);
  const max = (key) => (points.length ? Math.max(...points.map((p) => p[`${key}Max`] ?? p[key] ?? 0)) : null);
  const mb = (bytes) => (bytes === null ? null : Math.round(bytes / 1048576));
  const behind = rt.console.slice(-500).filter((e) => /Can't keep up!/.test(e.line)).length;
  return {
    cpuAvg: avg('cpu') === null ? null : +avg('cpu').toFixed(1),
    cpuPeak: points.length ? Math.max(...points.map((p) => p.cpu || 0)) : null,
    memoryMb: mb(avg('mem')),
    memoryPeakMb: mb(max('mem')),
    memoryLimitMb: Number(server.memory) || null,
    players: rt.players ?? null,
    playersPeak: max('players'),
    tps: rt.tps ?? null,
    behindLines: behind,
    uptimeMs: rt.startedAt ? Date.now() - rt.startedAt : 0,
  };
}

/** Plain-language reading of a snapshot: what stands out. */
function findings(snap, extra = {}) {
  const out = [];
  if (snap.tps !== null && snap.tps < 18) out.push(`TPS is ${snap.tps}; 20 is perfect and players notice below about 15.`);
  if (snap.behindLines) out.push(`"Can't keep up" appears ${snap.behindLines} time${snap.behindLines === 1 ? '' : 's'} in the recent console.`);
  if (snap.cpuPeak !== null && snap.cpuPeak >= 95) out.push(`CPU reached ${snap.cpuPeak.toFixed(0)} % in the last 15 minutes. The game is waiting on the processor.`);
  if (snap.memoryLimitMb && snap.memoryPeakMb && snap.memoryPeakMb >= snap.memoryLimitMb * 0.92) out.push(`Memory peaked at ${snap.memoryPeakMb} of ${snap.memoryLimitMb} MB, so the garbage collector is probably stalling the game.`);
  if (extra.fps !== undefined && extra.fps !== null) {
    if (extra.fps < 20) out.push(`The server runs at ${extra.fps} FPS. Below about 30 players feel rubber-banding; look at the plugin count and the entity count.`);
    else if (extra.fps < 30) out.push(`The server runs at ${extra.fps} FPS, which is a little low.`);
  }
  if (extra.plugins >= 40) out.push(`${extra.plugins} plugins are loaded. Remove the ones you do not use, then add them back one at a time if it still lags.`);
  if (!out.length) out.push('Nothing stands out. If players still report lag, take the report while it is happening.');
  return out;
}

/* ----------------------------------------------------------------- status -- */

function status(manager, server) {
  const template = manager.template(server);
  const kind = kindOf(server, template);
  const run = active.get(server.id) || null;
  return {
    kind,
    running: manager.isActive(server.id),
    sparkInstalled: kind === 'spark' ? sparkInstalled(server, template) : null,
    active: run ? { mode: run.mode, startedAt: run.startedAt, seconds: run.seconds, state: run.state, error: run.error || null } : null,
    reports: load(server),
  };
}

/* ------------------------------------------------------------------ start -- */

function record(manager, server, report) {
  const reports = [report, ...load(server)].slice(0, KEEP);
  save(server, reports);
  return report;
}

function newReport(manager, server, kind, fields, by) {
  return { id: crypto.randomBytes(5).toString('hex'), at: Date.now(), kind, by: by || null, ...fields };
}

/**
 * Start a report. Spark returns at once and finishes in the background (poll
 * status()); the others finish before returning.
 * @param {{mode?: 'profile'|'health', seconds?: number}} options
 */
async function start(manager, server, options = {}, by = null) {
  const template = manager.template(server);
  const kind = kindOf(server, template);
  if (!manager.isActive(server.id)) fail(409, 'Start the server first. A lag report measures a running server.');
  if (active.has(server.id)) fail(409, 'A report is already running for this server.');

  if (kind === 'spark') {
    if (!sparkInstalled(server, template)) fail(409, 'The spark profiler is not installed on this server. Install it first.');
    const mode = options.mode === 'health' ? 'health' : 'profile';
    const seconds = mode === 'profile' ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(Number(options.seconds) || 60))) : 0;
    const startSeq = manager.rt(server.id).seq;
    const run = { mode, seconds, startedAt: Date.now(), state: mode === 'profile' ? 'profiling' : 'waiting', startSeq };
    active.set(server.id, run);
    const snap = snapshot(manager, server);
    try {
      await manager.sendCommand(server.id, mode === 'profile' ? `spark profiler start --timeout ${seconds}` : 'spark health --upload');
    } catch (err) {
      active.delete(server.id);
      throw err;
    }
    watchSpark(manager, server, run, snap, by);
    return status(manager, server);
  }

  if (kind === 'rust') {
    const snap = snapshot(manager, server);
    let fps = null;
    let raw = '';
    try {
      const startSeq = manager.rt(server.id).seq;
      const res = await manager.sendCommand(server.id, 'fps');
      raw = String(res.response || '');
      if (!raw) {
        await new Promise((r) => setTimeout(r, 1500));
        raw = manager.rt(server.id).console.filter((e) => e.seq > startSeq && e.stream !== 'input').map((e) => e.line).join('\n');
      }
      fps = Number((raw.match(/(\d+(?:\.\d+)?)\s*fps/i) || raw.match(/(\d+(?:\.\d+)?)/) || [])[1]);
      if (!Number.isFinite(fps)) fps = null;
    } catch (err) {
      logger.warn(`Lag report for ${server.name}: the fps command failed: ${err.message}`);
    }
    const plugins = countFiles(server, template, /\.cs$/i);
    record(manager, server, newReport(manager, server, 'rust', { snapshot: snap, fps, raw: raw.slice(0, 400), plugins, findings: findings(snap, { fps, plugins }) }, by));
    return status(manager, server);
  }

  const snap = snapshot(manager, server);
  record(manager, server, newReport(manager, server, 'snapshot', { snapshot: snap, findings: findings(snap) }, by));
  return status(manager, server);
}

function countFiles(server, template, pattern) {
  try {
    const dir = containedPath(server.dir, compat.modContext(server, template).dir);
    return fs.readdirSync(dir).filter((f) => pattern.test(f)).length;
  } catch {
    return 0;
  }
}

/** Wait for spark's link to appear in the console, then keep it. */
function watchSpark(manager, server, run, snap, by) {
  const deadline = run.startedAt + (run.seconds + 120) * 1000;
  const finish = (error) => {
    active.delete(server.id);
    if (error) logger.warn(`Lag report for ${server.name}: ${error}`);
  };
  const tick = () => {
    if (active.get(server.id) !== run) return;
    if (!manager.isActive(server.id)) {
      run.state = 'failed';
      run.error = 'The server stopped before the report was ready.';
      return setTimeout(() => finish(run.error), POLL_MS * 4).unref?.();
    }
    const lines = manager.rt(server.id).console.filter((e) => e.seq > run.startSeq && e.stream !== 'input').map((e) => e.line);
    const url = lines.map((l) => l.match(SPARK_URL)?.[0]).find(Boolean);
    if (url) {
      try {
        record(manager, server, newReport(manager, server, 'spark', { mode: run.mode, seconds: run.seconds || null, url, snapshot: snap, findings: findings(snap) }, by));
        manager.store.addEvent('lag.report', `Lag report taken on ${server.name}`, { serverId: server.id });
      } catch (err) {
        logger.warn(`Could not save the lag report for ${server.name}: ${err.message}`);
      }
      return finish();
    }
    const problem = lines.find((l) => SPARK_MISSING.test(l) || SPARK_BUSY.test(l));
    if (problem) {
      run.state = 'failed';
      run.error = SPARK_BUSY.test(problem) ? 'The profiler is already running. Stop it from the console with "spark profiler stop".' : 'The server did not know the spark command. Install spark and restart the server.';
      return setTimeout(() => finish(run.error), POLL_MS * 4).unref?.();
    }
    if (Date.now() > deadline) {
      run.state = 'failed';
      run.error = 'spark did not give a link. Look at the console for what it said.';
      return setTimeout(() => finish(run.error), POLL_MS * 4).unref?.();
    }
    setTimeout(tick, POLL_MS).unref?.();
  };
  setTimeout(tick, POLL_MS).unref?.();
}

module.exports = { status, start, remove, kindOf, sparkInstalled, snapshot, findings, load };
