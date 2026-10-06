'use strict';

/**
 * Runs a template's install steps directly from Node.
 *
 * This is the installer on Windows, where there is no bash and no container:
 * every step type is implemented here with plain Node plus the tools Windows
 * ships with (tar.exe, PowerShell). Output streams to the server console just
 * like the Linux installer's does.
 *
 * Step types: steamcmd, download, fetchList, extract, copy, remove, run,
 * writeFile, mkdir, java, vcredist, directx, powershell, workshop.
 * (chmod and apt are accepted and skipped.)
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { config } = require('../../core/config');
const { interpolate, safeJoin } = require('../../core/util');
const { isWindows, run, powershell, spawnShell } = require('../../core/platform');
const { parseList } = require('./bash');

const UA = 'GamePanel/2 (+https://github.com/jebster33/gamepanel)';

class StepError extends Error {}

/** Raised by a step that should fail the whole install with a readable reason. */
const die = (message) => {
  throw new StepError(message);
};

/* --------------------------------------------------------------- helpers -- */

async function download(url, dest, log, { userAgent = UA } = {}) {
  log(`Downloading ${url}`);
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': userAgent }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
      return dest;
    } catch (err) {
      lastError = err;
      log(`Download attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return die(`Download failed: ${url} (${lastError?.message})`);
}

/** Stream a child process into the console, splitting on \r as well as \n. */
function streamProcess(file, args, { cwd, env, log, track }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    track?.(child);
    const forward = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n|\r/)) if (line.trim()) log(line, 'stdout');
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => {
      log(`Could not run ${path.basename(file)}: ${err.message}`);
      resolve(-1);
    });
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

/** bsdtar ships with Windows 10+ and unpacks zip, tar.gz and tar.xz alike. */
async function extractArchive(file, dest, log, { strip = 0 } = {}) {
  await fsp.mkdir(dest, { recursive: true });
  log(`Extracting ${path.basename(file)}`);
  const args = ['-xf', file, '-C', dest];
  if (strip) args.push(`--strip-components=${strip}`);
  const result = await run(isWindows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', args, {
    timeout: 60 * 60_000,
  });
  if (result.code !== 0) {
    // Some Windows builds of tar.exe cannot read .7z (FiveM ships its Windows
    // server as one), so fall back to the standalone 7-Zip console tool.
    if (/\.7z$/i.test(file) && !strip) {
      const sevenZip = path.join(config.toolsDir, '7zr.exe');
      if (!fs.existsSync(sevenZip)) await download('https://www.7-zip.org/a/7zr.exe', sevenZip, log);
      const seven = await run(sevenZip, ['x', file, `-o${dest}`, '-y'], { timeout: 60 * 60_000 });
      if (seven.code === 0) return;
    }
    // PowerShell's own unzipper as a fallback for odd zip variants.
    if (isWindows && /\.zip$/i.test(file) && !strip) {
      const ps = await powershell(`Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`, {
        timeout: 60 * 60_000,
      });
      if (ps.code === 0) return;
    }
    die(`Could not extract ${path.basename(file)}: ${(result.stderr || result.error || '').trim()}`);
  }
}

/* ------------------------------------------------------------- SteamCMD -- */

async function ensureSteamcmd(log) {
  const dir = path.join(config.toolsDir, 'steamcmd');
  const binary = path.join(dir, isWindows ? 'steamcmd.exe' : 'steamcmd.sh');
  if (fs.existsSync(binary)) return binary;
  log('Setting up SteamCMD (once for all servers)');
  const archive = path.join(config.cacheDir, isWindows ? 'steamcmd.zip' : 'steamcmd_linux.tar.gz');
  await download(
    isWindows
      ? 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
      : 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
    archive,
    log
  );
  await extractArchive(archive, dir, log);
  await fsp.rm(archive, { force: true });
  if (!fs.existsSync(binary)) die('SteamCMD did not unpack correctly');
  return binary;
}

/**
 * Install or update a Steam app. SteamCMD updates itself on first run and
 * sometimes exits early while doing so, so failures are retried.
 */
async function steamApp({ appid, login = 'anonymous', branch = '', dir, log, track, extraArgs = [] }) {
  const binary = await ensureSteamcmd(log);
  const args = [
    '+@ShutdownOnFailedCommand',
    '1',
    '+@NoPromptForPassword',
    '1',
    '+force_install_dir',
    dir,
    '+login',
    ...String(login || 'anonymous').split(/\s+/),
    '+app_update',
    String(appid),
    ...(branch ? ['-beta', branch] : []),
    ...extraArgs,
    'validate',
    '+quit',
  ];
  for (let attempt = 1; attempt <= 4; attempt++) {
    log(`SteamCMD: installing app ${appid}${branch ? ` (branch ${branch})` : ''}${attempt > 1 ? ` — attempt ${attempt}` : ''}`);
    const code = await streamProcess(binary, args, { cwd: path.dirname(binary), log, track });
    // 0 = done. 7 is "restart after self-update"; anything else is worth one more go.
    if (code === 0) return copySteamClient(path.dirname(binary), dir);
    log(`SteamCMD exited with code ${code}`);
  }
  die(`SteamCMD could not install app ${appid}. Check the disk space and that the app can be downloaded anonymously.`);
}

/**
 * Older Source servers on Windows (Left 4 Dead 2) only look for the Steam
 * client next to their own executable and drop to LAN-only mode without it.
 * SteamCMD ships those DLLs; put copies beside the game where none exist.
 */
async function copySteamClient(steamcmdDir, dir) {
  if (!isWindows) return;
  for (const name of ['steamclient.dll', 'steamclient64.dll', 'tier0_s.dll', 'tier0_s64.dll', 'vstdlib_s.dll', 'vstdlib_s64.dll']) {
    const from = path.join(steamcmdDir, name);
    const to = path.join(dir, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) await fsp.copyFile(from, to).catch(() => {});
  }
}

/** Download one Workshop item into `dest` (replacing what was there). */
async function workshopItem({ appid, item, dest, login = 'anonymous', dir, log, track }) {
  const binary = await ensureSteamcmd(log);
  const stage = path.join(dir, '.gamepanel', 'steam-workshop');
  const src = path.join(stage, 'steamapps', 'workshop', 'content', String(appid), String(item));
  await fsp.mkdir(stage, { recursive: true });
  for (let attempt = 1; attempt <= 3 && !fs.existsSync(src); attempt++) {
    log(`SteamCMD: downloading Workshop item ${item} (attempt ${attempt})`);
    await streamProcess(
      binary,
      ['+@NoPromptForPassword', '1', '+force_install_dir', stage, '+login', ...String(login || 'anonymous').split(/\s+/), '+workshop_download_item', String(appid), String(item), 'validate', '+quit'],
      { cwd: path.dirname(binary), log, track }
    );
  }
  if (!fs.existsSync(src)) die(`SteamCMD could not download Workshop item ${item}. Check that it exists, is public, and belongs to app ${appid}.`);
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(src, dest, { recursive: true });
  await fsp.rm(src, { recursive: true, force: true });
}

/* ----------------------------------------------------------------- Java -- */

/** A shared Temurin JRE per major version, downloaded on first use. */
async function ensureJava(version, log) {
  const want = String(version || '21');
  if (!/^\d{1,3}$/.test(want)) throw new Error(`"${want}" is not a Java version`);
  const home = path.join(config.toolsDir, `java-${want}`);
  const binary = path.join(home, 'bin', isWindows ? 'java.exe' : 'java');
  if (fs.existsSync(binary)) {
    log(`Java ${want} already installed`);
    return home;
  }
  const os = isWindows ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const archive = path.join(config.cacheDir, `java-${want}.${isWindows ? 'zip' : 'tar.gz'}`);
  log(`Installing Java ${want} (Eclipse Temurin)`);
  await download(`https://api.adoptium.net/v3/binary/latest/${want}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`, archive, log);
  await fsp.rm(home, { recursive: true, force: true });
  await extractArchive(archive, home, log, { strip: 1 });
  await fsp.rm(archive, { force: true });
  if (!fs.existsSync(binary)) die('The Java download looks incomplete');
  log(`Java ${want} ready`);
  return home;
}

/* -------------------------------------------------- Windows prerequisites -- */

async function ensureVcRedist(log) {
  if (!isWindows) return;
  const check = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', '/v', 'Installed']);
  if (check.code === 0 && /0x1/.test(check.stdout)) {
    log('Visual C++ runtime already installed');
    return;
  }
  const installer = path.join(config.cacheDir, 'vc_redist.x64.exe');
  await download('https://aka.ms/vs/17/release/vc_redist.x64.exe', installer, log);
  log('Installing the Visual C++ runtime');
  const result = await run(installer, ['/install', '/quiet', '/norestart'], { timeout: 15 * 60_000 });
  // 3010 = installed, reboot recommended; 1638 = a newer version is present.
  if (![0, 3010, 1638].includes(result.code)) die(`The Visual C++ runtime failed to install (code ${result.code})`);
}

async function ensureDirectX(log) {
  if (!isWindows) return;
  const marker = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'xinput1_3.dll');
  if (fs.existsSync(marker)) {
    log('DirectX runtime already installed');
    return;
  }
  const exe = path.join(config.cacheDir, 'directx_Jun2010_redist.exe');
  const unpack = path.join(config.cacheDir, 'directx');
  await download(
    'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe',
    exe,
    log
  );
  log('Installing the DirectX runtime');
  await run(exe, ['/Q', `/T:${unpack}`], { timeout: 10 * 60_000 });
  const result = await run(path.join(unpack, 'DXSETUP.exe'), ['/silent'], { timeout: 15 * 60_000 });
  if (result.code !== 0) die(`The DirectX runtime failed to install (code ${result.code})`);
}

