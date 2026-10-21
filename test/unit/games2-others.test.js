'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const squad = require('../../server/features/gametools/squad');
const gmod = require('../../server/features/gametools/gmod');
const satisfactory = require('../../server/features/gametools/satisfactory');
const palworld = require('../../server/features/gametools/palworld');
const se = require('../../server/features/gametools/space-engineers');
const { makeApp, load } = require('./support/routes');

const store = { save() {}, addEvent() {} };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `gp-${name}-`));
const put = (dir, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};
const manager = (active = false) => ({ isActive: () => active, vars: (s) => s.vars, broadcastServers() {}, template: () => ({}) });

test('squad rotation: parse, validate, save with backup', () => {
  const dir = tmp('squad');
  const server = { id: 's', dir };
  put(dir, 'SquadGame/ServerConfig/LayerRotation.cfg', '// my rotation\nGorodok_RAAS_v1\n\nMestia_AAS_v1 // note\n');
  const read = squad.read(server);
  assert.deepStrictEqual(read.layers.map((l) => l.id), ['Gorodok_RAAS_v1', 'Mestia_AAS_v1']);
  assert.ok(read.layers[0].official);
  const out = squad.save(manager(), server, null, { layers: ['Mestia_AAS_v1', 'Custom_Layer_v9', 'Gorodok_RAAS_v1'] });
  assert.ok(out.backup);
  const text = fs.readFileSync(path.join(dir, 'SquadGame/ServerConfig/LayerRotation.cfg'), 'utf8');
  assert.strictEqual(text, '// my rotation\nMestia_AAS_v1\nCustom_Layer_v9\nGorodok_RAAS_v1\n');
  assert.throws(() => squad.save(manager(), server, null, { layers: ['bad name'] }));
  assert.throws(() => squad.save(manager(), server, 'Evil', { layers: ['A_B_C'] }));
  assert.throws(() => squad.save(manager(), server, null, { layers: [] }));
});

test('gmod: finds gamemodes and maps (including inside a .gma) and switches', () => {
  const dir = tmp('gmod');
  const server = { id: 's', dir, vars: { GAMEMODE: 'sandbox', MAP: 'gm_construct' } };
  put(dir, 'garrysmod/gamemodes/terrortown/terrortown.txt', '"terrortown"\n{\n\t"title"\t"Trouble in Terrorist Town"\n\t"maps"\t"^ttt_"\n}\n');
  put(dir, 'garrysmod/maps/gm_construct.bsp', 'x');
  put(dir, 'garrysmod/maps/ttt_minecraft_b5.bsp', 'x');
  // A tiny GMA: header, title, description, author, version, two files.
  const z = (s) => Buffer.concat([Buffer.from(s), Buffer.from([0])]);
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const entry = (i, name) => Buffer.concat([u32(i), z(name), Buffer.alloc(8), u32(0)]);
  const gma = Buffer.concat([Buffer.from('GMAD'), Buffer.from([3]), Buffer.alloc(16), z(''), z('DarkRP Pack'), z('{}'), z('me'), u32(1), entry(1, 'gamemodes/darkrp/darkrp.txt'), entry(2, 'maps/rp_downtown.bsp'), u32(0)]);
  put(dir, 'garrysmod/addons/123.gma', gma);
  const scan = gmod.scan(server);
  const ids = scan.gamemodes.filter((g) => g.source).map((g) => g.id).sort();
  assert.deepStrictEqual(ids, ['darkrp', 'terrortown']);
  assert.deepStrictEqual(scan.gamemodes.find((g) => g.id === 'terrortown').prefixes, ['ttt_']);
  assert.ok(scan.maps.some((m) => m.name === 'rp_downtown' && /Workshop/.test(m.source)));
  const out = gmod.apply(manager(), store, server, { gamemode: 'terrortown', map: 'ttt_minecraft_b5' });
  assert.strictEqual(server.vars.GAMEMODE, 'terrortown');
  assert.strictEqual(server.vars.MAP, 'ttt_minecraft_b5');
  assert.strictEqual(out.warnings.length, 0);
  assert.ok(gmod.apply(manager(), store, server, { gamemode: 'darkrp', map: 'gm_construct' }).warnings.length);
  assert.throws(() => gmod.apply(manager(), store, server, { gamemode: 'x +quit' }));
  assert.throws(() => gmod.apply(manager(), store, server, { gamemode: 'darkrp', map: 'a b' }));
  assert.deepStrictEqual(gmod.prefixesFromPattern('^a.*|(evil+)+'), []);
});

