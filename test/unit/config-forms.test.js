'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cf = require('../../server/features/config-forms');

const byId = (fields) => Object.fromEntries(fields.map((f) => [f.id, f]));

test('YAML: values become fields, comments become help, edits keep everything else', () => {
  const text = [
    '# Main settings',
    'settings:',
    '  # How many homes a player gets',
    '  max-homes: 3',
    "  motd: '&6Welcome!'   # shown on join",
    '  spawn-on-join: false',
    '  ratio: 1.0',
    '  disabled-commands:',
    '    - fly',
    '    - god',
    '  worlds: [world, world_nether]',
    '  kits:',
    '    - name: starter',
    '      items: 3',
    'description: |',
    '  long text',
    'after: true',
    '',
  ].join('\n');
  const fields = byId(cf.parse(text, 'yaml'));
  assert.deepStrictEqual(Object.keys(fields), ['settings.max-homes', 'settings.motd', 'settings.spawn-on-join', 'settings.ratio', 'settings.disabled-commands', 'settings.worlds', 'after']);
  assert.strictEqual(fields['settings.max-homes'].help, 'How many homes a player gets');
  assert.strictEqual(fields['settings.motd'].value, '&6Welcome!');
  assert.deepStrictEqual(fields['settings.disabled-commands'].value, ['fly', 'god']);

  const out = cf.apply(text, 'yaml', {
    'settings.max-homes': 5,
    'settings.motd': "it's: &cnew",
    'settings.disabled-commands': ['fly', 'god', 'vanish'],
    'settings.worlds': ['world'],
    'settings.ratio': 2,
    after: false,
  });
  const lines = out.split('\n');
  assert.ok(lines.includes('  max-homes: 3'.replace('3', '5')));
  assert.ok(lines.includes("  motd: 'it''s: &cnew'   # shown on join"));
  assert.ok(lines.includes('    - vanish'));
  assert.ok(lines.includes('  worlds: [world]'));
  assert.ok(lines.includes('  ratio: 2.0'));
  assert.ok(lines.includes('after: false'));
  assert.ok(lines.includes('  # How many homes a player gets'));
  assert.ok(lines.includes('    - name: starter'));

  // Emptying a block list leaves "key: []".
  assert.ok(cf.apply(text, 'yaml', { 'settings.disabled-commands': [] }).includes('  disabled-commands: []\n  worlds'));
});

test('Forge TOML: ranges and allowed values from comments', () => {
  const text = [
    '#General settings',
    '[general]',
    '\t#Range: 1 ~ 64',
    '\tmaxStack = 16',
    '\t#Allowed Values: EASY, NORMAL, HARD',
    '\tmode = "NORMAL"',
    '\tnames = ["a", "b"]',
    '\tlong = [',
    '\t  "x",',
    '\t  "y"]',
    '\tafter = true',
    '[[entries]]',
    '\tid = 1',
  ].join('\n');
  const fields = byId(cf.parse(text, 'toml'));
  assert.deepStrictEqual(Object.keys(fields), ['general.maxStack', 'general.mode', 'general.names', 'general.after']);
  assert.strictEqual(fields['general.maxStack'].max, 64);
  assert.strictEqual(fields['general.mode'].type, 'select');
  assert.deepStrictEqual(fields['general.mode'].options, ['EASY', 'NORMAL', 'HARD']);
  assert.throws(() => cf.apply(text, 'toml', { 'general.maxStack': 100 }), /at most 64/);
  assert.throws(() => cf.apply(text, 'toml', { 'general.mode': 'NIGHTMARE' }), /one of/);
  const out = cf.apply(text, 'toml', { 'general.mode': 'HARD', 'general.names': ['c'], 'general.maxStack': 32 });
  assert.match(out, /\tmode = "HARD"\n/);
  assert.match(out, /\tnames = \["c"\]\n/);
  assert.match(out, /\tmaxStack = 32\n/);
});

test('BepInEx .cfg, .properties and JSON', () => {
  const cfg = '[General]\n\n## Turn the mod on\n# Setting type: Boolean\n# Default value: true\nEnabled = true\n\n## Name shown\n# Acceptable value range: From 0 to 10\nLevel = 3\nTitle = My server ; a note\n';
  const f = byId(cf.parse(cfg, 'ini'));
  assert.strictEqual(f['General.Enabled'].help, 'Turn the mod on');
  assert.strictEqual(f['General.Level'].max, 10);
  assert.strictEqual(f['General.Title'].value, 'My server');
  assert.match(cf.apply(cfg, 'ini', { 'General.Enabled': false, 'General.Title': 'New one' }), /Enabled = false\n[\s\S]*Title = New one ; a note/);

  const props = '#Minecraft\nmotd=Hello world\nmax-players=20\n';
  assert.strictEqual(cf.apply(props, 'properties', { motd: 'Hi\nthere', 'max-players': 30 }), '#Minecraft\nmotd=Hi\\nthere\nmax-players=30\n');

  const json = '{\n    "enabled": true,\n    "limits": { "max": 5, "names": ["a"] },\n    "rules": [{ "x": 1 }]\n}\n';
  const j = byId(cf.parse(json, 'json'));
  assert.deepStrictEqual(Object.keys(j), ['enabled', 'limits.max', 'limits.names']);
  const out = JSON.parse(cf.apply(json, 'json', { 'limits.max': 9, 'limits.names': ['b', 'c'] }));
  assert.deepStrictEqual(out, { enabled: true, limits: { max: 9, names: ['b', 'c'] }, rules: [{ x: 1 }] });
});

test('bad values are refused', () => {
  const text = 'a: 1\nb: true\n';
  assert.throws(() => cf.apply(text, 'yaml', { a: 'lots' }), /number/);
  assert.throws(() => cf.apply(text, 'yaml', { b: 'yes' }), /on or off/);
  assert.throws(() => cf.apply(text, 'yaml', { c: 1 }), /Unknown setting/);
});

test('finds plugin and mod configs, and refuses a file changed meanwhile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cfg-'));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('plugins/Essentials/config.yml', 'a: 1\n');
  put('plugins/Essentials/userdata/x.yml', 'a: 1\n');
  put('plugins/LuckPerms.jar', 'x');
  put('config/create-common.toml', 'a = 1\n');
  put('config/create-client.toml', 'a = 1\n');
  put('bukkit.yml', 'a: 1\n');
  put('usercache.json', '[]');
  const server = { id: 's', dir };
  const files = cf.list(server);
  assert.deepStrictEqual(files.map((f) => f.path).sort(), ['bukkit.yml', 'config/create-common.toml', 'plugins/Essentials/config.yml']);
  assert.strictEqual(files.find((f) => f.path.startsWith('plugins')).group, 'Essentials');
  assert.strictEqual(files.find((f) => f.path.startsWith('config')).group, 'create');

  const form = cf.form(server, 'plugins/Essentials/config.yml');
  assert.strictEqual(form.fields[0].loc, undefined);
  put('plugins/Essentials/config.yml', 'a: 2\n');
  assert.throws(() => cf.save(server, 'plugins/Essentials/config.yml', { version: form.version, changes: { a: 3 } }), /changed since/);
  assert.throws(() => cf.form(server, '../../etc/passwd.yml'), /outside|not allowed|escape|found/i);
  fs.rmSync(dir, { recursive: true, force: true });
});
