'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = path.join(os.tmpdir(), `gp-wipe-stats-${process.pid}`);
const history = require('../../server/servers/history');
const wipeStats = require('../../server/servers/wipe-stats');

const DAY = 86_400_000;

function manager(server, rt) {
  return Object.assign({ servers: [server], rt: () => rt, template: () => ({ wipe: { dir: 'x', map: ['*.map'] } }) }, history, wipeStats);
}

test('wipe stats split new and returning players and track the day-by-day crowd', () => {
  const realNow = Date.now;
  const t0 = realNow() - 20 * DAY;
  let clock = t0;
  Date.now = () => clock;
  try {
    const server = { id: 'w1', lastWipe: { at: t0, seed: 111 } };
    const rt = { status: 'running', playerList: [], players: 0 };
    const m = manager(server, rt);
    const tick = (list) => {
      rt.playerList = list;
      rt.players = list.length;
      m.observePlayers();
    };

    // Wipe 1: Ann, Bob and Cy play on day 0, Ann and Bob again on day 1.
    tick(['Ann', 'Bob', 'Cy']);
    clock += DAY;
    tick(['Ann', 'Bob']);
    tick([]);

    // Wipe 2 (a new seed): Ann returns, Dee is new.
    clock = t0 + 7 * DAY;
    server.lastWipe = { at: clock, seed: 222 };
    tick(['Ann', 'Dee']);
    clock += 2 * DAY;
    tick(['Dee']);

    const { enabled, wipes } = m.wipeStats(server);
    assert.strictEqual(enabled, true);
    assert.strictEqual(wipes.length, 2);
    const [second, first] = wipes; // newest first
    assert.strictEqual(first.seed, 111);
    assert.deepStrictEqual([first.unique, first.new, first.returning, first.peak], [3, 3, 0, 3]);
    assert.deepStrictEqual(first.days.slice(0, 2), [3, 2]);
    assert.strictEqual(second.seed, 222);
    assert.deepStrictEqual([second.unique, second.new, second.returning], [2, 1, 1]);
    assert.deepStrictEqual(second.days, [2, 0, 1]);
  } finally {
    Date.now = realNow;
  }
});

test('games without a wipe have no wipe stats', () => {
  const m = Object.assign({ servers: [], rt: () => ({}), template: () => ({}) }, history, wipeStats);
  assert.deepStrictEqual(m.wipeStats({ id: 'x' }), { enabled: false, wipes: [] });
});
