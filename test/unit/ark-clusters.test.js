'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ark-data-'));
const SIDE = process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer';
const clusters = require('../../server/features/ark-clusters');

function setup({ docker = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ark-'));
  const mk = (id, templateId) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    return { id, name: id, templateId, dir, ports: { game: 7777 } };
  };
  const servers = [mk('island', 'ark-survival-evolved'), mk('center', 'ark-survival-evolved'), mk('asa', 'ark-survival-ascended'), mk('mc', 'minecraft-paper')];
  const manager = { servers, require: (id) => servers.find((s) => s.id === id), runtimeFor: () => (docker ? 'docker' : 'process'), isActive: () => false, rt: () => ({}) };
  const store = { state: {}, save() {}, addEvent() {} };
  return { manager, store, servers };
}

test('a cluster gives its servers one cluster id and folder, and writes transfer limits', () => {
  const t = setup();
  const c = clusters.create(t.manager, t.store, { name: 'Main', servers: ['island', 'center'], options: { downloadDinos: false } }, { username: 'admin' });
  const a = clusters.argsFor(t.manager, t.store, t.servers[0]);
  assert.match(a, /-clusterid=gp\w+ -ClusterDirOverride="[^"]*clusters[\\/]\w+" -NoTransferFromFiltering/);
  assert.equal(a, clusters.argsFor(t.manager, t.store, t.servers[1]));
  assert.equal(clusters.argsFor(t.manager, t.store, t.servers[2]), '');
  const ini = fs.readFileSync(path.join(t.servers[0].dir, `ShooterGame/Saved/Config/${SIDE}/GameUserSettings.ini`), 'utf8');
  assert.match(ini, /\[ServerSettings\]/);
  assert.match(ini, /PreventDownloadDinos=True/);
  assert.match(ini, /PreventUploadDinos=False/);
  clusters.remove(t.manager, t.store, c.id);
  assert.match(fs.readFileSync(path.join(t.servers[0].dir, `ShooterGame/Saved/Config/${SIDE}/GameUserSettings.ini`), 'utf8'), /PreventDownloadDinos=False/);
  assert.equal(clusters.argsFor(t.manager, t.store, t.servers[0]), '');
});

test('in Docker the folder is mounted at a fixed path', () => {
  const t = setup({ docker: true });
  clusters.create(t.manager, t.store, { name: 'D', servers: ['island'] }, {});
  assert.match(clusters.argsFor(t.manager, t.store, t.servers[0]), /-ClusterDirOverride="\/home\/cluster"/);
  assert.equal(clusters.mountFor(t.manager, t.store, t.servers[0]).container, '/home/cluster');
});

test('clusters reject mixed games, other games, other nodes and double membership', () => {
  const t = setup();
  assert.throws(() => clusters.create(t.manager, t.store, { name: 'x', servers: ['island', 'asa'] }, {}), /cannot share/);
  assert.throws(() => clusters.create(t.manager, t.store, { name: 'x', servers: ['mc'] }, {}), /not an ARK server/);
  assert.throws(() => clusters.create(t.manager, t.store, { name: 'x', servers: ['node~1'] }, {}), /another node/);
  clusters.create(t.manager, t.store, { name: 'a', servers: ['island'] }, {});
  assert.throws(() => clusters.create(t.manager, t.store, { name: 'b', servers: ['island'] }, {}), /already in the cluster/);
});
