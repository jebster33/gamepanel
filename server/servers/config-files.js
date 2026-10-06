'use strict';

/**
 * Game config files: written once on install, and selectively patched before
 * every start so the panel's ports and settings always reach the game
 * without overwriting anything the user edited by hand.
 * Mixed into ServerManager (see manager.js).
 */

const fs = require('fs');
const path = require('path');
const { logger, interpolate } = require('../core/util');
const { containedPath } = require('../features/files');

/** Coerce "25" → 25 and "true" → true for JSON configs. */
function typed(raw) {
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/** key=value files (server.properties) and [section] key=value files (ini). */
function patchKeyValue(existing, values, { section } = {}) {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(values));
  let current = null;
  let sectionEnd = -1;
  const out = lines.map((line, i) => {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1];
      return line;
    }
    if (section && current !== section) return line;
    if (section) sectionEnd = i;
    const m = line.match(/^(\s*)([A-Za-z0-9_.\-]+)(\s*=\s*)(.*)$/);
    if (!m || !remaining.has(m[2])) return line;
    const value = remaining.get(m[2]);
    remaining.delete(m[2]);
    return `${m[1]}${m[2]}${m[3]}${value}`;
  });

  const extra = [...remaining].map(([k, v]) => `${k}=${v}`);
  if (!extra.length) return out.join('\n');
  if (!section) return [...out, ...extra].join('\n').replace(/\n{3,}/g, '\n\n');
  if (sectionEnd === -1 && !out.some((l) => l.trim() === `[${section}]`)) {
    return [...out, '', `[${section}]`, ...extra].join('\n').replace(/^\n+/, '');
  }
  // Insert the missing keys at the end of their section.
  const at = sectionEnd === -1 ? out.findIndex((l) => l.trim() === `[${section}]`) + 1 : sectionEnd + 1;
  out.splice(at, 0, ...extra);
  return out.join('\n');
}

module.exports = {
  /** Write template config files (only creating missing ones unless told otherwise). */
  writeConfigFiles(server, template, { overwrite = false } = {}) {
    const vars = this.vars(server);
    for (const file of template.configFiles || []) {
      let target;
      try {
        target = containedPath(server.dir, interpolate(file.path, vars));
      } catch {
        continue;
      }
      if (fs.existsSync(target) && (file.mode || 'create') !== 'overwrite' && !overwrite) continue;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, interpolate(file.content || '', vars));
      } catch (err) {
        logger.warn(`Could not write ${file.path}: ${err.message}`);
      }
    }
  },

  /**
   * Re-apply the panel-owned keys (ports, passwords, slots) before each boot.
   * Formats: properties, ini (with optional "section"), json (dotted keys).
 * A missing file is skipped unless `createIfMissing` or a `seedFrom` file exists.
   */
  applyPropertyPatches(server, template) {
    const vars = this.vars(server);
    for (const patch of template.patchProperties || []) {
      let target;
      try {
        target = containedPath(server.dir, interpolate(patch.path, vars));
      } catch {
        continue;
      }
      let existing = '';
      try {
        existing = fs.readFileSync(target, 'utf8');
      } catch {
        // `seedFrom`: start from the game's shipped default (Eco's Network.eco.template).
        try {
          if (patch.seedFrom) existing = fs.readFileSync(containedPath(server.dir, interpolate(patch.seedFrom, vars)), 'utf8');
        } catch {
          existing = '';
        }
        if (!existing && !patch.createIfMissing) continue;
      }
      const values = {};
      for (const [k, v] of Object.entries(patch.set || {})) values[k] = interpolate(String(v), vars);

      try {
        let next;
        if ((patch.format || 'properties') === 'json') {
          const obj = existing.trim() ? JSON.parse(existing) : {};
          for (const [key, raw] of Object.entries(values)) {
            const parts = key.split('.');
            let node = obj;
            while (parts.length > 1) {
              const part = parts.shift();
              node[part] = node[part] && typeof node[part] === 'object' ? node[part] : {};
              node = node[part];
            }
            node[parts[0]] = typed(raw);
          }
          next = JSON.stringify(obj, null, 2);
        } else {
          next = patchKeyValue(existing, values, { section: patch.section });
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, next);
      } catch (err) {
        logger.warn(`Could not patch ${patch.path}: ${err.message}`);
      }
    }
  },
};

module.exports.patchKeyValue = patchKeyValue;
