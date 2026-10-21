'use strict';

/**
 * Getting-started checklist, tracked per account. Most steps tick themselves
 * from what the panel can see (a server exists, 2FA is on...); the rest, and
 * "I don't need this", are ticked by hand. State lives on the user record:
 * user.onboarding = { done: { id: timestamp }, hidden, tourDone, seenNews }.
 */

const NEWS_ID = '2026-10-ux';
const ID_RE = /^[a-z0-9-]{1,32}$/;

/** Every step: who sees it and how it ticks itself. */
const ITEMS = [
  { id: 'server', label: 'Create your first server', hint: 'Pick a game on the Games page. The panel does the download and ports.', link: '#/templates', needs: 'deploy', auto: (c) => c.servers.length > 0 },
  { id: 'online', label: 'Start a server and see it come online', hint: 'Press Start on the server page and watch the console.', link: '#/servers', needs: 'power', auto: (c) => c.servers.some((s) => c.manager.isActive?.(s.id) || s.lastExit) },
  { id: 'ports', label: 'Open its ports so friends can join', hint: 'The Settings tab of a server has a one-click port opener.', link: '#/servers', admin: true, auto: (c) => (c.store.state.events || []).some((e) => e.type === 'network.opened') },
  { id: 'backups', label: 'Set up backups', hint: 'Schedule a backup, or make one by hand on the Backups tab.', link: '#/servers', needs: 'backups', auto: (c) => c.servers.some((s) => (s.schedules || []).some((x) => x.action === 'backup')) },
  { id: '2fa', label: 'Turn on two-factor sign-in', hint: 'An authenticator app or a passkey protects the account if the password leaks.', link: '#/account', auto: (c) => Boolean(c.record?.totp?.secret || c.record?.passkeys?.length) },
  { id: 'staff', label: 'Invite staff or friends', hint: 'Give them an account with only the servers and permissions they need.', link: '#/users', admin: true, auto: (c) => c.auth.users.length > 1 },
  { id: 'discord', label: 'Set up Discord alerts', hint: 'Crash, backup and update alerts to a channel through a webhook.', link: '#/settings/notifications', admin: true, auto: (c) => Boolean(c.store.state.settings.notifications?.discordWebhook || c.store.state.settings.integrations?.discordBot?.token) },
  { id: 'tour', label: 'Take the panel tour', hint: 'A two-minute walk past the main parts. Replay it from the Account page.', link: '#/account', auto: (c) => Boolean(c.record?.onboarding?.tourDone) },
];

function recordOf(app, user) {
  return app.auth.users.find((u) => u.id === user.id);
}

/** The steps this account can use at all. */
function applicable(app, user) {
  return ITEMS.filter((i) => (i.admin ? user.role === 'admin' : i.needs ? app.auth.can(user, i.needs) : true));
}

function view(app, user) {
  const record = recordOf(app, user) || {};
  const saved = record.onboarding || {};
  const done = saved.done || {};
  const servers = app.manager.servers.filter((s) => app.auth.canAccessServer(user, s.id));
  const ctx = { store: app.store, manager: app.manager, auth: app.auth, servers, record };
  const items = applicable(app, user).map((i) => {
    const auto = Boolean(i.auto(ctx));
    return { id: i.id, label: i.label, hint: i.hint, link: i.link, done: auto || Boolean(done[i.id]), auto, skipped: !auto && Boolean(done[i.id]) };
  });
  return { items, hidden: Boolean(saved.hidden), tourDone: Boolean(saved.tourDone), newsId: NEWS_ID, newsSeen: saved.seenNews === NEWS_ID };
}

/** Apply one change from the account itself. Unknown fields are ignored. */
function update(app, user, body) {
  const record = recordOf(app, user);
  if (!record) return view(app, user);
  const o = (record.onboarding = record.onboarding || {});
  o.done = o.done || {};
  if (typeof body.id === 'string') {
    if (!ID_RE.test(body.id) || !ITEMS.some((i) => i.id === body.id)) return view(app, user);
    if (body.done === false) delete o.done[body.id];
    else o.done[body.id] = Date.now();
  }
  if (body.hidden !== undefined) o.hidden = Boolean(body.hidden);
  if (body.tourDone !== undefined) {
    o.tourDone = Boolean(body.tourDone);
    if (o.tourDone) o.done.tour = o.done.tour || Date.now();
    else delete o.done.tour;
  }
  if (body.seenNews === NEWS_ID) o.seenNews = NEWS_ID;
  app.store.save();
  return view(app, user);
}

function reset(app, user) {
  const record = recordOf(app, user);
  if (record) {
    delete record.onboarding;
    app.store.save();
  }
  return view(app, user);
}

module.exports = { ITEMS, NEWS_ID, view, update, reset };
