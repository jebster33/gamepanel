'use strict';

/**
 * Secrets kept in panel.json (template variables marked "secret": true, such
 * as a Steam password) are sealed with AES-256-GCM. The key is derived from
 * the panel's own secret.key, so panel.json alone does not reveal them.
 *
 *   sealed value: "enc:v1:<iv>.<tag>.<ciphertext>" (base64url)
 */

const crypto = require('crypto');
const { loadSecret } = require('./config');

const PREFIX = 'enc:v1:';
let key = null;

function keyOf() {
  if (!key) key = Buffer.from(crypto.hkdfSync('sha256', loadSecret(), Buffer.alloc(0), 'gamepanel secret variables v1', 32));
  return key;
}

const isSealed = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/** Encrypt a value. Empty values and already sealed ones are returned as they are. */
function seal(value) {
  if (value === undefined || value === null || value === '' || isSealed(value)) return value ?? '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(), iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

/** Decrypt a sealed value; plain values pass through. A value sealed by another panel opens as ''. */
function open(value) {
  if (!isSealed(value)) return value;
  try {
    const [iv, tag, data] = value.slice(PREFIX.length).split('.').map((p) => Buffer.from(p, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Names of a template's secret variables. */
function secretNames(template) {
  return new Set((template?.variables || []).filter((v) => v.secret).map((v) => v.name));
}

module.exports = { seal, open, isSealed, secretNames };
