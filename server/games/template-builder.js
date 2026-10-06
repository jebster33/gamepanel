'use strict';

/**
 * Checks a game template made in the template builder (or pasted in as
 * JSON) before it is saved: everything a server needs is there, every
 * install step is one the installer knows, every {{PLACEHOLDER}} has a
 * value, and the regexes compile. Returns errors (blocking) and warnings.
 */

const { buildInstallScript } = require('../servers/install/bash');

const STEP_TYPES = {
  linux: ['apt', 'java', 'steamcmd', 'download', 'extract', 'copy', 'remove', 'run', 'writefile', 'chmod', 'mkdir', 'script', 'fetchlist', 'workshop'],
  // apt and chmod do nothing on Windows, so shared step lists can keep them.
  windows: ['apt', 'chmod', 'java', 'steamcmd', 'download', 'extract', 'copy', 'remove', 'run', 'writefile', 'mkdir', 'powershell', 'vcredist', 'directx', 'fetchlist', 'workshop'],
};
// Each entry: fields that must be there; "a|b" means either one.
const NEEDS = { steamcmd: ['appid'], download: ['url'], extract: ['file'], run: ['command'], writefile: ['path'], chmod: ['path'], mkdir: ['path'], apt: ['packages'], copy: ['from'], remove: ['path|paths'], script: ['run|script'], powershell: ['run|script'], fetchlist: ['list'] };
const QUERY_TYPES = ['none', 'a2s', 'minecraft', 'bedrock', 'tcp', 'udp'];
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGHUP', 'SIGQUIT'];
// Values the panel fills in for every server.
const BUILT_IN = ['SERVER_ID', 'SERVER_NAME', 'SERVER_DIR', 'MEMORY', 'MEMORY_MB', 'CPU_LIMIT', 'IP', 'PORT', 'MAX_PLAYERS', 'JAVA_VERSION'];
// Of those, the ones a setting may not replace (MAX_PLAYERS, JAVA_VERSION and SERVER_NAME can be settings).
const RESERVED = ['SERVER_ID', 'SERVER_DIR', 'MEMORY', 'MEMORY_MB', 'CPU_LIMIT', 'IP', 'PORT'];

const placeholders = (value) => [...JSON.stringify(value ?? '').matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]);

/**
 * @returns {{ template, errors: string[], warnings: string[], script: string }}
 */
