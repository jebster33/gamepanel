'use strict';

/**
 * Player history and the activity log, BattleMetrics style: every player the
 * server has seen with first/last seen and play time, sessions, a players
 * online graph, and a log of joins, leaves, chat, kicks, bans and restarts.
 *
 * Kept per server in data/players/<id>.json. Mixed into ServerManager (see
 * manager.js), so `this` is the manager.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { logger } = require('../core/util');
const { STATUS } = require('./constants');

const DIR = path.join(config.dataDir, 'players');
const MAX_LOG = 5000;
const MAX_SESSIONS = 25; // per player
const SAMPLE_EVERY_MS = 5 * 60_000;
const MAX_SAMPLES = 30 * 24 * 12; // 30 days of 5-minute points
const SAVE_EVERY_MS = 60_000;

// Minecraft Java chat: "[12:00:00] [Server thread/INFO]: <Steve> hello" (also "[Not Secure] <Steve> hi").
const MC_CHAT = /\]:\s+(?:\[Not Secure\]\s+)?<([A-Za-z0-9_]{3,16})>\s(.*)$/;

const fileFor = (id) => path.join(DIR, `${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.json`);

function blank() {
  return { players: {}, log: [], samples: [], open: {} };
}

module.exports = {
  /** The history for one server, loaded from disk on first use. */
  history(id) {
    if (!this.histories) this.histories = new Map();
    let h = this.histories.get(id);
    if (h) return h;
    h = blank();
    try {
      Object.assign(h, JSON.parse(fs.readFileSync(fileFor(id), 'utf8')));
    } catch {
      /* new server, or nothing saved yet */
    }
    // Sessions still open when the panel last stopped end where we last saw them.
    for (const [name, start] of Object.entries(h.open || {})) {
      const end = h.players[name]?.last || start;
      h.log.push({ t: end, type: 'leave', name, dur: this.closeSession(h, name, start, end) });
    }
    h.open = {};
    h.known = new Set();
    h.lastStatus = null;
    h.dirty = false;
    this.histories.set(id, h);
    return h;
  },

  logActivity(id, entry) {
    const h = this.history(id);
    h.log.push({ t: Date.now(), ...entry });
    if (h.log.length > MAX_LOG) h.log.splice(0, h.log.length - MAX_LOG);
    h.dirty = true;
  },

  closeSession(h, name, start, end) {
    const p = h.players[name];
    if (!p) return 0;
    const dur = Math.max(0, end - start);
    p.seconds = (p.seconds || 0) + Math.round(dur / 1000);
    p.last = end;
    p.recent = [...(p.recent || []), { start, end }].slice(-MAX_SESSIONS);
    return dur;
  },

  /** Called on every metrics tick: diff who is online and note status changes. */
  observePlayers() {
    const now = Date.now();
    for (const server of this.servers) {
      const rt = this.rt(server.id);
      const h = this.history(server.id);

      if (h.lastStatus !== rt.status) {
        if (h.lastStatus !== null) {
          if (rt.status === STATUS.RUNNING) this.logActivity(server.id, { type: 'start' });
          else if (rt.status === STATUS.CRASHED) this.logActivity(server.id, { type: 'crash' });
          else if (rt.status === STATUS.OFFLINE && h.lastStatus !== STATUS.INSTALLING) this.logActivity(server.id, { type: 'stop' });
        }
        h.lastStatus = rt.status;
      }

      const online = new Set(rt.playerList || []);
      for (const name of online) {
        if (h.known.has(name)) {
          if (h.players[name]) h.players[name].last = now;
          continue;
        }
        const p = (h.players[name] ||= { name, first: now, last: now, seconds: 0, sessions: 0, recent: [] });
        p.sessions += 1;
        p.last = now;
        // A join time from the query (players already on when the panel started) beats "now".
        const since = rt.playerInfo?.get(name)?.since;
        h.open[name] = since && since < now ? since : now;
        if (p.first > h.open[name]) p.first = h.open[name];
        this.logActivity(server.id, { type: 'join', name });
      }
      for (const name of h.known) {
        if (online.has(name)) continue;
        const dur = this.closeSession(h, name, h.open[name] || now, now);
        delete h.open[name];
        this.logActivity(server.id, { type: 'leave', name, dur });
      }
      h.known = online;
      if (online.size) h.dirty = true;

      this.checkIdle(server, rt, online.size, now);

      const lastSample = h.samples[h.samples.length - 1];
      if (!lastSample || now - lastSample[0] >= SAMPLE_EVERY_MS) {
        // Offline is recorded as null so the graph shows a gap, not zero players.
        const count = rt.status === STATUS.RUNNING ? (rt.players ?? online.size) : null;
        h.samples.push([now, count]);
        if (h.samples.length > MAX_SAMPLES) h.samples.splice(0, h.samples.length - MAX_SAMPLES);
        h.dirty = true;
      }
    }
    if (!this.historySavedAt || now - this.historySavedAt > SAVE_EVERY_MS) this.saveHistories();
  },

  /** Stop a server nobody has been on for a while, if it is set to (saves RAM and CPU). */
  checkIdle(server, rt, online, now) {
    const limit = Number(server.idleStopMinutes) || 0;
    if (!limit) return;
    // Only for games that tell us who is on; otherwise "nobody" might just mean "unknown".
    const knowable = rt.players != null || this.template(server)?.logPatterns?.join;
    const players = rt.players ?? online;
    if (!limit || !knowable || rt.status !== STATUS.RUNNING || players > 0) {
      rt.emptySince = null;
      return;
    }
    rt.emptySince ||= Math.max(now, (rt.startedAt || now));
    if (now - rt.emptySince < limit * 60_000 || rt.stopping) return;
    rt.emptySince = null;
    this.pushConsole(server, `Nobody has been on for ${limit} minutes, so the server is stopping to save resources.`, 'system');
    this.store.addEvent('server.idle_stopped', `${server.name} stopped after ${limit} minutes with nobody on`, { serverId: server.id });
    this.logActivity(server.id, { type: 'idle' });
    this.stop(server.id).catch(() => {});
  },

  /** Chat lines from the console, for the activity log. */
  trackChat(server, template, text) {
    const custom = template.logPatterns?.chat;
    const pattern = custom ? new RegExp(custom) : template.query?.type === 'minecraft' ? MC_CHAT : null;
    if (!pattern) return;
    for (const line of text.split('\n')) {
      const m = line.match(pattern);
      if (m) this.logActivity(server.id, { type: 'chat', name: m[1], text: String(m[2] || '').trim().slice(0, 500) });
    }
  },

  saveHistories() {
    this.historySavedAt = Date.now();
    if (!this.histories) return;
    for (const [id, h] of this.histories) {
      if (!h.dirty) continue;
      if (!this.servers.some((s) => s.id === id)) continue;
      try {
        fs.mkdirSync(DIR, { recursive: true });
        const { players, log, samples, open } = h;
        const tmp = `${fileFor(id)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ players, log, samples, open }));
        fs.renameSync(tmp, fileFor(id));
        h.dirty = false;
      } catch (err) {
        logger.warn(`Could not save player history for ${id}: ${err.message}`);
      }
    }
  },

  deleteHistory(id) {
    this.histories?.delete(id);
    fs.rmSync(fileFor(id), { force: true });
  },

  /** Everyone the server has seen, with totals, plus the players-online graph. */
  playerHistory(id) {
    const h = this.history(id);
    const now = Date.now();
    const players = Object.values(h.players).map((p) => {
      const openSince = h.open[p.name];
      return {
        name: p.name,
        first: p.first,
        last: openSince ? now : p.last,
        online: Boolean(openSince),
        seconds: (p.seconds || 0) + (openSince ? Math.round((now - openSince) / 1000) : 0),
        sessions: p.sessions || 0,
      };
    });
    players.sort((a, b) => b.online - a.online || b.last - a.last);
    const peak = (ms) => h.samples.filter(([t, n]) => now - t <= ms && n != null).reduce((m, [, n]) => Math.max(m, n), 0);
    return {
      players,
      samples: h.samples,
      summary: {
        unique: players.length,
        online: players.filter((p) => p.online).length,
        new24h: players.filter((p) => now - p.first <= 86_400_000).length,
        active7d: players.filter((p) => now - p.last <= 7 * 86_400_000).length,
        peak24h: peak(86_400_000),
        peak7d: peak(7 * 86_400_000),
        hours: Math.round(players.reduce((s, p) => s + p.seconds, 0) / 360) / 10,
      },
    };
  },

  /** One player's profile: totals, recent sessions and what they did. */
  playerProfile(id, name) {
    const h = this.history(id);
    const p = h.players[name];
    if (!p) return null;
    const summary = this.playerHistory(id).players.find((x) => x.name === name);
    const sessions = [...(p.recent || [])];
    if (h.open[name]) sessions.push({ start: h.open[name], end: null });
    return {
      ...summary,
      recent: sessions.reverse(),
      log: h.log.filter((e) => e.name === name).slice(-200).reverse(),
    };
  },

  /** The activity log, newest first, filtered by type and text. */
  activityLog(id, { before, types, q, limit = 100 } = {}) {
    const h = this.history(id);
    const wanted = types?.length ? new Set(types) : null;
    const needle = q ? String(q).toLowerCase() : '';
    const out = [];
    for (let i = h.log.length - 1; i >= 0 && out.length < limit; i--) {
      const e = h.log[i];
      if (before && e.t >= before) continue;
      if (wanted && !wanted.has(e.type)) continue;
      if (needle && !`${e.name || ''} ${e.text || ''}`.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return { entries: out, more: out.length === limit };
  },
};
