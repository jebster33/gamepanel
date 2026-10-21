'use strict';

/**
 * Memory pressure alerts: tell people before the system starts killing
 * servers. Looks at the memory still available to programs, swap in use and
 * (Linux) the kernel's own "pressure stall" figure, which rises when the
 * machine is waiting on memory. Warns at 'warn' and 'critical' with the
 * servers using the most, and says when it is over.
 *
 * settings.pressure = { enabled } (on by default). Alerts go out as
 * panel.memory_pressure events (Discord, ntfy, phone push, the bell).
 */

const fs = require('fs');
const os = require('os');
const { isLinux } = require('../core/platform');

const REPEAT_MS = 30 * 60_000;
let last = { level: 'ok', at: 0 };

function readLinux() {
  try {
    const mem = {};
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
      if (m) mem[m[1]] = Number(m[2]) * 1024;
    }
    let psi = null;
    try {
      psi = Number(fs.readFileSync('/proc/pressure/memory', 'utf8').match(/some avg10=([\d.]+)/)?.[1]);
    } catch {
      /* kernel without PSI */
    }
    const swapTotal = mem.SwapTotal || 0;
    return { total: mem.MemTotal, available: mem.MemAvailable ?? mem.MemFree, swapTotal, swapUsed: swapTotal - (mem.SwapFree || 0), psi: Number.isFinite(psi) ? psi : null };
  } catch {
    return null;
  }
}

function snapshot(manager) {
  const raw = (isLinux && readLinux()) || { total: os.totalmem(), available: os.freemem(), swapTotal: 0, swapUsed: 0, psi: null };
  const availablePct = (raw.available / raw.total) * 100;
  const swapPct = raw.swapTotal ? (raw.swapUsed / raw.swapTotal) * 100 : 0;
  let level = 'ok';
  const why = [];
  if (availablePct < 12) {
    level = 'warn';
    why.push(`only ${availablePct.toFixed(0)}% of memory is left`);
  }
  if (swapPct > 50 && raw.swapTotal) {
    level = 'warn';
    why.push(`swap is ${swapPct.toFixed(0)}% full`);
  }
  if (raw.psi != null && raw.psi > 10) {
    level = 'warn';
    why.push(`the system is waiting on memory ${raw.psi.toFixed(0)}% of the time`);
  }
  if (availablePct < 6 || (swapPct > 80 && raw.swapTotal) || (raw.psi != null && raw.psi > 25)) level = 'critical';
  const top = manager.servers
    .filter((s) => !s.node && manager.isActive(s.id))
    .map((s) => ({ id: s.id, name: s.name, memory: manager.rt(s.id).memory || 0, limit: (s.memory || 0) * 1048576 }))
    .sort((a, b) => b.memory - a.memory)
    .slice(0, 5);
  return { level, why, total: raw.total, available: raw.available, availablePct, swapTotal: raw.swapTotal, swapUsed: raw.swapUsed, swapPct, psi: raw.psi, top };
}

function tick(manager, store, now) {
  if (store.state.settings.pressure?.enabled === false) return;
  const snap = snapshot(manager);
  const rank = { ok: 0, warn: 1, critical: 2 };
  const worse = rank[snap.level] > rank[last.level];
  if (snap.level === 'ok') {
    if (last.level !== 'ok') store.addEvent('panel.memory_pressure', 'Memory pressure is over: the machine has room again.');
    last = { level: 'ok', at: now };
    return;
  }
  if (!worse && now - last.at < REPEAT_MS) return;
  last = { level: snap.level, at: now };
  const names = snap.top.slice(0, 3).map((s) => `${s.name} ${Math.round(s.memory / 1048576)} MB`).join(', ');
  store.addEvent('panel.memory_pressure', `${snap.level === 'critical' ? 'Memory is critically low' : 'Memory is getting tight'}: ${snap.why.join(' and ')}.${names ? ` Biggest: ${names}.` : ''} Stop something or add memory before the system starts killing servers.`);
}

module.exports = { snapshot, tick };
