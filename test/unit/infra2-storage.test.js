'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vault = require('../../server/features/vault');
const vaultTools = require('../../server/features/vault-tools');
const storage = require('../../server/features/storage-usage');
const logRules = require('../../server/features/log-rules');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `gp-infra2-${p}-`));

test('vault: check finds missing pieces, retention prunes and collects garbage', async () => {
  const server = { id: 's1', templateId: 'x', dir: tmp('srv') };
  const backups = tmp('bk');
  fs.writeFileSync(path.join(server.dir, 'a.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  const first = await vault.create(backups, server, 'one');
  fs.writeFileSync(path.join(server.dir, 'a.bin'), Buffer.alloc(3 * 1024 * 1024, 2));
  const second = await vault.create(backups, server, 'two');
  assert.notStrictEqual(first.name, second.name);

  const ok = await vaultTools.check(backups, { deep: true });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.snapshots, 2);
  assert.strictEqual(ok.orphans, 0);

  // Retention: keep only the newest one; the older snapshot and its pieces go.
  const list = vault.list(backups);
  const dry = await vaultTools.applyRetention(backups, list, { keepLast: 1 }, [], { dryRun: true });
  assert.strictEqual(dry.removed.length, 1);
  assert.strictEqual(vault.list(backups).length, 2);
  const real = await vaultTools.applyRetention(backups, list, { keepLast: 1 }, []);
  assert.strictEqual(real.removed.length, 1);
  assert.ok(real.freed > 0);
  assert.strictEqual(vault.list(backups).length, 1);
  assert.strictEqual((await vaultTools.check(backups)).ok, true);

  // Break a piece: check reports it.
  const v = vault.Vault.all(backups)[0];
  const chunks = path.join(v.dir, 'chunks');
  const sub = fs.readdirSync(chunks)[0];
  fs.rmSync(path.join(chunks, sub, fs.readdirSync(path.join(chunks, sub))[0]));
  const bad = await vaultTools.check(backups);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.missing.length >= 1);

  // An orphan piece is found and compact removes it.
  fs.mkdirSync(path.join(chunks, 'ff'), { recursive: true });
  fs.writeFileSync(path.join(chunks, 'ff', 'f'.repeat(64)), 'junk');
  assert.strictEqual((await vaultTools.check(backups)).orphans, 1);
  const c = await vault.compact(backups);
  assert.ok(c.freed >= 4);
});

test('vault tools: retention policy by age keeps the newest N', () => {
  const now = Date.now();
  const day = 86_400_000;
  const list = [0, 1, 10, 20, 40].map((d, i) => ({ name: `n${i}.snap`, createdAt: now - d * day }));
  const gone = vaultTools.selectOld(list, { keepLast: 2, keepDays: 15 }, now).map((b) => b.name);
  assert.deepStrictEqual(gone.sort(), ['n3.snap', 'n4.snap']);
  assert.deepStrictEqual(vaultTools.selectOld(list, {}, now), []);
});

test('storage: disk breakdown by folder with biggest files', async () => {
  const dir = tmp('disk');
  fs.mkdirSync(path.join(dir, 'world'));
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'world', 'region.mca'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(dir, 'logs', 'a.log'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dir, 'server.jar'), Buffer.alloc(300));
  const r = await storage.disk({ id: 'disk-t', dir }, { refresh: true });
  assert.strictEqual(r.total, 5400);
  assert.strictEqual(r.folders[0].name, 'world');
  assert.strictEqual(r.folders[0].kind, 'world');
  assert.strictEqual(r.biggest[0].path, 'world/region.mca');
  assert.strictEqual(storage.byKind(r).logs, 100);
});

test('storage: network is unavailable for plain processes and totals add up for containers', () => {
  const rts = { a: { docker: { id: 'x' }, networkRx: 100, networkTx: 50 }, b: {} };
  const manager = { servers: [{ id: 'a' }, { id: 'b' }], rt: (id) => rts[id], runtimeFor: (s) => (s.id === 'a' ? 'docker' : 'process') };
  assert.strictEqual(storage.network(manager, { id: 'b' }).available, false);
  storage.accumulate(manager, 30, Date.parse('2026-03-05T00:00:00Z'));
  const n = storage.network(manager, { id: 'a' });
  assert.strictEqual(n.available, true);
  assert.ok(n.months.find((m) => m.month === '2026-03').rx >= 3000);
});

test('log rules: delete, gzip, size cap, never the active file', async () => {
  const dir = tmp('logs');
  fs.mkdirSync(path.join(dir, 'logs'));
  const old = (name, days, size = 1000) => {
    const f = path.join(dir, 'logs', name);
    fs.writeFileSync(f, Buffer.alloc(size, 97));
    const t = new Date(Date.now() - days * 86_400_000);
    fs.utimesSync(f, t, t);
  };
  old('ancient.log', 60);
  old('week.log', 10);
  old('fresh.log', 0);
  old('latest.log', 90);
  const p = await logRules.plan(dir, logRules.LOG_DIRS, { deleteDays: 30, gzipDays: 5, maxMb: 0 }, { running: true });
  const by = Object.fromEntries(p.actions.map((a) => [a.rel, a.action]));
  assert.deepStrictEqual(by, { 'logs/ancient.log': 'delete', 'logs/week.log': 'gzip' });
  const res = await logRules.execute(p.actions);
  assert.strictEqual(res.deleted, 1);
  assert.strictEqual(res.gzipped, 1);
  assert.ok(fs.existsSync(path.join(dir, 'logs', 'week.log.gz')));
  assert.ok(!fs.existsSync(path.join(dir, 'logs', 'week.log')));
  assert.ok(fs.existsSync(path.join(dir, 'logs', 'latest.log')));
  assert.ok(fs.existsSync(path.join(dir, 'logs', 'fresh.log')));

  // Size cap: oldest first.
  const dir2 = tmp('cap');
  fs.mkdirSync(path.join(dir2, 'logs'));
  for (const [n, d] of [['a.log', 5], ['b.log', 4], ['c.log', 3]]) {
    const f = path.join(dir2, 'logs', n);
    fs.writeFileSync(f, Buffer.alloc(600 * 1024, 1));
    const t = new Date(Date.now() - d * 86_400_000);
    fs.utimesSync(f, t, t);
  }
  const capped = await logRules.plan(dir2, logRules.LOG_DIRS, { deleteDays: 0, gzipDays: 0, maxMb: 1 }, { running: false });
  assert.deepStrictEqual(capped.actions.map((a) => a.rel), ['logs/a.log', 'logs/b.log']);
});

test('log rules: a log folder that is a link is not followed', async () => {
  if (process.platform === 'win32') return;
  const outside = tmp('outside');
  fs.writeFileSync(path.join(outside, 'x.log'), 'x');
  const t = new Date(Date.now() - 90 * 86_400_000);
  fs.utimesSync(path.join(outside, 'x.log'), t, t);
  const dir = tmp('link');
  fs.symlinkSync(outside, path.join(dir, 'logs'));
  const p = await logRules.plan(dir, logRules.LOG_DIRS, { deleteDays: 1, gzipDays: 0, maxMb: 0 }, {});
  assert.strictEqual(p.actions.length, 0);
});
