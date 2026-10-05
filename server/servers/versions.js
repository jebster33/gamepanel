'use strict';

/**
 * Switching game version (and, for Minecraft Java, server type: Vanilla,
 * Paper, Purpur, Fabric, Forge, NeoForge, Quilt) with a backup first.
 * Mixed into ServerManager (see manager.js), so `this` is the manager.
 */

const { fail, logger } = require('../core/util');
const { variant } = require('../games/templates');
const { STATUS } = require('./constants');

// Minecraft Java server types that share world folders and ports, so one can
// be swapped for another in place.
const MC_JAVA = ['minecraft-vanilla', 'minecraft-paper', 'minecraft-purpur', 'minecraft-fabric', 'minecraft-quilt', 'minecraft-forge', 'minecraft-neoforge'];

// Variables that pick which build is downloaded.
const isVersionVar = (def) => def.source && /VERSION|BUILD|LOADER|CHANNEL/.test(def.name) && !/modpack/.test(def.source);

const describe = (tpl) =>
  (tpl.variables || []).filter(isVersionVar).map((v) => ({ name: v.name, label: v.label || v.name, source: v.source, default: v.default, description: v.description || '' }));

module.exports = {
  /** What can be switched on this server: its version fields and, for Minecraft Java, other server types. */
  versionInfo(server) {
    const template = this.template(server);
    if (!template) return { supported: false };
    const fields = describe(template);
    const types = MC_JAVA.includes(template.id)
      ? MC_JAVA.map((id) => this.templates.get(id))
          .filter(Boolean)
          .map((t) => ({ id: t.id, name: t.name.replace(/^Minecraft:\s*/, ''), icon: t.icon, fields: describe(t), mods: t.mods?.dir || null }))
      : [];
    return {
      supported: fields.length > 0 || types.length > 0,
      templateId: template.id,
      current: Object.fromEntries(fields.map((f) => [f.name, server.vars?.[f.name] ?? f.default])),
      resolved: server.resolvedVersion || null,
      gameVersion: this.gameVersion(server),
      fields,
      types,
      history: (server.versionHistory || []).slice(-10).reverse(),
    };
  },

  /**
   * Back up, change the version variables (and maybe the server type), then
   * run the install steps again so the new build is downloaded. Worlds,
   * configs and mods stay where they are.
   */
  async switchVersion(id, { templateId, vars = {}, backup = true, stopFirst = false } = {}, actor = null) {
    const server = this.require(id);
    const current = this.template(server);
    if (!current) fail(400, 'The template this server was created from is no longer available');
    if (this.isActive(id)) {
      if (!stopFirst) fail(409, 'Stop the server before switching version');
      this.pushConsole(server, 'Stopping the server to switch version…', 'system');
      await this.stop(id).catch(() => {});
      const deadline = Date.now() + 120_000;
      while (this.isActive(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
      if (this.isActive(id)) fail(409, 'The server did not stop, so nothing was changed');
    }
    if (this.rt(id).status === STATUS.INSTALLING) fail(409, 'An install is already running');

    let target = current;
    if (templateId && templateId !== current.id) {
      if (!MC_JAVA.includes(current.id) || !MC_JAVA.includes(templateId)) fail(400, 'This server cannot change to that type');
      const base = this.templates.get(templateId);
      if (!base) fail(404, 'That server type is not available');
      if (!(base.platforms || ['linux']).includes(server.platform || 'linux')) fail(400, `${base.name} does not run on this platform`);
      target = variant(base, server.platform || 'linux');
    }

    const allowed = new Map(describe(target).map((f) => [f.name, f]));
    const picked = {};
    for (const [key, value] of Object.entries(vars || {})) {
      if (!allowed.has(key)) fail(400, `${key} is not a version setting`);
      const text = String(value ?? '').trim();
      if (!/^[A-Za-z0-9._+\-]{1,64}$/.test(text)) fail(400, `Pick a valid ${allowed.get(key).label.toLowerCase()}`);
      picked[key] = text;
    }

    const before = {
      at: Date.now(),
      by: actor?.username || 'system',
      templateId: current.id,
      vars: Object.fromEntries(describe(current).map((f) => [f.name, server.vars?.[f.name] ?? f.default])),
      version: server.resolvedVersion || server.gameVersion || null,
    };

    if (backup) {
      this.setTask(server, 'Backing up');
      this.pushConsole(server, 'Backing up before switching version…', 'system');
      try {
        const made = await require('../features/backups').create(server, 'before-version-switch');
        before.backup = made.name;
        this.pushConsole(server, `Backup saved: ${made.name}`, 'system');
      } catch (err) {
        this.setTask(server, null);
        fail(500, `The backup failed, so nothing was changed: ${err.message}`);
      }
      this.setTask(server, null);
    }

    if (target !== current) {
      // Carry over everything both types understand (MOTD, max players, RCON…).
      const keep = Object.fromEntries(Object.entries(server.vars || {}).filter(([k]) => (target.variables || []).some((v) => v.name === k) && !allowed.has(k)));
      server.templateId = target.id;
      server.vars = this.resolveVars(target, { ...keep, ...picked });
      for (const def of target.ports || []) {
        if (server.ports[def.name] == null) server.ports[def.name] = this.allocatePort(def.default, this.usedPorts());
      }
    } else {
      server.vars = { ...server.vars, ...picked };
    }
    delete server.vars.JAVA_VERSION; // looked up again for the new version
    delete server.resolvedVersion;
    delete server.gameVersion;
    server.versionHistory = [...(server.versionHistory || []), before].slice(-20);
    this.store.save();

    const label = target !== current ? `${target.name}` : current.name;
    this.store.addEvent('server.version', `${actor?.username || 'Someone'} switched ${server.name} to ${label} ${Object.values(picked).join(' ')}`.trim(), { serverId: id });
    this.logActivity?.(id, { type: 'version', text: `${label} ${Object.values(picked).join(' ')}`.trim(), by: actor?.username });
    this.install(id).catch((err) => logger.error('Version switch install failed:', err.message));
    return { ok: true, backup: before.backup || null };
  },
};
