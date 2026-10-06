'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-net-data-'));
const networks = require('../../server/features/networks');

function setup({ docker = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-net-'));
  const mk = (id, templateId, port) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    return { id, name: id, templateId, dir, ports: { game: port } };
  };
  const proxy = mk('proxy', 'minecraft-velocity', 25577);
  const lobby = mk('lobby', 'minecraft-paper', 25601);
  const smp = mk('smp', 'minecraft-purpur', 25602);
  const fabric = mk('fab', 'minecraft-fabric', 25603);
  fs.writeFileSync(path.join(proxy.dir, 'velocity.toml'), 'bind = "0.0.0.0:25577"\nplayer-info-forwarding-mode = "none"\n\n[servers]\nlobby = "127.0.0.1:30066"\ntry = ["lobby"]\n\n[forced-hosts]\n"lobby.example.com" = ["lobby"]\n');
  fs.writeFileSync(path.join(lobby.dir, 'server.properties'), 'online-mode=true\nmotd=Lobby\n');
  fs.mkdirSync(path.join(lobby.dir, 'config'));
  fs.writeFileSync(path.join(lobby.dir, 'config/paper-global.yml'), "proxies:\n  bungee-cord:\n    online-mode: true\n  velocity:\n    enabled: false\n    online-mode: false\n    secret: ''\nscoreboards:\n  x: 1\n");
  const servers = [proxy, lobby, smp, fabric];
  const manager = {
    servers,
    require: (id) => servers.find((s) => s.id === id),
    runtimeFor: () => (docker ? 'docker' : 'process'),
    isActive: () => false,
    rt: () => ({}),
    template: () => ({}),
    writeConfigFiles() {},
  };
  const store = { state: {}, save() {}, addEvent() {} };
  return { root, manager, store, proxy, lobby, smp, fabric };
}

test('a network writes both ends of modern forwarding', () => {
  const t = setup();
  networks.create(t.manager, t.store, { name: 'Main', proxyId: 'proxy', servers: [{ serverId: 'lobby', name: 'lobby' }, { serverId: 'smp', name: 'survival' }] }, { username: 'admin' });
  const toml = fs.readFileSync(path.join(t.proxy.dir, 'velocity.toml'), 'utf8');
  assert.match(toml, /player-info-forwarding-mode = "modern"/);
  assert.match(toml, /lobby = "127\.0\.0\.1:25601"/);
  assert.match(toml, /survival = "127\.0\.0\.1:25602"/);
  assert.match(toml, /try = \["lobby"\]/);
  assert.ok(!toml.includes('30066'));
  assert.match(toml, /\[forced-hosts\]\n"lobby\.example\.com"/); // the next table is left alone
  const secret = fs.readFileSync(path.join(t.proxy.dir, 'forwarding.secret'), 'utf8');
  assert.ok(secret.length >= 24);

  assert.match(fs.readFileSync(path.join(t.lobby.dir, 'server.properties'), 'utf8'), /online-mode=false/);
  const paper = fs.readFileSync(path.join(t.lobby.dir, 'config/paper-global.yml'), 'utf8');
  assert.match(paper, /velocity:\n {4}enabled: true\n {4}online-mode: true\n {4}secret: '?[\w-]+'?/);
  assert.ok(paper.includes(secret));
  assert.match(paper, /bungee-cord:\n {4}online-mode: true/);
  // A server that never started gets a minimal file Paper fills in.
  assert.match(fs.readFileSync(path.join(t.smp.dir, 'config/paper-global.yml'), 'utf8'), /enabled: true/);

  // Taking a server out puts it back to normal.
  const id = t.store.state.networks[0].id;
  networks.update(t.manager, t.store, id, { servers: [{ serverId: 'lobby', name: 'lobby' }] });
  assert.match(fs.readFileSync(path.join(t.smp.dir, 'server.properties'), 'utf8'), /online-mode=true/);
  assert.match(fs.readFileSync(path.join(t.smp.dir, 'config/paper-global.yml'), 'utf8'), /enabled: false/);
  networks.remove(t.manager, t.store, id);
  assert.match(fs.readFileSync(path.join(t.lobby.dir, 'server.properties'), 'utf8'), /online-mode=true/);
  fs.rmSync(t.root, { recursive: true, force: true });
});

test('containers reach the servers through the host; bad setups are refused', () => {
  const t = setup({ docker: true });
  networks.create(t.manager, t.store, { name: 'Main', proxyId: 'proxy', servers: [{ serverId: 'lobby', name: 'lobby' }] });
  assert.match(fs.readFileSync(path.join(t.proxy.dir, 'velocity.toml'), 'utf8'), /lobby = "host\.docker\.internal:25601"/);
  assert.throws(() => networks.create(t.manager, t.store, { name: 'B', proxyId: 'lobby', servers: [{ serverId: 'smp' }] }), /Velocity proxy/);
  assert.throws(() => networks.create(t.manager, t.store, { name: 'B', proxyId: 'proxy', servers: [{ serverId: 'fab' }] }), /Paper or Purpur/);
  assert.throws(() => networks.create(t.manager, t.store, { name: 'B', proxyId: 'proxy', servers: [{ serverId: 'smp' }] }), /already runs/);
  fs.rmSync(t.root, { recursive: true, force: true });
});
