'use strict';

/**
 * The panel's bridge identity: an ECDSA P-256 key and a self-signed
 * certificate for it, made once and kept in the data directory.
 *
 * Every client download is stamped with the SHA-256 of this public key, and
 * the client refuses any TLS peer that does not present exactly that key. So
 * the tunnel is authenticated and encrypted end to end even when the panel
 * itself is plain http and whatever sits in between is untrusted. No CA, no
 * expiry to worry about: the pin is the trust.
 *
 * node:crypto can sign but cannot build certificates, so the few DER
 * structures a minimal X.509 v3 certificate needs are encoded by hand below.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* -------------------------------------------------------------- DER bits -- */

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, body) => tlv(0xa0 + n, body);

function int(buf) {
  // DER integers are signed: a leading 1 bit needs a 0x00 in front.
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    let v = part >> 7;
    while (v > 0) {
      chunk.unshift(0x80 | (v & 0x7f));
      v >>= 7;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));

/** A self-signed X.509 v3 certificate for an EC key pair, as PEM. */
function selfSignedCertificate(privateKey, publicKey, commonName) {
  const now = new Date();
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))), // v3
    int(crypto.randomBytes(16)),
    ECDSA_SHA256,
    name(commonName),
    seq(time(new Date(now.getTime() - 86400_000)), time(new Date(Date.UTC(now.getUTCFullYear() + 100, 0, 1)))),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' })
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

/* -------------------------------------------------------------- identity -- */

function pinOf(publicKey) {
  return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

/** Load the identity from `dir`, creating it the first time. */
function loadIdentity(dir) {
  const file = path.join(dir, 'identity.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const privateKey = crypto.createPrivateKey(saved.key);
    const cert = new crypto.X509Certificate(saved.cert);
    if (!cert.checkPrivateKey(privateKey)) throw new Error('key and certificate do not match');
    return { key: saved.key, cert: saved.cert, pin: pinOf(cert.publicKey) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Never silently replace an identity: every client is pinned to it.
      throw new Error(`The bridge identity in ${file} is unreadable (${err.message}). Restore it from a backup, or delete it to start over (every client will need a new download).`);
    }
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const cert = selfSignedCertificate(privateKey, publicKey, 'GamePanel Bridge');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ key, cert }, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return { key, cert, pin: pinOf(publicKey) };
}

module.exports = { loadIdentity, selfSignedCertificate, pinOf };
