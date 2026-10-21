'use strict';

/**
 * Operations: the tools that sit around servers rather than inside a game.
 *
 *   per server   trash, search in files, crash reports, log explainer, disk quota, isolation (Docker/process, CPU cores)
 *   panel        calendar, activity feed, costs, dynamic DNS, Prometheus, phone widgets, benchmark, memory pressure, status incidents
 */

const { fail, clamp } = require('../../core/util');
const { isSecure } = require('../helpers');
const trash = require('../../features/trash');
const fileSearch = require('../../features/file-search');
const crashes = require('../../features/crashes');
const logExplain = require('../../features/log-explain');
const quota = require('../../features/disk-quota');
const cpuPin = require('../../features/cpu-pin');
const calendar = require('../../features/calendar');
const feed = require('../../features/activity-feed');
const costs = require('../../features/costs');
const ddns = require('../../features/ddns');
const prom = require('../../features/prometheus');
const widgets = require('../../features/widgets');
const benchmark = require('../../features/benchmark');
const pressure = require('../../features/pressure');
const incidents = require('../../features/incidents');

module.exports = (router, { store, auth, manager, hostMetrics, scheduler }, { serverFor, requireAdmin }) => {
  const ev = (type, text, server) => store.addEvent(type, text, server ? { serverId: server.id } : {});
  const origin = (req) => `${isSecure(req) ? 'https' : 'http'}://${String(req.headers.host || 'localhost').replace(/[^\w.:\-[\]]/g, '')}`;
  const local = (server) => {
    if (server.node) fail(400, 'This works on servers hosted by this panel, not on another node');
    return server;
  };

  /* --------------------------------------------------------------- trash -- */

  router.get('/api/servers/:id/trash', async ({ user, params }) => ({ items: await trash.list(serverFor(user, params.id, 'files').id), keepDays: trash.KEEP_MS / 86400_000 }));

  router.post('/api/servers/:id/trash/:item/restore', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'files.write');
    const out = await trash.restore(server, params.item);
    ev('server.files', `${user.username} restored ${out.path} from the trash on ${server.name}`, server);
    return out;
  });

  router.delete('/api/servers/:id/trash/:item', async ({ user, params }) => {
    await trash.discard(serverFor(user, params.id, 'files.write').id, params.item);
    return { ok: true };
  });

  router.delete('/api/servers/:id/trash', async ({ user, params }) => {
    await trash.empty(serverFor(user, params.id, 'files.write').id);
    return { ok: true };
  });

  /* ----------------------------------------------------- search in files -- */

  router.get('/api/servers/:id/files/grep', async ({ user, params, url }) => {
    const server = local(serverFor(user, params.id, 'files'));
    const q = url.searchParams;
    return fileSearch.search(server.dir, { q: q.get('q'), regex: q.get('regex') === '1', caseSensitive: q.get('case') === '1', files: q.get('files') || '', path: q.get('path') || '', logs: q.get('logs') === '1', context: q.get('context') });
  });

  /* ------------------------------------------------------ crash reports -- */

  router.get('/api/servers/:id/crashes', ({ user, params }) => ({ crashes: crashes.list(serverFor(user, params.id, 'console').id) }));

  router.get('/api/servers/:id/crashes/:crash', ({ user, params }) => crashes.get(serverFor(user, params.id, 'console').id, params.crash));

  router.get('/api/servers/:id/crashes/:crash/bundle', ({ user, params, res }) => {
    const server = serverFor(user, params.id, 'console');
    const text = crashes.bundleText(server, crashes.get(server.id, params.crash));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="crash-${params.crash}.txt"`, 'X-Content-Type-Options': 'nosniff' });
    res.end(text);
  });

  router.delete('/api/servers/:id/crashes/:crash', ({ user, params }) => {
    crashes.remove(serverFor(user, params.id, 'settings').id, params.crash);
    return { ok: true };
  });

  /* -------------------------------------------------------- log explainer -- */

  router.post('/api/servers/:id/explain', ({ user, params, body }) => {
    serverFor(user, params.id, 'console');
    const out = logExplain.explain(body?.line);
    if (!out) fail(400, 'Paste a line from the console or a log');
    return out;
  });

  router.get('/api/servers/:id/explain/recent', ({ user, params }) => {
    const server = serverFor(user, params.id, 'console');
    const lines = manager.rt(server.id).console.filter((e) => e.stream !== 'input' && e.stream !== 'system').slice(-1500).map((e) => e.line);
    return { lines: logExplain.interesting(lines) };
  });

  /* ----------------------------------------------------------- disk quota -- */

  router.get('/api/servers/:id/disk-quota', ({ user, params }) => quota.usage(manager, serverFor(user, params.id)));

  router.put('/api/servers/:id/disk-quota', ({ user, params, body }) => {
    requireAdmin(user);
    const server = serverFor(user, params.id, 'settings');
    const out = quota.set(manager, server, body);
    ev('server.settings', `${user.username} set the disk quota of ${server.name} to ${out.gb ? `${out.gb} GB` : 'none'}`, server);
    return out;
  });

  /* ------------------------------------------- isolation: Docker, CPU cores -- */

  const isolationView = (server) => ({
    runtime: server.runtime || 'auto',
    effective: manager.runtimeFor(server),
    dockerAvailable: Boolean(manager.dockerAvailable),
    windowsBuild: (server.platform || 'linux') === 'windows',
    templateAllowsDocker: manager.template(server)?.container !== false,
    running: manager.isActive(server.id),
    cpu: cpuPin.view(manager, server),
  });

  router.get('/api/servers/:id/isolation', ({ user, params }) => isolationView(serverFor(user, params.id, 'settings')));

  // Where and how a server runs is the host's business: administrators only.
  router.put('/api/servers/:id/isolation', async ({ user, params, body }) => {
    requireAdmin(user);
    const server = local(serverFor(user, params.id, 'settings'));
    if (body?.runtime !== undefined) {
      if (!['auto', 'docker', 'process'].includes(body.runtime)) fail(400, 'Runtime: auto, docker or process');
      if (manager.isActive(server.id)) fail(409, 'Stop the server before changing how it runs');
      if (body.runtime === 'docker' && !manager.dockerAvailable) fail(400, 'Docker is not available on this machine');
      server.runtime = body.runtime === 'auto' ? undefined : body.runtime;
      ev('server.settings', `${user.username} set ${server.name} to run as: ${body.runtime}`, server);
    }
    if (body?.cpuAffinity !== undefined) {
      server.cpuAffinity = cpuPin.validate(body.cpuAffinity) || undefined;
      ev('server.settings', `${user.username} pinned ${server.name} to CPU cores: ${server.cpuAffinity || 'off'}`, server);
      if (manager.isActive(server.id) && body.apply !== false) await cpuPin.apply(manager, server);
    }
    store.save();
    manager.broadcastServers();
    return isolationView(server);
  });

  /* ------------------------------------------------------------ calendar -- */

  router.get('/api/calendar', ({ user, url }) => {
    const from = Number(url.searchParams.get('from')) || Date.now() - 86400_000;
    const to = Math.min(Number(url.searchParams.get('to')) || from + 35 * 86400_000, from + 62 * 86400_000);
    const servers = manager.servers.filter((s) => auth.canAccessServer(user, s.id) && auth.can(user, 'schedules', s.id));
    return { items: calendar.occurrences(manager, servers, from, to), from, to };
  });

  router.get('/api/calendar/forced-wipes', () => ({ wipes: calendar.nextForcedWipes(Date.now(), 8), rule: 'First Thursday of the month, 19:00 UTC' }));

  // Schedules for a wipe that follows the forced wipe (Rust).
  router.post('/api/servers/:id/wipe-plan', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'schedules');
    if (server.templateId !== 'rust') fail(400, 'This is for Rust servers');
    const cadence = ['monthly', 'biweekly', 'weekly'].includes(body?.cadence) ? body.cadence : 'monthly';
    const offset = clamp(body?.offsetHours ?? 0, 0, 24);
    const plan = calendar.wipePlan(cadence, offset);
    const made = plan.map((p) => scheduler.add(server, { ...p, warnMinutes: 10, waitForEmpty: false, wipe: { blueprints: p.name === 'Forced wipe', newSeed: true, updateFirst: true } }));
    ev('server.schedule', `${user.username} added ${made.length} wipe schedule(s) tied to the forced wipe on ${server.name}`, server);
    return { schedules: made };
  });

  /* ------------------------------------------------------- activity feed -- */

  router.get('/api/activity-feed', ({ user, url }) => ({ items: feed.build(store, auth, user, clamp(url.searchParams.get('limit') || 25, 1, 100)) }));

  /* --------------------------------------------------------------- costs -- */

  router.get('/api/ops/costs', ({ user, url }) => {
    requireAdmin(user);
    const month = String(url.searchParams.get('month') || '');
    return costs.report(store, /^\d{4}-\d{2}$/.test(month) ? month : undefined);
  });

  router.put('/api/ops/costs', ({ user, body }) => {
    requireAdmin(user);
    costs.update(store, body || {});
    return costs.report(store);
  });

  /* ----------------------------------------------------------------- DDNS -- */

  router.get('/api/ops/ddns', ({ user }) => {
    requireAdmin(user);
    return ddns.view(store);
  });

  router.put('/api/ops/ddns', ({ user, body }) => {
    requireAdmin(user);
    return ddns.update(store, body || {});
  });

  router.post('/api/ops/ddns/check', async ({ user }) => {
    requireAdmin(user);
    const out = await ddns.check(manager, store, { force: true });
    return { ...out, settings: ddns.view(store) };
  });

  /* ----------------------------------------------------------- Prometheus -- */

  router.get('/api/ops/prometheus', ({ user, req }) => {
    requireAdmin(user);
    return { ...prom.view(store), url: `${origin(req)}/api/public/metrics`, config: prom.prometheusConfig(origin(req)) };
  });

  router.post('/api/ops/prometheus', ({ user, req }) => {
    requireAdmin(user);
    const token = prom.enable(store);
    return { token, ...prom.view(store), url: `${origin(req)}/api/public/metrics` };
  });

  router.delete('/api/ops/prometheus', ({ user }) => {
    requireAdmin(user);
    prom.disable(store);
    return prom.view(store);
  });

  router.get('/api/ops/prometheus/dashboard.json', ({ user, res }) => {
    requireAdmin(user);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="gamepanel-grafana.json"' });
    res.end(JSON.stringify(prom.grafanaDashboard(), null, 2));
  });

  router.get(
    '/api/public/metrics',
    ({ req, res }) => {
      if (!prom.authorized(store, req.headers.authorization)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'text/plain' });
        res.end('unauthorized\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(prom.render({ manager, hostMetrics, version: require('../../../package.json').version }));
    },
    { public: true }
  );

  /* -------------------------------------------------------------- widgets -- */

  router.get('/api/ops/widgets', ({ user, req }) => {
    requireAdmin(user);
    return { widgets: widgets.all(store), origin: origin(req), script: widgets.scriptable(origin(req)) };
  });

  router.post('/api/ops/widgets', ({ user, body, req }) => {
    requireAdmin(user);
    const out = widgets.create(store, body || {});
    return { ...out, url: `${origin(req)}/api/public/widget/${out.token}` };
  });

  router.delete('/api/ops/widgets/:id', ({ user, params }) => {
    requireAdmin(user);
    widgets.remove(store, params.id);
    return { widgets: widgets.all(store) };
  });

  router.get(
    '/api/public/widget/:token',
    ({ params, res }) => {
      const out = widgets.data(store, manager, params.token);
      if (!out) fail(404, 'Unknown widget');
      res.setHeader('Cache-Control', 'no-store');
      return out;
    },
    { public: true }
  );

  router.get(
    '/api/public/widget/:token/badge.svg',
    ({ params, res }) => {
      const out = widgets.data(store, manager, params.token);
      if (!out) fail(404, 'Unknown widget');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(widgets.badgeSvg(out));
    },
    { public: true }
  );

  /* ------------------------------------------------ benchmark and pressure -- */

  router.get('/api/ops/benchmark', ({ user }) => {
    requireAdmin(user);
    return benchmark.status();
  });

  router.post('/api/ops/benchmark', ({ user }) => {
    requireAdmin(user);
    return benchmark.start(manager);
  });

  router.get('/api/ops/pressure', ({ user }) => {
    requireAdmin(user);
    return { ...pressure.snapshot(manager), enabled: store.state.settings.pressure?.enabled !== false };
  });

  router.put('/api/ops/pressure', ({ user, body }) => {
    requireAdmin(user);
    store.state.settings.pressure = { enabled: Boolean(body?.enabled) };
    store.save();
    return { enabled: store.state.settings.pressure.enabled };
  });

  /* ------------------------------------------------------------ incidents -- */

  router.get('/api/ops/incidents', ({ user }) => {
    requireAdmin(user);
    return { incidents: incidents.list(store), statuses: incidents.STATUSES, impacts: incidents.IMPACTS };
  });

  router.post('/api/ops/incidents', ({ user, body }) => {
    requireAdmin(user);
    return incidents.add(store, body || {}, user.username);
  });

  router.post('/api/ops/incidents/:id', ({ user, params, body }) => {
    requireAdmin(user);
    return incidents.addUpdate(store, params.id, body || {});
  });

  router.delete('/api/ops/incidents/:id', ({ user, params }) => {
    requireAdmin(user);
    incidents.remove(store, params.id);
    return { ok: true };
  });
};
