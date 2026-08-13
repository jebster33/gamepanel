'use strict';

/**
 * Best-effort location for a sign-in IP, shown in the activity log.
 *
 * Private and loopback addresses are labelled locally without leaving the
 * machine. Public addresses are looked up through ipwho.is (free, no key) and
 * cached, and the whole thing can be turned off in Settings — see
 * `settings.geoLookup`.
 */

const { logger } = require('./util');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;
const cache = new Map();

/** RFC1918, loopback, link-local, CGNAT and unique-local v6. */
function classifyPrivate(ip) {
  const address = String(ip || '').replace(/^::ffff:/, '');
  if (!address || address === 'unknown') return 'Unknown';
  if (address === '127.0.0.1' || address === '::1') return 'This machine';
  if (/^10\./.test(address)) return 'Local network';
  if (/^192\.168\./.test(address)) return 'Local network';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 'Local network';
  if (/^169\.254\./.test(address)) return 'Link-local';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 'Carrier NAT';
  if (/^(fc|fd)/i.test(address)) return 'Local network';
  if (/^fe80:/i.test(address)) return 'Link-local';
  return null;
}

function normalize(ip) {
  return String(ip || '').replace(/^::ffff:/, '').trim();
}

/**
 * @returns {Promise<string|null>} a short "City, Country" label, or a local
 * descriptor, or null when it could not be determined.
 */
async function locate(ip, { enabled = true } = {}) {
  const address = normalize(ip);
  const local = classifyPrivate(address);
  if (local) return local;
  if (!enabled) return null;

  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.label;

  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(address)}?fields=success,city,region,country,connection`, {
      headers: { 'User-Agent': 'GamePanel/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || data.success === false) throw new Error(data?.message || 'lookup failed');

    const label = [data.city, data.country].filter(Boolean).join(', ') || data.country || null;
    const isp = data.connection?.isp ? ` · ${data.connection.isp}` : '';
    const full = label ? `${label}${isp}` : null;
    cache.set(address, { at: Date.now(), label: full });
    return full;
  } catch (err) {
    logger.debug(`geoip lookup for ${address} failed: ${err.message}`);
    cache.set(address, { at: Date.now(), label: null });
    return null;
  }
}

module.exports = { locate, classifyPrivate };
