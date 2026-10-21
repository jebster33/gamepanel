'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mcworld-data-'));
const zip = require('../../server/core/zip');
const wc = require('../../server/features/world-convert');

function setup(templateId = 'minecraft-paper') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mcworld-'));
  const props = [];
  let active = false;
  const manager = {
    isActive: () => active,
    setProperties: (s, v) => props.push(v),
    logActivity() {},
    pushConsole() {},
  };
  const backups = { create: async () => ({ name: 'backup-1' }) };
  return { dir, props, manager, backups, server: { id: 's', name: 'S', dir, templateId }, run: (v) => (active = v) };
}

const upload = (dir, files, name = 'up.zip') => {
  fs.writeFileSync(path.join(dir, name), zip.build(files, { deflate: true }));
  return name;
};

const singleplayer = {
  'My World/level.dat': 'LEVEL',
  'My World/region/r.0.0.mca': 'OVERWORLD',
  'My World/DIM-1/region/r.0.0.mca': 'NETHER',
  'My World/DIM1/region/r.0.0.mca': 'END',
  'My World/session.lock': 'x',
  'My World/playerdata/a.dat': 'P',
  '__MACOSX/My World/._level.dat': 'junk',
};

test('finds the world however deep it is nested', () => {
  assert.strictEqual(wc.detect(['level.dat', 'region/r.mca']).prefix, '');
  assert.strictEqual(wc.detect(Object.keys(singleplayer)).prefix, 'My World/');
  assert.strictEqual(wc.detect(['a/b/c/World/level.dat', 'a/b/c/World/region/x']).prefix, 'a/b/c/World/');
  assert.strictEqual(wc.detect(['readme.txt']), null);
  const bedrock = wc.detect(['level.dat', 'levelname.txt', 'db/CURRENT']);
  assert.strictEqual(bedrock.bedrock, true);
});

test('zip-slip names are refused', () => {
  for (const bad of ['../evil.txt', 'World/../../evil', '/etc/passwd', 'C:/x', 'a\\..\\b']) assert.throws(() => wc.detect(['World/level.dat', bad]), /Unsafe path/);
});

test('Paper gets the Nether and End as sibling worlds; level-name is set; no lock file', async () => {
  const s = setup();
  const up = upload(s.dir, singleplayer);
  const info = wc.inspect(s.server, up);
  assert.deepStrictEqual([info.suggestedName, info.layout, info.dimensions], ['My World', 'split', { nether: true, end: true }]);
  const r = await wc.convert(s.manager, s.server, { path: up, name: 'survival' }, 'admin', { backups: s.backups });
  assert.deepStrictEqual(r.folders, ['survival', 'survival_nether', 'survival_the_end']);
  assert.strictEqual(fs.readFileSync(path.join(s.dir, 'survival/region/r.0.0.mca'), 'utf8'), 'OVERWORLD');
  assert.strictEqual(fs.readFileSync(path.join(s.dir, 'survival_nether/DIM-1/region/r.0.0.mca'), 'utf8'), 'NETHER');
  assert.strictEqual(fs.readFileSync(path.join(s.dir, 'survival_the_end/DIM1/region/r.0.0.mca'), 'utf8'), 'END');
  assert.strictEqual(fs.existsSync(path.join(s.dir, 'survival/DIM-1')), false);
  assert.strictEqual(fs.existsSync(path.join(s.dir, 'survival/session.lock')), false);
  assert.deepStrictEqual(s.props, [{ 'level-name': 'survival' }]);
  assert.strictEqual(fs.existsSync(path.join(s.dir, up)), false, 'the upload is removed');
  assert.deepStrictEqual(fs.readdirSync(s.dir).filter((f) => f.startsWith('.gp-world-import')), []);
});

