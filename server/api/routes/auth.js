'use strict';

const { fail } = require('../../core/util');
const { verifyPassword } = require('../../core/auth');
const { clientIp, isSecure } = require('../helpers');
const VERSION = require('../../../package.json').version;

module.exports = (router, app) => {
  const { store, auth } = app;
  router.get(
    '/api/status',
    () => ({ ok: true, version: VERSION, panelName: store.state.settings.panelName, setupRequired: auth.needsSetup(), setupCodeRequired: auth.needsSetup() }),
    { public: true }
  );

  router.post(
    '/api/setup',
    async ({ body, req }) => {
      if (!auth.needsSetup()) fail(409, 'The panel is already set up');
      auth.checkSetupCode(req, body?.setupCode);
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

  /* ------------------------------------------------------------ passkeys -- */

  const passkeys = require('../../features/passkeys');

  router.post('/api/auth/passkey/options', ({ req }) => passkeys.loginOptions(req), { public: true });

  router.post(
    '/api/auth/passkey/login',
    async ({ body, req, res }) => {
      const ip = clientIp(req);
      const result = passkeys.login(auth, store, req, ip, body || {});
      if (result.twoFactor) return { ok: true, twoFactor: true, ticket: result.ticket };
      return finishLogin(req, res, result, ip, ` with a passkey (${result.passkey})`);
    },
    { public: true }
  );

  router.post('/api/auth/passkeys/options', ({ user, req }) => passkeys.registerOptions(auth, store, user, req));

  router.post('/api/auth/passkeys', ({ user, req, body }) => {
    const passkey = passkeys.register(auth, store, user, req, body || {});
    store.addEvent('user.passkey', `${user.username} added a passkey (${passkey.name})`, { ip: clientIp(req) });
    return { user: auth.publicUser(auth.users.find((u) => u.id === user.id)) };
  });

  router.patch('/api/auth/passkeys/:id', ({ user, params, body }) => {
    passkeys.rename(auth, store, user, params.id, body?.name);
    return { user: auth.publicUser(auth.users.find((u) => u.id === user.id)) };
  });

  router.delete('/api/auth/passkeys/:id', ({ user, params, req }) => {
    passkeys.remove(auth, store, user, params.id);
    store.addEvent('user.passkey', `${user.username} removed a passkey`, { ip: clientIp(req) });
    return { user: auth.publicUser(auth.users.find((u) => u.id === user.id)) };
  });

  function finishLogin(req, res, { token, user }, ip, how = '') {
    res.setHeader('Set-Cookie', auth.cookieHeader(token, isSecure(req)));
    const record = auth.users.find((u) => u.id === user.id);
    const newAddress = record ? auth.noteSignInAddress(record, ip) : false;
    const event = store.addEvent('user.login', `${user.username} signed in${how}`, { ip });
    // A location lookup must never slow a sign-in down; fill it in afterwards.
    require('../../features/geoip')
      .locate(ip, { enabled: store.state.settings.geoLookup !== false })
      .catch(() => null)
      .then((location) => {
        if (location) {
          event.location = location;
          store.save();
        }
        // Signing in from somewhere new is worth a ping (Discord, phone).
        if (newAddress) {
          store.addEvent('user.new_ip', `${user.username} signed in from a new address: ${ip}${location ? ` (${location})` : ''}`, { ip });
        }
      });
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

  router.post('/api/auth/password', async ({ user, body, req, res }) => {
    const record = auth.users.find((u) => u.id === user.id);
    if (!verifyPassword(body.currentPassword, record.password)) fail(403, 'Your current password is not right');
    auth.setPassword(user.id, body.newPassword);
    // Every other device is signed out; this one gets a fresh session.
    keepThisDevice(req, res, record);
    store.addEvent('user.password', `${user.username} changed their password (other devices signed out)`, { ip: clientIp(req) });
    return { ok: true };
  });

  /** Sign out every other device, e.g. after using a shared computer. */
  /** API keys for scripts and bots (Authorization: Bearer gp_…). */
  router.get('/api/auth/api-keys', ({ user }) => ({ keys: auth.listApiKeys(user.id) }));

  router.post('/api/auth/api-keys', ({ user, req, body }) => {
    const created = auth.createApiKey(user.id, { name: body?.name, readOnly: Boolean(body?.readOnly) });
    store.addEvent('user.api_key', `${user.username} created the API key "${created.name}"${created.readOnly ? ' (read-only)' : ''}`, { ip: clientIp(req) });
    return created;
  });

  router.delete('/api/auth/api-keys/:keyId', ({ user, params }) => {
    auth.deleteApiKey(user.id, params.keyId);
    return { ok: true };
  });

  router.post('/api/auth/sessions/revoke', ({ user, req, res }) => {
    const record = auth.users.find((u) => u.id === user.id);
    auth.revokeSessions(user.id);
    keepThisDevice(req, res, record);
    store.addEvent('user.sessions_revoked', `${user.username} signed out of all other devices`, { ip: clientIp(req) });
    return { ok: true };
  });

  function keepThisDevice(req, res, record) {
    const { token } = auth.startSession(record, clientIp(req));
    res.setHeader('Set-Cookie', auth.cookieHeader(token, isSecure(req)));
  }
  /* ------------------------------- sign in with Google, Discord, GitHub -- */

  const oauth = require('../../features/oauth');
  const redirect = (res, location, cookies = []) => {
    const existing = res.getHeader('Set-Cookie');
    const all = [...(existing ? [existing].flat() : []), ...cookies];
    if (all.length) res.setHeader('Set-Cookie', all);
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  };
  const clearState = `${oauth.STATE_COOKIE}=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0`;

  router.get('/api/auth/oauth/providers', () => ({ providers: oauth.enabled(store) }), { public: true });

  /** Off to Google/Discord/GitHub. ?link=1 links the signed-in account instead of signing in. */
  router.get(
    '/api/auth/oauth/:provider/start',
    ({ req, res, params, url }) => {
      let linkUserId = null;
      if (url.searchParams.get('link') === '1') {
        const user = auth.userFromRequest(req);
        if (!user) fail(401, 'Sign in first, then link the account from the Account page');
        // Only a person signed in to the panel links a sign-in to their account, never a script with an API key.
        if (req.gpApiKey) fail(403, 'Link accounts from the Account page while signed in, not with an API key');
        linkUserId = user.id;
      }
      const { url: to, cookie } = oauth.start(store, auth, req, params.provider, { linkUserId });
      redirect(res, to, [cookie]);
      return undefined;
    },
    { public: true }
  );

  /** Back from the provider. Ends in a redirect to the dashboard (or the Account page when linking). */
  router.get(
    '/api/auth/oauth/:provider/callback',
    async ({ req, res, params, url }) => {
      const ip = clientIp(req);
      const label = oauth.PROVIDERS[params.provider]?.label || params.provider;
      let result;
      try {
        result = await oauth.finish(store, auth, req, params.provider, url.searchParams);
      } catch (err) {
        redirect(res, `/?oauth_error=${encodeURIComponent(err.message)}#/`, [clearState]);
        return undefined;
      }
      const { identity, linkUserId } = result;
      if (linkUserId) {
        try {
          const user = oauth.link(store, auth, linkUserId, params.provider, identity);
          store.addEvent('user.linked', `${user.username} linked their ${label} account (${identity.name})`, { ip });
          redirect(res, `/?oauth_linked=${encodeURIComponent(label)}#/account`, [clearState]);
        } catch (err) {
          redirect(res, `/?oauth_error=${encodeURIComponent(err.message)}#/account`, [clearState]);
        }
        return undefined;
      }
      const user = oauth.findUser(auth, params.provider, identity);
      if (!user) {
        auth.noteAccountFailure(`ip:${ip}`);
        redirect(res, `/?oauth_error=${encodeURIComponent(`No panel account is linked to the ${label} account ${identity.name}. Sign in with your password once, then link it on the Account page.`)}#/`, [clearState]);
        return undefined;
      }
      const login = auth.loginLinked(user, ip);
      if (login.twoFactor) {
        redirect(res, `/?oauth2fa=${encodeURIComponent(login.ticket)}#/`, [clearState]);
        return undefined;
      }
      finishLogin(req, res, login, ip, ` with ${label}`);
      redirect(res, '/#/dashboard', [clearState]);
      return undefined;
    },
    { public: true }
  );

  router.delete('/api/auth/oauth/:provider', ({ user, params, req }) => {
    const record = auth.users.find((u) => u.id === user.id);
    oauth.unlink(store, record, params.provider);
    store.addEvent('user.unlinked', `${user.username} unlinked their ${oauth.PROVIDERS[params.provider].label} account`, { ip: clientIp(req) });
    return { ok: true, user: auth.publicUser(record) };
  });

  router.get('/api/settings/oauth', ({ user, req }) => {
    if (user.role !== 'admin') fail(403, 'Only administrators can do that');
    return oauth.adminView(store, req);
  });

  router.put('/api/settings/oauth', ({ user, req, body }) => {
    if (user.role !== 'admin') fail(403, 'Only administrators can do that');
    oauth.update(store, body || {});
    store.addEvent('settings.oauth', `${user.username} changed the sign-in providers`);
    return oauth.adminView(store, req);
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

  /* ------------------------------------------------- phone notifications -- */

  // Started with the API so events reach phones from the first minute.
  const service = require('../../features/push').init(app);
  const push = () => service;

  router.get('/api/push', ({ user, url }) => ({ publicKey: push().keys.publicKey, ...push().status(user, url.searchParams.get('endpoint') || '') }));

  router.post('/api/push', ({ user, body }) => push().subscribe(user, body?.subscription, body?.events, body?.device));

  router.delete('/api/push', ({ user, body }) => push().unsubscribe(user, String(body?.endpoint || '')));

  router.post('/api/push/test', ({ user, body }) => push().test(user, String(body?.endpoint || '')));
};
