'use strict';

/**
 * Game templates.
 *
 * Built-in templates ship in ./templates; anything dropped into
 * <data>/templates is picked up too, so people can add games without touching
 * the panel source.
 *
 * A template describes one game for one or more platforms:
 *
 *   "platforms": ["linux", "windows"]      where it can run (default: linux)
 *   "windows":   { "startCommand": … }     anything that differs on Windows
 *   "linux":     { … }                     anything that differs on Linux
 *
 * The top level is the shared description; the per-platform block only lists
 * what changes. variant() merges the two into what a server actually runs.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { logger, fail } = require('../core/util');

const REQUIRED = ['id', 'name'];
const PLATFORMS = ['linux', 'windows'];

/** Fields a platform block may override wholesale. */
const OVERRIDABLE = [
  'install',
  'update',
  'startCommand',
  'stopCommand',
  'stopSignal',
  'stopTimeout',
  'configFiles',
  'patchProperties',
  'logPatterns',
  'resolve',
  'image',
  'packages',
  'env',
  'query',
  'rcon',
  'sidecars',
  'notes',
  'consoleInput',
  'consoleNewline',
  'stopRconCommand',
  'tailFiles',
  'readyOnPort',
  'joinNote',
  'defaultMemory',
  'container',
];

function platformsOf(tpl) {
  const list = Array.isArray(tpl.platforms) && tpl.platforms.length ? tpl.platforms : ['linux'];
  return list.filter((p) => PLATFORMS.includes(p));
}

/** The template as it runs on one platform. */
function variant(tpl, platform) {
  if (!tpl) return null;
  const block = tpl[platform];
  if (!block || typeof block !== 'object') return { ...tpl, platform };
  const merged = { ...tpl, platform };
  for (const key of OVERRIDABLE) if (block[key] !== undefined) merged[key] = block[key];
  if (block.mods) merged.mods = { ...(tpl.mods || {}), ...block.mods };
  if (block.variables) {
    // Platform blocks can add variables or adjust a default.
    const byName = new Map((tpl.variables || []).map((v) => [v.name, v]));
    for (const v of block.variables) byName.set(v.name, { ...(byName.get(v.name) || {}), ...v });
    merged.variables = [...byName.values()];
  }
  return merged;
}

class TemplateRegistry {
  constructor() {
    this.templates = new Map();
    this.load();
  }

  load() {
    this.templates.clear();
    for (const dir of [config.templatesDir, config.userTemplatesDir]) {
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue; // the user directory may not exist yet
      }
      for (const file of files) {
        try {
          const tpl = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          const missing = REQUIRED.filter((k) => !tpl[k]);
          if (!tpl.startCommand && !PLATFORMS.some((p) => tpl[p]?.startCommand)) missing.push('startCommand');
          if (missing.length) {
            logger.warn(`Template ${file} is missing: ${missing.join(', ')} — skipped`);
            continue;
          }
          tpl.custom = dir === config.userTemplatesDir;
          tpl.variables = tpl.variables || [];
          tpl.ports = tpl.ports?.length ? tpl.ports : [{ name: 'game', default: 27015, protocol: 'tcp' }];
          tpl.install = tpl.install || [];
          tpl.platforms = platformsOf(tpl);
          this.templates.set(tpl.id, tpl);
        } catch (err) {
          logger.warn(`Template ${file} could not be parsed: ${err.message}`);
        }
      }
    }
    logger.info(`Loaded ${this.templates.size} templates`);
    return this.templates.size;
  }

  list() {
    return [...this.templates.values()].sort(
      (a, b) => String(a.category || '').localeCompare(String(b.category || '')) || a.name.localeCompare(b.name)
    );
  }

  get(id) {
    return this.templates.get(id) || null;
  }

  require(id) {
    const tpl = this.get(id);
    if (!tpl) fail(404, `Unknown template: ${id}`);
    return tpl;
  }

  categories() {
    const seen = new Map();
    for (const tpl of this.templates.values()) {
      const cat = tpl.category || 'Other';
      seen.set(cat, (seen.get(cat) || 0) + 1);
    }
    return [...seen.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Persist a user-supplied template into the writable templates directory. */
  saveCustom(tpl) {
    if (!tpl?.id || !tpl.name) fail(400, 'A template needs at least an id, a name and a startCommand');
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(tpl.id)) fail(400, 'Template id must be lowercase letters, numbers and dashes');
    const existing = this.get(tpl.id);
    if (existing && !existing.custom) fail(409, 'A built-in template already uses that id');
    fs.mkdirSync(config.userTemplatesDir, { recursive: true });
    fs.writeFileSync(path.join(config.userTemplatesDir, `${tpl.id}.json`), JSON.stringify(tpl, null, 2));
    this.load();
    return this.get(tpl.id);
  }

  deleteCustom(id) {
    const tpl = this.get(id);
    if (!tpl) fail(404, 'Template not found');
    if (!tpl.custom) fail(400, 'Built-in templates cannot be deleted');
    fs.unlinkSync(path.join(config.userTemplatesDir, `${id}.json`));
    this.load();
  }
}

module.exports = { TemplateRegistry, variant, platformsOf, PLATFORMS, OVERRIDABLE };
