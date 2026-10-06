'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rp-data-'));
const backups = require('../../server/features/backups');
const rp = require('../../server/features/restore-preview');

test('preview shows what a restore changes; exact restore removes what was added since', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-rp-srv-'));
  const server = { id: 'rp-test', name: 'RP', dir, templateId: 'minecraft-paper' };
  const manager = { isActive: () => false };
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('server.properties', 'motd=Old\nmax-players=20\nrcon.password=hunter2\n');
  put('plugins/Essentials.jar', 'jar');
  put('world/level.dat', 'level');
  put('world/region/r.0.0.mca', 'region-a');
  put('.gamepanel/notes.json', '{}');
  const backup = await backups.create(server, '');

  put('server.properties', 'motd=New one\nmax-players=20\nrcon.password=other\npvp=false\n');
  fs.rmSync(path.join(dir, 'plugins/Essentials.jar'));
  put('plugins/Broken.jar', 'jar');
  put('plugins/Broken/config.yml', 'x: 1');
  put('world/region/r.0.0.mca', 'region-b-longer');
  put('.gamepanel/notes.json', '{"a":1}');

  const p = await rp.preview(manager, server, backup.name);
  assert.deepStrictEqual(p.counts, { comeBack: 1, changed: 2, addedSince: 2, same: 1 });
  assert.deepStrictEqual(p.jars.plugins, { comeBack: ['Essentials.jar'], addedSince: ['Broken.jar'] });
  const keys = Object.fromEntries(p.properties.map((x) => [x.key, [x.now, x.then]]));
  assert.deepStrictEqual(keys, { motd: ['New one', 'Old'], pvp: ['false', null] }); // passwords never shown
  assert.ok(!p.addedSince.some((f) => f.path.startsWith('.gamepanel')));
  assert.strictEqual(p.areas.find((a) => a.area === 'plugins').addedSince, 2);

  const r = await rp.restore(manager, server, backup.name, { backupFirst: true, exact: true });
  assert.strictEqual(r.removed, 2);
  assert.ok(r.safety && backups.list(server.id).some((b) => b.name === r.safety));
  assert.ok(fs.existsSync(path.join(dir, 'plugins/Essentials.jar')));
  assert.ok(!fs.existsSync(path.join(dir, 'plugins/Broken.jar')));
  assert.ok(!fs.existsSync(path.join(dir, 'plugins/Broken')), 'empty folder left behind');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'world/region/r.0.0.mca'), 'utf8'), 'region-a');
  assert.ok(fs.existsSync(path.join(dir, '.gamepanel/notes.json')), 'panel files are never removed');

  const again = await rp.preview(manager, server, backup.name);
  assert.deepStrictEqual([again.counts.comeBack, again.counts.addedSince], [0, 0]);
  await assert.rejects(rp.restore({ isActive: () => true }, server, backup.name), /Stop the server/);
});
