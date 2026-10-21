'use strict';

/** Steam branch, Zomboid sandbox, 7 Days map, Nexus links and the tShock provider. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-games1-x-'));

const steamBranch = require('../../server/features/steam-branch');
const sandbox = require('../../server/features/zomboid-sandbox');
const sevenDays = require('../../server/features/sevendays-map');
const nexus = require('../../server/features/nexus');
const tshockProvider = require('../../server/features/mods/providers/tshock');
const tshock = require('../../server/features/tshock');
const zip = require('../../server/core/zip');
const secrets = require('../../server/core/secrets');
const { buildInstallScript } = require('../../server/servers/install/bash');
const { makeApp, load } = require('./support/routes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-games1-srv-'));
test.after(() => fs.rmSync(process.env.GP_DATA_DIR, { recursive: true, force: true }));

/* -------------------------------------------------------- steam branch -- */

const steamTemplate = { id: 'valheim', install: [{ type: 'steamcmd', appid: '896660' }, { type: 'chmod', path: 'x', mode: '+x' }] };
const manager = { template: () => steamTemplate, vars: () => ({}), servers: [], require() {} };

test('a branch and its password are validated, sealed and applied to the SteamCMD step', () => {
  const server = { id: 'a' };
  assert.throws(() => steamBranch.set(manager, server, { branch: 'x; rm -rf /' }), /letters, numbers/);
  const view = steamBranch.set(manager, server, { branch: 'public_testing', password: 'pa ss"$word' });
  assert.deepStrictEqual([view.branch, view.hasPassword, view.custom], ['public_testing', true, true]);
  assert.ok(secrets.isSealed(server.steamBetaPassword));
  assert.ok(!JSON.stringify(view).includes('pa ss'));

  const vars = {};
  const steps = steamBranch.apply(manager, server, steamTemplate.install, vars);
  assert.strictEqual(steps[0].branch, 'public_testing');
  assert.strictEqual(vars.GP_BETA_PASSWORD, 'pa ss"$word');
  // The password reaches the script through the environment only.
  const { script, env } = buildInstallScript({ install: steps }, '/srv', vars);
  assert.ok(script.includes('${GP_BETA_PASSWORD}') && !script.includes('pa ss'));
  assert.strictEqual(env.GP_BETA_PASSWORD, 'pa ss"$word');
  assert.ok(script.includes('-betapassword'));

  steamBranch.set(manager, server, { branch: 'public' });
  assert.strictEqual(server.steamBranch, undefined);
  assert.strictEqual(server.steamBetaPassword, undefined);
  assert.strictEqual(steamBranch.apply(manager, server, steamTemplate.install, {}), steamTemplate.install);
});

test('branches come from api.steamcmd.net info', async () => {
  steamBranch._reset();
  const list = await steamBranch.listBranches('896660', async () => ({
    data: { 896660: { depots: { branches: { public: { buildid: '1' }, beta: { buildid: '2', pwdrequired: '1', timeupdated: '1700000000' }, 'bad name': { buildid: '3' } } } } },
  }));
  assert.deepStrictEqual(list.map((b) => [b.name, b.locked]), [['public', false], ['beta', true]]);
});

test('the steam branch routes keep the password out of reads and respect access', async () => {
  const server = { id: 'sv1', name: 'S', dir: tmp(), templateId: 'valheim' };
  const app = makeApp({ manager: { ...manager, servers: [server], require: () => server, isActive: () => false } });
  app.store.addEvent = () => {};
  const admin = app.auth.createUser({ username: 'boss', password: 'correct horse battery', role: 'admin' });
  const { call } = load('games1', app);
  const put = await call('PUT', '/api/servers/sv1/steam-branch', { user: admin, body: { branch: 'beta', password: 'secret1' } });
  assert.strictEqual(put.branch, 'beta');
  const got = await call('GET', '/api/servers/sv1/steam-branch', { user: admin });
  assert.strictEqual(got.hasPassword, true);
  assert.ok(!JSON.stringify(got).includes('secret1'));
  const stranger = app.auth.createUser({ username: 'nobody', password: 'another long passphrase', role: 'user', servers: [], permissions: [] });
  await assert.rejects(call('GET', '/api/servers/sv1/steam-branch', { user: app.auth.users.find((u) => u.id === stranger.id) }), /access/);
});

