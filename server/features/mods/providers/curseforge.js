'use strict';

/**
 * CurseForge: Minecraft mods, Bukkit plugins and datapacks.
 * Needs a free API key from console.curseforge.com (Settings → Integrations).
 */

const { fail } = require('../../../core/util');
const { getJson } = require('../http');
const { sameMinor } = require('../compat');

const API = 'https://api.curseforge.com/v1';
const MINECRAFT = 432;
// releaseType: 1 release, 2 beta, 3 alpha. relationType: 2 optional, 3 required, 5 incompatible.
const CHANNEL = { 1: 'release', 2: 'beta', 3: 'alpha' };
const RELATION = { 1: 'embedded', 2: 'optional', 3: 'required', 4: 'tool', 5: 'incompatible', 6: 'include' };
const CHANNEL_RANK = { release: 0, beta: 1, alpha: 2 };
const LOADER_NAMES = ['forge', 'fabric', 'quilt', 'neoforge'];

function headers(apiKey) {
  if (!apiKey) fail(400, 'Add a CurseForge API key in Settings → Integrations to use CurseForge. It is free at console.curseforge.com.');
  return { 'x-api-key': apiKey };
}

function normalizeFile(f) {
  const tags = f.gameVersions || [];
  return {
    id: String(f.id),
    projectId: String(f.modId),
    name: f.displayName,
    version: f.displayName,
    channel: CHANNEL[f.releaseType] || 'release',
    gameVersions: tags.filter((t) => /^\d/.test(t)),
    loaders: tags.filter((t) => LOADER_NAMES.includes(t.toLowerCase())).map((t) => t.toLowerCase()),
    published: f.fileDate,
    downloads: f.downloadCount,
    serverPack: Boolean(f.isServerPack),
    file: { url: f.downloadUrl || null, filename: f.fileName, size: f.fileLength, sha1: f.hashes?.find((h) => h.algo === 1)?.value },
    dependencies: (f.dependencies || []).map((d) => ({ projectId: String(d.modId), versionId: null, type: RELATION[d.relationType] || 'optional' })),
  };
}

const curseforge = {
  id: 'curseforge',
  label: 'CurseForge',
  needsKey: true,
  site: 'https://www.curseforge.com',

  fits(file, ctx) {
    if (!file || file.serverPack) return false;
    const wanted = (ctx.cfLoaders || []).map(([, name]) => name.toLowerCase());
    // Files that name no loader at all are usually loader-neutral (plugins, datapacks).
    if (wanted.length && !file.loaders.some((l) => wanted.includes(l))) return false;
    if (ctx.gameVersion && file.gameVersions.length) {
      // Bukkit plugins are tagged loosely ("1.21"), mods exactly ("1.21.4").
      const ok = ctx.cfClass === 5 ? file.gameVersions.some((v) => sameMinor(v, ctx.gameVersion)) : file.gameVersions.includes(ctx.gameVersion);
      if (!ok) return false;
    }
    return true;
  },

  async search({ query = '', page = 0, limit = 24, ctx, apiKey }) {
    const params = new URLSearchParams({
      gameId: String(MINECRAFT),
      classId: String(ctx.cfClass || 6),
      searchFilter: query,
      pageSize: String(limit),
      index: String(page * limit),
      sortField: query ? '2' : '6',
      sortOrder: 'desc',
    });
    const loader = ctx.cfLoaders?.[0]?.[0];
    if (loader) params.set('modLoaderType', String(loader));
    if (ctx.gameVersion && ctx.cfClass !== 5) params.set('gameVersion', ctx.gameVersion);
    const data = await getJson(`${API}/mods/search?${params}`, headers(apiKey));
    return {
      total: Math.min(data.pagination?.totalCount ?? data.data.length, 10000),
      items: data.data.map((mod) => ({
        provider: 'curseforge',
        id: String(mod.id),
        slug: mod.slug,
        name: mod.name,
        author: mod.authors?.[0]?.name || '',
        description: mod.summary,
        downloads: mod.downloadCount,
        icon: mod.logo?.thumbnailUrl || null,
        url: mod.links?.websiteUrl,
        categories: (mod.categories || []).map((c) => c.name).slice(0, 4),
        updated: mod.dateModified,
      })),
    };
  },

  async project(id, { apiKey } = {}) {
    const { data: mod } = await getJson(`${API}/mods/${encodeURIComponent(id)}`, headers(apiKey));
    return {
      id: String(mod.id),
      slug: mod.slug,
      name: mod.name,
      icon: mod.logo?.thumbnailUrl || null,
      url: mod.links?.websiteUrl,
      serverSupported: true,
    };
  },

  async version(versionId, { projectId, apiKey } = {}) {
    const { data } = await getJson(`${API}/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(versionId)}`, headers(apiKey));
    return normalizeFile(data);
  },

  async versions({ projectId, ctx, apiKey }) {
    const loaderIds = (ctx.cfLoaders || []).map(([id]) => id);
    const queries = loaderIds.length ? loaderIds : [null];
    const seen = new Map();
    for (const loader of queries) {
      const params = new URLSearchParams({ pageSize: '50' });
      if (loader) params.set('modLoaderType', String(loader));
      if (ctx.gameVersion && ctx.cfClass !== 5) params.set('gameVersion', ctx.gameVersion);
      const { data } = await getJson(`${API}/mods/${encodeURIComponent(projectId)}/files?${params}`, headers(apiKey));
      for (const f of data) seen.set(String(f.id), normalizeFile(f));
    }
    return [...seen.values()]
      .filter((f) => curseforge.fits(f, ctx))
      .sort((a, b) => CHANNEL_RANK[a.channel] - CHANNEL_RANK[b.channel] || String(b.published).localeCompare(String(a.published)));
  },

  async best(args) {
    return (await curseforge.versions(args))[0] || null;
  },

  downloadError(name) {
    return `The author of ${name} has turned off downloads from other apps. Download it from CurseForge and upload it with the file manager.`;
  },
};

module.exports = curseforge;
