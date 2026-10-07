'use strict';

/**
 * Loads a route file against a stand-in router so a test can call a handler
 * the way the API does, with a real Auth and the real access helpers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../../../server/core/store');
const { Auth } = require('../../../server/core/auth');
const { createHelpers } = require('../../../server/api/helpers');
const { Router } = require('../../../server/api/router');

function makeApp(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-routes-'));
  const store = new Store(path.join(dir, 'panel.json'));
  const auth = new Auth(store, 'test-secret-test-secret-test-secret');
  const app = { store, auth, templates: { list: () => [], require: () => ({}) }, manager: { servers: [], require() {} }, ...extra };
  return app;
}

/** Register one route file; returns call(method, path, { user, body, ... }). */
function load(name, app) {
  const router = new Router();
  const helpers = createHelpers(app);
  require(`../../../server/api/routes/${name}`)(router, app, helpers);
  const call = async (method, pathname, ctx = {}) => {
    const match = router.match(method, pathname);
    if (!match) throw new Error(`no route for ${method} ${pathname}`);
    const url = new URL(pathname, 'http://localhost');
    return match.route.handler({ params: match.params, url, body: {}, req: { headers: {}, socket: {} }, res: {}, ...ctx });
  };
  return { router, call, helpers };
}

module.exports = { makeApp, load };
