'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-infra1-sync-'));
const sync = require('../../server/features/config-sync');
const playit = require('../../server/features/playit');
const vpn = require('../../server/features/vpn-fallback');
const secrets = require('../../server/core/secrets');
const { which } = require('../../server/core/platform');
const { makeApp, load } = require('./support/routes');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-infra1-srv-'));
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
put('server.properties', 'motd=Hello\nrcon.password=hunter22\nserver-port=25565\n');
put('plugins/Essentials/config.yml', 'prefix: x\napi-key: ABCDEF123456\n');
put('plugins/Essentials/userdata/big.yml', 'x'.repeat(300 * 1024));
put('plugins/Essentials/private.yml', 'a: 1\n');
put('plugins/Essentials/tool.jar', 'PK');
put('world/level.dat', 'binary');
put('world/data.yml', 'a: 1');

const TEMPLATE = { id: 'mc', name: 'MC', ports: [{ name: 'game', protocol: 'tcp' }], variables: [{ name: 'RCON_PASSWORD', secret: true }, { name: 'MOTD' }] };
const manager = {
  servers: [{ id: 'one', name: 'One', templateId: 'mc', dir, ports: { game: 25565 }, vars: { MOTD: 'hi', RCON_PASSWORD: secrets.seal('hunter22') }, memory: 2048, ownerId: 'u1' }],
  template: () => TEMPLATE,
};
const settings = {
  panelName: 'P',
  portRangeStart: 27000,
  integrations: { discordBot: { token: secrets.seal('bot-token-123') }, steamApiKey: 'STEAMKEY', curseforgeKey: 'cfkey' },
  notifications: { discordWebhook: 'https://discord.com/api/webhooks/1/abc', events: ['server.crashed'] },
  nodes: [{ name: 'n', key: secrets.seal('nodekey') }],
  cloudBackups: { secretAccessKey: secrets.seal('s3secret'), bucket: 'b' },
  backupPassphrase: 'pp',
  configSync: { token: secrets.seal('ghp_x') },
  limits: { memoryMb: 0 },
};

test('the whitelist leaves out every secret and world data', () => {
  const { files, skipped } = sync.collect({ settings, manager, chosen: { one: ['server.properties', 'plugins/Essentials/', 'world/', '../etc/passwd', 'world/data.yml'] } });
  const all = [...files.entries()].map(([p, t]) => `${p}\n${t}`).join('\n');
  for (const secret of ['hunter22', 'bot-token-123', 'STEAMKEY', 'cfkey', 'discord.com/api/webhooks', 'nodekey', 's3secret', 'ghp_x', 'ABCDEF123456', 'enc:v1', 'pp"']) assert.ok(!all.includes(secret), `leaked ${secret}`);
  const names = [...files.keys()];
  assert.ok(names.includes('servers/one/files/server.properties'));
  assert.ok(names.includes('servers/one/files/plugins/Essentials/config.yml'));
  assert.ok(!names.some((n) => /world|big\.yml|private\.yml|\.jar|passwd/.test(n)));
  assert.ok(files.get('servers/one/files/server.properties').includes('rcon.password=<redacted>'));
  assert.ok(files.get('servers/one/files/server.properties').includes('motd=Hello'));
  assert.ok(skipped.length >= 2);
  const panel = JSON.parse(files.get('panel/settings.json'));
  assert.strictEqual(panel.panelName, 'P');
  assert.ok(!('nodes' in panel) && !('configSync' in panel));
  assert.strictEqual(panel.cloudBackups.bucket, 'b');
  assert.ok(files.get('servers.yaml').includes('MOTD: hi'));
});

