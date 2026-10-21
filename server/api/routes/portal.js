'use strict';

/**
 * Player portal routes. All public (players have no panel account), all
 * rate limited per address, and the session is the portal's own cookie.
 */

const { fail } = require('../../core/util');
const { RateLimiter } = require('../../core/ratelimit');
const { clientIp, isSecure } = require('../helpers');
const portal = require('../../features/portal');
const oauth = require('../../features/oauth');

module.exports = (router, { store, auth, manager }, { requireAdmin }) => {
  const readLimit = new RateLimiter({ limit: 60, windowMs: 60_000 });
  const startLimit = new RateLimiter({ limit: 10, windowMs: 10 * 60_000 });
  const pollLimit = new RateLimiter({ limit: 90, windowMs: 60_000 });

  const limited = (limiter, req) => {
    if (!limiter.take(clientIp(req))) fail(429, 'Too many requests. Try again in a little while.');
  };
  const on = () => {
    if (!portal.settings(store).enabled) fail(404, 'The player portal is turned off');
  };
  const session = (req) => {
    on();
    const s = portal.sessionFrom(auth, req);
    if (!s) fail(401, 'Sign in to see your stats');
    return s;
  };

  router.get(
    '/api/portal/config',
    ({ req }) => {
      limited(readLimit, req);
      const page = store.state.settings.statusPage || {};
      const enabled = portal.settings(store).enabled;
      return {
        enabled,
        panelName: store.state.settings.panelName || 'GamePanel',
        accent: page.accent || null,
        providers: enabled ? oauth.enabled(store).filter((p) => portal.PROVIDERS.includes(p.id)) : [],
        servers: enabled ? portal.servers(store, manager).length : 0,
        signedIn: enabled && Boolean(portal.sessionFrom(auth, req)),
      };
    },
    { public: true }
  );

  /** Off to Steam or Discord. They come back through the normal callback, which hands over a portal session. */
  router.get(
    '/api/portal/auth/:provider/start',
    ({ req, res, params }) => {
      limited(startLimit, req);
      on();
      if (!portal.PROVIDERS.includes(params.provider)) fail(404, 'Unknown sign-in provider');
      const { url: to, cookie } = oauth.start(store, auth, req, params.provider, { portal: true });
      res.setHeader('Set-Cookie', cookie);
      res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
      res.end();
      return undefined;
    },
    { public: true }
  );

  /** Start a code: say it in game chat. With a name this is a sign-in; signed in, it adds a name. */
  router.post(
    '/api/portal/code',
    ({ req, body }) => {
      limited(startLimit, req);
      on();
      const s = portal.sessionFrom(auth, req);
      if (body?.name === undefined && s) return portal.beginCode({ subject: s.subject });
      return portal.beginCode({ name: body?.name });
    },
    { public: true }
  );

  /** Poll while waiting for the code to be said. A verified name sign-in gets its session here. */
  router.get(
    '/api/portal/code/:ticket',
    ({ req, res, params }) => {
      limited(pollLimit, req);
      on();
      const result = portal.codeStatus(store, params.ticket);
      if (result.subject) {
        res.setHeader('Set-Cookie', portal.cookieFor(auth, result.subject, result.name, isSecure(req)));
        delete result.subject;
      }
      return result;
    },
    { public: true }
  );

  router.get(
    '/api/portal/me',
    ({ req, res }) => {
      limited(readLimit, req);
      const s = session(req);
      res.setHeader('Cache-Control', 'no-store');
      return portal.viewFor(store, manager, s.subject);
    },
    { public: true }
  );

  router.delete(
    '/api/portal/names/:server/:name',
    ({ req, params }) => {
      limited(readLimit, req);
      const s = session(req);
      portal.removeClaim(store, s.subject, params.server, params.name);
      return portal.viewFor(store, manager, s.subject);
    },
    { public: true }
  );

  router.post(
    '/api/portal/logout',
    ({ res }) => {
      res.setHeader('Set-Cookie', portal.clearCookie());
      return { ok: true };
    },
    { public: true }
  );

  /* ------------------------------------------------------- admin switch -- */

  router.get('/api/portal/settings', ({ user }) => {
    requireAdmin(user);
    return { ...portal.settings(store), servers: portal.servers(store, manager).length, steam: Boolean(oauth.enabled(store).some((p) => p.id === 'steam')), discord: Boolean(oauth.enabled(store).some((p) => p.id === 'discord')) };
  });

  router.put('/api/portal/settings', ({ user, body }) => {
    requireAdmin(user);
    const s = portal.update(store, body || {});
    store.addEvent('settings.portal', `${user.username} turned the player portal ${s.enabled ? 'on' : 'off'}`);
    return s;
  });
};
