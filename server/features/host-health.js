'use strict';

/**
 * Health of the machine the panel runs on (administrators only): disk SMART status, temperatures,
 * pending operating system updates, a disk-full forecast, uptime and whether a reboot is due.
 *
 * Everything runs fixed commands through execFile (no shell, nothing from a request goes into
 * them), is cached because some are slow, and says "unavailable" with a hint instead of failing.
 * Problems become `panel.host_health` events, which go out through the usual alert channels.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../core/config');
const { run, powershell, which, isWindows, isLinux } = require('../core/platform');
const { logger } = require('../core/util');

const TTL = { smart: 3600_000, updates: 6 * 3600_000, temps: 20_000 };
const cache = new Map();
async function cached(key, fn, ttl = TTL[key]) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (hit?.pending) return hit.pending;
  const pending = fn()
    .catch((err) => ({ available: false, error: String(err.message || err).slice(0, 200) }))
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    });
  cache.set(key, { ...(hit || { at: 0 }), pending });
  return pending;
}

/* ----------------------------------------------------------------- SMART -- */

/** One drive from `smartctl -j -H -A` output. */
function parseSmart(json, device) {
  const attrs = json.ata_smart_attributes?.table || [];
  const attr = (id) => attrs.find((a) => a.id === id)?.raw?.value;
  const nvme = json.nvme_smart_health_information_log || {};
  return {
    device,
    model: json.model_name || json.device?.name || device,
    passed: json.smart_status?.passed ?? null,
    temperature: json.temperature?.current ?? nvme.temperature ?? null,
    powerOnHours: json.power_on_time?.hours ?? null,
    reallocated: attr(5) ?? null,
    pending: attr(197) ?? null,
    wearUsedPercent: nvme.percentage_used ?? null,
    mediaErrors: nvme.media_errors ?? null,
  };
}

async function smart() {
  if (isWindows) {
    const r = await powershell(
      'Get-PhysicalDisk | ForEach-Object { $c = $_ | Get-StorageReliabilityCounter; [pscustomobject]@{ Name=$_.FriendlyName; Health=[string]$_.HealthStatus; Temp=$c.Temperature; Wear=$c.Wear; Hours=$c.PowerOnHours; ReadErrors=$c.ReadErrorsTotal } } | ConvertTo-Json -Compress',
      { timeout: 30_000 }
    );
    if (r.code !== 0 || !r.stdout.trim()) return { available: false, hint: 'Windows did not return disk health. Run the panel as administrator or check Get-PhysicalDisk by hand.' };
    const rows = [].concat(JSON.parse(r.stdout));
    return {
      available: true,
      source: 'Get-PhysicalDisk',
      drives: rows.map((d) => ({ device: d.Name, model: d.Name, passed: d.Health === 'Healthy', health: d.Health, temperature: d.Temp ?? null, powerOnHours: d.Hours ?? null, wearUsedPercent: d.Wear ?? null, mediaErrors: d.ReadErrors ?? null })),
    };
  }
  const bin = which('smartctl') || ['/usr/sbin/smartctl', '/usr/local/sbin/smartctl'].find((f) => fs.existsSync(f));
  if (!bin) return { available: false, hint: 'smartctl is not installed. Install smartmontools (for example: sudo apt install smartmontools) to see disk health.' };
  const scan = await run(bin, ['--scan', '-j'], { timeout: 15_000 });
  let devices = [];
  try {
    devices = (JSON.parse(scan.stdout).devices || []).map((d) => d.name).filter((n) => /^\/dev\/[A-Za-z0-9/_-]+$/.test(n));
  } catch {
    /* no devices listed */
  }
  if (!devices.length) return { available: true, drives: [], hint: 'smartctl found no drives (virtual machines and containers usually have none).' };
  const drives = [];
  let denied = false;
  for (const device of devices.slice(0, 12)) {
    let r = await run(bin, ['-H', '-A', '-i', '-j', device], { timeout: 20_000 });
    if (!r.stdout.trim().startsWith('{') && process.getuid && process.getuid() !== 0) r = await run('sudo', ['-n', bin, '-H', '-A', '-i', '-j', device], { timeout: 20_000 });
    try {
      const json = JSON.parse(r.stdout);
      if (json.smartctl?.messages?.some((m) => /permission denied/i.test(m.string || ''))) denied = true;
      else drives.push(parseSmart(json, device));
    } catch {
      denied = true;
    }
  }
  return { available: true, source: 'smartctl', drives, hint: denied && !drives.length ? 'smartctl needs root to read the drives. Allow it in sudoers: gamepanel ALL=(root) NOPASSWD: /usr/sbin/smartctl -H -A -i -j /dev/*' : undefined };
}

