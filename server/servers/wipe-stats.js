'use strict';

/**
 * Wipe stats for survival servers (Rust, ARK, ...): for each wipe, how many
 * players showed up, how many were new and how many came back from earlier,
 * the peak, and how fast the population falls off day by day.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 *
 * Kept in the player history file: history.wipes = [{ at, seed, blueprints,
 * baseline, peak, players: { name: [isNew, dayMask] } }]. A wipe starts when
 * server.lastWipe moves (see features/wipe.js). The first period begins at
 * the last wipe the panel knew of, or when the panel first saw a player, and
 * is a "baseline" when no wipe is known: its New/Returning split is not meaningful.
 */

const DAY = 86_400_000;
const MAX_DAYS = 31; // days after a wipe that are counted (a bit per day)
const MAX_WIPES = 24;

const dayOf = (wipe, now) => Math.floor((now - wipe.at) / DAY);

module.exports = {
  /** The wipe period in progress, started (or backfilled) if needed. Null for games without wipes. */
  currentWipe(server, h) {
    if (!this.template(server)?.wipe) return null;
    h.wipes = h.wipes || [];
    const last = h.wipes[h.wipes.length - 1];
    const lw = server.lastWipe;
    if (lw && (!last || lw.at > last.at + 1000)) {
      h.wipes.push({ at: lw.at, seed: lw.seed ?? null, blueprints: Boolean(lw.blueprints), baseline: false, peak: 0, players: {} });
      if (!last) this.backfillWipe(h, h.wipes[0]);
    } else if (!last) {
      const first = Object.values(h.players).reduce((m, p) => Math.min(m, p.first), Infinity);
      if (!Number.isFinite(first)) return null; // nobody yet: start counting with the first player
      h.wipes.push({ at: first, seed: null, blueprints: false, baseline: true, peak: 0, players: {} });
      this.backfillWipe(h, h.wipes[0]);
    }
    if (h.wipes.length > MAX_WIPES) h.wipes.splice(0, h.wipes.length - MAX_WIPES);
    h.dirty = true;
    return h.wipes[h.wipes.length - 1];
  },

  /** Players' remembered sessions give the first period a head start. */
  backfillWipe(h, wipe) {
    for (const p of Object.values(h.players)) {
      for (const { start, end } of p.recent || []) {
        if ((end || start) < wipe.at) continue;
        this.markWipePlayer(h, wipe, p, Math.max(start, wipe.at));
        this.markWipePlayer(h, wipe, p, end || start);
      }
    }
  },

  markWipePlayer(h, wipe, p, when) {
    const d = dayOf(wipe, when);
    if (d < 0) return;
    const entry = (wipe.players[p.name] ||= [p.first >= wipe.at - 60_000 ? 1 : 0, 0]);
    if (d < MAX_DAYS) entry[1] |= 1 << d;
    h.dirty = true;
  },

  /** Called from observePlayers for every server on every tick. */
  trackWipe(server, h, online, now) {
    const wipe = this.currentWipe(server, h);
    if (!wipe) return;
    for (const name of online) if (h.players[name]) this.markWipePlayer(h, wipe, h.players[name], now);
    const rt = this.rt(server.id);
    const count = Math.max(online.size, rt.status === 'running' ? rt.players || 0 : 0);
    if (count > wipe.peak) {
      wipe.peak = count;
      h.dirty = true;
    }
  },

  /** Per wipe: unique / new / returning players, peak, active players per day, retention. */
  wipeStats(server) {
    const h = this.history(server.id);
    const enabled = Boolean(this.template(server)?.wipe);
    if (!enabled) return { enabled: false, wipes: [] };
    this.currentWipe(server, h);
    const now = Date.now();
    const wipes = (h.wipes || []).map((w, i, all) => {
      const end = all[i + 1]?.at ?? now;
      const length = Math.max(1, Math.min(MAX_DAYS, Math.floor((end - w.at) / DAY) + 1));
      const entries = Object.values(w.players);
      const days = Array.from({ length }, (_, d) => entries.filter((e) => e[1] & (1 << d)).length);
      const top = Math.max(0, ...days);
      const afterTop = days.slice(days.indexOf(top));
      const halfIdx = top >= 4 ? afterTop.findIndex((n) => n <= top / 2) : -1;
      const day1 = entries.filter((e) => e[1] & 1 || e[1] & 2);
      const week = day1.filter((e) => e[1] & (1 << 6) || e[1] & (1 << 7) || e[1] & (1 << 8)).length;
      return {
        at: w.at,
        end: all[i + 1]?.at ?? null,
        seed: w.seed,
        blueprints: w.blueprints,
        baseline: Boolean(w.baseline),
        unique: entries.length,
        new: entries.filter((e) => e[0]).length,
        returning: entries.filter((e) => !e[0]).length,
        peak: w.peak,
        days,
        // Day the daily crowd first drops to half of its best day.
        halfDay: halfIdx > 0 ? days.indexOf(top) + halfIdx : null,
        // Of the players there in the first two days, the share seen again in days 7 to 9.
        retention7: length > 8 && day1.length >= 5 ? Math.round((week / day1.length) * 100) : null,
      };
    });
    return { enabled: true, wipes: wipes.reverse() };
  },
};
