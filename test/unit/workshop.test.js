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
