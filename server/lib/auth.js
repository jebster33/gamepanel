'use strict';

/**
 * Users, password hashing and stateless signed session tokens.
 * scrypt for passwords, HMAC-SHA256 for tokens — both from node:crypto.
 */

const crypto = require('crypto');
const { uid, fail, timingSafeEqual } = require('./util');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'gp_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** token = base64url(payloadJSON).base64url(hmac) */
function signToken(secret, payload) {
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifyToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  if (!timingSafeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

class Auth {
  constructor(store, secret) {
    this.store = store;
    this.secret = secret;
    this.failures = new Map(); // ip -> { count, until }
  }

  get users() {
    return this.store.state.users;
  }

  needsSetup() {
    return this.users.length === 0;
  }

  findByUsername(username) {
    const lower = String(username || '').toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === lower);
  }

  createUser({ username, password, role = 'user', servers = [] }) {
    username = String(username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      fail(400, 'Username must be 3-32 characters (letters, numbers, . _ -)');
    }
    if (String(password || '').length < 8) fail(400, 'Password must be at least 8 characters');
    if (this.findByUsername(username)) fail(409, 'That username is already taken');
    const user = {
      id: uid(10),
      username,
      password: hashPassword(password),
      role: role === 'admin' ? 'admin' : 'user',
      servers,
      createdAt: Date.now(),
    };
    this.users.push(user);
    this.store.save();
    return this.publicUser(user);
  }

  setPassword(userId, password) {
    if (String(password || '').length < 8) fail(400, 'Password must be at least 8 characters');
    const user = this.users.find((u) => u.id === userId);
    if (!user) fail(404, 'User not found');
    user.password = hashPassword(password);
    this.store.save();
  }

  deleteUser(userId) {
    const idx = this.users.findIndex((u) => u.id === userId);
    if (idx === -1) fail(404, 'User not found');
    const admins = this.users.filter((u) => u.role === 'admin');
    if (this.users[idx].role === 'admin' && admins.length <= 1) {
      fail(400, 'Cannot delete the only administrator');
    }
    this.users.splice(idx, 1);
    this.store.save();
  }

  /** Rate-limited credential check. Returns a session token. */
  login(username, password, ip = 'unknown') {
    const entry = this.failures.get(ip);
    if (entry && entry.until > Date.now()) {
      fail(429, `Too many failed attempts. Try again in ${Math.ceil((entry.until - Date.now()) / 1000)}s`);
    }
    const user = this.findByUsername(username);
    const ok = user && verifyPassword(password, user.password);
    if (!ok) {
      const next = { count: (entry?.count || 0) + 1, until: 0 };
      if (next.count >= 5) {
        next.until = Date.now() + Math.min(15 * 60_000, 2 ** (next.count - 5) * 30_000);
      }
      this.failures.set(ip, next);
      fail(401, 'Incorrect username or password');
    }
    this.failures.delete(ip);
    user.lastLogin = Date.now();
    this.store.save();
    return {
      token: signToken(this.secret, { sub: user.id, exp: Date.now() + SESSION_TTL_MS }),
      user: this.publicUser(user),
    };
  }

  /** Resolve a request to a user, via cookie or `Authorization: Bearer`. */
  userFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    let token = cookies[COOKIE_NAME];
    const authHeader = req.headers.authorization;
    if (!token && authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
    if (!token) {
      const url = new URL(req.url, 'http://localhost');
      token = url.searchParams.get('token');
    }
    return this.userFromToken(token);
  }

  userFromToken(token) {
    const payload = verifyToken(this.secret, token);
    if (!payload) return null;
    const user = this.users.find((u) => u.id === payload.sub);
    return user || null;
  }

  publicUser(user) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      servers: user.servers || [],
      createdAt: user.createdAt,
      lastLogin: user.lastLogin || null,
    };
  }

  /** Admins see everything; regular users only their assigned servers. */
  canAccessServer(user, serverId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return (user.servers || []).includes(serverId);
  }

  cookieHeader(token, secure) {
    const attrs = [
      `${COOKIE_NAME}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
  }

  clearCookieHeader() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}

module.exports = { Auth, hashPassword, verifyPassword, COOKIE_NAME };
