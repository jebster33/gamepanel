'use strict';

/** uMod (Oxide) plugins for Rust and other Oxide games. No key needed. */

const { getJson } = require('../http');

const umod = {
  id: 'umod',
  label: 'uMod',
  needsKey: false,
  site: 'https://umod.org',

  fits(version) {
    return Boolean(version?.file);
  },

  async search({ query = '', page = 0, limit = 24, ctx }) {
    const params = new URLSearchParams({
      query,
      page: String(page + 1),
      sort: query ? 'title' : 'downloads',
      sortdir: query ? 'asc' : 'desc',
      categories: ctx.umodGame || 'rust',
    });
    const data = await getJson(`https://umod.org/plugins/search.json?${params}`);
    return {
      total: data.total ?? data.data.length,
      items: data.data.slice(0, limit).map((plugin) => ({
        provider: 'umod',
        id: plugin.name,
        slug: plugin.slug,
        name: plugin.title,
        author: plugin.author,
        description: plugin.description,
        downloads: plugin.downloads,
        icon: plugin.icon_url || null,
        url: plugin.url,
        categories: String(plugin.tags_all || '').split(',').filter(Boolean).slice(0, 4),
        updated: plugin.latest_release_at,
        version: plugin.latest_release_version,
      })),
    };
  },

  async project(name) {
    return { id: name, slug: name, name, icon: null, url: `https://umod.org/plugins/${encodeURIComponent(name)}`, serverSupported: true };
  },

  async versions({ projectId }) {
    return [await umod.best({ projectId })];
  },

  async version(_id, { projectId }) {
    return umod.best({ projectId });
  },

  async best({ projectId }) {
    return {
      id: 'latest',
      projectId,
      name: 'Latest release',
      version: 'latest',
      channel: 'release',
      gameVersions: [],
      loaders: [],
      file: { url: `https://umod.org/plugins/${encodeURIComponent(projectId)}.cs`, filename: `${projectId}.cs` },
      dependencies: [],
    };
  },
};

module.exports = umod;
