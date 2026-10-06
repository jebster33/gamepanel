'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-bridge-unit-'));
process.env.GP_DATA_DIR = tmp;

const { loadIdentity } = require('../../server/features/bridge/identity');
const { Bridge } = require('../../server/features/bridge');
const clients = require('../../server/features/bridge/clients');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fakeStore() {
  return { state: { settings: { panelName: 'Test' }, events: [] }, save() {}, addEvent() {} };
}

function fakeManager(servers) {
  const templates = {
    mc: { ports: [{ name: 'game', protocol: 'tcp' }, { name: 'query', protocol: 'udp' }] },
    rust: { ports: [{ name: 'game', protocol: 'both' }] },
  };
  return { servers, template: (s) => templates[s.templateId] };
}

test('the bridge identity is a valid self-signed certificate, stable across loads', () => {
  const dir = path.join(tmp, 'id');
  const a = loadIdentity(dir);
  const cert = new crypto.X509Certificate(a.cert);
  assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(a.key)));
  assert.ok(cert.verify(cert.publicKey), 'self-signed signature verifies');
  const pin = crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  assert.strictEqual(a.pin, pin);
  assert.strictEqual(loadIdentity(dir).pin, a.pin, 'reloads the same key');
  assert.ok(new Date(cert.validTo).getFullYear() > 2100);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, 'identity.json')).mode & 0o777, 0o600);
});

test('a damaged identity is never silently replaced', () => {
  const dir = path.join(tmp, 'broken');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'identity.json'), '{nope');
  assert.throws(() => loadIdentity(dir), /unreadable/);
});

test('forwards cover exactly the allowed servers and custom ports', () => {
  const manager = fakeManager([
    { id: 's1', name: 'Minecraft', templateId: 'mc', ports: { game: 25565, query: 25566 } },
    { id: 's2', name: 'Rust', templateId: 'rust', ports: { game: 28015 }, ip: '10.0.0.5' },
    { id: 's3', name: 'Hidden', templateId: 'mc', ports: { game: 25575, query: 25576 } },
  ]);
  const bridge = new Bridge({ store: fakeStore(), manager, secret: 'x'.repeat(48) });
  const conn = bridge.createConnection('alex');
  bridge.updateConnection(conn.id, { servers: ['s1', 's2', 'nope'], ports: [{ name: 'SSH', port: 22, localPort: 2222, protocol: 'tcp' }] });
  assert.deepStrictEqual(conn.servers, ['s1', 's2'], 'unknown servers are dropped');
  const f = bridge.forwardsFor(conn);
  const ids = f.map((x) => `${x.group}:${x.port}/${x.protocol}`).sort();
  assert.deepStrictEqual(ids, ['Custom ports:22/tcp', 'Minecraft:25565/tcp', 'Minecraft:25566/udp', 'Rust:28015/tcp', 'Rust:28015/udp']);
  assert.strictEqual(f.find((x) => x.group === 'Rust').target.host, '10.0.0.5');
  assert.strictEqual(f.find((x) => x.group === 'Minecraft').target.host, '127.0.0.1');
  assert.strictEqual(f.find((x) => x.name === 'SSH').localPort, 2222);
  assert.ok(bridge.clientForwards(conn).every((x) => !x.target), 'internal targets are not sent to clients');
  bridge.forgetServer('s1');
  assert.deepStrictEqual(conn.servers, ['s2']);
  bridge.stop();
});

test('custom ports and usernames are validated', () => {
  const bridge = new Bridge({ store: fakeStore(), manager: fakeManager([]), secret: 'x'.repeat(48) });
  assert.throws(() => bridge.createConnection('a'), /3-32/);
  assert.throws(() => bridge.createConnection('bad name!'), /3-32/);
  const conn = bridge.createConnection('alex');
  assert.throws(() => bridge.createConnection('ALEX'), /already/);
  assert.throws(() => bridge.updateConnection(conn.id, { ports: [{ name: 'x', port: 70000 }] }), /1-65535/);
  assert.throws(() => bridge.updateConnection(conn.id, { ports: [{ name: '', port: 22 }] }), /name/);
  assert.throws(() => bridge.updateConnection(conn.id, { ports: [{ name: 'x', port: 22, host: 'a b' }] }), /host/);
  assert.throws(() => bridge.setSettings({ publicUrl: 'ftp://x' }), /http/);
  assert.throws(() => bridge.setSettings({ publicUrl: 'http://user:pw@x' }), /login/);
  bridge.stop();
});

test('download keys are per connection and rotate', () => {
  const bridge = new Bridge({ store: fakeStore(), manager: fakeManager([]), secret: 'x'.repeat(48) });
  const a = bridge.createConnection('alex');
  const b = bridge.createConnection('blair');
  const before = bridge.keyFor(a);
  assert.notStrictEqual(before, bridge.keyFor(b));
  bridge.rotateKey(a.id);
  assert.notStrictEqual(before, bridge.keyFor(a));
  bridge.stop();
});

test('the stamp trailer round-trips', () => {
  const payload = { v: 1, urls: ['http://x'], conn: 'c', key: 'k', pin: 'p' };
  const t = clients.trailer(payload);
  assert.ok(t.subarray(-8).equals(Buffer.from('GPBRIDG1')));
  const n = t.readUInt32LE(t.length - 12);
  assert.deepStrictEqual(JSON.parse(t.subarray(t.length - 12 - n, t.length - 12)), payload);
});
