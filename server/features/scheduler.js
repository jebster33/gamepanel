'use strict';

/**
 * Scheduled tasks per server: restart at 05:00, back up every 6 hours,
 * run a console command on the hour… Schedules use cron syntax
 * ("minute hour day month weekday") in the panel host's local time.
 *
 * A schedule: { id, name, cron, action, command?, enabled, lastRun, lastResult }
 * Actions: restart, start, stop, backup, command, update.
 */

const { logger, uid, fail } = require('../core/util');
const backups = require('./backups');

const ACTIONS = ['restart', 'start', 'stop', 'backup', 'command', 'update'];

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 }, // 0 and 7 are both Sunday
];

/** Parse one cron field into the set of values it matches. */
function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of String(text).split(',')) {
    const m = part.trim().match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`"${part}" is not a valid ${name}`);
    const step = m[3] ? Number(m[3]) : 1;
    let start = m[1] === '*' ? min : Number(m[1]);
    let end = m[1] === '*' ? max : m[2] !== undefined ? Number(m[2]) : m[3] ? max : start;
    if (start < min || end > max || start > end || step < 1) throw new Error(`"${part}" is out of range for ${name} (${min}-${max})`);
    for (let v = start; v <= end; v += step) values.add(name === 'weekday' && v === 7 ? 0 : v);
  }
  return values;
}

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule needs 5 fields: minute hour day month weekday');
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { sets, restrictDay: parts[2] !== '*', restrictWeekday: parts[4] !== '*' };
}

function matches(cron, date) {
  const { sets, restrictDay, restrictWeekday } = cron;
  if (!sets[0].has(date.getMinutes()) || !sets[1].has(date.getHours()) || !sets[3].has(date.getMonth() + 1)) return false;
  const day = sets[2].has(date.getDate());
  const weekday = sets[4].has(date.getDay());
  // Classic cron: when both day and weekday are restricted, either may match.
  if (restrictDay && restrictWeekday) return day || weekday;
  return day && weekday;
}

/** The next time an expression fires, for display. */
function nextRun(expr, from = new Date()) {
  let cron;
  try {
    cron = parseCron(expr);
  } catch {
    return null;
  }
  const d = new Date(from);
  d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (matches(cron, d)) return d.getTime();
  }
  return null;
}

