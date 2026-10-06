'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-fsec-data-'));
const files = require('../../server/features/files');
const zip = require('../../server/core/zip');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-fsec-'));

test('compress: a file named like a tar option is a name, never an option', async () => {
  const root = tmp();
  const marker = path.join(root, 'PWNED');
  const evil = '--checkpoint-action=exec=touch PWNED';
  fs.writeFileSync(path.join(root, evil), 'x');
  fs.writeFileSync(path.join(root, '--checkpoint=1'), 'x');
  fs.writeFileSync(path.join(root, 'plain.txt'), 'hi');
  const r = await files.compress(root, ['--checkpoint=1', evil, 'plain.txt'], 'bundle');
  assert.ok(!fs.existsSync(marker), 'no command ran');
  const listing = execFileSync('tar', ['-tzf', path.join(root, r.name)], { encoding: 'utf8' });
  assert.match(listing, /plain\.txt/);
  assert.match(listing, /--checkpoint=1/);
});

test('extract: an archive whose name starts with "-" is just a name', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '-d.zip'), zip.build({ 'a.txt': 'A' }, { deflate: true }));
  await files.extract(root, '-d.zip');
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'A');
});

test('extract: never writes through a symlink that is already in the server folder', { skip: process.platform === 'win32' && 'needs symlinks or FIFOs' }, async () => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret.json'), 'original');
  fs.symlinkSync(outside, path.join(root, 'cfg'));
  fs.writeFileSync(path.join(root, 'up.zip'), zip.build({ 'cfg/secret.json': 'OVERWRITTEN', 'cfg/new.txt': 'planted', 'fine/ok.txt': 'ok' }, { deflate: true }));
  await assert.rejects(files.extract(root, 'up.zip'), /link/);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.json'), 'utf8'), 'original');
  assert.ok(!fs.existsSync(path.join(outside, 'new.txt')));

  // A symlink standing where a file goes is replaced, not followed.
  const root2 = tmp();
  fs.writeFileSync(path.join(outside, 'target.txt'), 'original');
  fs.symlinkSync(path.join(outside, 'target.txt'), path.join(root2, 'config.txt'));
  fs.writeFileSync(path.join(root2, 'up.zip'), zip.build({ 'config.txt': 'NEW' }, { deflate: true }));
  await files.extract(root2, 'up.zip');
  assert.strictEqual(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'original');
  assert.strictEqual(fs.readFileSync(path.join(root2, 'config.txt'), 'utf8'), 'NEW');
  assert.ok(!fs.lstatSync(path.join(root2, 'config.txt')).isSymbolicLink());
});

test('extract: normal unpacking still works, nested folders and overwrites included', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'mods'));
  fs.writeFileSync(path.join(root, 'mods', 'old.jar'), 'old');
  fs.writeFileSync(path.join(root, 'pack.zip'), zip.build({ 'mods/new.jar': 'new', 'mods/old.jar': 'updated', 'config/a/b.toml': 'x=1' }, { deflate: true }));
  await files.extract(root, 'pack.zip');
  assert.strictEqual(fs.readFileSync(path.join(root, 'mods/old.jar'), 'utf8'), 'updated');
  assert.strictEqual(fs.readFileSync(path.join(root, 'mods/new.jar'), 'utf8'), 'new');
  assert.strictEqual(fs.readFileSync(path.join(root, 'config/a/b.toml'), 'utf8'), 'x=1');
  const tgz = path.join(root, 'out.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', root, 'config']);
  fs.rmSync(path.join(root, 'config'), { recursive: true });
  await files.extract(root, 'out.tar.gz');
  assert.strictEqual(fs.readFileSync(path.join(root, 'config/a/b.toml'), 'utf8'), 'x=1');
});
