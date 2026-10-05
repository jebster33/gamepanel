'use strict';

/**
 * Everything that differs between Linux and Windows hosts, in one place.
 *
 * The rest of the panel asks these helpers instead of checking
 * process.platform itself, so adding or fixing a platform quirk never means
 * hunting through the codebase.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

/** The template variant this host runs natively: "linux" or "windows". */
const HOST_PLATFORM = isWindows ? 'windows' : 'linux';

/** Run a program and collect its output; never throws on a non-zero exit. */
function run(file, args = [], { cwd, env, timeout = 60000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd, env, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err && typeof err.code !== 'number' ? err.message : null,
        });
      }
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

/** Run a PowerShell snippet (Windows only). */
function powershell(script, options = {}) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], options);
}

/**
 * Start a game server's shell command.
 *
 * Linux: `bash -lc` in its own process group, so the whole tree can be
 * signalled at once. Windows: `cmd /c`, with a console of its own when the
 * panel runs as a service, so Ctrl+C can be delivered for a clean shutdown.
 */
function spawnShell(command, { cwd, env, keepStdin = true } = {}) {
  const stdio = [keepStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'];
  if (isWindows) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      cwd,
      env,
      stdio,
      windowsVerbatimArguments: true,
      // A service has no console, so the child is given its own hidden one —
      // that is what makes the Ctrl+C below possible. From a terminal it would
      // share ours, so keep it windowless there instead.
      windowsHide: !process.env.GP_SERVICE,
    });
  }
  return spawn('bash', ['-lc', command], { cwd, env, stdio, detached: true });
}

/** Kill a process and everything it started. */
function killTree(pid, { force = true } = {}) {
  if (!pid) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => {}
    );
    return;
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Deliver a "please stop" signal to a server process tree.
 *
 * On Windows there are no signals: SIGINT becomes a console Ctrl+C (only
 * possible when the game has a console of its own, i.e. under the service),
 * anything else becomes a polite taskkill (WM_CLOSE).
 */
async function signalTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (!isWindows) {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
    return;
  }
  if (signal === 'SIGINT' && process.env.GP_SERVICE) {
    const ok = await sendCtrlC(pid);
    if (ok) return;
  }
  killTree(pid, { force: false });
}

/**
 * Ctrl+C for a Windows console process: a helper attaches to the game's
 * console, ignores the event itself, and raises it for everything attached.
 */
async function sendCtrlC(pid) {
  const script = `
$sig = '[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'
Add-Type -Namespace GP -Name Con -MemberDefinition $sig
[GP.Con]::FreeConsole() | Out-Null
if (-not [GP.Con]::AttachConsole(${Number(pid)})) { exit 3 }
[GP.Con]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null
[GP.Con]::GenerateConsoleCtrlEvent(0, 0) | Out-Null
Start-Sleep -Milliseconds 500
exit 0`;
  const result = await powershell(script, { timeout: 15000 });
  return result.code === 0;
}

/** The executable a template should look for, e.g. java → java.exe. */
function exe(name) {
  return isWindows ? `${name}.exe` : name;
}

/** First directory on PATH that contains `name`, or null. */
function which(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  const candidates = isWindows ? [name, `${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Friendly OS name for the dashboard. */
function describeHost() {
  const os = require('os');
  if (isWindows) {
    const release = os.release(); // 10.0.22631 etc.
    const build = Number(release.split('.')[2] || 0);
    const server = /server/i.test(os.version?.() || '');
    const name = server ? os.version() : build >= 22000 ? 'Windows 11' : 'Windows 10';
    return `${name} (build ${build})`;
  }
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const pretty = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
    if (pretty) return pretty;
  } catch {
    /* not every distro has it */
  }
  return `${os.type()} ${os.release()}`;
}

module.exports = {
  isWindows,
  isLinux,
  HOST_PLATFORM,
  run,
  powershell,
  spawnShell,
  killTree,
  signalTree,
  sendCtrlC,
  exe,
  which,
  describeHost,
};
