'use strict';

/**
 * GamePanel — entry point.
 * Wires the HTTP server, static dashboard, REST API and WebSocket stream.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { config, ensureDirs, loadSecret } = require('./lib/config');
const { logger, json, HttpError } = require('./lib/util');
const { Store } = require('./lib/store');
const { Auth } = require('./lib/auth');
const { WebSocketServer } = require('./lib/ws');
const { TemplateRegistry } = require('./lib/templates');
const { ServerManager } = require('./lib/gameserver');
const { HostMetrics } = require('./lib/metrics');
const { createApi, VERSION } = require('./lib/api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function main() {
  ensureDirs();
  const secret = loadSecret();
  const store = new Store(config.stateFile);
  const auth = new Auth(store, secret);
  const templates = new TemplateRegistry();
  const wss = new WebSocketServer();
  const hostMetrics = new HostMetrics();
  const manager = new ServerManager(store, templates, wss);
  const api = createApi({ store, auth, manager, templates, hostMetrics });

  /* ------------------------------------------------------ static assets -- */

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(config.publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(config.publicDir)) {
      json(res, 400, { error: 'Bad path' });
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        // Single-page app: unknown non-asset routes fall back to index.html
        if (!path.extname(rel)) return serveStatic(req, res, '/index.html');
        json(res, 404, { error: 'Not found' });
        return;
      }
      const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304).end();
        return;
      }
      const ext = path.extname(file).toLowerCase();
      // Code and markup revalidate on every load (cheap 304s) so a panel
      // update never leaves a stale dashboard cached in someone's browser.
      const revalidate = ['.html', '.js', '.css', '.json'].includes(ext);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        ETag: etag,
        'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(file).pipe(res);
    });
  }

  /* -------------------------------------------------------- http server -- */

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    try {
      await api.handle(req, res, url);
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpError) {
        json(res, err.code, { error: err.message });
      } else {
        logger.error(`${req.method} ${url.pathname} failed:`, err);
        json(res, 500, { error: err.message || 'Internal server error' });
      }
    }
  });

  server.on('clientError', (err, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  /* ---------------------------------------------------------- websocket -- */

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = auth.userFromRequest(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const conn = wss.handleUpgrade(req, socket, head);
    if (!conn) return;
    conn.user = user;
    conn.subscriptions.add('servers');
    conn.subscriptions.add('stats');
    conn.subscriptions.add('system');
    conn.subscriptions.add('server:status');

    conn.send({ topic: 'hello', version: VERSION, user: auth.publicUser(user) });
    conn.send({ topic: 'servers', servers: manager.servers.filter((s) => auth.canAccessServer(user, s.id)).map((s) => manager.publicServer(s)) });

    conn.on('message', async (msg) => {
      try {
        if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
          for (const topic of msg.topics) {
            // Console streams are per-server and access controlled.
            if (topic.startsWith('console:')) {
              const id = topic.slice(8);
              if (!auth.canAccessServer(conn.user, id) || !auth.can(conn.user, 'console')) continue;
              conn.send({ topic, type: 'lines', serverId: id, lines: manager.getConsole(id) });
            }
            conn.subscriptions.add(topic);
          }
        } else if (msg.type === 'unsubscribe' && Array.isArray(msg.topics)) {
          for (const topic of msg.topics) conn.subscriptions.delete(topic);
        } else if (msg.type === 'command' && msg.serverId) {
          if (!auth.canAccessServer(conn.user, msg.serverId) || !auth.can(conn.user, 'command')) return;
          await manager.sendCommand(msg.serverId, String(msg.command || ''));
        }
      } catch (err) {
        conn.send({ topic: 'error', message: err.message });
      }
    });
  });

  /* ------------------------------------------------------------- timers -- */

  const systemTimer = setInterval(() => {
    const sample = hostMetrics.sample();
    wss.broadcast('system', { host: sample, overview: manager.overview() });
  }, config.metricsIntervalMs);
  systemTimer.unref?.();

  /* ---------------------------------------------------------- lifecycle -- */

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));

  logger.info(`GamePanel ${VERSION} listening on http://${config.host}:${config.port}`);
  logger.info(`Data directory: ${config.dataDir}`);
  if (auth.needsSetup()) logger.info('No users yet — open the panel in a browser to create the first administrator.');

  await manager.init();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down…`);
    clearInterval(systemTimer);
    wss.close();
    server.close();
    try {
      await manager.shutdown();
    } catch (err) {
      logger.error('Error while stopping servers:', err.message);
    }
    store.saveNow();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => logger.error('Uncaught exception:', err));
  process.on('unhandledRejection', (err) => logger.error('Unhandled rejection:', err));
}

main().catch((err) => {
  logger.error('Failed to start GamePanel:', err);
  process.exit(1);
});
