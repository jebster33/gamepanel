'use strict';

/** uMod (Oxide) plugins for Rust and other Oxide games. No key needed. */

const { getJson } = require('../http');

/** How many plugins uMod puts on one search page. */
const UMOD_PAGE = 10;

const umod = {
  id: 'umod',
  label: 'uMod',
  needsKey: false,
  site: 'https://umod.org',

  fits(version) {
    return Boolean(version?.file);
  },

  async search({ query = '', page = 0, limit = 24, ctx }) {
    // uMod pages hold 10 plugins whatever is asked for, so one panel page spans several.
    // The game filter must be sent as categories[]: a plain "categories" is ignored and
    // returns every game's plugins.
    const fetchPage = (n) => {
      const params = new URLSearchParams({
        query,
        page: String(n),
        sort: query ? 'title' : 'downloads',
        sortdir: query ? 'asc' : 'desc',
      });
      params.append('categories[]', ctx.umodGame || 'rust');
      return getJson(`https://umod.org/plugins/search.json?${params}`);
    };
    const start = page * limit;
    const perPage = UMOD_PAGE;
    const firstPage = Math.floor(start / perPage) + 1;
    const first = await fetchPage(firstPage);
    const lastPage = Math.min(Math.floor((start + limit - 1) / perPage) + 1, Number(first.last_page) || firstPage);
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, lastPage - firstPage) }, (_, i) => fetchPage(firstPage + 1 + i).catch(() => ({ data: [] })))
    );
    const plugins = [first, ...rest].flatMap((d) => d.data || []);
    const skip = start - (firstPage - 1) * perPage;
    return {
      total: first.total ?? plugins.length,
      items: plugins.slice(skip, skip + limit).map((plugin) => ({
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
