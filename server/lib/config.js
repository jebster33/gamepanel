'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const isLinux = process.platform === 'linux';

/**
 * On a real install everything lives under /var/lib/gamepanel.
 * When run from a checkout (or on Windows for development) we keep state in
 * ./data so `node server/index.js` just works with no setup.
 */
function defaultDataDir() {
  if (process.env.GP_DATA_DIR) return path.resolve(process.env.GP_DATA_DIR);
  if (isLinux) {
    const system = '/var/lib/gamepanel';
    try {
      fs.mkdirSync(system, { recursive: true });
      fs.accessSync(system, fs.constants.W_OK);
      return system;
    } catch {
      /* not root / no permission — fall back to a local dir */
    }
  }
  return path.resolve(__dirname, '..', '..', 'data');
}

const dataDir = defaultDataDir();
const rootDir = path.resolve(__dirname, '..', '..');

const config = {
  isLinux,
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  templatesDir: process.env.GP_TEMPLATES_DIR
    ? path.resolve(process.env.GP_TEMPLATES_DIR)
    : path.join(rootDir, 'templates'),
  dataDir,
  serversDir: path.join(dataDir, 'servers'),
  backupsDir: path.join(dataDir, 'backups'),
  logsDir: path.join(dataDir, 'logs'),
  cacheDir: path.join(dataDir, 'cache'),
  stateFile: path.join(dataDir, 'panel.json'),
  secretFile: path.join(dataDir, 'secret.key'),
  steamcmdDir: path.join(dataDir, 'steamcmd'),
  host: process.env.GP_HOST || '0.0.0.0',
  port: Number(process.env.GP_PORT || 8080),
  behindProxy: process.env.GP_BEHIND_PROXY === '1' || process.env.GP_BEHIND_PROXY === 'true',
  consoleBufferLines: Number(process.env.GP_CONSOLE_LINES || 400),
  metricsIntervalMs: Number(process.env.GP_METRICS_INTERVAL || 2000),
  metricsHistoryPoints: Number(process.env.GP_METRICS_HISTORY || 180), // ~6 min at 2s
  queryIntervalMs: Number(process.env.GP_QUERY_INTERVAL || 15000),
  hostname: os.hostname(),
};

function ensureDirs() {
  for (const dir of [
    config.dataDir,
    config.serversDir,
    config.backupsDir,
    config.logsDir,
    config.cacheDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Persistent HMAC secret for session tokens; generated on first boot. */
function loadSecret() {
  try {
    const value = fs.readFileSync(config.secretFile, 'utf8').trim();
    if (value.length >= 32) return value;
  } catch {
    /* generate below */
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(config.secretFile, secret, { mode: 0o600 });
  try {
    fs.chmodSync(config.secretFile, 0o600);
  } catch {
    /* best effort on non-POSIX */
  }
  return secret;
}

module.exports = { config, ensureDirs, loadSecret };
