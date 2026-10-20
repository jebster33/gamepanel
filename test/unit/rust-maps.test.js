'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const maps = require('../../server/features/rust-maps');
const manager = { runtimeFor: () => 'process' };
const store = { save() {} };

test('Rust map choice becomes launch arguments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rustmap-'));
  const server = { id: 's1', dir };
  assert.strictEqual(maps.args(manager, server), '');
  maps.set(manager, store, server, { mode: 'official', level: 'HapisIsland' });
  assert.strictEqual(maps.args(manager, server), '+server.level "HapisIsland"');
  assert.ok(maps.isFixed(server));
  assert.throws(() => maps.set(manager, store, server, { mode: 'official', level: 'x" +quit' }));
  assert.throws(() => maps.set(manager, store, server, { mode: 'url', url: 'https://a.example/m.map" +rcon.password x' }));
  assert.throws(() => maps.set(manager, store, server, { mode: 'file', file: 'nope.map' }));
  maps.set(manager, store, server, { mode: 'url', url: 'https://a.example/m.map' });
  assert.strictEqual(maps.args(manager, server), '+server.levelurl "https://a.example/m.map"');

  fs.mkdirSync(path.join(dir, maps.DIR));
  fs.writeFileSync(path.join(dir, maps.DIR, 'baron.map'), 'x');
  const out = maps.set(manager, store, server, { mode: 'file', file: 'baron.map' });
  assert.strictEqual(out.map.token, undefined);
  assert.match(maps.args(manager, server), /^\+server\.levelurl "http:\/\/127\.0\.0\.1:\d+\/api\/public\/rust-map\/s1\/[0-9a-f]{36}\/baron\.map"$/);
  assert.ok(maps.openFile(server, server.map.token, 'baron.map'));
  assert.strictEqual(maps.openFile(server, 'wrong'.padEnd(36, '0'), 'baron.map'), null);
  assert.strictEqual(maps.openFile(server, server.map.token, '../x.map'), null);
});
