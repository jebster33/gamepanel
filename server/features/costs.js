'use strict';

/**
 * What each server costs to run. The panel samples every running server each
 * minute (CPU used and memory held) and the machine's load, and splits a
 * month's cost between the servers by how much they used.
 *
 * The cost of a month is the electricity (the machine's watts, from an idle and
 * a full-load figure and its CPU load, times the price per kWh) plus a fixed
 * amount (a VPS bill, internet, rent). A share of it (overhead) is the panel
 * and idle time and is not charged to any server.
 *
 * settings.costs = { currency, kwhPrice, idleWatts, maxWatts, fixedMonthly, overheadPercent }
 * state.costs[YYYY-MM] = { minutes, kwh, servers: { id: { name, cpuSec, memMbMin, runMin } } }
 */

const { fail } = require('../core/util');

const DEFAULTS = { currency: 'USD', kwhPrice: 0.15, idleWatts: 30, maxWatts: 90, fixedMonthly: 0, overheadPercent: 10 };

const monthKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const settingsOf = (store) => ({ ...DEFAULTS, ...(store.state.settings.costs || {}) });
const dataOf = (store) => (store.state.costs ||= {});

function update(store, body = {}) {
  const s = settingsOf(store);
  const num = (key, min, max) => {
    if (body[key] === undefined) return;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < min || n > max) fail(400, `${key} must be between ${min} and ${max}`);
    s[key] = n;
  };
  num('kwhPrice', 0, 100);
  num('idleWatts', 0, 5000);
  num('maxWatts', 0, 10000);
  num('fixedMonthly', 0, 1_000_000);
  num('overheadPercent', 0, 90);
  if (body.currency !== undefined) {
    if (!/^[A-Za-z]{3}$|^[^\w\s]{1,3}$/.test(String(body.currency).trim())) fail(400, 'Currency: a code like EUR or a symbol like $');
    s.currency = String(body.currency).trim().toUpperCase();
  }
  store.state.settings.costs = s;
  store.save();
  return s;
}

/** Called every minute with the host's CPU percent (0-100). Only the servers on this machine are counted. */
function sample(manager, store, hostCpuPercent, now) {
  const s = settingsOf(store);
  const month = (dataOf(store)[monthKey(now)] ||= { minutes: 0, kwh: 0, servers: {} });
  const watts = s.idleWatts + (s.maxWatts - s.idleWatts) * Math.max(0, Math.min(100, hostCpuPercent || 0)) / 100;
  month.minutes++;
  month.kwh += watts / 1000 / 60;
  for (const server of manager.servers) {
    if (server.node || !manager.isActive(server.id)) continue;
    const rt = manager.rt(server.id);
    const e = (month.servers[server.id] ||= { name: server.name, cpuSec: 0, memMbMin: 0, runMin: 0 });
    e.name = server.name;
    e.cpuSec += (rt.cpu || 0) / 100 * 60;
    e.memMbMin += (rt.memory || 0) / 1048576;
    e.runMin++;
  }
  // Keep two years.
  const keys = Object.keys(dataOf(store)).sort();
  while (keys.length > 24) delete dataOf(store)[keys.shift()];
  if (month.minutes % 10 === 0) store.save();
}

/** One month's bill split between servers. `month` is "2026-10"; the default is this month. */
function report(store, month = monthKey(Date.now()), now = Date.now()) {
  const s = settingsOf(store);
  const m = dataOf(store)[month] || { minutes: 0, kwh: 0, servers: {} };
  const power = m.kwh * s.kwhPrice;
  // The fixed amount is for the whole month; part of a month charges its share so far.
  const [y, mo] = month.split('-').map(Number);
  const days = new Date(y, mo, 0).getDate();
  const elapsed = month === monthKey(now) ? Math.min(1, new Date(now).getDate() / days) : 1;
  const fixed = s.fixedMonthly * elapsed;
  const total = power + fixed;
  const charge = total * (1 - s.overheadPercent / 100);
  const list = Object.entries(m.servers);
  const cpuTotal = list.reduce((a, [, e]) => a + e.cpuSec, 0);
  const memTotal = list.reduce((a, [, e]) => a + e.memMbMin, 0);
  const servers = list
    .map(([id, e]) => {
      const share = (cpuTotal ? 0.5 * (e.cpuSec / cpuTotal) : 0) + (memTotal ? 0.5 * (e.memMbMin / memTotal) : 0);
      return { id, name: e.name, share, cost: charge * share, cpuHours: e.cpuSec / 3600, memGbHours: e.memMbMin / 60 / 1024, runHours: e.runMin / 60 };
    })
    .sort((a, b) => b.cost - a.cost);
  return {
    month,
    settings: s,
    kwh: m.kwh,
    power,
    fixed,
    total,
    overhead: total - charge,
    servers,
    months: Object.keys(dataOf(store)).sort().reverse(),
    hoursSampled: m.minutes / 60,
  };
}

module.exports = { update, sample, report, settingsOf, monthKey, DEFAULTS };