test('Fabric/Vanilla keep the single-folder layout', async () => {
  const s = setup('minecraft-fabric');
  const up = upload(s.dir, singleplayer);
  const r = await wc.convert(s.manager, s.server, { path: up, name: 'world', use: false }, 'admin', { backups: s.backups });
  assert.deepStrictEqual(r.folders, ['world']);
  assert.ok(fs.existsSync(path.join(s.dir, 'world/DIM-1/region/r.0.0.mca')));
  assert.deepStrictEqual(s.props, []);
});

test('an existing world is backed up and moved aside, only when replacing is allowed', async () => {
  const s = setup();
  fs.mkdirSync(path.join(s.dir, 'world'));
  fs.writeFileSync(path.join(s.dir, 'world/old.txt'), 'old');
  const up = upload(s.dir, singleplayer);
  await assert.rejects(() => wc.convert(s.manager, s.server, { path: up, name: 'world' }, 'a', { backups: s.backups }), /already exists/);
  let made = 0;
  const backups = { create: async () => (made++, { name: 'b' }) };
  const r = await wc.convert(s.manager, s.server, { path: up, name: 'world', replace: true }, 'a', { backups });
  assert.strictEqual(made, 1);
  assert.deepStrictEqual(r.replaced, ['world']);
  const aside = path.join(s.dir, '.gamepanel/world-previous');
  const [stamp] = fs.readdirSync(aside);
  assert.strictEqual(fs.readFileSync(path.join(aside, stamp, 'world/old.txt'), 'utf8'), 'old');
  assert.ok(fs.existsSync(path.join(s.dir, 'world/region/r.0.0.mca')));
});

test('refuses while running, wrong edition, non-zip and zip-slip uploads; leaves no scratch behind', async () => {
  const s = setup();
  const up = upload(s.dir, singleplayer);
  s.run(true);
  await assert.rejects(() => wc.convert(s.manager, s.server, { path: up, name: 'w' }, 'a', { backups: s.backups }), /Stop the server/);
  s.run(false);
  await assert.rejects(() => wc.convert(s.manager, s.server, { path: up, name: '../x' }, 'a', { backups: s.backups }), /World names/);
  fs.writeFileSync(path.join(s.dir, 'junk.zip'), 'not a zip at all');
  await assert.rejects(() => wc.convert(s.manager, s.server, { path: 'junk.zip', name: 'w' }, 'a', { backups: s.backups }), /not a zip/);
  const evil = upload(s.dir, { 'World/level.dat': 'x', 'World/../../escape.txt': 'x' }, 'evil.zip');
  await assert.rejects(() => wc.convert(s.manager, s.server, { path: evil, name: 'w' }, 'a', { backups: s.backups }), /Unsafe path/);
  assert.strictEqual(fs.existsSync(path.join(path.dirname(s.dir), 'escape.txt')), false);
  const bedrock = upload(s.dir, { 'level.dat': 'x', 'levelname.txt': 'n', 'db/CURRENT': 'x' }, 'b.mcworld');
  await assert.rejects(() => wc.convert(s.manager, s.server, { path: bedrock, name: 'w' }, 'a', { backups: s.backups }), /Bedrock world/);
  assert.deepStrictEqual(fs.readdirSync(s.dir).filter((f) => f.startsWith('.gp-world-import')), []);
  assert.strictEqual(fs.existsSync(path.join(s.dir, 'w')), false);
});

test('a Bedrock .mcworld goes into worlds/<name>', async () => {
  const s = setup('minecraft-bedrock');
  const up = upload(s.dir, { 'level.dat': 'x', 'levelname.txt': 'n', 'db/CURRENT': 'x', 'db/000001.ldb': 'y' }, 'b.mcworld');
  const r = await wc.convert(s.manager, s.server, { path: up, name: 'Bedrock level' }, 'a', { backups: s.backups });
  assert.strictEqual(r.layout, 'bedrock');
  assert.ok(fs.existsSync(path.join(s.dir, 'worlds/Bedrock level/db/CURRENT')));
});
