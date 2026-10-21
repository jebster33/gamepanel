'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tools = require('../../server/features/rust-tools');
const afk = require('../../server/features/rust-afk');
const teams = require('../../server/features/rust-teams');
const { makeApp, load } = require('./support/routes');

const ID = (n) => String(76561198000000000n + BigInt(n));

test('loot preset changes only the multiplier numbers', () => {
  const cfg = { Generic: { 'Refresh time': 30 }, 'Loot Multipliers': { 'Scrap Multiplier': 1, Barrels: { Good: 1 } }, Other: { 'Some Multiplier': 4 } };
  const changed = tools.applyLoot(cfg, 3);
  assert.deepStrictEqual(cfg.Generic, { 'Refresh time': 30 });
  assert.strictEqual(cfg['Loot Multipliers']['Scrap Multiplier'], 3);
  assert.strictEqual(cfg['Loot Multipliers'].Barrels.Good, 3);
  assert.strictEqual(cfg.Other['Some Multiplier'], 3);
  assert.strictEqual(changed.length, 3);
  assert.throws(() => tools.applyLoot({ a: 1 }, 2), /recognises/);
});

test('stack preset follows categories and falls back to everything', () => {
  const cfg = { 'Category Multipliers': { Ammunition: 1, Food: 1, Weapon: 1 }, 'Global Multiplier': 1 };
  tools.applyStack(cfg, { all: 2, categories: { Food: 10 } });
  assert.deepStrictEqual(cfg['Category Multipliers'], { Ammunition: 2, Food: 10, Weapon: 2 });
  assert.strictEqual(cfg['Global Multiplier'], 2);
});

test('preset requests are validated', () => {
  assert.strictEqual(tools.lootSpec({ preset: '5x' }).multiplier, 5);
  assert.strictEqual(tools.lootSpec({ preset: 'custom', multiplier: '2.5' }).multiplier, 2.5);
  assert.throws(() => tools.lootSpec({ preset: 'custom', multiplier: '0' }), /number/);
  assert.throws(() => tools.lootSpec({ preset: 'custom', multiplier: 'x; quit' }), /number/);
  assert.strictEqual(tools.stackSpec({ preset: '10x' }).all, 10);
  assert.throws(() => tools.stackSpec({ preset: 'custom', categories: { Bogus: 2 } }), /Unknown/);
  assert.throws(() => tools.stackSpec({ preset: 'custom' }), /Pick/);
});

function fakeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const server = { id: 's1', dir, templateId: 'rust', ports: { game: 28015, app: 28082 }, vars: {} };
  const sent = [];
  const manager = {
    store: { save() {}, addEvent() {} },
    vars: () => ({ INSTALL_OXIDE: 'true', HOSTNAME_FULL: 'My Rust', SERVER_DESCRIPTION: 'Hi', WORLD_SEED: 5, WORLD_SIZE: 3500, MAX_PLAYERS: 50, RCON_PASSWORD: 'topsecret', HEADER_IMAGE: 'https://x.test/a.png', GATHER_RATE: '2' }),
    isActive: () => true,
    sendCommand: async (_id, cmd) => sent.push(cmd),
    rt: () => ({ players: 3 }),
    template: () => ({ id: 'rust' }),
  };
  return { server, manager, sent, dir };
}

test('applyPreset needs the plugin config, writes it and reloads the plugin', async () => {
  const { server, manager, sent, dir } = fakeServer();
  await assert.rejects(tools.applyPreset(manager, server, 'loot', tools.lootSpec({ preset: '2x' })), /not made its config/);
  fs.mkdirSync(path.join(dir, 'oxide/config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'oxide/config/BetterLoot.json'), JSON.stringify({ 'Loot Multipliers': { 'Scrap Multiplier': 1 }, Keep: true }));
  const res = await tools.applyPreset(manager, server, 'loot', tools.lootSpec({ preset: '2x' }));
  assert.strictEqual(res.reloaded, true);
  assert.deepStrictEqual(sent, ['oxide.reload BetterLoot']);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'oxide/config/BetterLoot.json'), 'utf8'));
  assert.strictEqual(after['Loot Multipliers']['Scrap Multiplier'], 2);
  assert.strictEqual(after.Keep, true);
  assert.strictEqual(server.rustTools.loot.preset, '2x');
});

