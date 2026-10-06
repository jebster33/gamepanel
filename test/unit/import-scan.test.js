'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scan = require('../../server/features/import-scan');

const templates = { get: (id) => ({ id }) };
function tree(root, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (content === null) fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, content);
  }
}

test('recognises games from their files, a level or two down', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-detect-'));
  tree(root, {
    'paper/paper-1.21.jar': 'x',
    'paper/server.properties': 'server-port=25570\nmax-players=40\nmotd=Hello\n',
    'fabric/fabric-server-launch.jar': 'x',
    'fabric/server.properties': '',
    'forge/libraries/net/minecraftforge': null,
    'forge/run.sh': '',
    'amp/Instance1/Minecraft/server.jar': 'x',
    'amp/Instance1/Minecraft/server.properties': '',
    'rust/RustDedicated': '',
    'valheim/valheim_server.x86_64': '',
    'nothing/readme.txt': '',
  });
  const d = (rel) => scan.detect(path.join(root, rel), templates)?.templateId || null;
  assert.strictEqual(d('paper'), 'minecraft-paper');
  assert.strictEqual(d('fabric'), 'minecraft-fabric');
  assert.strictEqual(d('forge'), 'minecraft-forge');
  assert.strictEqual(d('rust'), 'rust');
  assert.strictEqual(d('valheim'), 'valheim');
  assert.strictEqual(d('nothing'), null);
  const amp = scan.detect(path.join(root, 'amp/Instance1'), templates);
  assert.deepStrictEqual([amp.templateId, path.basename(amp.path)], ['minecraft-vanilla', 'Minecraft']);

  const paper = scan.details(path.join(root, 'paper'), 'minecraft-paper');
  assert.deepStrictEqual(paper.ports, { game: 25570 });
  assert.strictEqual(paper.maxPlayers, 40);
  assert.match(paper.startCommand, /-jar paper-1\.21\.jar nogui$/);
  assert.strictEqual(scan.details(path.join(root, 'forge'), 'minecraft-forge').startCommand, 'bash run.sh nogui');
  fs.rmSync(root, { recursive: true, force: true });
});

test('finds Pterodactyl volumes, AMP instances and LinuxGSM installs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-scan-'));
  const uuid = '3f2c1a4e-1111-2222-3333-444455556666';
  tree(root, {
    [`ptero/${uuid}/server.jar`]: 'x',
    [`ptero/${uuid}/server.properties`]: 'server-port=25601\n',
    [`ptero/${uuid}/spigot.yml`]: '',
    'ptero/not-a-uuid/x': '',
    'amp/instances/Survival01/Minecraft/server.jar': 'x',
    'amp/instances/Survival01/Minecraft/server.properties': 'server-port=25580\n',
    'amp/instances/Survival01/MinecraftModule.kvp': 'Java.MaxHeapSizeMB=6144\n',
    'amp/instances/ADS01/x': '',
    'amp/instances.json': JSON.stringify([{ InstanceName: 'Survival01', FriendlyName: 'Our Survival' }]),
    'home/rust/lgsm/config-lgsm/rustserver/_default.cfg': 'port="28015"\nmaxplayers="50"\nservername="LinuxGSM"\n',
    'home/rust/lgsm/config-lgsm/rustserver/common.cfg': 'maxplayers="100"\n',
    'home/rust/lgsm/config-lgsm/rustserver/rustserver.cfg': 'servername="Weekly Wipe"\n',
    'home/rust/serverfiles/RustDedicated': '',
  });

  const p = scan.scanPterodactyl(templates, [path.join(root, 'ptero')]);
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual([p[0].templateId, p[0].ports.game, p[0].name], ['minecraft-paper', 25601, 'Pterodactyl 3f2c1a4e']);
  assert.strictEqual(scan.details(path.join(root, 'amp/instances/Survival01/Minecraft')).motd, undefined);

  const a = scan.scanAmp(templates, [path.join(root, 'amp/instances')]);
  assert.strictEqual(a.length, 1);
  assert.deepStrictEqual([a[0].name, a[0].templateId, a[0].memory, a[0].ports.game], ['Our Survival', 'minecraft-vanilla', 6144, 25580]);
  assert.ok(a[0].path.endsWith(path.join('Survival01', 'Minecraft')));

  const l = scan.scanLinuxGsm(templates, [path.join(root, 'home/rust')]);
  assert.strictEqual(l.length, 1);
  assert.deepStrictEqual([l[0].name, l[0].templateId, l[0].maxPlayers, l[0].ports.game], ['Weekly Wipe', 'rust', 100, 28015]);
  fs.rmSync(root, { recursive: true, force: true });
});
