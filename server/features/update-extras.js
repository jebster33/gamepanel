'use strict';

/**
 * Around the panel updater (server/features/updater.js, which already has the stable and beta
 * channels and shows release notes or the commit list):
 *
 *   history      every update the panel applied: what it came from, what it went to
 *   rollback     go back to the version before the last update (git checkout: that commit;
 *                release install: that release's files), then restart
 *   scheduled    check for updates every six hours and raise `panel.update_available` once per
 *                new version (it only tells you; installing stays a click)
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { run } = require('../core/platform');
const { fail, logger } = require('../core/util');
const updater = require('./updater');

const FILE = path.join(config.dataDir, 'update-history.json');
const KEEP = 10;

function history() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function record(entry) {
  const list = [{ at: Date.now(), ...entry }, ...history()].slice(0, KEEP);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list));
  } catch (err) {
    logger.warn(`Could not save the update history: ${err.message}`);
  }
  return list;
}

/** The newest update that can be undone (not one that was itself a rollback). */
function rollbackTarget(list = history()) {
  const last = list.find((e) => !e.rollback && e.from && e.to && e.from !== e.to);
  if (!last) return null;
  const git = updater.isGitCheckout();
  if (git && !/^[0-9a-f]{7,40}$/.test(String(last.from))) return null;
  if (!git && !/^\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$/.test(String(last.from))) return null;
  return { from: last.from, to: last.to, at: last.at, mode: git ? 'git' : 'release' };
}

async function rollback({ onLog = () => {}, user = 'admin' } = {}) {
  const target = rollbackTarget();
  if (!target) fail(400, 'There is no earlier version recorded to go back to');
  if (target.mode === 'git') {
    const check = await run('git', ['-C', config.rootDir, 'cat-file', '-e', `${target.from}^{commit}`], { timeout: 15_000 });
    if (check.code !== 0) fail(400, `Commit ${target.from} is no longer in this checkout`);
    onLog(`Going back to ${target.from}`);
    const r = await run('git', ['-C', config.rootDir, 'reset', '--hard', target.from], { timeout: 60_000 });
    if (r.code !== 0) fail(500, `git could not go back: ${r.stderr.trim().slice(0, 200)}`);
    record({ from: target.to, to: target.from, mode: 'git', rollback: true, user });
    return { from: target.to, to: target.from };
  }
  const result = await updater.applyUpdate({ onLog, tag: `v${target.from}` });
  record({ from: target.to, to: result.to, mode: 'release', rollback: true, user });
  return { from: target.to, to: result.to };
}

let timer = null;
/** Every six hours: look for an update and say so once per version. */
function startChecks({ store }) {
  const tick = async () => {
    const s = store.state.settings;
    if (s.updateAutoCheck === false) return;
    try {
      const r = await updater.checkForUpdate({ channel: s.updateChannel });
      s.updateLastCheck = Date.now();
      const id = r.latest || r.current?.commit || null;
      if (r.updateAvailable && id && s.updateNotified !== id) {
        s.updateNotified = id;
        store.addEvent('panel.update_available', `A panel update is available (${r.mode === 'git' && r.channel === 'beta' ? `${r.behind} new change${r.behind === 1 ? '' : 's'}` : `version ${r.latest}`}). Settings, Panel updates.`);
      }
      store.save();
    } catch (err) {
      logger.warn(`Scheduled update check failed: ${err.message}`);
    }
  };
  timer = setInterval(tick, 6 * 3600_000);
  timer.unref?.();
  setTimeout(tick, 10 * 60_000).unref?.();
  return timer;
}

module.exports = { history, record, rollbackTarget, rollback, startChecks, FILE };
