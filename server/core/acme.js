'use strict';

/**
 * A small ACME client (RFC 8555), enough for Let's Encrypt: an account,
 * orders, http-01 and dns-01 challenges, a CSR, and the certificate chain.
 * No library: requests are signed (ES256, JWS) with Node's crypto, and the
 * certificate request is written in DER by hand below.
 */

const crypto = require('crypto');

const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';
const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

const b64u = (data) => Buffer.from(data).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ DER -- */

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A PKCS#10 certificate request for `domains`, signed with an EC P-256 `key`. */
function csr(domains, key) {
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const subject = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(domains[0])))));
  const san = seq(...domains.map((d) => tlv(0x82, Buffer.from(d)))); // [2] dNSName
  const extensions = seq(seq(oid('2.5.29.17'), tlv(0x04, san)));
  const attributes = tlv(0xa0, seq(oid('1.2.840.113549.1.9.14'), set(extensions)));
  const info = seq(tlv(0x02, Buffer.from([0])), subject, spki, attributes);
  const signature = crypto.sign('sha256', info, key);
  return seq(info, seq(oid('1.2.840.10045.4.3.2')), tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

/* ----------------------------------------------------------------- keys -- */

const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

function jwkOf(key) {
  const { crv, kty, x, y } = crypto.createPublicKey(key).export({ format: 'jwk' });
  return { crv, kty, x, y };
}

/** RFC 7638 thumbprint: the members in order, no spaces. */
function thumbprint(key) {
  const { crv, kty, x, y } = jwkOf(key);
  return b64u(crypto.createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest());
}

/* --------------------------------------------------------------- client -- */

class AcmeClient {
  /**
   * @param {{ directoryUrl: string, accountKey: string (PEM), kid?: string, log?: (line) => void }} opts
   */
  constructor({ directoryUrl = LETS_ENCRYPT, accountKey, kid = null, log = () => {} }) {
    this.directoryUrl = directoryUrl;
    this.key = crypto.createPrivateKey(accountKey);
    this.kid = kid;
    this.log = log;
    this.nonces = [];
    this.dir = null;
  }

  async directory() {
    if (!this.dir) {
      const res = await fetch(this.directoryUrl, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`The certificate authority answered ${res.status}`);
      this.dir = await res.json();
    }
    return this.dir;
  }

  async nonce() {
    if (this.nonces.length) return this.nonces.pop();
    const res = await fetch((await this.directory()).newNonce, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
    const n = res.headers.get('replay-nonce');
    if (!n) throw new Error('The certificate authority sent no nonce');
    return n;
  }

  sign(url, payload, nonce, { jwk = false } = {}) {
    const header = { alg: 'ES256', nonce, url, ...(jwk || !this.kid ? { jwk: jwkOf(this.key) } : { kid: this.kid }) };
    const protectedB64 = b64u(JSON.stringify(header));
    const payloadB64 = payload === null ? '' : b64u(JSON.stringify(payload));
    const signature = crypto.sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
    return JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64u(signature) });
  }

  /** A signed POST (payload null = POST-as-GET). Retries once on a stale nonce. */
  async post(url, payload, { jwk = false, accept = 'application/json', retry = true } = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json', Accept: accept },
      body: this.sign(url, payload, await this.nonce(), { jwk }),
      signal: AbortSignal.timeout(30_000),
    });
    const fresh = res.headers.get('replay-nonce');
    if (fresh) this.nonces.push(fresh);
    const text = await res.text();
    let body = text;
    if ((res.headers.get('content-type') || '').includes('json')) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.status >= 400) {
      if (retry && body?.type === 'urn:ietf:params:acme:error:badNonce') return this.post(url, payload, { jwk, accept, retry: false });
      const err = new Error(body?.detail || `The certificate authority answered ${res.status}`);
      err.acme = body?.type;
      throw err;
    }
    return { status: res.status, location: res.headers.get('location'), body };
  }

  /** Find or create the account for this key. */
  async account(email) {
    const dir = await this.directory();
    const res = await this.post(dir.newAccount, { termsOfServiceAgreed: true, ...(email ? { contact: [`mailto:${email}`] } : {}) }, { jwk: true });
    this.kid = res.location;
    return this.kid;
  }

  async newOrder(domains) {
    const dir = await this.directory();
    const res = await this.post(dir.newOrder, { identifiers: domains.map((value) => ({ type: 'dns', value })) });
    return { ...res.body, url: res.location };
  }

  async get(url) {
    return (await this.post(url, null)).body;
  }

  keyAuthorization(token) {
    return `${token}.${thumbprint(this.key)}`;
  }

  /** The TXT value for a dns-01 challenge. */
  dnsValue(token) {
    return b64u(crypto.createHash('sha256').update(this.keyAuthorization(token)).digest());
  }

  /** Ask until `url` is no longer pending/processing. */
  async poll(url, { timeoutMs = 120_000 } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const body = await this.get(url);
      if (!['pending', 'processing'].includes(body.status)) return body;
      if (Date.now() > until) throw new Error('The certificate authority took too long');
      await sleep(2000);
    }
  }

  /**
   * The whole order. `solve(challenge, authz)` prepares one challenge and
   * returns a cleanup function; `kinds` lists the challenge types to use.
   */
  async certificate(domains, { kinds, solve, domainKey }) {
    const order = await this.newOrder(domains);
    const cleanups = [];
    try {
      for (const authzUrl of order.authorizations) {
        const authz = await this.get(authzUrl);
        if (authz.status === 'valid') continue;
        const challenge = authz.challenges.find((c) => kinds.includes(c.type));
        if (!challenge) throw new Error(`The certificate authority offered no ${kinds.join(' or ')} challenge for ${authz.identifier.value}`);
        this.log(`Proving control of ${authz.identifier.value} (${challenge.type})`);
        cleanups.push(await solve(challenge, authz));
        await this.post(challenge.url, {});
        const done = await this.poll(authzUrl);
        if (done.status !== 'valid') {
          const why = done.challenges?.find((c) => c.error)?.error?.detail || done.status;
          throw new Error(`${authz.identifier.value} could not be verified: ${why}`);
        }
      }
    } finally {
      for (const clean of cleanups) await Promise.resolve(clean?.()).catch(() => {});
    }
    this.log('Requesting the certificate');
    await this.post(order.finalize, { csr: b64u(csr(domains, crypto.createPrivateKey(domainKey))) });
    const finished = await this.poll(order.url);
    if (finished.status !== 'valid' || !finished.certificate) throw new Error(`The order ended as ${finished.status}`);
    const chain = await this.post(finished.certificate, null, { accept: 'application/pem-certificate-chain' });
    return String(chain.body);
  }
}

module.exports = { AcmeClient, csr, newKey, thumbprint, jwkOf, LETS_ENCRYPT, LETS_ENCRYPT_STAGING };
