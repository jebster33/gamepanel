'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bans = require('../../server/features/bans');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-bans-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'online-mode=false\n');
  const mc = { id: 'mc', name: 'SMP', dir, templateId: 'minecraft-paper' };
  const pz = { id: 'pz', name: 'Zomboid', dir: os.tmpdir(), templateId: 'project-zomboid' };
  const valheim = { id: 'vh', name: 'Valheim', dir: os.tmpdir(), templateId: 'valheim' };
  const sent = [];
  const events = [];
  const running = new Set(['pz']);
  const manager = {
    servers: [mc, pz, valheim],
    template: (s) => ({ 'minecraft-paper': { id: 'minecraft-paper', query: { type: 'minecraft' } }, 'project-zomboid': { id: 'project-zomboid' }, valheim: { id: 'valheim' } })[s.templateId],
    rt: (id) => ({ status: running.has(id) ? 'running' : 'offline' }),
    isActive: (id) => running.has(id),
    sendCommand: async (id, cmd) => sent.push([id, cmd]),
    logActivity: () => {},
    pushConsole: () => {},
  };
  const store = { state: { settings: {} }, save() {}, addEvent: (type, msg) => events.push({ type, msg }) };
  const bannedFile = () => JSON.parse(fs.readFileSync(path.join(dir, 'banned-players.json'), 'utf8'));
  return { manager, store, mc, pz, valheim, sent, events, running, bannedFile, dir };
}

test('a shared ban reaches every server that can ban, and lifting it lifts it everywhere', async () => {
  const t = setup();
  const entry = await bans.ban(t.manager, t.store, { name: 'Griefer', reason: 'Burned spawn' }, 'admin');
  // The stopped Minecraft server gets it in its ban list file, the running Zomboid server by command.
  assert.strictEqual(t.bannedFile()[0].name, 'Griefer');
  assert.strictEqual(t.bannedFile()[0].reason, 'Burned spawn');
  assert.deepStrictEqual(t.sent, [['pz', 'banuser "Griefer"']]);
  assert.deepStrictEqual(t.mc.appliedBans, ['Griefer']);
  assert.strictEqual(t.valheim.appliedBans, undefined);
  await assert.rejects(() => bans.ban(t.manager, t.store, { name: 'griefer' }, 'admin'), /already/);
  await assert.rejects(() => bans.ban(t.manager, t.store, { name: 'bad name!' }, 'admin'), /player name/);

  await bans.unban(t.manager, t.store, entry.id, 'admin');
  assert.deepStrictEqual(t.bannedFile(), []);
  assert.deepStrictEqual(t.sent.at(-1), ['pz', 'unbanuser "Griefer"']);
  assert.deepStrictEqual(t.mc.appliedBans, []);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('servers that were off or opted out catch up; temporary bans run out', async () => {
  const t = setup();
  t.running.clear();
  await bans.ban(t.manager, t.store, { name: 'Alex', hours: 1 }, 'admin');
  assert.deepStrictEqual(t.sent, []); // Zomboid is off: nothing sent yet
  t.running.add('pz');
  await bans.tick(t.manager, t.store);
  assert.deepStrictEqual(t.sent, [['pz', 'banuser "Alex"']]);

  // Opting out lifts the shared bans on that server.
  await bans.setServer(t.manager, t.store, t.mc, false);
  assert.deepStrictEqual(t.bannedFile(), []);
  await bans.setServer(t.manager, t.store, t.mc, true);
  assert.strictEqual(t.bannedFile().length, 1);

  await bans.tick(t.manager, t.store, Date.now() + 2 * 3600_000);
  assert.strictEqual(bans.view(t.manager, t.store).bans.length, 0);
  assert.deepStrictEqual(t.bannedFile(), []);
  assert.deepStrictEqual(t.sent.at(-1), ['pz', 'unbanuser "Alex"']);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('appeals: closed by default, one open appeal per ban, accept lifts the ban', async () => {
  const t = setup();
  await bans.ban(t.manager, t.store, { name: 'Steve' }, 'admin');
  const message = 'I am sorry, it was my little brother on my account.';
  assert.throws(() => bans.submitAppeal(t.store, { name: 'Steve', message }), /not open/);
  bans.updateAppealSettings(t.store, { enabled: true, intro: 'Be honest.' });
  assert.throws(() => bans.submitAppeal(t.store, { name: 'Nobody', message }), /no ban/i);
  assert.throws(() => bans.submitAppeal(t.store, { name: 'Steve', message: 'pls' }), /more/);
  const { code } = bans.submitAppeal(t.store, { name: 'steve', message, contact: 'steve#1' });
  assert.match(code, /^[A-Z0-9]{8}$/);
  assert.throws(() => bans.submitAppeal(t.store, { name: 'Steve', message }), /already an open appeal/);
  assert.strictEqual(bans.appealStatus(t.store, code.toLowerCase()).status, 'open');
  assert.throws(() => bans.appealStatus(t.store, 'WRONG'), /No appeal/);

  const view = bans.view(t.manager, t.store);
  assert.strictEqual(view.appeals[0].codeHash, undefined);
  assert.ok(t.events.some((e) => e.type === 'ban.appeal'));
  await bans.decide(t.manager, t.store, view.appeals[0].id, { decision: 'accept', reply: 'Welcome back' }, 'admin');
  const status = bans.appealStatus(t.store, code);
  assert.deepStrictEqual([status.status, status.reply], ['accepted', 'Welcome back']);
  assert.strictEqual(bans.view(t.manager, t.store).bans.length, 0);
  assert.deepStrictEqual(t.bannedFile(), []);
  await assert.rejects(() => bans.decide(t.manager, t.store, view.appeals[0].id, { decision: 'deny' }, 'admin'), /already decided/);
  fs.rmSync(t.dir, { recursive: true, force: true });
});