test('paths and remotes are checked', () => {
  assert.strictEqual(sync.cleanRel('../x'), null);
  assert.strictEqual(sync.cleanRel('/etc/passwd'), null);
  assert.strictEqual(sync.cleanRel('world/level.dat'), null);
  assert.deepStrictEqual(sync.cleanRel('plugins\\Essentials\\'), { rel: 'plugins/Essentials', isDir: true });
  assert.strictEqual(sync.checkRemote('https://github.com/me/cfg.git'), 'https://github.com/me/cfg.git');
  assert.strictEqual(sync.checkRemote('git@github.com:me/cfg.git'), 'git@github.com:me/cfg.git');
  for (const bad of ['https://user:tok@github.com/me/cfg.git', '--upload-pack=x', 'ext::sh -c id', 'file:///tmp/x', 'http://github.com/a/b']) assert.throws(() => sync.checkRemote(bad), /repository address/);
  assert.throws(() => sync.checkBranch('--x'), /branch/);
});

test('a local sync commits the snapshot and the token is never written to the repo', { skip: !which('git') }, async () => {
  const state = { settings: { ...settings, configSync: { enabled: true, remote: '', branch: 'main', username: 'x', token: secrets.seal('ghp_secrettoken'), everyHours: 0, files: { one: ['server.properties'] } } }, events: [] };
  const store = { state, save() {}, addEvent() {} };
  const r = await sync.sync({ store, manager }, { push: false });
  assert.ok(r.committed);
  const again = await sync.sync({ store, manager }, { push: false });
  assert.ok(!again.committed, 'nothing changed, nothing committed');
  const seen = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else seen.push(fs.readFileSync(p, 'latin1'));
    }
  };
  walk(sync.REPO_DIR);
  assert.ok(!seen.join('\n').includes('ghp_secrettoken'));
  assert.ok(!seen.join('\n').includes('hunter22'));
  assert.deepStrictEqual(Object.keys(sync.view(store, manager)).includes('token'), false);
});

test('config sync and hosting routes are admin only', async () => {
  const app = makeApp({ bridge: { enabled: false, connections: [] } });
  app.manager = { servers: [], template: () => null, require() {} };
  const user = { id: 'u', username: 'bob', role: 'user' };
  const { call } = load('infra', app);
  const hosting = load('hosting', app);
  for (const [m, p] of [['GET', '/api/config-sync'], ['POST', '/api/config-sync/run'], ['GET', '/api/infra/export'], ['POST', '/api/infra/apply']]) await assert.rejects(call(m, p, { user }), /administrators/);
  for (const [m, p] of [['GET', '/api/hosting/playit'], ['POST', '/api/hosting/playit/install'], ['GET', '/api/hosting/vpn'], ['POST', '/api/hosting/vpn/join'], ['POST', '/api/hosting/wizard']]) await assert.rejects(hosting.call(m, p, { user }), /administrators/);
});

