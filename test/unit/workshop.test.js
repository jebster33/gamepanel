'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const steam = require('../../server/features/mods/providers/workshop');
const { editList, readKey } = require('../../server/features/mods/workshop');
const { parseDependency } = require('../../server/features/mods/providers/factorio');

const server = () => ({ id: 's', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ws-')), vars: {} });

test('parses pasted Workshop links and IDs', () => {
  assert.deepStrictEqual(steam.parseIds('https://steamcommunity.com/sharedfiles/filedetails/?id=2503622437&searchtext='), ['2503622437']);
  assert.deepStrictEqual(steam.parseIds('123456, 7891011'), ['123456', '7891011']);
  assert.throws(() => steam.parseIds('hello'), /Workshop/);
});

test('reads Project Zomboid Mod IDs from a description', () => {
  assert.deepStrictEqual(steam.zomboidModIds('Great mod\nWorkshop ID: 2392709985\nMod ID: tsarslib\nMod ID: Brita;Arsenal(26)GunFighter'), ['tsarslib', 'Brita', 'Arsenal(26)GunFighter']);
});

test('Unturned: File_IDs in WorkshopDownloadConfig.json', () => {
  const s = server();
  const spec = { file: 'Servers/gamepanel/WorkshopDownloadConfig.json', format: 'json' };
  editList(s, spec, 'File_IDs', { add: ['1111', '2222'] });
  editList(s, spec, 'File_IDs', { add: ['2222'], remove: ['1111'] });
  const data = JSON.parse(fs.readFileSync(path.join(s.dir, spec.file), 'utf8'));
  assert.deepStrictEqual(data.File_IDs, [2222]);
});

test('ARK: ActiveMods inside [ServerSettings], other keys untouched', () => {
  const s = server();
  const spec = { file: 'GameUserSettings.ini', section: 'ServerSettings', separator: ',' };
  fs.writeFileSync(path.join(s.dir, spec.file), '[ServerSettings]\nServerPassword=abc\n\n[SessionSettings]\nSessionName=x\n');
  editList(s, spec, 'ActiveMods', { add: ['731604991', '889745138'] });
  const text = fs.readFileSync(path.join(s.dir, spec.file), 'utf8');
  assert.strictEqual(readKey(text, 'ActiveMods', 'ServerSettings'), '731604991,889745138');
  assert.strictEqual(readKey(text, 'SessionName', 'SessionSettings'), 'x');
  assert.strictEqual(readKey(text, 'ServerPassword', 'ServerSettings'), 'abc');
});

test('Project Zomboid: WorkshopItems and Mods with semicolons', () => {
  const s = server();
  const spec = { file: 'Zomboid/Server/servertest.ini', separator: ';' };
  fs.mkdirSync(path.join(s.dir, 'Zomboid/Server'), { recursive: true });
  fs.writeFileSync(path.join(s.dir, spec.file), 'PVP=true\nMods=\nWorkshopItems=\n');
  editList(s, spec, 'WorkshopItems', { add: ['1', '2'] });
  editList(s, spec, 'Mods', { add: ['a'] });
  const text = fs.readFileSync(path.join(s.dir, spec.file), 'utf8');
  assert.match(text, /^WorkshopItems=1;2$/m);
  assert.match(text, /^Mods=a$/m);
  assert.match(text, /^PVP=true$/m);
});

test('Factorio dependency strings', () => {
  assert.deepStrictEqual(parseDependency('flib >= 0.12.0'), { projectId: 'flib', versionId: null, type: 'required' });
  assert.deepStrictEqual(parseDependency('? space-exploration'), { projectId: 'space-exploration', versionId: null, type: 'optional' });
  assert.deepStrictEqual(parseDependency('(?) foo'), { projectId: 'foo', versionId: null, type: 'optional' });
  assert.deepStrictEqual(parseDependency('! bar'), { projectId: 'bar', versionId: null, type: 'incompatible' });
  assert.deepStrictEqual(parseDependency('~ baz'), { projectId: 'baz', versionId: null, type: 'required' });
});

test('Space Engineers: mods in the server cfg and every saved world', () => {
  const { editXmlMods, SE } = require('../../server/features/mods/workshop');
  const s = server();
  const cfg = path.join(s.dir, 'SpaceEngineers-Dedicated.cfg');
  const world = path.join(s.dir, 'Sandbox_config.sbc');
  fs.writeFileSync(cfg, '<MyConfigDedicated>\n  <Mods />\n  <Port>27016</Port>\n</MyConfigDedicated>\n');
  fs.writeFileSync(world, '<Cfg>\n  <Mods>\n    <ModItem FriendlyName="Old"><Name>1.sbm</Name><PublishedFileId>1</PublishedFileId></ModItem>\n  </Mods>\n</Cfg>\n');
  editXmlMods(cfg, { add: [{ id: '42', title: 'A & B' }] }, SE.cfg.render, SE.cfg.idOf);
  editXmlMods(world, { add: [{ id: '42', title: 'A & B' }], remove: ['1'] }, SE.world.render, SE.world.idOf);
  const c = fs.readFileSync(cfg, 'utf8');
  const w = fs.readFileSync(world, 'utf8');
  assert.match(c, /<Mods>\s*<unsignedLong>42<\/unsignedLong>\s*<\/Mods>/);
  assert.match(c, /<Port>27016<\/Port>/);
  assert.match(w, /FriendlyName="A &amp; B"><Name>42\.sbm<\/Name><PublishedFileId>42<\/PublishedFileId>/);
  assert.doesNotMatch(w, /PublishedFileId>1</);
  editXmlMods(cfg, { remove: ['42'] }, SE.cfg.render, SE.cfg.idOf);
  assert.match(fs.readFileSync(cfg, 'utf8'), /^  <Mods \/>$/m);
});

test("Don't Starve Together: ServerModSetup and modoverrides.lua", () => {
  const { editDst } = require('../../server/features/mods/workshop');
  const s = server();
  const spec = { file: 'mods/dedicated_server_mods_setup.lua', overrides: ['dst/Cluster_1/Master/modoverrides.lua'] };
  fs.mkdirSync(path.join(s.dir, 'mods'));
  fs.writeFileSync(path.join(s.dir, spec.file), '-- comments stay\n');
  editDst(s, spec, { add: ['111', '222'] });
  editDst(s, spec, { add: ['111'] });
  const setup = fs.readFileSync(path.join(s.dir, spec.file), 'utf8');
  assert.strictEqual(setup.match(/ServerModSetup\("111"\)/g).length, 1);
  assert.match(setup, /-- comments stay/);
  const overrides = () => fs.readFileSync(path.join(s.dir, spec.overrides[0]), 'utf8');
  assert.match(overrides(), /\["workshop-111"\] = \{ enabled = true \},\n\s*\["workshop-222"\]/);
  editDst(s, spec, { disable: ['111'] });
  assert.doesNotMatch(overrides(), /workshop-111/);
  assert.match(fs.readFileSync(path.join(s.dir, spec.file), 'utf8'), /ServerModSetup\("111"\)/);
  editDst(s, spec, { remove: ['222'] });
  assert.doesNotMatch(fs.readFileSync(path.join(s.dir, spec.file), 'utf8'), /222/);
  assert.match(overrides(), /^return \{\n\}\n$/);
});

test('Arma 3 / DayZ: -mod lists enabled Workshop folders in order', () => {
  const { modArgument } = require('../../server/features/mods/workshop');
  const manifest = require('../../server/features/mods/manifest');
  const s = server();
  manifest.save(s, [
    { key: 'workshop:1', provider: 'workshop', strategy: 'bohemia', folder: '@1' },
    { key: 'workshop:2', provider: 'workshop', strategy: 'bohemia', folder: '@2', disabled: true },
    { key: 'workshop:3', provider: 'workshop', strategy: 'bohemia', folder: '@3' },
  ]);
  assert.strictEqual(modArgument(s), '@1;@3');
});
