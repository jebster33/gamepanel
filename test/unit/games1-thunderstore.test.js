'use strict';

/** Thunderstore provider against a fake site: search, dependencies, layout, switch off, remove, updates. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-games1-ts-'));

const mods = require('../../server/features/mods');
const ts = require('../../server/features/mods/providers/thunderstore');
const zip = require('../../server/core/zip');

const pack = zip.build({
  'manifest.json': '{}',
  'icon.png': 'x',
  'README.md': 'x',
  'BepInExPack_Valheim/winhttp.dll': 'loader',
  'BepInExPack_Valheim/BepInEx/core/BepInEx.dll': 'core',
  'BepInExPack_Valheim/BepInEx/config/BepInEx.cfg': 'default config',
});
const modZip = (n) =>
  zip.build({
    'manifest.json': '{}',
    'icon.png': 'x',
    [`Cool.dll`]: `cool-${n}`,
    'config/cool.cfg': 'cfg',
    'patchers/Patch.dll': 'patch',
    'assets/bundle.bin': 'bin',
    '../evil.dll': 'nope',
  });

let latest = '1.0.0';
const PKGS = () => [
  {
    name: 'BepInExPack_Valheim',
    full_name: 'denikson-BepInExPack_Valheim',
    owner: 'denikson',
    package_url: 'https://thunderstore.io/c/valheim/p/denikson/BepInExPack_Valheim/',
    categories: [],
    versions: [{ name: 'BepInExPack_Valheim', version_number: '5.4.2200', date_created: '2024-01-01', download_url: 'https://cdn.test/pack.zip', dependencies: [], downloads: 900, description: 'loader' }],
  },
  {
    name: 'CoolMod',
    full_name: 'Alice-CoolMod',
    owner: 'Alice',
    package_url: 'https://thunderstore.io/c/valheim/p/Alice/CoolMod/',
    categories: ['Mods', 'Server-side'],
    versions: [
      { name: 'CoolMod', version_number: latest, date_created: '2024-06-01', download_url: `https://cdn.test/cool-${latest}.zip`, dependencies: ['denikson-BepInExPack_Valheim-5.4.2200'], downloads: 50, description: 'A cool mod' },
      { name: 'CoolMod', version_number: '0.9.0', date_created: '2024-01-01', download_url: 'https://cdn.test/cool-0.9.0.zip', dependencies: ['denikson-BepInExPack_Valheim-5.4.2200'], downloads: 5, description: 'old' },
    ],
  },
  { name: 'Sodium', full_name: 'Bob-Skins', owner: 'Bob', categories: ['Client-side'], package_url: 'x', versions: [{ name: 'Skins', version_number: '1.0.0', date_created: '2024-01-01', download_url: 'https://cdn.test/skins.zip', dependencies: [] }] },
];

const realFetch = global.fetch;
test.before(() => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/c/valheim/api/v1/package/')) return new Response(JSON.stringify(PKGS()), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('pack.zip')) return new Response(pack, { status: 200 });
    const m = u.match(/cool-([\d.]+)\.zip$/);
    if (m) return new Response(modZip(m[1]), { status: 200 });
    return new Response('nope', { status: 404 });
  };
});
test.after(() => {
  global.fetch = realFetch;
  fs.rmSync(process.env.GP_DATA_DIR, { recursive: true, force: true });
});

const template = { id: 'valheim', mods: { providers: ['thunderstore'], dir: 'BepInEx/plugins', game: 'valheim', thunderstore: 'valheim' } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-games1-ts-srv-'));
const server = { id: 's1', name: 'V', dir, vars: {}, templateId: 'valheim' };
const exists = (rel) => fs.existsSync(path.join(dir, rel));

test('layout maps zip folders the way mod managers do and drops unsafe entries', () => {
  const out = ts.mapLayout(['manifest.json', 'a.dll', 'plugins/b.dll', 'config/c.cfg', 'patchers/p.dll', 'BepInEx/plugins/d.dll', '../x.dll', '/abs.dll', 'sub/e.dll'], { id: 'O-N', loader: false, root: 'BepInEx' });
  const to = Object.fromEntries(out.map((o) => [o.from, o.to]));
  assert.strictEqual(to['a.dll'], 'BepInEx/plugins/O-N/a.dll');
  assert.strictEqual(to['plugins/b.dll'], 'BepInEx/plugins/O-N/b.dll');
  assert.strictEqual(to['config/c.cfg'], 'BepInEx/config/c.cfg');
  assert.strictEqual(to['patchers/p.dll'], 'BepInEx/patchers/O-N/p.dll');
  assert.strictEqual(to['BepInEx/plugins/d.dll'], 'BepInEx/plugins/O-N/d.dll');
  assert.strictEqual(to['sub/e.dll'], 'BepInEx/plugins/O-N/sub/e.dll');
  assert.ok(!('manifest.json' in to) && !('../x.dll' in to) && !('/abs.dll' in to));
  assert.deepStrictEqual(ts.parseDependency('denikson-BepInExPack_Valheim-5.4.2200'), { projectId: 'denikson-BepInExPack_Valheim', versionId: '5.4.2200' });
});

test('search hides the loader and client-only mods are refused', async () => {
  const ctx = mods.context(server, template);
  const res = await mods.search(server, template, { provider: 'thunderstore', query: 'cool' }, {});
  assert.deepStrictEqual(res.items.map((i) => i.id), ['Alice-CoolMod']);
  assert.strictEqual(ctx.thunderstore, 'valheim');
  await assert.rejects(mods.install(server, template, { provider: 'thunderstore', projectId: 'Bob-Skins' }, {}), /client-side/);
});

test('install brings the loader as a dependency and puts files in the right folders', async () => {
  const r = await mods.install(server, template, { provider: 'thunderstore', projectId: 'Alice-CoolMod' }, {});
  assert.deepStrictEqual(r.installed.map((i) => i.name).sort(), ['CoolMod', 'BepInExPack Valheim'].sort());
  assert.ok(exists('winhttp.dll'), 'loader unwrapped into the server folder');
  assert.ok(exists('BepInEx/core/BepInEx.dll'));
  assert.ok(exists('BepInEx/plugins/Alice-CoolMod/Cool.dll'));
  assert.ok(exists('BepInEx/patchers/Alice-CoolMod/Patch.dll'));
  assert.ok(exists('BepInEx/config/cool.cfg'));
  assert.ok(exists('BepInEx/plugins/Alice-CoolMod/assets/bundle.bin'));
  assert.ok(!exists('evil.dll') && !fs.existsSync(path.join(dir, '..', 'evil.dll')));
  const list = await mods.listInstalled(server, template);
  assert.ok(list.items.find((i) => i.title === 'CoolMod' && !i.disabled));
});

test('switching off renames the dlls, switching on restores them', async () => {
  const off = await mods.toggle(server, template, 'Alice-CoolMod');
  assert.strictEqual(off.disabled, true);
  assert.ok(exists('BepInEx/plugins/Alice-CoolMod/Cool.dll.old') && !exists('BepInEx/plugins/Alice-CoolMod/Cool.dll'));
  assert.ok((await mods.listInstalled(server, template)).items.find((i) => i.title === 'CoolMod').disabled);
  const on = await mods.toggle(server, template, 'Alice-CoolMod');
  assert.strictEqual(on.disabled, false);
  assert.ok(exists('BepInEx/plugins/Alice-CoolMod/Cool.dll'));
  await assert.rejects(mods.toggle(server, template, 'thunderstore:denikson-BepInExPack_Valheim'), /loader/i);
});

test('an update check sees a new release, and updating keeps an edited config', async () => {
  fs.writeFileSync(path.join(dir, 'BepInEx/config/cool.cfg'), 'edited');
  latest = '1.1.0';
  ts._reset();
  const check = await mods.checkUpdates(server, template, {});
  assert.deepStrictEqual(check.updates.map((u) => [u.name, u.current, u.latest]), [['CoolMod', '1.0.0', '1.1.0']]);
  const res = await mods.update(server, template, ['thunderstore:Alice-CoolMod'], {});
  assert.strictEqual(res.failed.length, 0, JSON.stringify(res.failed));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'BepInEx/plugins/Alice-CoolMod/Cool.dll'), 'utf8'), 'cool-1.1.0');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'BepInEx/config/cool.cfg'), 'utf8'), 'edited');
});

test('removing the mod removes its files and the loader nobody needs', async () => {
  const r = await mods.remove(server, template, 'Alice-CoolMod');
  assert.ok(r.removed.includes('CoolMod'));
  assert.ok(!exists('BepInEx/plugins/Alice-CoolMod'));
  assert.ok(!exists('winhttp.dll'));
  assert.ok(exists('BepInEx/config/cool.cfg'), 'config files stay');
});
