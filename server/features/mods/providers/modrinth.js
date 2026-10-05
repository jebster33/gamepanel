'use strict';

/** Modrinth: Minecraft mods, plugins, datapacks and modpacks. No key needed. */

const { getJson, postJson } = require('../http');

const API = 'https://api.modrinth.com/v2';
const CHANNEL_RANK = { release: 0, beta: 1, alpha: 2 };

const projectCache = new Map();

function normalizeVersion(v) {
  const file = v.files?.find((f) => f.primary) || v.files?.[0] || null;
  return {
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    version: v.version_number,
    channel: v.version_type || 'release',
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
    published: v.date_published,
    downloads: v.downloads,
    file: file ? { url: file.url, filename: file.filename, size: file.size, sha1: file.hashes?.sha1, sha512: file.hashes?.sha512 } : null,
    dependencies: (v.dependencies || []).map((d) => ({
      projectId: d.project_id || null,
      versionId: d.version_id || null,
      type: d.dependency_type, // required | optional | incompatible | embedded
    })),
  };
}

function sortBest(list) {
  return list.sort(
    (a, b) => (CHANNEL_RANK[a.channel] ?? 3) - (CHANNEL_RANK[b.channel] ?? 3) || String(b.published).localeCompare(String(a.published))
  );
}

const modrinth = {
  id: 'modrinth',
  label: 'Modrinth',
  needsKey: false,
  site: 'https://modrinth.com',

  /** Would this release load on the server? */
  fits(version, ctx) {
    if (!version?.file) return false;
    if (ctx.modrinthLoaders?.length && !version.loaders.some((l) => ctx.modrinthLoaders.includes(l))) return false;
    if (ctx.gameVersion && !version.gameVersions.includes(ctx.gameVersion)) return false;
    return true;
  },

  async search({ query = '', page = 0, limit = 24, ctx, projectType }) {
    const type = projectType || ctx.projectType;
    const facets = [[`project_type:${type}`]];
    if (type !== 'modpack') {
      if (ctx.modrinthLoaders?.length) facets.push(ctx.modrinthLoaders.map((l) => `categories:${l}`));
      if (ctx.gameVersion) facets.push([`versions:${ctx.gameVersion}`]);
      // Client-only mods never load on a dedicated server.
      facets.push(['server_side!=unsupported']);
    }
    const params = new URLSearchParams({
      query,
      limit: String(limit),
      offset: String(page * limit),
      index: query ? 'relevance' : 'downloads',
      facets: JSON.stringify(facets),
    });
    const data = await getJson(`${API}/search?${params}`);
    return {
      total: data.total_hits,
      items: data.hits.map((hit) => ({
        provider: 'modrinth',
        id: hit.project_id,
        slug: hit.slug,
        name: hit.title,
        author: hit.author,
        description: hit.description,
        downloads: hit.downloads,
        icon: hit.icon_url || null,
        url: `https://modrinth.com/${hit.project_type}/${hit.slug}`,
        categories: (hit.display_categories || hit.categories || []).filter((c) => !(ctx.modrinthLoaders || []).includes(c)),
        updated: hit.date_modified,
        clientSide: hit.client_side,
        serverSide: hit.server_side,
      })),
    };
  },

  async project(id) {
    const cached = projectCache.get(id);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
    const p = await getJson(`${API}/project/${encodeURIComponent(id)}`);
    const value = {
      id: p.id,
      slug: p.slug,
      name: p.title,
      icon: p.icon_url || null,
      url: `https://modrinth.com/${p.project_type}/${p.slug}`,
      serverSupported: p.server_side !== 'unsupported',
    };
    projectCache.set(id, { at: Date.now(), value });
    projectCache.set(p.id, { at: Date.now(), value });
    return value;
  },

  async version(versionId) {
    return normalizeVersion(await getJson(`${API}/version/${encodeURIComponent(versionId)}`));
  },

  /** Every release that fits the server, best first. */
  async versions({ projectId, ctx, projectType }) {
    const params = new URLSearchParams();
    if (projectType !== 'modpack') {
      if (ctx.modrinthLoaders?.length) params.set('loaders', JSON.stringify(ctx.modrinthLoaders));
      if (ctx.gameVersion) params.set('game_versions', JSON.stringify([ctx.gameVersion]));
    }
    const data = await getJson(`${API}/project/${encodeURIComponent(projectId)}/version?${params}`);
    const list = data.map(normalizeVersion);
    return projectType === 'modpack' ? list : sortBest(list.filter((v) => modrinth.fits(v, ctx)));
  },

  async best({ projectId, ctx }) {
    return (await modrinth.versions({ projectId, ctx }))[0] || null;
  },

  /** Identify files by hash (used to recognise mods that came with a modpack). */
  async identify(sha512s) {
    if (!sha512s.length) return {};
    const out = {};
    for (let i = 0; i < sha512s.length; i += 100) {
      Object.assign(out, await postJson(`${API}/version_files`, { hashes: sha512s.slice(i, i + 100), algorithm: 'sha512' }));
    }
    return out;
  },

  async projects(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      out.push(...(await getJson(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(ids.slice(i, i + 100)))}`)));
    }
    return out;
  },
};

module.exports = modrinth;
