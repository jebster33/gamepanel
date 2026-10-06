'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const notes = require('../../server/features/live-notifications');

const auth = {
  users: [
    { id: 'a', role: 'admin' },
    { id: 'u', role: 'user', servers: ['s1'] },
  ],
  canAccessServer: (user, id) => user.role === 'admin' || (user.servers || []).includes(id),
};

test('people only see events for servers they have, and no account events', () => {
  const [admin, user] = auth.users;
  assert.ok(notes.visibleTo(auth, admin, { type: 'user.login' }));
  assert.ok(!notes.visibleTo(auth, user, { type: 'user.login' }));
  assert.ok(notes.visibleTo(auth, user, { type: 'server.crashed', serverId: 's1' }));
  assert.ok(!notes.visibleTo(auth, user, { type: 'server.crashed', serverId: 's2' }));
  assert.ok(!notes.visibleTo(auth, user, { type: 'panel.updated' }));
});

test('new events go out over the socket to the right people', () => {
  const store = new EventEmitter();
  store.state = { events: [] };
  const sent = { a: [], u: [] };
  const wss = { clients: new Set([{ user: { id: 'a' }, send: (m) => sent.a.push(m) }, { user: { id: 'u' }, send: (m) => sent.u.push(m) }]) };
  notes.start({ store, auth, wss });
  store.emit('event', { id: '1', type: 'server.crashed', message: 'SMP crashed', serverId: 's2', at: 1 });
  store.emit('event', { id: '2', type: 'server.crashed', message: 'Mine crashed', serverId: 's1', at: 2 });
  assert.deepStrictEqual(sent.a.map((m) => m.notification.id), ['1', '2']);
  assert.deepStrictEqual(sent.u.map((m) => m.notification.id), ['2']);
  assert.strictEqual(sent.u[0].topic, 'notification');
  assert.strictEqual(sent.u[0].notification.level, 'error');
  assert.ok(sent.u[0].notification.loud);
});
