'use strict';

/**
 * Wipe announcements: a Discord post before a wipe (when it starts, or a day
 * ahead) and another when it is done, with the map's size and seed, a map
 * preview and how to connect. Posts go through a Discord webhook, the one
 * set here or else the server's Discord channel (discord-feed).
 *
 * server.wipeAnnounce = { webhook?, before, after, ahead (hours, 0 = off),
 *   mention: 'none' | 'here' | 'everyone', connect, beforeMessage, afterMessage, sent }
 *
 * Messages are templates: {server} {when} {type} {size} {seed} {map} {connect}.
 */

const { fail, logger } = require('../core/util');

const WEBHOOK = /^https:\/\/(?:[a-z]+\.)?(?:discord|discordapp)\.com\/api\/webhooks\//;
const DEFAULT_BEFORE = '⚠️ **{server}** wipes {when}. This is a {type}.';
const DEFAULT_AFTER = '✅ **{server}** has wiped and is starting on a fresh map. Join in a few minutes.';
const COLORS = { before: 0xffb340, after: 0xc6f432 };

const webhookOf = (server) => server.wipeAnnounce?.webhook || server.discordFeed?.webhook || '';

/** What the settings card shows: the webhook itself never leaves the panel. */
function view(server) {
  const c = server.wipeAnnounce || {};
  return {
    before: c.before !== false,
    after: c.after !== false,
    ahead: c.ahead || 0,
    mention: c.mention || 'none',
    connect: c.connect || '',
    beforeMessage: c.beforeMessage || '',
    afterMessage: c.afterMessage || '',
    hasWebhook: Boolean(c.webhook),
    usesFeed: !c.webhook && Boolean(server.discordFeed?.webhook),
  };
}

function update(server, body = {}) {
  const prev = server.wipeAnnounce || {};
  let webhook = String(body.webhook || '').trim();
  if (!webhook && !body.clearWebhook) webhook = prev.webhook || '';
  if (webhook && !WEBHOOK.test(webhook)) fail(400, 'Paste a Discord webhook URL (Channel settings, Integrations, Webhooks)');
  const text = (v) => String(v || '').trim().slice(0, 1000);
  server.wipeAnnounce = {
    webhook: webhook || undefined,
    before: body.before !== false,
    after: body.after !== false,
    ahead: Math.max(0, Math.min(168, Math.round(Number(body.ahead) || 0))),
    mention: ['here', 'everyone'].includes(body.mention) ? body.mention : 'none',
    connect: String(body.connect || '').trim().slice(0, 100),
    beforeMessage: text(body.beforeMessage),
    afterMessage: text(body.afterMessage),
    sent: prev.sent,
  };
  return view(server);
}

const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));

/** The facts a message and its embed are built from. */
function facts(manager, server, { blueprints = false, seed, newSeed = false, when = '' } = {}) {
  const vars = manager.vars(server);
  const size = Number(vars.WORLD_SIZE);
  const map = server.map || { mode: 'procedural' };
  const fixed = map.mode !== 'procedural';
  const seedValue = seed ?? (newSeed && !fixed ? null : Number(vars.WORLD_SEED));
  const game = Object.values(server.ports || {})[0];
  const address = server.wipeAnnounce?.connect || require('./dns').playerAddress(server) || '';
  return {
    server: server.name,
    when,
    type: blueprints ? 'full wipe (blueprints too)' : 'map wipe (blueprints stay)',
    size: Number.isFinite(size) && size > 0 ? String(size) : '',
    seed: seedValue ? String(seedValue) : newSeed && !fixed ? 'a new random seed' : '',
    map: fixed ? (map.mode === 'official' ? map.level || 'official map' : map.mode === 'file' ? map.file || 'custom map' : 'custom map') : '',
    connect: address || (game ? `port ${game}` : ''),
    fixed,
    preview: !fixed && server.templateId === 'rust' && Number.isFinite(size) && size > 0 && seedValue ? { size, seed: seedValue } : null,
  };
}

