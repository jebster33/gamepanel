'use strict';

/**
 * SpigotMC plugins through Spiget (spiget.org), which mirrors the free ones.
 * No key needed. Premium plugins and ones hosted on another site (GitHub,
 * a dev's own page) can't be downloaded from here, and only the newest
 * release of each plugin is offered.
 */

const { getJson } = require('../http');

const API = 'https://api.spiget.org/v2';
const SITE = 'https://www.spigotmc.org';

const projectCache = new Map();

const icon = (r) => (r.icon?.url ? `${SITE}/${r.icon.url}` : null);
const pageUrl = (r) => `${SITE}/resources/${r.id}/`;
const installable = (r) => !r.premium && !r.external && r.file?.type === '.jar';

const spigot = {
  id: 'spigot',
  label: 'SpigotMC',
  needsKey: false,
  site: SITE,

  fits(version) {
    return Boolean(version?.file);
  },

  downloadError: (name) => `${name} is premium or only offered on another website, so it cannot be installed from here.`,

  async search({ query = '', page = 0, limit = 24 }) {
    const params = new URLSearchParams({ size: String(limit), page: String(page + 1), sort: '-downloads' });
    const url = query ? `${API}/search/resources/${encodeURIComponent(query)}?field=name&${params}` : `${API}/resources/free?${params}`;
    const data = await getJson(url).catch((err) => (err.code === 404 ? [] : Promise.reject(err)));
    const items = (Array.isArray(data) ? data : []).filter((r) => !r.premium);
    return {
      total: items.length < limit ? page * limit + items.length : (page + 2) * limit,
      items: items.map((r) => ({
        provider: 'spigot',
        id: String(r.id),
        slug: String(r.id),
        name: r.name,
        author: r.author?.name || '',
        description: r.tag || '',
        downloads: r.downloads,
        icon: icon(r),
        url: pageUrl(r),
        categories: r.external ? ['external download'] : [],
        updated: r.updateDate ? new Date(r.updateDate * 1000).toISOString() : null,
      })),
    };
  },

  async resource(id) {
    const cached = projectCache.get(String(id));
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
    const value = await getJson(`${API}/resources/${encodeURIComponent(id)}`);
    projectCache.set(String(id), { at: Date.now(), value });
    return value;
  },

  async project(id) {
    const r = await spigot.resource(id);
    return { id: String(r.id), slug: String(r.id), name: r.name, icon: icon(r), url: pageUrl(r), serverSupported: true };
  },

  async versions({ projectId }) {
    const r = await spigot.resource(projectId);
    const latest = await getJson(`${API}/resources/${encodeURIComponent(projectId)}/versions/latest`).catch(() => null);
    const id = String(latest?.id ?? r.version?.id ?? '');
    return [
      {
        id,
        projectId: String(r.id),
        name: latest?.name || id,
        version: latest?.name || id,
        channel: 'release',
        gameVersions: r.testedVersions || [],
        loaders: ['paper'],
        published: latest?.releaseDate ? new Date(latest.releaseDate * 1000).toISOString() : null,
        downloads: r.downloads,
        file: installable(r) ? { url: `${API}/resources/${r.id}/download`, filename: `${String(r.name).replace(/[^\w.-]+/g, '-')}.jar` } : null,
        dependencies: [],
      },
    ];
  },

  async version(versionId, { projectId } = {}) {
    if (!projectId) return null;
    const [v] = await spigot.versions({ projectId });
    return v || null;
  },

  async best({ projectId }) {
    const [v] = await spigot.versions({ projectId });
    return v || null;
  },
};

module.exports = spigot;
