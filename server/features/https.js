'use strict';

/**
 * Built-in HTTPS with a free Let's Encrypt certificate, so the panel works
 * at https://panel.example.com without a reverse proxy (and so passkeys and
 * the phone app work away from home).
 *
 * The certificate is proven with http-01 (Let's Encrypt calls
 * http://<domain>/.well-known/acme-challenge/… on port 80, which the panel
 * answers) or, when port 80 cannot reach this machine, with dns-01 through
 * the Cloudflare token under Settings → Integrations. It renews itself 30
 * days before it runs out; the HTTPS listener swaps certificates in place.
 *
 * settings.https = { enabled, domain, email, method: 'http'|'cloudflare', port, redirect, staging, directory }
 * <data>/tls/ account.pem, account.json, key.pem, cert.pem
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../core/config');
const { fail, logger } = require('../core/util');
const acme = require('../core/acme');

const RENEW_BEFORE_MS = 30 * 86_400_000;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

const tlsDir = () => path.join(config.dataDir, 'tls');
const file = (name) => path.join(tlsDir(), name);
const challenges = new Map(); // token -> key authorization (http-01)

let state = { store: null, handler: null, onUpgrade: null, server: null, port: null, issuing: null, lastError: null, lastAttempt: null, log: [] };

const settingsOf = (store) => ({ enabled: false, domain: '', email: '', method: 'http', port: 443, redirect: true, staging: false, directory: '', challengePort: 80, ...(store.state.settings.https || {}) });

/* ---------------------------------------------------------- certificate -- */

function certInfo() {
  try {
    const pem = fs.readFileSync(file('cert.pem'), 'utf8');
    const cert = new crypto.X509Certificate(pem);
    return {
      domains: (cert.subjectAltName || '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean),
      issuer: (cert.issuer.match(/O=([^\n]+)/) || cert.issuer.match(/CN=([^\n]+)/) || [])[1] || cert.issuer,
      notAfter: new Date(cert.validTo).getTime(),
      notBefore: new Date(cert.validFrom).getTime(),
    };
  } catch {
    return null;
  }
}

/** When to renew: a third of the way from the end (30 days for a 90-day certificate, two for a six-day one). */
function renewAt(info) {
  const lifetime = info.notAfter - info.notBefore;
  return info.notAfter - Math.min(RENEW_BEFORE_MS, lifetime / 3);
}

function certStatus() {
  try {
    const info = certInfo();
    return info ? { ...info, renewAt: renewAt(info) } : null;
  } catch {
    return null;
  }
}

function accountKey() {
  fs.mkdirSync(tlsDir(), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file('account.pem'))) fs.writeFileSync(file('account.pem'), acme.newKey(), { mode: 0o600 });
  return fs.readFileSync(file('account.pem'), 'utf8');
}

function directoryFor(s) {
  if (s.directory) return s.directory;
  return s.staging ? acme.LETS_ENCRYPT_STAGING : acme.LETS_ENCRYPT;
}

/** Answer http-01 requests: `/.well-known/acme-challenge/<token>`. */
function answerChallenge(req, res) {
  const m = String(req.url || '').match(/^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/);
  if (!m) return false;
  const value = challenges.get(m[1]);
  res.writeHead(value ? 200 : 404, { 'Content-Type': 'text/plain' });
  res.end(value || 'Not found');
  return true;
}