function check(input, registry) {
  const errors = [];
  const warnings = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { template: null, errors: ['A template is a JSON object'], warnings, script: '' };
  const t = JSON.parse(JSON.stringify(input));
  delete t.custom;
  delete t.runnable;
  delete t.runsAs;

  // Basics.
  t.id = String(t.id || '').trim();
  t.name = String(t.name || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(t.id)) errors.push('The id must be 2 to 49 lowercase letters, numbers and dashes');
  else if (registry?.get(t.id) && !registry.get(t.id).custom) errors.push(`"${t.id}" is a built-in game's id. Pick another.`);
  if (!t.name || t.name.length > 80) errors.push('Give the game a name (up to 80 characters)');
  if (t.category !== undefined) t.category = String(t.category).trim().slice(0, 40) || 'Other';
  if (t.icon !== undefined) t.icon = String(t.icon).slice(0, 8);
  if (t.description !== undefined) t.description = String(t.description).slice(0, 500);
  if (t.defaultMemory !== undefined) {
    const mb = Number(t.defaultMemory);
    if (!Number.isFinite(mb) || mb < 128 || mb > 262144) errors.push('Default memory must be between 128 and 262144 MB');
    else t.defaultMemory = Math.round(mb);
  }
  t.platforms = (Array.isArray(t.platforms) && t.platforms.length ? t.platforms : ['linux']).filter((p) => p === 'linux' || p === 'windows');
  if (!t.platforms.length) errors.push('Pick Linux, Windows or both');

  // Ports.
  const ports = Array.isArray(t.ports) ? t.ports : [];
  if (!ports.length) errors.push('Add at least one port (the one players connect to)');
  if (ports.length > 12) errors.push('At most 12 ports');
  const portNames = new Set();
  for (const p of ports) {
    p.name = String(p.name || '').trim().toLowerCase();
    p.default = Number(p.default);
    if (!/^[a-z][a-z0-9_]{0,20}$/.test(p.name)) errors.push(`Port name "${p.name}" should be a short lowercase word, like game or query`);
    else if (portNames.has(p.name)) errors.push(`Two ports are called ${p.name}`);
    portNames.add(p.name);
    if (!Number.isInteger(p.default) || p.default < 1 || p.default > 65535) errors.push(`Port ${p.name}: ${p.default} is not a port number`);
    p.protocol = ['tcp', 'udp', 'both'].includes(p.protocol) ? p.protocol : 'tcp';
    if (p.offset !== undefined && p.offset !== '' && !Number.isInteger(Number(p.offset))) errors.push(`Port ${p.name}: the offset must be a whole number`);
  }
  if (ports.length && !portNames.has('game')) warnings.push('No port is called "game": {{PORT}} becomes the first port instead');

  // Settings people fill in when they create a server.
  const vars = Array.isArray(t.variables) ? t.variables : [];
  t.variables = vars;
  const varNames = new Set();
  for (const v of vars) {
    v.name = String(v.name || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(v.name)) errors.push(`Setting "${v.name}" needs a name in CAPITALS_WITH_UNDERSCORES`);
    else if (varNames.has(v.name)) errors.push(`Two settings are called ${v.name}`);
    else if (RESERVED.includes(v.name) || /^PORT_/.test(v.name)) errors.push(`${v.name} is filled in by the panel; give the setting another name`);
    varNames.add(v.name);
    if (!v.label) v.label = v.name.charAt(0) + v.name.slice(1).toLowerCase().replace(/_/g, ' ');
    if (v.default === undefined || v.default === null) v.default = '';
    if (Array.isArray(v.options) && !v.options.length) delete v.options;
  }

  // Install steps, for each platform.
  const checkSteps = (steps, platform) => {
    if (!Array.isArray(steps)) return [];
    steps.forEach((s, i) => {
      const where = `Install step ${i + 1}${platform === 'windows' ? ' (Windows)' : ''}`;
      const type = String(s?.type || '').toLowerCase();
      if (!STEP_TYPES[platform].includes(type)) {
        errors.push(`${where}: "${type || 'nothing'}" is not a step the ${platform === 'windows' ? 'Windows' : 'Linux'} installer knows`);
        return;
      }
      const empty = (value) => value === undefined || value === '' || (Array.isArray(value) && !value.length);
      for (const need of NEEDS[type] || []) {
        if (need.split('|').every((f) => empty(s[f]))) errors.push(`${where} (${type}) needs ${need.split('|')[0]}`);
      }
      if (type === 'download' && s.url && !/^https?:\/\/|^\{\{/.test(String(s.url))) errors.push(`${where}: the download address must start with http:// or https://`);
      if (type === 'steamcmd' && s.appid && !/^\d+$|^\{\{[A-Z0-9_]+\}\}$/.test(String(s.appid))) errors.push(`${where}: a Steam app id is a number (find it on steamdb.info)`);
    });
    return steps;
  };
  t.install = checkSteps(t.install || [], 'linux');
  if (t.platforms.includes('linux') && !t.install.length) warnings.push('There are no install steps: the server folder starts empty');

  // Running and stopping.
  t.startCommand = String(t.startCommand || '').trim();
  if (t.platforms.includes('linux') && !t.startCommand) errors.push('Say how the server starts (the start command)');
  if (t.stopCommand !== undefined) t.stopCommand = String(t.stopCommand).trim();
  if (!t.stopCommand) delete t.stopCommand;
  if (t.stopSignal && !SIGNALS.includes(t.stopSignal)) errors.push(`${t.stopSignal} is not a stop signal the panel sends`);
  if (t.stopTimeout !== undefined) t.stopTimeout = Math.max(5, Math.min(600, Number(t.stopTimeout) || 30));

  if (t.windows) {
    if (!t.platforms.includes('windows')) delete t.windows;
    else {
      if (t.windows.install) checkSteps(t.windows.install, 'windows');
      if (!t.windows.startCommand && !t.startCommand) errors.push('Say how the server starts on Windows');
    }
  } else if (t.platforms.includes('windows') && (t.install || []).some((s) => ['apt', 'chmod', 'script'].includes(s.type))) {
    warnings.push('Some install steps only work on Linux. Add Windows steps, or untick Windows.');
  }

  // Status check.
  if (t.query) {
    if (!QUERY_TYPES.includes(t.query.type)) errors.push(`The status check "${t.query.type}" is unknown`);
    if (t.query.type === 'none') delete t.query;
    else if (t.query.port && !portNames.has(t.query.port)) errors.push(`The status check uses a port called ${t.query.port}, which is not in the list`);
  }

  // Console lines.
  if (t.logPatterns) {
    for (const [k, re] of Object.entries(t.logPatterns)) {
      if (!re) {
        delete t.logPatterns[k];
        continue;
      }
      try {
        new RegExp(re);
      } catch (err) {
        errors.push(`The "${k}" console line is not a valid pattern: ${err.message}`);
      }
    }
    if (!Object.keys(t.logPatterns).length) delete t.logPatterns;
  }
  if (!t.logPatterns?.ready && !t.readyOnPort && !t.query) warnings.push('The panel cannot tell when the server is ready: add the line it prints when it has started, or a status check');

  // Every {{NAME}} must have a value.
  const known = new Set([...BUILT_IN, ...varNames, ...[...portNames].map((p) => `PORT_${p.toUpperCase()}`), 'RESOLVED_BUILD', 'DOWNLOAD_URL', 'WORKSHOP_MODS']);
  const unknown = [...new Set(placeholders([t.startCommand, t.install, t.configFiles, t.windows, t.stopCommand]))].filter((n) => !known.has(n));
  for (const n of unknown) warnings.push(`{{${n}}} is not a setting or a value the panel fills in, so it stays empty`);

  // What the install would run, with example values.
  let script = '';
  if (t.platforms.includes('linux') && !errors.some((e) => e.startsWith('Install step'))) {
    try {
      const sample = { SERVER_ID: 'example', SERVER_NAME: 'Example', SERVER_DIR: '/srv/example', MEMORY: t.defaultMemory || 2048, MEMORY_MB: t.defaultMemory || 2048, PORT: ports[0]?.default || 0, MAX_PLAYERS: 20, JAVA_VERSION: '21' };
      for (const p of ports) sample[`PORT_${p.name.toUpperCase()}`] = p.default;
      for (const v of vars) sample[v.name] = v.default;
      const full = buildInstallScript(t, '/srv/example', sample).script;
      // Only the game's own steps, not the shared helper functions in front of them.
      const at = full.indexOf("gp_log '");
      script = (at >= 0 ? full.slice(at) : full).replace(/\n\ngp_log "Install complete"[\s\S]*$/, '').slice(0, 20000);
    } catch (err) {
      warnings.push(`Could not show the install script: ${err.message}`);
    }
  }
  return { template: t, errors, warnings, script };
}

module.exports = { check, STEP_TYPES, QUERY_TYPES, BUILT_IN };
