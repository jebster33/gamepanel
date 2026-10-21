'use strict';

/**
 * Monthly uptime report (PDF) for the whole fleet and for each server:
 * uptime %, crashes, restarts, peak players, backups ok/failed and disk
 * growth. Numbers come from what the panel already records (the player
 * history samples every 5 minutes, the history log, the event log), plus a
 * small tracker here for the things nothing kept long enough: monthly
 * backup/crash counters and one disk-size sample per day.
 *
 * Reports are saved in data/reports/. With "Make it automatically" on, the
 * previous month is written on the 1st and announced as a panel.report event,
 * which Discord/ntfy/Slack alerts, the bell and phone push already carry.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { HttpError, logger } = require('../core/util');
const { PdfDocument, COLORS } = require('./pdf');

const DIR = path.join(config.dataDir, 'reports');
const STATS_FILE = path.join(DIR, 'stats.json');
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const FILE_RE = /^uptime-(\d{4}-(0[1-9]|1[0-2]))\.pdf$/;
const DAY = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

function parseMonth(value) {
  const m = MONTH_RE.exec(String(value || ''));
  if (!m) throw new HttpError(400, 'month must look like 2026-09');
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const from = new Date(year, month, 1).getTime();
  const to = new Date(year, month + 1, 1).getTime();
  return { key: `${m[1]}-${m[2]}`, label: `${MONTHS[month]} ${year}`, from, to, days: Math.round((to - from) / DAY) };
}

const previousMonthKey = (now = new Date()) => monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));

/* ---------------------------------------------------------------- tracker -- */

class Tracker {
  constructor(store, manager, file = STATS_FILE) {
    this.store = store;
    this.manager = manager;
    this.file = file;
    this.data = { counters: {}, disk: {} };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* first run */
    }
    store.on('event', (event) => this.onEvent(event));
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (err) {
      logger.warn(`Could not save report statistics: ${err.message}`);
    }
  }

  bump(serverId, field, at = Date.now()) {
    const month = (this.data.counters[monthKey(new Date(at))] ||= {});
    const row = (month[serverId] ||= {});
    row[field] = (row[field] || 0) + 1;
    this.dirty = true;
  }

  onEvent(event) {
    if (!event.serverId) return;
    if (event.type === 'server.crashed') this.bump(event.serverId, 'crashes', event.at);
    else if (event.type === 'backup.created') this.bump(event.serverId, 'backupsOk', event.at);
    else if (event.type === 'backup.failed' || event.type === 'backup.verify_failed') this.bump(event.serverId, 'backupsFailed', event.at);
    if (this.dirty) {
      this.dirty = false;
      this.save();
    }
  }

  /** One disk-size sample per server per day, kept for 13 months. */
  sampleDisk(now = Date.now()) {
    const day = Math.floor(now / DAY);
    for (const server of this.manager.servers) {
      const bytes = this.manager.rt(server.id)?.diskBytes;
      if (!bytes) continue;
      const list = (this.data.disk[server.id] ||= []);
      if (list.length && list[list.length - 1][0] === day) list[list.length - 1][1] = bytes;
      else list.push([day, bytes]);
      if (list.length > 400) list.splice(0, list.length - 400);
    }
    this.save();
  }

  counters(key, serverId) {
    return this.data.counters[key]?.[serverId] || {};
  }

  /** [first, last] byte samples inside the month, or null when there are fewer than two. */
  diskRange(serverId, from, to) {
    const list = (this.data.disk[serverId] || []).filter(([d]) => d * DAY >= from - DAY && d * DAY < to);
    return list.length >= 2 ? [list[0][1], list[list.length - 1][1]] : null;
  }
}

/* ------------------------------------------------------------- the numbers -- */

/** Count restarts: a start within two minutes of a stop or crash. */
function countRestarts(log, from, to) {
  let last = null;
  let restarts = 0;
  for (const e of log) {
    if (!['start', 'stop', 'crash'].includes(e.type)) continue;
    if (e.t >= to) break;
    if (e.type === 'start' && last && e.t >= from && e.t - last.t < 120_000) restarts++;
    last = e;
  }
  return restarts;
}