test('satisfactory: save files list, upload, trash-delete, names validated', async () => {
  const dir = tmp('sat');
  const server = { id: 's', dir, ports: { game: 7777 } };
  assert.deepStrictEqual(satisfactory.listFiles(server).files, []);
  put(dir, 'FactoryGame/Saved/SaveGames/server/first.sav', 'abc');
  assert.strictEqual(satisfactory.listFiles(server).files[0].name, 'first');
  const { Readable } = require('stream');
  await satisfactory.uploadFile(manager(), server, 'second', Readable.from([Buffer.from('12345')]));
  assert.strictEqual(satisfactory.listFiles(server).files.length, 2);
  assert.throws(() => satisfactory.openFile(server, '../etc/passwd'));
  satisfactory.deleteFile(manager(), server, 'first');
  assert.strictEqual(satisfactory.listFiles(server).files.length, 1);
  assert.throws(() => satisfactory.deleteFile(manager(true), server, 'second'), /stopped/);
  await assert.rejects(() => satisfactory.sessions(server), /Trust the server certificate/);
  assert.strictEqual(satisfactory.status(server).certTrusted, false);
});

test('palworld: parse ShowPlayers, reset with backup, restore', () => {
  const players = palworld.parseShowPlayers('name,playeruid,steamid\nBob,3735928559,76561198000000001\n');
  assert.strictEqual(players[0].guid, 'DEADBEEF' + '0'.repeat(24));
  const dir = tmp('pal');
  const world = 'A'.repeat(32);
  const guid = 'DEADBEEF' + '0'.repeat(24);
  put(dir, `Pal/Saved/SaveGames/0/${world}/Players/${guid}.sav`, 'player');
  put(dir, `Pal/Saved/SaveGames/0/${world}/Players/${guid}_dps.sav`, 'box');
  const server = { id: 's', dir, ports: {} };
  const listed = palworld.describe(server, players);
  assert.strictEqual(listed.worlds[0].players[0].name, 'Bob');
  assert.throws(() => palworld.reset(manager(true), store, server, { guid, confirm: guid }), /stopped/);
  assert.throws(() => palworld.reset(manager(), store, server, { guid, confirm: 'no' }), /confirm/);
  assert.throws(() => palworld.reset(manager(), store, server, { guid: '../x', confirm: '../x' }));
  const out = palworld.reset(manager(), store, server, { guid, confirm: guid, includePalBox: true });
  assert.strictEqual(out.removed.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, `Pal/Saved/SaveGames/0/${world}/Players/${guid}.sav`)));
  const back = palworld.backups(server);
  assert.strictEqual(back.length, 1);
  palworld.restore(manager(), store, server, { world, stamp: back[0].stamp });
  assert.strictEqual(fs.readFileSync(path.join(dir, `Pal/Saved/SaveGames/0/${world}/Players/${guid}.sav`), 'utf8'), 'player');
});

const SECTOR = `<?xml version="1.0"?>
<MyObjectBuilder_Sector xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SectorObjects>
    <MyObjectBuilder_EntityBase xsi:type="MyObjectBuilder_CubeGrid">
      <EntityId>111</EntityId>
      <PositionAndOrientation><Position x="1" y="2" z="3" /></PositionAndOrientation>
      <DisplayName>Mine &amp; Co</DisplayName>
      <CubeBlocks><MyObjectBuilder_CubeBlock xsi:type="MyObjectBuilder_Cockpit"><SubtypeName>A</SubtypeName><Owner>7</Owner></MyObjectBuilder_CubeBlock></CubeBlocks>
    </MyObjectBuilder_EntityBase>
    <MyObjectBuilder_EntityBase xsi:type="MyObjectBuilder_CubeGrid">
      <EntityId>222</EntityId>
      <DisplayName>Active ship &gt; x</DisplayName>
      <CubeBlocks><MyObjectBuilder_CubeBlock xsi:type="MyObjectBuilder_Cockpit"><Owner>8</Owner></MyObjectBuilder_CubeBlock></CubeBlocks>
    </MyObjectBuilder_EntityBase>
    <MyObjectBuilder_EntityBase xsi:type="MyObjectBuilder_CubeGrid">
      <EntityId>333</EntityId>
      <DisplayName>Derelict</DisplayName>
      <CubeBlocks><MyObjectBuilder_CubeBlock xsi:type="MyObjectBuilder_Wall"><Owner>0</Owner></MyObjectBuilder_CubeBlock></CubeBlocks>
    </MyObjectBuilder_EntityBase>
    <MyObjectBuilder_EntityBase xsi:type="MyObjectBuilder_FloatingObject">
      <EntityId>444</EntityId>
      <Item><Amount>5</Amount><PhysicalContent xsi:type="MyObjectBuilder_Ore"><SubtypeName>Stone</SubtypeName></PhysicalContent></Item>
    </MyObjectBuilder_EntityBase>
    <!-- <MyObjectBuilder_EntityBase><EntityId>999</EntityId></MyObjectBuilder_EntityBase> -->
  </SectorObjects>
</MyObjectBuilder_Sector>
`;
const CHECKPOINT = `<?xml version="1.0"?>
<MyObjectBuilder_Checkpoint><Identities>
  <MyObjectBuilder_Identity><IdentityId>7</IdentityId><DisplayName>OldTimer</DisplayName><LastLoginTime>2020-01-01T00:00:00.000</LastLoginTime></MyObjectBuilder_Identity>
  <MyObjectBuilder_Identity><IdentityId>8</IdentityId><DisplayName>Fresh</DisplayName><LastLoginTime>${new Date().toISOString().slice(0, 23)}</LastLoginTime></MyObjectBuilder_Identity>
</Identities></MyObjectBuilder_Checkpoint>`;

