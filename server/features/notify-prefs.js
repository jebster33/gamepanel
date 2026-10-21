'use strict';

/**
 * Who hears about what. Each account can mute whole categories (crashes,
 * backups, sign-ins…) and single servers; a phone or browser subscription can
 * carry its own mutes that replace the account's. Muted things are never
 * sent: the bell, desktop notifications and phone push all ask `allows`.
 *
 * Also: one-time action tokens, so a notification can carry buttons
 * ("Restart", "Start") that call the panel without opening it.
 */

const crypto = require('crypto');

const CATEGORIES = [
  { id: 'crashes', label: 'Crashes and freezes', types: ['server.crashed', 'server.hung'] },
  { id: 'installs', label: 'Installs and updates of a server', types: ['server.install_failed', 'server.installed', 'server.moved', 'server.move_failed', 'server.world_reset', 'server.wiped'] },
  { id: 'backups', label: 'Backups', prefix: 'backup.', types: ['schedule.failed'] },
  { id: 'signins', label: 'Sign-ins and account security', prefix: 'user.' },
  { id: 'resources', label: 'Resource alerts (CPU, memory, disk)', types: ['server.resource_alert', 'panel.disk_low'] },
  { id: 'status', label: 'Servers starting and stopping', types: ['server.ready', 'server.stopped', 'server.idle_stopped', 'server.woken'] },
  { id: 'players', label: 'Players and ban appeals', types: ['player.watched', 'player.moderated', 'ban.appeal'] },
  { id: 'updates', label: 'Panel updates', types: ['panel.updated', 'panel.https_failed', 'panel.backup'] },
  { id: 'reports', label: 'Monthly reports', types: ['panel.report'] },
  { id: 'other', label: 'Everything else', types: [] },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

function categoryOf(type) {
  const t = String(type || '');
  for (const c of CATEGORIES) if (c.types?.includes(t)) return c.id;
  for (const c of CATEGORIES) if (c.prefix && t.startsWith(c.prefix)) return c.id;
  return 'other';
}

const MAX_SERVERS = 500;

/** Clean what a client sent into { mutedCategories, mutedServers }. */
function sanitize(input, knownServerIds) {
  const cats = Array.isArray(input?.mutedCategories) ? input.mutedCategories.filter((c) => CATEGORY_IDS.includes(c)) : [];
  const servers = Array.isArray(input?.mutedServers) ? input.mutedServers.filter((s) => typeof s === 'string' && s.length <= 80 && (!knownServerIds || knownServerIds.includes(s))) : [];
  return { mutedCategories: [...new Set(cats)], mutedServers: [...new Set(servers)].slice(0, MAX_SERVERS) };
}

/** Does this person (these prefs) want to hear about this event? `prefs` may be undefined: everything on. */
function allows(prefs, event) {
  if (!prefs) return true;
  if (prefs.mutedCategories?.includes(categoryOf(event.type))) return false;
  if (event.serverId && prefs.mutedServers?.includes(event.serverId)) return false;
  return true;
}

const userPrefs = (store, userId) => store.state.userPrefs?.[userId]?.notify;

function saveUserPrefs(store, userId, notify) {
  const all = (store.state.userPrefs ||= {});
  all[userId] = { ...(all[userId] || {}), notify };
  store.save();
}

/** What applies to one subscription: its own mutes if it has any, else the account's. */
const effective = (store, sub) => sub?.prefs || userPrefs(store, sub?.userId);

/* ------------------------------------------------------- action buttons -- */

const ACTION_TTL = 24 * 3600_000;
const POWER_ACTIONS = { restart: 'Restart', start: 'Start' };

/** Which buttons a notification gets for this event, before any token is minted. */
function actionsFor(event) {
  if (!event.serverId) return [];
  switch (event.type) {
    case 'server.crashed':
    case 'server.hung':
      return ['restart', 'console'];
    case 'server.stopped':
    case 'server.idle_stopped':
      return ['start', 'console'];
    case 'server.install_failed':
    case 'server.resource_alert':
      return ['console'];
    default:
      return [];
  }
}

class ActionTokens {
  constructor() {
    this.key = crypto.randomBytes(32);
    // Tokens only count while they are in this map, so a restart of the panel
    // voids every outstanding one and a used one cannot be replayed.
    this.issued = new Map();
  }

  sign(body) {
    return crypto.createHmac('sha256', this.key).update(body).digest('base64url');
  }

  mint({ userId, serverId, action }, now = Date.now()) {
    if (this.issued.size >= 5000) this.sweep(now);
    if (this.issued.size >= 5000) this.issued.delete(this.issued.keys().next().value);
    const n = crypto.randomBytes(18).toString('base64url');
    this.issued.set(n, now + ACTION_TTL);
    const body = Buffer.from(JSON.stringify({ u: userId, s: serverId, a: action, n, e: now + ACTION_TTL })).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /** The token's contents, once. null when forged, expired or already used. */
  consume(token, now = Date.now()) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const want = Buffer.from(this.sign(body));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    let p;
    try {
      p = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      return null;
    }
    const until = this.issued.get(p.n);
    if (!until || until < now || p.e < now) {
      this.issued.delete(p.n);
      return null;
    }
    this.issued.delete(p.n);
    return { userId: p.u, serverId: p.s, action: p.a };
  }

  sweep(now = Date.now()) {
    for (const [n, until] of this.issued) if (until < now) this.issued.delete(n);
  }
}

const tokens = new ActionTokens();

/**
 * The buttons and tokens for one person and event: only the actions their
 * account may do on that server. Returns { actions: [{action,title}], tokens: {action: token} }.
 */
function buttonsFor({ auth, user, event }) {
  const actions = [];
  const minted = {};
  const can = (cap) => typeof auth.can === 'function' && auth.can(user, cap, event.serverId);
  for (const a of actionsFor(event)) {
    if (a === 'console') {
      if (can('console')) actions.push({ action: 'console', title: 'Open console' });
    } else if (POWER_ACTIONS[a] && can('power')) {
      actions.push({ action: a, title: POWER_ACTIONS[a] });
      minted[a] = tokens.mint({ userId: user.id, serverId: event.serverId, action: a });
    }
  }
  // Browsers show two or three buttons at most.
  return { actions: actions.slice(0, 2), tokens: minted };
}

module.exports = { CATEGORIES, categoryOf, sanitize, allows, userPrefs, saveUserPrefs, effective, actionsFor, buttonsFor, ActionTokens, tokens, POWER_ACTIONS };
