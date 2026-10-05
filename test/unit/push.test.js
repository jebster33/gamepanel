'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

process.env.GP_DATA_DIR = path.join(os.tmpdir(), `gp-push-${process.pid}`);
const { encrypt } = require('../../server/features/push');

// Decrypt the way a browser does (RFC 8291), to prove the panel's encryption is right.
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  assert.strictEqual(plain[plain.length - 1], 2); // last-record delimiter
  return plain.subarray(0, -1).toString();
}

test('push payloads decrypt on the receiving side', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const body = encrypt(sub, JSON.stringify({ title: 'Survival SMP', body: 'crashed' }));
  assert.deepStrictEqual(JSON.parse(decrypt(body, ua, auth)), { title: 'Survival SMP', body: 'crashed' });
});
