'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');

const cm = require('../../server/features/chat-moderation');

const cfg = (over = {}) => cm.validate({ enabled: true, words: ['badword', 'grief*'], links: true, allowDomains: ['discord.gg'], caps: true, spam: true, ...over });

test('word list: whole words, leetspeak and spacing tricks, no Scunthorpe problem', () => {
  const c = cfg();
  assert.ok(cm.violation(c, 'you are a badword'));
  assert.ok(cm.violation(c, 'you are a B4DW0RD!!'));
  assert.ok(cm.violation(c, 'b.a.d.w.o.r.d'));
  assert.ok(cm.violation(c, 'baaaadword'.replace('aaaa', 'aaa')));
  assert.ok(cm.violation(c, 'stop griefing'));
  assert.strictEqual(cm.violation(c, 'that is not a badwordsmith'), null);
  assert.strictEqual(cm.violation(c, 'hello there'), null);
});

test('links, addresses, caps and spam', () => {
  const c = cfg();
  assert.strictEqual(cm.violation(c, 'join my server at play.otherserver.net').rule, 'link');
  assert.strictEqual(cm.violation(c, 'connect 51.12.3.4:25565').rule, 'link');
  assert.strictEqual(cm.violation(c, 'our discord: discord.gg/abc'), null);
  assert.strictEqual(cm.violation(c, 'version 1.20.4 is out'), null);
  assert.strictEqual(cm.violation(c, 'WHY IS EVERYONE SO MEAN'.toUpperCase()).rule, 'caps');
  assert.strictEqual(cm.violation(c, 'OK'), null);
  const now = Date.now();
  const burst = [1, 2, 3, 4, 5].map((i) => ({ t: now - i * 1000, text: `msg ${i}` }));
  assert.strictEqual(cm.violation(c, 'one more', burst, now).rule, 'spam');
  const repeats = [{ t: now - 5000, text: 'buy stuff' }, { t: now - 3000, text: 'BUY stuff!' }];
  assert.strictEqual(cm.violation({ ...c, caps: false }, 'buy stuff', repeats, now).rule, 'spam');
});

test('the ladder: warn, mute (or kick without a mute plugin), kick, temp-ban, then pardon', async () => {
  const sent = [];
  const events = [];
  const server = { id: 's', name: 'SMP', dir: os.tmpdir(), moderation: cfg({ ladder: ['warn', 'mute', 'kick', 'tempban'], banHours: 2 }) };
  const rt = {};
  const manager = {
    servers: [server],
    template: () => ({ id: 'minecraft-paper', query: { type: 'minecraft' } }),
    rt: () => rt,
    isActive: () => true,
    sendCommand: async (id, cmd) => sent.push(cmd),
    logActivity: (id, e) => events.push(e),
    pushConsole: () => {},
    store: { save() {}, addEvent: (type, msg) => events.push({ type, msg }) },
  };
  let t = Date.now();
  const say = (text) => cm.onChat(manager, server, 'Steve', text, (t += 1000));
  assert.strictEqual(await say('hello'), null);
  assert.strictEqual((await say('badword')).done, 'warned');
  assert.match(sent.at(-1), /^tell Steve Language/);
  assert.strictEqual((await say('badword')).done, 'kicked (no mute plugin)');
  assert.match(sent.at(-1), /^kick Steve Language/);
  assert.strictEqual((await say('badword')).done, 'kicked');
  assert.strictEqual((await say('badword')).done, 'banned for 2 h');
  assert.match(sent.at(-1), /^ban Steve Language \(2h\)/);
  assert.strictEqual(server.tempBans.length, 1);
  assert.ok(events.some((e) => e.type === 'automod' && e.said === 'badword'));

  // Exempt players are left alone.
  server.moderation.exempt = ['steve'];
  assert.strictEqual(await say('badword'), null);

  // Bans lift when they run out.
  await cm.tick(manager, Date.now() + 3 * 3600_000);
  assert.strictEqual(sent.at(-1), 'pardon Steve');
  assert.strictEqual(server.tempBans.length, 0);
});

test('strikes are forgotten after a quiet while; quotes and ; cannot inject commands', async () => {
  const sent = [];
  const server = { id: 's', name: 'SMP', dir: os.tmpdir(), moderation: cfg({ forgetHours: 1 }) };
  const rt = {};
  const manager = {
    servers: [server],
    template: () => ({ id: 'minecraft-paper', query: { type: 'minecraft' } }),
    rt: () => rt,
    sendCommand: async (id, cmd) => sent.push(cmd),
    logActivity: () => {},
    pushConsole: () => {},
    store: { save() {}, addEvent() {} },
  };
  const t0 = Date.now();
  assert.strictEqual((await cm.onChat(manager, server, 'Alex', 'badword', t0)).strike, 1);
  assert.strictEqual((await cm.onChat(manager, server, 'Alex', 'badword', t0 + 2 * 3600_000)).strike, 1);
  await cm.onChat(manager, server, 'A";op x', 'badword', t0);
  assert.ok(!/[";]/.test(sent.at(-1)));
});
