'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ab1-data-'));
const nbt = require('../../server/core/nbt');
const safefs = require('../../server/core/safefs');
const dp = require('../../server/features/datapacks');
const staging = require('../../server/features/staging');
const zip = require('../../server/core/zip');
const nb = require('../../server/features/node-backups');
const { Readable } = require('stream');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ab1-'));
const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

test('NBT: a negative array length is refused (it used to loop forever)', () => {
  // compound { byte-array "a" of length -8 }
  const evil = Buffer.concat([Buffer.from([10, 0, 0, 7, 0, 1, 0x61]), Buffer.from([0xff, 0xff, 0xff, 0xf8]), Buffer.from([0, 0])]);
  assert.throws(() => nbt.parse(evil), /bad NBT array length/);
  assert.throws(() => nbt.read(zlib.gzipSync(evil)), /bad NBT array length/);
  const ints = Buffer.concat([Buffer.from([10, 0, 0, 11, 0, 1, 0x61]), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from([0, 0])]);
  assert.throws(() => nbt.parse(ints), /bad NBT array length/);
});

test('a FIFO or a link where a file should be never blocks or leaks', { skip: process.platform === 'win32' && 'needs symlinks or FIFOs' }, () => {
  const dir = tmp();
  execFileSync('mkfifo', [path.join(dir, 'fifo')]);
  assert.throws(() => safefs.readRegular(path.join(dir, 'fifo')), /not a regular file/);
  put(dir, 'real.txt', 'hello');
  fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'));
  assert.strictEqual(safefs.readText(path.join(dir, 'real.txt')), 'hello');
  assert.throws(() => safefs.readRegular(path.join(dir, 'link.txt')));
  assert.throws(() => safefs.readRegular(path.join(dir, 'real.txt'), 3), /larger/);
  assert.strictEqual(safefs.tailText(path.join(dir, 'fifo')), '');
  assert.strictEqual(safefs.tailText(path.join(dir, 'real.txt'), 3), 'llo');
  assert.throws(() => zip.open(path.join(dir, 'fifo')), /not a regular file/);
});

test('datapacks: the record of installed packs cannot name a path outside the folder', { skip: process.platform === 'win32' && 'needs symlinks or FIFOs' }, async () => {
  const dir = tmp();
  put(dir, '.gamepanel/datapacks.json', JSON.stringify({ '../../../victim': { projectId: 'p1' }, 'sub/x.zip': { projectId: 'p1' }, 'ok.zip': { projectId: 'p1', name: 'Fine' } }));
  fs.mkdirSync(path.join(dir, 'world/datapacks'), { recursive: true });
  put(dir, 'world/datapacks/ok.zip', 'not a zip');
  fs.symlinkSync('/etc/hostname', path.join(dir, 'world/datapacks/evil.zip'));
  const manager = {
    activeWorld: () => 'world',
    template: () => ({ category: 'Minecraft', mods: { dir: 'plugins', loader: 'paper' } }),
    rt: () => ({ status: 'stopped', version: null }),
  };
  const list = dp.list(manager, { id: 's', dir, templateId: 'minecraft-paper', resolvedVersion: '1.21.4' });
  const names = list.packs.map((p) => p.name);
  assert.deepStrictEqual(names, ['ok.zip'], 'links are not packs');
  assert.strictEqual(list.packs[0].title, 'Fine');
});

test('staging: a link in live is never followed by a push', { skip: process.platform === 'win32' && 'needs symlinks or FIFOs' }, async () => {
  const outside = tmp();
  put(outside, 'panel.json', 'precious');
  put(outside, 'sub/secret.key', 'precious');
  const live = { id: 'live', name: 'Live', dir: tmp(), templateId: 'minecraft-paper', vars: {} };
  put(live.dir, 'server.properties', 'server-port=25565\n');
  put(live.dir, 'plugins/A.jar', 'a');
  put(live.dir, 'plugins/Keep/config.yml', 'x: 1');
  const stage = { id: 'stage', name: 'Stage', dir: tmp(), templateId: 'minecraft-paper', vars: {}, stagingOf: 'live' };
  put(stage.dir, 'server.properties', 'server-port=25570\n');
  put(stage.dir, 'plugins/A.jar', 'a2');
  put(stage.dir, 'plugins/Keep/config.yml', 'x: 2');
  put(stage.dir, 'config/new.toml', 'a=1');
  // The game on live replaced "config" with a link to the panel's data, and plugins/Keep with a link too.
  fs.symlinkSync(outside, path.join(live.dir, 'config'));
  fs.rmSync(path.join(live.dir, 'plugins/Keep'), { recursive: true });
  fs.symlinkSync(outside, path.join(live.dir, 'plugins/Keep'));

  const sent = [];
  const manager = {
    servers: [live, stage],
    require: (id) => [live, stage].find((s) => s.id === id),
    isActive: () => false,
    activeWorld: () => 'world',
    setProperties: () => {},
    pushConsole: () => {},
    sendCommand: async (id, c) => sent.push(c),
    stop: async () => {},
    start: async () => {},
  };
  const store = { save() {}, addEvent() {} };
  const d = await staging.diff(manager, 'stage');
  assert.ok(d.skippedLinks.includes('config'), 'the linked folder is skipped and reported');
  assert.ok(!d.entries.some((e) => e.name === 'config'));
  await assert.rejects(staging.push(manager, store, 'stage', { entries: ['config'], properties: false }, {}), /nothing to push/);
  // plugins: a jar is pushed; the file below the linked folder is not written through the link.
  const r = await staging.push(manager, store, 'stage', { entries: ['plugins'], properties: false }, {});
  assert.deepStrictEqual(r.skippedLinks, ['plugins/Keep/config.yml']);
  assert.strictEqual(fs.readFileSync(path.join(live.dir, 'plugins/A.jar'), 'utf8'), 'a2');
  assert.strictEqual(fs.readFileSync(path.join(outside, 'panel.json'), 'utf8'), 'precious');
  assert.ok(!fs.existsSync(path.join(outside, 'config.yml')), 'nothing written through the link');
  assert.ok(fs.existsSync(path.join(outside, 'sub/secret.key')));
});

test('node backups: no overwriting, size required, names that climb out refused', async () => {
  const req = (buf, size = buf.length) => Object.assign(Readable.from([buf]), { headers: size === null ? {} : { 'x-backup-size': String(size) } });
  await nb.receive(req(Buffer.from('one')), 'panelX', 'srv1', 'a.tar.gz');
  await assert.rejects(nb.receive(req(Buffer.from('two')), 'panelX', 'srv1', 'a.tar.gz'), /already here/);
  assert.strictEqual(fs.readFileSync(nb.storeFile('panelX', 'srv1', 'a.tar.gz'), 'utf8'), 'one');
  await assert.rejects(nb.receive(req(Buffer.from('x'), null), 'panelX', 'srv1', 'b.tar.gz'), /X-Backup-Size/);
});
