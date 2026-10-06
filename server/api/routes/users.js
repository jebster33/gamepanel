'use strict';

const { fail } = require('../../core/util');
const { CAPABILITIES, DEFAULT_PERMISSIONS, sanitizePermissions } = require('../../core/auth');

// Quick picks for the Access tab on a server.
const PRESETS = [
  { id: 'console', label: 'Console only', permissions: ['console', 'command'] },
  { id: 'power', label: 'Start and stop', permissions: ['power', 'console'] },
  { id: 'files', label: 'Files only', permissions: ['files', 'files.write'] },
  { id: 'full', label: 'Full server access', permissions: ['power', 'console', 'command', 'settings', 'schedules', 'files', 'files.write', 'mods', 'backups', 'backups.restore'] },
];

module.exports = (router, { store, auth, manager }, { requireAdmin }) => {
  require('./nodes')(router, { store, nodes: manager.nodes }, { requireAdmin });
  router.get('/api/users', ({ user }) => {
    requireAdmin(user);
    return { users: auth.users.map((u) => auth.publicUser(u)), capabilities: CAPABILITIES, defaults: DEFAULT_PERMISSIONS, requireAdmin2fa: Boolean(store.state.settings.requireAdmin2fa) };
  });

  /** The signed-in account's own quota and what it uses of it. */
  router.get('/api/quota', ({ user }) => {
    const quotas = require('../../features/quotas');
    if (user.role === 'admin') return { unlimited: true };
    return { quota: quotas.quotaFor(user), usage: quotas.usage(manager, user), canDeploy: auth.can(user, 'deploy') };
  });

  /** Sign-in rules for everyone. */
  router.put('/api/users/policy', ({ user, body }) => {
    requireAdmin(user);
    if (body.requireAdmin2fa !== undefined) {
      const on = Boolean(body.requireAdmin2fa);
      // Don't let anyone lock themselves out of the page that turns it off.
      const me = auth.users.find((u) => u.id === user.id);
      if (on && !me?.totp?.secret && !me?.passkeys?.length) fail(400, 'Turn on two-factor (or add a passkey) for your own account first (Account page).');
      store.state.settings.requireAdmin2fa = on;
      store.addEvent('user.policy', `${user.username} ${on ? 'now requires' : 'no longer requires'} two-factor sign-in for administrators`);
    }
    store.save();
    return { requireAdmin2fa: Boolean(store.state.settings.requireAdmin2fa) };
  });

  router.post('/api/users', ({ user, body }) => {
    requireAdmin(user);
    let created = auth.createUser(body);
    if (body.quota) {
      const record = auth.users.find((u) => u.id === created.id);
      record.quota = require('../../features/quotas').cleanQuota(body.quota);
      store.save();
      created = auth.publicUser(record);
    }
    store.addEvent('user.created', `User ${created.username} created by ${user.username}`);
    return { user: created };
  });

  router.patch('/api/users/:id', ({ user, params, body }) => {
    requireAdmin(user);
    const target = auth.users.find((u) => u.id === params.id);
    if (!target) fail(404, 'User not found');
    if (body.role) {
      if (target.id === user.id && body.role !== 'admin') fail(400, 'You cannot remove your own administrator role');
      target.role = body.role === 'admin' ? 'admin' : 'user';
    }
    if (Array.isArray(body.servers)) target.servers = body.servers;
    if (Array.isArray(body.permissions)) target.permissions = sanitizePermissions(body.permissions);
    if (body.quota) target.quota = require('../../features/quotas').cleanQuota(body.quota);
    if (body.password) auth.setPassword(target.id, body.password);
    // For someone who lost their phone and their recovery codes.
    if (body.resetTwoFactor) auth.disableTwoFactor(target.id);
    if (body.revokeSessions) auth.revokeSessions(target.id);
    store.save();
    store.addEvent('user.updated', `${target.username} updated by ${user.username}`);
    return { user: auth.publicUser(target) };
  });

  router.delete('/api/users/:id', ({ user, params }) => {
    requireAdmin(user);
    if (params.id === user.id) fail(400, 'You cannot delete your own account');
    auth.deleteUser(params.id);
    return { ok: true };
  });

  /* ------------------------------------------- sub-users on one server -- */

  router.get('/api/servers/:id/access', ({ user, params }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    return {
      users: auth.users.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        access: auth.canAccessServer(u, server.id),
        custom: Boolean(u.serverPerms?.[server.id]),
        permissions: auth.permissionsFor(u, server.id),
      })),
      capabilities: CAPABILITIES.filter((c) => c.group !== 'Panel'),
      presets: PRESETS,
    };
  });

  const grant = (target, serverId, permissions) => {
    if (target.role === 'admin') fail(400, 'Administrators already have every server');
    target.servers = [...new Set([...(target.servers || []), serverId])];
    target.serverPerms = { ...(target.serverPerms || {}), [serverId]: sanitizePermissions(permissions) };
  };

  /** Make a brand new account that only sees this server. */
  router.post('/api/servers/:id/access', ({ user, params, body }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    const permissions = sanitizePermissions(body.permissions);
    const created = auth.createUser({ username: body.username, password: body.password, role: 'user', servers: [server.id], permissions });
    grant(auth.users.find((u) => u.id === created.id), server.id, permissions);
    store.save();
    store.addEvent('user.created', `${user.username} added ${created.username} to ${server.name}`, { serverId: server.id });
    return { ok: true };
  });

  router.put('/api/servers/:id/access/:userId', ({ user, params, body }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    const target = auth.users.find((u) => u.id === params.userId);
    if (!target) fail(404, 'User not found');
    grant(target, server.id, body.permissions);
    store.save();
    store.addEvent('user.updated', `${user.username} set what ${target.username} can do on ${server.name}`, { serverId: server.id });
    return { ok: true };
  });

  router.delete('/api/servers/:id/access/:userId', ({ user, params }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    const target = auth.users.find((u) => u.id === params.userId);
    if (!target) fail(404, 'User not found');
    target.servers = (target.servers || []).filter((id) => id !== server.id);
    if (target.serverPerms) delete target.serverPerms[server.id];
    store.save();
    store.addEvent('user.updated', `${user.username} removed ${target.username} from ${server.name}`, { serverId: server.id });
    return { ok: true };
  });
};
