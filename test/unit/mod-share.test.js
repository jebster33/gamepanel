'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const share = require('../../server/features/mods/share');
const manifest = require('../../server/features/mods/manifest');
const modrinth = require('../../server/features/mods/providers/modrinth');

function setup(template, mods) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-share-'));
  const server = { id: 's1', name: 'Test', dir, vars: {}, gameVersion: '1.21.1', loader: 'fabric', resolvedVersion: '1.21.1 (loader 0.16.9)' };
  manifest.save(server, mods);
  const store = { state: { settings: {} }, save() {} };
  const manager = { servers: [server], template: () => template };
  return { server, store, manager };
}

const fabric = { name: 'Fabric', category: 'Minecraft', mods: { loader: 'fabric', projectType: 'mod', dir: 'mods', providers: ['modrinth'] } };

test('the public list only exists while sharing is on, and leaves out server-only mods', async () => {
  const { store, manager } = setup(fabric, [
    { key: 'modrinth:a', provider: 'modrinth', projectId: 'a', name: 'Client Mod', clientSide: 'required', url: 'https://modrinth.com/mod/a', versionId: 'v1' },
    { key: 'modrinth:b', provider: 'modrinth', projectId: 'b', name: 'Server Only', clientSide: 'unsupported' },
    { key: 'modrinth:c', provider: 'modrinth', projectId: 'c', name: 'Nice To Have', clientSide: 'optional' },
  ]);
  assert.equal(await share.publicView(store, manager, 'nope'), null);
  const cfg = share.update(store, 's1', { enabled: true, notes: 'hi', extras: [{ name: 'Pack', url: 'https://example.com/p.zip' }] });
  assert.equal(await share.publicView(store, manager, 'wrong'), null);
  const view = await share.publicView(store, manager, cfg.slug);
  assert.deepEqual(view.mods.map((m) => [m.name, m.side]), [['Client Mod', 'required'], ['Nice To Have', 'optional']]);
  assert.equal(view.loaderVersion, '0.16.9');
  assert.equal(view.pack, true);
  share.update(store, 's1', { enabled: false });
  assert.equal(await share.publicView(store, manager, cfg.slug), null);
});

test('extra links must be web addresses', () => {
  const { store } = setup(fabric, []);
  assert.throws(() => share.update(store, 's1', { extras: [{ name: 'x', url: 'javascript:alert(1)' }] }), /https/);
});

test('plugins are not something players install', async () => {
  const paper = { name: 'Paper', category: 'Minecraft', mods: { loader: 'paper', projectType: 'plugin', dir: 'plugins', providers: ['hangar'] } };
  const { store, manager } = setup(paper, [{ key: 'hangar:x', provider: 'hangar', projectId: 'x', name: 'EssentialsX' }]);
  const cfg = share.update(store, 's1', { enabled: true });
  assert.equal((await share.publicView(store, manager, cfg.slug)).mods.length, 0);
});

test('the .mrpack lists Modrinth mods with their hashes and the loader', async () => {
  const { store, manager } = setup(fabric, [{ key: 'modrinth:a', provider: 'modrinth', projectId: 'a', name: 'A', clientSide: 'required', versionId: 'v1' }]);
  const cfg = share.update(store, 's1', { enabled: true });
  const original = modrinth.version;
  modrinth.version = async () => ({ file: { url: 'https://cdn.modrinth.com/a.jar', filename: 'a.jar', size: 5, sha1: 'x', sha512: 'y' } });
  try {
    const pack = await share.mrpack(store, manager, cfg.slug);
    const index = JSON.parse(require('../../server/core/zip').open(pack.data).read('modrinth.index.json'));
    assert.equal(index.files[0].downloads[0], 'https://cdn.modrinth.com/a.jar');
    assert.deepEqual(index.dependencies, { minecraft: '1.21.1', 'fabric-loader': '0.16.9' });
  } finally {
    modrinth.version = original;
  }
});
