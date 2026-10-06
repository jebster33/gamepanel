'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const zip = require('../../server/core/zip');
const c = require('../../server/features/mods/conflicts');

const fabricMod = (id, extra = {}) => zip.build({ 'fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, name: id, version: '1.0.0', environment: '*', ...extra }) });

function server(loader, gameVersion, jars) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mods-'));
  fs.mkdirSync(path.join(dir, 'mods'));
  for (const [name, buf] of Object.entries(jars)) fs.writeFileSync(path.join(dir, 'mods', name), buf);
  return { id: 'm', dir, loader, gameVersion, vars: {} };
}
const template = { id: 'minecraft-fabric', category: 'Minecraft', mods: { dir: 'mods' } };

test('version ranges: Fabric and Maven', () => {
  assert.ok(c.fabricSatisfies('1.20.1', '~1.20'));
  assert.ok(!c.fabricSatisfies('1.21', '~1.20'));
  assert.ok(c.fabricSatisfies('1.20.4', '1.20.x'));
  assert.ok(c.fabricSatisfies('1.20.4', ['1.19.x', '>=1.20 <1.21']));
  assert.ok(!c.fabricSatisfies('1.21.1', '>=1.20 <1.21'));
  assert.ok(c.fabricSatisfies('0.92.2+1.20.1', '>=0.90'));
  assert.ok(c.mavenSatisfies('1.20.1', '[1.20.1,1.21)'));
  assert.ok(!c.mavenSatisfies('1.21', '[1.20.1,1.21)'));
  assert.ok(c.mavenSatisfies('47.2.0', '[47,)'));
  assert.ok(c.mavenSatisfies('1.20.1-2.3.4', '[2.3,)'));
  assert.ok(c.mavenSatisfies('anything', '1.0')); // a bare version is a soft requirement
});

test('the zip reader reads stored and deflated entries', () => {
  const plain = zip.build({ 'a.txt': 'hello' });
  assert.strictEqual(zip.open(plain).read('a.txt').toString(), 'hello');
  const packed = zip.build({ 'b.txt': 'hi there hi there', 'dir/c.txt': 'x' }, { deflate: true });
  const z = zip.open(packed);
  assert.deepStrictEqual(z.names, ['b.txt', 'dir/c.txt']);
  assert.strictEqual(z.read('b.txt').toString(), 'hi there hi there');
  assert.strictEqual(z.read('missing'), null);
  assert.throws(() => zip.open(Buffer.from('not a zip at all')), /not a zip/);
});

test('finds wrong loader, missing and broken dependencies, wrong Minecraft, duplicates and client mods', () => {
  const s = server('fabric', '1.20.1', {
    'good.jar': fabricMod('good', { depends: { minecraft: '~1.20', fabricloader: '>=0.14', 'fabric-api': '*' } }),
    'fabric-api.jar': zip.build({
      'fabric.mod.json': JSON.stringify({ id: 'fabric-api', version: '0.92.2+1.20.1', provides: ['fabric'], jars: [{ file: 'META-INF/jars/base.jar' }] }),
      'META-INF/jars/base.jar': fabricMod('fabric-api-base'),
    }),
    'needs-base.jar': fabricMod('needsbase', { depends: { 'fabric-api-base': '*', fabric: '*' } }),
    'old.jar': fabricMod('oldmod', { depends: { minecraft: '1.19.2' } }),
    'lonely.jar': fabricMod('lonely', { depends: { cloth_config: '>=11' } }),
    'breaker.jar': fabricMod('breaker', { breaks: { good: '*' } }),
    'minimap.jar': fabricMod('minimap', { environment: 'client' }),
    'dup-1.jar': fabricMod('dup'),
    'dup-2.jar': fabricMod('dup'),
    'forge-only.jar': zip.build({ 'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="jei"\nversion="1"\n[[dependencies.jei]]\nmodId="forge"\nmandatory=true\nversionRange="[47,)"\n' }),
    'plugin.jar': zip.build({ 'plugin.yml': 'name: Essentials\nversion: 2\nmain: x\n' }),
    'notzip.jar': Buffer.from('nope'),
  });
  const r = c.check(s, template);
  assert.ok(r.supported);
  const about = (file) => r.issues.filter((i) => i.file === file).map((i) => i.message).join(' | ');
  assert.strictEqual(about('good.jar'), '');
  assert.strictEqual(about('needs-base.jar'), '');
  assert.strictEqual(about('fabric-api.jar'), '');
  assert.match(about('old.jar'), /Minecraft 1\.19\.2; this server runs 1\.20\.1/);
  assert.match(about('lonely.jar'), /needs cloth_config, which is not installed/);
  assert.match(about('breaker.jar'), /does not work together with good/);
  assert.match(about('minimap.jar'), /client-side/);
  assert.match(r.issues.map((i) => i.message).join(' '), /dup is installed twice/);
  assert.match(about('forge-only.jar'), /made for Forge/);
  assert.match(about('plugin.jar'), /made for Bukkit/);
  assert.match(about('notzip.jar'), /not a working jar/);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('Forge mods.toml dependencies and Paper plugins', () => {
  const toml = `modLoader="javafml"
loaderVersion="[47,)"
[[mods]]
modId="create"
version="\${file.jarVersion}"
displayName="Create"
description='''
A mod. [[not a table]]
'''
[[dependencies.create]]
    modId="forge"
    mandatory=true
    versionRange="[47.1.3,)"
[[dependencies.create]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20.1,1.20.2)"
[[dependencies.create]]
    modId="flywheel"
    mandatory=true
    versionRange="[0.6.10,0.6.11)"
`;
  const s = server('forge', '1.20.1', {
    'create.jar': zip.build({ 'META-INF/mods.toml': toml, 'META-INF/MANIFEST.MF': 'Implementation-Version: 0.5.1.f\n' }),
    'flywheel.jar': zip.build({ 'META-INF/mods.toml': '[[mods]]\nmodId="flywheel"\nversion="0.6.9"\n' }),
  });
  const r = c.check(s, { ...template, id: 'minecraft-forge' });
  assert.strictEqual(r.issues.length, 1, JSON.stringify(r.issues));
  assert.match(r.issues[0].message, /needs flywheel \[0\.6\.10,0\.6\.11\); 0\.6\.9 is installed/);
  fs.rmSync(s.dir, { recursive: true, force: true });

  const p = server('paper', '1.20.4', {
    'a.jar': zip.build({ 'plugin.yml': 'name: Shop\nversion: 1\napi-version: "1.21"\ndepend:\n  - Vault\n' }),
    'b.jar': zip.build({ 'paper-plugin.yml': 'name: Fancy\nversion: 1\napi-version: 1.20\ndependencies:\n  server:\n    LuckPerms:\n      load: BEFORE\n      required: true\n    Optional:\n      required: false\n' }),
  });
  const rp = c.check(p, { ...template, id: 'minecraft-paper', mods: { dir: 'mods' } });
  const text = rp.issues.map((i) => i.message).join(' | ');
  assert.match(text, /Shop needs Minecraft 1\.21 or newer/);
  assert.match(text, /Shop needs vault/);
  assert.match(text, /Fancy needs luckperms/);
  assert.doesNotMatch(text, /optional/i);
  fs.rmSync(p.dir, { recursive: true, force: true });
});

test('games other than Minecraft are not checked', () => {
  const r = c.check({ id: 'r', dir: os.tmpdir(), vars: {} }, { id: 'rust', mods: { dir: 'oxide/plugins' } });
  assert.strictEqual(r.supported, false);
});
