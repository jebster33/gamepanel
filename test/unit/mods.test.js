'use strict';

/**
 * The one-click mod installer against a fake Modrinth: compatible-only
 * picking, dependency resolution, replacing old versions and cleaning up
 * dependencies nobody needs any more. No network needed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-unit-'));

const mods = require('../../server/features/mods');
const manifest = require('../../server/features/mods/manifest');
const { modContext } = require('../../server/features/mods/compat');

/* ----------------------------------------------------------- fake API -- */

const file = (name) => {
  const body = Buffer.from(`jar:${name}`);
  return { url: `https://cdn.test/${name}`, filename: name, size: body.length, primary: true, hashes: { sha1: crypto.createHash('sha1').update(body).digest('hex') } };
};
const version = (id, project, number, { loaders = ['fabric'], game = ['1.21.4'], type = 'release', deps = [], date = '2025-01-01' } = {}) => ({
  id,
  project_id: project,
  name: `${project} ${number}`,
  version_number: number,
  version_type: type,
  game_versions: game,
  loaders,
  date_published: date,
  files: [file(`${project}-${number}.jar`)],
  dependencies: deps,
});

const PROJECTS = {
  ledger: { id: 'ledger', slug: 'ledger', title: 'Ledger', server_side: 'required', project_type: 'mod' },
  'fabric-api': { id: 'fabric-api', slug: 'fabric-api', title: 'Fabric API', server_side: 'optional', project_type: 'mod' },
  flk: { id: 'flk', slug: 'fabric-language-kotlin', title: 'Fabric Language Kotlin', server_side: 'required', project_type: 'mod' },
  sodium: { id: 'sodium', slug: 'sodium', title: 'Sodium', server_side: 'unsupported', project_type: 'mod' },
  clash: { id: 'clash', slug: 'clash', title: 'Clash', server_side: 'required', project_type: 'mod' },
};

let VERSIONS;
function resetVersions() {
  VERSIONS = {
    ledger: [
      version('l2', 'ledger', '1.3.0-beta', { type: 'beta', date: '2025-03-01', deps: [{ project_id: 'fabric-api', dependency_type: 'required' }] }),
      version('l1', 'ledger', '1.2.0', { date: '2025-02-01', deps: [{ project_id: 'fabric-api', dependency_type: 'required' }, { version_id: 'k1', dependency_type: 'required' }] }),
      version('lf', 'ledger', '1.2.0-forge', { loaders: ['forge'], date: '2025-04-01' }),
    ],
    'fabric-api': [
      version('f2', 'fabric-api', '0.110.0', { game: ['1.21.5'], date: '2025-03-01' }),
      version('f1', 'fabric-api', '0.105.0', { date: '2025-01-01' }),
    ],
    flk: [version('k1', 'flk', '1.12.0', { game: ['1.21.4', '1.21.5'] })],
    sodium: [version('s1', 'sodium', '0.6.0')],
    clash: [version('c1', 'clash', '1.0', { deps: [{ project_id: 'ledger', dependency_type: 'incompatible' }] })],
  };
}

const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
global.fetch = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'cdn.test') return new Response(Buffer.from(`jar:${u.pathname.slice(1)}`));
  let m = u.pathname.match(/^\/v2\/project\/([^/]+)\/version$/);
  if (m) {
    const loaders = JSON.parse(u.searchParams.get('loaders') || 'null');
    const games = JSON.parse(u.searchParams.get('game_versions') || 'null');
    const list = (VERSIONS[m[1]] || []).filter((v) => (!loaders || v.loaders.some((l) => loaders.includes(l))) && (!games || v.game_versions.some((g) => games.includes(g))));
    return json(list);
  }
  m = u.pathname.match(/^\/v2\/project\/([^/]+)$/);
  if (m) {
    const p = Object.values(PROJECTS).find((x) => x.id === m[1] || x.slug === m[1]);
    return p ? json(p) : new Response('not found', { status: 404 });
  }
  m = u.pathname.match(/^\/v2\/version\/([^/]+)$/);
  if (m) {
    const v = Object.values(VERSIONS).flat().find((x) => x.id === m[1]);
    return v ? json(v) : new Response('not found', { status: 404 });
  }
  if (u.pathname === '/v2/version_files') return json({});
  if (u.pathname === '/v2/projects') return json([]);
  return new Response('unexpected', { status: 500 });
};

