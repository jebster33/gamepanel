'use strict';

/**
 * Raspberry Pi and other ARM hosts. Java games (Minecraft, Mindustry...) run
 * natively; most Steam servers and Bedrock are x86 only and run through box64
 * (64-bit programs) and box86 (32-bit programs such as SteamCMD) when those
 * are installed. Nothing here changes behaviour on an x86 machine.
 */

const fs = require('fs');
const path = require('path');
const { which, run, isLinux } = require('../core/platform');

/** "x64", "arm64", "arm" or whatever Node reports. */
const hostArch = () => process.arch;
const isArm = () => process.arch === 'arm64' || process.arch === 'arm';

/** How each template runs on ARM. An explicit `template.arm` ("native" | "box64" | "none") wins. */
function armClass(template) {
  if (['native', 'box64', 'none'].includes(template?.arm)) return template.arm;
  const text = [template?.startCommand, template?.image, ...(template?.packages || [])].filter(Boolean).join(' ');
  if (/\bjava\b|java:|temurin|jre|\.jar\b/i.test(text) && !/bedrock/i.test(template?.id || '')) return 'native';
  if (template?.platforms && !template.platforms.includes('linux')) return 'none';
  return 'box64';
}

let cache = null;
/** Which translators are installed (cached for a minute). */
function boxStatus() {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = { box64: isLinux ? which('box64') : null, box86: isLinux ? which('box86') : null };
  cache = { at: Date.now(), value };
  return value;
}

/**
 * How a template fares on this machine.
 * status: "ok" (runs natively or on an x86 host), "box64" (works through box64),
 * "needs-box64" (x86 only, box64 not installed), "unsupported".
 */
function compat(template, { arch = hostArch(), box = boxStatus(), platform = process.platform } = {}) {
  const cls = armClass(template);
  if (!(arch === 'arm64' || arch === 'arm')) {
    return { status: 'ok', arch, class: cls, label: 'Works on this machine', note: cls === 'native' ? 'Runs natively on ARM too.' : 'x86 game server: on ARM it needs box64.' };
  }
  if (platform === 'win32') return { status: 'unsupported', arch, class: cls, label: 'Not supported', note: 'Game servers on Windows ARM are not supported.' };
  if (cls === 'native') return { status: 'ok', arch, class: cls, label: 'Works on this machine', note: 'Java runs natively on ARM.' };
  if (cls === 'none') return { status: 'unsupported', arch, class: cls, label: 'Not supported', note: 'Only ships a build that cannot be translated.' };
  if (arch === 'arm' && !box.box86) return { status: 'unsupported', arch, class: cls, label: 'Not supported', note: '32-bit ARM needs box86; 64-bit games need a 64-bit OS.' };
  if (box.box64 || box.box86) return { status: 'box64', arch, class: cls, label: 'Works with box64', note: 'x86 game run through box64. Slower than native and some games misbehave.' };
  return { status: 'needs-box64', arch, class: cls, label: 'Needs box64', note: 'x86 only. Install box64 first (see the Raspberry Pi guide).' };
}

/** First bytes of an ELF file: 1 = 32-bit, 2 = 64-bit, 0 when it is not ELF. */
function elfClass(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0);
      return b.toString('latin1', 0, 4) === '\x7fELF' ? b[4] : 0;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

/**
 * Put box64/box86 in front of an x86 binary in a start command ("./RustDedicated -batchmode").
 * Left alone: x86 hosts, Java templates, scripts, commands that are not an ELF file in the server folder.
 */
function wrapStart(command, server, template, box = boxStatus(), { force = false } = {}) {
  if (!force && (!isArm() || process.platform !== 'linux')) return command;
  if (armClass(template) !== 'box64') return command;
  const m = String(command).match(/^(\s*)(\.\/[^\s"']+|[A-Za-z0-9_.-]+)(.*)$/s);
  if (!m) return command;
  const [, lead, bin, rest] = m;
  if (/^(java|bash|sh|exec|cd|env|box64|box86)$/.test(bin) || /\.sh$/.test(bin)) return command;
  const kind = elfClass(path.join(server.dir || '', bin.replace(/^\.\//, '')));
  if (!kind) return command;
  const runner = kind === 1 ? box.box86 && 'box86' : box.box64 && 'box64';
  return runner ? `${lead}${runner} ${bin}${rest}` : command;
}

/** Install box64 (box86 on 32-bit) from the system package manager. Admin has to confirm; needs the panel's sudo rule for apt-get. */
async function installBox({ confirm, arch = hostArch() } = {}) {
  if (!confirm) return { ok: false, error: 'Confirm that you want to install box64 from the system package manager.' };
  if (!isLinux || !isArm()) return { ok: false, error: 'box64 is only for ARM machines running Linux.' };
  const pkg = arch === 'arm64' ? 'box64' : 'box86';
  const r = await run('sudo', ['-n', 'apt-get', 'install', '-y', pkg], { timeout: 300_000 });
  cache = null;
  const log = (r.stdout.split('\n').slice(-4).join('\n') + r.stderr.split('\n').slice(-3).join('\n')).trim();
  if (r.code !== 0) {
    return { ok: false, error: `apt could not install ${pkg}. It is packaged in Debian 13 and recent Ubuntu; on older systems add the repository described in the Raspberry Pi guide.`, log };
  }
  return { ok: true, status: boxStatus(), log };
}

function info() {
  return { arch: hostArch(), arm: isArm(), platform: process.platform, ...boxStatus(), canInstall: isArm() && isLinux };
}

module.exports = { hostArch, isArm, armClass, boxStatus, compat, wrapStart, installBox, info, elfClass };
