'use strict';

/**
 * Notifications in the web panel: every event the panel records (crashes,
 * installs, backups, sign-ins…) is pushed over the live socket to the people
 * allowed to see it, and the bell in the top bar lists the recent ones.
 */

const { TITLES } = require('./notify');
const prefs = require('./notify-prefs');

// Shown as a pop-up as well as in the list.
const LOUD = /\.(crashed|install_failed|failed|upload_failed|verify_failed|test_failed|flood_blocked|disk_low|lockout|hung|resource_alert|watched|ready|installed)$/;

/** Same rule as the activity log: account events are for administrators only. */
function visibleTo(auth, user, event) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (event.type.startsWith('user.') || event.type.startsWith('panel.') || event.type.startsWith('security.') || event.type.startsWith('settings.')) return false;
  return Boolean(event.serverId) && auth.canAccessServer(user, event.serverId);
}

function shape(event) {
  const level = /(crashed|failed|lockout|disk_low)$/.test(event.type) ? 'error' : /(alert|hung|watched|2fa_disabled|new_ip)$/.test(event.type) ? 'warn' : 'info';
  return {
    id: event.id,
    type: event.type,
    title: TITLES[event.type] || null,
    message: event.message,
    serverId: event.serverId || null,
    at: event.at,
    level,
    loud: LOUD.test(event.type),
  };
}

function list(store, auth, user, limit = 40) {
  const mine = prefs.userPrefs(store, user.id);
  return store.state.events
    .filter((e) => visibleTo(auth, user, e) && prefs.allows(mine, e))
    .slice(0, limit)
    .map(shape);
}

/** Forward new events to every signed-in browser that may see them. */
function start({ store, auth, wss }) {
  store.on('event', (event) => {
    const note = shape(event);
    for (const client of wss.clients) {
      if (!client.user || client.closed) continue;
      // The account may have changed since the socket opened (removed, demoted).
      const user = auth.users.find((u) => u.id === client.user.id);
      if (!visibleTo(auth, user, event) || !prefs.allows(prefs.userPrefs(store, user.id), event)) continue;
      // Action buttons (Restart, Start…) come with one-time tokens for this account only.
      const buttons = prefs.buttonsFor({ auth, user, event });
      client.send({ topic: 'notification', notification: { ...note, actions: buttons.actions, tokens: buttons.tokens } });
    }
  });
}

module.exports = { start, list, visibleTo, shape };
