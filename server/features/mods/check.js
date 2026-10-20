'use strict';

/**
 * The mod check for every game with mods. Minecraft is read out of the jars
 * (conflicts.js); Rust's uMod plugins and Factorio's mod zips say what they
 * need in their own files; and for any game the panel's record of what it
 * installed is compared with what is on disk.
 *
 * Issues: { severity: 'error'|'warning', file, message }. Starting a server
 * with issues only warns (see power.js): the check can be wrong about a mod
 * it does not understand, and the owner knows better.
 */

const fs = require('fs');
const path = require('path');
const safefs = require('../../core/safefs');
const zip = require('../../core/zip');
const compat = require('./compat');
const manifest = require('./manifest');
const conflicts = require('./conflicts');
const { containedPath } = require('../files');

/** Directory entries of the mods folder, [] when there is none. */
function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------- rust -- */

/** "// Requires: Name" lines and [Info("Name", "Author", "1.0.0")] at the top of a uMod plugin. */
function describePlugin(text) {
  const info = text.match(/\[Info\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"/);
  const requires = [...text.matchAll(/^\s*\/\/\s*Requires:\s*([A-Za-z0-9_.-]+)/gim)].map((m) => m[1]);
  return { name: info?.[1] || null, version: info?.[3] || null, requires };
}

function checkOxide(server, ctx, add) {
  const dir = containedPath(server.dir, ctx.dir);
  const plugins = [];
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !/\.cs$/i.test(entry.name)) continue;
    try {
      plugins.push({ file: entry.name, ...describePlugin(safefs.readText(path.join(dir, entry.name), 2 * 1024 * 1024)) });
    } catch {
      add('warning', entry.name, 'This plugin file could not be read.');
    }
  }
  if (!plugins.length) return 0;

  const names = new Map();
  for (const p of plugins) {
    for (const key of [p.name, p.file.replace(/\.cs$/i, '')].filter(Boolean).map((k) => k.toLowerCase())) {
      if (!names.has(key)) names.set(key, new Set());
      names.get(key).add(p.file);
    }
  }
  for (const p of plugins) {
    const label = p.name || p.file;
    if (!p.name) add('warning', p.file, `${label} has no [Info] line, so Oxide will not load it as a plugin.`);
    for (const need of p.requires) {
      if (!names.has(need.toLowerCase())) add('error', p.file, `${label} needs the ${need} plugin, which is not installed.`);
    }
  }
  const byName = new Map();
  for (const p of plugins) if (p.name) byName.set(p.name.toLowerCase(), [...(byName.get(p.name.toLowerCase()) || []), p.file]);
  for (const [, files] of byName) if (files.length > 1) add('error', files[0], `${files.join(' and ')} are the same plugin. Oxide loads only one of them; remove the other.`);

  // The plugins need Oxide or Carbon underneath them.
  const hasFramework =
    fs.existsSync(path.join(server.dir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll')) || fs.existsSync(path.join(server.dir, 'carbon')) || fs.existsSync(path.join(server.dir, 'HarmonyMods'));
  if (!hasFramework) add('warning', plugins[0].file, 'Plugins are installed, but neither Oxide nor Carbon was found in this server. They will not run until one of them is installed.');
  return plugins.length;
}

/* -------------------------------------------------------------- factorio -- */

const FACTORIO_BUILTIN = new Set(['base', 'core', 'space-age', 'quality', 'elevated-rails']);
const numbers = (v) => String(v).split('.').map((n) => Number(n) || 0);
function cmpDotted(a, b) {
  const x = numbers(a);
  const y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
const holds = (version, op, wanted) => {
  const c = cmpDotted(version, wanted);
  return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
};

/** One dependency string: "? name", "! name", "name >= 1.2", "(?) name", "~ name". */
function parseFactorioDep(text) {
  const m = String(text).trim().match(/^(\(\?\)|[!?~])?\s*([^\s<>=]+(?:\s+[^\s<>=]+)*?)\s*(?:(>=|<=|>|<|=)\s*([\d.]+))?$/);
  if (!m) return null;
  const kind = m[1] === '!' ? 'incompatible' : m[1] === '?' || m[1] === '(?)' ? 'optional' : 'required';
  return { kind, name: m[2], op: m[3] || null, version: m[4] || null };
}

function checkFactorio(server, ctx, add) {
  const dir = containedPath(server.dir, ctx.dir);
  let enabled = null;
  try {
    const list = JSON.parse(safefs.readText(path.join(dir, 'mod-list.json'), 1024 * 1024));
    enabled = new Map((list.mods || []).map((m) => [m.name, m.enabled !== false]));
  } catch {
    /* no list yet: everything in the folder counts */
  }
  const mods = [];
  for (const entry of listDir(dir)) {
    if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue;
    try {
      const z = zip.open(path.join(dir, entry.name));
      try {
        const infoName = z.names.find((n) => /^(?:[^/]+\/)?info\.json$/.test(n));
        const info = infoName ? JSON.parse(z.read(infoName).toString('utf8').replace(/^﻿/, '')) : null;
        if (!info?.name) {
          add('error', entry.name, 'This zip has no info.json, so Factorio will not treat it as a mod.');
          continue;
        }
        mods.push({ file: entry.name, ...info });
      } finally {
        z.close();
      }
    } catch (err) {
      add('error', entry.name, `This is not a working mod zip (${err.message}). Download it again.`);
    }
  }
  const active = mods.filter((m) => !enabled || enabled.get(m.name) !== false);
  const byName = new Map();
  for (const m of active) byName.set(m.name, [...(byName.get(m.name) || []), m]);
  for (const [name, list] of byName) {
    if (list.length > 1) add('warning', list[0].file, `${name} is installed twice (${list.map((m) => m.file).join(' and ')}). Factorio uses the newest; remove the other.`);
  }

  const game = ctx.gameVersion ? ctx.gameVersion.split('.').slice(0, 2).join('.') : null;
  for (const m of active) {
    if (game && m.factorio_version && m.factorio_version !== game) {
      add('error', m.file, `${m.title || m.name} is made for Factorio ${m.factorio_version}; this server runs ${ctx.gameVersion}.`);
    }
    for (const raw of m.dependencies || []) {
      const d = parseFactorioDep(raw);
      if (!d || FACTORIO_BUILTIN.has(d.name)) continue;
      const have = byName.get(d.name);
      if (d.kind === 'incompatible') {
        if (have) add('error', m.file, `${m.title || m.name} does not work together with ${d.name}. Remove one of them.`);
      } else if (d.kind === 'required') {
        if (!have) add('error', m.file, `${m.title || m.name} needs ${d.name}, which is not installed${enabled?.get(d.name) === false ? ' (it is switched off)' : ''}.`);
        else if (d.op && !have.some((h) => holds(h.version, d.op, d.version))) {
          add('warning', m.file, `${m.title || m.name} needs ${d.name} ${d.op} ${d.version}; ${have.map((h) => h.version).join(' / ')} is installed.`);
        }
      }
    }
  }
  return mods.length;
}

/* ------------------------------------------------------------- the panel -- */

/** What the panel recorded against what is on disk, for any game. */
function checkRecord(server, ctx, add) {
  const records = manifest.load(server);
  if (!records.length) return;
  const dir = containedPath(server.dir, ctx.dir);
  const onDisk = new Set(listDir(dir).map((e) => e.name));
  const byKey = new Map(records.map((r) => [r.key, r]));
  for (const r of records) {
    if (r.file && !r.disabled && !onDisk.has(r.file) && !onDisk.has(`${r.file}.disabled`)) {
      add('warning', r.file, `${r.name} is recorded as installed, but its file is gone from ${ctx.dir}. Install it again or remove it from the list.`);
    }
    if (r.disabled || (r.file && onDisk.has(`${r.file}.disabled`) && !onDisk.has(r.file))) {
      const needing = (r.requiredBy || []).map((k) => byKey.get(k)).filter((p) => p && !p.disabled && !(p.file && !onDisk.has(p.file)));
      if (needing.length) add('error', r.file || r.key, `${r.name} is switched off, but ${needing.map((p) => p.name).join(', ')} need${needing.length === 1 ? 's' : ''} it.`);
    }
  }
}

/**
 * Check a server's mods.
 * @returns {{supported, loader, gameVersion, checked, issues, at}}
 */
function run(server, template) {
  const ctx = compat.modContext(server, template);
  const base = { loader: ctx.loaderLabel || ctx.loader || null, gameVersion: ctx.gameVersion || null, at: Date.now() };
  const issues = [];
  const add = (severity, file, message) => issues.push({ severity, file, message });
  let checked = 0;
  let supported = false;

  if (ctx.game === 'minecraft') {
    const r = conflicts.check(server, template);
    if (r.supported) {
      supported = true;
      checked += r.checked;
      issues.push(...r.issues);
    }
  } else if (ctx.game === 'rust') {
    supported = true;
    checked += checkOxide(server, ctx, add);
  } else if (ctx.game === 'factorio' || template?.id === 'factorio') {
    supported = true;
    checked += checkFactorio(server, ctx, add);
  }
  try {
    checkRecord(server, ctx, add);
    supported = supported || manifest.load(server).length > 0;
  } catch {
    /* an unreadable folder is not a mod problem */
  }

  issues.sort((a, b) => (a.severity === b.severity ? String(a.file).localeCompare(String(b.file)) : a.severity === 'error' ? -1 : 1));
  return { ...base, supported, checked, issues };
}

/** True when the Mods tab has something to check for this server. */
function checkable(server, template) {
  const ctx = compat.modContext(server, template);
  if (ctx.game === 'minecraft') return Boolean(conflicts.acceptedKinds(ctx.loader, ctx.gameVersion));
  return ctx.game === 'rust' || ctx.game === 'factorio' || template?.id === 'factorio' || manifest.load(server).length > 0;
}

module.exports = { run, checkable, describePlugin, parseFactorioDep };
