'use strict';

/**
 * Template registry. Built-in templates ship in ./templates; anything dropped
 * into <data>/templates is picked up too, so users can add their own games
 * without touching the panel source.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { logger, fail } = require('./util');

const REQUIRED = ['id', 'name', 'startCommand'];

class TemplateRegistry {
  constructor() {
    this.templates = new Map();
    this.userDir = path.join(config.dataDir, 'templates');
    this.load();
  }

  load() {
    this.templates.clear();
    for (const dir of [config.templatesDir, this.userDir]) {
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue; // directory may not exist yet
      }
      for (const file of files) {
        const full = path.join(dir, file);
        try {
          const tpl = JSON.parse(fs.readFileSync(full, 'utf8'));
          const missing = REQUIRED.filter((k) => !tpl[k]);
          if (missing.length) {
            logger.warn(`Template ${file} is missing: ${missing.join(', ')} — skipped`);
            continue;
          }
          tpl.custom = dir === this.userDir;
          tpl.variables = tpl.variables || [];
          tpl.ports = tpl.ports && tpl.ports.length ? tpl.ports : [{ name: 'game', default: 27015, protocol: 'tcp' }];
          tpl.install = tpl.install || [];
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
    return [...this.templates.values()].sort((a, b) => {
      const cat = String(a.category || '').localeCompare(String(b.category || ''));
      return cat !== 0 ? cat : a.name.localeCompare(b.name);
    });
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
    const missing = REQUIRED.filter((k) => !tpl[k]);
    if (missing.length) fail(400, `Template is missing required fields: ${missing.join(', ')}`);
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(tpl.id)) fail(400, 'Template id must be lowercase letters, numbers and dashes');
    const builtin = this.get(tpl.id);
    if (builtin && !builtin.custom) fail(409, 'A built-in template already uses that id');
    fs.mkdirSync(this.userDir, { recursive: true });
    fs.writeFileSync(path.join(this.userDir, `${tpl.id}.json`), JSON.stringify(tpl, null, 2));
    this.load();
    return this.get(tpl.id);
  }

  deleteCustom(id) {
    const tpl = this.get(id);
    if (!tpl) fail(404, 'Template not found');
    if (!tpl.custom) fail(400, 'Built-in templates cannot be deleted');
    fs.unlinkSync(path.join(this.userDir, `${id}.json`));
    this.load();
  }
}

module.exports = { TemplateRegistry };
