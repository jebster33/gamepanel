'use strict';

/**
 * Player skins for the players pages, fetched by the panel (never by the
 * viewer's browser, so nobody's address is shown to Mojang, Microsoft or a
 * head-rendering site, and the page's CSP only needs 'self').
 *
 *  Java:    name -> uuid (Mojang API, or the server's usercache) -> session
 *           server profile -> signed textures property -> the skin PNG on
 *           textures.minecraft.net.
 *  Bedrock: gamertag -> xuid -> Geyser global API -> texture id -> the PNG.
 *  Offline-mode servers (online-mode=false) have no real accounts: no lookup is
 *  made and the page falls back to a letter tile.
 *
 * Results (including "no skin") are cached in memory; the PNG is returned
 * as-is and drawn by the page (head, body) on a canvas.
 */

const { fail } = require('../core/util');
const safefs = require('../core/safefs');
const { containedPath } = require('./files');

const UA = 'GamePanel (+https://github.com/jebster33/gamepanel)';
const TTL = 6 * 3600_000;
const MISS_TTL = 10 * 60_000;
const MAX_CACHE = 400;
const MAX_PNG = 128 * 1024;
const HOSTS = new Set(['textures.minecraft.net']);

const { RateLimiter } = require('../core/ratelimit');

// Uncached lookups only, for the whole panel: a page of unknown names cannot hammer Mojang.
const lookups = new RateLimiter({ limit: 60, windowMs: 60_000 });

const cache = new Map();
const pending = new Map();

const remember = (key, value, ttl) => {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, { value, until: Date.now() + ttl });
};

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
  return res.json();
}

async function getPng(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) throw new Error('unexpected skin host');
  const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!res.ok) throw new Error(`skin responded ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PNG || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a skin image');
  return buf;
}

const dashed = (id) => String(id).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

function onlineMode(manager, server) {
  try {
    const props = safefs.readText(containedPath(server.dir, 'server.properties'), 1024 * 1024);
    return !/^online-mode=false\s*$/m.test(props);
  } catch {
    return true;
  }
}

function cachedUuid(server, name) {
  try {
    const list = JSON.parse(safefs.readText(containedPath(server.dir, 'usercache.json'), 8 * 1024 * 1024));
    const hit = list.find((u) => String(u.name).toLowerCase() === String(name).toLowerCase());
    return hit && /^[0-9a-f-]{32,36}$/i.test(hit.uuid) ? hit.uuid.replace(/-/g, '') : null;
  } catch {
    return null;
  }
}

async function javaSkin(name, uuidHint) {
  let id = uuidHint;
  if (!id) {
    const profile = await getJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
    id = profile?.id;
  }
  if (!id || !/^[0-9a-f]{32}$/i.test(id)) return null;
  const session = await getJson(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
  const prop = (session?.properties || []).find((p) => p.name === 'textures');
  if (!prop) return null;
  let textures;
  try {
    textures = JSON.parse(Buffer.from(String(prop.value), 'base64').toString('utf8'))?.textures;
  } catch {
    return null;
  }
  const skin = textures?.SKIN;
  if (!skin?.url) return null;
  return { png: await getPng(skin.url), slim: skin.metadata?.model === 'slim', uuid: dashed(id) };
}

async function bedrockSkin(name) {
  const gamertag = String(name).replace(/^\./, '');
  const x = await getJson(`https://api.geysermc.org/v2/xbox/xuid/${encodeURIComponent(gamertag)}`);
  if (!x?.xuid) return null;
  const s = await getJson(`https://api.geysermc.org/v2/skin/${encodeURIComponent(String(x.xuid))}`);
  const tex = String(s?.texture_id || '');
  if (!/^[0-9a-f]{20,80}$/i.test(tex)) return null;
  return { png: await getPng(`https://textures.minecraft.net/texture/${tex}`), slim: Boolean(s.is_steve === false), uuid: null };
}

/** A player name that can be looked up: Java names, or Bedrock gamertags (spaces allowed, an optional Floodgate dot). */
const validName = (name, bedrock) => (bedrock ? /^\.?[A-Za-z0-9 _-]{1,32}$/.test(name) : /^[A-Za-z0-9_]{1,16}$/.test(name));

/**
 * { png: Buffer, slim } for a player, or null (no skin, offline mode, no internet).
 */
async function skinFor(manager, server, name) {
  const bedrock = server.templateId === 'minecraft-bedrock';
  const floodgate = !bedrock && /^\./.test(name);
  if (!validName(name, bedrock || floodgate)) fail(400, 'Not a valid player name');
  if (!bedrock && !floodgate && !onlineMode(manager, server)) return null;
  const key = `${bedrock || floodgate ? 'b' : 'j'}:${name.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  if (pending.has(key)) return pending.get(key);
  if (!lookups.take('all')) return null;
  const job = (async () => {
    try {
      const value = bedrock || floodgate ? await bedrockSkin(name) : await javaSkin(name, cachedUuid(server, name));
      remember(key, value, value ? TTL : MISS_TTL);
      return value;
    } catch {
      remember(key, null, MISS_TTL / 2);
      return null;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, job);
  return job;
}

module.exports = { skinFor, validName, cache };
