'use strict';

/**
 * Welcome messages and message-of-the-day rotation.
 *
 * - server.welcome = { enabled, message, mode: 'first' | 'every' }: said in
 *   game chat when someone joins (the first time ever, or every time).
 * - server.motd = { enabled, messages: [], everyMinutes, order, next, lastAt }:
 *   Minecraft Java only. The text in server.properties changes on a timer.
 *   Minecraft reads it when it starts, so a new line shows in the server list
 *   after the next restart (or at once while a wake-on-join server sleeps).
 *
 * Placeholders in any message: {player} {server} {online}.
 */

const crypto = require('crypto');
const { fail } = require('../core/util');

const MOTD_MIN = 15;
const MOTD_MAX = 24 * 60;

/** Fill {player} {server} {online}. Function replacers keep $& and friends literal. */
function expand(text, { player = 'everyone', server = '', online = 0 } = {}) {
  return String(text || '')
    .replace(/\{player\}/g, () => player)
    .replace(/\{server\}/g, () => server)
    .replace(/\{online\}/g, () => String(online));
}

const clean = (value, max) => String(value || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, max);

const isJava = (server) => String(server.templateId || '').startsWith('minecraft') && server.templateId !== 'minecraft-bedrock';

function onlineCount(manager, server) {
  const rt = manager.rt?.(server.id);
  return rt?.status === 'running' ? rt.players ?? rt.playerList?.length ?? 0 : 0;
}

/** The chat text for a joining player, or null when this join gets none. */
function welcomeText(manager, server, name, firstTime) {
  const w = server.welcome;
  if (!w?.enabled) return null;
  if (!firstTime && w.mode !== 'every') return null;
  return expand(w.message || 'Welcome {player}! Say hi everyone.', { player: name, server: server.name, online: onlineCount(manager, server) });
}

/** A value for server.properties: & colour codes become the section sign, anything non-ASCII is escaped. */
function propertiesValue(text) {
  return String(text)
    .replace(/&([0-9a-fk-or])/gi, '§$1')
    .replace(/\\/g, '\\\\')
    .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function applyMotd(manager, server, now = Date.now()) {
  const m = server.motd;
  if (!m?.enabled || !m.messages?.length || !isJava(server)) return false;
  const i = m.order === 'random' ? crypto.randomInt(m.messages.length) : (m.next || 0) % m.messages.length;
  m.next = i + 1;
  m.lastAt = now;
  const line = expand(m.messages[i], { server: server.name, online: onlineCount(manager, server) }).slice(0, 59);
  manager.setProperties(server, { motd: propertiesValue(line) });
  manager.store.save();
  return true;
}

/** Once a minute: rotate any MOTD that is due. */
function tick(manager, now = Date.now()) {
  for (const server of manager.servers) {
    const m = server.motd;
    if (!m?.enabled || now - (m.lastAt || 0) < (m.everyMinutes || 60) * 60_000) continue;
    try {
      applyMotd(manager, server, now);
    } catch {
      m.lastAt = now; // no server.properties yet: try again next period
    }
  }
}

/** Validate and store the settings from the Messages card. */
function save(manager, server, body = {}) {
  if (body.welcome) {
    server.welcome = {
      ...(server.welcome || {}),
      enabled: Boolean(body.welcome.enabled),
      message: clean(body.welcome.message, 200),
      mode: body.welcome.mode === 'every' ? 'every' : 'first',
    };
  }
  if (body.motd) {
    if (!isJava(server)) fail(400, 'Rotating the message of the day is for Minecraft Java servers');
    const messages = (Array.isArray(body.motd.messages) ? body.motd.messages : []).map((x) => clean(x, 120)).filter(Boolean).slice(0, 20);
    const every = Math.max(MOTD_MIN, Math.min(MOTD_MAX, Math.round(Number(body.motd.everyMinutes) || 60)));
    const was = server.motd || {};
    server.motd = { enabled: Boolean(body.motd.enabled) && messages.length > 0, messages, everyMinutes: every, order: body.motd.order === 'random' ? 'random' : 'rotate', next: was.next || 0, lastAt: 0 };
    if (server.motd.enabled) {
      try {
        applyMotd(manager, server);
      } catch {
        /* written on the next tick once the server has its files */
      }
    }
  }
  manager.store.save();
  return { welcome: server.welcome || null, motd: server.motd || null };
}

module.exports = { expand, welcomeText, applyMotd, propertiesValue, tick, save, isJava };
