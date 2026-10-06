'use strict';

/** Access checks and request helpers shared by every route file. */

const { fail } = require('../core/util');
const { config } = require('../core/config');
const { CAPABILITIES } = require('../core/auth');

function createHelpers({ auth, manager, store }) {
  const requireAdmin = (user) => {
    if (!user || user.role !== 'admin') fail(403, 'Only administrators can do that');
  };

  /** Capability gate for non-admin accounts. */
  const requireCap = (user, capability) => {
    if (!auth.can(user, capability)) {
      const label = CAPABILITIES.find((c) => c.id === capability)?.label || capability;
      fail(403, `Your account is not allowed to: ${label.toLowerCase()}`);
    }
  };

  const serverFor = (user, id, capability) => {
    const server = manager.require(id);
    if (!auth.canAccessServer(user, server.id)) fail(403, 'You do not have access to this server');
    if (capability) requireCap(user, capability);
    return server;
  };

  const visibleServers = (user) => manager.servers.filter((s) => auth.canAccessServer(user, s.id)).map((s) => manager.publicServer(s));

  const integrations = () => store.state.settings.integrations || {};

  return { requireAdmin, requireCap, serverFor, visibleServers, integrations };
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

module.exports = { createHelpers, clientIp, isSecure };
