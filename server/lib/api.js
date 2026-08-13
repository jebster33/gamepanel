'use strict';

/** REST API: a tiny pattern router plus every panel endpoint. */

const fs = require('fs');
const path = require('path');
const { json, readJson, readBody, fail, HttpError, logger, clamp } = require('./util');
const { config } = require('./config');
const files = require('./files');
const backups = require('./backups');
const { rconCommand } = require('./rcon');
const { query } = require('./query');

const VERSION = require('../../package.json').version;

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const parts = pattern.split('/').filter(Boolean);
    this.routes.push({ method, parts, handler, ...options });
  }

  get(p, h, o) {
    this.add('GET', p, h, o);
  }

  post(p, h, o) {
    this.add('POST', p, h, o);
  }

  patch(p, h, o) {
    this.add('PATCH', p, h, o);
  }

  put(p, h, o) {
    this.add('PUT', p, h, o);
  }

  delete(p, h, o) {
    this.add('DELETE', p, h, o);
  }

  match(method, pathname) {
    const segs = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const part = route.parts[i];
        if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segs[i]);
        else if (part !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

/**
 * @param {object} ctx {store, auth, manager, templates, hostMetrics}
 */
function createApi(ctx) {
  const { store, auth, manager, templates, hostMetrics } = ctx;
  const router = new Router();

  const requireAdmin = (user) => {
    if (!user || user.role !== 'admin') fail(403, 'Administrator access required');
  };

  const serverFor = (user, id) => {
    const server = manager.require(id);
    if (!auth.canAccessServer(user, server.id)) fail(403, 'You do not have access to this server');
    return server;
  };

  const visibleServers = (user) =>
    manager.servers.filter((s) => auth.canAccessServer(user, s.id)).map((s) => manager.publicServer(s));

  /* ------------------------------------------------------------- public -- */

  router.get('/api/status', () => ({
    ok: true,
    version: VERSION,
    panelName: store.state.settings.panelName,
    setupRequired: auth.needsSetup(),
  }), { public: true });

  router.post('/api/setup', async ({ body }) => {
    if (!auth.needsSetup()) fail(409, 'The panel is already set up');
    const user = auth.createUser({ username: body.username, password: body.password, role: 'admin' });
    store.addEvent('user.created', `Initial administrator ${user.username} created`);
    return { ok: true, user };
  }, { public: true });

  router.post('/api/auth/login', async ({ body, req, res }) => {
    const ip = clientIp(req);
    const { token, user } = auth.login(body.username, body.password, ip);
    res.setHeader('Set-Cookie', auth.cookieHeader(token, isSecure(req)));
    store.addEvent('user.login', `${user.username} signed in`, { ip });
    return { ok: true, user, token };
  }, { public: true });

  router.post('/api/auth/logout', async ({ res }) => {
    res.setHeader('Set-Cookie', auth.clearCookieHeader());
    return { ok: true };
  }, { public: true });

  /* --------------------------------------------------------------- self -- */

  router.get('/api/auth/me', ({ user }) => ({ user: auth.publicUser(user) }));

  router.post('/api/auth/password', async ({ user, body }) => {
    const { verifyPassword } = require('./auth');
    const record = auth.users.find((u) => u.id === user.id);
    if (!verifyPassword(body.currentPassword, record.password)) fail(403, 'Current password is incorrect');
    auth.setPassword(user.id, body.newPassword);
    return { ok: true };
  });

  /* ------------------------------------------------------------- system -- */

  router.get('/api/system', ({ user }) => ({
    host: hostMetrics.last,
    overview: manager.overview(),
    version: VERSION,
    isAdmin: user.role === 'admin',
    dataDir: user.role === 'admin' ? config.dataDir : undefined,
  }));

  router.get('/api/events', ({ user, url }) => {
    const limit = clamp(url.searchParams.get('limit') || 100, 1, 500);
    const all = store.state.events;
    const filtered = user.role === 'admin' ? all : all.filter((e) => !e.serverId || auth.canAccessServer(user, e.serverId));
    return { events: filtered.slice(0, limit) };
  });

  /* ---------------------------------------------------------- templates -- */

  router.get('/api/templates', () => ({ templates: templates.list(), categories: templates.categories() }));

  router.get('/api/templates/:id', ({ params }) => ({ template: templates.require(params.id) }));

  router.post('/api/templates', ({ user, body }) => {
    requireAdmin(user);
    return { template: templates.saveCustom(body) };
  });

  router.delete('/api/templates/:id', ({ user, params }) => {
    requireAdmin(user);
    templates.deleteCustom(params.id);
    return { ok: true };
  });

  router.post('/api/templates/reload', ({ user }) => {
    requireAdmin(user);
    return { count: templates.load() };
  });

  /* ------------------------------------------------------------ servers -- */

  router.get('/api/servers', ({ user }) => ({ servers: visibleServers(user) }));

  router.post('/api/servers', async ({ user, body }) => {
    requireAdmin(user);
    const server = manager.create(body, user);
    // Installing can take many minutes — kick it off and let the console stream.
    manager.install(server.id).catch((err) => logger.error('Install error:', err.message));
    return { server: manager.publicServer(server) };
  });

  router.get('/api/servers/:id', ({ user, params }) => {
    const server = serverFor(user, params.id);
    const template = manager.template(server);
    return {
      server: manager.publicServer(server),
      template: template ? { ...template, install: undefined } : null,
    };
  });

  router.patch('/api/servers/:id', ({ user, params, body }) => {
    requireAdmin(user);
    return { server: manager.publicServer(manager.update(params.id, body)) };
  });

  router.delete('/api/servers/:id', async ({ user, params, url }) => {
    requireAdmin(user);
    await manager.remove(params.id, url.searchParams.get('keepFiles') !== '1');
    return { ok: true };
  });

  router.post('/api/servers/:id/power', async ({ user, params, body }) => {
    const server = serverFor(user, params.id);
    const action = String(body.action || '').toLowerCase();
    switch (action) {
      case 'start':
        return { ok: true, server: await manager.start(server.id) };
      case 'stop':
        return await manager.stop(server.id);
      case 'restart':
        return await manager.restart(server.id);
      case 'kill':
        manager.killTree(server.id);
        return { ok: true };
      default:
        fail(400, 'action must be one of: start, stop, restart, kill');
        return null;
    }
  });

  router.post('/api/servers/:id/install', async ({ user, params, body }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    manager.install(server.id, { reinstall: Boolean(body.reinstall) }).catch((err) =>
      logger.error('Install error:', err.message)
    );
    return { ok: true, started: true };
  });

  router.get('/api/servers/:id/console', ({ user, params }) => {
    const server = serverFor(user, params.id);
    return { lines: manager.getConsole(server.id) };
  });

  router.post('/api/servers/:id/command', async ({ user, params, body }) => {
    const server = serverFor(user, params.id);
    if (!body.command || !String(body.command).trim()) fail(400, 'Command is required');
    return await manager.sendCommand(server.id, String(body.command).trim());
  });

  router.get('/api/servers/:id/history', ({ user, params }) => {
    const server = serverFor(user, params.id);
    return { history: manager.getHistory(server.id) };
  });

  router.get('/api/servers/:id/query', async ({ user, params }) => {
    const server = serverFor(user, params.id);
    const template = manager.template(server);
    const q = template?.query;
    if (!q || q.type === 'none') return { supported: false };
    const port = q.portOffset ? Number(server.ports.game) + Number(q.portOffset) : server.ports[q.port || 'query'] ?? server.ports.game;
    return { supported: true, result: await query({ type: q.type, host: '127.0.0.1', port }) };
  });

  router.post('/api/servers/:id/rcon', async ({ user, params, body }) => {
    const server = serverFor(user, params.id);
    const template = manager.template(server);
    if (!template?.rcon) fail(400, 'This game does not support RCON');
    const response = await rconCommand({
      host: '127.0.0.1',
      port: server.ports[template.rcon.port || 'rcon'],
      password: server.vars?.RCON_PASSWORD,
      command: String(body.command || ''),
    });
    return { response };
  });

  /* -------------------------------------------------------------- files -- */

  const rootOf = (user, id) => serverFor(user, id).dir;

  router.get('/api/servers/:id/files', async ({ user, params, url }) =>
    files.list(rootOf(user, params.id), url.searchParams.get('path') || '')
  );

  router.get('/api/servers/:id/files/content', async ({ user, params, url }) =>
    files.read(rootOf(user, params.id), url.searchParams.get('path') || '')
  );

  router.put('/api/servers/:id/files/content', async ({ user, params, url, body }) =>
    files.write(rootOf(user, params.id), url.searchParams.get('path') || '', body.content)
  );

  router.post('/api/servers/:id/files/mkdir', async ({ user, params, body }) =>
    files.mkdir(rootOf(user, params.id), body.path)
  );

  router.post('/api/servers/:id/files/rename', async ({ user, params, body }) =>
    files.rename(rootOf(user, params.id), body.from, body.to)
  );

  router.delete('/api/servers/:id/files', async ({ user, params, url }) =>
    files.remove(rootOf(user, params.id), url.searchParams.get('path') || '')
  );

  router.get('/api/servers/:id/files/download', async ({ user, params, url, res }) => {
    const { file, size, name } = files.resolveDownload(rootOf(user, params.id), url.searchParams.get('path') || '');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
    });
    fs.createReadStream(file).pipe(res);
    return undefined;
  }, { raw: true });

  router.post('/api/servers/:id/files/upload', async ({ user, params, url, req }) => {
    const root = rootOf(user, params.id);
    const rel = url.searchParams.get('path');
    if (!rel) fail(400, 'A target path is required');
    const buf = await readBody(req, 512 * 1024 * 1024);
    const { safeJoin } = require('./util');
    const target = safeJoin(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    return { ok: true, path: rel, size: buf.length };
  }, { rawBody: true });

  /* ------------------------------------------------------------ backups -- */

  router.get('/api/servers/:id/backups', ({ user, params }) => {
    const server = serverFor(user, params.id);
    return { backups: backups.list(server.id) };
  });

  router.post('/api/servers/:id/backups', async ({ user, params, body }) => {
    const server = serverFor(user, params.id);
    const backup = await backups.create(server, body.label || '');
    store.addEvent('backup.created', `Backup created for ${server.name}`, { serverId: server.id });
    return { backup };
  });

  router.post('/api/servers/:id/backups/:name/restore', async ({ user, params }) => {
    requireAdmin(user);
    const server = manager.require(params.id);
    if (manager.isActive(server.id)) fail(409, 'Stop the server before restoring a backup');
    await backups.restore(server, params.name);
    store.addEvent('backup.restored', `Backup ${params.name} restored to ${server.name}`, { serverId: server.id });
    return { ok: true };
  });

  router.delete('/api/servers/:id/backups/:name', ({ user, params }) => {
    const server = serverFor(user, params.id);
    return backups.remove(server.id, params.name);
  });

  router.get('/api/servers/:id/backups/:name/download', ({ user, params, res }) => {
    const server = serverFor(user, params.id);
    const file = backups.resolve(server.id, params.name);
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${params.name}"`,
    });
    fs.createReadStream(file).pipe(res);
    return undefined;
  }, { raw: true });

  /* -------------------------------------------------------------- users -- */

  router.get('/api/users', ({ user }) => {
    requireAdmin(user);
    return { users: auth.users.map((u) => auth.publicUser(u)) };
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
    if (body.role) target.role = body.role === 'admin' ? 'admin' : 'user';
    if (Array.isArray(body.servers)) target.servers = body.servers;
    if (body.password) auth.setPassword(target.id, body.password);
    store.save();
    return { user: auth.publicUser(target) };
  });

  router.delete('/api/users/:id', ({ user, params }) => {
    requireAdmin(user);
    if (params.id === user.id) fail(400, 'You cannot delete your own account');
    auth.deleteUser(params.id);
    return { ok: true };
  });

  /* ----------------------------------------------------------- settings -- */

  router.get('/api/settings', ({ user }) => {
    requireAdmin(user);
    return { settings: store.state.settings };
  });

  router.patch('/api/settings', ({ user, body }) => {
    requireAdmin(user);
    const s = store.state.settings;
    if (body.panelName) s.panelName = String(body.panelName).slice(0, 40);
    if (body.portRangeStart) s.portRangeStart = clamp(body.portRangeStart, 1024, 65535);
    if (body.portRangeEnd) s.portRangeEnd = clamp(body.portRangeEnd, 1024, 65535);
    if (body.autoRestart !== undefined) s.autoRestart = Boolean(body.autoRestart);
    if (body.maxCrashRestarts !== undefined) s.maxCrashRestarts = clamp(body.maxCrashRestarts, 0, 100);
    store.save();
    return { settings: s };
  });

  /* ------------------------------------------------------------ dispatch -- */

  async function handle(req, res, url) {
    const match = router.match(req.method, url.pathname);
    if (!match) {
      json(res, 404, { error: 'Endpoint not found' });
      return;
    }
    const { route, params } = match;

    let user = null;
    if (!route.public) {
      user = auth.userFromRequest(req);
      if (!user) {
        json(res, 401, { error: 'Not signed in' });
        return;
      }
    }

    let body = {};
    if (!route.rawBody && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      body = await readJson(req);
    }

    const result = await route.handler({ req, res, url, params, body, user });
    if (res.writableEnded || result === undefined) return;
    json(res, 200, result);
  }

  return { handle, router };
}

function clientIp(req) {
  if (config.behindProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  return config.behindProxy && String(req.headers['x-forwarded-proto'] || '').includes('https');
}

module.exports = { createApi, HttpError, VERSION };
