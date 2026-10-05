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
const { createHelpers } = require('./helpers');

const VERSION = require('../../package.json').version;
const ROUTES = ['auth', 'system', 'templates', 'servers', 'files', 'mods', 'network', 'backups', 'users'];

/** @param {{store, auth, manager, templates, hostMetrics, scheduler, notifier}} app */
function createApi(app) {
  const router = new Router();
  const h = createHelpers(app);
  for (const name of ROUTES) require(`./routes/${name}`)(router, app, h);

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
        json(res, 401, { error: 'Not signed in' });
        return;
      }
    }

    const body = !route.rawBody && writes ? await readJson(req) : {};
    const result = await route.handler({ req, res, url, params, body, user });
    if (res.writableEnded || result === undefined) return;
    json(res, 200, result);
  }

  return { handle, router };
}

module.exports = { createApi, HttpError, VERSION };