function validate(input) {
  const action = String(input.action || '');
  if (!ACTIONS.includes(action)) fail(400, `Action must be one of: ${ACTIONS.join(', ')}`);
  try {
    parseCron(input.cron);
  } catch (err) {
    fail(400, err.message);
  }
  if (action === 'command' && !String(input.command || '').trim()) fail(400, 'Enter the console command to run');
  return {
    name: String(input.name || '').trim().slice(0, 60) || `${action[0].toUpperCase()}${action.slice(1)}`,
    cron: String(input.cron).trim(),
    action,
    command: action === 'command' ? String(input.command).trim() : undefined,
    onlyIfRunning: input.onlyIfRunning !== false,
    // "Restart at 5am, but not while people are playing."
    onlyWhenEmpty: action !== 'start' && Boolean(input.onlyWhenEmpty),
    enabled: input.enabled !== false,
    // Minutes of in-game countdown before a restart or stop.
    warnMinutes: ['restart', 'stop'].includes(action) ? Math.max(0, Math.min(30, Math.round(Number(input.warnMinutes) || 0))) : 0,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "Server restarting in 5 minutes" … "in 10 seconds", in game chat. */
async function countdown(m, server, minutes, verb) {
  const command = require('../games/players').broadcastCommand(m.template(server));
  if (!command || !minutes) return false;
  const say = (text) => m.sendCommand(server.id, command.replace('{msg}', text.replace(/["\r\n]/g, ''))).catch(() => {});
  const marks = [minutes * 60, 300, 60, 30, 10, 5].filter((s, i, all) => s <= minutes * 60 && all.indexOf(s) === i).sort((a, b) => b - a);
  let left = minutes * 60;
  for (const mark of marks) {
    await sleep((left - mark) * 1000);
    left = mark;
    if (!m.isActive(server.id)) return true;
    await say(`Server ${verb} in ${mark >= 60 ? `${mark / 60} minute${mark === 60 ? '' : 's'}` : `${mark} seconds`}`);
  }
  await sleep(left * 1000);
  return true;
}

class Scheduler {
  constructor(manager, store) {
    this.manager = manager;
    this.store = store;
    this.lastMinute = null;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  tick(now = new Date()) {
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    for (const server of this.manager.servers) {
      for (const schedule of server.schedules || []) {
        if (!schedule.enabled) continue;
        let cron;
        try {
          cron = parseCron(schedule.cron);
        } catch {
          continue;
        }
        if (matches(cron, now)) this.run(server, schedule).catch(() => {});
      }
    }
  }

  async run(server, schedule) {
    const m = this.manager;
    const running = m.isActive(server.id);
    let result = 'ok';
    const rt = m.rt?.(server.id);
    const online = rt ? rt.players ?? rt.playerList?.length ?? 0 : 0;
    try {
      if (schedule.onlyWhenEmpty && running && online > 0) {
        result = `skipped (${online} player${online === 1 ? '' : 's'} online)`;
      } else {
        switch (schedule.action) {
          case 'restart':
            if (running && schedule.warnMinutes) await countdown(m, server, schedule.warnMinutes, 'restarting');
            if (running && m.isActive(server.id)) await m.restart(server.id);
            else if (!schedule.onlyIfRunning) await m.start(server.id);
            else result = 'skipped (not running)';
            break;
          case 'start':
            if (!running && server.installedAt) await m.start(server.id);
            else result = 'skipped';
            break;
          case 'stop':
            if (running && schedule.warnMinutes) await countdown(m, server, schedule.warnMinutes, 'shutting down');
            if (running && m.isActive(server.id)) await m.stop(server.id);
            else result = 'skipped (not running)';
            break;
          case 'command':
            if (running) await m.sendCommand(server.id, schedule.command);
            else result = 'skipped (not running)';
            break;
          case 'update':
            if (running) {
              result = 'skipped (stop the server first, or turn on "update on start")';
            } else {
              const r = await m.updateGame(server.id);
              if (!r.ok) throw new Error(r.error);
            }
            break;
          case 'backup': {
            const backup = await backups.create(server, 'auto');
            const pruned = backups.prune(server.id, server.backupRetention);
            this.store.addEvent('backup.created', `Scheduled backup of ${server.name}${pruned.length ? ` (removed ${pruned.length} old)` : ''}`, { serverId: server.id, backup: backup.name });
            break;
          }
          default:
            result = 'unknown action';
        }
      }
    } catch (err) {
      result = `failed: ${err.message}`;
      logger.warn(`Schedule "${schedule.name}" on ${server.name} failed: ${err.message}`);
      this.store.addEvent(schedule.action === 'backup' ? 'backup.failed' : 'schedule.failed', `${schedule.name} on ${server.name} failed: ${err.message}`, {
        serverId: server.id,
      });
    }
    schedule.lastRun = Date.now();
    schedule.lastResult = result;
    m.pushConsole(server, `Schedule "${schedule.name}": ${result}`, 'system');
    this.store.save();
    return result;
  }

  /* ------------------------------------------------------------- CRUD -- */

  list(server) {
    return (server.schedules || []).map((s) => ({ ...s, nextRun: s.enabled ? nextRun(s.cron) : null }));
  }

  add(server, input) {
    const schedule = { id: uid(6), ...validate(input), createdAt: Date.now(), lastRun: null };
    server.schedules = [...(server.schedules || []), schedule];
    this.store.save();
    return schedule;
  }

  update(server, id, input) {
    const schedule = (server.schedules || []).find((s) => s.id === id);
    if (!schedule) fail(404, 'Schedule not found');
    Object.assign(schedule, validate({ ...schedule, ...input }));
    this.store.save();
    return schedule;
  }

  remove(server, id) {
    server.schedules = (server.schedules || []).filter((s) => s.id !== id);
    this.store.save();
  }
}

module.exports = { Scheduler, parseCron, matches, nextRun, ACTIONS };
