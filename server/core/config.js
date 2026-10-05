'use strict';

/**
 * Where everything lives, and the knobs that can be set from the environment.
 *
 *   Linux service   /var/lib/gamepanel
 *   Windows service C:\ProgramData\GamePanel
 *   anything else   ./data inside the checkout (so `node server/index.js` just works)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isWindows, isLinux } = require('./platform');

const rootDir = path.resolve(__dirname, '..', '..');

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultDataDir() {
  if (process.env.GP_DATA_DIR) return path.resolve(process.env.GP_DATA_DIR);
  // Only a real install (the service) claims the system location; a checkout
  // run by hand keeps its state next to itself.
  const system = isWindows
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'GamePanel')
    : isLinux
      ? '/var/lib/gamepanel'
      : null;
  if (system && (process.env.GP_SERVICE || isLinux) && writable(system)) return system;
  return path.join(rootDir, 'data');
}

const dataDir = defaultDataDir();

const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  templatesDir: process.env.GP_TEMPLATES_DIR ? path.resolve(process.env.GP_TEMPLATES_DIR) : path.join(rootDir, 'templates'),

  dataDir,
  serversDir: path.join(dataDir, 'servers'),
  backupsDir: path.join(dataDir, 'backups'),
  logsDir: path.join(dataDir, 'logs'),
  cacheDir: path.join(dataDir, 'cache'),
  runDir: path.join(dataDir, 'run'),
  toolsDir: path.join(dataDir, 'tools'), // SteamCMD, Java runtimes… shared by all servers
  userTemplatesDir: path.join(dataDir, 'templates'),
  stateFile: path.join(dataDir, 'panel.json'),
  secretFile: path.join(dataDir, 'secret.key'),
  steamcmdDir: path.join(dataDir, 'steamcmd'),

  host: process.env.GP_HOST || '0.0.0.0',
  port: Number(process.env.GP_PORT || 8420),
  behindProxy: ['1', 'true'].includes(String(process.env.GP_BEHIND_PROXY)),
  dockerSocket: process.env.GP_DOCKER_SOCKET || (isWindows ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock'),

  consoleBufferLines: Number(process.env.GP_CONSOLE_LINES || 500),
  metricsIntervalMs: Number(process.env.GP_METRICS_INTERVAL || (isWindows ? 3000 : 2000)),
  metricsHistoryPoints: Number(process.env.GP_METRICS_HISTORY || 180),
  queryIntervalMs: Number(process.env.GP_QUERY_INTERVAL || 15000),

  /** Set by the Linux systemd unit and the Windows service wrapper. */
  service: Boolean(process.env.GP_SERVICE),
  hostname: os.hostname(),
};

function ensureDirs() {
  for (const dir of [config.dataDir, config.serversDir, config.backupsDir, config.logsDir, config.cacheDir, config.runDir]) {
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
  return secret;
}

module.exports = { config, ensureDirs, loadSecret };
