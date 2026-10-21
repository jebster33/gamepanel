'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sec2b-'));

const flood = require('../../server/features/flood');
const backupTest = require('../../server/features/backup-test');
const platform = require('../../server/core/platform');

const conntrack = [
  'ipv4 2 tcp 6 100 ESTABLISHED src=203.0.113.5 dst=10.0.0.2 sport=40000 dport=25565 packets=10 bytes=500 src=10.0.0.2 dst=203.0.113.5 sport=25565 dport=40000 packets=9 bytes=400',
  'ipv4 2 tcp 6 100 ESTABLISHED src=203.0.113.5 dst=10.0.0.2 sport=40001 dport=25565 packets=10 bytes=500 src=10.0.0.2 dst=203.0.113.5 sport=25565 dport=40001',
  'ipv4 2 tcp 6 100 TIME_WAIT src=203.0.113.5 dst=10.0.0.2 sport=40002 dport=25565',
  'ipv4 2 udp 17 20 src=198.51.100.7 dst=10.0.0.2 sport=5000 dport=27015 packets=5000 bytes=5',
  'ipv4 2 tcp 6 100 ESTABLISHED src=203.0.113.6 dst=10.0.0.2 sport=1 dport=80',
].join('\n');

test('conntrack, ss and Windows listings are counted per address and protected port', () => {
  const ports = new Set(['tcp/25565', 'udp/27015']);
  const c = flood.parseConntrack(conntrack, ports);
  assert.strictEqual(c.get('203.0.113.5|tcp|25565').connections, 2);
  assert.strictEqual(c.get('198.51.100.7|udp|27015').packets, 5000);
  assert.ok(![...c.keys()].some((k) => k.includes('203.0.113.6')));
  const ss = flood.parseSs('ESTAB 0 0 10.0.0.2:25565 203.0.113.9:5555\nESTAB 0 0 [::ffff:10.0.0.2]:25565 [2001:db8::1]:6000\nESTAB 0 0 10.0.0.2:22 1.1.1.1:1', ports);
  assert.strictEqual(ss.get('203.0.113.9|tcp|25565').connections, 1);
  assert.ok(ss.has('2001:db8::1|tcp|25565'));
  const win = flood.parseWindowsTcp('[{"RemoteAddress":"203.0.113.9","LocalPort":25565},{"RemoteAddress":"x","LocalPort":25565}]', ports);
  assert.strictEqual(win.size, 1);
});

test('offenders: too many connections, or too many packets per second', () => {
  const samples = new Map([
    ['1.1.1.1|tcp|25565', { connections: 150, packets: 0 }],
    ['2.2.2.2|udp|27015', { connections: 3, packets: 60000 }],
    ['3.3.3.3|tcp|25565', { connections: 3, packets: 10 }],
  ]);
  const found = flood.offenders(samples, new Map([['2.2.2.2|udp|27015', 0]]), 10, { maxConnections: 100, maxPackets: 4000 });
  assert.deepStrictEqual(found.map((f) => f.ip).sort(), ['1.1.1.1', '2.2.2.2']);
  assert.match(found.find((f) => f.ip === '2.2.2.2').reason, /6000 packets/);
});

test('firewall commands are argument lists built from validated values only', () => {
  assert.deepStrictEqual(flood.nft.block('203.0.113.5', 25565, 'tcp', 900).slice(0, 5), ['add', 'element', 'inet', 'gamepanel', 'flood4_tcp']);
  assert.ok(flood.nft.block('2001:db8::1', 27015, 'udp', 60).includes('flood6_udp'));
  assert.ok(flood.nft.init().some((a) => a.includes('gamepanel-flood')));
  assert.throws(() => flood.nft.block('1.2.3.4; reboot', 25565, 'tcp', 1), /Not an IP/);
  assert.throws(() => flood.nft.block('1.2.3.4', 70000, 'tcp', 1), /Not a port/);
  assert.throws(() => flood.iptables.rule('-A', '1.2.3.4', 80, 'icmp'), /Not a protocol/);
  assert.ok(flood.iptables.rule('-A', '1.2.3.4', 80, 'tcp').includes('gamepanel-flood'));
  const rule = flood.netsh.block('203.0.113.5', 25565, 'tcp');
  assert.ok(rule.includes('remoteip=203.0.113.5') && rule.includes('action=block') && rule.includes('localport=25565'));
  assert.throws(() => flood.netsh.block('10.0.0.0/8', 1, 'tcp'), /Not an IP/);
});

