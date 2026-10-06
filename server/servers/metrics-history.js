'use strict';

/**
 * Long-term CPU, memory and player history behind the graphs: one point a
 * minute for the last day and one every 15 minutes for the last 30 days,
 * kept per server in data/metrics/<id>.json so it survives restarts.
 * Mixed into ServerManager (see manager.js).
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');

const DIR = path.join(config.dataDir, 'metrics');
const TIERS = [
  { name: 'minute', every: 60_000, keep: 24 * 60 },
  { name: 'quarter', every: 15 * 60_000, keep: 30 * 24 * 4 },
];
const RANGES = { '1h': ['minute', 60 * 60_000], '24h': ['minute', 24 * 60 * 60_000], '7d': ['quarter', 7 * 24 * 60 * 60_000], '30d': ['quarter', 30 * 24 * 60 * 60_000] };

const fileFor = (id) => path.join(DIR, `${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.json`);

module.exports = {
  metricStore(id) {
    this.metricStores ||= new Map();
    let m = this.metricStores.get(id);
    if (!m) {
      m = { minute: [], quarter: [], acc: {} };
      try {
        Object.assign(m, JSON.parse(fs.readFileSync(fileFor(id), 'utf8')));
      } catch {
        /* first run for this server */
      }
      m.acc = {};
      this.metricStores.set(id, m);
    }
    return m;
  },

  /** Fold one live sample into the minute and 15-minute averages. */
  recordMetric(id, point) {
    const m = this.metricStore(id);
    for (const tier of TIERS) {
      const slot = Math.floor(point.t / tier.every) * tier.every;
      const acc = m.acc[tier.name];
      if (acc && acc.t !== slot && acc.n) {
        m[tier.name].push({ t: acc.t, cpu: +(acc.cpu / acc.n).toFixed(1), mem: Math.round(acc.mem / acc.n), memMax: acc.memMax, players: +(acc.players / acc.n).toFixed(1), playersMax: acc.playersMax });
        if (m[tier.name].length > tier.keep) m[tier.name].splice(0, m[tier.name].length - tier.keep);
        m.dirty = true;
      }
      if (!acc || acc.t !== slot) m.acc[tier.name] = { t: slot, n: 0, cpu: 0, mem: 0, memMax: 0, players: 0, playersMax: 0 };
      const a = m.acc[tier.name];
      a.n++;
      a.cpu += point.cpu;
      a.mem += point.mem;
      a.memMax = Math.max(a.memMax, point.mem);
      a.players += point.players;
      a.playersMax = Math.max(a.playersMax, point.players);
    }
  },

  /** Points for a range ("1h", "24h", "7d", "30d"); no range means the live few minutes. */
  getHistory(id, range) {
    if (!RANGES[range]) return this.rt(id).history.toArray();
    const [tier, span] = RANGES[range];
    const since = Date.now() - span;
    return this.metricStore(id)[tier].filter((p) => p.t >= since);
  },

  saveMetricHistories() {
    if (!this.metricStores) return;
    for (const [id, m] of this.metricStores) {
      if (!m.dirty || !this.servers.some((s) => s.id === id)) continue;
      try {
        fs.mkdirSync(DIR, { recursive: true });
        const tmp = `${fileFor(id)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ minute: m.minute, quarter: m.quarter }));
        fs.renameSync(tmp, fileFor(id));
        m.dirty = false;
      } catch {
        /* try again next time */
      }
    }
  },

  dropMetricHistory(id) {
    this.metricStores?.delete(id);
    fs.rm(fileFor(id), { force: true }, () => {});
  },
};
