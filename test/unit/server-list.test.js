'use strict';

const test = require('node:test');
const assert = require('node:assert');
const list = require('../../server/features/server-list');

test('a Steam list entry matches a server by game or query port', () => {
  const server = { ports: { game: 28015, query: 28016 } };
  assert.ok(list.matches({ addr: '1.2.3.4:28016', gameport: 28015 }, server));
  assert.ok(list.matches({ addr: '1.2.3.4:9999', gameport: 28015 }, server));
  assert.ok(!list.matches({ addr: '1.2.3.4:27016', gameport: 27015 }, server));
});

test('check finds the server in Steam\'s answer and alerts after two misses', async () => {
  const realFetch = global.fetch;
  let servers = [];
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ response: { servers } }) });
  try {
    const events = [];
    const rt = { status: 'running', startedAt: Date.now() - list.GRACE_MS - 1000 };
    const manager = { rt: () => rt, store: { addEvent: (type) => events.push(type) }, template: () => ({ query: { type: 'a2s' } }) };
    const server = { id: 'r1', name: 'Rust', ports: { game: 28015, query: 28016 }, serverList: { enabled: true, ip: '1.2.3.4' } };

    const miss1 = await list.check(manager, server, 'KEY');
    list.raise(manager, server, miss1);
    assert.strictEqual(miss1.listed, false);
    assert.deepStrictEqual(events, []);
    const miss2 = await list.check(manager, server, 'KEY');
    list.raise(manager, server, miss2);
    assert.deepStrictEqual(events, ['server.unlisted']);

    servers = [{ addr: '1.2.3.4:28016', gameport: 28015, name: 'Rust', players: 3, max_players: 100 }];
    const back = await list.check(manager, server, 'KEY');
    list.raise(manager, server, back);
    assert.strictEqual(back.listed, true);
    assert.deepStrictEqual(events, ['server.unlisted', 'server.relisted']);
    assert.strictEqual(list.view(manager, server, 'KEY').entry.players, 3);
  } finally {
    global.fetch = realFetch;
  }
});
