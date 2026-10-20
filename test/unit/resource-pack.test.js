'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rp-data-'));
const rp = require('../../server/features/resource-pack');
const zip = require('../../server/core/zip');
const { patchKeyValue } = require('../../server/servers/config-files');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rp-srv-'));
const server = { id: 'srv1', name: 'Test', dir, templateId: 'minecraft-vanilla' };
const manager = {
  servers: [server],
  rt: () => ({ status: 'stopped' }),
  readProperties: () => {
    try {
      return fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    } catch {
      return '';
    }
  },
  setProperties: (s, values) => fs.writeFileSync(path.join(dir, 'server.properties'), patchKeyValue(manager.readProperties(), values)),
  logActivity: () => {},
};
const store = { state: { settings: {} }, addEvent: () => {}, save: () => {} };
const req = { headers: { host: 'panel.example.com' }, socket: { encrypted: true } };
const good = zip.build({ 'pack.mcmeta': '{"pack":{"pack_format":34,"description":"x"}}', 'assets/a.txt': 'hi' });

test('upload hosts the pack and writes server.properties', async () => {
  const view = await rp.upload(manager, store, server, 'My Pack.zip', good, req, 'chris');
  const props = manager.readProperties();
  assert.ok(view.pack.applied);
  assert.match(props, /^resource-pack=https:\/\/panel\.example\.com\/api\/public\/resource-pack\/[\w-]+\/pack\.zip$/m);
  assert.match(props, new RegExp(`^resource-pack-sha1=${crypto.createHash('sha1').update(good).digest('hex')}$`, 'm'));
  const slug = view.pack.url.split('/').at(-2);
  const hit = rp.lookup(store, manager, slug);
  assert.deepStrictEqual(fs.readFileSync(hit.file), good);
  assert.strictEqual(rp.lookup(store, manager, '../x'), null);
});

test('require and prompt are plain text only', () => {
  rp.update(manager, store, server, { require: true, prompt: 'Hi "there" \\ ok' }, req);
  const props = manager.readProperties();
  assert.match(props, /^require-resource-pack=true$/m);
  assert.match(props, /^resource-pack-prompt=\{"text":"Hi there  ok"\}$/m);
  assert.throws(() => rp.update(manager, store, server, { baseUrl: 'https://a.com/path' }, req));
});

test('bad zips are refused', async () => {
  await assert.rejects(rp.upload(manager, store, server, 'a.zip', Buffer.from('nope'), req), /not a zip/);
  await assert.rejects(rp.upload(manager, store, server, 'a.zip', zip.build({ 'p/pack.mcmeta': '{}' }), req), /inside the folder/);
  await assert.rejects(rp.upload(manager, store, server, 'a.zip', zip.build({ 'a.txt': 'x' }), req), /no pack\.mcmeta/);
});

test('remove clears the keys and the file', async () => {
  const slug = rp.view(manager, store, server, req).pack.url.split('/').at(-2);
  await rp.remove(manager, store, server, 'chris');
  assert.match(manager.readProperties(), /^resource-pack=$/m);
  assert.strictEqual(rp.lookup(store, manager, slug), null);
});
