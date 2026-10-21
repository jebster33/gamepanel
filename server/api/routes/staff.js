'use strict';

const { fail } = require('../../core/util');
const { CAPABILITIES } = require('../../core/auth');
const staff = require('../../features/staff');

module.exports = (router, { store, auth, manager }, { requireAdmin }) => {
  /** Who moderated what, per staff member. Administrators only. */
  router.get('/api/staff/activity', ({ user }) => {
    requireAdmin(user);
    return staff.summary({ store, auth });
  });

  /* ------------------------------------------------- reason templates -- */

  // Everyone signed in can pick one in a ban or kick dialog; only administrators change them.
  router.get('/api/staff/reasons', () => ({ templates: staff.reasonList(store) }));

  router.post('/api/staff/reasons', ({ user, body }) => {
    requireAdmin(user);
    return { template: staff.saveReason(store, body) };
  });

  router.put('/api/staff/reasons/:id', ({ user, params, body }) => {
    requireAdmin(user);
    return { template: staff.saveReason(store, body, params.id) };
  });

  router.delete('/api/staff/reasons/:id', ({ user, params }) => {
    requireAdmin(user);
    staff.deleteReason(store, params.id);
    return { ok: true };
  });

  /* --------------------------------------------------- role templates -- */

  router.get('/api/staff/roles', ({ user }) => {
    requireAdmin(user);
    return { roles: staff.roles(store), capabilities: CAPABILITIES.filter((c) => c.group !== 'Panel' || c.id === 'activity') };
  });

  router.post('/api/staff/roles', ({ user, body }) => {
    requireAdmin(user);
    return { role: staff.saveRole(store, body) };
  });

  router.put('/api/staff/roles/:id', ({ user, params, body }) => {
    requireAdmin(user);
    return { role: staff.saveRole(store, body, params.id) };
  });

  router.delete('/api/staff/roles/:id', ({ user, params }) => {
    requireAdmin(user);
    staff.deleteRole(store, params.id);
    return { roles: staff.roles(store) };
  });

  /** Apply a role template to a sub-user on one server (same result as ticking the boxes in the Access tab). */
  router.post('/api/servers/:id/access/:userId/role', ({ user, params, body }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    const { user: target, permissions } = staff.applyRole(store, auth, server.id, params.userId, String(body?.role || ''));
    store.addEvent('user.updated', `${user.username} gave ${target.username} the ${staff.roles(store).find((r) => r.id === body.role)?.name} role on ${server.name}`, { serverId: server.id });
    return { ok: true, permissions };
  });

  /* ------------------------------------------------ time-limited access -- */

  router.get('/api/servers/:id/access-grants', ({ user, params }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    return { grants: staff.grantsFor(store, server.id), roles: staff.roles(store), now: Date.now() };
  });

  router.post('/api/servers/:id/access-grants', ({ user, params, body }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    if (!body?.userId) fail(400, 'Choose a user');
    const grant = staff.createGrant(
      store,
      auth,
      { serverId: server.id, userId: String(body.userId), role: body.role ? String(body.role) : undefined, permissions: body.permissions, hours: body.hours, until: body.until },
      Date.now(),
      user.username
    );
    store.addEvent('user.updated', `${user.username} gave ${grant.username} access to ${server.name} until ${new Date(grant.expiresAt).toISOString()}`, { serverId: server.id });
    return { grant };
  });

  router.delete('/api/servers/:id/access-grants/:grantId', ({ user, params }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    staff.revokeGrant(store, auth, manager, server.id, params.grantId, user.username);
    return { ok: true };
  });
};
