'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const vault = require('../../server/features/vault');

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-src-'));
  fs.mkdirSync(path.join(dir, 'world/region'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.gamepanel/downloads'), { recursive: true });
  // 3.5 MiB of random data: four pieces.
  fs.writeFileSync(path.join(dir, 'world/region/r.0.0.mca'), crypto.randomBytes(3.5 * 1024 * 1024));
  fs.writeFileSync(path.join(dir, 'world/level.dat'), 'level');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=hi\n');
  fs.writeFileSync(path.join(dir, '.gamepanel/downloads/big.zip'), 'skip me');
  fs.symlinkSync('server.properties', path.join(dir, 'props-link'));
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel));

test('incremental: the second backup stores only what changed, and both restore exactly', async () => {
  vault.configure({ passphrase: () => null });
  const src = world();
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-bk-'));
  const server = { id: 's', dir: src, templateId: 'minecraft-paper' };

  const first = await vault.create(backups, server, 'auto');
  assert.ok(first.size > 3 * 1024 * 1024);
  assert.strictEqual(first.files, 3);

  // Change one piece of the region file in place.
  const fd = fs.openSync(path.join(src, 'world/region/r.0.0.mca'), 'r+');
  fs.writeSync(fd, Buffer.from('changed!'), 0, 8, 1024 * 1024 + 10);
  fs.closeSync(fd);
  const original = read(src, 'world/region/r.0.0.mca');
  const second = await vault.create(backups, server);
  assert.ok(second.size < 1.2 * 1024 * 1024, `second backup stored ${second.size} bytes`);
  assert.strictEqual(vault.list(backups).length, 2);

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-out-'));
  await vault.restore(backups, second.name, out);
  assert.ok(read(out, 'world/region/r.0.0.mca').equals(original));
  assert.strictEqual(read(out, 'world/level.dat').toString(), 'level');
  assert.strictEqual(fs.readlinkSync(path.join(out, 'props-link')), 'server.properties');
  assert.ok(!fs.existsSync(path.join(out, '.gamepanel/downloads/big.zip')));

  // The first one still has the old bytes.
  const out1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-out-'));
  await vault.restore(backups, first.name, out1);
  assert.ok(!read(out1, 'world/region/r.0.0.mca').equals(original));

  // Single files, browsing, checking.
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-out-'));
  await vault.restore(backups, second.name, out2, ['world/level.dat']);
  assert.deepStrictEqual(fs.readdirSync(path.join(out2, 'world')), ['level.dat']);
  assert.ok(vault.contents(backups, second.name).entries.some((e) => e.path === 'world/region' && e.dir));
  assert.strictEqual((await vault.verify(backups, second.name)).ok, true);

  // Deleting the first frees the piece only it used.
  const before = vault.stats(backups).bytes;
  const { freed } = await vault.remove(backups, first.name);
  assert.ok(freed > 0 && freed < 1.2 * 1024 * 1024);
  assert.ok(vault.stats(backups).bytes < before);
  await vault.restore(backups, second.name, fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-out-')));

  for (const d of [src, backups, out, out1, out2]) fs.rmSync(d, { recursive: true, force: true });
});

test('encrypted: nothing readable at rest, the wrong passphrase is refused, a new one rewraps', async () => {
  let pass = 'correct horse battery staple';
  vault.configure({ passphrase: () => pass });
  const src = world();
  fs.writeFileSync(path.join(src, 'secret.txt'), 'TOP-SECRET-MARKER '.repeat(100));
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-enc-'));
  const server = { id: 's', dir: src };
  const snap = await vault.create(backups, server, '', { encrypt: true });
  assert.strictEqual(snap.encrypted, true);

  // No piece or snapshot contains the plain text or the file names.
  const all = [];
  const scan = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? scan(path.join(d, e.name)) : all.push(fs.readFileSync(path.join(d, e.name)))));
  scan(path.join(backups, '.vault-enc'));
  assert.ok(!all.some((b) => b.includes('TOP-SECRET') || b.includes('level.dat')));

  pass = 'wrong passphrase entirely';
  assert.throws(() => vault.contents(backups, snap.name), /does not open/);

  // Changing the passphrase: the old one must open every vault first.
  assert.throws(() => vault.rewrapAll(path.dirname(backups), 'not it either!!', 'new passphrase 123'), /does not open/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-root-'));
  fs.renameSync(backups, path.join(root, 's'));
  assert.strictEqual(vault.rewrapAll(root, 'correct horse battery staple', 'new passphrase 123'), 1);
  pass = 'new passphrase 123';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-out-'));
  await vault.restore(path.join(root, 's'), snap.name, out);
  assert.strictEqual(read(out, 'secret.txt').toString().slice(0, 10), 'TOP-SECRET');

  // A damaged piece is caught.
  const chunkDir = path.join(root, 's/.vault-enc/chunks');
  const sub = fs.readdirSync(chunkDir)[0];
  const victim = path.join(chunkDir, sub, fs.readdirSync(path.join(chunkDir, sub))[0]);
  const buf = fs.readFileSync(victim);
  buf[buf.length - 1] ^= 0xff;
  fs.writeFileSync(victim, buf);
  await assert.rejects(() => vault.verify(path.join(root, 's'), snap.name));

  for (const d of [src, root, out]) fs.rmSync(d, { recursive: true, force: true });
});

test('restore never writes through a link that points outside', async () => {
  vault.configure({ passphrase: () => null });
  const src = world();
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-bk-'));
  const snap = await vault.create(backups, { id: 's', dir: src });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-tgt-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-vault-outside-'));
  fs.symlinkSync(outside, path.join(target, 'world'));
  await assert.rejects(() => vault.restore(backups, snap.name, target), /link/);
  assert.deepStrictEqual(fs.readdirSync(outside), []);
  for (const d of [src, backups, target, outside]) fs.rmSync(d, { recursive: true, force: true });
});
