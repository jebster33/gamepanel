'use strict';

const test = require('node:test');
const assert = require('node:assert');
const gameSettings = require('../../server/games/settings');
const events = require('../../server/features/events');

// A tiny game settings file in memory: { key: value }.
const file = { 'xp-rate': '1', pvp: 'true' };
gameSettings.readGameSettings = () => ({ supported: true, groups: [{ fields: Object.entries(file).map(([key, value]) => ({ key, label: key, type: key === 'pvp' ? 'bool' : 'text', value: key === 'pvp' ? value === 'true' : value })) }] });
gameSettings.writeGameSettings = (m, server, changes) => {
  for (const [k, v] of Object.entries(changes)) file[k] = String(v);
  return { ok: true };
};

function setup() {
  const log = [];
  const server = { id: 's', name: 'SMP', events: [] };
  const manager = {
    servers: [server],
    template: () => ({ id: 'minecraft-paper' }),
    isActive: () => true,
    sendCommand: async (id, cmd) => log.push(cmd),
    restart: async () => log.push('restart'),
    pushConsole: () => {},
  };
  const store = { state: { settings: { scheduledEvents: true } }, save: () => {}, addEvent: (type) => log.push(type) };
  return { log, server, manager, store };
}

test('an event changes settings at its time and puts them back when it ends', async () => {
  const { log, server, manager, store } = setup();
  const event = events.add(manager, store, server, { name: 'Double XP', cron: '0 18 * * 5', hours: 48, changes: { 'xp-rate': '2', pvp: false } });
  await events.tick(manager, store, new Date('2026-10-09T18:00:00')); // a Friday
  assert.deepStrictEqual(file, { 'xp-rate': '2', pvp: 'false' });
  assert.ok(event.active);
  assert.ok(log.includes('restart'));
  await events.tick(manager, store, new Date('2026-10-10T18:00:00'));
  assert.ok(event.active, 'still running a day later');
  await events.tick(manager, store, new Date(event.active.endsAt + 1000));
  assert.deepStrictEqual(file, { 'xp-rate': '1', pvp: 'true' });
  assert.strictEqual(event.active, null);
  assert.deepStrictEqual(log.filter((l) => l.startsWith('server.event')), ['server.event_started', 'server.event_ended']);
});

test('turned off: nothing starts, but a running event still ends', async () => {
  const { server, manager, store } = setup();
  const event = events.add(manager, store, server, { name: 'PvP night', cron: '0 20 * * *', hours: 2, changes: { pvp: false } });
  await events.begin(manager, store, server, event, new Date('2026-10-09T20:00:00').getTime());
  store.state.settings.scheduledEvents = false;
  await events.tick(manager, store, new Date('2026-10-09T23:00:00'));
  assert.strictEqual(event.active, null);
  assert.strictEqual(file.pvp, 'true');
  await events.tick(manager, store, new Date('2026-10-10T20:00:00'));
  assert.strictEqual(event.active, null, 'does not start while off');
});

test('events need a name, a sane length and known settings', () => {
  const { server, manager, store } = setup();
  assert.throws(() => events.add(manager, store, server, { cron: '0 18 * * 5', hours: 2, changes: { pvp: true } }), /name/);
  assert.throws(() => events.add(manager, store, server, { name: 'x', cron: '0 18 * * 5', hours: 0, changes: { pvp: true } }), /15 minutes/);
  assert.throws(() => events.add(manager, store, server, { name: 'x', cron: '0 18 * * 5', hours: 2, changes: { nope: 1 } }), /Unknown setting/);
});