/* ---------------------------------------------------------- temperatures -- */

/** Linux temperature sensors: hwmon first, thermal zones for what hwmon lacks, Raspberry Pi vcgencmd. */
function readSensors(sysRoot = '/sys') {
  const out = [];
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const hwmon = path.join(sysRoot, 'class/hwmon');
  let chips = [];
  try {
    chips = fs.readdirSync(hwmon);
  } catch {
    /* none */
  }
  for (const chip of chips) {
    const dir = path.join(hwmon, chip);
    const name = read(path.join(dir, 'name')) || chip;
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^temp\d+_input$/.test(f));
    } catch {
      /* skip */
    }
    for (const f of files) {
      const v = Number(read(path.join(dir, f)));
      if (!Number.isFinite(v) || v <= -50000 || v > 200000) continue;
      const label = read(path.join(dir, f.replace('_input', '_label')));
      out.push({ name: label ? `${name} ${label}` : name, celsius: Math.round(v / 100) / 10, source: 'hwmon' });
    }
  }
  if (!out.length) {
    const tz = path.join(sysRoot, 'class/thermal');
    let zones = [];
    try {
      zones = fs.readdirSync(tz).filter((z) => /^thermal_zone\d+$/.test(z));
    } catch {
      /* none */
    }
    for (const z of zones) {
      const v = Number(read(path.join(tz, z, 'temp')));
      if (Number.isFinite(v) && v > -50000 && v < 200000) out.push({ name: read(path.join(tz, z, 'type')) || z, celsius: Math.round(v / 100) / 10, source: 'thermal_zone' });
    }
  }
  return out;
}

async function temps() {
  if (isWindows) {
    const r = await powershell("Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ Name=$_.InstanceName; C=[math]::Round(($_.CurrentTemperature/10)-273.15,1) } } | ConvertTo-Json -Compress", { timeout: 15_000 });
    if (r.code !== 0 || !r.stdout.trim()) return { available: false, hint: 'Windows exposes temperatures only on some hardware (and to administrators). Use the maker\'s tool or HWiNFO instead.' };
    return { available: true, sensors: [].concat(JSON.parse(r.stdout)).map((s) => ({ name: String(s.Name).replace(/^ACPI\\/, ''), celsius: s.C, source: 'WMI' })) };
  }
  const sensors = isLinux ? readSensors() : [];
  const vc = which('vcgencmd');
  if (vc) {
    const r = await run(vc, ['measure_temp'], { timeout: 5000 });
    const m = r.stdout.match(/temp=([\d.]+)/);
    if (m && !sensors.some((s) => s.source === 'vcgencmd')) sensors.push({ name: 'Raspberry Pi SoC', celsius: Number(m[1]), source: 'vcgencmd' });
    const t = await run(vc, ['get_throttled'], { timeout: 5000 });
    const bits = parseInt((t.stdout.match(/0x([0-9a-f]+)/i) || [])[1] || '0', 16);
    if (bits & 0x5) sensors.push({ name: 'Raspberry Pi power', celsius: null, warning: bits & 0x1 ? 'Under-voltage: use a better power supply' : 'Throttled by heat', source: 'vcgencmd' });
  }
  if (!sensors.length) return { available: false, hint: isLinux ? 'No temperature sensors are exposed here (common in virtual machines and containers).' : 'Temperatures are not available on this system.' };
  return { available: true, sensors, max: Math.max(...sensors.filter((s) => s.celsius != null).map((s) => s.celsius)) };
}

