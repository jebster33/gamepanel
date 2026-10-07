'use strict';

/**
 * Users, password hashing and stateless signed session tokens.
 * scrypt for passwords, HMAC-SHA256 for tokens — both from node:crypto.
 */

const crypto = require('crypto');
const { uid, fail, timingSafeEqual } = require('./util');
const totp = require('./totp');

/**
 * What a non-admin account is allowed to do, on the servers assigned to it.
 * Administrators implicitly hold every capability.
 */
const CAPABILITIES = [
  { id: 'power', label: 'Start, stop and restart servers', group: 'Server' },
  { id: 'console', label: 'View the console', group: 'Server' },
  { id: 'command', label: 'Send console commands', group: 'Server' },
  {
    id: 'settings',
    label: 'Edit server settings, ports and variables',
    group: 'Server',
    warning: 'Trusted: variables are passed to the game process, so this can influence how it launches.',
  },
  { id: 'schedules', label: 'Manage scheduled tasks', group: 'Server' },
  { id: 'files', label: 'Browse and download files', group: 'Files' },
  {
    id: 'files.write',
    label: 'Upload, edit and delete files',
    group: 'Files',
    warning: 'Trusted: uploaded plugins, mods and scripts run with the game server, so this can run code on this machine unless the server is in a container.',
  },
  { id: 'mods', label: 'Install and remove mods', group: 'Content' },
  { id: 'backups', label: 'Create and download backups', group: 'Backups' },
  { id: 'backups.restore', label: 'Restore and delete backups', group: 'Backups' },
  { id: 'activity', label: 'View the activity log', group: 'Panel' },
  {
    id: 'deploy',
    label: 'Create their own servers (within their quota)',
    group: 'Panel',
    warning: 'They get full access to the servers they create, up to the quota set below.',
  },
  { id: 'templates', label: 'Browse the template catalogue', group: 'Panel' },
];

const CAPABILITY_IDS = CAPABILITIES.map((c) => c.id);

/** A sensible starting point: run the server, look at it, leave it intact. */
const DEFAULT_PERMISSIONS = ['power', 'console', 'command', 'files', 'backups'];