test('day and night length go to the console as numbers and are saved as variables', async () => {
  const { server, manager, sent } = fakeServer();
  const res = await tools.setTime(manager, server, { day: '60', night: '5' });
  assert.deepStrictEqual(sent, ['env.daylength 60', 'env.nightlength 5']);
  assert.strictEqual(res.live, true);
  assert.strictEqual(server.vars.DAY_LENGTH, '60');
  await assert.rejects(tools.setTime(manager, server, { day: '7; quit' }), /must be one of/);
  await tools.setTime(manager, server, { preset: 'default' });
  assert.strictEqual(server.vars.DAY_LENGTH, '');
  assert.strictEqual(sent.length, 2);
});

test('AFK: warn, then kick after the warning time; admins are skipped; movement resets', () => {
  const cfg = afk.clean({ enabled: true, afkMinutes: 3, graceSeconds: 60, highPing: false });
  const tracks = new Map();
  const at = (min) => min * 60_000;
  const p = (x = 10) => [
    { id: ID(1), name: 'A', ping: 20, x, z: 0 },
    { id: ID(2), name: 'Admin', ping: 20, x: 5, z: 5 },
  ];
  const exempt = new Set([ID(2)]);
  assert.deepStrictEqual(afk.evaluate(tracks, p(), cfg, at(0), exempt), []);
  assert.deepStrictEqual(afk.evaluate(tracks, p(), cfg, at(2), exempt), []);
  const warn = afk.evaluate(tracks, p(), cfg, at(3), exempt);
  assert.deepStrictEqual(warn.map((a) => [a.id, a.kind, a.why]), [[ID(1), 'warn', 'afk']]);
  assert.deepStrictEqual(afk.evaluate(tracks, p(), cfg, at(3) + 30_000, exempt), []);
  assert.strictEqual(afk.evaluate(tracks, p(), cfg, at(4), exempt)[0].kind, 'kick');
  // moving clears everything
  const t2 = new Map();
  afk.evaluate(t2, p(), cfg, at(0), exempt);
  afk.evaluate(t2, p(), cfg, at(3), exempt);
  assert.deepStrictEqual(afk.evaluate(t2, p(50), cfg, at(4), exempt), []);
});

test('high ping needs several checks in a row', () => {
  const cfg = afk.clean({ afk: false, highPing: true, maxPing: 200, pingChecks: 3, graceSeconds: 20 });
  const tracks = new Map();
  const row = (ping) => [{ id: ID(1), name: 'A', ping, x: null, z: null }];
  assert.deepStrictEqual(afk.evaluate(tracks, row(300), cfg, 0), []);
  assert.deepStrictEqual(afk.evaluate(tracks, row(50), cfg, 20_000), []); // recovered: counter resets
  afk.evaluate(tracks, row(300), cfg, 40_000);
  afk.evaluate(tracks, row(300), cfg, 60_000);
  assert.strictEqual(afk.evaluate(tracks, row(300), cfg, 80_000)[0].kind, 'warn');
  assert.strictEqual(afk.evaluate(tracks, row(300), cfg, 100_000)[0].kind, 'kick');
});