/* ------------------------------------------------------ operating system -- */

/** `apt-get -s upgrade` lines: "Inst libc6 [2.1] (2.2 Debian-Security:12/stable-security [amd64])". */
function parseApt(text) {
  const inst = String(text).split('\n').filter((l) => l.startsWith('Inst '));
  return { count: inst.length, security: inst.filter((l) => /security/i.test(l)).length, packages: inst.slice(0, 15).map((l) => l.split(' ')[1]) };
}

async function osUpdates() {
  if (isWindows) {
    const r = await powershell(
      "$s = New-Object -ComObject Microsoft.Update.Session; $r = $s.CreateUpdateSearcher().Search('IsInstalled=0 and IsHidden=0'); [pscustomobject]@{ Count=$r.Updates.Count; Titles=@($r.Updates | Select-Object -First 15 | ForEach-Object { $_.Title }) } | ConvertTo-Json -Compress",
      { timeout: 120_000 }
    );
    if (r.code !== 0 || !r.stdout.trim()) return { available: false, manager: 'Windows Update', hint: 'Windows Update could not be queried from here. Open Settings, Windows Update.' };
    const j = JSON.parse(r.stdout);
    return { available: true, manager: 'Windows Update', count: j.Count, security: null, packages: [].concat(j.Titles || []) };
  }
  if (which('apt-get')) {
    const r = await run('apt-get', ['-s', '-o', 'Debug::NoLocking=1', 'upgrade'], { timeout: 60_000 });
    return { available: true, manager: 'apt', ...parseApt(r.stdout), note: 'Based on the package lists already on this machine (run apt update to refresh them).' };
  }
  if (which('dnf')) {
    const r = await run('dnf', ['-q', 'check-update'], { timeout: 120_000 });
    const lines = r.stdout.split('\n').filter((l) => /^\S+\.\S+\s+\S+\s+\S+/.test(l));
    return { available: true, manager: 'dnf', count: lines.length, security: null, packages: lines.slice(0, 15).map((l) => l.split(/\s+/)[0]) };
  }
  if (which('checkupdates')) {
    const r = await run('checkupdates', [], { timeout: 120_000 });
    const lines = r.stdout.split('\n').filter(Boolean);
    return { available: true, manager: 'pacman', count: lines.length, security: null, packages: lines.slice(0, 15).map((l) => l.split(' ')[0]) };
  }
  return { available: false, hint: 'No supported package manager found (apt, dnf or pacman; pacman needs pacman-contrib for checkupdates).' };
}

async function rebootRequired() {
  if (isWindows) {
    const r = await powershell("(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending')", { timeout: 10_000 });
    return { required: /true/i.test(r.stdout) };
  }
  const flag = '/var/run/reboot-required';
  if (!fs.existsSync(flag)) return { required: false };
  let packages = [];
  try {
    packages = fs.readFileSync(`${flag}.pkgs`, 'utf8').split('\n').filter(Boolean).slice(0, 10);
  } catch {
    /* no list */
  }
  return { required: true, since: fs.statSync(flag).mtimeMs, packages };
}

/* ------------------------------------------------------------- forecast -- */

const SAMPLES = path.join(config.dataDir, 'host-disk.json');
let samples = null;

