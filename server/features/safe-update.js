'use strict';

/**
 * Safe updates: take a backup first, then update. Nothing is ever rolled back
 * on its own; if the update turns out badly, "Roll back" puts the server back
 * exactly as it was at the snapshot (files added since are removed too).
 * The snapshot is an ordinary backup named ...-pre-update-..., remembered in
 * `server.safeUpdate` and kept out of backup pruning.
 */

const { fail, HttpError } = require('../core/util');
const backups = require('./backups');
const restorePreview = require('./restore-preview');
const { updateSteps } = require('../servers/install');

const busy = (manager, server) => {
  if (manager.rt(server.id).task) fail(409, 'Another job is running on this server');
};

/** The snapshot to show: null when there is none or its backup was deleted. */
function view(server) {
  const snap = server.safeUpdate;
  if (!snap) return null;
  const made = backups.list(server.id).find((b) => b.name === snap.backup);
  return { ...snap, exists: Boolean(made), size: made?.total || made?.size || 0 };
}

/** Back the server up and remember it as the safe-update snapshot. */
async function snapshot(manager, server, kind, actor) {
  busy(manager, server);
  manager.checkDiskRoom('make a backup');
  manager.setTask(server, 'Backing up');
  manager.pushConsole(server, 'Safe update: backing up first…', 'system');
  try {
    const made = await backups.create(server, 'pre-update');
    server.safeUpdate = { backup: made.name, at: Date.now(), by: actor, kind };
    manager.store.save();
    manager.store.addEvent('backup.created', `Backup ${made.name} of ${server.name} made before an update`, { serverId: server.id, backup: made.name });
    manager.pushConsole(server, `Safe update: snapshot saved (${made.name}).`, 'system');
    return made;
  } catch (err) {
    manager.pushConsole(server, `Safe update: the backup failed, so nothing was changed (${err.message}).`, 'system');
    throw err;
  } finally {
    manager.setTask(server, null);
  }
}

/** Snapshot, then update the game files. The server must be stopped. */
async function updateGame(manager, server, actor) {
  const template = manager.template(server);
  if (!template || !updateSteps(template).length) fail(400, 'This game is updated by reinstalling it');
  if (manager.isActive(server.id)) fail(409, 'Stop the server before updating it');
  await snapshot(manager, server, 'game', actor);
  manager.store.addEvent('server.safe_update', `${actor} started a safe update of ${server.name}`, { serverId: server.id });
  return manager.updateGame(server.id);
}

/** Put the server back as it was at the snapshot. */
async function rollback(manager, server, actor) {
  const snap = view(server);
  if (!snap) fail(404, 'There is no snapshot to roll back to');
  if (!snap.exists) fail(410, 'The snapshot backup has been deleted');
  if (manager.isActive(server.id)) fail(409, 'Stop the server before rolling back');
  busy(manager, server);
  manager.setTask(server, 'Rolling back');
  manager.pushConsole(server, `Rolling back to ${snap.backup}…`, 'system');
  try {
    let result;
    try {
      result = await restorePreview.restore(manager, server, snap.backup, { exact: true });
    } catch (err) {
      // Too large to list for "exactly like the backup": restore over the top instead.
      if (!(err instanceof HttpError) || err.code !== 400) throw err;
      result = await restorePreview.restore(manager, server, snap.backup, { exact: false });
    }
    server.lastRollback = { at: Date.now(), by: actor, backup: snap.backup };
    server.safeUpdate = null;
    manager.rt(server.id).autoUpdate = null; // the next check looks at the restored files
    manager.store.save();
    manager.pushConsole(server, `Rolled back to ${snap.backup}${result.removed ? ` (${result.removed} newer files removed)` : ''}.`, 'system');
    manager.store.addEvent('server.rolled_back', `${actor} rolled ${server.name} back to ${snap.backup}`, { serverId: server.id, backup: snap.backup });
    return { ok: true, removed: result.removed };
  } finally {
    manager.setTask(server, null);
  }
}

module.exports = { view, snapshot, updateGame, rollback };
