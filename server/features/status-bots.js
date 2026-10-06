'use strict';

/**
 * Player counts in Discord's member list: a bot whose status reads
 * "25/200 players". The panel's own Discord bot can show it (for every server
 * together, or one), and extra "status bots" can be added, one per server,
 * the way big communities show each server in the sidebar. A status bot only
 * needs a token: it never reads messages and needs no permissions.
 *
 * settings.integrations.discordBot.presence = { mode: 'off'|'all'|'server', serverId, format, style }
 * settings.statusBots = [{ id, token (sealed), serverId, format, style }]
 */

const { uid, fail, logger } = require('../core/util');
const secrets = require('../core/secrets');

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const TICK_MS = 20_000;
const STYLES = { custom: 4, playing: 0, watching: 3 };
const DEFAULT_FORMAT = '{online}/{max} players';

/* ------------------------------------------------------------- the text -- */

/** What the status should say for one server, or all of them. */
function presenceFor(manager, { serverId = null, format = DEFAULT_FORMAT, style = 'custom' } = {}) {
  const servers = serverId ? manager.servers.filter((s) => s.id === serverId) : manager.servers;
  if (!servers.length) return { text: 'No server', status: 'dnd', style };
  const live = servers.map((s) => ({ s, rt: manager.rt(s.id) }));
  const running = live.filter((x) => x.rt.status === 'running');
  const starting = live.some((x) => ['starting', 'installing'].includes(x.rt.status));
  if (!running.length) {
    return starting ? { text: 'Starting…', status: 'idle', style } : { text: serverId ? 'Server offline' : 'All servers offline', status: 'dnd', style };
  }
  const online = running.reduce((n, x) => n + (Number(x.rt.players ?? x.rt.playerList?.length) || 0), 0);
  const max = running.reduce((n, x) => n + (Number(x.rt.maxPlayers ?? x.s.maxPlayers) || 0), 0);
  const text = String(format || DEFAULT_FORMAT)
    .replace(/\{online\}/g, String(online))
    .replace(/\{max\}/g, String(max))
    .replace(/\{server\}/g, servers.length === 1 ? servers[0].name : `${running.length} servers`)
    .replace(/\{servers\}/g, String(running.length))
    .slice(0, 120);
  return { text, status: 'online', style };
}

/** The gateway's presence object. */
function activity({ text, status, style }) {
  const type = STYLES[style] ?? 4;
  return {
    since: null,
    afk: false,
    status,
    activities: [type === 4 ? { type: 4, name: 'Custom Status', state: text } : { type, name: text }],
  };
}

/* --------------------------------------------------------- a status bot -- */

/** A bot that only connects and sets its status. */
class PresenceBot {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.seq = null;
    this.timer = null;
    this.retry = 0;
    this.presence = null;
    this.state = { status: 'connecting', user: null, error: null };
    this.stopped = false;
  }

  start() {
    if (typeof WebSocket !== 'function') {
      this.state = { status: 'error', error: 'Status bots need Node.js 22 or newer' };
      return;
    }
    const ws = new WebSocket(GATEWAY);
    this.ws = ws;
    ws.onmessage = (event) => {
      try {
        this.onPayload(JSON.parse(event.data));
      } catch (err) {
        logger.debug(`Status bot: ${err.message}`);
      }
    };
    ws.onclose = (event) => {
      clearInterval(this.timer);
      if (this.stopped) return;
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
        this.state = { status: 'error', user: null, error: event.code === 4004 ? 'Discord rejected the token' : `Discord closed the connection (${event.code})` };
        return;
      }
      this.state = { ...this.state, status: 'connecting' };
      this.reconnect = setTimeout(() => this.start(), Math.min(60_000, 2000 * 2 ** this.retry++));
    };
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.reconnect);
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  send(op, d) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op, d }));
  }

  onPayload({ op, d, s, t }) {
    if (s) this.seq = s;
    if (op === 10) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.send(1, this.seq), d.heartbeat_interval);
      this.send(2, { token: this.token, intents: 0, properties: { os: process.platform, browser: 'gamepanel', device: 'gamepanel' }, ...(this.presence ? { presence: activity(this.presence) } : {}) });
    } else if (op === 1) this.send(1, this.seq);
    else if (op === 7 || op === 9) this.ws.close(4000);
    else if (op === 0 && t === 'READY') {
      this.retry = 0;
      this.state = { status: 'online', user: d.user?.username || null, error: null };
    }
  }

  set(presence) {
    this.presence = presence;
    if (this.state.status === 'online') this.send(3, activity(presence));
  }
}

/* ------------------------------------------------------------ the runner -- */

