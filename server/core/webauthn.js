'use strict';

/**
 * Passkeys (WebAuthn) without a library: just enough CBOR to read what the
 * browser sends, the authenticator data layout, COSE public keys (ES256,
 * RS256, Ed25519), and the signature checks, done by Node's crypto.
 *
 * Attestation is "none": the panel does not care which brand of key made a
 * passkey, only that the same key signs in later.
 */

const crypto = require('crypto');

/* ------------------------------------------------------------------ CBOR -- */

/** Decode one CBOR item. Returns [value, next offset]. Maps keep integer keys as numbers. */
function decodeItem(buf, pos = 0, depth = 0) {
  if (depth > 16) throw new Error('CBOR nested too deep');
  if (pos >= buf.length) throw new Error('CBOR ends early');
  const first = buf[pos++];
  const major = first >> 5;
  const info = first & 0x1f;
  let len = info;
  if (info === 24) len = buf[pos++];
  else if (info === 25) {
    len = buf.readUInt16BE(pos);
    pos += 2;
  } else if (info === 26) {
    len = buf.readUInt32BE(pos);
    pos += 4;
  } else if (info === 27) {
    const big = buf.readBigUInt64BE(pos);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR number too large');
    len = Number(big);
    pos += 8;
  } else if (info > 27) {
    if (major === 7 && info === 31) throw new Error('CBOR break where none belongs');
    throw new Error('CBOR indefinite lengths are not supported');
  }
  switch (major) {
    case 0:
      return [len, pos];
    case 1:
      return [-1 - len, pos];
    case 2: {
      if (pos + len > buf.length) throw new Error('CBOR ends early');
      return [buf.subarray(pos, pos + len), pos + len];
    }
    case 3: {
      if (pos + len > buf.length) throw new Error('CBOR ends early');
      return [buf.toString('utf8', pos, pos + len), pos + len];
    }
    case 4: {
      const out = [];
      for (let i = 0; i < len; i++) {
        let v;
        [v, pos] = decodeItem(buf, pos, depth + 1);
        out.push(v);
      }
      return [out, pos];
    }
    case 5: {
      const out = new Map();
      for (let i = 0; i < len; i++) {
        let k;
        let v;
        [k, pos] = decodeItem(buf, pos, depth + 1);
        [v, pos] = decodeItem(buf, pos, depth + 1);
        out.set(k, v);
      }
      return [out, pos];
    }
    case 6:
      return decodeItem(buf, pos, depth + 1); // a tag: take what it wraps
    case 7:
      if (info === 20) return [false, pos];
      if (info === 21) return [true, pos];
      if (info === 22 || info === 23) return [null, pos];
      throw new Error('CBOR floats are not expected here');
    default:
      throw new Error('bad CBOR');
  }
}

const decode = (buf) => decodeItem(Buffer.from(buf), 0)[0];

/* ------------------------------------------------------- authenticator -- */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

/** The authenticator data: which site, flags, counter and (on registration) the new key. */
function parseAuthData(buf) {
  if (buf.length < 37) throw new Error('authenticator data is too short');
  const flags = buf[32];
  const out = {
    rpIdHash: buf.subarray(0, 32),
    up: Boolean(flags & 0x01),
    uv: Boolean(flags & 0x04),
    be: Boolean(flags & 0x08),
    bs: Boolean(flags & 0x10),
    at: Boolean(flags & 0x40),
    signCount: buf.readUInt32BE(33),
  };
  if (out.at) {
    let pos = 37;
    out.aaguid = buf.subarray(pos, pos + 16);
    pos += 16;
    const idLen = buf.readUInt16BE(pos);
    pos += 2;
    out.credentialId = buf.subarray(pos, pos + idLen);
    pos += idLen;
    const [key, next] = decodeItem(buf, pos);
    out.publicKey = buf.subarray(pos, next);
    out.cose = key;
  }
  return out;
}