/* ---------------------------------------------------- zomboid sandbox -- */

const LUA = `-- generated
SandboxVars = {
    VERSION = 5,
    Zombies = 4, -- population
    Distribution = 1,
    XpMultiplier = 1.0,
    StarterKit = false,
    ZombieLore = {
        Speed = 2,
        Strength = 2,
    },
    Custom = "hi",
}
`;

test('the sandbox file is read without being run, and only values change on save', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'Zomboid/Server'), { recursive: true });
  const file = path.join(dir, 'Zomboid/Server/servertest_SandboxVars.lua');
  fs.writeFileSync(file, LUA);
  const server = { id: 'z', dir };
  assert.deepStrictEqual(sandbox.listFiles(server), ['Zomboid/Server/servertest_SandboxVars.lua']);
  const form = sandbox.form(server, 'Zomboid/Server/servertest_SandboxVars.lua');
  const byPath = Object.fromEntries(form.fields.map((f) => [f.path, f]));
  assert.ok(!('VERSION' in byPath));
  assert.strictEqual(byPath.Zombies.options.length, 6);
  assert.strictEqual(byPath['ZombieLore.Speed'].value, 2);
  assert.strictEqual(byPath.Custom.group, 'Other options');
  assert.ok(form.presets.every((p) => Object.keys(p.values).every((k) => k in byPath)));

  const res = sandbox.save(server, 'Zomboid/Server/servertest_SandboxVars.lua', { version: form.version, changes: { Zombies: 2, XpMultiplier: 2, StarterKit: true, 'ZombieLore.Speed': 1, Custom: 'say "x"' } });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('Zombies = 2, -- population'), 'comment kept');
  assert.ok(text.includes('XpMultiplier = 2.0') && text.includes('StarterKit = true') && text.includes('Speed = 1,'));
  assert.ok(text.includes('Custom = "say \\"x\\""'));
  assert.ok(res.version !== form.version);
  assert.throws(() => sandbox.save(server, 'Zomboid/Server/servertest_SandboxVars.lua', { version: form.version, changes: { Zombies: 3 } }), /changed since/);
  assert.throws(() => sandbox.save(server, 'Zomboid/Server/servertest_SandboxVars.lua', { changes: { Zombies: 99 } }), /allowed choices/);
  assert.throws(() => sandbox.save(server, 'Zomboid/Server/servertest_SandboxVars.lua', { changes: { Nope: 1 } }), /not an option/);
  assert.throws(() => sandbox.form(server, '../etc/passwd'), /not a sandbox/);
});

test('Lua that is more than a table is refused, never executed', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'Zomboid/Server'), { recursive: true });
  const rel = 'Zomboid/Server/bad_SandboxVars.lua';
  fs.writeFileSync(path.join(dir, rel), 'SandboxVars = { Zombies = os.execute("touch /tmp/pwned") }');
  const form = sandbox.form({ id: 'z', dir }, rel);
  assert.ok(form.error && form.fields.length === 0);
  assert.throws(() => sandbox.parse('SandboxVars = { A = 1 + 2 }'), /Unexpected|not a number/);
  assert.throws(() => sandbox.parse('X = {}; os.exit()'), /more in the file|Unexpected/);
});

/* ---------------------------------------------------------- 7dtd map -- */

