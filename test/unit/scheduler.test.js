'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCron, matches, nextRun } = require('../../server/features/scheduler');

test('cron fields', () => {
  const at = (s) => new Date(s);
  assert.ok(matches(parseCron('0 5 * * *'), at('2026-01-02T05:00:00')));
  assert.ok(!matches(parseCron('0 5 * * *'), at('2026-01-02T05:01:00')));
  assert.ok(matches(parseCron('*/15 * * * *'), at('2026-01-02T10:45:00')));
  assert.ok(matches(parseCron('0 3 * * 7'), at('2026-01-04T03:00:00')), 'Sunday as 7');
  assert.ok(matches(parseCron('30 12 1-7 * 1-5'), at('2026-01-05T12:30:00')));
  assert.throws(() => parseCron('* * *'), /5 fields/);
  assert.throws(() => parseCron('0 24 * * *'), /out of range/);
});

test('next run', () => {
  const next = nextRun('0 */6 * * *', new Date('2026-01-01T07:10:00'));
  assert.strictEqual(new Date(next).getHours(), 12);
});

test('"skip while players are online" holds a restart', async () => {
  const { Scheduler } = require('../../server/features/scheduler');
  const calls = [];
  const rt = { players: 2 };
  const m = { isActive: () => true, rt: () => rt, restart: async () => calls.push('restart'), pushConsole: () => {} };
  const s = new Scheduler(m, { addEvent: () => {}, save: () => {} });
  const schedule = { name: 'Nightly', action: 'restart', onlyWhenEmpty: true };
  await s.run({ id: 'a', name: 'SMP' }, schedule);
  assert.deepStrictEqual(calls, []);
  assert.match(schedule.lastResult, /2 players online/);
  rt.players = 0;
  await s.run({ id: 'a', name: 'SMP' }, schedule);
  assert.deepStrictEqual(calls, ['restart']);
});
