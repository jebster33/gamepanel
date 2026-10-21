'use strict';

/**
 * Dynamic DNS. A home connection's public address changes now and then; this
 * checks it every few minutes and, when it changed, updates
 *
 *   - DuckDNS names (token + the names, comma separated),
 *   - Cloudflare names in the zone from Settings → Integrations (an A record
 *     is created when missing),
 *   - the play.example.com names the panel made for servers (their A record).
 *
 * settings.ddns = { enabled, duckdns: { domains, token }, cloudflareNames: [], servers,
 *   lastIp, lastCheck, lastChange, lastResult }
 */

const secrets = require('../core/secrets');
const { fail, logger } = require('../core/util');
const dns = require('./dns');

const DUCK_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EVERY_MIN = 5;

const settingsOf = (store) => (store.state.settings.ddns ||= { enabled: false, duckdns: { domains: '', token: '' }, cloudflareNames: [], servers: true, lastIp: '', lastCheck: 0, lastChange: 0, lastResult: '' });

function view(store) {
  const s = settingsOf(store);
  return { ...s, duckdns: { domains: s.duckdns?.domains || '', tokenSet: Boolean(s.duckdns?.token) }, cloudflareReady: Boolean(store.state.settings.integrations?.cloudflare?.token) };
}

function update(store, body = {}) {
  const s = settingsOf(store);
  if (body.enabled !== undefined) s.enabled = Boolean(body.enabled);
  if (body.servers !== undefined) s.servers = Boolean(body.servers);
  if (body.duckdns) {
    if (body.duckdns.domains !== undefined) {
      const names = String(body.duckdns.domains).split(/[,\s]+/).map((n) => n.trim().replace(/\.duckdns\.org$/i, '')).filter(Boolean);
      if (names.length > 10) fail(400, 'DuckDNS: 10 names at most');
      for (const n of names) if (!DUCK_NAME.test(n)) fail(400, `"${n}" is not a DuckDNS name (letters, numbers and dashes)`);
      s.duckdns.domains = names.join(',');
    }
    if (body.duckdns.clearToken) s.duckdns.token = '';
    else if (String(body.duckdns.token || '').trim()) {
      const token = String(body.duckdns.token).trim();
      if (!/^[0-9a-f-]{20,64}$/i.test(token)) fail(400, 'That does not look like a DuckDNS token');
      s.duckdns.token = secrets.seal(token);
    }
  }
  if (body.cloudflareNames !== undefined) {
    const names = (Array.isArray(body.cloudflareNames) ? body.cloudflareNames : String(body.cloudflareNames).split(/[,\s]+/)).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
    if (names.length > 10) fail(400, 'Cloudflare: 10 names at most');
    for (const n of names) if (!HOST.test(n)) fail(400, `"${n}" is not a valid host name`);
    s.cloudflareNames = names;
  }
  store.save();
  return view(store);
}

async function updateDuck(s, ip) {
  const token = secrets.open(s.duckdns.token);
  const res = await fetch(`https://www.duckdns.org/update?domains=${encodeURIComponent(s.duckdns.domains)}&token=${encodeURIComponent(token)}&ip=${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(15_000) }).catch((err) => {
    throw new Error(`DuckDNS unreachable (${err.cause?.code || 'network'})`);
  });
  const text = (await res.text()).trim();
  if (!/^OK/i.test(text)) throw new Error('DuckDNS refused the update (check the token and names)');
}

async function updateCloudflare(store, names, ip) {
  const c = dns.settingsOf(store);
  const zone = await dns.zoneId(c);
  for (const name of names) {
    if (!name.endsWith(c.domain) && name !== c.domain) throw new Error(`${name} is not in the Cloudflare zone ${c.domain}`);
    const found = await dns.cf(c.token, 'GET', `/zones/${zone}/dns_records?type=A&name=${encodeURIComponent(name)}`);
    if (found?.length) {
      if (found[0].content !== ip) await dns.cf(c.token, 'PUT', `/zones/${zone}/dns_records/${encodeURIComponent(found[0].id)}`, { type: 'A', name, content: ip, ttl: 1, proxied: false, comment: 'GamePanel DDNS' });
    } else {
      await dns.cf(c.token, 'POST', `/zones/${zone}/dns_records`, { type: 'A', name, content: ip, ttl: 1, proxied: false, comment: 'GamePanel DDNS' });
    }
  }
}

async function updateServerNames(manager, store, ip) {
  const c = dns.settingsOf(store);
  const zone = await dns.zoneId(c);
  let n = 0;
  for (const server of manager.servers) {
    const sub = server.subdomain;
    if (!sub?.records?.length || sub.ip === ip) continue;
    await dns.cf(c.token, 'PUT', `/zones/${zone}/dns_records/${encodeURIComponent(sub.records[0])}`, { type: 'A', name: sub.host, content: ip, ttl: 1, proxied: false, comment: `GamePanel: ${server.name}` });
    sub.ip = ip;
    n++;
  }
  return n;
}

/** Look up the public address and update whatever needs it. `force` updates even when it did not change. */
async function check(manager, store, { force = false } = {}) {
  const s = settingsOf(store);
  const ip = await dns.publicIp();
  s.lastCheck = Date.now();
  if (ip === s.lastIp && !force) {
    store.save();
    return { changed: false, ip };
  }
  const done = [];
  const problems = [];
  const attempt = async (label, fn) => {
    try {
      const out = await fn();
      done.push(typeof out === 'number' ? `${label} (${out})` : label);
    } catch (err) {
      problems.push(`${label}: ${err.message}`);
    }
  };
  if (s.duckdns?.domains && s.duckdns.token) await attempt('DuckDNS', () => updateDuck(s, ip));
  if (s.cloudflareNames?.length) await attempt('Cloudflare', () => updateCloudflare(store, s.cloudflareNames, ip));
  if (s.servers && store.state.settings.integrations?.cloudflare?.token && manager.servers.some((x) => x.subdomain)) await attempt('Server names', () => updateServerNames(manager, store, ip));
  if (!problems.length) s.lastIp = ip;
  if (s.lastIp === ip) s.lastChange = Date.now();
  s.lastResult = problems.length ? problems.join('; ').slice(0, 400) : `${ip}: updated ${done.join(', ') || 'nothing (no names set)'}`;
  store.save();
  store.addEvent('panel.ddns', problems.length ? `Dynamic DNS could not update everything: ${s.lastResult}` : `Public address is now ${ip}; ${done.join(', ') || 'no names to update'}`);
  return { changed: true, ip, done, problems };
}

let busy = false;
async function tick(manager, store, now) {
  const s = settingsOf(store);
  if (!s.enabled || busy || now - s.lastCheck < EVERY_MIN * 60_000) return;
  busy = true;
  try {
    await check(manager, store);
  } catch (err) {
    s.lastCheck = now;
    s.lastResult = err.message.slice(0, 300);
    logger.warn(`Dynamic DNS: ${err.message}`);
  } finally {
    busy = false;
  }
}

module.exports = { view, update, check, tick };
