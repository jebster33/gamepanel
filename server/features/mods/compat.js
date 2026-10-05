'use strict';

/**
 * Which mods fit a server.
 *
 * A Minecraft server can only load content built for its own platform and
 * game version: a Fabric server cannot run Forge mods, Paper runs Bukkit and
 * Spigot plugins but not mods, vanilla only takes datapacks. This file turns a
 * server into a "context" that every provider filters on, so the browser only
 * ever lists things that will actually load.
 */

const fs = require('fs');
const { interpolate, safeJoin } = require('../../core/util');

/**
 * Per Minecraft platform:
 *   modrinth    loaders a Modrinth release may list (any one is enough)
 *   projectType Modrinth project type to browse
 *   cfClass     CurseForge class (6 mods, 5 Bukkit plugins, 6945 datapacks)
 *   cfLoaders   CurseForge mod loader ids and the names its files are tagged with
 */
const MINECRAFT = {
  paper: { label: 'Paper', modrinth: ['paper', 'spigot', 'bukkit'], projectType: 'plugin', cfClass: 5, cfLoaders: [] },
  purpur: { label: 'Purpur', modrinth: ['purpur', 'paper', 'spigot', 'bukkit'], projectType: 'plugin', cfClass: 5, cfLoaders: [] },
  folia: { label: 'Folia', modrinth: ['folia'], projectType: 'plugin', cfClass: 5, cfLoaders: [] },
  fabric: { label: 'Fabric', modrinth: ['fabric'], projectType: 'mod', cfClass: 6, cfLoaders: [[4, 'Fabric']] },
  // Quilt loads almost every Fabric mod.
  quilt: { label: 'Quilt', modrinth: ['quilt', 'fabric'], projectType: 'mod', cfClass: 6, cfLoaders: [[5, 'Quilt'], [4, 'Fabric']] },
  forge: { label: 'Forge', modrinth: ['forge'], projectType: 'mod', cfClass: 6, cfLoaders: [[1, 'Forge']] },
  neoforge: { label: 'NeoForge', modrinth: ['neoforge'], projectType: 'mod', cfClass: 6, cfLoaders: [[6, 'NeoForge']] },
  vanilla: { label: 'Vanilla', modrinth: ['datapack'], projectType: 'datapack', cfClass: 6945, cfLoaders: [] },
};

/** NeoForge on 1.20.1 is a fork of Forge and still loads Forge mods. */
function minecraftLoaders(loader, gameVersion) {
  const spec = MINECRAFT[loader];
  if (!spec) return null;
  if (loader === 'neoforge' && gameVersion === '1.20.1') {
    return { ...spec, modrinth: ['neoforge', 'forge'], cfLoaders: [[6, 'NeoForge'], [1, 'Forge']] };
  }
  return spec;
}

const VERSION_RE = /\b(\d+\.\d+(?:\.\d+)?)\b/;

function cleanVersion(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'latest') return null;
  return text.match(VERSION_RE)?.[1] || null;
}

/** Read a version string out of a file the game ships (e.g. Factorio's data/base/info.json). */
function versionFromFile(server, spec) {
  if (!spec?.path) return null;
  try {
    const raw = fs.readFileSync(safeJoin(server.dir, spec.path), 'utf8');
    if (spec.key) return cleanVersion(JSON.parse(raw)[spec.key]);
    return cleanVersion(raw);
  } catch {
    return null;
  }
}

/**
 * Everything a provider needs to filter for this server.
 * @returns {{game, loader, loaderLabel, gameVersion, modrinthLoaders, projectType, cfClass, cfLoaders, dir, appId, umodGame, workshop}}
 */
function modContext(server, template, liveVersion) {
  const spec = template?.mods || {};
  const vars = server.vars || {};
  const fill = (value) => (value ? interpolate(String(value), vars) : undefined);

  // The loader: what the installer actually set up beats what the template says.
  let loader = server.loader || server.pack?.loader?.split(' ')[0] || (spec.loaderVar ? vars[spec.loaderVar] : fill(spec.loader));
  loader = loader ? String(loader).toLowerCase() : undefined;

  // The game version: what was installed, else the chosen one, else what the server reports.
  const gameVersion =
    cleanVersion(server.gameVersion) ||
    cleanVersion(server.pack?.mcVersion) ||
    cleanVersion(spec.gameVersionVar ? vars[spec.gameVersionVar] : fill(spec.gameVersion)) ||
    versionFromFile(server, spec.versionFile) ||
    cleanVersion(server.resolvedVersion) ||
    cleanVersion(liveVersion) ||
    undefined;

  const game = spec.game || (template?.category === 'Minecraft' ? 'minecraft' : template?.id);
  const mc = game === 'minecraft' ? minecraftLoaders(loader || 'vanilla', gameVersion) : null;

  return {
    game,
    loader: loader || (mc ? 'vanilla' : undefined),
    loaderLabel: mc?.label || loader || null,
    gameVersion,
    modrinthLoaders: mc?.modrinth || (loader ? [loader] : []),
    projectType: spec.projectType || mc?.projectType || 'mod',
    cfClass: spec.cfClass || mc?.cfClass || 6,
    cfLoaders: mc?.cfLoaders || [],
    dir: modDir(server, template),
    appId: spec.appId ? String(spec.appId) : undefined,
    umodGame: spec.umodGame || spec.game || template?.id,
    workshop: spec.workshop || null,
    modpack: Boolean(template?.modpacks),
  };
}

/** Where a template keeps its mods, e.g. "plugins" or "oxide/plugins". */
function modDir(server, template) {
  return interpolate(template?.mods?.dir || 'mods', { ...(server.vars || {}), SERVER_DIR: server.dir }).replace(/\\/g, '/');
}

/** Modrinth/CurseForge version strings that count as the same release line. */
function sameMinor(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  return pa[0] === pb[0] && pa[1] === pb[1];
}

/** Human description of the filter, shown above search results. */
function describe(ctx) {
  const parts = [];
  if (ctx.loaderLabel) parts.push(ctx.loaderLabel);
  if (ctx.gameVersion) parts.push(ctx.gameVersion);
  return parts.join(' ');
}

module.exports = { MINECRAFT, modContext, modDir, minecraftLoaders, cleanVersion, sameMinor, describe };
