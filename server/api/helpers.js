'use strict';

/** Access checks and request helpers shared by every route file. */

const { fail, SECRET_NAME } = require('../core/util');
const { config } = require('../core/config');
const { CAPABILITIES } = require('../core/auth');

function createHelpers({ auth, manager, store }) {
  const requireAdmin = (user) => {
    if (!user || user.role !== 'admin') fail(403, 'Only administrators can do that');
  };

  /** Capability gate for non-admin accounts. */
  const requireCap = (user, capability, serverId) => {
    if (!auth.can(user, capability, serverId)) {
      const label = CAPABILITIES.find((c) => c.id === capability)?.label || capability;
      fail(403, `Your account is not allowed to: ${label.toLowerCase()}`);
    }
  };

  const serverFor = (user, id, capability) => {
    const server = manager.require(id);
    if (!auth.canAccessServer(user, server.id)) fail(403, 'You do not have access to this server');
    if (capability) requireCap(user, capability, server.id);
    return server;
  };

  const visibleServers = (user) => manager.servers.filter((s) => auth.canAccessServer(user, s.id)).map((s) => redactServer(auth, user, manager.publicServer(s)));

  const serverView = (user, server) => redactServer(auth, user, manager.publicServer(server));

  const integrations = () => store.state.settings.integrations || {};

  return { requireAdmin, requireCap, serverFor, visibleServers, serverView, integrations };
}

/**
 * One account's view of a server (manager.publicServer output). Passwords in
 * its variables and the start command are for whoever may edit them.
 */
function redactServer(auth, user, server) {
  if (!server || user?.role === 'admin' || auth.can(user, 'settings', server.id)) return server;
  const vars = Object.fromEntries(Object.entries(server.vars || {}).filter(([name]) => !SECRET_NAME.test(name)));
  return { ...server, vars, startCommand: undefined };
}

/**
 * What a signed-in WebSocket may receive of a broadcast: only the servers its
 * account can see, console lines only with console access, and nothing once
 * the account is deleted or its sessions are revoked. null drops the message.
 */
function scopeBroadcast(auth, conn, topic, payload) {
  const user = conn.user;
  if (!auth.users.includes(user) || (user.sessionEpoch || 0) !== conn.epoch) {
    conn.close(4001, 'Signed out');
    return null;
  }
  if (user.role === 'admin') return payload;
  const consoleOf = topic.startsWith('console:') ? topic.slice(8) : null;
  if (consoleOf && !(auth.canAccessServer(user, consoleOf) && auth.can(user, 'console', consoleOf))) return null;
  if (payload.serverId && !auth.canAccessServer(user, payload.serverId)) return null;
  const out = { ...payload };
  if (Array.isArray(out.servers)) out.servers = out.servers.filter((s) => auth.canAccessServer(user, s?.id)).map((s) => redactServer(auth, user, s));
  if (out.server) out.server = redactServer(auth, user, out.server);
  return out;
}

/** False when a browser says the request comes from another site's page. No Origin (scripts, curl) is fine. */
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function clientIp(req) {
  if (config.behindProxy) {
    const fwd = req.headers['x-forwarded-for'];
    // The last hop is the one our proxy added; earlier entries are whatever
    // the client sent and could be forged to dodge the sign-in lockout.
    if (fwd) return String(fwd).split(',').pop().trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  return config.behindProxy && String(req.headers['x-forwarded-proto'] || '').includes('https');
}

module.exports = { createHelpers, clientIp, isSecure, sameOrigin, redactServer, scopeBroadcast };
