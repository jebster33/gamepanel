'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-arkroute-data-'));
const { makeApp, load } = require('./support/routes');
const clusters = require('../../server/features/ark-clusters');
const mods = require('../../server/features/ark-mods');
const transfers = require('../../server/features/ark-transfers');

const SIDE = process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-arkroute-'));
  const mk = (id, templateId) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    return { id, name: id, templateId, dir, ports: { game: 7777 }, vars: {} };
  };
  const servers = [mk('ase', 'ark-survival-evolved'), mk('asa', 'ark-survival-ascended'), mk('mc', 'minecraft-paper')];
  const sent = [];
  const running = new Set();
  const manager = {
    servers,
    require: (id) => servers.find((s) => s.id === id),
    runtimeFor: () => 'process',
    isActive: (id) => running.has(id),
    rt: () => ({ playerList: ['Alex'] }),
    update: (id, patch) => Object.assign(servers.find((s) => s.id === id).vars, patch.vars),
    sendCommand: async (id, cmd) => {
      sent.push(cmd);
      return { ok: true, response: 'done' };
    },
    logActivity() {},
  };
  const app = makeApp({ manager });
  app.store.addEvent = () => {};
  app.auth.canAccessServer = () => true;
  app.auth.can = () => true;
  return { servers, manager, app, sent, running, route: load('ark', app) };
}
const admin = { role: 'admin', username: 'root' };

test('mod order: ASE writes ActiveMods while stopped, ASA keeps it in MODS for -mods=', () => {
  const t = setup();
  const r = mods.write(t.manager, t.servers[0], ['3', '1', '2'], 'root');
  assert.deepStrictEqual(r.mods.map((m) => m.id), ['3', '1', '2']);
  assert.match(fs.readFileSync(path.join(t.servers[0].dir, `ShooterGame/Saved/Config/${SIDE}/GameUserSettings.ini`), 'utf8'), /ActiveMods=3,1,2/);
  t.running.add('ase');
  assert.throws(() => mods.write(t.manager, t.servers[0], ['1'], 'root'), /Stop the server/);
  mods.write(t.manager, t.servers[1], ['930', '5'], 'root');
  assert.strictEqual(t.servers[1].vars.MODS, '930,5');
  assert.strictEqual(mods.asaArgs('930,5'), '-mods=930,5');
  assert.strictEqual(mods.asaArgs('1;rm -rf /'), '');
  assert.throws(() => mods.cleanIds(['1', '1']), /twice/);
  assert.throws(() => mods.cleanIds(['1', 'x y']), /not a mod ID/);
});

test('ARK routes: only ARK servers, give-item needs an online player', async () => {
  const t = setup();
  await assert.rejects(() => t.route.call('GET', '/api/servers/mc/ark/levels', { user: admin }), /not an ARK server/);
  const lv = await t.route.call('GET', '/api/servers/ase/ark/levels', { user: admin });
  assert.strictEqual(lv.exists, false);
  const preview = await t.route.call('POST', '/api/servers/ase/ark/levels/preview', { user: admin, body: { cap: 120 } });
  assert.strictEqual(preview.ramp.length, 119);
  const put = await t.route.call('PUT', '/api/servers/ase/ark/levels', { user: admin, body: { player: { ramp: preview.ramp } } });
  assert.strictEqual(put.values.player.cap, 120);
  const cr = await t.route.call('PUT', '/api/servers/ase/ark/crates', { user: admin, body: { crates: [] } });
  assert.deepStrictEqual(cr.crates, []);

  const found = await t.route.call('GET', '/api/servers/ase/ark/items', { user: admin, url: new URL('http://x/?q=metal+ingot') });
  const body = { player: 'Alex', playerId: 77, path: found.items[0].path, quantity: 5, tier: 'ascendant' };
  await assert.rejects(() => t.route.call('POST', '/api/servers/ase/ark/give', { user: admin, body }), /Start the server/);
  t.running.add('ase');
  await assert.rejects(() => t.route.call('POST', '/api/servers/ase/ark/give', { user: admin, body: { ...body, player: 'Eve' } }), /not online/);
  const ok = await t.route.call('POST', '/api/servers/ase/ark/give', { user: admin, body });
  assert.strictEqual(ok.sent, true);
  assert.match(t.sent[0], /^GiveItemToPlayer 77 "Blueprint'/);
  await assert.rejects(() => t.route.call('GET', '/api/clusters/x/transfers', { user: { role: 'user' } }), /administrators/);
});

test('transfer log: cluster folder files and transfer lines from the server log', () => {
  const t = setup();
  const store = { state: {}, save() {}, addEvent() {} };
  const c = clusters.create(t.manager, store, { name: 'Main', servers: ['ase'] }, {});
  const dir = clusters.dirOf({ id: c.id });
  fs.writeFileSync(path.join(dir, '76561198000000001'), 'x');
  fs.writeFileSync(path.join(dir, 'dino_0001'), 'y');
  const logs = path.join(t.servers[0].dir, 'ShooterGame/Saved/Logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, 'ShooterGame.log'),
    ['[2025.03.01-10.00.00:001][  1]LogNet: Hello', '[2025.03.01-10.05.00:002][  2]Player Alex uploaded a survivor to the obelisk', '[2025.03.01-10.06.00:002][  2]Workshop download of mod 1 finished'].join('\n')
  );
  const v = transfers.view(t.manager, store, c.id);
  assert.deepStrictEqual(v.files.map((f) => f.kind).sort(), ['Creature', 'Survivor or items']);
  assert.strictEqual(v.lines.length, 1);
  assert.strictEqual(v.lines[0].at, Date.UTC(2025, 2, 1, 10, 5, 0));
  assert.match(v.lines[0].text, /uploaded a survivor/);
  assert.throws(() => transfers.view(t.manager, store, 'nope'), /not found/);
});
