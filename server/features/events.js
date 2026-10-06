'use strict';

/**
 * Scheduled events (optional, Settings → Scheduled events): change some game
 * settings for a while, then put them back. "Double XP weekend": every Friday
 * at 18:00 for 48 hours, set the XP rate to 2, tell the players, restart; when
 * it ends, the old values come back the same way.
 *
 * server.events = [{ id, name, cron, hours, changes: { key: value }, announce,
 *   restart, enabled, active: { startedAt, endsAt, previous: { key: value } } }]
 */

const { uid, fail, logger } = require('../core/util');
const gameSettings = require('../games/settings');
// The scheduler requires this file too, so its cron helpers are looked up when used.
const parseCron = (expr) => require('./scheduler').parseCron(expr);
const matches = (cron, date) => require('./scheduler').matches(cron, date);
const nextRun = (expr) => require('./scheduler').nextRun(expr);

const enabled = (store) => Boolean(store.state.settings.scheduledEvents);

function validate(input, fields) {
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) fail(400, 'Give the event a name, e.g. Double XP weekend');
  try {
    parseCron(input.cron);
  } catch (err) {
    fail(400, err.message);
  }
  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours < 0.25 || hours > 24 * 14) fail(400, 'An event lasts from 15 minutes to 14 days');
  const changes = {};
  for (const [key, value] of Object.entries(input.changes || {})) {
    if (fields && !fields.has(key)) fail(400, `Unknown setting: ${key}`);
    if (fields?.get(key)?.managed) fail(400, `${fields.get(key).label} is set by the panel and cannot be part of an event`);
    changes[key] = typeof value === 'boolean' ? value : String(value ?? '').slice(0, 200);
  }
  if (!Object.keys(changes).length) fail(400, 'Pick at least one setting the event changes');
  return {
    name,
    cron: String(input.cron).trim(),
    hours: Math.round(hours * 4) / 4,
    changes,
    announce: input.announce !== false,
    restart: input.restart !== false,
    enabled: input.enabled !== false,
  };
}

/** The game settings fields of a server, by key. */
function fieldsOf(manager, server) {
  const current = gameSettings.readGameSettings(manager, server);
  if (!current.supported) fail(400, 'This game has no settings file the panel can change');
  if (current.missing || current.error) fail(409, current.error || 'Install the server first; its settings file does not exist yet');
  return new Map(current.groups.flatMap((g) => g.fields).map((f) => [f.key, f]));
}

async function say(manager, server, text) {
  const players = require('../games/players');
  const command = players.broadcastCommand(manager.template(server));
  if (command && manager.isActive(server.id)) await manager.sendCommand(server.id, players.fillBroadcast(command, text)).catch(() => {});
}

/** Apply an event's values, remembering what they were. */
async function begin(manager, store, server, event, now = Date.now()) {
  if (event.active) return event;
  const fields = fieldsOf(manager, server);
  const previous = {};
  for (const key of Object.keys(event.changes)) if (fields.has(key)) previous[key] = fields.get(key).value;
  // What a non-administrator set up is checked like any of their edits (servers/untrusted.js).
  gameSettings.writeGameSettings(manager, server, event.changes, { trusted: event.trusted !== false, actor: `event: ${event.name}` });
  event.active = { startedAt: now, endsAt: now + event.hours * 3_600_000, previous };
  store.save();
  store.addEvent('server.event_started', `${event.name} started on ${server.name}`, { serverId: server.id });
  manager.pushConsole(server, `Event "${event.name}" started; it ends ${new Date(event.active.endsAt).toLocaleString()}`, 'system');
  if (event.announce) await say(manager, server, `${event.name} has started!`);
  if (event.restart && manager.isActive(server.id)) await manager.restart(server.id).catch((err) => logger.warn(`Event restart failed: ${err.message}`));
  return event;
}

/** Put the old values back. */
async function finish(manager, store, server, event) {
  if (!event.active) return event;
  const { previous } = event.active;
  event.active = null;
  store.save();
  try {
    // Putting back what was there before is always allowed.
    if (Object.keys(previous).length) gameSettings.writeGameSettings(manager, server, previous, { actor: `event: ${event.name} ended` });
  } catch (err) {
    store.addEvent('schedule.failed', `${event.name} on ${server.name} could not put the old settings back: ${err.message}`, { serverId: server.id });
    return event;
  }
  store.addEvent('server.event_ended', `${event.name} ended on ${server.name}`, { serverId: server.id });
  manager.pushConsole(server, `Event "${event.name}" ended; settings are back to how they were`, 'system');
  if (event.announce) await say(manager, server, `${event.name} has ended. Thanks for playing!`);
  if (event.restart && manager.isActive(server.id)) await manager.restart(server.id).catch((err) => logger.warn(`Event restart failed: ${err.message}`));
  return event;
}

/** Called once a minute by the scheduler. Ending events always runs, so turning the feature off never strands changed settings. */
async function tick(manager, store, now = new Date()) {
  for (const server of manager.servers) {
    for (const event of server.events || []) {
      try {
        if (event.active && now.getTime() >= event.active.endsAt) await finish(manager, store, server, event);
        else if (!event.active && event.enabled && enabled(store) && matches(parseCron(event.cron), now)) await begin(manager, store, server, event, now.getTime());
      } catch (err) {
        logger.warn(`Event "${event.name}" on ${server.name}: ${err.message}`);
        store.addEvent('schedule.failed', `${event.name} on ${server.name} failed: ${err.message}`, { serverId: server.id });
      }
    }
  }
}

function list(server) {
  return (server.events || []).map((e) => ({ ...e, nextRun: e.enabled && !e.active ? nextRun(e.cron) : null }));
}

/** `trusted` is false when a non-administrator made the event: its values are then checked like their own edits. */
function add(manager, store, server, input, { trusted = true } = {}) {
  const event = { id: uid(6), ...validate(input, fieldsOf(manager, server)), active: null, createdAt: Date.now(), trusted };
  server.events = [...(server.events || []), event];
  store.save();
  return event;
}

function update(manager, store, server, id, input, { trusted = true } = {}) {
  const event = (server.events || []).find((e) => e.id === id);
  if (!event) fail(404, 'Event not found');
  if (event.active && input.changes) fail(409, 'End the event before changing what it sets');
  Object.assign(event, validate({ ...event, ...input }, input.changes ? fieldsOf(manager, server) : null));
  // Once a non-administrator has changed what it sets, it is theirs.
  if (input.changes && !trusted) event.trusted = false;
  store.save();
  return event;
}

async function remove(manager, store, server, id) {
  const event = (server.events || []).find((e) => e.id === id);
  if (!event) fail(404, 'Event not found');
  if (event.active) await finish(manager, store, server, event);
  server.events = server.events.filter((e) => e.id !== id);
  store.save();
}

module.exports = { tick, list, add, update, remove, begin, finish, validate, enabled };
