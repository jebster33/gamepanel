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
 *   bridge      Manage connections: bridge clients, their servers and ports
 *   bans        the shared ban list and ban appeals
 */

const { json, readJson, HttpError } = require('../core/util');
const { Router } = require('./router');
const { createHelpers, clientIp, sameOrigin } = require('./helpers');
const { RateLimiter } = require('../core/ratelimit');
const audit = require('../features/audit');
const { isDangerous } = require('../core/danger');

const VERSION = require('../../package.json').version;
const safeDecode = (v) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};
const CORE_ROUTES = ['auth', 'system', 'templates', 'servers', 'files', 'mods', 'network', 'backups', 'users', 'bridge', 'bans'];
// Every other file in routes/ (nodes.js is wired by users.js) is loaded too, after the core ones (in name order), so a new area needs no edit here.
const ROUTES = [
  ...CORE_ROUTES,
  ...require('fs')
    .readdirSync(require('path').join(__dirname, 'routes'))
    .filter((f) => f.endsWith('.js') && !CORE_ROUTES.includes(f.slice(0, -3)) && f !== 'nodes.js')
    .map((f) => f.slice(0, -3))
    .sort(),
];

/** @param {{store, auth, manager, templates, hostMetrics, scheduler, notifier, bridge}} app */
function createApi(app) {
  const router = new Router();
  const h = createHelpers(app);
  for (const name of ROUTES) require(`./routes/${name}`)(router, app, h);
  // Newer feature areas: every other file in routes/ is loaded too.
  for (const file of require('fs').readdirSync(require('path').join(__dirname, 'routes')).sort()) {
    const name = file.replace(/\.js$/, '');
    if (file.endsWith('.js') && !ROUTES.includes(name)) require(`./routes/${name}`)(router, app, h);
  }
  // Per address for anything anonymous (sign-in page, status page), per account once signed in.
  const anonymousLimit = new RateLimiter({ limit: 120 });
  const userLimit = new RateLimiter({ limit: 1200 });
  const tooMany = (res, limiter, key) => {
    res.setHeader('Retry-After', String(limiter.retryAfter(key)));
    json(res, 429, { error: 'Too many requests. Slow down and try again in a moment.' });
  };

  /**
   * Requests for a server on another node ("<node>~<id>"), or sent straight
   * to a node, are passed through to that panel. Administrators only.
   */
  async function proxyToNode(req, res, url) {
    const nodes = app.manager.nodes;
    if (!nodes?.list.length) return false;
    // The server list: administrators also get the servers on other nodes.
    if (req.method === 'GET' && url.pathname === '/api/servers' && url.searchParams.get('local') !== '1') {
      const user = app.auth.userFromRequest(req);
      if (user?.role !== 'admin') return false;
      json(res, 200, { servers: [...app.manager.servers.map((s) => app.manager.publicServer(s)), ...nodes.remoteServers()] });
      return true;
    }
    let node;
    let path;
    const direct = url.pathname.match(/^\/api\/nodes\/([^/]+)\/proxy(\/api\/.*)$/);
    const viaId = url.pathname.match(/^\/api\/servers\/([^/]+)(\/.*)?$/);
    if (direct) {
      node = nodes.list.find((n) => n.id === direct[1]);
      path = direct[2];
    } else if (viaId) {
      const target = nodes.parseId(safeDecode(viaId[1]));
      if (!target) return false;
      node = target.node;
      path = `/api/servers/${encodeURIComponent(target.remoteId)}${viaId[2] || ''}`;
    }
    if (!node) return false;
    if (req.method !== 'GET' && !sameOrigin(req)) {
      json(res, 403, { error: 'Cross-origin request refused' });
      return true;
    }
    const user = app.auth.userFromRequest(req);
    if (!user) {
      json(res, 401, { error: 'Not signed in' });
      return true;
    }
    if (user.role !== 'admin') {
      json(res, 403, { error: 'Only administrators can manage servers on other nodes' });
      return true;
    }
    // The remote panel only sees the node's own admin key, so a read-only key's limits would not carry over.
    if (req.gpApiKey?.readOnly) {
      json(res, 403, { error: 'A read-only API key cannot reach other nodes' });
      return true;
    }
    // The block on account changes for API keys must hold through a node's proxy too, where the node would answer to the admin key it was given.
    if (req.method !== 'GET' && req.gpApiKey && require('../core/auth').isAccountRoute(path)) {
      json(res, 403, { error: 'Account changes need a person signed in, not an API key' });
      return true;
    }
    // The node only sees its own admin key, so the code check has to happen here.
    if (isDangerous(req.method, path.split('?')[0])) {
      const need = app.auth.requireDanger(user, req);
      if (need) {
        json(res, 403, { error: need, confirmRequired: true });
        return true;
      }
    }
    if (req.method !== 'GET') {
      audit.record({ user: user.username, ip: clientIp(req), action: `${req.method.toLowerCase()} ${path.replace(/^\/api\//, '')} on node ${node.name}`, path, status: 200 });
    }
    await nodes.proxy(req, res, node, path + url.search);
    return true;
  }

  async function handle(req, res, url) {
    if (await proxyToNode(req, res, url)) return;
    const match = router.match(req.method, url.pathname);
    if (!match) {
      json(res, 404, { error: 'Endpoint not found' });
      return;
    }
    const { route, params } = match;
    const writes = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);

    // CSRF: the session cookie is SameSite=Lax, and the Origin is checked too.
    if (writes && !sameOrigin(req)) {
      json(res, 403, { error: 'Cross-origin request refused' });
      return;
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

    // Sign-in and other public routes take small bodies only: anyone on the internet can send one.
    const body = !route.rawBody && writes ? await readJson(req, route.public ? 64 * 1024 : undefined) : {};
    // Wipes, deletes and rollbacks: a fresh authenticator code when the account has 2FA.
    if (user && writes && isDangerous(req.method, url.pathname, body)) {
      const need = app.auth.requireDanger(user, req);
      if (need) {
        json(res, 403, { error: need, confirmRequired: true });
        return;
      }
    }
    // Every change goes in the audit log, including refused ones.
    const note = (status, error) => {
      if (!writes) return;
      const pattern = '/' + route.parts.join('/');
      const server = params.id && app.manager.servers.find((s) => s.id === params.id);
      audit.record({
        user: user?.username || (typeof body?.username === 'string' ? body.username.slice(0, 40) : null),
        ip: clientIp(req),
        action: audit.describe(req.method, pattern, body),
        path: url.pathname,
        serverId: server?.id,
        server: server?.name,
        details: route.rawBody ? undefined : audit.details(body),
        status,
        error,
      });
    };
    let result;
    try {
      result = await route.handler({ req, res, url, params, body, user });
    } catch (err) {
      note(typeof err.code === 'number' ? err.code : 500, err.message);
      throw err;
    }
    note(res.statusCode || 200);
    if (res.writableEnded || result === undefined) return;
    json(res, 200, result);
  }

  return { handle, router };
}

module.exports = { createApi, HttpError, VERSION };
