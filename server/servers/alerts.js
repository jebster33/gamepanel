'use strict';

/**
 * Resource alerts: tell people (Discord, phone) when a server runs hot on
 * CPU or memory for a while, or its folder grows past a size, and when the
 * disk the panel lives on is nearly full.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 *
 * server.alerts = { cpu: percent, memory: percent of its limit, disk: GB, tps: below this (Paper) };
 * 0 or missing turns one off.
 */

const fs = require('fs');
const { config } = require('../core/config');
const { STATUS } = require('./constants');

const SUSTAIN_MS = 2 * 60_000; // over the line this long before anyone hears
const COOLDOWN_MS = 30 * 60_000; // then at most once per half hour per metric
const HOST_COOLDOWN_MS = 6 * 3600_000;

function cleanAlerts(input = {}) {
  const num = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  return { cpu: num(input.cpu, 6400), memory: num(input.memory, 100), disk: num(input.disk, 100_000), tps: num(input.tps, 20) };
}

module.exports = {
  cleanAlerts,

  checkAlerts() {
    const now = Date.now();
    for (const server of this.servers) {
      const limits = server.alerts;
      if (!limits) continue;
      const rt = this.rt(server.id);
      rt.alerts = rt.alerts || {};
      const running = rt.status === STATUS.RUNNING;
      const memPct = server.memory ? (rt.memory / (server.memory * 1024 * 1024)) * 100 : 0;
      this.alertWhen(server, rt, 'cpu', running && limits.cpu > 0 && rt.cpu >= limits.cpu, now, () => `CPU has been at ${Math.round(rt.cpu)}% for over 2 minutes (alert at ${limits.cpu}%)`);
      this.alertWhen(server, rt, 'memory', running && limits.memory > 0 && memPct >= limits.memory, now, () => `Memory has been at ${Math.round(memPct)}% of its ${server.memory} MB limit for over 2 minutes`);
      this.alertWhen(server, rt, 'tps', running && limits.tps > 0 && rt.tps != null && rt.tps < limits.tps, now, () => `TPS has been ${rt.tps.toFixed(1)} for over 2 minutes (alert below ${limits.tps}). Players will feel lag.`);
      const diskGb = (rt.diskBytes || 0) / 1024 ** 3;
      this.alertWhen(server, rt, 'disk', limits.disk > 0 && diskGb >= limits.disk, now, () => `The server folder is ${diskGb.toFixed(1)} GB (alert at ${limits.disk} GB)`, 0);
    }
  },

  alertWhen(server, rt, metric, over, now, message, sustain = SUSTAIN_MS) {
    const state = (rt.alerts[metric] = rt.alerts[metric] || { since: 0, sent: 0 });
    if (!over) {
      state.since = 0;
      return;
    }
    if (!state.since) state.since = now;
    if (now - state.since < sustain || (state.sent && now - state.sent < COOLDOWN_MS)) return;
    state.sent = now;
    this.store.addEvent('server.resource_alert', `${server.name}: ${message()}`, { serverId: server.id, metric });
  },

  /** The disk holding servers and backups: warn below 5% or 2 GB free. */
  checkHostDisk() {
    if (typeof fs.statfsSync !== 'function') return null;
    let stat;
    try {
      stat = fs.statfsSync(config.dataDir);
    } catch {
      return null;
    }
    const free = stat.bavail * stat.bsize;
    const total = stat.blocks * stat.bsize;
    const low = free < 2 * 1024 ** 3 || free / total < 0.05;
    if (low && Date.now() - (this.hostDiskAlertAt || 0) > HOST_COOLDOWN_MS) {
      this.hostDiskAlertAt = Date.now();
      this.store.addEvent('panel.disk_low', `Only ${(free / 1024 ** 3).toFixed(1)} GB is free on the panel's disk. Delete old backups or make room before servers fail to save.`);
    }
    return { free, total, low };
  },
};
