'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ext-'));
const { Extensions, validateManifest, hookMatches, BUILTIN_DIR } = require('../../server/features/extensions');
const { readZip, writeZip, safeEntryPath } = require('../../server/features/zip');
const { Store } = require('../../server/core/store');

const good = { name: 'my-theme', title: 'My theme', version: '1.0.0', themes: [{ id: 'mine', name: 'Mine', mode: 'dark', vars: { '--bg': '#000', '--lime': 'rgba(1,2,3,0.5)' } }] };

test('a valid manifest passes and unknown fields are dropped', () => {
  const { errors, manifest } = validateManifest({ ...good, evil: 1 });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(manifest.evil, undefined);
  assert.strictEqual(manifest.themes[0].vars['--bg'], '#000');
});

test('bad manifests are refused with a reason', () => {
  const bad = (patch) => validateManifest({ ...good, ...patch }).errors.length > 0;
  assert.ok(bad({ name: '../x' }));
  assert.ok(bad({ version: '' }));
  assert.ok(bad({ themes: [{ id: 'a', mode: 'dark', vars: { '--bg': 'red; } body { display:none' } }] }));
  assert.ok(bad({ themes: [{ id: 'a', mode: 'dark', vars: { '--bg': 'url(https://evil/x.png)' } }] }));
  assert.ok(bad({ themes: [{ id: 'a', mode: 'dark', vars: { color: 'red' } }] }));
  assert.ok(bad({ themes: [{ id: 'a', mode: 'purple', vars: {} }] }));
  assert.ok(bad({ themes: [], pages: [{ id: 'p', entry: '../../etc/passwd.html' }] }));
  assert.ok(bad({ themes: [], hooks: [{ event: 'server.crashed', url: 'ftp://x' }] }));
  assert.ok(bad({ themes: [], main: '/abs/server.js' }));
  assert.ok(bad({ themes: [] })); // provides nothing
});

test('hook patterns', () => {
  assert.ok(hookMatches('*', 'a.b'));
  assert.ok(hookMatches('backup.*', 'backup.failed'));
  assert.ok(!hookMatches('backup.*', 'server.crashed'));
  assert.ok(hookMatches('server.crashed', 'server.crashed'));
});

test('zip entry paths are checked', () => {
  for (const evil of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'con.txt', 'a/\0b', '']) assert.strictEqual(safeEntryPath(evil), null, evil);
  assert.strictEqual(safeEntryPath('a/./b.css'), 'a/b.css');
});

test('zips with unsafe or oversized contents are refused', () => {
  assert.throws(() => readZip(writeZip({ '../evil.txt': 'x' })), /Unsafe path/);
  assert.throws(() => readZip(writeZip({ 'link.css': 'x' }, { 'link.css': 0o120777 })), /link/);
  assert.throws(() => readZip(Buffer.from('not a zip at all, really not')), /not a zip/);
  assert.throws(() => readZip(writeZip({ 'a.txt': 'x'.repeat(100) }), { files: 10, fileBytes: 50, totalBytes: 1000 }), /too large/);
  assert.deepStrictEqual(readZip(writeZip({ 'a/b.txt': 'hi' })).map((f) => [f.path, f.data.toString()]), [['a/b.txt', 'hi']]);
});

test('installing from a zip writes only inside the extensions folder, and removing works', () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ext-user-'));
  const store = new Store(null);
  const ext = new Extensions(store, { userDir });
  const files = { 'pack/manifest.json': JSON.stringify({ ...good, name: 'zipped', themes: [], pages: [{ id: 'p', entry: 'page.html' }] }), 'pack/page.html': '<p>hi</p>' };
  const m = ext.installZip(writeZip(files));
  assert.strictEqual(m.name, 'zipped');
  assert.ok(fs.existsSync(path.join(userDir, 'zipped', 'page.html')));
  assert.ok(ext.fileFor('zipped', 'page.html'));
  assert.strictEqual(ext.fileFor('zipped', '../manifest.json'), null);
  assert.strictEqual(ext.fileFor('zipped', 'manifest.json'), fs.realpathSync(path.join(userDir, 'zipped', 'manifest.json')));
  // Missing file the manifest names, built-in name clash, disallowed type.
  assert.throws(() => ext.installZip(writeZip({ 'manifest.json': files['pack/manifest.json'] })), /not in the zip/);
  assert.throws(() => ext.installZip(writeZip({ 'manifest.json': JSON.stringify({ ...good, name: 'theme-nord' }) })), /built-in/);
  assert.throws(() => ext.installZip(writeZip({ 'manifest.json': JSON.stringify(good), 'run.exe': 'x' })), /not allowed/);
  ext.setEnabled('zipped', false);
  assert.strictEqual(ext.fileFor('zipped', 'page.html'), null);
  ext.remove('zipped');
  assert.ok(!fs.existsSync(path.join(userDir, 'zipped')));
  assert.throws(() => ext.remove('theme-nord'), /Built-in/);
  assert.deepStrictEqual(fs.readdirSync(userDir), []);
});

test('the built-in themes load and produce scoped CSS', () => {
  const ext = new Extensions(new Store(null), { userDir: path.join(os.tmpdir(), 'gp-none') });
  const view = ext.publicView({ role: 'admin' });
  assert.ok(fs.existsSync(BUILTIN_DIR));
  assert.ok(view.themes.length >= 10);
  for (const name of ['Midnight blue', 'Solarized dark', 'Solarized light', 'Dracula', 'Nord', 'Rust orange', 'Forest green', 'High contrast', 'Paper light', 'Control room']) assert.ok(view.themes.some((t) => t.name === name), name);
  const t = ext.theme('theme-solarized-light/solarized-light');
  assert.strictEqual(t.mode, 'light');
  assert.match(t.css, /^:root\[data-ext-theme="theme-solarized-light\/solarized-light"\]\[data-theme\]\{/);
  assert.strictEqual(ext.theme('nope/nope'), null);
});

test('code extensions stay off unless allowed', () => {
  const store = new Store(null);
  const ext = new Extensions(store, { userDir: path.join(os.tmpdir(), 'gp-none') });
  assert.strictEqual(ext.settings.allowCode, false);
  ext.startCode({ manager: { servers: [] } });
  assert.deepStrictEqual(ext.codeLoaded, []);
});
