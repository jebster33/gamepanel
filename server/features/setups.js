'use strict';

/**
 * Ready-made setups: a game plus what makes it a particular kind of server
 * (mods or plugins, a few game settings, schedules), deployed in one click.
 * The curated ones live in setups/ in the repository; the panel's data folder
 * can hold more (data/setups/*.json) in the same format:
 *
 *   { id, name, templateId, description, tags, memory, vars,
 *     mods: [{ provider, projectId }], gameSettings: { key: value },
 *     schedules: [{ name, action, cron, ... }] }
 *
 * The server is created and installed as usual; once the install finishes,
 * the rest is applied and shown in its console.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../core/config');
const { fail, logger } = require('../core/util');

const DIRS = [path.join(config.rootDir, 'setups'), path.join(config.dataDir, 'setups')];

function load() {
  const out = new Map();
  for (const dir of DIRS) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const setup = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (setup.id && setup.templateId && setup.name) out.set(setup.id, setup);
      } catch (err) {
        logger.warn(`Setup ${file} could not be read: ${err.message}`);
      }
    }
  }
  return [...out.values()];
}

/** What the Games page shows: only setups whose game this panel has. */
function list(templates) {
  return load()
    .map((s) => {
      const t = templates.get(s.templateId);
      if (!t) return null;
      return {
        id: s.id,
        name: s.name,
        description: s.description || '',
        tags: s.tags || [],
        templateId: s.templateId,
        templateName: t.name,
        icon: t.icon,
        logo: t.logo || null,
        storeAppId: t.storeAppId || null,
        memory: s.memory || t.defaultMemory || 2048,
        adminOnly: Boolean(t.adminOnly),
        includes: [
          ...(s.mods?.length ? [`${s.mods.length} ${s.templateId.startsWith('minecraft') ? 'plugins or mods' : 'plugins'}`] : []),
          ...(s.gameSettings ? [`${Object.keys(s.gameSettings).length} game setting${Object.keys(s.gameSettings).length === 1 ? '' : 's'}`] : []),
          ...(s.schedules?.length ? [`${s.schedules.length} schedule${s.schedules.length === 1 ? '' : 's'}`] : []),
        ],
      };
    })
    .filter(Boolean);
}

function get(id) {
  const setup = load().find((s) => s.id === id);
  if (!setup) fail(404, 'No such setup');
  return setup;
}

/** The body for creating the server, before the extras. */
function serverInput(setup, { name, memory } = {}) {
  return {
    templateId: setup.templateId,
    name: String(name || setup.name).trim().slice(0, 60),
    memory: Number(memory) || setup.memory,
    vars: { ...(setup.vars || {}) },
  };
}

/** Remember what to add once the install is done. */
function attach(store, server, setup) {
  server.setup = { id: setup.id, name: setup.name, pending: { mods: setup.mods || [], gameSettings: setup.gameSettings || null, schedules: setup.schedules || [] } };
  store.save();
}

/** Mods, game settings and schedules, after the game itself is installed. */
async function apply({ manager, store, scheduler }, server) {
  const pending = server.setup?.pending;
  if (!pending) return;
  server.setup.pending = null;
  store.save();
  const say = (line) => manager.pushConsole(server, `Setup "${server.setup.name}": ${line}`, 'system');
  const problems = [];
  const template = manager.template(server);
  const integrations = store.state.settings.integrations || {};
  const mods = require('./mods');
  for (const mod of pending.mods) {
    try {
      const result = await mods.install(server, template, { provider: mod.provider, projectId: mod.projectId, liveVersion: manager.rt(server.id).version }, integrations);
      say(`installed ${result.installed.map((i) => i.name).join(', ')}`);
    } catch (err) {
      problems.push(`${mod.projectId}: ${err.message}`);
      say(`could not install ${mod.projectId}: ${err.message}`);
    }
  }
  if (pending.gameSettings) {
    try {
      require('../games/settings').writeGameSettings(manager, server, pending.gameSettings, `setup: ${server.setup.name}`);
      say(`set ${Object.keys(pending.gameSettings).join(', ')}`);
    } catch (err) {
      problems.push(`game settings: ${err.message}`);
      say(`could not change game settings: ${err.message}`);
    }
  }
  for (const schedule of pending.schedules) {
    try {
      scheduler.add(server, schedule);
      say(`scheduled "${schedule.name}"`);
    } catch (err) {
      problems.push(`schedule ${schedule.name}: ${err.message}`);
    }
  }
  store.addEvent(
    problems.length ? 'server.setup_incomplete' : 'server.setup_applied',
    problems.length ? `${server.name}: the ${server.setup.name} setup is installed, but ${problems.length} part(s) failed. See the console.` : `${server.name} is ready as a ${server.setup.name}`,
    { serverId: server.id }
  );
}

/** Apply setups when their server's install finishes. */
function start(app) {
  app.store.on('event', (event) => {
    if (event.type !== 'server.installed') return;
    const server = app.manager.find(event.serverId);
    if (server?.setup?.pending) apply(app, server).catch((err) => logger.warn(`Setup for ${server.name} failed: ${err.message}`));
  });
}

module.exports = { list, get, serverInput, attach, apply, start, load };
