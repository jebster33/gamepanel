'use strict';

/**
 * Host and per-process metrics straight from /proc — no agents, no exporters.
 * Everything degrades to nulls on non-Linux so the panel still runs for
 * development on other platforms.
 */

const fs = require('fs');
const os = require('os');
const { logger, sh } = require('./util');

const isLinux = process.platform === 'linux';
const CLK_TCK = 100; // USER_HZ is 100 on every mainstream Linux build
const PAGE_SIZE = 4096;

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ host -- */

function readCpuTotals() {
  const stat = readFileSafe('/proc/stat');
  if (!stat) return null;
  const line = stat.split('\n', 1)[0];
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function readMemInfo() {
  const raw = readFileSafe('/proc/meminfo');
  if (!raw) {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, used: total - free, free, cached: 0, swapTotal: 0, swapUsed: 0 };
  }
  const map = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+) kB/);
    if (m) map[m[1]] = Number(m[2]) * 1024;
  }
  const total = map.MemTotal || 0;
  const available = map.MemAvailable !== undefined ? map.MemAvailable : (map.MemFree || 0) + (map.Cached || 0);
  return {
    total,
    free: available,
    used: total - available,
    cached: map.Cached || 0,
    swapTotal: map.SwapTotal || 0,
    swapUsed: (map.SwapTotal || 0) - (map.SwapFree || 0),
  };
}

function readNetTotals() {
  const raw = readFileSafe('/proc/net/dev');
  if (!raw) return null;
  let rx = 0;
  let tx = 0;
  for (const line of raw.split('\n').slice(2)) {
    const [nameRaw, rest] = line.split(':');
    if (!rest) continue;
    const name = nameRaw.trim();
    if (name === 'lo' || name.startsWith('veth') || name.startsWith('docker') || name.startsWith('br-')) continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    rx += cols[0] || 0;
    tx += cols[8] || 0;
  }
  return { rx, tx };
}

function readDiskUsage(mountPoint = '/') {
  try {
    // fs.statfsSync landed in Node 18.15; guard for older runtimes.
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(mountPoint);
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      return { total, free, used: total - free };
    }
  } catch {
    /* fall through */
  }
  return { total: 0, free: 0, used: 0 };
}

/** Established TCP connections whose local port is in `ports`. */
function countConnections(ports) {
  if (!isLinux || !ports || !ports.length) return 0;
  const wanted = new Set(ports.map(Number));
  let count = 0;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const raw = readFileSafe(file);
    if (!raw) continue;
    for (const line of raw.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const state = cols[3];
      if (state !== '01') continue; // TCP_ESTABLISHED
      const local = cols[1];
      const portHex = local.split(':')[1];
      if (!portHex) continue;
      if (wanted.has(parseInt(portHex, 16))) count++;
    }
  }
  return count;
}

class HostMetrics {
  constructor() {
    this.prevCpu = null;
    this.prevNet = null;
    this.prevNetAt = 0;
    this.last = this.sample();
  }

  sample() {
    const now = Date.now();
    let cpuPercent = 0;
    if (isLinux) {
      const cpu = readCpuTotals();
      if (cpu && this.prevCpu) {
        const dTotal = cpu.total - this.prevCpu.total;
        const dIdle = cpu.idle - this.prevCpu.idle;
        if (dTotal > 0) cpuPercent = Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
      }
      if (cpu) this.prevCpu = cpu;
    } else {
      const cpus = os.cpus();
      cpuPercent = 0;
      if (this._prevOsCpus) {
        let idle = 0;
        let total = 0;
        cpus.forEach((c, i) => {
          const p = this._prevOsCpus[i];
          if (!p) return;
          for (const k of Object.keys(c.times)) total += c.times[k] - p.times[k];
          idle += c.times.idle - p.times.idle;
        });
        if (total > 0) cpuPercent = Math.max(0, Math.min(100, ((total - idle) / total) * 100));
      }
      this._prevOsCpus = cpus;
    }

    let netRxRate = 0;
    let netTxRate = 0;
    const net = isLinux ? readNetTotals() : null;
    if (net && this.prevNet) {
      const dt = (now - this.prevNetAt) / 1000;
      if (dt > 0) {
        netRxRate = Math.max(0, (net.rx - this.prevNet.rx) / dt);
        netTxRate = Math.max(0, (net.tx - this.prevNet.tx) / dt);
      }
    }
    if (net) {
      this.prevNet = net;
      this.prevNetAt = now;
    }

    const mem = readMemInfo();
    const disk = readDiskUsage(process.env.GP_DISK_MOUNT || '/');

    this.last = {
      at: now,
      cpu: { percent: Number(cpuPercent.toFixed(1)), cores: os.cpus().length, model: os.cpus()[0]?.model || 'unknown' },
      memory: mem,
      swap: { total: mem.swapTotal, used: mem.swapUsed },
      disk,
      network: {
        rxBytesPerSec: Math.round(netRxRate),
        txBytesPerSec: Math.round(netTxRate),
        rxTotal: net?.rx || 0,
        txTotal: net?.tx || 0,
      },
      load: os.loadavg(),
      uptime: os.uptime(),
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      panelUptime: process.uptime(),
    };
    return this.last;
  }
}

