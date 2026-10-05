'use strict';

/**
 * Friendly addresses through Cloudflare DNS: play.example.com instead of
 * 203.0.113.7:25565. Creates an A record for the name and, for Minecraft
 * Java, an SRV record so players do not need to type the port.
 *
 * Needs integrations.cloudflare = { token, domain } (a token with Zone:DNS:Edit).
 */

const { fail } = require('../core/util');

const API = 'https://api.cloudflare.com/client/v4';
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

async function cf(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => fail(502, `Could not reach Cloudflare: ${err.cause?.code || err.message}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = data.errors?.[0]?.message || `Cloudflare answered ${res.status}`;
    fail(res.status === 403 || res.status === 401 ? 400 : 502, `Cloudflare: ${msg}`);
  }
  return data.result;
}

function settingsOf(store) {
  const c = store.state.settings?.integrations?.cloudflare;
  if (!c?.token || !c?.domain) fail(400, 'Add a Cloudflare token and domain under Settings, Integrations first');
  return c;
}

async function zoneId(c) {
  if (c.zoneId) return c.zoneId;
  const zones = await cf(c.token, 'GET', `/zones?name=${encodeURIComponent(c.domain)}`);
  if (!zones?.length) fail(400, `Cloudflare has no zone called ${c.domain} for that token`);
  c.zoneId = zones[0].id;
  return c.zoneId;
}

async function publicIp() {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      /* try the next one */
    }
  }
  fail(502, 'Could not work out this machine\'s public IP address');
}

function isJavaMinecraft(server) {
  return String(server.templateId || '').startsWith('minecraft') && server.templateId !== 'minecraft-bedrock';
}

/** Point name.domain at this machine (and add the Minecraft SRV record). */
async function assign(store, server, name, { ip } = {}) {
  const c = settingsOf(store);
  const label = String(name || '').trim().toLowerCase();
  if (!LABEL.test(label)) fail(400, 'Use letters, numbers and dashes, like "play" or "smp"');
  const zone = await zoneId(c);
  const host = `${label}.${c.domain}`;
  const address = ip || (await publicIp());
  if (server.subdomain) await release(store, server).catch(() => {});

  const taken = await cf(c.token, 'GET', `/zones/${zone}/dns_records?name=${encodeURIComponent(host)}`);
  if (taken?.length) fail(409, `${host} already exists in Cloudflare. Pick another name or delete it there.`);

  const records = [];
  const a = await cf(c.token, 'POST', `/zones/${zone}/dns_records`, { type: 'A', name: host, content: address, ttl: 1, proxied: false, comment: `GamePanel: ${server.name}` });
  records.push(a.id);
  const port = Number(server.ports?.game);
  if (isJavaMinecraft(server) && port) {
    const srv = await cf(c.token, 'POST', `/zones/${zone}/dns_records`, {
      type: 'SRV',
      name: `_minecraft._tcp.${host}`,
      data: { priority: 0, weight: 5, port, target: host },
      ttl: 1,
      comment: `GamePanel: ${server.name}`,
    });
    records.push(srv.id);
  }
  server.subdomain = { host, ip: address, port, records, srv: records.length > 1, at: Date.now() };
  store.save();
  return server.subdomain;
}

async function release(store, server) {
  if (!server.subdomain) return { ok: true };
  const c = settingsOf(store);
  const zone = await zoneId(c);
  for (const id of server.subdomain.records || []) {
    await cf(c.token, 'DELETE', `/zones/${zone}/dns_records/${encodeURIComponent(id)}`).catch(() => {});
  }
  delete server.subdomain;
  store.save();
  return { ok: true };
}

/** What players type: just the name when SRV covers the port. */
function playerAddress(server) {
  const s = server.subdomain;
  if (!s) return null;
  return s.srv || !s.port ? s.host : `${s.host}:${s.port}`;
}

module.exports = { assign, release, playerAddress, cf, LABEL };
