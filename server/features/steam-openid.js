'use strict';

/**
 * Steam sign-in (OpenID 2.0), with no dependencies.
 *
 * Steam has no client secret: the browser goes to steamcommunity.com, the
 * person signs in there, and Steam sends them back with a signed answer. We
 * never trust that answer by looking at it. We post it back to Steam
 * ("check_authentication") and only accept it when Steam says is_valid:true.
 *
 * Guards, because the answer arrives through the browser:
 *  - the check goes to the fixed Steam address, never to one named in the answer;
 *  - the answer must be for the return address we built (which carries our
 *    signed one-time state), and must have signed the fields we rely on;
 *  - the nonce must be recent and is accepted once (no replays);
 *  - the identity must be a plain steamcommunity.com/openid/id/<17 digits> address.
 * The realm and return address come from the configured panel address, never
 * from the request's Host header or a query parameter.
 */

const ENDPOINT = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const IDENTITY = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const REQUIRED_SIGNED = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'];
const NONCE_WINDOW_MS = 5 * 60_000;
const MAX_PARAMS = 40;

// Nonces already accepted, until they are too old to be accepted anyway.
const seen = new Map();

function remember(nonce, now) {
  for (const [key, at] of seen) if (now - at > NONCE_WINDOW_MS * 2) seen.delete(key);
  if (seen.has(nonce)) return false;
  seen.set(nonce, now);
  return true;
}

/** The address to send the browser to. */
function authUrl({ returnTo, realm }) {
  const params = new URLSearchParams({
    'openid.ns': NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': `${NS}/identifier_select`,
    'openid.claimed_id': `${NS}/identifier_select`,
  });
  return `${ENDPOINT}?${params}`;
}

/** "2026-01-01T12:00:00Z" + a unique suffix: the moment Steam made the answer. */
function nonceTime(nonce) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(nonce);
  return m ? Date.parse(m[1]) : NaN;
}

/**
 * Check a Steam answer. `query` is the callback's URLSearchParams and
 * `returnTo` the exact address we sent. Resolves to the 17-digit SteamID64,
 * or throws an Error with a message fit to show.
 */
async function verify(query, { returnTo, fetchFn = fetch, now = Date.now() } = {}) {
  const bad = (why) => new Error(`Steam sign-in could not be verified (${why}). Try again.`);
  const get = (k) => query.get(`openid.${k}`);
  if (query.get('openid.mode') === 'cancel') throw new Error('Steam sign-in was cancelled');
  const entries = [...query.entries()].filter(([k]) => k.startsWith('openid.'));
  if (entries.length > MAX_PARAMS || entries.some(([k, v]) => k.length > 100 || v.length > 1000)) throw bad('malformed answer');
  if (new Set(entries.map(([k]) => k)).size !== entries.length) throw bad('repeated fields');
  if (get('ns') !== NS || get('mode') !== 'id_res') throw bad('not a sign-in answer');
  if (get('op_endpoint') !== ENDPOINT) throw bad('wrong provider');
  if (!returnTo || get('return_to') !== returnTo) throw bad('answer was for another address');
  const signed = String(get('signed') || '').split(',');
  if (!REQUIRED_SIGNED.every((f) => signed.includes(f))) throw bad('required fields were not signed');
  const claimed = IDENTITY.exec(get('claimed_id') || '');
  if (!claimed || get('identity') !== get('claimed_id')) throw bad('not a Steam account');
  const nonce = get('response_nonce') || '';
  const at = nonceTime(nonce);
  if (!Number.isFinite(at) || Math.abs(now - at) > NONCE_WINDOW_MS) throw bad('answer expired');

  // Ask Steam whether it really made this answer: the same fields, a different mode.
  const body = new URLSearchParams(entries);
  body.set('openid.mode', 'check_authentication');
  let text = '';
  try {
    const res = await fetchFn(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain', 'User-Agent': 'GamePanel' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    text = String(await res.text()).slice(0, 2000);
  } catch (err) {
    throw bad(`Steam did not answer: ${err.message}`);
  }
  const valid = text.split(/\r?\n/).some((line) => line.trim() === 'is_valid:true');
  if (!valid) throw bad('Steam did not confirm it');
  // Only after Steam agreed: burn the nonce, so the same answer cannot be used twice.
  if (!remember(nonce, now)) throw bad('answer already used');
  return claimed[1];
}

/** The public profile name, for display only. Any failure just means "no name". */
async function profileName(steamId, fetchFn = fetch) {
  if (!/^\d{17}$/.test(steamId)) return null;
  try {
    const res = await fetchFn(`https://steamcommunity.com/profiles/${steamId}?xml=1`, { headers: { 'User-Agent': 'GamePanel' }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const m = /<steamID><!\[CDATA\[([^\]]{1,64})\]\]><\/steamID>/.exec(String(await res.text()).slice(0, 200_000));
    return m ? m[1].replace(/[\u0000-\u001f]/g, '').trim() || null : null;
  } catch {
    return null;
  }
}

module.exports = { ENDPOINT, authUrl, verify, profileName, _seen: seen };
