'use strict';

/**
 * The downloadable client. One prebuilt binary per platform (built by
 * .github/workflows/bridge.yml with the GamePanel icon baked in) is fetched
 * once from the matching GitHub release and cached. Each download is that
 * binary with a small trailer appended: who it belongs to, where the panel
 * is and the key the panel's TLS identity must have. Executables tolerate
 * trailing data, so no compiler or resource editor is needed on the panel.
 *
 *   [binary][JSON][u32 LE JSON length][8-byte magic "GPBRIDG1"]
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../../core/config');
const { logger, fail } = require('../../core/util');

const pkg = require('../../../package.json');

const CLIENT_VERSION = pkg.bridgeClientVersion;
const REPO = process.env.GP_UPDATE_REPO || 'jebster33/gamepanel';
const MAGIC = Buffer.from('GPBRIDG1');

const PLATFORMS = {
  'windows-amd64': { label: 'Windows', asset: 'gamepanel-bridge-windows-amd64.exe', ext: '.exe', magic: Buffer.from('MZ') },
  'linux-amd64': { label: 'Linux (x64)', asset: 'gamepanel-bridge-linux-amd64', ext: '', magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
  'linux-arm64': { label: 'Linux (ARM64)', asset: 'gamepanel-bridge-linux-arm64', ext: '', magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
};

const cacheDir = () => path.join(config.dataDir, 'bridge', 'bin', `v${CLIENT_VERSION}`);

/** Where a ready binary may already be: a bundled copy, a mirror, or the cache. */
function candidates(platform) {
  const { asset } = PLATFORMS[platform];
  const dirs = [process.env.GP_BRIDGE_CLIENT_DIR, path.join(config.rootDir, 'bridge', 'bin'), cacheDir()].filter(Boolean);
  return dirs.map((dir) => path.join(dir, asset));
}

function looksRight(file, platform) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      if (size < 100_000) return false;
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      const tail = Buffer.alloc(8);
      fs.readSync(fd, tail, 0, 8, size - 8);
      // A stamped copy must never be used as the base for another user.
      return head.subarray(0, PLATFORMS[platform].magic.length).equals(PLATFORMS[platform].magic) && !tail.equals(MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function localBinary(platform) {
  return candidates(platform).find((file) => looksRight(file, platform)) || null;
}

const inflight = new Map();

/** The base binary for a platform, downloading it the first time. */
async function baseBinary(platform) {
  if (!PLATFORMS[platform]) fail(400, 'Unknown client platform');
  const local = localBinary(platform);
  if (local) return local;
  if (!inflight.has(platform)) {
    inflight.set(
      platform,
      download(platform).finally(() => inflight.delete(platform))
    );
  }
  return inflight.get(platform);
}

async function download(platform) {
  const { asset } = PLATFORMS[platform];
  const base = process.env.GP_BRIDGE_CLIENT_URL || `https://github.com/${REPO}/releases/download/bridge-v${CLIENT_VERSION}`;
  const url = `${base.replace(/\/$/, '')}/${asset}`;
  const dir = cacheDir();
  const dest = path.join(dir, asset);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  logger.info(`Downloading the bridge client ${CLIENT_VERSION} for ${platform}`);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'GamePanel' }, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    fail(502, `Could not download the bridge client (${err.message}). If this machine is offline, put ${asset} in ${dir}.`);
  }
  if (!res.ok) fail(502, `Could not download the bridge client: GitHub answered ${res.status} for ${url}. Put ${asset} in ${dir} to use a copy you have.`);
  const data = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmp, data, { mode: 0o644 });
  if (!looksRight(tmp, platform)) {
    fs.rmSync(tmp, { force: true });
    fail(502, 'The downloaded bridge client is not a valid program');
  }
  fs.renameSync(tmp, dest);
  return dest;
}

/** What gets appended to the base binary for one connection. */
function trailer(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([body, size, MAGIC]);
}

/** Which platforms can be offered right now (already here, or fetchable). */
function availability() {
  return Object.entries(PLATFORMS).map(([id, p]) => ({ id, label: p.label, ready: Boolean(localBinary(id)) }));
}

module.exports = { PLATFORMS, CLIENT_VERSION, MAGIC, baseBinary, trailer, availability };
