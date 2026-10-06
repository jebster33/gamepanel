'use strict';

/**
 * Mod conflict check for Minecraft: open every jar in the mods or plugins
 * folder, read what it says about itself (fabric.mod.json, quilt.mod.json,
 * META-INF/mods.toml, neoforge.mods.toml, plugin.yml, paper-plugin.yml) and
 * find what would stop the server or leave a mod unloaded:
 *
 *   - built for another loader (a Forge mod on Fabric, a plugin on Forge)
 *   - built for another Minecraft version
 *   - a required mod or plugin is missing, or too old/new
 *   - two mods that say they break each other
 *   - the same mod twice (two versions of one jar)
 *   - client-only mods
 *
 * Works on jars uploaded by hand too, not just the ones the panel installed.
 */

const fs = require('fs');
const path = require('path');
const zip = require('../../core/zip');
const compat = require('./compat');

/* -------------------------------------------------------------- versions -- */

/** "0.92.2+1.20.1" → { nums: [0, 92, 2], pre: '' }; null when it is not a version. */
function parseVersion(value) {
  let text = String(value || '').trim().replace(/^v/i, '');
  text = text.split('+')[0];
  // Forge-style "1.20.1-2.3.4" and "mc1.20.1-2.3.4": the mod's own version is after the dash.
  // ("1.0.5-264" is a pre-release of 1.0.5, not that.)
  const mcPrefix = text.match(/^mc\d+\.\d+(?:\.\d+)?-(\d.*)$/i) || text.match(/^(?:1\.(?:[7-9]|[1-9]\d)|2\d\.\d+)(?:\.\d+)?-(\d+\.\d.*)$/);
  if (mcPrefix) text = mcPrefix[1];
  const [core, ...rest] = text.split('-');
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return { nums: core.split('.').map(Number), pre: rest.join('-') };
}

/** Minecraft's own version: "1.20.1", "1.21". */
function parseMc(value) {
  const m = String(value || '').match(/^(\d+(?:\.\d+)*)(?:-(.+))?$/);
  return m ? { nums: m[1].split('.').map(Number), pre: m[2] || '' } : null;
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] || 0) - (b.nums[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
}

/** One Fabric/Quilt predicate: ">=1.20", "~1.20.1", "1.20.x", "*". */
function predicate(version, pred, parse) {
  const text = String(pred).trim();
  if (!text || text === '*' || text === 'x' || text === 'X') return true;
  const m = text.match(/^(>=|<=|>|<|=|~|\^)?\s*(.+)$/);
  const op = m[1] || '=';
  let target = m[2];
  // Wildcards: "1.20.x" is anything starting 1.20.
  const wild = target.match(/^(.*?)\.?[xX*](?:\.[xX*])*$/);
  if (wild && (op === '=' || op === '~' || op === '^')) {
    const prefix = parse(wild[1]);
    if (!prefix) return true;
    return prefix.nums.every((n, i) => (version.nums[i] || 0) === n);
  }
  target = target.replace(/\.[xX*]/g, '');
  const t = parse(target);
  if (!t) return true;
  const c = compare(version, t);
  switch (op) {
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    case '~': {
      const upper = { nums: t.nums.length > 1 ? [t.nums[0], t.nums[1] + 1] : [t.nums[0] + 1], pre: '' };
      return c >= 0 && compare({ ...version, pre: '' }, upper) < 0;
    }
    case '^':
      return c >= 0 && compare({ ...version, pre: '' }, { nums: [t.nums[0] + 1], pre: '' }) < 0;
    default:
      return c === 0;
  }
}

/** A Fabric or Quilt range: one string (space-separated AND) or an array of them (OR). */
function fabricSatisfies(value, range, parse = parseVersion) {
  const version = parse(value);
  if (!version) return true; // unknown: give it the benefit of the doubt
  const any = Array.isArray(range) ? range : [range];
  if (!any.length) return true;
  return any.some((r) => String(r).split(/\s+/).filter(Boolean).every((p) => predicate(version, p, parse)) || !String(r).trim());
}

/** A Maven range as Forge uses it: "[1.20.1,1.21)", "[47,)", "[1.0],[1.2,)"; a bare version means "any". */
function mavenSatisfies(value, range, parse = parseVersion) {
  const version = parse(value);
  const text = String(range || '').trim();
  if (!version || !text || text === '*') return true;
  const ranges = [...text.matchAll(/([[(])\s*([^,\])]*?)\s*(?:(,)\s*([^\])]*?)\s*)?([\])])/g)];
  if (!ranges.length) return true;
  return ranges.some(([, open, low, comma, high, close]) => {
    if (!comma) {
      const exact = parse(low);
      return !exact || compare(version, exact) === 0;
    }
    const lo = low ? parse(low) : null;
    const hi = high ? parse(high) : null;
    if (lo && (open === '[' ? compare(version, lo) < 0 : compare(version, lo) <= 0)) return false;
    if (hi && (close === ']' ? compare(version, hi) > 0 : compare(version, hi) >= 0)) return false;
    return true;
  });
}