/** Make sure something answers on the challenge port while a certificate is issued. */
async function challengeListener(s) {
  const port = Number(s.challengePort) || 80;
  if (port === config.port) return () => {}; // the panel's own HTTP server answers already
  const server = http.createServer((req, res) => {
    if (!answerChallenge(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', (err) =>
      reject(
        new Error(
          err.code === 'EACCES'
            ? `The panel is not allowed to use port ${port}. Run it with that right (CAP_NET_BIND_SERVICE), forward port ${port} to ${config.port}, or use the Cloudflare method.`
            : err.code === 'EADDRINUSE'
              ? `Port ${port} is taken by another program (a web server?). Point it at the panel, or use the Cloudflare method.`
              : err.message
        )
      )
    );
    server.listen(port, config.host, resolve);
  });
  return () => new Promise((resolve) => server.close(() => resolve()));
}

/* ------------------------------------------------------- Cloudflare DNS -- */

async function cloudflareTxt(store, domain, value) {
  const dns = require('./dns');
  const c = store.state.settings?.integrations?.cloudflare;
  if (!c?.token) fail(400, 'Add a Cloudflare token under Settings → Integrations to use the Cloudflare method');
  const zones = await dns.cf(c.token, 'GET', `/zones?name=${encodeURIComponent(c.domain || domain.split('.').slice(-2).join('.'))}`);
  if (!zones?.length) fail(400, `Cloudflare has no zone for ${domain} with that token`);
  const zone = zones[0].id;
  const name = `_acme-challenge.${domain}`;
  const record = await dns.cf(c.token, 'POST', `/zones/${zone}/dns_records`, { type: 'TXT', name, content: value, ttl: 60 });
  // Wait until the world (Cloudflare's own resolver) sees it.
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if ((data?.Answer || []).some((a) => String(a.data).replace(/"/g, '') === value)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return () => dns.cf(c.token, 'DELETE', `/zones/${zone}/dns_records/${record.id}`).catch(() => {});
}

/* --------------------------------------------------------------- issuing -- */

function log(line) {
  state.log = [...state.log, { at: Date.now(), line }].slice(-40);
  logger.info(`HTTPS: ${line}`);
}

/** Get (or renew) the certificate. One at a time. */
function issue(store) {
  if (state.issuing) return state.issuing;
  state.issuing = (async () => {
    const s = settingsOf(store);
    state.lastAttempt = Date.now();
    state.log = [];
    try {
      if (!DOMAIN_RE.test(s.domain)) fail(400, 'Enter the domain the panel is reached at, like panel.example.com');
      const meta = (() => {
        try {
          return JSON.parse(fs.readFileSync(file('account.json'), 'utf8'));
        } catch {
          return {};
        }
      })();
      const directoryUrl = directoryFor(s);
      const client = new acme.AcmeClient({ directoryUrl, accountKey: accountKey(), kid: meta.directory === directoryUrl ? meta.kid : null, log });
      if (!client.kid) {
        log(`Creating an account with ${new URL(directoryUrl).hostname}`);
        await client.account(s.email);
        fs.writeFileSync(file('account.json'), JSON.stringify({ directory: directoryUrl, kid: client.kid }), { mode: 0o600 });
      }
      const domainKey = acme.newKey();
      let stopListener = null;
      const solve =
        s.method === 'cloudflare'
          ? async (challenge) => cloudflareTxt(store, s.domain, client.dnsValue(challenge.token))
          : async (challenge) => {
              challenges.set(challenge.token, client.keyAuthorization(challenge.token));
              stopListener ||= await challengeListener(s);
              return () => challenges.delete(challenge.token);
            };
      let chain;
      try {
        chain = await client.certificate([s.domain], { kinds: [s.method === 'cloudflare' ? 'dns-01' : 'http-01'], solve, domainKey });
      } finally {
        await stopListener?.();
      }
      fs.writeFileSync(file('key.pem'), domainKey, { mode: 0o600 });
      fs.writeFileSync(file('cert.pem'), chain, { mode: 0o600 });
      state.lastError = null;
      const info = certInfo();
      log(`Certificate ready, valid until ${new Date(info.notAfter).toISOString().slice(0, 10)}`);
      store.addEvent('panel.https', `HTTPS certificate for ${s.domain} issued, valid until ${new Date(info.notAfter).toISOString().slice(0, 10)}`);
      await serve(store);
      return info;
    } catch (err) {
      state.lastError = err.message;
      log(`Failed: ${err.message}`);
      store.addEvent('panel.https_failed', `Could not get an HTTPS certificate for ${s.domain}: ${err.message}`);
      throw err;
    } finally {
      state.issuing = null;
    }
  })();
  return state.issuing;
}

/* -------------------------------------------------------------- serving -- */

/** Start, update or stop the HTTPS listener to match the settings and certificate. */
async function serve(store) {
  const s = settingsOf(store);
  const info = certInfo();
  if (!s.enabled || !info) {
    if (state.server) {
      await new Promise((resolve) => state.server.close(() => resolve()));
      state.server = null;
      state.port = null;
    }
    return;
  }
  const options = { key: fs.readFileSync(file('key.pem')), cert: fs.readFileSync(file('cert.pem')) };
  if (state.server && state.port === s.port) {
    state.server.setSecureContext(options); // a renewal: no restart, no dropped connections
    return;
  }
  if (state.server) await new Promise((resolve) => state.server.close(() => resolve()));
  const server = https.createServer(options, state.handler);
  server.on('upgrade', state.onUpgrade);
  server.on('clientError', (err, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(err.code === 'EACCES' ? `The panel is not allowed to use port ${s.port}. Pick a port above 1024 or give it that right.` : err.code === 'EADDRINUSE' ? `Port ${s.port} is taken by another program` : err.message)));
    server.listen(s.port, config.host, resolve);
  });
  state.server = server;
  state.port = s.port;
  logger.info(`GamePanel listening on https://${s.domain}${s.port === 443 ? '' : `:${s.port}`}`);
}

/** Plain-HTTP requests for the panel's domain go to HTTPS (IP addresses and other names keep working). */
function redirect(store, req, res) {
  const s = settingsOf(store);
  if (!s.enabled || !s.redirect || !state.server) return false;
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (host !== s.domain) return false;
  res.writeHead(301, { Location: `https://${s.domain}${s.port === 443 ? '' : `:${s.port}`}${req.url}` });
  res.end();
  return true;
}

/** Called once at boot with the panel's own request and upgrade handlers. */
async function start(store, handler, onUpgrade) {
  state = { ...state, store, handler, onUpgrade };
  try {
    await serve(store);
  } catch (err) {
    state.lastError = err.message;
    logger.warn(`HTTPS did not start: ${err.message}`);
  }
  // Daily: renew in good time.
  const timer = setInterval(() => {
    const s = settingsOf(store);
    const info = certInfo();
    if (s.enabled && s.domain && (!info || Date.now() >= renewAt(info)) && !state.issuing) {
      issue(store).catch(() => {});
    }
  }, 3_600_000);
  timer.unref?.();
}

function update(store, input) {
  const s = settingsOf(store);
  const domain = String(input.domain ?? s.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (domain && !DOMAIN_RE.test(domain)) fail(400, 'Enter the domain like panel.example.com (no IP addresses: certificates are for names)');
  const email = String(input.email ?? s.email).trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'That email address does not look right');
  const port = Number(input.port ?? s.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === config.port) fail(400, 'Pick a port for HTTPS that is not the panel\'s HTTP port');
  const directory = String(input.directory ?? s.directory).trim();
  if (directory && !/^https:\/\//.test(directory)) fail(400, 'The ACME directory must be an https:// address');
  const challengePort = Number(input.challengePort ?? s.challengePort) || 80;
  store.state.settings.https = {
    enabled: Boolean(input.enabled ?? s.enabled),
    domain,
    email,
    method: input.method === 'cloudflare' ? 'cloudflare' : input.method === 'http' ? 'http' : s.method,
    port,
    redirect: input.redirect === undefined ? s.redirect : Boolean(input.redirect),
    staging: Boolean(input.staging ?? s.staging),
    directory,
    challengePort,
  };
  store.save();
  return status(store);
}

function status(store) {
  const s = settingsOf(store);
  return { settings: s, certificate: certStatus(), listening: state.server ? state.port : null, issuing: Boolean(state.issuing), lastError: state.lastError, lastAttempt: state.lastAttempt, log: state.log, httpPort: config.port };
}

module.exports = { start, serve, issue, update, status, redirect, answerChallenge, certInfo };
