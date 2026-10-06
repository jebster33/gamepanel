'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const acme = require('../../server/core/acme');

test('the certificate request carries the names and a valid signature', () => {
  const key = crypto.createPrivateKey(acme.newKey());
  const der = acme.csr(['panel.example.com', 'www.example.com'], key);
  assert.strictEqual(der[0], 0x30);
  const text = der.toString('latin1');
  assert.ok(text.includes('panel.example.com') && text.includes('www.example.com'));
  // Unwrap SEQUENCE { info, algorithm, BIT STRING signature } and check the signature over info.
  const readTlv = (buf, pos) => {
    let len = buf[pos + 1];
    let head = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | buf[pos + 2 + i];
      head = 2 + n;
    }
    return { start: pos, head, len, end: pos + head + len };
  };
  const outer = readTlv(der, 0);
  const info = readTlv(der, outer.head);
  const alg = readTlv(der, info.end);
  const sig = readTlv(der, alg.end);
  const signature = der.subarray(sig.start + sig.head + 1, sig.end);
  assert.ok(crypto.verify('sha256', der.subarray(info.start, info.end), crypto.createPublicKey(key), signature));
});

test('requests are signed ES256 the way ACME servers check them', () => {
  const pem = acme.newKey();
  const client = new acme.AcmeClient({ directoryUrl: 'https://example.invalid/dir', accountKey: pem });
  const body = JSON.parse(client.sign('https://example.invalid/new-acct', { termsOfServiceAgreed: true }, 'nonce123'));
  const header = JSON.parse(Buffer.from(body.protected, 'base64url'));
  assert.deepStrictEqual([header.alg, header.nonce, header.url, header.jwk.crv], ['ES256', 'nonce123', 'https://example.invalid/new-acct', 'P-256']);
  const ok = crypto.verify('sha256', Buffer.from(`${body.protected}.${body.payload}`), { key: crypto.createPublicKey(pem), dsaEncoding: 'ieee-p1363' }, Buffer.from(body.signature, 'base64url'));
  assert.ok(ok);
  // Once registered, the account URL replaces the key; POST-as-GET has an empty payload.
  client.kid = 'https://example.invalid/acct/1';
  const get = JSON.parse(client.sign('https://example.invalid/order/1', null, 'n2'));
  assert.strictEqual(JSON.parse(Buffer.from(get.protected, 'base64url')).kid, 'https://example.invalid/acct/1');
  assert.strictEqual(get.payload, '');
  // Key authorizations use the RFC 7638 thumbprint.
  assert.match(client.keyAuthorization('tok'), /^tok\.[A-Za-z0-9_-]{43}$/);
  assert.match(client.dnsValue('tok'), /^[A-Za-z0-9_-]{43}$/);
});