test('AFK settings and the player list are validated and parsed', () => {
  assert.throws(() => afk.clean({ afkMinutes: 1 }), /AFK minutes/);
  assert.throws(() => afk.clean({ ignoreIds: 'abc' }), /17 digits/);
  assert.deepStrictEqual(afk.clean({ ignoreIds: `${ID(1)}, ${ID(1)}` }).ignoreIds, [ID(1)]);
  const rows = afk.parsePlayerList(`[{"SteamID":"${ID(1)}","DisplayName":"Bob","Ping":42},{"SteamID":"bad","DisplayName":"x","Ping":1}]`);
  assert.deepStrictEqual(rows, [{ id: ID(1), name: 'Bob', ping: 42 }]);
  const { server, dir } = fakeServer();
  fs.mkdirSync(path.join(dir, 'server/gamepanel/cfg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server/gamepanel/cfg/users.cfg'), `ownerid ${ID(7)} "Boss" "x"\nmoderatorid ${ID(8)} "Mod" "x"\nbanid ${ID(9)} "bad"\n`);
  assert.deepStrictEqual([...afk.adminIds(server)].sort(), [ID(7), ID(8)]);
});

test('teams join members, online players, bases and clans', () => {
  const clans = teams.parseClans({ clans: { RED: { ownerID: ID(1), members: { [ID(1)]: {}, [ID(2)]: {} } } } });
  assert.deepStrictEqual(clans, [{ tag: 'RED', owner: ID(1), members: [ID(1), ID(2)] }]);
  const out = teams.buildTeams({
    teams: [
      ['10', ID(1), [ID(1), ID(2)]],
      ['11', ID(3), [ID(3)]],
    ],
    players: [{ id: ID(1), name: 'Ann', x: 5, z: 6 }],
    bases: [{ owner: ID(2), name: 'Bo', x: 100, z: 200, members: 3 }],
    clans,
  });
  assert.strictEqual(out.teams[0].id, '10'); // online team first
  assert.strictEqual(out.teams[0].members[1].name, 'Bo');
  assert.strictEqual(out.teams[0].members[0].clan, 'RED');
  assert.strictEqual(out.teams[0].bases.length, 1);
  assert.strictEqual(out.clans[0].bases[0].x, 100);
});

test('entity owners are ranked with a teleport command', () => {
  const out = teams.shapeOwners(
    [
      [ID(1), 'Small', 10, 5, 5, 0, 10, 0],
      [ID(2), 'Big', 2000, 1500, 500, 100.4, 20, -50],
    ],
    [{ id: ID(2) }]
  );
  assert.strictEqual(out[0].name, 'Big');
  assert.strictEqual(out[0].heavy, true);
  assert.strictEqual(out[0].online, true);
  assert.strictEqual(out[0].teleport, 'teleportpos (100,22,-50)');
  assert.strictEqual(out[1].heavy, false);
});

test('the info card carries only public fields', () => {
  const { server, manager } = fakeServer();
  const card = teams.infoCard(manager, server, 'play.example.com');
  assert.strictEqual(card.connect, 'steam://connect/play.example.com:28015');
  assert.strictEqual(card.rustPlusPort, 28082);
  assert.strictEqual(card.seed, 5);
  assert.ok(!JSON.stringify(card).includes('topsecret'));
});

test('the Rust routes refuse other games and validate the kick settings', async () => {
  const { server, manager } = fakeServer();
  const other = { ...server, id: 's2', templateId: 'minecraft-paper' };
  const list = [server, other];
  const app = makeApp({ manager: { ...manager, servers: list, require: (id) => list.find((s) => s.id === id) } });
  const { call } = load('rust-tools', app);
  const admin = { id: 'a', username: 'admin', role: 'admin' };
  const card = await call('GET', '/api/servers/s1/rust-info', { user: admin });
  assert.strictEqual(card.name, 'My Rust');
  await assert.rejects(call('GET', '/api/servers/s2/rust-info', { user: admin }), /only for Rust/);
  const saved = await call('PUT', '/api/servers/s1/rust-tools/afk', { user: admin, body: { enabled: true, afkMinutes: 10 } });
  assert.strictEqual(saved.afk.enabled, true);
  assert.strictEqual(server.rustTools.afk.afkMinutes, 10);
  await assert.rejects(call('PUT', '/api/servers/s1/rust-tools/afk', { user: admin, body: { afkMinutes: 0 } }), /AFK minutes/);
});