test('space engineers: classify grids and floating objects, remove with backup', () => {
  const dir = tmp('se');
  const server = { id: 's', dir };
  put(dir, 'Instance/Saves/World1/SANDBOX_0_0_0_.sbc', SECTOR);
  put(dir, 'Instance/Saves/World1/Sandbox.sbc', CHECKPOINT);
  const scan = se.scan(server, {});
  const by = Object.fromEntries(scan.entities.map((e) => [e.id, e]));
  assert.strictEqual(scan.total, 4);
  assert.ok(by[111].categories.includes('abandoned'));
  assert.strictEqual(by[111].name, 'Mine & Co');
  assert.deepStrictEqual(by[111].position, { x: 1, y: 2, z: 3 });
  assert.ok(!by[222]);
  assert.ok(by[333].categories.includes('unowned'));
  assert.ok(by[444].categories.includes('floating'));
  assert.strictEqual(scan.oldPlayers[0].name, 'OldTimer');
  assert.throws(() => se.remove(manager(true), server, { ids: ['333'] }), /stopped/);
  assert.throws(() => se.remove(manager(), server, { ids: ['1; rm'] }));
  const out = se.remove(manager(), server, { ids: ['333', '444'] });
  assert.strictEqual(out.removed, 2);
  assert.ok(fs.existsSync(path.join(dir, out.backup)));
  const after = fs.readFileSync(path.join(dir, 'Instance/Saves/World1/SANDBOX_0_0_0_.sbc'), 'utf8');
  assert.ok(se.balanced(after));
  assert.ok(!after.includes('Derelict') && after.includes('Active ship') && after.includes('999'));
  assert.strictEqual(se.scan(server, {}).total, 2);
});

test('space engineers: a damaged file is refused, not guessed at', () => {
  assert.throws(() => [...se.tags('<a><b')]);
  assert.strictEqual(se.balanced('<a><b></a></b>'), false);
});

test('game tool routes are scoped to their game and admin-only where dangerous', async () => {
  const dir = tmp('route');
  put(dir, 'SquadGame/ServerConfig/LayerRotation.cfg', 'A_B_C\n');
  const server = { id: 'sq1', name: 'Squad', templateId: 'squad', dir, vars: {}, ports: {} };
  const app = makeApp({ manager: { servers: [server], require: () => server, isActive: () => false, vars: (s) => s.vars } });
  const { call } = load('gametools', app);
  const admin = { username: 'root', role: 'admin' };
  const out = await call('GET', '/api/servers/sq1/gametools/squad', { user: admin });
  assert.strictEqual(out.layers[0].id, 'A_B_C');
  await assert.rejects(() => call('GET', '/api/servers/sq1/gametools/cs2', { user: admin }), /only for cs2/);
  const stranger = { username: 'bob', role: 'user', permissions: {} };
  await assert.rejects(() => call('POST', '/api/servers/sq1/gametools/palworld/reset', { user: stranger, body: {} }), /administrators/);
  await assert.rejects(() => call('PUT', '/api/servers/sq1/gametools/cs2/skins/enabled', { user: stranger, body: {} }), /administrators/);
  await assert.rejects(() => call('GET', '/api/servers/sq1/gametools/space-engineers', { user: stranger }), /administrators/);
});