/* -------------------------------------------------------------- metadata -- */

/** Just enough TOML for mods.toml: [[mods]], [[dependencies.id]], key = value. */
function parseModsToml(text) {
  const out = { mods: [], dependencies: {}, top: {} };
  let target = out.top;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const table = line.match(/^\[\[\s*([^\]]+?)\s*\]\]/);
    if (table) {
      const name = table[1];
      target = {};
      if (name === 'mods') out.mods.push(target);
      else if (name.startsWith('dependencies.')) {
        const id = name.slice(13).replace(/^"|"$/g, '');
        (out.dependencies[id] ||= []).push(target);
      }
      continue;
    }
    if (/^\[/.test(line)) {
      target = {}; // a table we do not need
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    const multi = value.match(/^("""|''')/);
    if (multi) {
      let body = value.slice(3);
      while (!body.includes(multi[1]) && i + 1 < lines.length) body += `\n${lines[++i]}`;
      value = body.slice(0, body.indexOf(multi[1]));
    } else if (/^["']/.test(value)) {
      const q = value[0];
      const end = value.indexOf(q, 1);
      value = value.slice(1, end === -1 ? undefined : end);
    } else {
      value = value.replace(/\s+#.*$/, '');
      if (value === 'true' || value === 'false') value = value === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    }
    target[kv[1]] = value;
  }
  return out;
}

/** Just enough YAML for plugin.yml: top-level scalars and lists. */
function parsePluginYml(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2].replace(/\s+#.*$/, '');
    if (value.startsWith('[')) value = value.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (value === '') {
      const items = [];
      while (i + 1 < lines.length && /^\s+-\s*/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s+-\s*/, '').trim().replace(/^["']|["']$/g, ''));
      value = items.length ? items : '';
    } else value = value.replace(/^["']|["']$/g, '');
    out[m[1]] = value;
  }
  return out;
}

/** paper-plugin.yml: dependencies.server.<Name>.required (true unless it says false). */
function paperDependencies(text) {
  const lines = text.split(/\r?\n/);
  const deps = [];
  let inDeps = false;
  let inServer = false;
  let current = null;
  for (const line of lines) {
    if (/^dependencies:/.test(line)) {
      inDeps = true;
      continue;
    }
    if (inDeps && /^\S/.test(line)) inDeps = inServer = false;
    if (!inDeps) continue;
    const indent = line.match(/^\s*/)[0].length;
    const key = line.trim().match(/^([^:#]+):\s*(.*)$/);
    if (!key) continue;
    if (indent <= 2) {
      inServer = key[1] === 'server';
      continue;
    }
    if (!inServer) continue;
    if (indent <= 4) {
      current = { id: key[1].trim().replace(/^["']|["']$/g, ''), required: true };
      deps.push(current);
    } else if (current && key[1] === 'required') current.required = key[2].trim() !== 'false';
  }
  return deps;
}

const dep = (id, range, flavor, extra = {}) => ({ id: String(id).toLowerCase(), range, flavor, ...extra });

/**
 * What one jar is and says about itself.
 * @returns {{kinds: string[], mods: {id, name, version}[], provides: string[], depends, breaks, conflicts, environment, apiVersion, folia, nested: Buffer[]}}
 */
function describeJar(source) {
  const z = zip.open(source);
  try {
    const info = { kinds: [], mods: [], provides: [], depends: [], breaks: [], conflicts: [], environment: '*', apiVersion: null, folia: false, nested: [] };
    const text = (name) => {
      const buf = z.read(name);
      return buf ? buf.toString('utf8').replace(/^﻿/, '') : null;
    };
    const manifestVersion = () => (text('META-INF/MANIFEST.MF') || '').match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim() || null;

    const fabric = text('fabric.mod.json');
    if (fabric) {
      try {
        // Some mods put raw newlines inside strings; JSON.parse refuses those.
        const j = JSON.parse(fabric.replace(/\r?\n/g, ' '));
        info.kinds.push('fabric');
        info.mods.push({ id: String(j.id).toLowerCase(), name: j.name || j.id, version: j.version });
        info.provides.push(...(j.provides || []).map((p) => String(p).toLowerCase()));
        info.environment = j.environment || '*';
        for (const [id, range] of Object.entries(j.depends || {})) info.depends.push(dep(id, range, 'fabric'));
        for (const [id, range] of Object.entries(j.breaks || {})) info.breaks.push(dep(id, range, 'fabric'));
        for (const [id, range] of Object.entries(j.conflicts || {})) info.conflicts.push(dep(id, range, 'fabric'));
        for (const nested of j.jars || []) if (nested?.file) info.nested.push(nested.file);
      } catch {
        /* unreadable metadata: treat the jar as unknown */
      }
    }

    const quilt = text('quilt.mod.json');
    if (quilt) {
      try {
        const j = JSON.parse(quilt.replace(/\r?\n/g, ' '));
        const q = j.quilt_loader || {};
        info.kinds.push('quilt');
        if (!info.mods.length) info.mods.push({ id: String(q.id).toLowerCase(), name: q.metadata?.name || q.id, version: q.version });
        info.provides.push(...(q.provides || []).map((p) => String(p.id || p).toLowerCase()));
        if (j.minecraft?.environment === 'client') info.environment = 'client';
        if (!fabric) {
          for (const d of q.depends || []) {
            const o = typeof d === 'string' ? { id: d } : d;
            if (!o.optional && o.id) info.depends.push(dep(o.id, o.versions || '*', 'fabric'));
          }
          for (const d of q.breaks || []) {
            const o = typeof d === 'string' ? { id: d } : d;
            if (o.id) info.breaks.push(dep(o.id, o.versions || '*', 'fabric'));
          }
        }
        for (const nested of q.jars || []) info.nested.push(nested.file || nested);
      } catch {
        /* as above */
      }
    }

    for (const [file, defaultKind] of [
      ['META-INF/neoforge.mods.toml', 'neoforge'],
      ['META-INF/mods.toml', null],
    ]) {
      const raw = text(file);
      if (!raw) continue;
      const toml = parseModsToml(raw);
      const all = Object.values(toml.dependencies).flat();
      const kind = defaultKind || (all.some((d) => d.modId === 'neoforge') ? 'neoforge' : all.some((d) => d.modId === 'forge') ? 'forge' : 'forge-like');
      info.kinds.push(...(kind === 'forge-like' ? ['forge', 'neoforge'] : [kind]));
      for (const m of toml.mods) {
        let version = m.version;
        if (!version || String(version).includes('${')) version = manifestVersion();
        info.mods.push({ id: String(m.modId).toLowerCase(), name: m.displayName || m.modId, version });
      }
      for (const [owner, list] of Object.entries(toml.dependencies)) {
        if (!info.mods.some((m) => m.id === owner.toLowerCase())) continue;
        for (const d of list) {
          if (!d.modId || String(d.side || 'BOTH').toUpperCase() === 'CLIENT') continue;
          const type = String(d.type || (d.mandatory === false ? 'optional' : 'required')).toLowerCase();
          const entry = dep(d.modId, d.versionRange, 'maven', { owner: owner.toLowerCase() });
          if (type === 'required') info.depends.push(entry);
          else if (type === 'incompatible') info.breaks.push(entry);
          else if (type === 'discouraged') info.conflicts.push(entry);
        }
      }
      for (const name of z.names) if (/^META-INF\/jarjar\/[^/]+\.jar$/.test(name)) info.nested.push(name);
      break;
    }

    const plugin = text('plugin.yml');
    const paper = text('paper-plugin.yml');
    if (plugin || paper) {
      const y = parsePluginYml(paper || plugin);
      info.kinds.push(paper ? 'paper' : 'bukkit');
      info.mods.push({ id: String(y.name || '').toLowerCase(), name: y.name, version: y.version });
      info.apiVersion = y['api-version'] ? String(y['api-version']) : null;
      info.folia = String(y['folia-supported']) === 'true';
      const depends = paper ? paperDependencies(paper).filter((d) => d.required).map((d) => d.id) : [].concat(y.depend || []);
      for (const id of depends) info.depends.push(dep(id, '*', 'none'));
      if (paper && plugin) info.kinds.push('bukkit');
    }

    const velocity = text('velocity-plugin.json');
    if (velocity) {
      try {
        const j = JSON.parse(velocity);
        info.kinds.push('velocity');
        info.mods.push({ id: String(j.id).toLowerCase(), name: j.name || j.id, version: j.version });
        for (const d of j.dependencies || []) if (!d.optional) info.depends.push(dep(d.id, '*', 'none'));
      } catch {
        /* as above */
      }
    }
    const bungee = text('bungee.yml');
    if (bungee && !plugin) {
      const y = parsePluginYml(bungee);
      info.kinds.push('bungee');
      info.mods.push({ id: String(y.name || '').toLowerCase(), name: y.name, version: y.version });
      for (const id of [].concat(y.depends || y.depend || [])) info.depends.push(dep(id, '*', 'none'));
    }

    // Jars inside the jar (Fabric's jar-in-jar, Forge's jarjar) provide mods too.
    info.nested = info.nested
      .map((name) => {
        try {
          return z.read(name);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return info;
  } finally {
    z.close();
  }
}

/* ----------------------------------------------------------------- check -- */

/** Which kinds of jar a server's loader loads. */
function acceptedKinds(loader, gameVersion) {
  switch (loader) {
    case 'fabric':
      return ['fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    case 'forge':
      return ['forge'];
    case 'neoforge':
      return gameVersion === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    case 'paper':
    case 'purpur':
    case 'folia':
      return ['bukkit', 'paper'];
    case 'velocity':
      return ['velocity'];
    case 'bungeecord':
    case 'waterfall':
      return ['bungee'];
    default:
      return null;
  }
}

const LOADER_NAMES = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', bukkit: 'Bukkit/Paper', paper: 'Paper', velocity: 'Velocity', bungee: 'BungeeCord' };
// What every loader provides by itself.
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'forge', 'neoforge', 'javafml', 'mcp', 'velocity']);

/**
 * Check a server's mods folder.
 * @returns {{supported, loader, gameVersion, checked, issues: {severity, file, message}[], at}}
 */
function check(server, template) {
  const ctx = compat.modContext(server, template);
  const loader = ctx.loader;
  const accepted = ctx.game === 'minecraft' ? acceptedKinds(loader, ctx.gameVersion) : null;
  const base = { loader: ctx.loaderLabel || loader || null, gameVersion: ctx.gameVersion || null, at: Date.now() };
  if (!accepted) return { ...base, supported: false, checked: 0, issues: [] };

  const dir = require('../files').containedPath(server.dir, ctx.dir);
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.jar$/i.test(e.name)).map((e) => e.name);
  } catch {
    names = [];
  }

  const issues = [];
  const add = (severity, file, message) => issues.push({ severity, file, message });
  const jars = [];
  for (const file of names) {
    try {
      jars.push({ file, ...describeJar(path.join(dir, file)) });
    } catch (err) {
      add('error', file, `This is not a working jar file (${err.message}). Re-download it.`);
    }
  }

  // Everything installed, by id: top-level mods, what they provide and what they carry inside.
  const provided = new Map();
  const offer = (id, version, file, nested) => {
    if (!id) return;
    if (!provided.has(id)) provided.set(id, []);
    provided.get(id).push({ version, file, nested });
  };
  const addNested = (buffers, file, depth) => {
    for (const buf of buffers) {
      try {
        const inner = describeJar(buf);
        for (const m of inner.mods) offer(m.id, m.version, file, true);
        for (const p of inner.provides) offer(p, null, file, true);
        if (depth < 2) addNested(inner.nested, file, depth + 1);
      } catch {
        /* an unreadable library inside a mod is the mod's problem */
      }
    }
  };
  for (const jar of jars) {
    for (const m of jar.mods) offer(m.id, m.version, jar.file, false);
    for (const p of jar.provides) offer(p, null, jar.file, false);
    addNested(jar.nested, jar.file, 1);
  }
  // Sinytra Connector lets NeoForge run Fabric mods.
  const kinds = provided.has('connector') && loader === 'neoforge' ? [...accepted, 'fabric'] : accepted;
  const mc = ctx.gameVersion;
  const nameOf = (id) => {
    for (const j of jars) {
      const m = j.mods.find((x) => x.id === id);
      if (m) return m.name || id;
    }
    return id;
  };

  for (const jar of jars) {
    const label = jar.mods[0]?.name || jar.file;
    if (!jar.kinds.length) continue; // a library or something we cannot read: say nothing rather than guess
    if (!jar.kinds.some((k) => kinds.includes(k))) {
      const madeFor = [...new Set(jar.kinds.map((k) => LOADER_NAMES[k] || k))].join(' or ');
      add('error', jar.file, `${label} is made for ${madeFor}, and this server runs ${base.loader}. It will not load.`);
      continue;
    }
    if (jar.environment === 'client') add('error', jar.file, `${label} is a client-side mod. On a server it does nothing or stops it from starting.`);
    if (loader === 'folia' && jar.kinds.includes('bukkit') && !jar.folia) add('error', jar.file, `${label} does not say it supports Folia, so Folia will not load it.`);
    if (jar.apiVersion && mc) {
      const api = parseMc(jar.apiVersion);
      const ours = parseMc(mc);
      if (api && ours && compare({ nums: api.nums.slice(0, 2), pre: '' }, { nums: ours.nums.slice(0, 2), pre: '' }) > 0) {
        add('error', jar.file, `${label} needs Minecraft ${jar.apiVersion} or newer; this server runs ${mc}.`);
      }
    }
    for (const d of jar.depends) {
      if (d.id === 'minecraft') {
        const ok = !mc || (d.flavor === 'maven' ? mavenSatisfies(mc, d.range, parseMc) : fabricSatisfies(mc, d.range, parseMc));
        if (!ok) add('error', jar.file, `${label} is made for Minecraft ${prettyRange(d.range)}; this server runs ${mc}.`);
        continue;
      }
      if (BUILTIN.has(d.id)) continue;
      const have = provided.get(d.id);
      if (!have) {
        add('error', jar.file, `${label} needs ${d.id}, which is not installed.`);
        continue;
      }
      if (d.range && d.range !== '*') {
        const fits = have.some((h) => (d.flavor === 'maven' ? mavenSatisfies(h.version, d.range) : fabricSatisfies(h.version, d.range)));
        if (!fits) add('warning', jar.file, `${label} needs ${nameOf(d.id)} ${prettyRange(d.range)}; ${have.map((h) => h.version).filter(Boolean).join(' / ') || 'another version'} is installed.`);
      }
    }
    for (const [list, severity, verb] of [
      [jar.breaks, 'error', 'does not work together with'],
      [jar.conflicts, 'warning', 'can misbehave with'],
    ]) {
      for (const d of list) {
        const have = provided.get(d.id)?.filter((h) => h.file !== jar.file && (!d.range || d.range === '*' || (d.flavor === 'maven' ? mavenSatisfies(h.version, d.range) : fabricSatisfies(h.version, d.range))));
        if (have?.length) add(severity, jar.file, `${label} ${verb} ${nameOf(d.id)} (${have[0].file}). Remove one of them.`);
      }
    }
  }

  // The same mod twice: two top-level jars with one id.
  const owners = new Map();
  for (const jar of jars) for (const m of jar.mods) if (m.id) owners.set(m.id, new Set([...(owners.get(m.id) || []), jar.file]));
  for (const [id, files] of owners) {
    if (files.size > 1) add('error', [...files][0], `${nameOf(id)} is installed twice: ${[...files].join(' and ')}. Keep one.`);
  }

  issues.sort((a, b) => (a.severity === b.severity ? a.file.localeCompare(b.file) : a.severity === 'error' ? -1 : 1));
  return { ...base, supported: true, checked: jars.length, issues };
}

function prettyRange(range) {
  if (Array.isArray(range)) return range.join(' or ');
  return String(range || 'any version');
}

module.exports = { check, describeJar, fabricSatisfies, mavenSatisfies, parseVersion, parseModsToml, parsePluginYml, paperDependencies, acceptedKinds };
