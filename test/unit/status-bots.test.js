'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sb = require('../../server/features/status-bots');

function manager(entries) {
  return {
    servers: entries.map((e) => ({ id: e.id, name: e.id, maxPlayers: e.max })),
    rt: (id) => {
      const e = entries.find((x) => x.id === id);
      return { status: e.status, players: e.players, maxPlayers: e.max };
    },
  };
}

test('player counts for one server or all of them', () => {
  const m = manager([
    { id: 'smp', status: 'running', players: 20, max: 100 },
    { id: 'creative', status: 'running', players: 5, max: 100 },
    { id: 'old', status: 'offline', players: 0, max: 50 },
  ]);
  assert.deepStrictEqual(sb.presenceFor(m), { text: '25/200 players', status: 'online', style: 'custom' });
  assert.strictEqual(sb.presenceFor(m, { serverId: 'smp', format: '{server}: {online}/{max}' }).text, 'smp: 20/100');
  assert.deepStrictEqual(sb.presenceFor(m, { serverId: 'old' }), { text: 'Server offline', status: 'dnd', style: 'custom' });
  assert.strictEqual(sb.presenceFor(m, { format: '{online} on {servers} servers' }).text, '25 on 2 servers');
});

test('the gateway presence: custom status by default, or Playing/Watching', () => {
  const p = sb.activity({ text: '25/200 players', status: 'online', style: 'custom' });
  assert.deepStrictEqual(p.activities, [{ type: 4, name: 'Custom Status', state: '25/200 players' }]);
  assert.deepStrictEqual(sb.activity({ text: 'x', status: 'idle', style: 'watching' }).activities, [{ type: 3, name: 'x' }]);
});
