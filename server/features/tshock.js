'use strict';

/**
 * tShock plugin extras for Terraria: installing a plugin from any https
 * address or from an uploaded file, and telling whether tShock is there at
 * all. Catalogue installs, switching off and removing go through the normal
 * mod provider (mods/providers/tshock.js).
 *
 * tShock loads every *.dll in ServerPlugins/. A download is either that
 * .dll or a .zip holding one or more of them; anything else is refused.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');
const dns = require('dns/promises');
const https = require('https');
const crypto = require('crypto');

const { fail, HttpError } = require('../core/util');
const { containedPath } = require('./files');
const { safeFileName } = require('./mods/http');
const tshockProvider = require('./mods/providers/tshock');

const PLUGIN_DIR = 'ServerPlugins';
const MAX_BYTES = 64 * 1024 * 1024;

const privateAddress = (ip) =>
  net.isIPv4(ip)
    ? /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)
    : /^(::1?$|f[cd]|fe[89ab])/i.test(ip) || /^::ffff:/i.test(ip);

/** Download an https address to a file. No private addresses, 3 redirects at most, size capped. */
async function download(input, target, hops = 0) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    fail(400, 'That is not a web address');
  }
  if (url.protocol !== 'https:') fail(400, 'Only https:// addresses are accepted');
  if (url.username || url.password) fail(400, 'The address cannot contain a user name or password');
  const lookups = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!lookups.length) fail(400, `Could not find ${url.hostname}`);
  if (lookups.some((l) => privateAddress(l.address))) fail(400, 'That address points inside your network');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: lookups[0].address, servername: url.hostname, path: url.pathname + url.search, headers: { host: url.hostname, 'user-agent': 'GamePanel' }, timeout: 20000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= 3) return reject(new HttpError(400, 'Too many redirects'));
          return download(new URL(res.headers.location, url).toString(), target, hops + 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new HttpError(400, `The address answered ${res.statusCode}`));
        }
        let size = 0;
        const out = fs.createWriteStream(target, { flags: 'w' });
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            out.destroy();
            reject(new HttpError(400, 'That file is bigger than 64 MB'));
          }
        });
        res.pipe(out);
        out.on('finish', () => resolve({ size, name: decodeURIComponent(path.posix.basename(url.pathname)) }));
        out.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('The address took too long to answer')));
    req.on('error', (err) => reject(err instanceof HttpError ? err : new HttpError(400, err.message)));
  });
}

/** What is in ServerPlugins and whether tShock itself looks installed. */
function status(server) {
  const exists = (rel) => {
    try {
      return fs.existsSync(containedPath(server.dir, rel));
    } catch {
      return false;
    }
  };
  return {
    tshock: exists('TShockAPI.dll') || exists('tshock') || exists('TShock.Server') || exists(PLUGIN_DIR),
    config: exists('tshock/config.json'),
    pluginDir: PLUGIN_DIR,
  };
}

/**
 * Put a downloaded or uploaded file in ServerPlugins/ and delete it from
 * where it was. Returns the plugin file names written.
 */
async function installFile(server, file, nameHint) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  const dir = containedPath(server.dir, PLUGIN_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const written = [];
  try {
    if (head[0] === 0x50 && head[1] === 0x4b) {
      let dlls;
      try {
        dlls = tshockProvider.dllsInZip(file);
      } catch {
        fail(400, 'That zip file could not be read');
      }
      if (!dlls.length) fail(400, 'There is no plugin .dll inside that zip');
      for (const { name, data } of dlls) {
        await fsp.writeFile(containedPath(server.dir, `${PLUGIN_DIR}/${name}`), data);
        written.push(name);
      }
    } else if (head[0] === 0x4d && head[1] === 0x5a) {
      let name = safeFileName(nameHint, 'plugin.dll');
      if (!/\.dll$/i.test(name)) name = `${name.replace(/\.[^.]*$/, '') || 'plugin'}.dll`;
      await fsp.copyFile(file, containedPath(server.dir, `${PLUGIN_DIR}/${name}`));
      written.push(name);
    } else {
      fail(400, 'That is not a plugin: expected a .dll or a .zip containing one');
    }
  } finally {
    await fsp.rm(file, { force: true });
  }
  return written;
}

const tempFile = (server) => containedPath(server.dir, `.gamepanel/downloads/${crypto.randomBytes(6).toString('hex')}.tmp`);

async function installFromUrl(server, url) {
  const temp = tempFile(server);
  try {
    const got = await download(url, temp);
    return await installFile(server, temp, got.name);
  } catch (err) {
    await fsp.rm(temp, { force: true });
    throw err;
  }
}

module.exports = { status, installFile, installFromUrl, download, tempFile, privateAddress, PLUGIN_DIR, MAX_BYTES };
