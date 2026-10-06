'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = path.join(os.tmpdir(), `gp-backups-${process.pid}`);
const backups = require('../../server/features/backups');

test('backups can be browsed and single files put back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-srv-'));
  fs.mkdirSync(path.join(dir, 'plugins', 'Essentials'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=hello\n');
  fs.writeFileSync(path.join(dir, 'plugins', 'Essentials', 'config.yml'), 'a: 1\n');
  const server = { id: `t${process.pid}`, dir };
  const { name } = await backups.create(server);

  const { entries } = await backups.contents(server.id, name);
  const paths = entries.map((e) => e.path);
  assert.ok(paths.includes('server.properties'));
  assert.ok(entries.find((e) => e.path === 'plugins/Essentials' && e.dir));
  assert.strictEqual(entries.find((e) => e.path === 'server.properties').size, 11);

  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=broken\n');
  fs.writeFileSync(path.join(dir, 'plugins', 'Essentials', 'config.yml'), 'a: 2\n');
  await backups.restorePaths(server, name, ['server.properties']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), 'motd=hello\n');
  // Only what was picked comes back.
  assert.strictEqual(fs.readFileSync(path.join(dir, 'plugins', 'Essentials', 'config.yml'), 'utf8'), 'a: 2\n');

  await backups.restorePaths(server, name, ['plugins/Essentials']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'plugins', 'Essentials', 'config.yml'), 'utf8'), 'a: 1\n');

  await assert.rejects(backups.restorePaths(server, name, ['../outside']), /Invalid path/);
  await assert.rejects(backups.restorePaths(server, name, ['nope.txt']), /not in this backup/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a backup check restores it into a scratch folder, and catches a broken one', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { config } = require('../../server/core/config');
  const backups = require('../../server/features/backups');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-verify-'));
  Object.assign(config, { backupsDir: path.join(root, 'b'), cacheDir: path.join(root, 'c') });
  const server = { id: 'v1', templateId: 'minecraft-paper', dir: path.join(root, 'srv') };
  fs.mkdirSync(path.join(server.dir, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, 'world', 'level.dat'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(server.dir, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(50_000, 7));
  const made = await backups.create(server);
  const good = await backups.verify(server, made.name);
  assert.ok(good.ok, good.error);
  assert.strictEqual(good.files, 2);
  assert.strictEqual(backups.checks('v1')[made.name].ok, true);
  // Cut the archive short: the check must notice.
  const file = path.join(config.backupsDir, 'v1', made.name);
  fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
  const bad = await backups.verify(server, made.name);
  assert.strictEqual(bad.ok, false);
});