/* --------------------------------------------------------------- process -- */

/**
 * Sum CPU ticks and RSS across a whole process group, so a launcher script
 * that forks the real game binary is still accounted for correctly.
 */
function readProcessGroup(pgid) {
  if (!isLinux || !pgid) return null;
  let ticks = 0;
  let rss = 0;
  let procs = 0;
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.charCodeAt(0) < 48 || entry.charCodeAt(0) > 57) continue;
    const raw = readFileSafe(`/proc/${entry}/stat`);
    if (!raw) continue;
    // comm may contain spaces/parens — split after the closing paren.
    const close = raw.lastIndexOf(')');
    if (close === -1) continue;
    const fields = raw.slice(close + 2).split(' ');
    // fields[0] = state, so pgrp (field 5 overall) is fields[2]
    const pgrp = Number(fields[2]);
    if (pgrp !== pgid) continue;
    procs++;
    ticks += Number(fields[11] || 0) + Number(fields[12] || 0); // utime + stime
    rss += Number(fields[21] || 0) * PAGE_SIZE;
  }
  if (!procs) return null;
  return { ticks, rss, procs, at: Date.now() };
}

/** Single-process fallback used when process groups are unavailable. */
function readProcess(pid) {
  if (!isLinux || !pid) return null;
  const raw = readFileSafe(`/proc/${pid}/stat`);
  if (!raw) return null;
  const close = raw.lastIndexOf(')');
  if (close === -1) return null;
  const fields = raw.slice(close + 2).split(' ');
  return {
    ticks: Number(fields[11] || 0) + Number(fields[12] || 0),
    rss: Number(fields[21] || 0) * PAGE_SIZE,
    procs: 1,
    at: Date.now(),
  };
}

/**
 * Turn two samples into a CPU percentage where 100 = one full core,
 * matching what `top` reports.
 */
function cpuPercentFrom(prev, next) {
  if (!prev || !next) return 0;
  const dt = (next.at - prev.at) / 1000;
  if (dt <= 0) return 0;
  const dTicks = next.ticks - prev.ticks;
  if (dTicks < 0) return 0;
  return Math.max(0, (dTicks / CLK_TCK / dt) * 100);
}

/** Directory size in bytes; `du` is far faster than walking in JS. */
async function directorySize(dir) {
  try {
    if (isLinux) {
      const { stdout } = await sh(`du -sb ${JSON.stringify(dir)} 2>/dev/null`, { timeout: 30000 });
      const n = Number(String(stdout).split(/\s+/)[0]);
      return Number.isFinite(n) ? n : 0;
    }
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        try {
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) total += fs.statSync(p).size;
        } catch {
          /* skip unreadable entries */
        }
      }
    };
    walk(dir);
    return total;
  } catch (err) {
    logger.debug('directorySize failed:', err.message);
    return 0;
  }
}

/** Fixed-length ring buffer used for the sparkline charts. */
class Ring {
  constructor(size) {
    this.size = size;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }

  toArray() {
    return this.items.slice();
  }
}

module.exports = {
  HostMetrics,
  readProcessGroup,
  readProcess,
  cpuPercentFrom,
  countConnections,
  directorySize,
  readDiskUsage,
  Ring,
  isLinux,
};
