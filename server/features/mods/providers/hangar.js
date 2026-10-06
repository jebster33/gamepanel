'use strict';

/** Hangar (hangar.papermc.io): PaperMC's plugin site. No key needed. */

const { getJson } = require('../http');

const API = 'https://hangar.papermc.io/api/v1';
const PLATFORM = 'PAPER'; // Paper, Purpur and Folia all load Paper plugins

const projectCache = new Map();

function normalizeVersion(v, projectId) {
  const dl = v.downloads?.[PLATFORM];
  return {
    id: String(v.id),
    projectId: String(projectId ?? v.projectId),
    name: v.name,
    version: v.name,
    channel: /release/i.test(v.channel?.name || '') ? 'release' : 'beta',
    gameVersions: v.platformDependencies?.[PLATFORM] || [],
    loaders: ['paper'],
    published: v.createdAt,
    downloads: v.stats?.totalDownloads,
    // Some plugins only link to another site; those cannot be installed from here.
    file: dl?.downloadUrl ? { url: dl.downloadUrl, filename: dl.fileInfo?.name || `${v.name}.jar`, size: dl.fileInfo?.sizeBytes } : null,
    dependencies: (v.pluginDependencies?.[PLATFORM] || [])
      .filter((d) => d.projectId)
      .map((d) => ({ projectId: String(d.projectId), versionId: null, type: d.required ? 'required' : 'optional' })),
  };
}

const hangar = {
  id: 'hangar',
  label: 'Hangar',
  needsKey: false,
  site: 'https://hangar.papermc.io',

  fits(version, ctx) {
    if (!version?.file) return false;
    if (ctx.gameVersion && version.gameVersions.length && !version.gameVersions.includes(ctx.gameVersion)) return false;
    return true;
  },

  downloadError: (name) => `${name} is only offered on another website, so it cannot be installed from here.`,

  async search({ query = '', page = 0, limit = 24, ctx }) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(page * limit), platform: PLATFORM, sort: query ? '-stars' : '-downloads' });
    if (query) params.set('q', query);
    if (ctx.gameVersion) params.set('version', ctx.gameVersion);
    const data = await getJson(`${API}/projects?${params}`);
    return {
      total: data.pagination?.count ?? data.result.length,
      items: data.result.map((p) => ({
        provider: 'hangar',
        id: String(p.id),
        slug: p.namespace.slug,
        name: p.name,
        author: p.namespace.owner,
        description: p.description,
        downloads: p.stats?.downloads,
        icon: p.avatarUrl || null,
        url: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
        categories: [String(p.category || '').replace(/_/g, ' ')].filter(Boolean),
        updated: p.lastUpdated,
      })),
    };
  },

  async project(id) {
    const cached = projectCache.get(String(id));
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
    const p = await getJson(`${API}/projects/${encodeURIComponent(id)}`);
    const value = {
      id: String(p.id),
      slug: p.namespace.slug,
      name: p.name,
      icon: p.avatarUrl || null,
      url: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
      serverSupported: true,
    };
    projectCache.set(String(id), { at: Date.now(), value });
    projectCache.set(value.id, { at: Date.now(), value });
    return value;
  },

  async versions({ projectId, ctx }) {
    const params = new URLSearchParams({ limit: '25', platform: PLATFORM });
    if (ctx?.gameVersion) params.set('platformVersion', ctx.gameVersion);
    // Busy plugins post dozens of snapshots between releases, so ask for releases separately.
    const url = `${API}/projects/${encodeURIComponent(projectId)}/versions?${params}`;
    const [releases, all] = await Promise.all([getJson(`${url}&channel=Release`).catch(() => ({ result: [] })), getJson(url)]);
    const seen = new Set();
    const list = [...releases.result, ...all.result]
      .filter((v) => !seen.has(v.id) && seen.add(v.id))
      .map((v) => normalizeVersion(v, projectId))
      .filter((v) => !ctx || hangar.fits(v, ctx));
    // Releases first, newest first within each channel.
    return list.sort((a, b) => (a.channel === 'release' ? 0 : 1) - (b.channel === 'release' ? 0 : 1) || String(b.published).localeCompare(String(a.published)));
  },

  async version(versionId, { projectId } = {}) {
    if (!projectId) return null;
    const data = await getJson(`${API}/projects/${encodeURIComponent(projectId)}/versions?limit=25&platform=${PLATFORM}`);
    const found = data.result.find((v) => String(v.id) === String(versionId));
    return found ? normalizeVersion(found, projectId) : null;
  },

  async best({ projectId, ctx }) {
    return (await hangar.versions({ projectId, ctx }))[0] || null;
  },
};

module.exports = hangar;
