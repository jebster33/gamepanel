'use strict';

/** Factorio Mod Portal. Browsing is open; downloads need a factorio.com username and token. */

const { fail } = require('../../../core/util');
const { getJson } = require('../http');

const PORTAL = 'https://mods.factorio.com';
// Shipped with the game (or its DLC), never downloaded.
const BUILT_IN = new Set(['base', 'core', 'space-age', 'quality', 'elevated-rails']);

/** "2.0.28" → "2.0", which is what releases are tagged with. */
const line = (version) => String(version || '').split('.').slice(0, 2).join('.');

/**
 * info.json dependency strings: "name >= 1.0" is required, "? name" optional,
 * "(?) name" hidden optional, "! name" incompatible, "~ name" required
 * without load-order.
 */
function parseDependency(text) {
  const m = String(text).trim().match(/^(\(\?\)|\?|!|~)?\s*([^<>=]+?)\s*(?:[<>=]=?.*)?$/);
  if (!m) return null;
  const prefix = m[1] || '';
  const name = m[2].trim();
  const type = prefix === '!' ? 'incompatible' : prefix.includes('?') ? 'optional' : 'required';
  return { projectId: name, versionId: null, type };
}

function normalizeRelease(project, release) {
  return {
    id: release.version,
    projectId: project.name,
    name: `${project.title} ${release.version}`,
    version: release.version,
    channel: 'release',
    gameVersions: [release.info_json?.factorio_version].filter(Boolean),
    loaders: [],
    published: release.released_at,
    file: { url: `${PORTAL}${release.download_url}`, filename: release.file_name, size: release.file_size, sha1: release.sha1 },
    dependencies: (release.info_json?.dependencies || [])
      .map(parseDependency)
      .filter((d) => d && !BUILT_IN.has(d.projectId)),
  };
}

const cache = new Map();
async function full(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = await getJson(`${PORTAL}/api/mods/${encodeURIComponent(name)}/full`);
  cache.set(name, { at: Date.now(), value });
  return value;
}

let listCache = null;
async function allMods(version) {
  if (listCache && listCache.version === version && Date.now() - listCache.at < 30 * 60_000) return listCache.results;
  const params = new URLSearchParams({ page_size: 'max', hide_deprecated: 'true' });
  if (version) params.set('version', version);
  const data = await getJson(`${PORTAL}/api/mods?${params}`);
  listCache = { at: Date.now(), version, results: data.results || [] };
  return listCache.results;
}

const factorio = {
  id: 'factorio',
  label: 'Factorio Mod Portal',
  needsKey: false,
  site: PORTAL,

  fits(version, ctx) {
    if (!version?.file) return false;
    return !ctx.gameVersion || version.gameVersions.includes(line(ctx.gameVersion));
  },

  async search({ query = '', page = 0, limit = 24, ctx }) {
    const version = ctx.gameVersion ? line(ctx.gameVersion) : '';
    let data;
    if (query) {
      // The portal has no text search, so match against the full (cached) list.
      const q = query.toLowerCase();
      const matches = (await allMods(version)).filter((m) => `${m.name} ${m.title} ${m.summary}`.toLowerCase().includes(q));
      matches.sort((a, b) => (b.downloads_count || 0) - (a.downloads_count || 0));
      data = { results: matches.slice(page * limit, page * limit + limit), pagination: { count: matches.length } };
    } else {
      const params = new URLSearchParams({ page_size: String(limit), page: String(page + 1), hide_deprecated: 'true', sort: 'downloads_count', sort_order: 'desc' });
      if (version) params.set('version', version);
      data = await getJson(`${PORTAL}/api/mods?${params}`);
    }
    return {
      total: data.pagination?.count ?? data.results.length,
      items: data.results.map((mod) => ({
        provider: 'factorio',
        id: mod.name,
        slug: mod.name,
        name: mod.title,
        author: mod.owner,
        description: mod.summary,
        downloads: mod.downloads_count,
        icon: mod.thumbnail ? `https://assets-mod.factorio.com${mod.thumbnail}` : null,
        url: `${PORTAL}/mod/${encodeURIComponent(mod.name)}`,
        categories: mod.category ? [mod.category] : [],
        version: mod.latest_release?.version,
      })),
    };
  },

  async project(name) {
    const data = await full(name);
    return {
      id: data.name,
      slug: data.name,
      name: data.title,
      icon: data.thumbnail ? `https://assets-mod.factorio.com${data.thumbnail}` : null,
      url: `${PORTAL}/mod/${encodeURIComponent(data.name)}`,
      serverSupported: true,
    };
  },

  async versions({ projectId, ctx }) {
    const data = await full(projectId);
    return (data.releases || [])
      .map((r) => normalizeRelease(data, r))
      .filter((v) => factorio.fits(v, ctx))
      .reverse();
  },

  async version(versionId, { projectId }) {
    const data = await full(projectId);
    const release = (data.releases || []).find((r) => r.version === versionId);
    return release ? normalizeRelease(data, release) : null;
  },

  async best(args) {
    return (await factorio.versions(args))[0] || null;
  },

  /** The portal wants credentials on the download URL itself. */
  authorize(url, { credentials } = {}) {
    if (!credentials?.username || !credentials?.token) {
      fail(400, 'Factorio mod downloads need your factorio.com username and token. Add them in Settings → Integrations (the token is on your factorio.com profile).');
    }
    return `${url}?username=${encodeURIComponent(credentials.username)}&token=${encodeURIComponent(credentials.token)}`;
  },
};

module.exports = factorio;
module.exports.parseDependency = parseDependency;
