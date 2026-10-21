'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-wa-'));
const announce = require('../../server/features/wipe-announce');
const { Scheduler } = require('../../server/features/scheduler');

const HOOK = 'https://discord.com/api/webhooks/1/abc';
const presets = [
  { id: 'vanilla', label: 'Vanilla', description: '1x', vars: { GATHER_RATE: '1' } },
  { id: '2x', label: '2x', description: 'double', vars: { GATHER_RATE: '2' } },
];

function setup() {
  const server = { id: 's1', name: 'Rusty', templateId: 'rust', ports: { game: 28015 }, vars: { WORLD_SIZE: '3500', WORLD_SEED: '1234', GATHER_RATE: '1' }, schedules: [] };
  const calls = [];
  const manager = {
    servers: [server],
    template: () => ({ presets, wipe: {} }),
    vars: (s) => s.vars,
    isActive: () => false,
    rt: () => ({}),
    update: (id, patch) => Object.assign(server.vars, patch.vars),
    pushConsole() {},
    store: { save() {} },
  };
  const store = { state: { settings: {} }, save() {}, addEvent: (...a) => calls.push(a) };
  return { server, manager, store, calls };
}

test('announcements need a valid Discord webhook and keep it private', () => {
  const { server } = setup();
  assert.throws(() => announce.update(server, { webhook: 'https://evil.example/x' }));
  const v = announce.update(server, { webhook: HOOK, mention: 'here', ahead: 24 });
  assert.equal(v.hasWebhook, true);
  assert.equal(v.webhook, undefined);
  assert.equal(announce.update(server, { ahead: 999 }).ahead, 168);
  assert.equal(server.wipeAnnounce.webhook, HOOK);
});

test('the after-wipe post carries size, seed, wipe type and connect info, and pings only as asked', async () => {
  const { server, manager, store } = setup();
  announce.update(server, { webhook: HOOK, mention: 'everyone', connect: 'play.example.com:28015' });
  const sent = [];
  const real = global.fetch;
  global.fetch = async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true });
  try {
    await announce.announceAfter(manager, store, server, { blueprints: true, seed: 99 });
  } finally {
    global.fetch = real;
  }
  assert.equal(sent.length, 1);
  const { body } = sent[0];
  assert.match(body.content, /^@everyone /);
  assert.deepEqual(body.allowed_mentions, { parse: ['everyone'] });
  const text = JSON.stringify(body.embeds[0]);
  assert.match(text, /3500/);
  assert.match(text, /99/);
  assert.match(text, /full wipe/);
  assert.match(text, /play\.example\.com:28015/);
  assert.match(body.embeds[0].url, /rustmaps\.com\/map\/3500_99/);
});

test('a wipe posts nothing without a webhook or when switched off', async () => {
  const { server, manager, store } = setup();
  const real = global.fetch;
  let n = 0;
  global.fetch = async () => (n++, { ok: true });
  try {
    await announce.announceAfter(manager, store, server, {});
    announce.update(server, { webhook: HOOK, after: false });
    await announce.announceAfter(manager, store, server, {});
  } finally {
    global.fetch = real;
  }
  assert.equal(n, 0);
});

test('an early notice is posted once per upcoming wipe', async () => {
  const { server, manager, store } = setup();
  announce.update(server, { webhook: HOOK, ahead: 168 });
  server.schedules.push({ id: 'w', action: 'wipe', enabled: true, cron: '0 19 * * *', wipe: {} });
  const real = global.fetch;
  let n = 0;
  global.fetch = async () => (n++, { ok: true });
  const at = new Date();
  at.setMinutes(0, 0, 0);
  try {
    await announce.tick(manager, store, at.getTime());
    await announce.tick(manager, store, at.getTime());
  } finally {
    global.fetch = real;
  }
  assert.equal(n, 1);
});

test('a preset schedule switches the settings, skips when already on it, and rejects unknown presets', async () => {
  const { server, manager, store } = setup();
  const scheduler = new Scheduler(manager, store);
  assert.throws(() => scheduler.add(server, { action: 'preset', presetId: 'nope', cron: '0 18 * * 5' }));
  const on = scheduler.add(server, { action: 'preset', presetId: '2x', cron: '0 18 * * 5' });
  assert.equal(on.name, 'Switch to 2x');
  assert.equal(await scheduler.run(server, on), 'switched to 2x');
  assert.equal(server.vars.GATHER_RATE, '2');
  assert.match(await scheduler.run(server, on), /already on 2x/);
  const off = scheduler.add(server, { action: 'preset', presetId: 'vanilla', cron: '0 6 * * 1' });
  await scheduler.run(server, off);
  assert.equal(server.vars.GATHER_RATE, '1');
});
