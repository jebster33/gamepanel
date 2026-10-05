'use strict';

const { fail } = require('../../core/util');
const { CAPABILITIES, DEFAULT_PERMISSIONS, sanitizePermissions } = require('../../core/auth');

module.exports = (router, { store, auth }, { requireAdmin }) => {
  router.get('/api/users', ({ user }) => {
    requireAdmin(user);
    return { users: auth.users.map((u) => auth.publicUser(u)), capabilities: CAPABILITIES, defaults: DEFAULT_PERMISSIONS };
  });

  router.post('/api/users', ({ user, body }) => {
    requireAdmin(user);
    const created = auth.createUser(body);
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
};