test('the 7 Days map says plainly when no world exists, then reads prefabs and size', () => {
  const dir = tmp();
  const server = { id: 'd', dir };
  const none = sevenDays.preview(server);
  assert.strictEqual(none.available, false);
  assert.match(none.message, /only available after the world exists/);

  const world = path.join(dir, 'data/GeneratedWorlds/Pregen 8k');
  fs.mkdirSync(world, { recursive: true });
  fs.writeFileSync(path.join(world, 'prefabs.xml'), '<prefabs><decoration type="model" name="army_camp_02" position="-300,33,1200" rotation="2"/><decoration name="bad" position="x"/></prefabs>');
  fs.writeFileSync(path.join(world, 'map_info.xml'), '<MapInfo><property name="HeightMapSize" value="8192,8192"/></MapInfo>');
  fs.writeFileSync(path.join(world, 'biomes.png'), Buffer.from([137, 80, 78, 71]));
  const p = sevenDays.preview(server);
  assert.deepStrictEqual([p.available, p.world, p.size, p.hasImage], [true, 'Pregen 8k', 8192, true]);
  assert.deepStrictEqual(p.pois, [{ name: 'Army Camp', id: 'army_camp_02', x: -300, z: 1200 }]);
  assert.strictEqual(sevenDays.image(server, 'Pregen 8k').size, 4);
  assert.throws(() => sevenDays.image(server, '../x'), /not been generated/);
  assert.throws(() => sevenDays.image(server, 'Pregen 8k', '../../secret'), /Unknown image/);
});

/* ------------------------------------------------------------- nexus -- */

test('Nexus links come from a fixed catalogue', () => {
  const g = nexus.forTemplate('seven-days-to-die');
  assert.strictEqual(g.url, 'https://www.nexusmods.com/7daystodie');
  assert.ok(nexus.searchUrl(g.domain, 'a b&c').includes('gsearch=a+b%26c'));
  assert.strictEqual(nexus.forTemplate('nope'), null);
  assert.strictEqual(nexus.forTemplate('minecraft-paper').domain, 'minecraft');
});

/* ------------------------------------------------------------ tshock -- */

const dll = (tag) => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, tag)]);

test('tShock zips give up their dlls (flat) and plain dlls are checked', async () => {
  const dir = tmp();
  const server = { id: 't', dir };
  const archive = path.join(dir, 'p.zip');
  fs.writeFileSync(archive, zip.build({ 'Plugin/Cool.dll': dll(1), 'Plugin/readme.txt': 'x', '../Evil.dll': dll(2), 'notadll.dll': 'text' }));
  const written = await tshock.installFile(server, archive, 'p.zip');
  assert.deepStrictEqual(written.sort(), ['Cool.dll', 'Evil.dll']);
  assert.ok(fs.existsSync(path.join(dir, 'ServerPlugins/Cool.dll')) && !fs.existsSync(path.join(dir, '..', 'Evil.dll')));

  const single = path.join(dir, 'one.bin');
  fs.writeFileSync(single, dll(3));
  assert.deepStrictEqual(await tshock.installFile(server, single, '../weird name'), ['weird_name.dll']);
  const junk = path.join(dir, 'junk');
  fs.writeFileSync(junk, 'hello world');
  await assert.rejects(tshock.installFile(server, junk, 'x.dll'), /not a plugin/);
  await assert.rejects(tshock.installFromUrl(server, 'http://example.com/a.dll'), /https/);
  await assert.rejects(tshock.installFromUrl(server, 'https://127.0.0.1/a.dll'), /inside your network/);
});

test('the tShock provider switches plugins off with .disabled and removes them', async () => {
  const dir = tmp();
  const server = { id: 't2', dir, vars: {} };
  fs.mkdirSync(path.join(dir, 'ServerPlugins'));
  fs.writeFileSync(path.join(dir, 'ServerPlugins/A.dll'), dll(1));
  const entry = { file: 'A.dll', disabled: false };
  assert.strictEqual(await tshockProvider.toggleEntry(server, {}, entry), true);
  assert.ok(fs.existsSync(path.join(dir, 'ServerPlugins/A.dll.disabled')));
  entry.disabled = true;
  assert.strictEqual(await tshockProvider.toggleEntry(server, {}, entry), false);
  await tshockProvider.removeEntry(server, {}, entry);
  assert.ok(!fs.existsSync(path.join(dir, 'ServerPlugins/A.dll')));
  assert.throws(() => tshockProvider.parseId('a/b'), /catalogue/);
});
