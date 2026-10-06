'use strict';

/**
 * Windows only. C:\ProgramData lets every local account read the folders
 * below it, and create files in them. For GamePanel that would mean:
 *
 *   - anyone who can sign in to the machine reads secret.key and can forge an
 *     administrator session, or reads panel.json (password hashes, API keys,
 *     node keys, cloud backup credentials);
 *   - anyone can drop a template or a java.exe where the service, running as
 *     SYSTEM, will pick it up.
 *
 * So at start-up the service locks those down to SYSTEM and Administrators.
 * Server and backup folders keep the default, because Docker Desktop has to
 * reach them for Linux games.
 */

const fs = require('fs');
const path = require('path');

const SYSTEM = '*S-1-5-18';
const ADMINS = '*S-1-5-32-544';
const USERS = '*S-1-5-32-545';

/** What gets locked down, relative to the data folder. */
const TARGETS = [
  { rel: 'secret.key', kind: 'file' },
  { rel: 'panel.json', kind: 'file' },
  { rel: 'push-keys.json', kind: 'file' },
  { rel: 'push.json', kind: 'file' },
  // Private folders: run holds panel.json's temporary copy, so the renamed file keeps this ACL.
  { rel: 'run', kind: 'private' },
  { rel: 'bridge', kind: 'private' },
  // Code the service runs: readable, not writable, by everyone else.
  { rel: 'templates', kind: 'code' },
  { rel: 'tools', kind: 'code' },
  { rel: 'steamcmd', kind: 'code' },
];

/** The icacls argument lists for one data folder (exported for tests). */
function icaclsCommands(dataDir) {
  const out = [];
  for (const { rel, kind } of TARGETS) {
    const target = path.join(dataDir, rel);
    const inherit = kind === 'file' ? '' : '(OI)(CI)';
    const grants = [`${SYSTEM}:${inherit}F`, `${ADMINS}:${inherit}F`];
    if (kind === 'code') grants.push(`${USERS}:${inherit}RX`);
    out.push({ target, kind, args: [target, '/inheritance:r', '/grant:r', ...grants, '/C', '/Q'] });
    out.push({ target, kind, args: [target, '/setowner', ADMINS, '/C', '/Q'] });
  }
  return out;
}

const ACL_VERSION = 1;

/**
 * Best effort: a failure is logged, never fatal. Files are done on every
 * start (push.json appears later); folders once, since what is created in
 * them afterwards inherits their ACL and redoing Java's thousands of files
 * on every start would be slow.
 */
async function hardenWindowsData(dataDir, { run, logger, store }) {
  const foldersDone = store.state.settings.windowsAcl === ACL_VERSION;
  for (const { rel, kind } of TARGETS) {
    // Create the folders now, so nobody else can create them first.
    if (kind !== 'file') fs.mkdirSync(path.join(dataDir, rel), { recursive: true });
  }
  let ok = true;
  for (const { target, kind, args } of icaclsCommands(dataDir)) {
    if (!fs.existsSync(target) || (foldersDone && kind !== 'file')) continue;
    const result = await run('icacls', args, { timeout: 300_000 });
    if (result.code !== 0) {
      ok = false;
      logger.warn(`Could not restrict access to ${target}: ${(result.stdout + result.stderr).trim().split('\n')[0] || result.error}`);
    }
  }
  if (ok && !foldersDone) {
    store.state.settings.windowsAcl = ACL_VERSION;
    store.save();
  }
}

module.exports = { hardenWindowsData, icaclsCommands, TARGETS };
