'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mclp-data-'));
const lp = require('../../server/features/luckperms');
const jvm = require('../../server/features/jvm-presets');
const skins = require('../../server/features/mc-skins');

const cmd = (body) => lp.build(body).join(' ');

test('LuckPerms commands are built from validated fields only', () => {
  assert.strictEqual(cmd({ action: 'group.create', name: 'Mod' }), 'lp creategroup mod');
  assert.strictEqual(cmd({ action: 'permission.set', type: 'group', name: 'mod', node: 'essentials.kick', value: false }), 'lp group mod permission set essentials.kick false');
  assert.strictEqual(cmd({ action: 'permission.set', type: 'user', name: 'Notch', node: 'worldedit.*', value: true, context: { world: 'world_nether' } }), 'lp user Notch permission set worldedit.* true world=world_nether');
  assert.strictEqual(cmd({ action: 'permission.set', type: 'user', name: 'Notch', node: 'a.b', value: true, duration: '7d' }), 'lp user Notch permission settemp a.b true 7d');
  assert.strictEqual(cmd({ action: 'weight.set', name: 'admin', weight: 100 }), 'lp group admin setweight 100');
  assert.strictEqual(cmd({ action: 'parent.add', type: 'group', name: 'admin', parent: 'mod' }), 'lp group admin parent add mod');
  assert.strictEqual(cmd({ action: 'prefix.set', type: 'group', name: 'admin', priority: 100, text: '&c[Admin] ' }), 'lp group admin meta addprefix 100 "&c[Admin] "');
  assert.strictEqual(cmd({ action: 'prefix.set', type: 'group', name: 'admin', priority: 5, text: '&c[A]' }), 'lp group admin meta addprefix 5 &c[A]');
  assert.strictEqual(cmd({ action: 'meta.set', type: 'user', name: 'Notch', key: 'homes', value: '3' }), 'lp user Notch meta set homes 3');
  assert.throws(() => lp.build({ action: 'group.delete', name: 'default' }), /default group/);
});

test('LuckPerms rejects anything that could smuggle a second command', () => {
  const bad = [
    { action: 'group.create', name: 'x; op me' },
    { action: 'group.create', name: 'x\nstop' },
    { action: 'permission.set', type: 'group', name: 'a', node: 'x y' },
    { action: 'permission.set', type: 'group', name: 'a b', node: 'x' },
    { action: 'permission.set', type: 'user', name: 'Notch', node: 'x', context: { 'server=a': 'b' } },
    { action: 'permission.set', type: 'user', name: 'Notch', node: 'x', context: { server: 'a b' } },
    { action: 'permission.set', type: 'user', name: 'Notch', node: 'x', duration: '1d; stop' },
    { action: 'prefix.set', type: 'group', name: 'a', priority: 1, text: 'a"b' },
    { action: 'prefix.set', type: 'group', name: 'a', priority: 1, text: 'a\nstop' },
    { action: 'prefix.set', type: 'group', name: 'a', priority: 'x', text: 'a' },
    { action: 'meta.set', type: 'group', name: 'a', key: 'k k', value: 'v' },
    { action: 'weight.set', name: 'a', weight: 1e9 },
    { action: 'op.everyone' },
    { action: 'permission.set', type: 'player', name: 'a', node: 'x' },
  ];
  for (const b of bad) assert.throws(() => lp.build(b), /./, JSON.stringify(b));
});

