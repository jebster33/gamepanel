'use strict';

/**
 * Where a server's disk space and network traffic go.
 *
 * Disk: size per top-level folder (world, mods, logs, cache...) and the biggest files, from
 * one scan of the server folder. A scan stops after MAX_ENTRIES files or MAX_MS and says so,
 * and the result is cached for five minutes so opening the tab repeatedly costs nothing.
 *
 * Network: only container servers have their own network counters (Docker stats), so those
 * get live rates, a history graph (metrics-history) and monthly totals kept here. A plain
 * process shares the host's network namespace: /proc/<pid>/net/dev would show the whole
 * machine, which would be wrong, so nothing is shown for it (and nothing on Windows).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { config } = require('../core/config');

const MAX_ENTRIES = 300_000;
const MAX_MS = 20_000;
const CACHE_MS = 5 * 60_000;
const TOP_FILES = 15;

const KINDS = [
  ['logs', /^(logs?|crash-reports|crashes|output_log.*|oxide[\\/]logs|saved[\\/]logs)$/i],
  ['world', /^(world.*|saves?|saved|worlds?|region|dimensions?|.*_nether|.*_the_end|server[\\/]my_server.*|storage|data)$/i],
  ['mods', /^(mods?|plugins?|oxide|carbon|bepinex|addons?|datapacks?|workshop|steamapps[\\/]workshop)$/i],
  ['cache', /^(cache|\.cache|libraries|versions|\.gamepanel|\.steamcmd|\.java|tmp|temp|downloads)$/i],
];
const kindOf = (name) => KINDS.find(([, re]) => re.test(name))?.[0] || 'other';

const cache = new Map(); // serverId -> { at, result }
const running = new Map();

async function scan(root) {
  const started = Date.now();
  const folders = new Map(); // top-level name -> { bytes, files }
  const files = []; // biggest so far
  let entries = 0;
  let total = 0;
  let truncated = false;
  const stack = [''];
  const add = (top, size) => {
    const f = folders.get(top) || { bytes: 0, files: 0 };
    f.bytes += size;
    f.files++;
    folders.set(top, f);
  };
  while (stack.length && !truncated) {
    const rel = stack.pop();
    let list;
    try {
      list = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      if (++entries > MAX_ENTRIES || Date.now() - started > MAX_MS) {
        truncated = true;
        break;
      }
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!rel) folders.set(e.name, folders.get(e.name) || { bytes: 0, files: 0 });
        stack.push(child);
      } else if (e.isFile()) {
        const st = await fsp.lstat(path.join(root, child)).catch(() => null);
        if (!st) continue;
        total += st.size;
        add(rel ? rel.split('/')[0] : '(files in the server folder)', st.size);
        if (files.length < TOP_FILES || st.size > files[files.length - 1].size) {
          files.push({ path: child, size: st.size, mtime: Math.round(st.mtimeMs) });
          files.sort((a, b) => b.size - a.size);
          if (files.length > TOP_FILES) files.pop();
        }
      }
    }
  }
  return {
    at: Date.now(),
    total,
    truncated,
    scanned: entries,
    folders: [...folders.entries()].map(([name, f]) => ({ name, kind: kindOf(name), ...f })).sort((a, b) => b.bytes - a.bytes),
    biggest: files,
  };
}

/** The disk breakdown of a server folder (cached; pass refresh to scan again). */
async function disk(server, { refresh = false } = {}) {
  const hit = cache.get(server.id);
  if (hit && !refresh && Date.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };
  if (running.has(server.id)) return running.get(server.id);
  const job = scan(server.dir)
    .then((result) => {
      cache.set(server.id, { at: Date.now(), result });
      return { ...result, cached: false };
    })
    .finally(() => running.delete(server.id));
  running.set(server.id, job);
  return job;
}

/** Disk use by kind, for the bars. */
function byKind(result) {
  const out = {};
  for (const f of result.folders) out[f.kind] = (out[f.kind] || 0) + f.bytes;
  return out;
}

/* ------------------------------------------------------------ bandwidth -- */

const FILE = path.join(config.dataDir, 'bandwidth.json');
const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
let totals = null;
let ticks = 0;

function load() {
  if (totals) return totals;
  try {
    totals = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    totals = {};
  }
  return totals;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(totals));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch {
    /* next time */
  }
}

/** Add `seconds` of traffic at the servers' current rates (bytes per second) to this month. */
function accumulate(manager, seconds, now = Date.now()) {
  const all = load();
  const month = monthKey(now);
  for (const server of manager.servers) {
    const rt = manager.rt(server.id);
    if (!rt.docker?.id || (!rt.networkRx && !rt.networkTx)) continue;
    const m = ((all[server.id] ||= {})[month] ||= { rx: 0, tx: 0 });
    m.rx += Math.round((rt.networkRx || 0) * seconds);
    m.tx += Math.round((rt.networkTx || 0) * seconds);
  }
  return all;
}

function start(manager) {
  const every = 30;
  const timer = setInterval(() => {
    accumulate(manager, every);
    if (++ticks % 10 === 0) save();
  }, every * 1000);
  timer.unref?.();
  process.once('exit', () => totals && save());
  return timer;
}

/** Network view of one server: availability, live rates, monthly totals. */
function network(manager, server) {
  const rt = manager.rt(server.id);
  const container = manager.runtimeFor(server) === 'docker';
  const months = Object.entries(load()[server.id] || {})
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, 12);
  if (!container) {
    return {
      available: false,
      reason:
        process.platform === 'win32'
          ? 'This server runs as a plain process on Windows, which has no per-process network counters. Run it in a container to see its traffic.'
          : 'This server runs as a plain process that shares the host network, so Linux cannot say how much of it is this server. Run it in a container to see its traffic.',
      months,
    };
  }
  return { available: true, rx: rt.networkRx || 0, tx: rt.networkTx || 0, months, note: 'Counted from container network counters since the panel started watching; totals start the day this feature was enabled.' };
}

module.exports = { disk, byKind, scan, kindOf, accumulate, network, start, save, monthKey, MAX_ENTRIES };