/* ---------------------------------------------------------------- steps -- */

/** PowerShell helpers available inside "powershell" steps. */
const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function GP-Log([string]$m) { Write-Output "[gamepanel] $m" }
function GP-Fetch([string]$url, [string]$dest) { GP-Log "Downloading $url"; Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $dest -UserAgent 'GamePanel/2' }
function GP-Extract([string]$file, [string]$dest = '.') { GP-Log "Extracting $file"; tar.exe -xf $file -C $dest; if ($LASTEXITCODE -ne 0) { Expand-Archive -LiteralPath $file -DestinationPath $dest -Force } }
Set-Location -LiteralPath $env:GP_SERVER_DIR
`;

async function runStep(step, ctx) {
  const { dir, vars, log } = ctx;
  const val = (v) => interpolate(v, vars);
  const inDir = (rel) => safeJoin(dir, val(rel || '.'));
  const type = String(step.type || '').toLowerCase();

  switch (type) {
    case 'steamcmd':
      return steamApp({
        appid: val(step.appid),
        login: val(step.login || 'anonymous'),
        branch: val(step.branch || ''),
        dir: step.dir ? inDir(step.dir) : dir,
        log,
        track: ctx.track,
      });

    case 'workshop':
      return workshopItem({ appid: val(step.appid), item: val(step.item), dest: inDir(step.dest), login: val(step.login || 'anonymous'), dir, log, track: ctx.track });

    case 'download':
      return download(val(step.url), inDir(step.dest || 'download.bin'), log, step.userAgent ? { userAgent: val(step.userAgent) } : {});

    case 'fetchlist': {
      const list = parseList(val(step.list));
      if (!list.length) log('Nothing to download');
      for (const f of list) {
        if (ctx.cancelled?.()) die('Install cancelled');
        await download(f.url, inDir(f.path), log);
      }
      return undefined;
    }

    case 'copy': {
      const from = inDir(step.from);
      if (!fs.existsSync(from)) return undefined;
      const to = inDir(step.to || '.');
      if (fs.statSync(from).isDirectory()) await fsp.cp(from, to, { recursive: true, force: true });
      else {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(from, to);
      }
      return undefined;
    }

    case 'remove':
      for (const p of [].concat(step.path || step.paths || [])) await fsp.rm(inDir(p), { recursive: true, force: true });
      return undefined;

    case 'run': {
      // A plain command in the server folder, with a Java fetched earlier in this install on PATH.
      if (!val(step.command || '').trim()) return undefined;
      const env = { ...ctx.env };
      if (ctx.javaHome) {
        const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
        env[key] = [path.join(ctx.javaHome, 'bin'), env[key] || ''].join(path.delimiter);
        env.JAVA_HOME = ctx.javaHome;
      }
      const code = await new Promise((resolve) => {
        const child = spawnShell(val(step.command), { cwd: dir, env, keepStdin: false });
        ctx.track?.(child);
        const forward = (chunk) => {
          for (const line of chunk.toString('utf8').split(/\r?\n|\r/)) if (line.trim()) log(line, 'stdout');
        };
        child.stdout.on('data', forward);
        child.stderr.on('data', forward);
        child.on('error', (err) => {
          log(`Could not run the command: ${err.message}`);
          resolve(-1);
        });
        child.on('exit', (c) => resolve(c ?? -1));
      });
      if (code !== 0) die(`${step.label || 'The command'} failed (exit ${code})`);
      return undefined;
    }

    case 'extract': {
      const file = inDir(step.file);
      await extractArchive(file, inDir(step.dest || '.'), log, { strip: Number(step.strip || 0) });
      if (step.deleteArchive) await fsp.rm(file, { force: true });
      return undefined;
    }

    case 'writefile': {
      const target = inDir(step.path);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, val(step.content ?? ''));
      log(`Wrote ${val(step.path)}`);
      return undefined;
    }

    case 'mkdir':
      await fsp.mkdir(inDir(step.path), { recursive: true });
      return undefined;

    case 'java': {
      const home = await ensureJava(val(step.version || vars.JAVA_VERSION || '21'), log);
      ctx.javaHome = home;
      return undefined;
    }

    case 'vcredist':
      return ensureVcRedist(log);

    case 'directx':
      return ensureDirectX(log);

    case 'powershell': {
      const script = PS_PRELUDE + val(step.run || step.script || '');
      const file = path.join(dir, '.gamepanel-step.ps1');
      await fsp.writeFile(file, script);
      const code = await streamProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { cwd: dir, env: ctx.env, log, track: ctx.track }
      );
      await fsp.rm(file, { force: true });
      if (code !== 0) die(`The "${step.label || 'PowerShell'}" step failed (exit ${code})`);
      return undefined;
    }

    case 'chmod':
    case 'apt':
      return undefined; // meaningless outside Linux

    case 'script':
      return die('This template only has a Linux (bash) installer for this step. It needs a "windows" install block.');

    default:
      return die(`Unknown install step type: ${step.type}`);
  }
}

/**
 * @param {object[]} steps   the template's install steps
 * @param {object} options   {dir, vars, env, log(line, stream), track(child)}
 * @returns {Promise<{ok:boolean, error?:string, javaHome?:string}>}
 */
async function runNativeInstall(steps, options) {
  const ctx = { ...options, env: { ...process.env, ...(options.env || {}), GP_SERVER_DIR: options.dir } };
  await fsp.mkdir(options.dir, { recursive: true });
  for (const [i, step] of steps.entries()) {
    if (options.cancelled?.()) return { ok: false, error: 'Install cancelled' };
    const label = interpolate(step.label || `${step.type} step ${i + 1}`, options.vars);
    options.log(`[gamepanel] ${label}`, 'system');
    try {
      await runStep(step, ctx);
    } catch (err) {
      return { ok: false, error: err instanceof StepError ? err.message : `${label}: ${err.message}` };
    }
  }
  return { ok: true, javaHome: ctx.javaHome };
}

module.exports = { runNativeInstall, ensureJava, ensureSteamcmd, steamApp, download, extractArchive };