async function post(server, { content, embed, mention }) {
  const url = webhookOf(server);
  if (!url) return false;
  const ping = mention === 'here' ? '@here ' : mention === 'everyone' ? '@everyone ' : '';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: server.name.slice(0, 80),
      content: `${ping}${content || ''}`.slice(0, 1900) || undefined,
      embeds: embed ? [embed] : [],
      allowed_mentions: { parse: ping ? ['everyone'] : [] },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
  return true;
}

async function send(manager, store, server, kind, opts) {
  const config = server.wipeAnnounce || {};
  if (!webhookOf(server) || (config[kind] === false && !opts.force)) return false;
  const f = facts(manager, server, opts);
  const message = fill(config[`${kind}Message`] || (kind === 'before' ? DEFAULT_BEFORE : DEFAULT_AFTER), f);
  const fields = [
    f.size && { name: 'Map size', value: f.size, inline: true },
    f.seed && { name: 'Seed', value: f.seed, inline: true },
    f.map && { name: 'Map', value: f.map, inline: true },
    { name: 'Wipe', value: f.type, inline: true },
    f.connect && { name: 'Connect', value: `\`${f.connect}\``, inline: true },
  ].filter(Boolean);
  const embed = { title: kind === 'before' ? 'Wipe coming up' : 'Wipe done', description: message.slice(0, 2000), color: COLORS[kind], fields, timestamp: new Date().toISOString() };
  if (f.preview) {
    const { previewUrl, thumbnail } = require('./rustmaps');
    embed.url = previewUrl(f.preview.size, f.preview.seed);
    const image = await thumbnail(store, f.preview.size, f.preview.seed);
    if (image) embed.image = { url: image };
    else embed.fields.push({ name: 'Map preview', value: embed.url });
  }
  return post(server, { embed, mention: config.mention });
}

/** Never throws: a webhook that is down must not hold up a wipe. */
const safely = (promise, server) => promise.catch((err) => logger.debug(`Wipe announcement for ${server.name}: ${err.message}`));

/** A scheduled wipe is about to start (`minutes` of chat countdown first). */
function announceBefore(manager, store, server, { minutes = 0, blueprints, newSeed } = {}) {
  const when = minutes ? `in ${minutes} minute${minutes === 1 ? '' : 's'}` : 'now';
  return safely(send(manager, store, server, 'before', { blueprints, newSeed, when }), server);
}

/** The wipe is done and the server is starting again. */
function announceAfter(manager, store, server, result = {}) {
  return safely(send(manager, store, server, 'after', { blueprints: result.blueprints, seed: result.seed || undefined }), server);
}

/** "Wipe in about 24 hours": once per upcoming wipe, from the scheduler's minute tick. */
async function tick(manager, store, now = Date.now()) {
  if (Math.floor(now / 60_000) % 5 !== 0) return;
  const { nextRun } = require('./scheduler');
  for (const server of manager.servers) {
    const c = server.wipeAnnounce;
    if (!c?.ahead || c.before === false || !webhookOf(server)) continue;
    for (const s of server.schedules || []) {
      if (s.action !== 'wipe' || !s.enabled) continue;
      const next = nextRun(s.cron, new Date(now), { firstOfMonth: s.firstOfMonth, weekOfMonth: s.weekOfMonth });
      if (!next || next - now > c.ahead * 3_600_000 || c.sent?.[s.id] === next) continue;
      c.sent = { ...c.sent, [s.id]: next };
      store.save();
      await announceAhead(manager, store, server, s, next);
    }
  }
}

const announceAhead = (manager, store, server, schedule, at) =>
  safely(send(manager, store, server, 'before', { blueprints: schedule.wipe?.blueprints, newSeed: schedule.wipe?.newSeed, when: `<t:${Math.floor(at / 1000)}:R> (<t:${Math.floor(at / 1000)}:F>)` }), server);

/** A sample of the "wipe done" post, to see how it looks. */
async function test(manager, store, server) {
  if (!webhookOf(server)) fail(400, 'Add a Discord webhook first, or connect this server to a Discord channel');
  try {
    await send(manager, store, server, 'after', { blueprints: false, force: true });
  } catch (err) {
    fail(400, `Discord did not accept the message: ${err.message}`);
  }
  return { ok: true };
}

module.exports = { view, update, announceBefore, announceAfter, tick, test, fill };
