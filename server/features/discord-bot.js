'use strict';

/**
 * A Discord bot with slash commands: /status, /players, /whois, /start,
 * /stop, /restart. It connects out to Discord's gateway, so it works behind a home
 * router with no public address or open port.
 *
 * integrations.discordBot = { token, controllers: "123,456" }
 * Anyone in the bot's servers can look; only the listed Discord user IDs can
 * start, stop or restart.
 */

const { logger } = require('../core/util');
const { STATUS } = require('../servers/constants');

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const LIME = 0xc6f432;
const EPHEMERAL = 64;

const server = (required = true) => ({ type: 3, name: 'server', description: 'Which server', required, autocomplete: true });
const COMMANDS = [
  { name: 'status', description: 'Show every game server and who is online' },
  { name: 'players', description: 'Who is on a server right now', options: [server()] },
  { name: 'whois', description: 'When a player was last on, and how long they have played', options: [{ type: 3, name: 'player', description: 'Player name', required: true }] },
  { name: 'start', description: 'Start a server', options: [server()] },
  { name: 'stop', description: 'Stop a server', options: [server()] },
  { name: 'restart', description: 'Restart a server', options: [server()] },
];
const POWER = new Set(['start', 'stop', 'restart']);

class DiscordBot {
  constructor(store, manager) {
    this.store = store;
    this.manager = manager;
    this.ws = null;
    this.seq = null;
    this.timer = null;
    this.state = { status: 'off', error: null, user: null };
    this.retry = 0;
  }

  get settings() {
    return this.store.state.settings?.integrations?.discordBot || {};
  }

  status() {
    const s = this.settings;
    return { ...this.state, configured: Boolean(s.token), controllers: s.controllers || '', invite: this.state.appId ? `https://discord.com/oauth2/authorize?client_id=${this.state.appId}&scope=bot%20applications.commands&permissions=0` : null };
  }

