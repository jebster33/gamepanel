'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cs2-data-'));

const cs2 = require('../../server/features/gametools/cs2');
const skins = require('../../server/features/gametools/cs2-skins');

const store = { save() {} };
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cs2-'));
  fs.mkdirSync(path.join(dir, 'game/csgo/cfg'), { recursive: true });
  const server = { id: 's1', dir, vars: {}, ports: {} };
  const manager = { isActive: () => false, vars: (s) => s.vars, broadcastServers() {} };
  return { dir, server, manager };
}

test('presets write whitelisted cfg and set game type and mode', () => {
  const { dir, server, manager } = setup();
  const out = cs2.applyPreset(manager, store, server, { preset: 'practice', bots: 3 });
  assert.strictEqual(server.vars.GAME_TYPE, '0');
  assert.strictEqual(server.vars.BOT_QUOTA, '3');
  const cfg = fs.readFileSync(path.join(dir, 'game/csgo/cfg/gamepanel-preset.cfg'), 'utf8');
  assert.match(cfg, /sv_cheats 1/);
  assert.match(cfg, /sv_grenade_trajectory_prac_pipreview 1/);
  assert.match(cfg, /mp_endmatch_votenextmap 1/);
  assert.strictEqual(out.preset, 'practice');
  cs2.applyPreset(manager, store, server, { preset: 'arms_race' });
  assert.strictEqual(server.vars.GAME_TYPE, '1');
  assert.strictEqual(server.vars.GAME_MODE, '0');
  assert.throws(() => cs2.applyPreset(manager, store, server, { preset: 'nope' }));
});

test('no preset turns the skin changer on', () => {
  const { server, manager } = setup();
  for (const id of Object.keys(cs2.PRESETS)) cs2.applyPreset(manager, store, server, { preset: id });
  assert.strictEqual(server.cs2.skinchanger.enabled, false);
  for (const p of Object.values(cs2.PRESETS)) assert.ok(!p.cvars.join(' ').match(/weaponpaints|skin/i));
});

test('map pool writes a map group and validates names', () => {
  const { dir, server, manager } = setup();
  cs2.setPool(manager, store, server, { maps: ['de_dust2', 'de_mirage', 'workshop/123456789/de_cool'] });
  const text = fs.readFileSync(path.join(dir, 'game/csgo/gamemodes_server.txt'), 'utf8');
  assert.match(text, /"de_mirage"/);
  assert.match(text, /workshop\/123456789\/de_cool/);
  assert.strictEqual(server.vars.MAPGROUP, 'mg_gamepanel');
  assert.match(fs.readFileSync(path.join(dir, 'game/csgo/mapcycle.txt'), 'utf8'), /de_dust2\nde_mirage/);
  assert.throws(() => cs2.setPool(manager, store, server, { maps: ['de_dust2', 'x"\n"evil'] }));
  assert.throws(() => cs2.setPool(manager, store, server, { maps: ['de_dust2'] }));
});

test('gameinfo patch is idempotent', () => {
  const text = 'SearchPaths\n{\n\t\tGame\tcsgo\n\t\tGame\tcore\n}\n';
  const a = cs2.patchGameinfo(text);
  assert.ok(a.changed);
  assert.match(a.text, /Game\tcsgo\/addons\/metamod\n\t\tGame\tcsgo\n/);
  assert.strictEqual(cs2.patchGameinfo(a.text).changed, false);
  assert.throws(() => cs2.patchGameinfo('nothing'));
});

test('skin changer is opt-in, validated and sealed', async () => {
  const { dir, server, manager } = setup();
  assert.strictEqual(skins.view(server).enabled, false);
  assert.throws(() => skins.enable(store, server, { enabled: true }, 'a'), /accept the warning/);
  assert.throws(() => skins.enable(store, server, { acknowledge: 'yes' }, 'a'));
  await assert.rejects(() => cs2.installPlugin(manager, server, 'weaponpaints'), /Turn the skin changer on/);
  skins.enable(store, server, { acknowledge: true }, 'admin');
  assert.strictEqual(skins.view(server).enabled, true);
  assert.match(skins.WARNING, /banned/);
  skins.setDb(store, server, { host: '127.0.0.1', port: 3306, user: 'wp', name: 'wp', password: 's3cret' });
  const view = JSON.stringify(skins.view(server));
  assert.ok(!view.includes('s3cret'));
  assert.ok(server.cs2.skinchanger.db.password.startsWith('enc:v1:'));
  assert.throws(() => skins.setDb(store, server, { host: 'a;b', user: 'u', name: 'n' }));
  // Use the bundled list so the test needs no network.
  await skins.pick(store, server, '76561198000000001', { defindex: 7, paint: 282 }, skins.FALLBACK_CATALOG);
  await assert.rejects(() => skins.pick(store, server, '76561198000000001', { defindex: 7, paint: 28123 }, skins.FALLBACK_CATALOG), /not in the catalog/);
  await assert.rejects(() => skins.pick(store, server, "1' OR 1=1", { defindex: 7, paint: 282 }, skins.FALLBACK_CATALOG));
  await skins.pick(store, server, '76561198000000001', { defindex: 507, paint: 415 }, skins.FALLBACK_CATALOG);
  const sql = skins.sql(server);
  assert.match(sql, /VALUES \('76561198000000001', 0, 7, 282, 0\.000001, 0\)/);
  assert.match(sql, /wp_player_knife .* 'weapon_knife_karambit'/);
  skins.writePluginConfig(manager, server);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, skins.PLUGIN_CONFIG), 'utf8'));
  assert.strictEqual(cfg.DatabasePassword, 's3cret');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, skins.CORE_CONFIG), 'utf8')).FollowCS2ServerGuidelines, false);
});

test('catalog normalise keeps guns and knives, drops gloves', () => {
  const items = skins.normalise([
    { weapon: { id: 'weapon_ak47', weapon_id: 7, name: 'AK-47' }, category: { id: 'rifles' }, pattern: { name: 'Redline' }, paint_index: '282', rarity: { color: '#d32ce6' } },
    { weapon: { id: 'leather_handwraps', weapon_id: 5032, name: 'Wraps' }, category: { id: 'sfui_invpanel_filter_gloves' }, paint_index: '10010' },
  ]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].p, 282);
});
