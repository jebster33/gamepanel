'use strict';

/**
 * Chat moderation. The panel reads chat from the console, so it cannot stop a
 * message from appearing; it acts right after: a warning first, then a mute,
 * a kick and a temporary ban for players who keep going (the ladder is
 * configurable). Strikes are forgotten after a quiet while.
 *
 * server.moderation = { enabled, words: [], links, allowDomains: [], caps,
 *   spam, ladder: ['warn','mute','kick','tempban'], muteMinutes, banHours,
 *   forgetHours, exempt: [] }
 * server.tempBans = [{ name, until, reason }]
 */

const fs = require('fs');
const path = require('path');
const { fail, logger } = require('../core/util');
const players = require('../games/players');

const ACTIONS = ['warn', 'mute', 'kick', 'tempban'];
const DEFAULTS = { enabled: false, words: [], links: false, allowDomains: [], caps: false, spam: true, ladder: ['warn', 'mute', 'kick', 'tempban'], muteMinutes: 10, banHours: 24, forgetHours: 24, exempt: [] };

const list = (value, max, len = 60) =>
  [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\n,]+/)).map((s) => String(s).trim().toLowerCase().slice(0, len)).filter(Boolean))].slice(0, max);
const int = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

function validate(input = {}, current = {}) {
  const next = { ...DEFAULTS, ...current, ...input };
  const ladder = (Array.isArray(next.ladder) ? next.ladder : []).filter((a) => ACTIONS.includes(a)).slice(0, 6);
  return {
    enabled: Boolean(next.enabled),
    words: list(next.words, 500),
    links: Boolean(next.links),
    allowDomains: list(next.allowDomains, 50, 100).map((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '')),
    caps: Boolean(next.caps),
    spam: Boolean(next.spam),
    ladder: ladder.length ? ladder : ['warn'],
    muteMinutes: int(next.muteMinutes, 1, 1440, 10),
    banHours: int(next.banHours, 1, 24 * 30, 24),
    forgetHours: int(next.forgetHours, 1, 24 * 30, 24),
    exempt: list(next.exempt, 100, 32),
  };
}

/* ----------------------------------------------------------------- rules -- */

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' };

