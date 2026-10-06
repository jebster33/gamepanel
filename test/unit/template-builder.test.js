'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-tb-data-'));
const { TemplateRegistry } = require('../../server/games/templates');
const builder = require('../../server/games/template-builder');

const registry = new TemplateRegistry();

test('every built-in template passes the builder check (as a copy)', () => {
  const dir = path.join(__dirname, '../../templates');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const tpl = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    tpl.id = `${tpl.id}-copy`.slice(0, 49);
    assert.deepStrictEqual(builder.check(tpl, registry).errors, [], file);
  }
});

test('mistakes are caught and explained', () => {
  const r = builder.check(
    {
      id: 'terraria',
      name: '',
      ports: [{ name: 'game', default: 70000 }, { name: 'game', default: 1 }],
      variables: [{ name: 'PORT' }, { name: 'world name' }],
      install: [{ type: 'teleport' }, { type: 'download', url: 'ftp://x' }, { type: 'steamcmd', appid: 'valheim' }],
      startCommand: './run {{NOPE}} {{PORT_GAME}}',
      logPatterns: { ready: '[' },
      query: { type: 'a2s', port: 'query' },
    },
    registry
  );
  const all = r.errors.join('\n');
  for (const bit of ['built-in game', 'Give the game a name', 'not a port number', 'Two ports are called game', 'PORT is filled in by the panel', 'CAPITALS', '"teleport"', 'http:// or https://', 'Steam app id is a number', 'not a valid pattern', 'port called query']) {
    assert.ok(all.includes(bit), `missing: ${bit}\n${all}`);
  }
  assert.ok(r.warnings.some((w) => w.includes('{{NOPE}}')));
  assert.ok(!r.warnings.some((w) => w.includes('PORT_GAME')));
});

test('a good template gets an install script preview', () => {
  const r = builder.check(
    {
      id: 'my-game',
      name: 'My Game',
      ports: [{ name: 'game', default: 7777, protocol: 'udp' }],
      variables: [{ name: 'WORLD', default: 'main' }],
      install: [{ type: 'Download', url: 'https://example.com/s.zip', dest: 's.zip' }, { type: 'extract', file: 's.zip' }],
      startCommand: './server -world {{WORLD}} -port {{PORT}}',
      logPatterns: { ready: 'Started' },
    },
    registry
  );
  assert.deepStrictEqual(r.errors, []);
  assert.match(r.script, /gp_fetch 'https:\/\/example.com\/s.zip' 's.zip'/);
  assert.ok(!r.script.includes('gp_die()'), 'helper functions are left out');
  assert.strictEqual(r.template.variables[0].label, 'World');
});
