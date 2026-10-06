'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-stg-data-'));
const staging = require('../../server/features/staging');

function put(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

function fakeManager(servers) {
  const sent = [];
  let active = new Set();
  const m = {
    sent,
    servers,
    require: (id) => servers.find((s) => s.id === id) || (() => { throw new Error('no server'); })(),
    isActive: (id) => active.has(id),
    setActive: (id, on) => (on ? active.add(id) : active.delete(id)),
    sendCommand: async (id, cmd) => sent.push(cmd),
    stop: async (id) => { sent.push(`stop ${id}`); active.delete(id); },
    start: async (id) => { sent.push(`start ${id}`); active.add(id); },
    activeWorld: () => 'world',
    setProperties: (server, values) => {
      const file = path.join(server.dir, 'server.properties');
      let text = fs.readFileSync(file, 'utf8');
      for (const [k, v] of Object.entries(values)) text = text.match(new RegExp(`^${k}=`, 'm')) ? text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${text}${k}=${v}\n`;
      fs.writeFileSync(file, text);
    },
    pushConsole: () => {},
    broadcastServers: () => {},
    publicServer: (s) => s,
    create: (input) => {
      const copy = { ...input, id: 'stage', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gp-stg-copy-')), ports: { game: 25570 } };
      fs.rmSync(copy.dir, { recursive: true });
      servers.push(copy);
      return copy;
    },
  };
  return m;
}

test('make a staging copy, change it, and push only the chosen parts to live', async () => {
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-stg-live-'));
  put(liveDir, 'server.properties', 'server-port=25565\nmotd=Live\nview-distance=10\npvp=true\n');
  put(liveDir, 'plugins/Old.jar', 'old');
  put(liveDir, 'plugins/Keep.jar', 'keep');
  put(liveDir, 'plugins/Keep/config.yml', 'a: 1');
  put(liveDir, 'plugins/Keep/data.db', 'live-data');
  put(liveDir, 'world/level.dat', 'level');
  put(liveDir, 'world/region/r.0.0.mca', 'live-region');
  put(liveDir, 'whitelist.json', '["live"]');
  put(liveDir, 'server.jar', 'paper-1');
  const live = { id: 'live', name: 'Live', dir: liveDir, templateId: 'minecraft-paper', vars: { MC_VERSION: '1.21.4', RCON_PASSWORD: 'x' }, resolvedVersion: '1.21.4' };
  const store = { save: () => {}, addEvent: () => {} };
  const manager = fakeManager([live]);
  manager.setActive('live', true);

  const { server: stage } = await staging.create(manager, store, 'live', { withWorld: true }, { username: 'admin' });
  assert.strictEqual(stage.stagingOf, 'live');
  assert.deepStrictEqual(manager.sent, ['save-off', 'save-all flush', 'save-on'], 'live keeps running; saving pauses while the world is copied');
  assert.strictEqual(read(stage.dir, 'world/region/r.0.0.mca'), 'live-region');
  await assert.rejects(staging.create(manager, store, 'live', {}, { username: 'admin' }), /already has a staging copy/);

  // Changes on staging: a plugin update, a removed plugin, a config change, a property, a world edit, a whitelist edit and a new jar.
  fs.rmSync(path.join(stage.dir, 'plugins/Old.jar'));
  put(stage.dir, 'plugins/New.jar', 'new');
  put(stage.dir, 'plugins/Keep/config.yml', 'a: 2');
  put(stage.dir, 'plugins/Keep/data.db', 'staging-data');
  put(liveDir, 'plugins/Keep/cache/new.tmp', 'made on live after the copy');
  put(stage.dir, 'server.properties', 'server-port=25570\nmotd=Staging\nview-distance=8\npvp=false\n');
  put(stage.dir, 'world/region/r.0.0.mca', 'staging-region');
  put(stage.dir, 'whitelist.json', '["tester"]');
  put(stage.dir, 'server.jar', 'paper-2');
  stage.vars = { ...stage.vars, MC_VERSION: '1.21.5' };
  stage.resolvedVersion = '1.21.5';

  const d = await staging.diff(manager, 'stage');
  const byName = Object.fromEntries(d.entries.map((e) => [e.name, e]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['plugins', 'world']);
  assert.deepStrictEqual([byName.plugins.added, byName.plugins.changed, byName.plugins.removed, byName.plugins.push], [1, 1, 1, true]);
  assert.strictEqual(byName.world.push, false);
  assert.deepStrictEqual(d.properties.map((p) => p.key).sort(), ['pvp', 'view-distance']);
  assert.ok(d.version.settings.some((v) => v.key === 'MC_VERSION'));
  assert.ok(!d.version.settings.some((v) => v.key === 'RCON_PASSWORD'));
  assert.deepStrictEqual(d.version.files, ['server.jar']);

  manager.sent.length = 0;
  const r = await staging.push(manager, store, 'stage', { entries: ['plugins'], properties: true, version: false }, { username: 'admin' });
  assert.deepStrictEqual(r.pushed, ['plugins', 'server.properties']);
  assert.ok(r.backup && r.restarted);
  assert.deepStrictEqual(manager.sent, ['stop live', 'start live']);
  assert.ok(!fs.existsSync(path.join(liveDir, 'plugins/Old.jar')));
  assert.strictEqual(read(liveDir, 'plugins/New.jar'), 'new');
  assert.strictEqual(read(liveDir, 'plugins/Keep/config.yml'), 'a: 2');
  assert.strictEqual(read(liveDir, 'plugins/Keep/data.db'), 'live-data', "live's plugin data stays");
  assert.ok(fs.existsSync(path.join(liveDir, 'plugins/Keep/cache/new.tmp')));
  const props = read(liveDir, 'server.properties');
  assert.match(props, /server-port=25565/);
  assert.match(props, /motd=Live/);
  assert.match(props, /view-distance=8/);
  assert.match(props, /pvp=false/);
  assert.strictEqual(read(liveDir, 'world/region/r.0.0.mca'), 'live-region', 'the world stays');
  assert.strictEqual(read(liveDir, 'whitelist.json'), '["live"]', 'player lists stay');
  assert.strictEqual(read(liveDir, 'server.jar'), 'paper-1');

  await staging.push(manager, store, 'stage', { entries: [], properties: false, version: true }, { username: 'admin' });
  assert.strictEqual(read(liveDir, 'server.jar'), 'paper-2');
  assert.strictEqual(live.vars.MC_VERSION, '1.21.5');
  assert.strictEqual(live.vars.RCON_PASSWORD, 'x');
  assert.strictEqual(live.resolvedVersion, '1.21.5');
  await assert.rejects(staging.push(manager, store, 'stage', { entries: ['nope'] }, {}), /nothing to push/);
  await assert.rejects(staging.diff(manager, 'live'), /not a staging copy/);
});
