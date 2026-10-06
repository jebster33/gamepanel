'use strict';

/**
 * "Can people on the internet reach this server?" The panel cannot answer
 * that from inside the network, so it asks a service outside it:
 *
 *   Minecraft Java and Bedrock   mcsrvstat.us joins the server list ping (Bedrock over UDP)
 *   any TCP port                 portchecker.io tries to connect
 *
 * Plain UDP ports cannot be tested from outside without the game's own
 * protocol, so those come back as "unknown", with the forwarding steps.
 */

const network = require('./network');

const UA = { 'User-Agent': 'GamePanel reachability check (https://github.com/jebster33/gamepanel)' };
const recent = new Map(); // server id -> { at, result }

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

async function publicIp() {
  const res = await fetch('https://api.ipify.org', { headers: UA, signal: AbortSignal.timeout(10_000) });
  const ip = (await res.text()).trim();
  if (!/^[\d.]+$|^[0-9a-f:]+$/i.test(ip)) throw new Error('Could not find this network\'s public address');
  return ip;
}

async function minecraft(host, port, bedrock) {
  const data = await getJson(`https://api.mcsrvstat.us/${bedrock ? 'bedrock/' : ''}3/${encodeURIComponent(`${host}:${port}`)}`);
  return Boolean(data.online);
}

async function tcpPorts(host, ports) {
  const data = await getJson('https://portchecker.io/api/v1/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, ports }) });
  if (data.error) throw new Error(data.msg || 'portchecker.io could not test it');
  return new Map((data.check || []).map((c) => [Number(c.port), Boolean(c.status)]));
}

/**
 * Test one server. `host` is what players type (a domain or the public IP);
 * empty means the public IP of this network.
 */
async function check(manager, server, { host = '' } = {}) {
  const cached = recent.get(server.id);
  if (cached && Date.now() - cached.at < 30_000) return { ...cached.result, cached: true };
  if (manager.rt(server.id).status !== 'running') return { error: 'Start the server first. Only a running server can be reached.' };

  const template = manager.template(server);
  const ports = network.serverPorts(server, template);
  const ip = await publicIp();
  const target = String(host || '').trim().replace(/^https?:\/\//, '').replace(/[/:].*$/, '') || ip;
  const results = ports.map((p) => ({ ...p, status: 'unknown', how: null }));

  const isJava = template?.category === 'Minecraft' && server.templateId !== 'minecraft-bedrock';
  const isBedrock = server.templateId === 'minecraft-bedrock';
  try {
    if (isJava || isBedrock) {
      const game = results.find((r) => r.name === 'game' && r.protocol === (isBedrock ? 'udp' : 'tcp'));
      if (game) {
        game.status = (await minecraft(target, game.port, isBedrock)) ? 'open' : 'closed';
        game.how = 'mcsrvstat.us joined the server list';
      }
    }
    // Geyser's Bedrock port on a Java server is a Bedrock server of its own.
    const geyser = results.find((r) => r.name === 'bedrock' && r.protocol === 'udp');
    if (geyser && isJava) {
      geyser.status = (await minecraft(target, geyser.port, true)) ? 'open' : 'closed';
      geyser.how = 'mcsrvstat.us joined over Bedrock';
    }
    const tcp = results.filter((r) => r.protocol === 'tcp' && r.status === 'unknown' && r.name !== 'rcon');
    if (tcp.length) {
      const answers = await tcpPorts(target, tcp.map((r) => r.port));
      for (const r of tcp) {
        if (!answers.has(r.port)) continue;
        r.status = answers.get(r.port) ? 'open' : 'closed';
        r.how = 'portchecker.io connected';
      }
    }
  } catch (err) {
    return { error: `The outside check failed: ${err.message}. Try again in a minute.` };
  }
  for (const r of results) if (r.name === 'rcon') r.note = 'Remote admin: better kept closed to the internet';

  const game = results.find((r) => r.name === 'game' && r.status !== 'unknown') || results.find((r) => r.status !== 'unknown' && r.name !== 'rcon');
  const result = {
    publicIp: ip,
    target,
    reachable: game ? game.status === 'open' : null,
    ports: results,
    checkedAt: Date.now(),
  };
  recent.set(server.id, { at: Date.now(), result });
  return result;
}

module.exports = { check };