test('flood engine: blocks an offender once, never private or allowlisted addresses, unblocks and expires', async () => {
  const calls = [];
  const store = { state: { settings: { flood: { allow: ['198.51.100.0/24'], maxConnections: 5 } }, users: [{ id: 'a', knownIps: ['203.0.113.77'] }] }, save() {}, addEvent: (t) => calls.push(['event', t]) };
  const server = { id: 's1', name: 'Survival', floodGuard: true, ports: { game: 25565 }, templateId: 'x' };
  const manager = { servers: [server], template: () => ({ ports: [{ name: 'game', protocol: 'tcp' }] }) };
  let now = 1_000_000;
  const text = (ip, n) => Array.from({ length: n }, (_, i) => `ipv4 2 tcp 6 100 ESTABLISHED src=${ip} dst=10.0.0.2 sport=${4000 + i} dport=25565`).join('\n');
  let listing = [text('203.0.113.5', 9), text('10.0.0.9', 9), text('198.51.100.4', 9), text('203.0.113.77', 9)].join('\n');
  const engine = new flood.Flood({ store, manager, now: () => now, readFile: () => listing, run: async (file, args) => { calls.push([file, ...args]); return { code: 0, stdout: file === 'which' ? '/usr/sbin/nft' : '', stderr: '' }; } });
  if (platform.isWindows) engine.backend = 'windows'; // the engine itself picks netsh there; this test covers the Linux path
  else {
    await engine.tick();
    assert.strictEqual(engine.blocks.length, 1);
    assert.strictEqual(engine.blocks[0].ip, '203.0.113.5');
    const added = calls.filter((c) => c[1] === 'add' && c[2] === 'element');
    assert.strictEqual(added.length, 1);
    assert.ok(added[0].includes('203.0.113.5'));
    assert.ok(calls.some((c) => c[0] === 'event'));
    // Seen again: still one block, no second element.
    await engine.tick();
    assert.strictEqual(engine.blocks.length, 1);
    // Unblock by hand: a grace period stops an instant re-block.
    await engine.unblock(engine.blocks[0].id);
    await engine.tick();
    assert.strictEqual(engine.blocks.length, 0);
    now += 3 * 60_000;
    await engine.tick();
    assert.strictEqual(engine.blocks.length, 1);
    // Expiry.
    listing = '';
    now += 20 * 60_000;
    await engine.tick();
    assert.strictEqual(engine.blocks.length, 0);
  }
  assert.ok((await engine.view()).settings.maxConnections === 5);
  // Manual blocks refuse loopback and allowlisted addresses.
  await assert.rejects(engine.block({ ip: '127.0.0.1', server, ports: [], reason: 'x', manual: true }), /never blocked/);
});

test('backup game checks: Minecraft level.dat and regions, Rust save and map', async () => {
  const level = zlib.gzipSync(Buffer.alloc(64, 1));
  const read = async (rel) => (rel.endsWith('level.dat') ? level : null);
  const mc = { templateId: 'minecraft-paper' };
  const okChecks = await backupTest.gameChecks(mc, [{ path: 'world/level.dat', size: 70 }, { path: 'world/region/r.0.0.mca', size: 8192 }], read);
  assert.ok(okChecks.length === 2 && okChecks.every((c) => c.ok));
  const cut = await backupTest.gameChecks(mc, [{ path: 'world/level.dat', size: 70 }, { path: 'world/region/r.0.0.mca', size: 5000 }], read);
  assert.ok(cut.some((c) => !c.ok));
  const noLevel = await backupTest.gameChecks(mc, [{ path: 'world/region/r.0.0.mca', size: 8192 }], read);
  assert.ok(noLevel.some((c) => !c.ok));
  const badLevel = await backupTest.gameChecks(mc, [{ path: 'world/level.dat', size: 3 }], async () => Buffer.from('abc'));
  assert.ok(!badLevel[0].ok);
  const rust = { templateId: 'rust' };
  assert.ok((await backupTest.gameChecks(rust, [{ path: 'server/my/proc.5.sav', size: 10 }, { path: 'server/my/proc.map', size: 9 }], read)).every((c) => c.ok));
  assert.ok((await backupTest.gameChecks(rust, [{ path: 'cfg', size: 10 }], read)).some((c) => !c.ok));
});
