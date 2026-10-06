'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-history-'));
require('../../server/core/config').config.dataDir = dir;
const history = require('../../server/features/config-history');

test('saves keep versions, the original first, and skip repeats', () => {
  history.record('s1', 'server.properties', { before: 'pvp=true\n', after: 'pvp=false\n', by: 'alex' });
  history.record('s1', '/server.properties', { before: 'pvp=false\n', after: 'pvp=false\n', by: 'alex' });
  history.record('s1', 'server.properties', { before: 'pvp=false\n', after: 'pvp=false\nmotd=hi\n', by: 'sam' });
  const { versions } = history.versions('s1', 'server.properties');
  assert.deepStrictEqual(versions.map((v) => v.by), ['sam', 'alex', 'original']);
  assert.strictEqual(history.content('s1', 'server.properties', versions[2].id).content, 'pvp=true\n');
  assert.deepStrictEqual(history.files('s1').map((f) => f.path), ['server.properties']);
});

test('binary and unknown versions are refused', () => {
  assert.strictEqual(history.record('s1', 'world.dat', { after: 'a\u0000b' }), null);
  assert.throws(() => history.content('s1', 'server.properties', '../x'), /Unknown version/);
  history.forget('s1');
  assert.deepStrictEqual(history.files('s1'), []);
});
