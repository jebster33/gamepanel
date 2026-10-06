'use strict';

/**
 * Web Push to the phone app (iPhone home-screen apps get push on iOS 16.4+).
 *
 * No dependencies: VAPID (RFC 8292) is an ES256 JWT signed with node:crypto,
 * and payloads are encrypted with aes128gcm (RFC 8291) using ECDH + HKDF.
 *
 * Keys live in data/push-keys.json, subscriptions in data/push.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../core/config');
const { logger, fail } = require('../core/util');

const KEYS_FILE = path.join(config.dataDir, 'push-keys.json');
const SUBS_FILE = path.join(config.dataDir, 'push.json');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

// What a phone hears about unless its owner picks otherwise.
const DEFAULT_EVENTS = ['server.crashed', 'server.install_failed', 'backup.failed', 'backup.upload_failed', 'user.lockout', 'user.new_ip', 'schedule.failed', 'server.resource_alert', 'panel.disk_low'];
const EVENT_CHOICES = {
  'server.crashed': 'A server crashes',
  'server.ready': 'A server comes online',
  'server.stopped': 'A server stops',
  'server.idle_stopped': 'A server stops because it is empty',
  'server.woken': 'A player wakes a sleeping server by joining',
  'server.install_failed': 'An install or update fails',
  'backup.failed': 'A backup fails',
  'backup.upload_failed': 'A cloud backup fails',
  'schedule.failed': 'A scheduled task fails',
  'server.resource_alert': 'A server goes over its CPU, memory or disk alert',
  'panel.disk_low': "The panel's disk is almost full",
  'user.login': 'Someone signs in',
  'user.lockout': 'Repeated failed sign-ins',
  'user.new_ip': 'Someone signs in from a new address',
};

/* ------------------------------------------------------------- crypto -- */

function loadKeys() {
  try {
    const saved = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    if (saved.jwk && saved.publicKey) return saved;
  } catch {
    /* first run */
  }
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
  const keys = { jwk, publicKey };
  fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

/** RFC 8291 aes128gcm body for one subscription. */
function encrypt(subscription, payload, { salt = crypto.randomBytes(16), ecdh } = {}) {
  const uaPublic = fromB64u(subscription.keys.p256dh);
  const authSecret = fromB64u(subscription.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Bad subscription keys');

  const local = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

function vapidHeader(keys, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: keys.jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

/* --------------------------------------------------------- the service -- */

class Push {
  constructor(store, auth, manager) {
    this.store = store;
    this.auth = auth;
    this.manager = manager;
    this.keys = loadKeys();
    try {
      this.subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    } catch {
      this.subs = [];
    }
    store.on('event', (event) => this.onEvent(event));
  }

  save() {
    try {
      fs.writeFileSync(SUBS_FILE, JSON.stringify(this.subs), { mode: 0o600 });
    } catch (err) {
      logger.warn(`Could not save push subscriptions: ${err.message}`);
    }
  }

  subscribe(user, subscription, events, device) {
    const endpoint = String(subscription?.endpoint || '');
    // Only real push services: never let a subscription make the panel call arbitrary URLs.
    if (!/^https:\/\/([a-z0-9-]+\.)*(push\.apple\.com|googleapis\.com|mozilla\.com|mozaws\.net|notify\.windows\.com|push\.services\.mozilla\.com)\//i.test(endpoint)) {
      fail(400, 'That is not a push service the panel knows');
    }
    if (!subscription.keys?.p256dh || !subscription.keys?.auth) fail(400, 'The subscription is missing its keys');
    // Real subscriptions have short endpoints and 65-byte / 16-byte keys; and nobody needs hundreds.
    if (endpoint.length > 600 || String(subscription.keys.p256dh).length > 130 || String(subscription.keys.auth).length > 40) fail(400, 'That subscription is not valid');
    const mine = this.subs.filter((s) => s.userId === user.id && s.endpoint !== endpoint);
    if (mine.length >= 20) fail(409, 'This account has too many phones subscribed. Remove some first.');
    if (this.subs.length >= 5000) fail(503, 'Too many phone subscriptions on this panel');
    const picked = Array.isArray(events) ? events.filter((e) => EVENT_CHOICES[e]) : DEFAULT_EVENTS;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    this.subs.push({ userId: user.id, endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, events: picked, device: String(device || '').slice(0, 60), at: Date.now() });
    this.save();
    return this.status(user, endpoint);
  }

  unsubscribe(user, endpoint) {
    this.subs = this.subs.filter((s) => !(s.endpoint === endpoint && s.userId === user.id));
    this.save();
    return { ok: true };
  }

  status(user, endpoint) {
    const mine = this.subs.find((s) => s.endpoint === endpoint && s.userId === user.id);
    return { subscribed: Boolean(mine), events: mine?.events || DEFAULT_EVENTS, choices: EVENT_CHOICES, devices: this.subs.filter((s) => s.userId === user.id).length };
  }

  async send(sub, message) {
    const body = encrypt(sub, JSON.stringify(message));
    const subject = `mailto:gamepanel@${(this.store.state.settings?.panelName || 'gamepanel').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'gamepanel'}.invalid`;
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(this.keys, sub.endpoint, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    // The phone unsubscribed or the app was removed.
    if (res.status === 404 || res.status === 410) {
      this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
      this.save();
    } else if (!res.ok) {
      throw new Error(`push service answered ${res.status}`);
    }
  }

  async test(user, endpoint) {
    const sub = this.subs.find((s) => s.endpoint === endpoint && s.userId === user.id);
    if (!sub) fail(404, 'This device is not subscribed');
    await this.send(sub, { title: 'GamePanel', body: 'Notifications are working.', url: '/app/' });
    return { ok: true };
  }

  onEvent(event) {
    if (!this.subs.length) return;
    for (const sub of this.subs) {
      if (!sub.events.includes(event.type)) continue;
      const user = this.auth.users.find((u) => u.id === sub.userId);
      if (!user) continue;
      // Server events only reach people who can see that server; account events only admins.
      if (event.serverId ? !this.auth.canAccessServer(user, event.serverId) : user.role !== 'admin') continue;
      const server = event.serverId ? this.manager.find(event.serverId) : null;
      this.send(sub, {
        title: server ? server.name : 'GamePanel',
        body: event.message,
        url: server ? `/app/#server/${server.id}` : '/app/',
        tag: `${event.type}:${event.serverId || ''}`,
      }).catch((err) => logger.debug(`Push failed: ${err.message}`));
    }
  }
}

let instance = null;
function init(app) {
  if (!instance) instance = new Push(app.store, app.auth, app.manager);
  return instance;
}

module.exports = { init, encrypt, vapidHeader, DEFAULT_EVENTS, EVENT_CHOICES };
