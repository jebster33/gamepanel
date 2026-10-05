'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = path.join(os.tmpdir(), `gp-history-${process.pid}`);
const history = require('../../server/servers/history');
const { offlineUuid } = require('../../server/games/player-lists');

test('player history records sessions, chat and restarts', () => {
  const rt = { status: 'offline', playerList: [], players: null };
  const m = Object.assign({ servers: [{ id: 's1' }], rt: () => rt }, history);
  m.observePlayers();
  rt.status = 'running';
  m.observePlayers();
  rt.playerList = ['Steve', 'Alex'];
  m.observePlayers();
  m.trackChat({ id: 's1' }, { query: { type: 'minecraft' } }, '[12:00:00] [Server thread/INFO]: <Steve> hello there');
  rt.playerList = ['Alex'];
  m.observePlayers();

  const types = m.activityLog('s1').entries.map((e) => `${e.type}:${e.name || ''}`);
  assert.deepStrictEqual(types, ['leave:Steve', 'chat:Steve', 'join:Alex', 'join:Steve', 'start:']);
  const { summary, players } = m.playerHistory('s1');
  assert.strictEqual(summary.unique, 2);
  assert.strictEqual(summary.online, 1);
  assert.strictEqual(players[0].name, 'Alex');
  assert.strictEqual(m.playerProfile('s1', 'Steve').recent.length, 1);
  assert.deepStrictEqual(m.activityLog('s1', { types: ['chat'], q: 'hello' }).entries.length, 1);
});

test('offline UUIDs match what Minecraft generates', () => {
  assert.strictEqual(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});
