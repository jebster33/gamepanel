'use strict';

/** Small fetch helpers shared by the mod providers. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { fail } = require('../../core/util');

const UA = 'GamePanel/2 (+https://github.com/jebster33/gamepanel)';
const TIMEOUT = 20000;

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    fail(502, `Could not reach ${new URL(url).hostname}: ${err.cause?.code || err.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    fail(res.status === 404 ? 404 : 502, `${new URL(url).hostname} responded ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  return res.json();
}

const getJson = (url, headers) => request(url, { headers });
const postJson = (url, body, headers) => request(url, { method: 'POST', body, headers });

/** Download to a temporary name first, so a failed download never leaves half a mod behind. */
async function downloadTo(url, target, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(300000) }).catch(
    (err) => fail(502, `Download failed: ${err.cause?.code || err.message}`)
  );
  if (!res.ok || !res.body) fail(502, `Download failed (${res.status})`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  const hash = crypto.createHash('sha1');
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => hash.update(chunk));
  await pipeline(source, fs.createWriteStream(partial));
  await fsp.rename(partial, target);
  const stat = await fsp.stat(target);
  return { path: target, size: stat.size, sha1: hash.digest('hex') };
}

/** Only ever write a plain file name into a mod directory. */
function safeFileName(name, fallback = 'mod.jar') {
  const base = path
    .basename(String(name || ''))
    .replace(/[^A-Za-z0-9._+-]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return base || fallback;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { UA, TIMEOUT, getJson, postJson, downloadTo, safeFileName, mapLimit };