const bots = new Map(); // id -> { bot, key }
let ctx = null;
let lastText = new Map();

function config(store) {
  return {
    main: { mode: 'off', serverId: '', format: DEFAULT_FORMAT, style: 'custom', ...(store.state.settings.integrations?.discordBot?.presence || {}) },
    bots: store.state.settings.statusBots || [],
  };
}

/** Start, stop or restart the extra bots to match the settings. */
function sync() {
  if (!ctx) return;
  const { bots: wanted } = config(ctx.store);
  for (const [id, entry] of bots) {
    const w = wanted.find((b) => b.id === id);
    if (!w || w.token !== entry.key) {
      entry.bot.stop();
      bots.delete(id);
      lastText.delete(id);
    }
  }
  for (const w of wanted) {
    if (bots.has(w.id)) continue;
    const token = secrets.open(w.token);
    if (!token) continue;
    const bot = new PresenceBot(token);
    bots.set(w.id, { bot, key: w.token });
    bot.start();
  }
  tick();
}

function tick() {
  if (!ctx) return;
  const { manager, store } = ctx;
  const { main, bots: wanted } = config(store);
  const push = (key, target, presence) => {
    const sig = JSON.stringify(presence);
    if (lastText.get(key) === sig && target.state?.status === 'online') return;
    lastText.set(key, sig);
    target.set(presence);
  };
  const mainBot = require('./discord-bot').instance();
  if (mainBot && main.mode !== 'off' && mainBot.state.status === 'online') {
    push('main', { state: mainBot.state, set: (p) => mainBot.setPresence(activity(p)) }, presenceFor(manager, { serverId: main.mode === 'server' ? main.serverId : null, format: main.format, style: main.style }));
  } else if (mainBot && main.mode === 'off' && lastText.has('main')) {
    lastText.delete('main');
    mainBot.setPresence(null);
  }
  for (const w of wanted) {
    const entry = bots.get(w.id);
    if (entry) push(w.id, entry.bot, presenceFor(manager, { serverId: w.serverId, format: w.format, style: w.style }));
  }
}

function start(app) {
  ctx = app;
  sync();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  // Starts and stops show up sooner than the next tick.
  app.store.on('event', (e) => {
    if (/^server\.(started|stopped|crashed|ready)$/.test(e.type)) setTimeout(tick, 1500);
  });
}

/* ------------------------------------------------------------- settings -- */

const cleanFormat = (f) => String(f || DEFAULT_FORMAT).replace(/[\r\n]/g, ' ').trim().slice(0, 100) || DEFAULT_FORMAT;
const cleanStyle = (s) => (STYLES[s] !== undefined ? s : 'custom');

function update(store, manager, input = {}) {
  const s = store.state.settings;
  if (input.main) {
    const mode = ['off', 'all', 'server'].includes(input.main.mode) ? input.main.mode : 'off';
    if (mode === 'server' && !manager.servers.some((x) => x.id === input.main.serverId)) fail(400, 'Pick the server the bot shows');
    s.integrations = { ...(s.integrations || {}) };
    s.integrations.discordBot = { ...(s.integrations.discordBot || {}), presence: { mode, serverId: mode === 'server' ? input.main.serverId : '', format: cleanFormat(input.main.format), style: cleanStyle(input.main.style) } };
  }
  if (Array.isArray(input.bots)) {
    const before = s.statusBots || [];
    const next = [];
    for (const b of input.bots.slice(0, 25)) {
      const old = before.find((x) => x.id === b.id);
      const token = b.token ? String(b.token).trim() : null;
      if (!old && !token) fail(400, 'Paste the token of the new status bot');
      if (token && !/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(token)) fail(400, 'That does not look like a Discord bot token');
      if (!manager.servers.some((x) => x.id === b.serverId)) fail(400, 'Pick the server each status bot shows');
      next.push({ id: old?.id || uid(6), token: token ? secrets.seal(token) : old.token, serverId: b.serverId, format: cleanFormat(b.format), style: cleanStyle(b.style) });
    }
    s.statusBots = next;
  }
  store.save();
  sync();
  return view(store);
}

function view(store) {
  const { main, bots: list } = config(store);
  return {
    main,
    bots: list.map((b) => ({ id: b.id, serverId: b.serverId, format: b.format, style: b.style, ...(bots.get(b.id)?.bot.state || { status: 'off' }) })),
    preview: ctx ? presenceFor(ctx.manager, { serverId: main.mode === 'server' ? main.serverId : null, format: main.format }).text : null,
  };
}

module.exports = { start, update, view, presenceFor, activity, PresenceBot, DEFAULT_FORMAT };
