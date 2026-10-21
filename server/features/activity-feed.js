'use strict';

/**
 * The dashboard's "who did what" feed: what staff changed (from the audit
 * log, administrators only) mixed with what happened (events: starts, stops,
 * crashes, backups, wipes), newest first. Each person sees only what they
 * could see on the Activity page.
 */

const audit = require('./audit');
const { visibleTo } = require('./live-notifications');

function build(store, auth, user, limit = 25) {
  const out = [];
  for (const e of store.state.events) {
    if (!visibleTo(auth, user, e) || /^(user\.login|server\.metrics)/.test(e.type)) continue;
    out.push({ at: e.at, who: null, text: e.message, type: e.type, serverId: e.serverId || null });
    if (out.length >= limit * 2) break;
  }
  if (user.role === 'admin') {
    for (const a of audit.list({ limit: limit * 3 })) {
      if (!a.user || (a.status && a.status >= 400) || /^get /i.test(a.action || '')) continue;
      if (/sign.?in|login|logout|session/i.test(a.action || '')) continue;
      // An event usually says the same thing a moment later; the audit entry adds the name.
      if (out.some((o) => Math.abs(o.at - a.at) < 4000 && o.serverId && o.serverId === a.serverId && o.text?.toLowerCase().includes(String(a.user).toLowerCase()))) continue;
      out.push({ at: a.at, who: a.user, text: a.server ? `${a.action} (${a.server})` : a.action, type: 'audit', serverId: a.serverId || null });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

module.exports = { build };
