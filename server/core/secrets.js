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

/**
 * Seal the tokens and keys the panel holds in its settings (Discord bot,
 * Cloudflare, node API keys, S3 secret, sign-in provider secrets). Safe to run
 * on every start: sealed values are left alone, so settings saved by an older
 * version are converted the first time. Returns true when something changed.
 */
function sealSettings(settings) {
  let changed = false;
  const put = (holder, field) => {
    if (holder && typeof holder[field] === 'string' && holder[field] && !isSealed(holder[field])) {
      holder[field] = seal(holder[field]);
      changed = true;
    }
  };
  put(settings.integrations?.discordBot, 'token');
  put(settings.integrations?.cloudflare, 'token');
  for (const node of settings.nodes || []) put(node, 'key');
  put(settings.cloudBackups, 'secretAccessKey');
  for (const provider of Object.values(settings.oauth || {})) if (provider && typeof provider === 'object') put(provider, 'clientSecret');
  return changed;
}

/** A copy of a settings tree with every sealed value blanked: what the settings page may be sent. */
function maskSealed(value) {
  if (Array.isArray(value)) return value.map(maskSealed);
  if (isSealed(value)) return '';
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSealed(v)]));
}

module.exports = { seal, open, isSealed, secretNames, sealSettings, maskSealed };
