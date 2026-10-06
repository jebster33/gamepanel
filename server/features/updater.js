'use strict';

/**
 * In-place updates, two ways:
 *
 *   git checkout   (install.sh on Linux) `git reset --hard` to the target
 *   release        (Setup.exe / zip on Windows, or any non-git copy) download
 *                  a GitHub release and copy its files over this one
 *
 * and two channels (Settings → Panel updates):
 *
 *   stable   tagged releases only (v2.2.0, v2.3.0…)
 *   beta     pre-releases too; a git checkout follows every change on main
 *
 * A git checkout installed by install.sh has always followed main, so that
 * stays its default; a release install defaults to stable.
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

const CHANNELS = ['stable', 'beta'];

function channelOf(setting) {
  return CHANNELS.includes(setting) ? setting : isGitCheckout() ? 'beta' : 'stable';
}

/**
 * The newest panel release for a channel. Only "v1.2.3" tags count: the
 * repository also publishes other things (the bridge client) as releases.
 */
async function latestRelease(channel = 'stable') {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=40`, {
    headers: { 'User-Agent': 'GamePanel', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const releases = (await res.json()).filter((r) => !r.draft && /^v\d/.test(r.tag_name) && (channel === 'beta' || !r.prerelease));
  // Newest first; a final release beats its own pre-releases (2.3.0 over 2.3.0-beta.1).
  return releases.sort((a, b) => (newer(a.tag_name, b.tag_name) ? -1 : newer(b.tag_name, a.tag_name) ? 1 : Number(a.prerelease) - Number(b.prerelease)))[0] || null;
}

async function checkRelease(version, channel) {
  try {
    const release = await latestRelease(channel);
    if (!release) return { supported: true, mode: 'release', channel, version, updateAvailable: false, note: 'No releases have been published yet.' };
    const latest = release.tag_name.replace(/^v/, '');
    return {
      supported: true,
      mode: 'release',
      channel,
      prerelease: Boolean(release.prerelease),
      version,
      latest,
      updateAvailable: newer(latest, version),
      notes: String(release.body || '').slice(0, 4000),
      url: release.html_url,
      published: release.published_at,
    };
  } catch (err) {
    return { supported: true, mode: 'release', channel, version, error: `Could not reach GitHub: ${err.message}` };
  }
}

async function applyRelease(onLog, channel) {
  const { download, extractArchive } = require('../servers/install/native');
  const release = await latestRelease(channel);
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

/** The newest "v…" tag on the remote: what a stable git checkout follows. */
async function latestTag() {
  await git('fetch --quiet --tags --force origin');
  const tags = (await git("tag -l v* --sort=-v:refname")).split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t.trim()));
  return tags[0] || null;
}

/** A stable git checkout: how far HEAD is from the newest release tag. */
async function checkTag(version, current) {
  let tag;
  try {
    tag = await latestTag();
  } catch (err) {
    return { supported: true, mode: 'git', channel: 'stable', version, current, error: `Could not reach the update server: ${err.message}` };
  }
  if (!tag) return { supported: true, mode: 'git', channel: 'stable', version, current, updateAvailable: false, note: 'No releases have been tagged yet.' };
  const behind = Number(await git(`rev-list --count HEAD..${tag}`).catch(() => '0'));
  const ahead = Number(await git(`rev-list --count ${tag}..HEAD`).catch(() => '0'));
  return {
    supported: true,
    mode: 'git',
    channel: 'stable',
    version,
    current,
    latest: tag.replace(/^v/, ''),
    behind,
    updateAvailable: behind > 0,
    note: !behind && ahead ? `This copy is ${ahead} change${ahead === 1 ? '' : 's'} ahead of ${tag} (it followed beta); it moves to the next stable release when there is one.` : undefined,
    commits: [],
  };
}

/** Fetch from the remote and report how far behind we are. */
async function checkForUpdate({ channel: setting } = {}) {
  const version = require('../../package.json').version;
  const channel = channelOf(setting);
  if (!isGitCheckout()) return checkRelease(version, channel);

  const current = await currentRevision();
  if (channel === 'stable') return checkTag(version, current);
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
    channel,
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
async function applyUpdate({ onLog = () => {}, channel: setting } = {}) {
  const channel = channelOf(setting);
  if (!isGitCheckout()) {
    const from = require('../../package.json').version;
    const result = await applyRelease(onLog, channel);
    return { from, to: result.to, subject: `Release ${result.to}` };
  }

  const before = await currentRevision();
  onLog(`Updating from ${before?.commit || 'unknown'} …`);

  if (before?.dirty) {
    onLog('Local modifications found — stashing them before the update.');
    await git('stash push --include-untracked --message "gamepanel-auto-update"').catch(() => {});
  }

  if (channel === 'stable') {
    const tag = await latestTag();
    if (!tag) fail(400, 'No releases have been tagged yet');
    if (!Number(await git(`rev-list --count HEAD..${tag}`).catch(() => '0'))) fail(400, `Already at or past ${tag}`);
    onLog(`Moving to ${tag} (stable)`);
    await git(`reset --hard ${tag}`);
  } else {
    await git(`fetch origin ${BRANCH}`);
    await git(`reset --hard origin/${BRANCH}`);
  }

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

module.exports = { checkForUpdate, applyUpdate, scheduleRestart, currentRevision, isGitCheckout, channelOf, latestRelease, newer, CHANNELS };