// 2^15 (about 32 MB, tens of milliseconds); hashes stored with a lower cost are upgraded the next time their owner signs in.
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };
// Node refuses scrypt above 32 MB unless told otherwise.
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'gp_session';
// How long the second step of a two-factor sign-in may take.
const TICKET_TTL_MS = 5 * 60 * 1000;
const MAX_REVOKED_TOKENS = 20000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, { ...SCRYPT_PARAMS, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

let decoy;
const decoyHash = () => (decoy ||= hashPassword(crypto.randomBytes(16).toString('hex')));

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
      maxmem: SCRYPT_MAXMEM,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with less work than the current setting. */
function needsRehash(stored) {
  const [scheme, N, r, p] = String(stored).split('$');
  return scheme !== 'scrypt' || Number(N) < SCRYPT_PARAMS.N || Number(r) < SCRYPT_PARAMS.r || Number(p) < SCRYPT_PARAMS.p;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** token = base64url(payloadJSON).base64url(hmac) */
// The passwords every brute-force list tries first.
const COMMON_PASSWORDS = new Set(
  'password password1 password123 12345678 123456789 1234567890 qwertyui qwerty123 11111111 00000000 iloveyou abc12345 welcome1 letmein1 admin123 administrator changeme minecraft gamepanel passw0rd sunshine princess football baseball superman starwars trustno1 dragon12 monkey123 shadow12 master12 whatever 1q2w3e4r qwertyuiop asdfghjk zaq12wsx'.split(' ')
);

function checkPasswordStrength(password, username = '') {
  const value = String(password || '');
  if (value.length < 8) fail(400, 'Password must be at least 8 characters');
  if (value.length > 256) fail(400, 'Password is too long');
  const lower = value.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(value)) fail(400, 'That password is one of the first ones attackers try. Pick another.');
  if (username && lower.includes(String(username).toLowerCase())) fail(400, 'Your password should not contain your username');
}

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

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
/** A request's path the way the router matches it: empty segments dropped. */
const routePath = (url) => `/${new URL(url, 'http://localhost').pathname.split('/').filter(Boolean).join('/')}`;

/** Routes that change accounts, keys, 2FA or who can reach a server: a person signed in, never an API key. */
const isAccountRoute = (url) => /^\/api\/(auth|users)(\/|$)|^\/api\/servers\/[^/]+\/access(\/|$)/.test(routePath(url));

const publicKey = (k) => ({ id: k.id, name: k.name, readOnly: k.readOnly, prefix: k.prefix, createdAt: k.createdAt, lastUsed: k.lastUsed });

class Auth {
  constructor(store, secret) {
    this.store = store;
    this.secret = secret;
    this.failures = new Map(); // ip -> { count, until }
    this.usedTickets = new Map(); // two-factor ticket id -> expiry
  }

  /** A ticket for the code step: good once, for five minutes, and only while the account's sessions are as they were. */
  newTicket(user) {
    return signToken(this.secret, { sub: user.id, v: user.sessionEpoch || 0, jti: crypto.randomBytes(9).toString('base64url'), purpose: '2fa', exp: Date.now() + TICKET_TTL_MS });
  }

  get users() {
    return this.store.state.users;
  }

  /**
   * First-run setup: whoever reaches the panel first would become its
   * administrator. A code printed in the panel's own log (readable only by
   * whoever runs it) is asked for, except from this machine itself.
   */
  setupCode() {
    if (!this.needsSetup()) return null;
    this.setupSecret ||= crypto.randomBytes(5).toString('hex');
    return this.setupSecret;
  }

  checkSetupCode(req, code) {
    const addr = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const local = ['127.0.0.1', '::1'].includes(addr) && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'];
    if (local) return;
    const want = Buffer.from(this.setupCode() || '');
    const got = Buffer.from(String(code || '').trim().toLowerCase());
    if (!want.length || got.length !== want.length || !crypto.timingSafeEqual(want, got)) {
      fail(403, 'Enter the setup code the panel printed when it started (in its log, or run "journalctl -u gamepanel" on Linux).');
    }
  }

  needsSetup() {
    return this.users.length === 0;
  }

  findByUsername(username) {
    const lower = String(username || '').toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === lower);
  }

  createUser({ username, password, role = 'user', servers = [], permissions }) {
    username = String(username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      fail(400, 'Username must be 3-32 characters (letters, numbers, . _ -)');
    }
    checkPasswordStrength(password, username);
    if (this.findByUsername(username)) fail(409, 'That username is already taken');
    const user = {
      id: uid(10),
      username,
      password: hashPassword(password),
      role: role === 'admin' ? 'admin' : 'user',
      servers,
      permissions: sanitizePermissions(permissions ?? DEFAULT_PERMISSIONS),
      createdAt: Date.now(),
    };
    this.users.push(user);
    this.store.save();
    return this.publicUser(user);
  }

  setPassword(userId, password) {
    const user = this.users.find((u) => u.id === userId);
    if (!user) fail(404, 'User not found');
    checkPasswordStrength(password, user.username);
    user.password = hashPassword(password);
    user.sessionEpoch = (user.sessionEpoch || 0) + 1;
    // A key made in a session that has just been ended would otherwise outlive the password change.
    user.apiKeys = [];
    this.store.save();
  }

  /** Ask for the password again before something sensitive; guessing it here counts against the account like a sign-in does. */
  checkPassword(user, password) {
    const key = `pw:${user.id}`;
    this.checkLockout(key);
    if (!verifyPassword(String(password ?? ''), user.password)) {
      this.noteAccountFailure(key);
      fail(403, 'Your password is not right');
    }
    this.failures.delete(key);
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

  checkLockout(ip) {
    const entry = this.failures.get(ip);
    if (entry && entry.until > Date.now()) {
      fail(429, `Too many failed attempts. Try again in ${Math.ceil((entry.until - Date.now()) / 1000)}s`);
    }
  }

  noteAccountFailure(key) {
    // Made-up usernames must not grow this map forever.
    // Only entries that have sat idle for an hour go; a flood of made-up names must not reset real counters.
    const now = Date.now();
    if (this.failures.size > 5000) for (const [k, v] of this.failures) if (v.until < now - 3_600_000 && (v.seen || 0) < now - 3_600_000) this.failures.delete(k);
    const entry = this.failures.get(key);
    const count = (entry?.count || 0) + 1;
    this.failures.set(key, { count, seen: Date.now(), until: count >= 10 ? Date.now() + Math.min(5 * 60_000, 2 ** (count - 10) * 15_000) : 0 });
  }

  recordFailure(ip, message) {
    const entry = this.failures.get(ip);
    const next = { count: (entry?.count || 0) + 1, seen: Date.now(), until: 0 };
    if (next.count >= 5) {
      next.until = Date.now() + Math.min(15 * 60_000, 2 ** (next.count - 5) * 30_000);
      if (next.count === 5) this.store.addEvent('user.lockout', `Sign-ins from ${ip} paused after 5 failed attempts`, { ip });
    }
    this.failures.set(ip, next);
    fail(401, message);
  }

  /**
   * Rate-limited credential check. Returns a session token, or — when the
   * account has two-factor sign-in — a short-lived ticket for the code step.
   */
  login(username, password, ip = 'unknown') {
    this.checkLockout(ip);
    // A slow, spread-out guessing attack from many addresses still hits the
    // account's own limit (kept short, so it cannot lock the owner out for long).
    const account = `user:${String(username || '').toLowerCase()}`;
    this.checkLockout(account);
    const user = this.findByUsername(username);
    // Unknown names still pay for one hash, so response time doesn't reveal which accounts exist.
    const ok = verifyPassword(password, user ? user.password : decoyHash()) && Boolean(user);
    if (!ok) {
      this.noteAccountFailure(account);
      this.recordFailure(ip, 'Incorrect username or password');
    }
    this.failures.delete(account);
    if (user.totp?.secret) {
      return { twoFactor: true, ticket: this.newTicket(user) };
    }
    this.passkeyOnlyAdmin(user);
    // A hash made with less work than today's setting is replaced now that the password is at hand.
    if (needsRehash(user.password)) {
      user.password = hashPassword(password);
      this.store.save();
    }
    return this.startSession(user, ip);
  }

  /**
   * With "require two-factor for administrators" on, an admin whose second
   * factor is a passkey signs in with the passkey: a password (or Google…)
   * alone is one factor.
   */
  passkeyOnlyAdmin(user) {
    if (user.role === 'admin' && this.store.state.settings?.requireAdmin2fa && user.passkeys?.length && !user.totp?.secret) {
      fail(403, 'Administrators sign in with their passkey here. Use "Sign in with a passkey", or set up an authenticator app.');
    }
  }

  /** Second step: the code from the authenticator app, or a recovery code. */
  loginSecondFactor(ticket, code, ip = 'unknown') {
    this.checkLockout(ip);
    const payload = verifyToken(this.secret, ticket);
    if (!payload || payload.purpose !== '2fa') fail(401, 'That sign-in took too long. Enter your password again.');
    const user = this.users.find((u) => u.id === payload.sub);
    if (!user?.totp?.secret) fail(401, 'That sign-in took too long. Enter your password again.');
    // Signing out everywhere (or a password change) since the password step cancels it, and so does having used it.
    const now = Date.now();
    for (const [id, exp] of this.usedTickets) if (exp < now) this.usedTickets.delete(id);
    if ((payload.v || 0) !== (user.sessionEpoch || 0) || (payload.jti && this.usedTickets.has(payload.jti)) || !payload.jti) {
      fail(401, 'That sign-in took too long. Enter your password again.');
    }
    // Someone who has the password can fetch fresh tickets from many addresses;
    // the account's own limit stops them cycling through codes.
    const account = `2fa:${user.id}`;
    this.checkLockout(account);
    const how = this.checkSecondFactor(user, code);
    if (!how) {
      this.noteAccountFailure(account);
      this.recordFailure(ip, 'That code is not right');
    }
    this.failures.delete(account);
    this.usedTickets.set(payload.jti, payload.exp);
    return { ...this.startSession(user, ip), usedRecoveryCode: how === 'recovery', recoveryCodesLeft: (user.totp.recovery || []).length };
  }

  /**
   * Sign in after another service vouched for the person (Google, Discord,
   * GitHub). Two-factor sign-in still applies: the result is the same as a
   * right password.
   */
  loginLinked(user, ip = 'unknown') {
    if (user.totp?.secret) return { twoFactor: true, ticket: this.newTicket(user) };
    this.passkeyOnlyAdmin(user);
    return this.startSession(user, ip);
  }

  sign(payload) {
    return signToken(this.secret, payload);
  }

  verify(token) {
    return verifyToken(this.secret, token);
  }

  /** 'totp' or 'recovery' when the code is good (a recovery code is used up), otherwise null. */
  checkSecondFactor(user, code) {
    const step = totp.verify(user.totp.secret, code, { lastStep: user.totp.lastStep ?? -1 });
    if (step >= 0) {
      user.totp.lastStep = step; // the same code cannot be used twice
      this.store.save();
      return 'totp';
    }
    const hash = totp.hashRecoveryCode(code);
    const idx = (user.totp.recovery || []).indexOf(hash);
    if (String(code || '').replace(/\W/g, '').length >= 8 && idx !== -1) {
      user.totp.recovery.splice(idx, 1);
      this.store.save();
      return 'recovery';
    }
    return null;
  }

  startSession(user, ip) {
    this.failures.delete(ip);
    user.lastLogin = Date.now();
    this.store.save();
    return {
      token: signToken(this.secret, { sub: user.id, v: user.sessionEpoch || 0, exp: Date.now() + SESSION_TTL_MS }),
      user: this.publicUser(user),
    };
  }

  /* ---------------------------------------------------- two-factor setup -- */

  /** A fresh secret to scan. Nothing changes until it is confirmed with a code. */
  beginTwoFactor(userId) {
    const user = this.users.find((u) => u.id === userId);
    if (!user) fail(404, 'User not found');
    // Replacing a working authenticator would let anyone with a stolen session lock the owner out: turn it off first (password and code).
    if (user.totp?.secret) fail(409, 'Two-factor sign-in is already on. Turn it off first (it asks for your password and a code), then set it up again.');
    const secret = totp.generateSecret();
    user.totpPending = { secret, at: Date.now() };
    this.store.save();
    const issuer = this.store.state.settings.panelName || 'GamePanel';
    return { secret, url: totp.otpauthUrl(secret, user.username, issuer) };
  }

  confirmTwoFactor(userId, code) {
    const user = this.users.find((u) => u.id === userId);
    const pending = user?.totpPending;
    if (!pending || Date.now() - pending.at > 30 * 60_000) fail(400, 'Start the setup again, the QR code expired');
    const step = totp.verify(pending.secret, code);
    if (step < 0) fail(400, 'That code is not right. Check the time on your phone and try the newest code.');
    const codes = totp.recoveryCodes();
    user.totp = { secret: pending.secret, enabledAt: Date.now(), lastStep: step, recovery: codes.map(totp.hashRecoveryCode) };
    delete user.totpPending;
    this.store.save();
    return { recoveryCodes: codes };
  }

  disableTwoFactor(userId) {
    const user = this.users.find((u) => u.id === userId);
    if (!user) fail(404, 'User not found');
    delete user.totp;
    delete user.totpPending;
    this.store.save();
  }

  newRecoveryCodes(userId) {
    const user = this.users.find((u) => u.id === userId);
    if (!user?.totp) fail(400, 'Two-factor sign-in is not on');
    const codes = totp.recoveryCodes();
    user.totp.recovery = codes.map(totp.hashRecoveryCode);
    this.store.save();
    return { recoveryCodes: codes };
  }

  /** Resolve a request to a user, via cookie or `Authorization: Bearer`. */
  userFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    let token = cookies[COOKIE_NAME];
    const authHeader = req.headers.authorization;
    // Never from the query string: URLs end up in logs, history and Referer headers.
    if (!token && authHeader && authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
    if (token && token.startsWith('gp_')) {
      // Account changes (passwords, 2FA, keys, users, sub-users) need a person signed in, not a script.
      // Checked on the path as the router sees it: it skips empty segments, so /api//auth is /api/auth.
      if (req.method !== 'GET' && isAccountRoute(req.url)) return null;
      const user = this.requireTwoFactor(this.userFromApiKey(token, req.method), req);
      // Remembered on the request, so the WebSocket and account linking can tell a script from a person.
      if (user) {
        req.gpApiKey = { readOnly: this.apiKeyIsReadOnly(token) };
        req.gpApiKeyId = this.apiKeyRecord(token)?.id;
      }
      return user;
    }
    return this.requireTwoFactor(this.userFromToken(token), req);
  }

  /**
   * With "require two-factor for administrators" on, an admin without it can
   * only reach their own account pages until they set it up.
   */
  requireTwoFactor(user, req) {
    // A passkey counts: it is a second factor on its own.
    if (!user || user.role !== 'admin' || user.totp?.secret || user.passkeys?.length || !this.store.state.settings?.requireAdmin2fa) return user;
    const path = routePath(req.url);
    // Only sign-in and account setup are open; everything else, the live WebSocket included, waits for 2FA.
    if (path === '/ws') return null; // refused like a signed-out socket (the upgrade handler cannot take a throw)
    if (!path.startsWith('/api/') || path.startsWith('/api/auth/')) return user;
    fail(403, 'Two-factor sign-in is required for administrators. Set it up on your Account page first.');
  }

  /** Remember where an account signs in from; true the first time an address is seen. */
  noteSignInAddress(user, ip) {
    if (!ip) return false;
    user.knownIps = user.knownIps || [];
    const known = user.knownIps.includes(ip);
    user.knownIps = [ip, ...user.knownIps.filter((x) => x !== ip)].slice(0, 20);
    this.store.save();
    return !known && user.knownIps.length > 1;
  }

  /* API keys: for scripts and bots. Stored hashed; read-only keys can only GET. */

  createApiKey(userId, { name, readOnly = false } = {}) {
    const user = this.users.find((u) => u.id === userId);
    if (!user) fail(404, 'User not found');
    const label = String(name || '').trim().slice(0, 40);
    if (!label) fail(400, 'Give the key a name so you know what uses it');
    user.apiKeys = user.apiKeys || [];
    if (user.apiKeys.length >= 20) fail(400, 'An account can have at most 20 keys');
    const key = `gp_${crypto.randomBytes(24).toString('base64url')}`;
    const record = { id: crypto.randomBytes(6).toString('hex'), name: label, readOnly: Boolean(readOnly), hash: hashKey(key), prefix: key.slice(0, 7), createdAt: Date.now(), lastUsed: null };
    user.apiKeys.push(record);
    this.store.save();
    return { key, ...publicKey(record) };
  }

  listApiKeys(userId) {
    const user = this.users.find((u) => u.id === userId);
    return (user?.apiKeys || []).map(publicKey);
  }

  deleteApiKey(userId, keyId) {
    const user = this.users.find((u) => u.id === userId);
    if (!user) fail(404, 'User not found');
    const before = (user.apiKeys || []).length;
    user.apiKeys = (user.apiKeys || []).filter((k) => k.id !== keyId);
    if (user.apiKeys.length === before) fail(404, 'No such key');
    this.store.save();
  }

  apiKeyRecord(key) {
    const hash = hashKey(key);
    for (const user of this.users) for (const k of user.apiKeys || []) if (k.hash === hash) return k;
    return null;
  }

  apiKeyIsReadOnly(key) {
    return Boolean(this.apiKeyRecord(key)?.readOnly);
  }

  userFromApiKey(key, method = 'GET') {
    const hash = hashKey(key);
    for (const user of this.users) {
      const record = (user.apiKeys || []).find((k) => k.hash.length === hash.length && crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(hash)));
      if (!record) continue;
      if (record.readOnly && !['GET', 'HEAD'].includes(String(method).toUpperCase())) return null;
      // Remember use at most once a minute, so busy scripts do not rewrite the state file.
      if (!record.lastUsed || Date.now() - record.lastUsed > 60_000) {
        record.lastUsed = Date.now();
        this.store.save();
      }
      return user;
    }
    return null;
  }

  userFromToken(token) {
    const payload = verifyToken(this.secret, token);
    // A half-finished two-factor sign-in is not a session.
    if (!payload || payload.purpose) return null;
    const user = this.users.find((u) => u.id === payload.sub);
    // Signing out everywhere (or a password change) bumps the epoch, which
    // retires every session issued before it.
    if (!user || (payload.v || 0) !== (user.sessionEpoch || 0)) return null;
    if (this.store.state.revokedTokens?.[hashKey(token)]) return null;
    return user;
  }

  /** End every session this account has, on every device. */
  revokeSessions(userId) {
    const user = this.users.find((u) => u.id === userId);
    if (!user) fail(404, 'User not found');
    user.sessionEpoch = (user.sessionEpoch || 0) + 1;
    // API keys count as sessions here: "everywhere" includes scripts that were set up from a stolen session.
    const keys = (user.apiKeys || []).length;
    user.apiKeys = [];
    this.store.save();
    return { apiKeysRevoked: keys };
  }

  /** The session token a request carries (cookie, or Authorization: Bearer): not an API key. */
  tokenFromRequest(req) {
    const authHeader = req.headers.authorization;
    // Never from the query string: URLs end up in logs, history and Referer headers.
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME] || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);
    return token && !token.startsWith('gp_') ? token : null;
  }

  /** Sign out of this one session for good: its token stops working even before it would have expired. */
  revokeToken(token) {
    const payload = verifyToken(this.secret, token);
    if (!payload || payload.purpose) return false;
    const denied = (this.store.state.revokedTokens ||= {});
    const now = Date.now();
    for (const [h, exp] of Object.entries(denied)) if (exp < now) delete denied[h];
    // Past the cap the oldest go: they expire first anyway (every token lives a week).
    const keys = Object.keys(denied);
    if (keys.length >= MAX_REVOKED_TOKENS) for (const h of keys.slice(0, keys.length - MAX_REVOKED_TOKENS + 1)) delete denied[h];
    denied[hashKey(token)] = payload.exp;
    this.store.save();
    return true;
  }

  publicUser(user) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      servers: user.servers || [],
      permissions: user.role === 'admin' ? CAPABILITY_IDS : sanitizePermissions(user.permissions),
      serverPerms: user.role === 'admin' ? {} : user.serverPerms || {},
      createdAt: user.createdAt,
      lastLogin: user.lastLogin || null,
      twoFactor: Boolean(user.totp?.secret),
      passkeys: require('../features/passkeys').publicList(user),
      recoveryCodesLeft: user.totp ? (user.totp.recovery || []).length : undefined,
      quota: user.role === 'admin' ? null : require('../features/quotas').quotaFor(user),
      identities: Object.fromEntries(Object.entries(user.identities || {}).map(([p, i]) => [p, i.name || i.id])),
    };
  }

  /** Admins see everything; regular users only their assigned servers. */
  canAccessServer(user, serverId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return (user.servers || []).includes(serverId);
  }

  /**
   * Capability check. Administrators hold everything; everyone else holds
   * exactly what was ticked for them. Accounts created before permissions
   * existed fall back to the default set rather than being locked out.
   */
  can(user, capability, serverId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return this.permissionsFor(user, serverId).includes(capability);
  }

  /**
   * What an account holds on one server. A server can carry its own set
   * (sub-users added from that server's Access tab); otherwise the account's
   * general permissions apply.
   */
  permissionsFor(user, serverId) {
    if (user.role === 'admin') return CAPABILITY_IDS;
    const own = serverId && user.serverPerms?.[serverId];
    if (own) return sanitizePermissions(own);
    return user.permissions === undefined ? DEFAULT_PERMISSIONS : sanitizePermissions(user.permissions);
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

/** Keep only known capability ids, so the store never holds junk. */
function sanitizePermissions(list) {
  if (!Array.isArray(list)) return [];
  return CAPABILITY_IDS.filter((id) => list.includes(id));
}

module.exports = {
  isAccountRoute,
  Auth,
  hashPassword,
  verifyPassword,
  needsRehash,
  checkPasswordStrength,
  sanitizePermissions,
  COOKIE_NAME,
  CAPABILITIES,
  CAPABILITY_IDS,
  DEFAULT_PERMISSIONS,
};