/* -------------------------------------------------------------- setup -- */

const template = { id: 'minecraft-fabric', category: 'Minecraft', mods: { providers: ['modrinth'], dir: 'mods', loader: 'fabric', gameVersionVar: 'MC_VERSION' } };
function newServer(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mods-'));
  return { id: path.basename(dir), name: 'Test', dir, vars: { MC_VERSION: '1.21.4' }, ...extra };
}
const files = (server) => fs.readdirSync(path.join(server.dir, 'mods')).sort();

/* -------------------------------------------------------------- tests -- */

test('context: loader families', () => {
  const ctx = (loader, mc = '1.21.4') => modContext({ dir: '/x', vars: {}, loader, gameVersion: mc }, { category: 'Minecraft', mods: {} });
  assert.deepStrictEqual(ctx('quilt').modrinthLoaders, ['quilt', 'fabric']);
  assert.deepStrictEqual(ctx('paper').modrinthLoaders, ['paper', 'spigot', 'bukkit']);
  assert.strictEqual(ctx('paper').projectType, 'plugin');
  assert.deepStrictEqual(ctx('neoforge', '1.20.1').modrinthLoaders, ['neoforge', 'forge']);
  assert.deepStrictEqual(ctx('neoforge', '1.21.1').modrinthLoaders, ['neoforge']);
  assert.strictEqual(ctx(undefined).projectType, 'datapack');
});

test('context: modpack servers filter on the pack loader and Minecraft version', () => {
  const ctx = modContext({ dir: '/x', vars: {}, pack: { loader: 'neoforge 21.1.80', mcVersion: '1.21.1' } }, { category: 'Minecraft', modpacks: true, mods: {} });
  assert.strictEqual(ctx.loader, 'neoforge');
  assert.strictEqual(ctx.gameVersion, '1.21.1');
});

test('installs the newest stable release that fits, plus required dependencies', async () => {
  resetVersions();
  const server = newServer();
  const result = await mods.install(server, template, { provider: 'modrinth', projectId: 'ledger' }, {});
  // Ledger 1.2.0 (the 1.3 beta and the Forge build are skipped), Fabric API for 1.21.4, and Kotlin via a pinned version id.
  assert.deepStrictEqual(files(server), ['fabric-api-0.105.0.jar', 'flk-1.12.0.jar', 'ledger-1.2.0.jar']);
  assert.strictEqual(result.installed.filter((i) => i.dependency).length, 2);
  const m = manifest.load(server);
  assert.strictEqual(m.find((x) => x.projectId === 'ledger').auto, false);
  assert.deepStrictEqual(m.find((x) => x.projectId === 'fabric-api').requiredBy, ['modrinth:ledger']);
});

test('updating replaces the old file instead of leaving two copies', async () => {
  resetVersions();
  const server = newServer();
  await mods.install(server, template, { provider: 'modrinth', projectId: 'ledger' }, {});
  VERSIONS.ledger.unshift(version('l3', 'ledger', '1.4.0', { date: '2025-05-01', deps: [{ project_id: 'fabric-api', dependency_type: 'required' }] }));
  const { updates } = await mods.checkUpdates(server, template, {});
  assert.deepStrictEqual(updates.map((u) => [u.name, u.latest]), [['Ledger', '1.4.0']]);
  await mods.update(server, template, updates.map((u) => u.key), {});
  assert.deepStrictEqual(files(server), ['fabric-api-0.105.0.jar', 'flk-1.12.0.jar', 'ledger-1.4.0.jar']);
});

