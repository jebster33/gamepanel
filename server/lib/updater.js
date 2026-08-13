'use strict';

/**
 * In-place updates.
 *
 * The panel is a git checkout with no build step and no dependencies, so
 * updating is `git reset --hard origin/main` followed by a restart. With the
 * container runtime the running game servers are untouched — the panel
 * re-attaches to them on the way back up.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('./config');
const { sh, logger, fail } = require('./util');

const BRANCH = process.env.GP_BRANCH || 'main';

function isGitCheckout() {
  return fs.existsSync(path.join(config.rootDir, '.git'));
}

async function git(args) {
  const { stdout } = await sh(`git -C ${JSON.stringify(config.rootDir)} ${args}`, { timeout: 60000 });
  return stdout.trim();
}

async function currentRevision() {
  if (!isGitCheckout()) return null;
  try {
    return {
      commit: await git('rev-parse --short HEAD'),
      date: await git('log -1 --format=%cI'),
      subject: await git('log -1 --format=%s'),
      branch: await git('rev-parse --abbrev-ref HEAD'),
      dirty: Boolean(await git('status --porcelain')),
    };
  } catch (err) {
    logger.debug('git revision lookup failed:', err.message);
    return null;
  }
}

/** Fetch from the remote and report how far behind we are. */
async function checkForUpdate() {
  const version = require('../../package.json').version;
  if (!isGitCheckout()) {
    return {
      supported: false,
      version,
      reason: 'This installation is not a git checkout, so it cannot update itself. Re-run install.sh to update.',
    };
  }

  const current = await currentRevision();
  try {
    await git(`fetch --quiet origin ${BRANCH}`);
  } catch (err) {
    return { supported: true, version, current, error: `Could not reach the update server: ${err.message}` };
  }

  const behind = Number(await git(`rev-list --count HEAD..origin/${BRANCH}`).catch(() => '0'));

  // %x09 is a literal tab: it keeps the format free of shell metacharacters
  // (a "|" separator would be parsed as a pipe by the shell running git) and
  // cannot appear inside a commit subject.
  const commits = behind
    ? await git(`log --format=%h%x09%cI%x09%s HEAD..origin/${BRANCH} --max-count=20`)
        .then((out) =>
          out
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [commit, date, ...rest] = line.split('\t');
              return { commit, date, subject: rest.join('\t') };
            })
        )
        .catch(() => [])
    : [];

  return {
    supported: true,
    version,
    current,
    behind,
    updateAvailable: behind > 0,
    commits,
    latest: behind ? await git(`rev-parse --short origin/${BRANCH}`) : current?.commit,
  };
}

/**
 * Pull the new code, then hand over to systemd (or simply exit — the unit has
 * Restart=always, so the supervisor brings the panel back on the new code).
 */
async function applyUpdate({ onLog = () => {} } = {}) {
  if (!isGitCheckout()) fail(400, 'This installation cannot update itself — re-run install.sh');

  const before = await currentRevision();
  onLog(`Updating from ${before?.commit || 'unknown'} …`);

  if (before?.dirty) {
    onLog('Local modifications found — stashing them before the update.');
    await git('stash push --include-untracked --message "gamepanel-auto-update"').catch(() => {});
  }

  await git(`fetch origin ${BRANCH}`);
  await git(`reset --hard origin/${BRANCH}`);

  // Keep the helper scripts runnable even if a checkout landed without modes.
  await sh(`chmod +x ${JSON.stringify(config.rootDir)}/*.sh`).catch(() => {});

  const after = await currentRevision();
  onLog(`Now at ${after?.commit} — ${after?.subject}`);

  return { from: before?.commit, to: after?.commit, subject: after?.subject };
}

/** Restart the panel process itself, a moment after the HTTP reply is sent. */
function scheduleRestart(delayMs = 1200) {
  setTimeout(() => {
    logger.info('Restarting to load the update…');
    try {
      // Ask systemd first: the job is queued with the manager, so it completes
      // even though this process is killed part-way through.
      const proc = spawn('sudo', ['-n', 'systemctl', 'restart', 'gamepanel'], {
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();
      proc.on('error', () => process.exit(0));
    } catch {
      /* fall through */
    }
    // Whatever happens, exit: any supervisor restarts us on the new code.
    setTimeout(() => process.exit(0), 4000).unref?.();
  }, delayMs).unref?.();
}

module.exports = { checkForUpdate, applyUpdate, scheduleRestart, currentRevision, isGitCheckout };
