'use strict';

const test = require('node:test');
const assert = require('node:assert');
const prefs = require('../../server/features/ux-prefs');
const { makeApp, load } = require('./support/routes');

test('defaults are empty and updates are partial', () => {
  const rec = {};
  assert.deepStrictEqual(prefs.read(rec).pinned, []);
  prefs.update(rec, { pinned: ['a', 'b', 'a'] });
  prefs.update(rec, { tags: { a: ['Beta', 'beta', ' pvp '] } });
  const out = prefs.read(rec);
  assert.deepStrictEqual(out.pinned, ['a', 'b']);
  assert.deepStrictEqual(out.tags, { a: ['beta', 'pvp'] });
});

test('invalid values and unknown keys are refused', () => {
  const rec = {};
  assert.throws(() => prefs.update(rec, { pinned: ['../etc'] }), /invalid id/);
  assert.throws(() => prefs.update(rec, { pinned: 'a' }), /list/);
  assert.throws(() => prefs.update(rec, { nope: 1 }), /Unknown preference/);
  assert.throws(() => prefs.update(rec, []), /object/);
  assert.throws(() => prefs.update(rec, { folders: [{ id: 'f', name: '  ' }] }), /name/);
  assert.throws(() => prefs.update(rec, { folders: [{ id: 'f', name: 'A' }, { id: 'f', name: 'B' }] }), /repeated/);
});

test('size limits hold', () => {
  const rec = {};
  const many = Array.from({ length: prefs.LIMITS.pinned + 1 }, (_, i) => `s${i}`);
  assert.throws(() => prefs.update(rec, { pinned: many }), /at most/);
  const nine = Array.from({ length: 9 }, (_, i) => `t${i}`);
  assert.throws(() => prefs.update(rec, { tags: { a: nine } }), /at most 8 tags/);
  assert.throws(() => prefs.update(rec, { folders: Array.from({ length: 31 }, (_, i) => ({ id: `f${i}`, name: 'x' })) }), /at most 30/);
  assert.throws(() => prefs.update(rec, { recent: [{ kind: 'page', key: 'x'.repeat(40000) }] }), /too large/);
});

test('a server lives in one folder; widgets are whitelisted; null resets', () => {
  const rec = {};
  prefs.update(rec, { folders: [{ id: 'a', name: 'One', servers: ['s1', 's2'] }, { id: 'b', name: 'Two', servers: ['s2', 's3'], collapsed: 1 }] });
  const f = prefs.read(rec).folders;
  assert.deepStrictEqual(f[1].servers, ['s3']);
  assert.strictEqual(f[1].collapsed, true);
  prefs.update(rec, { widgets: { order: ['servers', 'host', 'evil', 'host'], hidden: ['capacity', 'x'] } });
  assert.deepStrictEqual(prefs.read(rec).widgets, { order: ['servers', 'host'], hidden: ['capacity'] });
  prefs.update(rec, { widgets: null });
  assert.deepStrictEqual(prefs.read(rec).widgets, { order: [], hidden: [] });
});

test('recent items are cleaned', () => {
  const rec = {};
  prefs.update(rec, { recent: [{ kind: 'page', key: 'servers', label: '<b>Servers</b>' }, { kind: 'bogus', key: 'x' }, { kind: 'page', key: 'servers' }] });
  assert.deepStrictEqual(prefs.read(rec).recent, [{ kind: 'page', key: 'servers', label: 'bServers/b' }]);
});

test('the routes keep each account separate', async () => {
  const app = makeApp();
  const a = app.auth.createUser({ username: 'alice', password: 'Sup3r-long-passw0rd!x', role: 'user', servers: [] });
  const b = app.auth.createUser({ username: 'bobby', password: 'Sup3r-long-passw0rd!y', role: 'user', servers: [] });
  const { call } = load('ux-prefs', app);
  await call('PUT', '/api/me/prefs', { user: a, body: { pinned: ['x1'] } });
  assert.deepStrictEqual((await call('GET', '/api/me/prefs', { user: a })).prefs.pinned, ['x1']);
  assert.deepStrictEqual((await call('GET', '/api/me/prefs', { user: b })).prefs.pinned, []);
  await assert.rejects(() => call('PUT', '/api/me/prefs', { user: a, body: { pinned: [1] } }), /invalid id/);
});