test('parses an lp export into groups, parents, weights, prefixes, meta and users', () => {
  const file = {
    groups: {
      default: { nodes: [{ type: 'permission', key: 'essentials.spawn', value: true }, { key: 'weight.1', value: true }] },
      admin: {
        nodes: [
          { key: 'group.default', value: true },
          { key: 'weight.100', value: true },
          { key: 'prefix.100.&c[Admin] ', value: true },
          { key: 'meta.homes.5', value: true },
          { key: '*', value: true },
          { key: 'essentials.ban', value: false, context: { server: 'hub' } },
        ],
      },
    },
    users: { '069a79f4-44e9-4726-a5be-fca90e38aaf5': { username: 'Notch', primaryGroup: 'admin', nodes: [{ key: 'group.admin', value: true }] } },
    tracks: { staff: { groups: ['default', 'admin'] } },
  };
  for (const buf of [Buffer.from(JSON.stringify(file)), zlib.gzipSync(JSON.stringify(file))]) {
    const r = lp.parseExport(buf);
    assert.deepStrictEqual(r.groups.map((g) => g.name), ['admin', 'default']);
    const admin = r.groups[0];
    assert.strictEqual(admin.weight, 100);
    assert.deepStrictEqual(admin.parents.map((p) => p.group), ['default']);
    assert.deepStrictEqual(admin.prefixes, [{ priority: 100, text: '&c[Admin] ', context: {} }]);
    assert.deepStrictEqual(admin.meta.map((m) => [m.key, m.value]), [['homes', '5']]);
    assert.deepStrictEqual(admin.permissions.map((p) => [p.node, p.value]), [['*', true], ['essentials.ban', false]]);
    assert.deepStrictEqual(admin.permissions[1].context, { server: 'hub' });
    assert.deepStrictEqual([r.users[0].name, r.users[0].parents[0].group], ['Notch', 'admin']);
    assert.deepStrictEqual(r.tracks[0].groups, ['default', 'admin']);
  }
  assert.throws(() => lp.parseExport(Buffer.from('nope')), /could not read/);
});