/** "B@d   w0rddd!" → "bad word": what players do to get past a word list. */
function normalize(text) {
  return String(text)
    .toLowerCase()
    // ! and | stand for i only inside a word ("sh!t"), not as punctuation ("hi!!").
    .replace(/[!|](?=[a-z0-9@$])/g, 'i')
    .replace(/[0134578@$]/g, (c) => LEET[c])
    .replace(/[^\p{L}\s]/gu, '')
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A word list entry: "word" matches the whole word, "word*" anything starting with it. */
function wordPattern(entry) {
  const star = entry.endsWith('*');
  const core = normalize(entry.replace(/\*+$/, ''));
  if (!core) return null;
  const body = core.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s?');
  return new RegExp(`(?:^|\\s)${body}${star ? '' : '(?=\\s|$)'}`);
}

const LINK = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|net|org|gg|io|me|co|xyz|tv|ly|us|uk|de|ru|info|biz|club|online|site|store|link|app|dev|fun|pro|top|shop)\b(?:\/\S*)?)|\b(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\b/i;

/** What, if anything, a message breaks. `recent` is the player's earlier messages: [{ t, text }]. */
function violation(cfg, text, recent = [], now = Date.now()) {
  const norm = normalize(text);
  for (const entry of cfg.words) {
    const re = wordPattern(entry);
    if (re && (re.test(norm) || re.test(norm.replace(/ /g, '')))) return { rule: 'word', reason: 'Language' };
  }
  if (cfg.links) {
    const m = String(text).match(LINK);
    if (m) {
      const host = (m[1] || m[2] || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const allowed = cfg.allowDomains.some((d) => host === d || host.endsWith(`.${d}`));
      if (!allowed) return { rule: 'link', reason: 'Links and server addresses are not allowed' };
    }
  }
  if (cfg.caps) {
    const letters = String(text).replace(/[^A-Za-z]/g, '');
    if (letters.length >= 12 && letters.replace(/[^A-Z]/g, '').length / letters.length >= 0.7) return { rule: 'caps', reason: 'Too many capitals' };
  }
  if (cfg.spam) {
    const last10s = recent.filter((r) => now - r.t < 10_000);
    if (last10s.length >= 5) return { rule: 'spam', reason: 'Too many messages too fast' };
    const same = recent.filter((r) => now - r.t < 60_000 && normalize(r.text) === norm && norm.length > 0);
    if (same.length >= 2) return { rule: 'spam', reason: 'Repeating the same message' };
  }
  return null;
}

/* --------------------------------------------------------------- actions -- */

const isMinecraft = (template) => template?.query?.type === 'minecraft';

/** Whether a mute command exists: EssentialsX, LiteBans, AdvancedBan or CMI on a Minecraft server. */
function muteCommand(server, template) {
  if (template?.players?.commands?.mute) return template.players.commands.mute;
  if (!isMinecraft(template)) return null;
  let jars = [];
  try {
    jars = fs.readdirSync(path.join(server.dir, 'plugins')).map((n) => n.toLowerCase());
  } catch {
    return null;
  }
  if (jars.some((n) => /^(litebans|advancedban)/.test(n) && n.endsWith('.jar'))) return 'tempmute {name} {minutes}m {reason}';
  if (jars.some((n) => /^(essentialsx?|cmi)[^/]*\.jar$/.test(n))) return 'mute {name} {minutes}m {reason}';
  return null;
}

const whisperCommand = (template) => template?.players?.commands?.whisper || (isMinecraft(template) ? 'tell {name} {msg}' : null);
const clean = (s) => String(s).replace(/["\r\n;]/g, ' ').replace(/\s+/g, ' ').trim();
const fill = (cmd, vars) => cmd.replace(/\{(\w+)\}/g, (_, k) => clean(vars[k] ?? ''));

async function act(manager, server, name, action, cfg, reason) {
  const template = manager.template(server);
  const cmds = players.playerCommands(template);
  const send = (cmd) => manager.sendCommand(server.id, cmd);
  const vars = { name, reason, minutes: cfg.muteMinutes, hours: cfg.banHours };
  switch (action) {
    case 'warn': {
      const whisper = whisperCommand(template);
      const msg = `${reason}. Please stop, or you will be muted or kicked.`;
      if (whisper) await send(fill(whisper, { ...vars, msg }));
      else if (players.broadcastCommand(template)) await send(players.fillBroadcast(players.broadcastCommand(template), `${name}: ${msg}`));
      return 'warned';
    }
    case 'mute': {
      const mute = muteCommand(server, template);
      if (mute) {
        await send(fill(mute, vars));
        return `muted for ${cfg.muteMinutes} min`;
      }
      // No mute on this server: a kick is the next best thing.
      if (!cmds.kick) return 'warned';
      await send(fill(cmds.kick, vars) + (isMinecraft(template) ? ` ${clean(reason)}` : ''));
      return 'kicked (no mute plugin)';
    }
    case 'kick':
      if (!cmds.kick) return 'warned';
      await send(fill(cmds.kick, vars) + (isMinecraft(template) ? ` ${clean(reason)}` : ''));
      return 'kicked';
    case 'tempban': {
      if (!cmds.ban) {
        if (cmds.kick) await send(fill(cmds.kick, vars));
        return 'kicked (no ban command)';
      }
      await send(fill(cmds.ban, vars) + (isMinecraft(template) ? ` ${clean(reason)} (${cfg.banHours}h)` : ''));
      server.tempBans = [...(server.tempBans || []).filter((b) => b.name.toLowerCase() !== name.toLowerCase()), { name, until: Date.now() + cfg.banHours * 3_600_000, reason }];
      manager.store.save();
      return `banned for ${cfg.banHours} h`;
    }
    default:
      return 'ignored';
  }
}

/** Called for every chat line the console shows. */
async function onChat(manager, server, name, text, now = Date.now()) {
  const cfg = server.moderation;
  if (!cfg?.enabled || !name) return null;
  if (cfg.exempt.includes(String(name).toLowerCase())) return null;
  const rt = manager.rt(server.id);
  const state = (rt.moderation ||= { recent: new Map(), strikes: new Map() });
  const key = String(name).toLowerCase();
  const recent = (state.recent.get(key) || []).filter((r) => now - r.t < 60_000);
  const found = violation(cfg, text, recent, now);
  recent.push({ t: now, text });
  state.recent.set(key, recent.slice(-20));
  if (!found) return null;

  const strike = state.strikes.get(key);
  const count = strike && now - strike.last < cfg.forgetHours * 3_600_000 ? strike.count + 1 : 1;
  state.strikes.set(key, { count, last: now });
  // Spam bursts count once: no second strike for the next lines of the same burst.
  state.recent.set(key, []);
  const action = cfg.ladder[Math.min(count, cfg.ladder.length) - 1];
  let done;
  try {
    done = await act(manager, server, name, action, cfg, found.reason);
  } catch (err) {
    logger.warn(`Chat moderation on ${server.name}: ${err.message}`);
    return null;
  }
  manager.logActivity(server.id, { type: 'automod', name, text: `${done}: ${found.reason}`, said: String(text).slice(0, 200) });
  manager.pushConsole(server, `Chat moderation: ${name} ${done} (${found.reason.toLowerCase()}, strike ${count})`, 'system');
  if (action !== 'warn') manager.store.addEvent('player.moderated', `${name} was ${done} on ${server.name}: ${found.reason}`, { serverId: server.id });
  return { action, done, strike: count, rule: found.rule };
}

/** Once a minute: lift temporary bans that have run out (when the server is up to hear it). */
async function tick(manager, now = Date.now()) {
  for (const server of manager.servers) {
    if (!server.tempBans?.length || !manager.isActive(server.id)) continue;
    const due = server.tempBans.filter((b) => b.until <= now);
    if (!due.length) continue;
    const template = manager.template(server);
    const unban = template?.players?.commands?.unban || (isMinecraft(template) ? 'pardon {name}' : null);
    for (const ban of due) {
      try {
        if (unban) await manager.sendCommand(server.id, fill(unban, { name: ban.name }));
        manager.logActivity(server.id, { type: 'unban', name: ban.name, by: 'chat moderation' });
      } catch (err) {
        logger.warn(`Could not lift the ban on ${ban.name}: ${err.message}`);
        continue;
      }
      server.tempBans = server.tempBans.filter((b) => b !== ban);
    }
    manager.store.save();
  }
}

/** Whether chat can be read for this game. */
const supported = (template) => Boolean(template?.logPatterns?.chat || (isMinecraft(template) && template.id !== 'minecraft-bedrock'));

function update(manager, server, input) {
  if (!supported(manager.template(server))) fail(400, 'The panel cannot read chat for this game, so it cannot moderate it');
  server.moderation = validate(input, server.moderation);
  manager.store.save();
  return view(manager, server);
}

function view(manager, server) {
  const template = manager.template(server);
  return {
    supported: supported(template),
    settings: server.moderation || validate({}),
    canMute: Boolean(muteCommand(server, template)),
    tempBans: (server.tempBans || []).map((b) => ({ name: b.name, until: b.until, reason: b.reason })),
  };
}

module.exports = { validate, normalize, violation, onChat, tick, update, view, supported, muteCommand, ACTIONS };