  reload() {
    this.stop();
    if (!this.settings.token) return;
    if (typeof WebSocket !== 'function') {
      this.state = { status: 'error', error: 'The Discord bot needs Node.js 22 or newer.' };
      return;
    }
    this.connect();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    this.timer = null;
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }
    this.ws = null;
    this.state = { status: 'off', error: null };
  }

  connect() {
    this.state = { ...this.state, status: 'connecting', error: null };
    const ws = new WebSocket(GATEWAY);
    this.ws = ws;
    ws.onmessage = (event) => this.onPayload(JSON.parse(event.data)).catch((err) => logger.debug(`Discord bot: ${err.message}`));
    ws.onclose = (event) => {
      clearInterval(this.timer);
      // 4004: bad token. 4014: intents not allowed. Neither gets better by retrying.
      if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
        this.state = { status: 'error', error: event.code === 4004 ? 'Discord rejected the bot token' : `Discord closed the connection (${event.code})` };
        return;
      }
      this.state = { ...this.state, status: 'connecting' };
      const delay = Math.min(60_000, 2000 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  send(op, d) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ op, d }));
  }

  async onPayload({ op, d, s, t }) {
    if (s) this.seq = s;
    if (op === 10) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.send(1, this.seq), d.heartbeat_interval);
      this.send(2, { token: this.settings.token, intents: 0, properties: { os: process.platform, browser: 'gamepanel', device: 'gamepanel' } });
    } else if (op === 1) {
      this.send(1, this.seq);
    } else if (op === 7 || op === 9) {
      this.ws.close(4000);
    } else if (op === 0 && t === 'READY') {
      this.retry = 0;
      this.state = { status: 'online', error: null, user: `${d.user.username}`, appId: d.application.id };
      await this.rest('PUT', `/applications/${d.application.id}/commands`, COMMANDS).catch((err) => {
        this.state.error = `Could not register the slash commands: ${err.message}`;
      });
      logger.info(`Discord bot online as ${d.user.username}`);
    } else if (op === 0 && t === 'INTERACTION_CREATE') {
      await this.onInteraction(d);
    }
  }

  async rest(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bot ${this.settings.token}`, 'Content-Type': 'application/json', 'User-Agent': 'GamePanel (https://github.com/jebster33/gamepanel, 2)' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Discord answered ${res.status}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  reply(interaction, data) {
    return this.rest('POST', `/interactions/${interaction.id}/${interaction.token}/callback`, data);
  }

  findServer(query) {
    const q = String(query || '').toLowerCase();
    return this.manager.servers.find((s) => s.id === query) || this.manager.servers.find((s) => s.name.toLowerCase() === q);
  }

  async onInteraction(i) {
    const name = i.data?.name;
    const options = Object.fromEntries((i.data?.options || []).map((o) => [o.name, o.value]));

    if (i.type === 4) {
      // Autocomplete for the server option.
      const q = String(options.server || '').toLowerCase();
      const choices = this.manager.servers
        .filter((s) => !q || s.name.toLowerCase().includes(q))
        .slice(0, 25)
        .map((s) => ({ name: s.name.slice(0, 100), value: s.id }));
      return this.reply(i, { type: 8, data: { choices } });
    }
    if (i.type !== 2) return null;

    const userId = i.member?.user?.id || i.user?.id;
    const caller = i.member?.user?.username || i.user?.username || 'someone';
    const respond = (content, embeds, hidden = false) => this.reply(i, { type: 4, data: { content, embeds, flags: hidden ? EPHEMERAL : 0, allowed_mentions: { parse: [] } } });

    if (name === 'status') {
      const lines = this.manager.servers.map((s) => {
        const rt = this.manager.rt(s.id);
        const on = rt.status === STATUS.RUNNING;
        const count = rt.players ?? rt.playerList?.length ?? 0;
        return `${on ? '🟢' : rt.status === STATUS.STARTING ? '🟡' : '🔴'} **${clean(s.name)}** ${on ? `· ${count} online` : `· ${rt.status}`}`;
      });
      return respond(null, [{ title: this.store.state.settings?.panelName || 'GamePanel', description: lines.join('\n') || 'No servers yet.', color: LIME }]);
    }

    if (name === 'whois') {
      const wanted = String(options.player || '').trim().toLowerCase();
      const rows = (this.manager.searchPlayers?.(this.manager.servers.map((s) => s.id), wanted) || []).filter((p) => p.name.toLowerCase() === wanted);
      if (!rows.length) return respond(`Nobody called ${clean(options.player || '')} has played here.`, null, true);
      const hours = (sec) => (sec < 3600 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`);
      const total = rows.reduce((n, p) => n + p.seconds, 0);
      const lines = rows.map((p) => {
        const s = this.manager.servers.find((x) => x.id === p.serverId);
        return `**${clean(s?.name || p.serverId)}** · ${hours(p.seconds)} · ${p.online ? '🟢 online now' : `last seen <t:${Math.round(p.last / 1000)}:R>`}`;
      });
      return respond(null, [{ title: clean(rows[0].name), description: lines.join('\n'), color: LIME, footer: { text: `${hours(total)} played in total` } }]);
    }

    const target = this.findServer(options.server);
    if (!target) return respond('I could not find that server.', null, true);
    const rt = this.manager.rt(target.id);

    if (name === 'players') {
      const list = rt.playerList || [];
      return respond(null, [{ title: clean(target.name), description: list.length ? list.map(clean).join(', ') : 'Nobody is online.', color: LIME, footer: { text: `${list.length}${rt.maxPlayers ? ` / ${rt.maxPlayers}` : ''} players` } }]);
    }

    if (POWER.has(name)) {
      const allowed = String(this.settings.controllers || '').split(/[\s,]+/).filter(Boolean);
      if (!allowed.includes(String(userId))) return respond('Only people the panel admin listed can do that.', null, true);
      // Discord wants an answer within 3 seconds and a start can take longer (updates, containers):
      // say "thinking…" now, then edit that message when the action is done.
      await this.reply(i, { type: 5 });
      const edit = (content) => this.rest('PATCH', `/webhooks/${this.state.appId}/${i.token}/messages/@original`, { content, allowed_mentions: { parse: [] } });
      try {
        await this.manager[name](target.id);
      } catch (err) {
        return edit(`Could not ${name} ${clean(target.name)}: ${err.message}`);
      }
      this.store.addEvent(`server.${name}`, `${caller} used /${name} on ${target.name} from Discord`, { serverId: target.id });
      const verb = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' }[name];
      return edit(`${verb} **${clean(target.name)}**…`);
    }
    return null;
  }
}

/** Keep Discord markdown and mentions out of names. */
function clean(text) {
  return String(text).replace(/[*_`~|>@]/g, (c) => `\\${c}`);
}

let instance = null;
function init(app) {
  if (!instance) {
    instance = new DiscordBot(app.store, app.manager);
    setImmediate(() => instance.reload());
  }
  return instance;
}

module.exports = { init, DiscordBot, COMMANDS };