/** Everything the PDF shows, as plain data (also handy for tests). */
function collect({ manager, store, tracker }, monthValue, onlyServerId) {
  const period = parseMonth(monthValue);
  const servers = manager.servers.filter((s) => !onlyServerId || s.id === onlyServerId);
  if (onlyServerId && !servers.length) throw new HttpError(404, 'No such server');
  const events = store.state.events;
  const rows = servers.map((server) => {
    const h = manager.history(server.id);
    const samples = h.samples.filter(([t]) => t >= period.from && t < period.to);
    const up = samples.filter(([, n]) => n != null).length;
    const daily = Array.from({ length: period.days }, () => [0, 0]);
    let peak = null;
    for (const [t, n] of samples) {
      const bin = daily[Math.min(period.days - 1, Math.floor((t - period.from) / DAY))];
      bin[1]++;
      if (n != null) {
        bin[0]++;
        if (peak == null || n > peak) peak = n;
      }
    }
    const logIn = h.log.filter((e) => e.t >= period.from && e.t < period.to);
    const tracked = tracker.counters(period.key, server.id);
    const fromEvents = (types) => events.filter((e) => e.serverId === server.id && e.at >= period.from && e.at < period.to && types.includes(e.type)).length;
    const disk = tracker.diskRange(server.id, period.from, period.to);
    return {
      id: server.id,
      name: server.name,
      game: server.templateId,
      samples: samples.length,
      uptime: samples.length ? up / samples.length : null,
      daily: daily.map(([on, all]) => (all ? on / all : null)),
      crashes: Math.max(logIn.filter((e) => e.type === 'crash').length, tracked.crashes || 0),
      starts: logIn.filter((e) => e.type === 'start').length,
      restarts: countRestarts(h.log, period.from, period.to),
      peakPlayers: peak,
      backupsOk: Math.max(tracked.backupsOk || 0, fromEvents(['backup.created'])),
      backupsFailed: Math.max(tracked.backupsFailed || 0, fromEvents(['backup.failed', 'backup.verify_failed'])),
      diskStart: disk ? disk[0] : null,
      diskEnd: disk ? disk[1] : null,
      diskGrowth: disk ? disk[1] - disk[0] : null,
    };
  });
  const measured = rows.filter((r) => r.uptime != null);
  const sum = (key) => rows.reduce((a, r) => a + (r[key] || 0), 0);
  const peaks = rows.map((r) => r.peakPlayers).filter((n) => n != null);
  const growths = rows.map((r) => r.diskGrowth).filter((n) => n != null);
  return {
    period,
    servers: rows,
    fleet: {
      servers: rows.length,
      uptime: measured.length ? measured.reduce((a, r) => a + r.uptime, 0) / measured.length : null,
      crashes: sum('crashes'),
      restarts: sum('restarts'),
      peakPlayers: peaks.length ? Math.max(...peaks) : null,
      backupsOk: sum('backupsOk'),
      backupsFailed: sum('backupsFailed'),
      diskGrowth: growths.length ? growths.reduce((a, b) => a + b, 0) : null,
    },
  };
}

/* --------------------------------------------------------------------- PDF -- */

const pct = (v) => (v == null ? 'no data' : `${(v * 100).toFixed(v >= 0.9995 ? 0 : 2)}%`);
const tone = (v) => (v == null ? undefined : v >= 0.99 ? 'good' : v >= 0.95 ? 'warn' : 'bad');
const barColor = (v) => ({ good: COLORS.good, warn: COLORS.warn, bad: COLORS.bad })[tone(v)] || COLORS.accent;
function bytes(n) {
  if (n == null) return 'n/a';
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  const a = Math.abs(n);
  return `${sign}${a >= 1024 ** 3 ? `${(a / 1024 ** 3).toFixed(2)} GB` : `${Math.round(a / 1024 ** 2)} MB`}`;
}
const count = (v) => (v == null ? 'n/a' : String(v));