function diskNow() {
  try {
    const st = fs.statfsSync(config.dataDir);
    return { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
  } catch {
    return null;
  }
}

function loadSamples() {
  if (samples) return samples;
  try {
    samples = JSON.parse(fs.readFileSync(SAMPLES, 'utf8'));
  } catch {
    samples = [];
  }
  return samples;
}

/** Keep one sample an hour for 30 days. */
function sampleDisk(now = Date.now()) {
  const d = diskNow();
  if (!d) return;
  const list = loadSamples();
  if (list.length && now - list[list.length - 1].t < 3600_000) return;
  list.push({ t: now, used: d.total - d.free });
  while (list.length > 24 * 30) list.shift();
  try {
    fs.writeFileSync(SAMPLES, JSON.stringify(list));
  } catch {
    /* next time */
  }
}

/** Days until the disk is full at the recent growth rate (least squares over the samples), or null when it is not growing. */
function forecast(list, total, freeNow) {
  const pts = list.filter((p) => Date.now() - p.t < 14 * 86_400_000);
  if (pts.length < 6 || pts[pts.length - 1].t - pts[0].t < 12 * 3600_000) return { days: null, note: 'Not enough history yet (needs about half a day of samples).' };
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.t, 0) / n;
  const my = pts.reduce((a, p) => a + p.used, 0) / n;
  const num = pts.reduce((a, p) => a + (p.t - mx) * (p.used - my), 0);
  const den = pts.reduce((a, p) => a + (p.t - mx) ** 2, 0);
  const perDay = den ? (num / den) * 86_400_000 : 0;
  if (perDay <= 1024 * 1024) return { days: null, perDay: Math.max(0, Math.round(perDay)), note: 'Disk use is not growing.' };
  return { days: Math.round((freeNow / perDay) * 10) / 10, perDay: Math.round(perDay), total };
}

/* --------------------------------------------------------------- report -- */

async function report({ refresh = false } = {}) {
  if (refresh) cache.clear();
  sampleDisk();
  const d = diskNow();
  const [s, t, u, rb] = await Promise.all([cached('smart', smart), cached('temps', temps), cached('updates', osUpdates), cached('reboot', rebootRequired, 60_000)]);
  return {
    at: Date.now(),
    uptime: os.uptime(),
    host: `${os.hostname()} (${process.platform}/${process.arch})`,
    disk: d ? { ...d, forecast: forecast(loadSamples(), d.total, d.free) } : null,
    smart: s,
    temps: t,
    updates: u,
    reboot: rb,
  };
}

/** What deserves an alert in a report. */
function problems(r) {
  const out = [];
  for (const d of r.smart?.drives || []) {
    if (d.passed === false) out.push({ key: `smart:${d.device}`, text: `Disk ${d.device} (${d.model}) reports that it is failing its SMART check. Back up and replace it.` });
    else if (d.pending > 0 || d.mediaErrors > 0) out.push({ key: `smart-warn:${d.device}`, text: `Disk ${d.device} has ${d.pending || 0} pending and ${d.mediaErrors || 0} media errors. Watch it.` });
  }
  const hot = (r.temps?.sensors || []).filter((s) => s.celsius != null && s.celsius >= 85);
  if (hot.length) out.push({ key: 'temp', text: `The machine is hot: ${hot[0].name} is at ${hot[0].celsius} °C.` });
  for (const s of r.temps?.sensors || []) if (s.warning) out.push({ key: `pi:${s.name}`, text: s.warning });
  const days = r.disk?.forecast?.days;
  if (days != null && days < 7) out.push({ key: 'disk-forecast', text: `At the current rate the disk fills up in about ${days} days.` });
  if (r.reboot?.required && r.reboot.since && Date.now() - r.reboot.since > 7 * 86_400_000) out.push({ key: 'reboot', text: 'The machine has needed a reboot for over a week (OS updates are waiting for it).' });
  if (r.updates?.security > 0) out.push({ key: 'sec-updates', text: `${r.updates.security} security update${r.updates.security === 1 ? ' is' : 's are'} waiting to be installed.` });
  return out;
}

const COOLDOWN = 12 * 3600_000;
const sent = new Map();

function startMonitor({ store }) {
  const tick = async () => {
    try {
      const r = await report();
      for (const p of problems(r)) {
        if (Date.now() - (sent.get(p.key) || 0) < COOLDOWN) continue;
        sent.set(p.key, Date.now());
        store.addEvent('panel.host_health', p.text);
      }
    } catch (err) {
      logger.warn(`Host health check failed: ${err.message}`);
    }
  };
  const timer = setInterval(tick, 30 * 60_000);
  timer.unref?.();
  setTimeout(tick, 2 * 60_000).unref?.();
  return timer;
}

module.exports = { report, problems, forecast, parseApt, parseSmart, readSensors, startMonitor, sampleDisk };