test('playit: picks the right release asset, verifies downloads, reads claim links and tunnels', () => {
  const release = { assets: ['playit-linux-amd64', 'playit-linux-aarch64', 'playit-windows-x86_64-signed.exe', 'playit-darwin-aarch64', 'playit-linux-amd64.sha256'].map((name) => ({ name, browser_download_url: `https://github.com/playit-cloud/playit-agent/releases/download/v1/${name}` })) };
  assert.strictEqual(playit.pickAsset(release, 'linux', 'x64').name, 'playit-linux-amd64');
  assert.strictEqual(playit.pickAsset(release, 'linux', 'arm64').name, 'playit-linux-aarch64');
  assert.strictEqual(playit.pickAsset(release, 'win32', 'x64').name, 'playit-windows-x86_64-signed.exe');
  assert.strictEqual(playit.pickAsset(release, 'linux', 'riscv64'), null);

  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(2 * 1024 * 1024)]);
  const crypto = require('crypto');
  const digest = `sha256:${crypto.createHash('sha256').update(elf).digest('hex')}`;
  assert.strictEqual(playit.verifyDownload(elf, { size: elf.length, digest }).checksum, 'verified');
  assert.throws(() => playit.verifyDownload(elf, { size: elf.length, digest: `sha256:${'0'.repeat(64)}` }), /checksum/);
  assert.throws(() => playit.verifyDownload(elf, { size: elf.length + 1 }), /GitHub lists/);
  assert.throws(() => playit.verifyDownload(Buffer.alloc(100), {}), /size/);
  assert.throws(() => playit.verifyDownload(Buffer.concat([Buffer.from('<html'), Buffer.alloc(2 * 1024 * 1024)]), {}), /not a program/);

  assert.deepStrictEqual(playit.parseClaim('Visit link to setup https://playit.gg/claim/ab12CD34'), { url: 'https://playit.gg/claim/ab12CD34', code: 'ab12CD34' });
  assert.strictEqual(playit.parseClaim('nothing'), null);
  assert.strictEqual(playit.readSecretText('secret_key = "abc123abc123abc123abc"\n'), 'abc123abc123abc123abc');

  const tunnels = playit.parseRundata({ status: 'success', data: { tunnels: [{ name: 'mc', port_type: 'tcp', alloc: { status: 'allocated', data: { assigned_domain: 'x.joinmc.link', port_start: 4242 } }, origin: { type: 'agent', data: { local_ip: '127.0.0.1', local_port: 25565 } } }] } });
  assert.deepStrictEqual(tunnels[0], { name: 'mc', protocol: 'tcp', address: 'x.joinmc.link:4242', localPort: 25565, pending: false });
  const mapped = playit.mapToServers([{ id: 'one', name: 'One' }], tunnels, () => [{ name: 'game', port: 25565, protocol: 'tcp' }, { name: 'q', port: 25566, protocol: 'udp' }]);
  assert.deepStrictEqual(mapped[0].ports.map((p) => p.addresses), [['x.joinmc.link:4242'], []]);
});

test('vpn: parsing, addresses, CGNAT and the recommendation order', () => {
  const ts = vpn.parseTailscale({ BackendState: 'Running', TailscaleIPs: ['100.64.1.2', 'fd7a::1'], Self: { DNSName: 'box.tail1.ts.net.' } });
  assert.deepStrictEqual([ts.up, ts.ipv4, ts.dnsName], [true, '100.64.1.2', 'box.tail1.ts.net']);
  const zt = vpn.parseZeroTier([{ nwid: 'a'.repeat(16), status: 'OK', assignedAddresses: ['10.147.17.5/24', 'fc00::1/88'] }]);
  assert.deepStrictEqual(zt[0].ips, ['10.147.17.5']);
  const addr = vpn.connectAddresses([{ id: 's', name: 'S' }], () => [{ name: 'game', port: 25565, protocol: 'tcp' }, { name: 'rcon', port: 25575, protocol: 'tcp' }], { tailscale: ts, zerotier: zt });
  assert.deepStrictEqual(addr[0].ports.length, 1);
  assert.ok(addr[0].ports[0].addresses.some((a) => a.address === '100.64.1.2:25565'));
  assert.ok(addr[0].ports[0].addresses.some((a) => a.address === '10.147.17.5:25565'));
  assert.ok(vpn.isCgnat('100.70.0.1', '1.2.3.4') && vpn.isCgnat('10.0.0.5', null) && vpn.isCgnat('5.5.5.5', '6.6.6.6') && !vpn.isCgnat('5.5.5.5', '5.5.5.5'));
  assert.strictEqual(vpn.recommend({ reachable: true }).recommended, 'portforward');
  assert.strictEqual(vpn.recommend({ cgnat: true, bridge: { enabled: false } }).recommended, 'playit');
  assert.strictEqual(vpn.recommend({ reachable: false, upnp: true }).recommended, 'portforward');
  assert.strictEqual(vpn.recommend({ cgnat: true, bridge: { enabled: true, connections: 2 } }).recommended, 'bridge');
  assert.strictEqual(vpn.recommend({ cgnat: true, tailscale: { up: true } }).recommended, 'tailscale');
  assert.ok(vpn.TS_KEY.test('tskey-auth-abc123DEF456-xyz') && !vpn.TS_KEY.test('tskey-; rm -rf /'));
  assert.ok(vpn.ZT_ID.test('8056c2e21c000001') && !vpn.ZT_ID.test('8056c2e21c00000; id'));
});