function renderPdf(report, panelName = 'GamePanel') {
  const { period, fleet, servers } = report;
  const doc = new PdfDocument({ title: `${panelName} uptime report ${period.label}`, footer: `${panelName} - uptime report - ${period.label}` });
  doc.h1('Monthly uptime report');
  doc.para(`${panelName}  |  ${period.label}  |  generated ${new Date().toISOString().slice(0, 10)}`, { size: 10 });
  doc.space(4);
  doc.stats([
    { label: 'Fleet uptime', value: pct(fleet.uptime), tone: tone(fleet.uptime) },
    { label: 'Crashes', value: fleet.crashes, tone: fleet.crashes ? 'bad' : 'good' },
    { label: 'Restarts', value: fleet.restarts },
    { label: 'Peak players', value: count(fleet.peakPlayers) },
  ]);
  doc.stats([
    { label: 'Servers', value: fleet.servers },
    { label: 'Backups ok', value: fleet.backupsOk, tone: 'good' },
    { label: 'Backups failed', value: fleet.backupsFailed, tone: fleet.backupsFailed ? 'bad' : undefined },
    { label: 'Disk growth', value: bytes(fleet.diskGrowth) },
  ]);

  doc.h2('Uptime by server');
  if (servers.length) doc.bars(servers.map((s) => ({ label: s.name, value: s.uptime, text: pct(s.uptime), color: barColor(s.uptime) })));
  else doc.para('This panel has no servers yet.');

  doc.h2('All servers');
  doc.table(
    ['Server', 'Uptime', 'Crashes', 'Restarts', 'Peak', 'Backups ok/failed', 'Disk growth'],
    servers.map((s) => [s.name, { text: pct(s.uptime), color: s.uptime == null ? COLORS.faint : COLORS[tone(s.uptime)] }, s.crashes, s.restarts, count(s.peakPlayers), `${s.backupsOk} / ${s.backupsFailed}`, bytes(s.diskGrowth)]),
    { widths: [0.26, 0.12, 0.1, 0.1, 0.08, 0.2, 0.14], align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'] }
  );

  for (const s of servers) {
    doc.newPage();
    doc.h1(s.name);
    doc.para(`${s.game || 'Server'}  |  ${period.label}  |  ${s.samples} status samples`);
    doc.stats([
      { label: 'Uptime', value: pct(s.uptime), tone: tone(s.uptime) },
      { label: 'Crashes', value: s.crashes, tone: s.crashes ? 'bad' : 'good' },
      { label: 'Restarts', value: s.restarts },
      { label: 'Peak players', value: count(s.peakPlayers) },
    ]);
    doc.columns(s.daily, { label: `UPTIME PER DAY (1-${period.days}), GREEN 99%+ / AMBER 90%+ / RED BELOW` });
    doc.table(
      ['What', 'Value'],
      [
        ['Starts', s.starts],
        ['Backups completed', s.backupsOk],
        ['Backups failed', s.backupsFailed],
        ['Disk at first sample', s.diskStart == null ? 'n/a' : bytes(s.diskStart).replace('+', '')],
        ['Disk at last sample', s.diskEnd == null ? 'n/a' : bytes(s.diskEnd).replace('+', '')],
        ['Disk growth', bytes(s.diskGrowth)],
      ],
      { widths: [0.6, 0.4], align: ['left', 'right'] }
    );
  }
  return doc.build();
}

/* ----------------------------------------------------------------- service -- */

class Reports {
  constructor(app) {
    this.app = app;
    this.tracker = new Tracker(app.store, app.manager);
    this.timer = null;
  }

  get settings() {
    return (this.app.store.state.settings.reports ||= { auto: false });
  }

  pdf(monthValue, serverId) {
    const data = collect({ manager: this.app.manager, store: this.app.store, tracker: this.tracker }, monthValue, serverId);
    return { data, buffer: renderPdf(data, this.app.store.state.settings.panelName || 'GamePanel') };
  }

  /** Write data/reports/uptime-YYYY-MM.pdf and return its summary. */
  save(monthValue) {
    const { data, buffer } = this.pdf(monthValue);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, `uptime-${data.period.key}.pdf`), buffer);
    return data;
  }

  list() {
    let names = [];
    try {
      names = fs.readdirSync(DIR);
    } catch {
      /* none yet */
    }
    return names
      .map((name) => ({ name, m: FILE_RE.exec(name) }))
      .filter((e) => e.m)
      .map((e) => ({ name: e.name, month: e.m[1], label: parseMonth(e.m[1]).label, size: fs.statSync(path.join(DIR, e.name)).size }))
      .sort((a, b) => b.month.localeCompare(a.month));
  }

  /** Path of a saved report by file name (strictly validated), or null. */
  file(name) {
    if (!FILE_RE.test(String(name))) return null;
    const file = path.join(DIR, name);
    return fs.existsSync(file) ? file : null;
  }

  /** Make last month's report once, on or after the 1st, and announce it. */
  autoRun(now = new Date()) {
    if (!this.settings.auto) return null;
    const key = previousMonthKey(now);
    if (this.file(`uptime-${key}.pdf`)) return null;
    // A panel that did not exist last month has nothing to say about it.
    if (!this.app.manager.servers.length) return null;
    const data = this.save(key);
    const f = data.fleet;
    this.app.store.addEvent('panel.report', `The ${data.period.label} uptime report is ready: fleet uptime ${pct(f.uptime)}, ${f.crashes} crash${f.crashes === 1 ? '' : 'es'}, ${f.backupsFailed} failed backup${f.backupsFailed === 1 ? '' : 's'}. Download it in Settings, Reports.`);
    return data;
  }

  start() {
    const tick = () => {
      try {
        this.tracker.sampleDisk();
        this.autoRun();
      } catch (err) {
        logger.warn(`Report job failed: ${err.message}`);
      }
    };
    // Disk sizes arrive a minute after start; then once an hour is plenty.
    setTimeout(tick, 90_000).unref?.();
    this.timer = setInterval(tick, 3_600_000);
    this.timer.unref?.();
  }
}

let instance = null;
function init(app) {
  if (!instance) {
    instance = new Reports(app);
    if (app.manager?.servers && process.env.GP_NO_REPORT_TIMER !== '1') instance.start();
  }
  return instance;
}

module.exports = { Reports, Tracker, init, collect, renderPdf, parseMonth, previousMonthKey, countRestarts, FILE_RE, DIR };