test('removing a mod also removes dependencies nothing else needs', async () => {
  resetVersions();
  const server = newServer();
  await mods.install(server, template, { provider: 'modrinth', projectId: 'ledger' }, {});
  const result = await mods.remove(server, template, 'ledger-1.2.0.jar');
  assert.deepStrictEqual(result.removed.sort(), ['Fabric API', 'Fabric Language Kotlin', 'Ledger']);
  assert.deepStrictEqual(files(server), []);
});

test('a dependency the user installed on purpose is kept', async () => {
  resetVersions();
  const server = newServer();
  await mods.install(server, template, { provider: 'modrinth', projectId: 'fabric-api' }, {});
  await mods.install(server, template, { provider: 'modrinth', projectId: 'ledger' }, {});
  await mods.remove(server, template, 'ledger-1.2.0.jar');
  assert.deepStrictEqual(files(server), ['fabric-api-0.105.0.jar']);
});

test('refuses client-only mods and mods with no fitting release', async () => {
  resetVersions();
  const server = newServer();
  await assert.rejects(mods.install(server, template, { provider: 'modrinth', projectId: 'sodium' }, {}), /client-side/);
  const old = newServer({ vars: { MC_VERSION: '1.20.1' } });
  await assert.rejects(mods.install(old, template, { provider: 'modrinth', projectId: 'ledger' }, {}), /no release for Fabric 1\.20\.1/);
  assert.ok(!fs.existsSync(path.join(old.dir, 'mods')) || files(old).length === 0, 'nothing is left behind');
});

test('refuses a mod that declares itself incompatible with an installed one', async () => {
  resetVersions();
  const server = newServer();
  await mods.install(server, template, { provider: 'modrinth', projectId: 'ledger' }, {});
  await assert.rejects(mods.install(server, template, { provider: 'modrinth', projectId: 'clash' }, {}), /does not work together with Ledger/);
});

test('a missing dependency stops the whole install', async () => {
  resetVersions();
  VERSIONS['fabric-api'] = [];
  const server = newServer();
  await assert.rejects(mods.install(server, template, { provider: 'modrinth', projectId: 'ledger' }, {}), /Ledger needs Fabric API/);
  assert.ok(!fs.existsSync(path.join(server.dir, 'mods')) || files(server).length === 0);
});

test('disable and enable by renaming', async () => {
  resetVersions();
  const server = newServer();
  await mods.install(server, template, { provider: 'modrinth', projectId: 'fabric-api' }, {});
  await mods.toggle(server, template, 'fabric-api-0.105.0.jar');
  assert.deepStrictEqual(files(server), ['fabric-api-0.105.0.jar.disabled']);
  const list = await mods.listInstalled(server, template);
  assert.strictEqual(list.items[0].title, 'Fabric API');
  assert.strictEqual(list.items[0].disabled, true);
  await mods.toggle(server, template, 'fabric-api-0.105.0.jar.disabled');
  assert.deepStrictEqual(files(server), ['fabric-api-0.105.0.jar']);
});

test('modpack diff matches mods by project, not file name', () => {
  const { diff } = require('../../server/games/pack-diff');
  const pack = (version, mods) => ({ version, minecraft: '1.21.1', loader: 'fabric 0.16', mods: new Map(mods) });
  const d = diff(
    pack('1.0', [['mr:sodium', { name: 'Sodium', version: '0.5.8' }], ['mr:lithium', { name: 'Lithium', version: '0.12' }], ['mr:old', { name: 'Old', version: '1' }]]),
    pack('1.1', [['mr:sodium', { name: 'Sodium', version: '0.6.0' }], ['mr:lithium', { name: 'Lithium', version: '0.12' }], ['mr:new', { name: 'New', version: '2' }]])
  );
  assert.deepStrictEqual(d.updated, [{ name: 'Sodium', from: '0.5.8', to: '0.6.0' }]);
  assert.deepStrictEqual(d.added.map((m) => m.name), ['New']);
  assert.deepStrictEqual(d.removed.map((m) => m.name), ['Old']);
  assert.strictEqual(d.unchanged, 1);
});