/** A COSE key → { alg, key: KeyObject }. */
function coseToKey(cose) {
  const map = cose instanceof Map ? cose : decode(cose);
  const kty = map.get(1);
  const alg = map.get(3);
  if (kty === 2 && alg === -7 && map.get(-1) === 1) {
    const jwk = { kty: 'EC', crv: 'P-256', x: b64u(map.get(-2)), y: b64u(map.get(-3)) };
    return { alg, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) };
  }
  if (kty === 3 && alg === -257) {
    const jwk = { kty: 'RSA', n: b64u(map.get(-1)), e: b64u(map.get(-2)) };
    return { alg, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) };
  }
  if (kty === 1 && alg === -8 && map.get(-1) === 6) {
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: b64u(map.get(-2)) };
    return { alg, key: crypto.createPublicKey({ key: jwk, format: 'jwk' }) };
  }
  throw new Error('This kind of passkey is not supported (use ES256, RS256 or Ed25519)');
}

function verifySignature(cose, data, signature) {
  const { alg, key } = coseToKey(cose);
  if (alg === -8) return crypto.verify(null, data, key, signature);
  return crypto.verify('sha256', data, alg === -257 ? { key, padding: crypto.constants.RSA_PKCS1_PADDING } : key, signature);
}

/** What the browser signed: type, challenge and origin must all be what we expect. */
function checkClientData(clientDataJSON, { type, challenge, origin }) {
  let data;
  try {
    data = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
  } catch {
    throw new Error('The browser sent something unreadable');
  }
  if (data.type !== type) throw new Error('Wrong kind of passkey response');
  const sent = fromB64u(data.challenge);
  const want = fromB64u(challenge);
  if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) throw new Error('That passkey request expired or was not for this sign-in');
  if (data.origin !== origin) throw new Error(`The passkey was used on ${data.origin}, not ${origin}`);
  if (data.crossOrigin === true) throw new Error('Passkeys cannot be used from inside another site');
  return data;
}

/**
 * Check a new passkey. Returns what to keep: { id, publicKey (COSE, base64url), signCount, backedUp }.
 */
function verifyRegistration({ clientDataJSON, attestationObject }, { challenge, origin, rpId }) {
  checkClientData(fromB64u(clientDataJSON), { type: 'webauthn.create', challenge, origin });
  const att = decode(fromB64u(attestationObject));
  const authData = parseAuthData(Buffer.from(att.get('authData')));
  if (!authData.rpIdHash.equals(sha256(rpId))) throw new Error('The passkey was made for another site');
  if (!authData.up) throw new Error('The passkey did not confirm someone was there');
  if (!authData.at || !authData.credentialId?.length) throw new Error('The passkey did not include its key');
  coseToKey(authData.cose); // refuses kinds we cannot check later
  return { id: b64u(authData.credentialId), publicKey: b64u(authData.publicKey), signCount: authData.signCount, backedUp: authData.bs, uv: authData.uv };
}

/** Check a sign-in with a known passkey. Returns { signCount, uv }. */
function verifyAuthentication({ clientDataJSON, authenticatorData, signature }, stored, { challenge, origin, rpId }) {
  const clientData = fromB64u(clientDataJSON);
  checkClientData(clientData, { type: 'webauthn.get', challenge, origin });
  const authBuf = fromB64u(authenticatorData);
  const authData = parseAuthData(authBuf);
  if (!authData.rpIdHash.equals(sha256(rpId))) throw new Error('The passkey is for another site');
  if (!authData.up) throw new Error('The passkey did not confirm someone was there');
  const ok = verifySignature(fromB64u(stored.publicKey), Buffer.concat([authBuf, sha256(clientData)]), fromB64u(signature));
  if (!ok) throw new Error('The passkey signature is not right');
  // A counter that goes backwards means a copied key (synced passkeys always send 0).
  if (authData.signCount !== 0 && stored.signCount && authData.signCount <= stored.signCount) throw new Error('This passkey looks copied: its counter went backwards');
  return { signCount: authData.signCount, uv: authData.uv };
}

module.exports = { decode, parseAuthData, coseToKey, verifyRegistration, verifyAuthentication, checkClientData, b64u, fromB64u };
