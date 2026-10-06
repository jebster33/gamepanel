'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DiscordBot } = require('../../server/features/discord-bot');

function setup() {
  const started = [];
  const rts = { a: { status: 'running', playerList: ['Steve'], players: 1, maxPlayers: 20 }, b: { status: 'offline', playerList: [] } };
  const manager = { servers: [{ id: 'a', name: 'Survival' }, { id: 'b', name: 'Creative' }], rt: (id) => rts[id], start: async (id) => started.push(id) };
  const events = [];
  const store = { state: { settings: { integrations: { discordBot: { token: 't', controllers: '111111111111111111' } } } }, addEvent: (type, msg) => events.push(msg) };
  const bot = new DiscordBot(store, manager);
  const replies = [];
  bot.rest = async (method, path, body) => replies.push(body);
  return { bot, replies, started, events };
}

const cmd = (name, server, userId = '111111111111111111') => ({ id: '1', token: 'x', type: 2, data: { name, options: server ? [{ name: 'server', value: server }] : [] }, member: { user: { id: userId, username: 'chris' } } });

test('discord bot: status, players and autocomplete', async () => {
  const { bot, replies } = setup();
  await bot.onInteraction(cmd('status'));
  assert.match(replies[0].data.embeds[0].description, /🟢 \*\*Survival\*\* · 1 online/);
  await bot.onInteraction(cmd('players', 'a'));
  assert.strictEqual(replies[1].data.embeds[0].description, 'Steve');
  await bot.onInteraction({ id: '2', token: 'y', type: 4, data: { name: 'start', options: [{ name: 'server', value: 'cre', focused: true }] } });
  assert.deepStrictEqual(replies[2], { type: 8, data: { choices: [{ name: 'Creative', value: 'b' }] } });
});

test('discord bot: only listed users can start servers', async () => {
  const { bot, replies, started, events } = setup();
  await bot.onInteraction(cmd('start', 'b', '999999999999999999'));
  assert.strictEqual(started.length, 0);
  assert.strictEqual(replies[0].data.flags, 64);
  await bot.onInteraction(cmd('start', 'b'));
  assert.deepStrictEqual(started, ['b']);
  assert.match(events[0], /chris used \/start on Creative/);
});

test('a server Discord feed batches chat and keeps mentions out', async () => {
  const feed = require('../../server/features/discord-feed');
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 204 };
  };
  try {
    const server = { id: 'f1', name: 'SMP', discordFeed: { webhook: 'https://discord.com/api/webhooks/1/x', chat: true, joins: false, status: true } };
    feed.relay(server, { type: 'join', name: 'Steve' });
    feed.relay(server, { type: 'chat', name: 'Steve', text: 'hi @everyone *bold*' });
    feed.relay(server, { type: 'crash' });
    await feed.flush(server);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].content, '**Steve**: hi @​everyone \\*bold\\*\n💥 Server crashed');
    assert.deepStrictEqual(sent[0].allowed_mentions, { parse: [] });
  } finally {
    global.fetch = realFetch;
  }
});
