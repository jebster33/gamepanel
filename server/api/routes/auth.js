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
      const result = auth.login(body.username, body.password, ip);
      // Password was right, now the authenticator code.
      if (result.twoFactor) return { ok: true, twoFactor: true, ticket: result.ticket };
      return finishLogin(req, res, result, ip);
    },
    { public: true }
  );

  router.post(
    '/api/auth/login/2fa',
    async ({ body, req, res }) => {
      const ip = clientIp(req);
      const result = auth.loginSecondFactor(body.ticket, body.code, ip);
      if (result.usedRecoveryCode) {
        store.addEvent('user.recovery_code', `${result.user.username} signed in with a recovery code (${result.recoveryCodesLeft} left)`, { ip });
      }
      return { ...finishLogin(req, res, result, ip), usedRecoveryCode: result.usedRecoveryCode, recoveryCodesLeft: result.recoveryCodesLeft };
    },
    { public: true }
  );

  function finishLogin(req, res, { token, user }, ip) {
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
  }

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
  /* ------------------------------------------------- two-factor sign-in -- */

  const requirePassword = (user, password) => {
    const record = auth.users.find((u) => u.id === user.id);
    if (!verifyPassword(password, record.password)) fail(403, 'Your password is not right');
    return record;
  };

  router.post('/api/auth/2fa/setup', ({ user }) => auth.beginTwoFactor(user.id));

  router.post('/api/auth/2fa/enable', ({ user, body }) => {
    const result = auth.confirmTwoFactor(user.id, body.code);
    store.addEvent('user.2fa_enabled', `${user.username} turned on two-factor sign-in`);
    return { ok: true, ...result };
  });

  router.post('/api/auth/2fa/disable', ({ user, body }) => {
    const record = requirePassword(user, body.password);
    if (record.totp && !auth.checkSecondFactor(record, body.code)) fail(403, 'That code is not right');
    auth.disableTwoFactor(user.id);
    store.addEvent('user.2fa_disabled', `${user.username} turned off two-factor sign-in`);
    return { ok: true };
  });

  router.post('/api/auth/2fa/recovery-codes', ({ user, body }) => {
    requirePassword(user, body.password);
    return auth.newRecoveryCodes(user.id);
  });
};
