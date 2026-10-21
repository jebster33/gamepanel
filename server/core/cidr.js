'use strict';

/** IPv4 and IPv6 addresses and CIDR ranges, without a library. */

const net = require('net');

/** Groups of an IPv6 text half ("1:2:1.2.3.4" allowed at the end) as hex strings. */
function groupsOf(part) {
  if (!part) return [];
  const groups = part.split(':');
  const last = groups[groups.length - 1];
  if (last.includes('.')) {
    const p = last.split('.').map(Number);
    groups.splice(-1, 1, ((p[0] << 8) | p[1]).toString(16), ((p[2] << 8) | p[3]).toString(16));
  }
  return groups;
}

/** The address as a BigInt plus its family, or null. IPv4-mapped IPv6 (::ffff:1.2.3.4) counts as IPv4. */
function parseIp(text) {
  let ip = String(text || '').trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  ip = ip.replace(/%.*$/, '');
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (!family) return null;
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    return { family: 4, bits: 32, value: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
  }
  const [head, tail] = ip.split('::');
  const h = groupsOf(head);
  const t = tail === undefined ? [] : groupsOf(tail);
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return { family: 6, bits: 128, value: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n) };
}

function formatIp(value, family) {
  if (family === 4) return [24n, 16n, 8n, 0n].map((s) => Number((value >> s) & 255n)).join('.');
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  // Shorten the longest run of zero groups to "::".
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.len < 2) return hex.join(':');
  return `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`;
}

/** "10.0.0.0/8", "2001:db8::/32" or a single address. Returns a range or null. */
function parseCidr(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 60) return null;
  const [addr, len, extra] = raw.split('/');
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  let prefix = ip.bits;
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len)) return null;
    prefix = Number(len);
    if (prefix > ip.bits) return null;
  }
  const shift = BigInt(ip.bits - prefix);
  const base = (ip.value >> shift) << shift;
  return { family: ip.family, bits: ip.bits, prefix, base, text: `${formatIp(base, ip.family)}${len !== undefined ? `/${prefix}` : ''}` };
}

function contains(range, ip) {
  const addr = typeof ip === 'string' ? parseIp(ip) : ip;
  if (!addr || addr.family !== range.family) return false;
  const shift = BigInt(range.bits - range.prefix);
  return (addr.value >> shift) << shift === range.base;
}

/** True when the address is in any of the ranges (strings or parsed). */
function matchesAny(ranges, ip) {
  const addr = parseIp(ip);
  if (!addr) return false;
  return ranges.some((r) => contains(typeof r === 'string' ? parseCidr(r) || { family: 0 } : r, addr));
}

const LOOPBACK = ['127.0.0.0/8', '::1'].map(parseCidr);
const isLoopback = (ip) => matchesAny(LOOPBACK, ip);

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8', 'fc00::/7', 'fe80::/10', '::/128'].map(parseCidr);
/** Loopback, LAN, link-local and carrier-grade NAT addresses: never blocked by flood protection. */
const isPrivate = (ip) => isLoopback(ip) || matchesAny(PRIVATE, ip);

/** Validate a list typed by a person. Returns { ranges: [text], bad: [text] } with normalised text. */
function parseList(items) {
  const ranges = [];
  const bad = [];
  for (const item of [].concat(items || [])) {
    const text = String(item || '').trim();
    if (!text) continue;
    const r = parseCidr(text);
    if (r) ranges.push(r.text);
    else bad.push(text.slice(0, 60));
  }
  return { ranges: [...new Set(ranges)], bad };
}

/** The address as a plain string (no ::ffff: prefix), or '' when it is not an address. */
function normalizeIp(text) {
  const ip = parseIp(text);
  return ip ? formatIp(ip.value, ip.family) : '';
}

module.exports = { parseIp, parseCidr, contains, matchesAny, isLoopback, isPrivate, parseList, normalizeIp, formatIp };
