'use strict';

/**
 * One calendar for everything the panel will do on its own: every schedule
 * of every server, scheduled game events, and Rust's forced wipe (the first
 * Thursday of each month at 19:00 UTC, when Facepunch ships the monthly update).
 * Times are the panel host's local time, like the schedules themselves.
 */

const { parseCron, matches, inWeek } = require('./scheduler');

const DAY = 86400_000;
const MAX_ITEMS = 3000;

/** First Thursday of a month, 19:00 UTC, as a timestamp. month is 0-11. */
function forcedWipe(year, month) {
  const d = new Date(Date.UTC(year, month, 1, 19, 0, 0));
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

/** The next `count` forced wipes after `from`. */
function nextForcedWipes(from = Date.now(), count = 6) {
  const out = [];
  const d = new Date(from);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  while (out.length < count) {
    const t = forcedWipe(y, m);
    if (t >= from - DAY) out.push(t);
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

/** Cron + week-of-month for "this local weekday and time" matching a UTC moment; so a monthly forced wipe lands right in any timezone. */
function localSlot(utcMs) {
  const d = new Date(utcMs);
  return { minute: d.getMinutes(), hour: d.getHours(), weekday: d.getDay(), week: Math.ceil(d.getDate() / 7) };
}

/**
 * What to put in a schedule for a wipe tied to the forced wipe.
 * cadence: 'monthly' (on forced wipe day), 'biweekly' (forced day + two weeks later), 'weekly'.
 * `offsetHours` shifts the wipe after the forced update (it must come after the update ships).
 */
function wipePlan(cadence, offsetHours = 0, from = Date.now()) {
  const slot = localSlot(nextForcedWipes(from, 1)[0] + offsetHours * 3600_000);
  const base = { action: 'wipe', cron: `${slot.minute} ${slot.hour} * * ${slot.weekday}` };
  const list = [{ ...base, name: 'Forced wipe', weekOfMonth: slot.week }];
  if (cadence === 'biweekly') list.push({ ...base, name: 'Mid-month wipe', weekOfMonth: Math.min(4, slot.week + 2) });
  else if (cadence === 'weekly') {
    for (const w of [slot.week + 1, slot.week + 2, slot.week + 3]) if (w <= 4) list.push({ ...base, name: `Weekly wipe (week ${w})`, weekOfMonth: w });
  }
  return list;
}

function occurrences(manager, servers, from, to) {
  const items = [];
  const startMinute = Math.ceil(from / 60_000) * 60_000;
  const prepared = [];
  for (const server of servers) {
    for (const s of server.schedules || []) {
      if (!s.enabled) continue;
      try {
        prepared.push({ server, kind: s.action === 'wipe' ? 'wipe' : 'schedule', title: s.name, action: s.action, cron: parseCron(s.cron), week: s.firstOfMonth ? 1 : s.weekOfMonth || 0, wait: s.waitForEmpty });
      } catch {
        /* a broken schedule is shown on its own tab */
      }
    }
    for (const e of server.events || []) {
      if (e.enabled === false) continue;
      try {
        prepared.push({ server, kind: 'event', title: e.name, action: 'event', cron: parseCron(e.cron), week: 0, hours: e.hours });
      } catch {
        /* skip */
      }
    }
  }
  if (prepared.length) {
    // Walk the range by the minute, but only the minutes any schedule can hit (hour/minute sets), which keeps a month cheap.
    const cursor = new Date(startMinute);
    for (let t = startMinute; t < to && items.length < MAX_ITEMS; t += 60_000) {
      cursor.setTime(t);
      for (const p of prepared) {
        if (matches(p.cron, cursor) && inWeek(cursor, p.week)) {
          items.push({ at: t, serverId: p.server.id, server: p.server.name, kind: p.kind, title: p.title, action: p.action, hours: p.hours, waits: Boolean(p.wait) });
        }
      }
    }
  }
  // Rust servers: the forced wipe is a marker, whether or not a wipe is scheduled for it.
  const rust = servers.filter((s) => s.templateId === 'rust');
  for (const t of nextForcedWipes(from - 31 * DAY, 18)) {
    if (t < from || t >= to) continue;
    items.push({ at: t, serverId: null, server: rust.length ? 'Rust' : '', kind: 'forced', title: 'Rust forced wipe (monthly update)', action: 'forced' });
  }
  return items.sort((a, b) => a.at - b.at);
}

module.exports = { occurrences, forcedWipe, nextForcedWipes, wipePlan, localSlot };
