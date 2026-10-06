'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-dp-data-'));
const dp = require('../../server/features/datapacks');
const zip = require('../../server/core/zip');

function fakeManager(server, { running = false } = {}) {
  const sent = [];
  return {
    sent,
    activeWorld: () => 'world',
    template: () => ({ category: 'Minecraft', mods: { dir: 'plugins', loader: 'paper' } }),
    rt: () => ({ status: running ? 'running' : 'stopped', version: null }),
    sendCommand: async (id, cmd) => sent.push(cmd),
    logActivity: () => {},
  };
}
const store = { addEvent: () => {} };

test('pack formats and pack.mcmeta ranges', () => {
  assert.strictEqual(dp.formatFor('1.21.4'), 61);
  assert.strictEqual(dp.formatFor('1.21.1'), 48);
  assert.strictEqual(dp.formatFor('1.20.1'), 15);
  assert.strictEqual(dp.formatFor('26.3'), null); // newer than the table: not guessed
  assert.strictEqual(dp.formatFor(null), null);
  const old = dp.readMcmeta('{"pack":{"pack_format":48,"description":"Hi"}}');
  assert.deepStrictEqual([old.format, old.min, old.max, old.description], [48, 48, 48, 'Hi']);
  assert.strictEqual(dp.fits(old, 48), true);
  assert.strictEqual(dp.fits(old, 61), false);
  const range = dp.readMcmeta(JSON.stringify({ pack: { pack_format: 48, supported_formats: { min_inclusive: 48, max_inclusive: 71 }, description: [{ text: '§aGreen ' }, 'pack'] } }));
  assert.strictEqual(dp.fits(range, 61), true);
  assert.strictEqual(range.description, 'Green pack');
  const modern = dp.readMcmeta('{"pack":{"min_format":[88,0],"max_format":94}}');
  assert.deepStrictEqual([modern.min, modern.max], [88, 94]);
});

test('list, turn off and on while stopped, upload checks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-dp-srv-'));
  const server = { id: 'mc', name: 'MC', dir, templateId: 'minecraft-paper', resolvedVersion: '1.21.4' };
  const manager = fakeManager(server);
  const packs = path.join(dir, 'world/datapacks');
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(path.join(packs, 'good.zip'), zip.build({ 'pack.mcmeta': '{"pack":{"pack_format":61,"description":"Good"}}', 'data/x/function/a.mcfunction': 'say hi' }));
  fs.writeFileSync(path.join(packs, 'old.zip'), zip.build({ 'pack.mcmeta': '{"pack":{"pack_format":15,"description":"Old"}}' }));
  fs.writeFileSync(path.join(packs, 'empty.zip'), zip.build({ 'readme.txt': 'no' }));
  fs.mkdirSync(path.join(packs, 'folderpack'));
  fs.writeFileSync(path.join(packs, 'folderpack/pack.mcmeta'), '{"pack":{"pack_format":61,"description":"Folder"}}');
  fs.mkdirSync(path.join(packs, 'not-a-pack'));

  let l = dp.list(manager, server);
  assert.strictEqual(l.format, 61);
  const by = Object.fromEntries(l.packs.map((p) => [p.name, p]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['empty.zip', 'folderpack', 'good.zip', 'old.zip']);
  assert.strictEqual(by['good.zip'].fits, true);
  assert.strictEqual(by['old.zip'].fits, false);
  assert.ok(by['empty.zip'].broken);
  assert.strictEqual(by.folderpack.folder, true);

  await dp.toggle(manager, server, 'good.zip', false, 'admin');
  assert.ok(!fs.existsSync(path.join(packs, 'good.zip')));
  l = dp.list(manager, server);
  assert.strictEqual(l.packs.find((p) => p.name === 'good.zip').on, false);
  await dp.toggle(manager, server, 'good.zip', true, 'admin');
  assert.ok(fs.existsSync(path.join(packs, 'good.zip')));
  await assert.rejects(dp.toggle(manager, server, '../server.properties', false, 'admin'), /Bad datapack name/);

  // Running: Paper gets minecraft:reload, never the Bukkit reload.
  const live = fakeManager(server, { running: true });
  const nested = zip.build({ 'MyPack/pack.mcmeta': '{"pack":{"pack_format":61}}' });
  await assert.rejects(dp.upload(live, store, server, 'nested.zip', nested, 'admin'), /inside the folder "MyPack"/);
  await assert.rejects(dp.upload(live, store, server, 'mod.zip', zip.build({ 'fabric.mod.json': '{}' }), 'admin'), /a mod, not a datapack/);
  const r = await dp.upload(live, store, server, 'new pack.zip', zip.build({ 'pack.mcmeta': '{"pack":{"pack_format":61}}' }), 'admin');
  assert.strictEqual(r.name, 'new_pack.zip');
  assert.deepStrictEqual(live.sent, ['datapack enable "file/new_pack.zip"', 'minecraft:reload']);
  await dp.toggle(live, server, 'new_pack.zip', false, 'admin');
  assert.strictEqual(live.sent.at(-1), 'datapack disable "file/new_pack.zip"');
  assert.strictEqual(dp.list(live, server).packs.find((p) => p.name === 'new_pack.zip').on, false);

  // The server jar's own version.json beats the table (and covers versions newer than it).
  fs.writeFileSync(path.join(dir, 'server.jar'), zip.build({ 'version.json': JSON.stringify({ id: '26.3', pack_version: { resource_major: 97, data_major: 121 } }) }));
  assert.strictEqual(dp.list(manager, server).format, 121);
  fs.writeFileSync(path.join(dir, 'server.jar'), zip.build({ 'version.json': JSON.stringify({ id: '1.21.1', pack_version: { resource: 34, data: 48 } }) }));
  fs.utimesSync(path.join(dir, 'server.jar'), new Date(), new Date(Date.now() + 5000));
  assert.strictEqual(dp.list(manager, server).format, 48);

  await dp.remove(manager, store, server, 'old.zip', 'admin');
  assert.ok(!fs.existsSync(path.join(packs, 'old.zip')));
  assert.throws(() => dp.list(manager, { ...server, templateId: 'minecraft-bedrock' }), /Java/);
});