test('LuckPerms read() sends lp export, waits for the file, parses it and cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mclp-'));
  fs.mkdirSync(path.join(dir, 'plugins/LuckPerms'), { recursive: true });
  const sent = [];
  const manager = {
    rt: () => ({ status: 'running' }),
    sendCommand: async (id, command) => {
      sent.push(command);
      const name = command.split(' ')[2];
      setTimeout(() => fs.writeFileSync(path.join(dir, 'plugins/LuckPerms', `${name}.json.gz`), zlib.gzipSync(JSON.stringify({ groups: { default: { nodes: [] } }, users: {} }))), 50);
    },
  };
  const server = { id: 's', dir, templateId: 'minecraft-paper' };
  const r = await lp.read(manager, server, { wait: 5000 });
  assert.match(sent[0], /^lp export gp-export-[a-z0-9]+$/);
  assert.strictEqual(r.groups[0].name, 'default');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'plugins/LuckPerms')), []);
  assert.deepStrictEqual(lp.installed({ ...server, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mclp-')) }).installed, false);
  await assert.rejects(() => lp.read({ ...manager, rt: () => ({ status: 'stopped' }) }, server), /Start the server/);
});

test('JVM presets: memory-aware flags, validated custom flags, applied to JAVA_ARGS', () => {
  const server = { id: 's', templateId: 'minecraft-paper', memory: 8192, vars: {} };
  const updates = [];
  const manager = {
    template: () => ({ variables: [{ name: 'JAVA_ARGS', default: '-XX:+UseG1GC' }] }),
    require: () => server,
    update: (id, patch) => {
      updates.push(patch);
      Object.assign(server.vars, patch.vars);
    },
  };
  const v = jvm.view(manager, server);
  assert.strictEqual(v.supported, true);
  assert.strictEqual(v.memoryFlags, '-Xms8192M -Xmx8192M');
  assert.deepStrictEqual(v.presets.map((p) => p.id), ['aikar', 'zgc', 'zgc24', 'lowmem', 'graal', 'default']);
  assert.ok(v.presets.every((p) => p.line.length > 20 && !/-Xm[sx]/.test(p.flags)));
  assert.match(v.presets.find((p) => p.id === 'zgc').flags, /-XX:\+UseZGC -XX:\+ZGenerational -XX:SoftMaxHeapSize=6963M/);
  assert.match(v.presets.find((p) => p.id === 'graal').flags, /UseJVMCICompiler/);
  jvm.apply(manager, server, { preset: 'lowmem' }, 'admin');
  assert.match(updates[0].vars.JAVA_ARGS, /UseSerialGC/);
  assert.strictEqual(jvm.view(manager, server).preset, 'lowmem');
  jvm.apply(manager, server, { preset: 'custom', custom: '-XX:+UseParallelGC  -Dfoo=bar' }, 'admin');
  assert.strictEqual(updates[1].vars.JAVA_ARGS, '-XX:+UseParallelGC -Dfoo=bar');
  for (const bad of ['-Xmx99G', '-Xms1G', 'java -jar x', '-XX:+Foo; rm -rf /', '-Dx=$(id)', '-Dx="a"', '-jar evil.jar', '-XX:A\n-XX:B']) assert.throws(() => jvm.checkCustom(bad), /./, bad);
  assert.throws(() => jvm.apply(manager, server, { preset: 'nope' }), /Unknown preset/);
  assert.strictEqual(jvm.view({ template: () => ({ variables: [] }) }, { templateId: 'minecraft-paper' }).supported, false);
});

test('skin names are validated and offline-mode servers never look anything up', async () => {
  assert.strictEqual(skins.validName('Notch', false), true);
  assert.strictEqual(skins.validName('../x', false), false);
  assert.strictEqual(skins.validName('a'.repeat(17), false), false);
  assert.strictEqual(skins.validName('.Floodgate Name', true), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mcskin-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'online-mode=false\n');
  const realFetch = global.fetch;
  global.fetch = () => {
    throw new Error('no network lookups expected');
  };
  try {
    assert.strictEqual(await skins.skinFor({}, { id: 's', dir, templateId: 'minecraft-paper' }, 'Notch'), null);
    await assert.rejects(() => skins.skinFor({}, { id: 's', dir, templateId: 'minecraft-paper' }, 'bad name!'), /valid player name/);
  } finally {
    global.fetch = realFetch;
  }
});

test('Java skins go through the session server and only accept textures.minecraft.net PNGs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mcskin-'));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const calls = [];
  const realFetch = global.fetch;
  const textures = (url) => Buffer.from(JSON.stringify({ textures: { SKIN: { url, metadata: { model: 'slim' } } } })).toString('base64');
  global.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.startsWith('https://api.mojang.com/users/profiles/minecraft/Alexa')) return json({ id: '069a79f444e94726a5befca90e38aaf5' });
    if (u.startsWith('https://api.mojang.com/users/profiles/minecraft/Evil')) return json({ id: '169a79f444e94726a5befca90e38aaf5' });
    if (u.includes('sessionserver.mojang.com') && u.endsWith('069a79f444e94726a5befca90e38aaf5')) return json({ properties: [{ name: 'textures', value: textures('https://textures.minecraft.net/texture/abc') }] });
    if (u.includes('sessionserver.mojang.com')) return json({ properties: [{ name: 'textures', value: textures('https://evil.example/skin.png') }] });
    if (u === 'https://textures.minecraft.net/texture/abc') return { ok: true, status: 200, arrayBuffer: async () => png };
    throw new Error(`unexpected ${u}`);
  };
  try {
    const server = { id: 's', dir, templateId: 'minecraft-paper' };
    const a = await skins.skinFor({}, server, 'Alexa');
    assert.strictEqual(a.slim, true);
    assert.ok(a.png.equals(png));
    const n = calls.length;
    await skins.skinFor({}, server, 'Alexa');
    assert.strictEqual(calls.length, n, 'second request is served from the cache');
    assert.strictEqual(await skins.skinFor({}, server, 'Evil'), null, 'a texture URL on another host is never fetched');
    assert.ok(!calls.some((c) => c.includes('evil.example')));
  } finally {
    global.fetch = realFetch;
  }
});
