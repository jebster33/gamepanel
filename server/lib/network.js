'use strict';

/**
 * Getting a server reachable, without hunting through two firewalls.
 *
 * Two layers usually stand between a player and a game server:
 *   1. the host firewall (ufw on Ubuntu) — opened here directly
 *   2. the router, when the box is on a home LAN — offered over UPnP IGD,
 *      which most consumer routers speak, with copy-paste instructions as the
 *      fallback for the ones that do not
 */

const os = require('os');
const dgram = require('dgram');
const http = require('http');
const { sh, logger, fail } = require('./util');

/* --------------------------------------------------------------- host fw -- */

async function ufwAvailable() {
  try {
    await sh('command -v ufw', { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

async function ufwStatus() {
  if (!(await ufwAvailable())) return { available: false, active: false, rules: [] };
  try {
    const { stdout } = await sh('sudo -n ufw status 2>/dev/null || ufw status 2>/dev/null', { timeout: 8000 });
    const active = /Status:\s*active/i.test(stdout);
    const rules = stdout
      .split('\n')
      .map((line) => line.match(/^(\d+)(?::(\d+))?\/(tcp|udp)/i))
      .filter(Boolean)
      .map((m) => ({ from: Number(m[1]), to: Number(m[2] || m[1]), protocol: m[3].toLowerCase() }));
    return { available: true, active, rules };
  } catch (err) {
    return { available: true, active: false, rules: [], error: err.message };
  }
}

function isOpenInUfw(status, port, protocol) {
  return (status.rules || []).some(
    (rule) => rule.protocol === protocol && port >= rule.from && port <= rule.to
  );
}

/** Open (or close) a set of ports in ufw. Needs the installer's sudo rule. */
async function ufwSet(ports, open = true) {
  const done = [];
  for (const { port, protocol } of ports) {
    const action = open ? 'allow' : 'delete allow';
    const rule = `${port}/${protocol}`;
    try {
      await sh(`sudo -n ufw ${action} ${rule}`, { timeout: 15000 });
      done.push({ port, protocol, ok: true });
    } catch (err) {
      const message = String(err.stderr || err.message || '').trim();
      done.push({
        port,
        protocol,
        ok: false,
        error: /sudo/i.test(message)
          ? 'The panel is not allowed to run ufw — re-run install.sh to grant it'
          : message.split('\n')[0],
      });
    }
  }
  return done;
}

/* ------------------------------------------------------------------ UPnP -- */

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

/** Find an Internet Gateway Device on the LAN. */
function discoverGateway(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const search = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n'
    );
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.on('message', (msg) => {
      const location = String(msg).match(/^location:\s*(.+)$/im)?.[1]?.trim();
      if (location) finish(location);
    });
    socket.on('error', () => finish(null));
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(search, SSDP_PORT, SSDP_ADDRESS);
      } catch {
        finish(null);
      }
    });
  });
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
  });
}

/** Read the device description to find the WANIPConnection control URL. */
async function describeGateway(location) {
  const xml = await httpGet(location);
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/g)].map((m) => m[1]);
  const wan = services.find((s) => /WANIPConnection|WANPPPConnection/.test(s));
  if (!wan) return null;
  const type = wan.match(/<serviceType>(.*?)<\/serviceType>/)?.[1];
  let controlUrl = wan.match(/<controlURL>(.*?)<\/controlURL>/)?.[1];
  if (!type || !controlUrl) return null;
  if (!/^https?:/.test(controlUrl)) controlUrl = new URL(controlUrl, location).toString();
  return { serviceType: type, controlUrl };
}

function soap(controlUrl, serviceType, action, args = {}) {
  const body =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
    `<u:${action} xmlns:u="${serviceType}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${String(v)}</${k}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`;

  const url = new URL(controlUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST',
        timeout: 8000,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': Buffer.byteLength(body),
          SOAPAction: `"${serviceType}#${action}"`,
        },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            const detail = out.match(/<errorDescription>(.*?)<\/errorDescription>/)?.[1] || `HTTP ${res.statusCode}`;
            reject(new Error(detail));
          } else resolve(out);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('the router did not answer')));
    req.write(body);
    req.end();
  });
}

/** The LAN address the router should forward to. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

async function upnpStatus() {
  const location = await discoverGateway();
  if (!location) return { available: false, reason: 'No UPnP router answered on this network' };
  try {
    const device = await describeGateway(location);
    if (!device) return { available: false, reason: 'The router does not expose port forwarding over UPnP' };
    let externalIp = null;
    try {
      const xml = await soap(device.controlUrl, device.serviceType, 'GetExternalIPAddress');
      externalIp = xml.match(/<NewExternalIPAddress>(.*?)<\/NewExternalIPAddress>/)?.[1] || null;
    } catch {
      /* not fatal */
    }
    return { available: true, device, externalIp, gateway: new URL(location).hostname };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/** Add or remove router port mappings for a server. */
async function upnpSet(ports, open, description) {
  const status = await upnpStatus();
  if (!status.available) fail(400, status.reason || 'UPnP is not available on this network');
  const internal = lanAddress();
  if (!internal) fail(400, 'Could not work out this machine’s LAN address');

  const done = [];
  for (const { port, protocol } of ports) {
    try {
      if (open) {
        await soap(status.device.controlUrl, status.device.serviceType, 'AddPortMapping', {
          NewRemoteHost: '',
          NewExternalPort: port,
          NewProtocol: protocol.toUpperCase(),
          NewInternalPort: port,
          NewInternalClient: internal,
          NewEnabled: 1,
          NewPortMappingDescription: description || 'GamePanel',
          NewLeaseDuration: 0,
        });
      } else {
        await soap(status.device.controlUrl, status.device.serviceType, 'DeletePortMapping', {
          NewRemoteHost: '',
          NewExternalPort: port,
          NewProtocol: protocol.toUpperCase(),
        });
      }
      done.push({ port, protocol, ok: true });
    } catch (err) {
      done.push({ port, protocol, ok: false, error: err.message });
    }
  }
  logger.info(`UPnP ${open ? 'opened' : 'closed'} ${done.filter((d) => d.ok).length}/${done.length} mappings`);
  return { mappings: done, internal, externalIp: status.externalIp };
}

/** Flatten a server's ports into {port, protocol} pairs, expanding "both". */
function serverPorts(server, template) {
  const out = [];
  for (const [name, port] of Object.entries(server.ports || {})) {
    const def = (template?.ports || []).find((p) => p.name === name);
    const protocols = !def?.protocol || def.protocol === 'both' ? ['tcp', 'udp'] : [def.protocol];
    for (const protocol of protocols) out.push({ name, port: Number(port), protocol });
  }
  return out;
}

module.exports = { ufwStatus, ufwSet, isOpenInUfw, upnpStatus, upnpSet, serverPorts, lanAddress };
