'use strict';

/**
 * REST API. Each file in routes/ adds the endpoints for one area:
 *
 *   auth        sign in, first-run setup, password
 *   system      host stats, activity, updates, settings, notifications
 *   templates   the game catalogue
 *   servers     create/delete, power, console, schedules
 *   files       the file manager
 *   mods        one-click mods, Workshop, modpacks
 *   network     firewall and router port forwarding
 *   backups     backups and restores
 *   users       accounts and permissions
 */

const { json, readJson, HttpError } = require('../core/util');
const { Router } = require('./router');
const { createHelpers, clientIp } = require('./helpers');
const { RateLimiter } = require('../core/ratelimit');

const VERSION = require('../../package.json').version;
const ROUTES = ['auth', 'system', 'templates', 'servers', 'files', 'mods', 'network', 'backups', 'users'];

/** @param {{store, auth, manager, templates, hostMetrics, scheduler, notifier}} app */
function createApi(app) {
  const router = new Router();
  const h = createHelpers(app);
  for (const name of ROUTES) require(`./routes/${name}`)(router, app, h);
  // Per address for anything anonymous (sign-in page, status page), per account once signed in.
  const anonymousLimit = new RateLimiter({ limit: 120 });
  const userLimit = new RateLimiter({ limit: 1200 });
  const tooMany = (res, limiter, key) => {
    res.setHeader('Retry-After', String(limiter.retryAfter(key)));
    json(res, 429, { error: 'Too many requests. Slow down and try again in a moment.' });
  };

  async function handle(req, res, url) {
    const match = router.match(req.method, url.pathname);
    if (!match) {
      json(res, 404, { error: 'Endpoint not found' });
      return;
    }
    const { route, params } = match;
    const writes = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);

    // CSRF: the session cookie is SameSite=Lax, and the Origin is checked too.
    if (writes && req.headers.origin) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(req.headers.origin).host === req.headers.host;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        json(res, 403, { error: 'Cross-origin request refused' });
        return;
      }
    }

    let user = null;
    if (!route.public) {
      user = app.auth.userFromRequest(req);
      if (!user) {
        const ip = clientIp(req);
        if (!anonymousLimit.take(ip)) return tooMany(res, anonymousLimit, ip);
        json(res, 401, { error: 'Not signed in' });
        return;
      }
      if (!userLimit.take(user.id)) return tooMany(res, userLimit, user.id);
    } else {
      const ip = clientIp(req);
      if (!anonymousLimit.take(ip)) return tooMany(res, anonymousLimit, ip);
    }

    const body = !route.rawBody && writes ? await readJson(req) : {};
    const result = await route.handler({ req, res, url, params, body, user });
    if (res.writableEnded || result === undefined) return;
    json(res, 200, result);
  }

  return { handle, router };
}

module.exports = { createApi, HttpError, VERSION };
