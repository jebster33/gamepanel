'use strict';

/**
 * Alerts to Discord (any webhook that speaks Discord's format, which
 * includes Guilded and most chat bridges), Slack, or ntfy (phone push with
 * no account: https://ntfy.sh/<topic>, or a self-hosted ntfy). Fire-and-forget:
 * a webhook that is down never affects the panel.
 */

const { logger } = require('../core/util');

const COLORS = { lockout: 0xff5f57, '2fa_disabled': 0xffb340, crashed: 0xff5f57, failed: 0xff5f57, install_failed: 0xff5f57, ready: 0xc6f432, installed: 0xc6f432, created: 0xc6f432, uploaded: 0xc6f432, upload_failed: 0xff5f57, verify_failed: 0xff5f57, updated: 0xffb340, resource_alert: 0xffb340, disk_low: 0xff5f57, watched: 0xffb340 };

const TITLES = {
  'server.crashed': 'Server crashed',
  'server.install_failed': 'Install failed',
  'server.installed': 'Server installed',
  'server.ready': 'Server is online',
  'server.stopped': 'Server stopped',
  'server.idle_stopped': 'Stopped while empty',
  'server.hung': 'Frozen server restarted',
  'server.world_reset': 'World reset',
  'server.wiped': 'Server wiped',
  'server.resource_alert': 'Resource alert',
  'player.watched': 'Watched player joined',
  'player.moderated': 'Chat moderation acted',
  'ban.appeal': 'New ban appeal',
  'panel.disk_low': 'Disk almost full',
  'user.api_key': 'API key created',
  'user.new_ip': 'Sign-in from a new address',
  'user.policy': 'Sign-in rules changed',
  'backup.created': 'Backup created',
  'backup.failed': 'Backup failed',
  'backup.verify_failed': 'Backup failed its check',
  'backup.uploaded': 'Backup copied to the cloud',
  'backup.upload_failed': 'Cloud backup failed',
  'schedule.failed': 'Scheduled task failed',
  'panel.updated': 'Panel updated',
  'panel.backup': 'Panel backup downloaded',
  'user.login': 'Sign-in',
  'user.lockout': 'Repeated failed sign-ins',
  'user.password': 'Password changed',
  'user.2fa_disabled': 'Two-factor sign-in turned off',
  'user.sessions_revoked': 'Signed out of other devices',
};

const EVENT_CHOICES = Object.keys(TITLES);

function colorFor(type) {
  const suffix = type.split('.').pop();
  return COLORS[suffix] ?? 0xa19f96;
}

async function postDiscord(url, event, panelName) {
  if (!/^https:\/\//.test(url)) throw new Error('The webhook must be an https:// URL');
  const title = TITLES[event.type] || event.type;
  const host = new URL(url).hostname;
  if (host === 'hooks.slack.com') return send(url, { 'Content-Type': 'application/json' }, JSON.stringify({ text: `*${title}*\n${event.message}` }));
  if (!/(^|\.)(discord|discordapp)\.com$/.test(host) && !/\/api\/webhooks\//.test(url)) {
    // ntfy: the body is the message, headers carry the rest.
    return send(url, { 'Content-Type': 'text/plain; charset=utf-8', Title: `${panelName || 'GamePanel'}: ${title}`.replace(/[^\x20-\x7e]/g, ''), Tags: colorFor(event.type) === 0xff5f57 ? 'rotating_light' : 'video_game' }, event.message);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: panelName || 'GamePanel',
      embeds: [
        {
          title: TITLES[event.type] || event.type,
          description: event.message,
          color: colorFor(event.type),
          timestamp: new Date(event.at || Date.now()).toISOString(),
        },
      ],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
}

async function send(url, headers, body) {
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
}

class Notifier {
  constructor(store) {
    this.store = store;
    this.recent = [];
    store.on('event', (event) => this.onEvent(event));
  }

  get settings() {
    return this.store.state.settings.notifications || {};
  }

  onEvent(event) {
    const { discordWebhook, events = [] } = this.settings;
    if (!discordWebhook || !events.includes(event.type)) return;
    // Discord allows ~30 messages a minute per webhook; stay well under it.
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= 20) return;
    this.recent.push(now);
    postDiscord(discordWebhook, event, this.store.state.settings.panelName).catch((err) => logger.debug(`Discord notification failed: ${err.message}`));
  }

  /** Send a test message and report the result to the caller. */
  async test(url) {
    await postDiscord(url || this.settings.discordWebhook, { type: 'panel.test', message: 'Notifications from GamePanel are working.', at: Date.now() }, this.store.state.settings.panelName);
    return { ok: true };
  }
}

module.exports = { Notifier, EVENT_CHOICES, TITLES };
