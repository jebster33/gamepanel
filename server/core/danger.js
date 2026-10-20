'use strict';

/**
 * Destructive actions: ones that delete a server, its saves or its backups, or
 * put old data over the current one. An account with two-factor sign-in on
 * must give a fresh authenticator code for each (see Auth.requireDanger).
 * API keys are exempt: a key is a credential a person made on purpose, and a
 * script cannot type a code.
 */

const ID = '[^/]+';
const DANGEROUS = [
  ['DELETE', new RegExp(`^/api/servers/${ID}$`)],
  ['POST', new RegExp(`^/api/servers/${ID}/(wipe|dino-wipe|trim|worlds/reset|worlds/delete|safe-update/rollback)$`)],
  ['POST', new RegExp(`^/api/servers/${ID}/backups/${ID}/(restore|restore-files)$`)],
  ['DELETE', new RegExp(`^/api/servers/${ID}/backups/${ID}$`)],
  ['DELETE', new RegExp(`^/api/servers/${ID}/backups/(node|cloud)/${ID}$`)],
  ['DELETE', /^\/api\/backup-store\/[^/]+\/[^/]+\/[^/]+$/],
  ['DELETE', new RegExp(`^/api/servers/${ID}/files$`)],
  ['DELETE', new RegExp(`^/api/clusters/${ID}$`)],
];

/** @param {string} method @param {string} pathname @param {object} [body] parsed JSON body when known */
function isDangerous(method, pathname, body) {
  const clean = `/${String(pathname).split('/').filter(Boolean).join('/')}`;
  if (!DANGEROUS.some(([m, re]) => m === method && re.test(clean))) {
    // A reinstall overwrites game files.
    return method === 'POST' && new RegExp(`^/api/servers/${ID}/install$`).test(clean) && body?.reinstall === true;
  }
  // A trim preview changes nothing.
  if (body?.dryRun === true && /\/trim$/.test(clean)) return false;
  return true;
}

module.exports = { isDangerous };
