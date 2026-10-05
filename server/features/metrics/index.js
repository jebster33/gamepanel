'use strict';

/**
 * Host and per-server metrics on either OS.
 *   Linux    /proc (metrics/linux.js)
 *   Windows  a PowerShell sampler (metrics/windows.js)
 * Containers report their own numbers through the Docker stats stream.
 */

const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');

const { config } = require('../../core/config');
const { isWindows, describeHost } = require('../../core/platform');
const linux = require('./linux');

let sampler = null;
function windowsSampler() {
  if (!isWindows) return null;
  if (!sampler) {
    const { WindowsSampler } = require('./windows');
    sampler = new WindowsSampler(config.metricsIntervalMs);
    sampler.start();
  }
  return sampler;
}

class HostMetrics {
  constructor() {
    this.inner = new linux.HostMetrics();
    this.prevNet = null;
    this.host = describeHost();
    windowsSampler();
    this.last = this.sample();
  }

  sample() {
    const out = this.inner.sample();
    out.platform = this.host;
    out.os = isWindows ? 'windows' : 'linux';
    out.disk = linux.readDiskUsage(process.env.GP_DISK_MOUNT || (isWindows ? path.parse(config.dataDir).root : '/'));
    const s = windowsSampler();
    if (s?.latest) {
      const now = s.latest.at;
      if (this.prevNet && now > this.prevNet.at) {
        const dt = (now - this.prevNet.at) / 1000;
        out.network = {
          rxBytesPerSec: Math.max(0, Math.round((s.latest.rx - this.prevNet.rx) / dt)),
          txBytesPerSec: Math.max(0, Math.round((s.latest.tx - this.prevNet.tx) / dt)),
          rxTotal: s.latest.rx,
          txTotal: s.latest.tx,
        };
      } else if (this.prevNet) {
        out.network = this.last?.network || out.network;
      }
      if (!this.prevNet || now > this.prevNet.at) this.prevNet = { at: now, rx: s.latest.rx, tx: s.latest.tx };
    }
    this.last = out;
    return out;
  }
}

/**
 * CPU and memory of a server process and its children.
 * Returns { cpuMs, rss, procs, at } — CPU time in milliseconds.
 */
function sampleProcessTree(pid) {
  if (!pid) return null;
  if (isWindows) return windowsSampler()?.processTree(pid) || null;
  const s = linux.readProcessGroup(pid) || linux.readProcess(pid);
  return s ? { cpuMs: s.ticks * 10, rss: s.rss, procs: s.procs, at: s.at } : null;
}

/** CPU percentage between two samples, where 100 = one full core (like top). */
function cpuPercent(prev, next) {
  if (!prev || !next) return 0;
  const dt = next.at - prev.at;
  if (dt <= 0) return 0;
  const used = next.cpuMs - prev.cpuMs;
  return used > 0 ? (used / dt) * 100 : 0;
}

function countConnections(ports) {
  if (!ports?.length) return 0;
  if (isWindows) return windowsSampler()?.connections(ports) || 0;
  return linux.countConnections(ports);
}

/** Directory size in bytes, without blocking the event loop. */
async function directorySize(dir) {
  if (!isWindows) return linux.directorySize(dir);
  let total = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) total += (await fsp.stat(p)).size;
      } catch {
        /* skip unreadable entries */
      }
    }
  };
  if (fs.existsSync(dir)) await walk(dir);
  return total;
}

function stopSampler() {
  sampler?.stop();
}

module.exports = {
  HostMetrics,
  Ring: linux.Ring,
  sampleProcessTree,
  cpuPercent,
  countConnections,
  directorySize,
  readDiskUsage: linux.readDiskUsage,
  stopSampler,
};
