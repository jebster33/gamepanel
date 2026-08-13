'use strict';

const crypto = require('crypto');
const path = require('path');
const { exec } = require('child_process');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL = LEVELS[process.env.GP_LOG_LEVEL] || LEVELS.info;

function log(level, ...args) {
  if ((LEVELS[level] || 20) < LEVEL) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase()} ${args.map(stringify).join(' ')}`;
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function stringify(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const logger = {
  debug: (...a) => log('debug', ...a),
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
};

/** Short, URL-safe, collision-resistant id. */
function uid(len = 8) {
  return crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, len).toLowerCase();
}

function json(res, code, body) {
  const payload = Buffer.from(JSON.stringify(body === undefined ? null : body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new HttpError(code, message);
}

/** Read and JSON-parse a request body with a hard size cap. */
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/**
 * Resolve `rel` inside `root`, refusing anything that escapes it.
 * Returns an absolute path that is guaranteed to be at or below root.
 */
function safeJoin(root, rel) {
  const cleaned = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, cleaned);
  const rootRes = path.resolve(root);
  if (target !== rootRes && !target.startsWith(rootRes + path.sep)) {
    throw new HttpError(400, 'Path escapes the server directory');
  }
  return target;
}

function sh(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Replace {{VAR}} placeholders from a flat map of values. */
function interpolate(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'server';
}

/** Constant-time string comparison that tolerates length mismatch. */
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Strip ANSI escapes so console output stays readable in the browser. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '');
}

module.exports = {
  logger,
  uid,
  json,
  fail,
  HttpError,
  readBody,
  readJson,
  safeJoin,
  sh,
  sleep,
  clamp,
  interpolate,
  slugify,
  timingSafeEqual,
  stripAnsi,
};
