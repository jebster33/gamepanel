'use strict';

/**
 * In-place updates, two ways:
 *
 *   git checkout   (install.sh on Linux) `git reset --hard origin/main`
 *   release        (Setup.exe / zip on Windows, or any non-git copy) download
 *                  the newest GitHub release and copy its files over this one
 *
 * There is no build step and no dependencies, so either way it is just new
 * files plus a restart. Containerised game servers keep running; the panel
 * re-attaches to them on the way back up.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('../core/config');
const { sh, logger, fail } = require('../core/util');

const BRANCH = process.env.GP_BRANCH || 'main';
const REPO = process.env.GP_UPDATE_REPO || 'jebster33/gamepanel';
const isWindows = process.platform === 'win32';
// What a release replaces. Everything else (data, the bundled Node runtime) stays.
const APP_PATHS = ['server', 'public', 'templates', 'windows', 'package.json', 'README.md', 'LICENSE', 'install.sh', 'update.sh', 'uninstall.sh'];

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'GamePanel', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

async function checkRelease(version) {
  try {
    const release = await latestRelease();
    if (!release) return { supported: true, mode: 'release', version, updateAvailable: false, note: 'No releases have been published yet.' };
    const latest = release.tag_name.replace(/^v/, '');
    return {
      supported: true,
      mode: 'release',
      version,
      latest,
      updateAvailable: newer(latest, version),
      notes: String(release.body || '').slice(0, 4000),
      url: release.html_url,
      published: release.published_at,
    };
  } catch (err) {
    return { supported: true, mode: 'release', version, error: `Could not reach GitHub: ${err.message}` };
  }
}

async function applyRelease(onLog) {
  const { download, extractArchive } = require('../servers/install/native');
  const release = await latestRelease();
  if (!release) fail(400, 'No releases have been published yet');
  const tag = release.tag_name;
  const work = path.join(config.cacheDir, `update-${tag.replace(/[^\w.-]/g, '')}`);
  fs.rmSync(work, { recursive: true, force: true });
  const archive = path.join(config.cacheDir, `gamepanel-${tag}.zip`);
  const log = (line) => onLog(line);
  await download(release.zipball_url, archive, log);
  await extractArchive(archive, work, log, { strip: 1 });
  if (!fs.existsSync(path.join(work, 'server', 'index.js'))) fail(500, 'The downloaded release does not look like GamePanel');

  for (const rel of APP_PATHS) {
    const from = path.join(work, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(config.rootDir, rel);
    fs.rmSync(`${to}.old`, { recursive: true, force: true });
    if (fs.existsSync(to)) fs.renameSync(to, `${to}.old`);
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(`${to}.old`, { recursive: true, force: true });
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  const version = JSON.parse(fs.readFileSync(path.join(config.rootDir, 'package.json'), 'utf8')).version;
  onLog(`Installed GamePanel ${version}`);
  return { to: version };
}

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
  if (!isGitCheckout()) return checkRelease(version);

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
    mode: 'git',
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
  if (!isGitCheckout()) {
    const from = require('../../package.json').version;
    const result = await applyRelease(onLog);
    return { from, to: result.to, subject: `Release ${result.to}` };
  }

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
    // The Windows service wrapper restarts the panel when it exits with an error code.
    if (isWindows) process.exit(process.env.GP_SERVICE ? 1 : 0);
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
