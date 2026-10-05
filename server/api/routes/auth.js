'use strict';

const { fail } = require('../../core/util');
const { verifyPassword } = require('../../core/auth');
const { clientIp, isSecure } = require('../helpers');
const VERSION = require('../../../package.json').version;

module.exports = (router, { store, auth }) => {
  router.get(
    '/api/status',
    () => ({ ok: true, version: VERSION, panelName: store.state.settings.panelName, setupRequired: auth.needsSetup() }),
    { public: true }
  );

  router.post(
    '/api/setup',
    async ({ body }) => {
      if (!auth.needsSetup()) fail(409, 'The panel is already set up');
      const user = auth.createUser({ username: body.username, password: body.password, role: 'admin' });
      store.addEvent('user.created', `First administrator ${user.username} created`);
      return { ok: true, user };
    },
    { public: true }
  );

  router.post(
    '/api/auth/login',
    async ({ body, req, res }) => {
      const ip = clientIp(req);
      const { token, user } = auth.login(body.username, body.password, ip);
      res.setHeader('Set-Cookie', auth.cookieHeader(token, isSecure(req)));
      const event = store.addEvent('user.login', `${user.username} signed in`, { ip });
      // A location lookup must never slow a sign-in down; fill it in afterwards.
      require('../../features/geoip')
        .locate(ip, { enabled: store.state.settings.geoLookup !== false })
        .then((location) => {
          if (!location) return;
          event.location = location;
          store.save();
        })
        .catch(() => {});
      return { ok: true, user, token };
    },
    { public: true }
  );

  router.post(
    '/api/auth/logout',
    async ({ res }) => {
      res.setHeader('Set-Cookie', auth.clearCookieHeader());
      return { ok: true };
    },
    { public: true }
  );

  router.get('/api/auth/me', ({ user }) => ({ user: auth.publicUser(user) }));

  router.post('/api/auth/password', async ({ user, body }) => {
    const record = auth.users.find((u) => u.id === user.id);
    if (!verifyPassword(body.currentPassword, record.password)) fail(403, 'Your current password is not right');
    auth.setPassword(user.id, body.newPassword);
    return { ok: true };
  });
};
