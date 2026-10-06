'use strict';

/**
 * A server's own Discord channel: in-game chat, joins and leaves, and
 * starts, stops and crashes, posted through a webhook. Lines are batched
 * every couple of seconds so a busy chat stays inside Discord's rate limit.
 *
 * server.discordFeed = { webhook, chat, joins, status }
 */

const { logger } = require('../core/util');

const FLUSH_MS = 2000;
const MAX_LEN = 1900;
const queues = new Map(); // server id -> { lines, timer }

/** Keep players from pinging @everyone or breaking the formatting. */
const clean = (text) => String(text).replace(/[*_`~|>\\]/g, (c) => `\\${c}`).replace(/@/g, '@​');

function lineFor(entry, feed) {
  switch (entry.type) {
    case 'chat':
      return feed.chat ? `**${clean(entry.name)}**: ${clean(entry.text)}` : null;
    case 'join':
      return feed.joins ? `➡️ ${clean(entry.name)} joined` : null;
    case 'leave':
      return feed.joins ? `⬅️ ${clean(entry.name)} left` : null;
    case 'start':
      return feed.status ? '🟢 Server is online' : null;
    case 'stop':
      return feed.status ? '🔴 Server stopped' : null;
    case 'crash':
      return feed.status ? '💥 Server crashed' : null;
    default:
      return null;
  }
}

function relay(server, entry) {
  const feed = server.discordFeed;
  if (!feed?.webhook) return;
  const line = lineFor(entry, feed);
  if (!line) return;
  const q = queues.get(server.id) || { lines: [] };
  queues.set(server.id, q);
  if (q.lines.length < 200) q.lines.push(line);
  q.timer ||= setTimeout(() => flush(server), FLUSH_MS);
}

async function flush(server) {
  const q = queues.get(server.id);
  if (!q) return;
  clearTimeout(q.timer);
  q.timer = null;
  const lines = q.lines.splice(0);
  const feed = server.discordFeed;
  if (!feed?.webhook || !lines.length) return;
  // One message per ~1900 characters.
  const messages = [];
  for (const line of lines) {
    const last = messages[messages.length - 1];
    if (last && last.length + line.length + 1 <= MAX_LEN) messages[messages.length - 1] = `${last}\n${line}`;
    else messages.push(line.slice(0, MAX_LEN));
  }
  for (const content of messages.slice(0, 5)) {
    try {
      await post(feed.webhook, { content, username: server.name.slice(0, 80) });
    } catch (err) {
      logger.debug(`Discord feed for ${server.name}: ${err.message}`);
      return;
    }
  }
}

async function post(url, body) {
  if (!/^https:\/\//.test(url)) throw new Error('The webhook must be an https:// URL');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
}

module.exports = { relay, flush, post, lineFor };
