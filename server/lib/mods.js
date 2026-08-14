'use strict';

/**
 * Mod / plugin browser and installer.
 *
 * Providers implemented against their public APIs:
 *   modrinth    — Minecraft mods, plugins, datapacks and modpacks (no key)
 *   curseforge  — Minecraft (and more); needs a free API key in Settings
 *   umod        — Oxide/uMod plugins for Rust, Hurtworld, 7DTD… (no key)
 *   factorio    — mods.factorio.com (search open, download needs a token)
 *   workshop    — Steam Workshop items via SteamCMD (GMod, ARK, Unturned…)
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { fail, logger, interpolate, safeJoin } = require('./util');

const UA = 'GamePanel/1.0 (+https://github.com/jebster33/gamepanel)';
const TIMEOUT = 20000;

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    fail(res.status === 404 ? 404 : 502, `${new URL(url).hostname} responded ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }
  return res.json();
}

/** Only ever write a plain file name into the mod directory. */
function safeFileName(name, fallback = 'mod.jar') {
  const base = path
    .basename(String(name || ''))
    .replace(/[^A-Za-z0-9._+-]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return base || fallback;
}

async function downloadTo(url, targetPath, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok || !res.body) fail(502, `Download failed (${res.status})`);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(targetPath));
  const stat = await fsp.stat(targetPath);
  return { path: targetPath, size: stat.size };
}

/* ---------------------------------------------------------------- modrinth */

const modrinth = {
  id: 'modrinth',
  label: 'Modrinth',
  needsKey: false,
  site: 'https://modrinth.com',

  async search({ query = '', loader, gameVersion, projectType, page = 0, limit = 20 }) {
    const facets = [];
    if (projectType) facets.push([`project_type:${projectType}`]);
    if (loader) facets.push([`categories:${loader}`]);
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    const params = new URLSearchParams({
      query,
      limit: String(limit),
      offset: String(page * limit),
      index: query ? 'relevance' : 'downloads',
    });
    if (facets.length) params.set('facets', JSON.stringify(facets));

    const data = await getJson(`https://api.modrinth.com/v2/search?${params}`);
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
        categories: hit.categories || [],
        updated: hit.date_modified,
        clientSide: hit.client_side,
        serverSide: hit.server_side,
      })),
    };
  },

  async versions({ projectId, loader, gameVersion }) {
    const params = new URLSearchParams();
    if (loader) params.set('loaders', JSON.stringify([loader]));
    if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
    const data = await getJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version?${params}`);
    return data.map((v) => ({
      id: v.id,
      name: v.name,
      version: v.version_number,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      channel: v.version_type,
      published: v.date_published,
      filename: v.files[0]?.filename,
      size: v.files[0]?.size,
      url: v.files[0]?.url,
    }));
  },

  async resolveDownload({ projectId, versionId, loader, gameVersion }) {
    const list = await modrinth.versions({ projectId, loader, gameVersion });
    if (!list.length) fail(404, 'No release of that mod matches this server’s loader and game version');
    const chosen = versionId ? list.find((v) => v.id === versionId) || list[0] : list[0];
    if (!chosen.url) fail(404, 'That release has no downloadable file');
    return { url: chosen.url, filename: chosen.filename, version: chosen.version };
  },
};

/* -------------------------------------------------------------- curseforge */

const curseforge = {
  id: 'curseforge',
  label: 'CurseForge',
  needsKey: true,
  site: 'https://www.curseforge.com',

  headers(key) {
    if (!key) fail(400, 'Add a CurseForge API key in Settings to browse CurseForge (it is free at console.curseforge.com)');
    return { 'x-api-key': key };
  },

  // 432 = Minecraft. Loader ids: 1 Forge, 4 Fabric, 5 Quilt, 6 NeoForge.
  loaderId(loader) {
    return { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }[String(loader || '').toLowerCase()];
  },

  async search({ query = '', loader, gameVersion, page = 0, limit = 20, apiKey, classId }) {
    const params = new URLSearchParams({
      gameId: '432',
      searchFilter: query,
      pageSize: String(limit),
      index: String(page * limit),
      sortField: query ? '2' : '6',
      sortOrder: 'desc',
    });
    if (classId) params.set('classId', String(classId));
    const loaderType = curseforge.loaderId(loader);
    if (loaderType) params.set('modLoaderType', String(loaderType));
    if (gameVersion) params.set('gameVersion', gameVersion);

    const data = await getJson(`https://api.curseforge.com/v1/mods/search?${params}`, curseforge.headers(apiKey));
    return {
      total: data.pagination?.totalCount ?? data.data.length,
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
        categories: (mod.categories || []).map((c) => c.name),
        updated: mod.dateModified,
      })),
    };
  },

  async versions({ projectId, loader, gameVersion, apiKey }) {
    const params = new URLSearchParams({ pageSize: '30' });
    const loaderType = curseforge.loaderId(loader);
    if (loaderType) params.set('modLoaderType', String(loaderType));
    if (gameVersion) params.set('gameVersion', gameVersion);
    const data = await getJson(
      `https://api.curseforge.com/v1/mods/${encodeURIComponent(projectId)}/files?${params}`,
      curseforge.headers(apiKey)
    );
    return data.data.map((file) => ({
      id: String(file.id),
      name: file.displayName,
      version: file.displayName,
      gameVersions: file.gameVersions,
      loaders: [],
      published: file.fileDate,
      filename: file.fileName,
      size: file.fileLength,
      url: file.downloadUrl,
    }));
  },

  async resolveDownload({ projectId, versionId, loader, gameVersion, apiKey }) {
    const list = await curseforge.versions({ projectId, loader, gameVersion, apiKey });
    if (!list.length) fail(404, 'No CurseForge file matches this server’s loader and version');
    const chosen = versionId ? list.find((v) => v.id === versionId) || list[0] : list[0];
    if (!chosen.url) {
      fail(
        400,
        'The author has disabled third-party downloads for that file. Download it from CurseForge and upload it with the file manager.'
      );
    }
    return { url: chosen.url, filename: chosen.filename, version: chosen.version };
  },
};

/* ------------------------------------------------------------------- umod */

const umod = {
  id: 'umod',
  label: 'uMod / Oxide',
  needsKey: false,
  site: 'https://umod.org',

  async search({ query = '', page = 0, limit = 20, game = 'rust' }) {
    const params = new URLSearchParams({
      query,
      page: String(page + 1),
      sort: query ? 'title' : 'downloads',
      sortdir: query ? 'asc' : 'desc',
      categories: game,
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
        clientSide: 'unsupported',
        serverSide: 'required',
        downloadUrl: plugin.download_url,
      })),
    };
  },

  async versions({ projectId }) {
    return [{ id: 'latest', name: 'Latest release', version: 'latest', filename: `${projectId}.cs`, url: `https://umod.org/plugins/${projectId}.cs` }];
  },

  async resolveDownload({ projectId }) {
    return { url: `https://umod.org/plugins/${encodeURIComponent(projectId)}.cs`, filename: `${projectId}.cs`, version: 'latest' };
  },
};

/* --------------------------------------------------------------- factorio */

const factorio = {
  id: 'factorio',
  label: 'Factorio Mod Portal',
  needsKey: false,
  site: 'https://mods.factorio.com',

  async search({ query = '', page = 0, limit = 20 }) {
    const params = new URLSearchParams({ page_size: String(limit), page: String(page + 1) });
    if (query) params.set('namelike', query);
    const data = await getJson(`https://mods.factorio.com/api/mods?${params}`);
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
        url: `https://mods.factorio.com/mod/${encodeURIComponent(mod.name)}`,
        categories: mod.category ? [mod.category] : [],
        version: mod.latest_release?.version,
      })),
    };
  },

  async versions({ projectId }) {
    const data = await getJson(`https://mods.factorio.com/api/mods/${encodeURIComponent(projectId)}/full`);
    return (data.releases || []).reverse().map((release) => ({
      id: release.version,
      name: `${data.title} ${release.version}`,
      version: release.version,
      gameVersions: [release.info_json?.factorio_version].filter(Boolean),
      filename: release.file_name,
      size: release.file_size,
      url: `https://mods.factorio.com${release.download_url}`,
    }));
  },

  async resolveDownload({ projectId, versionId, credentials }) {
    if (!credentials?.username || !credentials?.token) {
      fail(400, 'Factorio downloads need your factorio.com username and token — add them in Settings (they are shown on your Factorio profile page).');
    }
    const list = await factorio.versions({ projectId });
    if (!list.length) fail(404, 'That mod has no releases');
    const chosen = versionId ? list.find((v) => v.id === versionId) || list[0] : list[0];
    const url = `${chosen.url}?username=${encodeURIComponent(credentials.username)}&token=${encodeURIComponent(credentials.token)}`;
    return { url, filename: chosen.filename, version: chosen.version };
  },
};

/* --------------------------------------------------------------- workshop */

const workshop = {
  id: 'workshop',
  label: 'Steam Workshop',
  needsKey: false, // browsing needs a key, installing by ID does not
  site: 'https://steamcommunity.com/workshop',
  viaSteamcmd: true,

  async search({ query = '', page = 0, limit = 20, appId, apiKey }) {
    if (!apiKey) {
      fail(
        400,
        'Steam Workshop search needs a free Steam Web API key (Settings → Integrations). You can still install any item by pasting its Workshop ID or URL.'
      );
    }
    const params = new URLSearchParams({
      key: apiKey,
      appid: String(appId || ''),
      search_text: query,
      page: String(page + 1),
      numperpage: String(limit),
      return_metadata: 'true',
      query_type: query ? '12' : '3',
    });
    const data = await getJson(`https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?${params}`);
    return {
      total: data.response?.total ?? 0,
      items: (data.response?.publishedfiledetails || []).map((item) => ({
        provider: 'workshop',
        id: item.publishedfileid,
        name: item.title,
        author: item.creator,
        description: (item.file_description || '').slice(0, 220),
        downloads: item.subscriptions,
        icon: item.preview_url || null,
        url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`,
        categories: (item.tags || []).map((t) => t.tag).slice(0, 4),
      })),
    };
  },

  async versions() {
    return [{ id: 'latest', name: 'Current Workshop version', version: 'latest' }];
  },
};

const PROVIDERS = { modrinth, curseforge, umod, factorio, workshop };

/* ------------------------------------------------------------------ files */

/** Where a template keeps its mods, e.g. "plugins" or "oxide/plugins". */
function modDir(server, template) {
  const dir = template?.mods?.dir || 'mods';
  return interpolate(dir, { ...(server.vars || {}), SERVER_DIR: server.dir });
}

function providersFor(template) {
  const ids = template?.mods?.providers || [];
  return ids.filter((id) => PROVIDERS[id]).map((id) => ({
    id,
    label: PROVIDERS[id].label,
    needsKey: PROVIDERS[id].needsKey,
    site: PROVIDERS[id].site,
    viaSteamcmd: Boolean(PROVIDERS[id].viaSteamcmd),
  }));
}

function requireProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) fail(400, `Unknown mod provider: ${id}`);
  return provider;
}

async function listInstalled(server, template) {
  const dir = safeJoin(server.dir, modDir(server, template));
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { dir: modDir(server, template), items: [] };
  }
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    items.push({
      name: entry.name,
      size: stat.size,
      modified: stat.mtimeMs,
      directory: entry.isDirectory(),
      disabled: entry.name.endsWith('.disabled'),
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { dir: modDir(server, template), items };
}

async function installFile(server, template, { url, filename, headers }) {
  const dir = modDir(server, template);
  const target = safeJoin(server.dir, path.posix.join(dir, safeFileName(filename)));
  const result = await downloadTo(url, target, headers);
  logger.info(`Installed ${path.basename(target)} into ${server.name}/${dir}`);
  return { name: path.basename(target), size: result.size, dir };
}

async function removeInstalled(server, template, name) {
  const target = safeJoin(server.dir, path.posix.join(modDir(server, template), safeFileName(name)));
  await fsp.rm(target, { recursive: true, force: true });
  return { ok: true };
}

/** Disable a mod by renaming it rather than deleting — easy to undo. */
async function toggleInstalled(server, template, name) {
  const dir = modDir(server, template);
  const safe = safeFileName(name);
  const from = safeJoin(server.dir, path.posix.join(dir, safe));
  const to = safeJoin(
    server.dir,
    path.posix.join(dir, safe.endsWith('.disabled') ? safe.replace(/\.disabled$/, '') : `${safe}.disabled`)
  );
  await fsp.rename(from, to);
  return { name: path.basename(to), disabled: to.endsWith('.disabled') };
}

/**
 * Move client-only mods out of a server's mods folder.
 *
 * A pack's overrides/ folder carries jars with no metadata at all, so the only
 * reliable check is to hash what actually landed and ask Modrinth what each
 * one is. Forge and NeoForge abort the entire server when a client mod is
 * present, so this runs after every modpack install.
 *
 * Files are moved aside rather than deleted, so nothing is lost if the
 * classification is ever wrong.
 */
async function pruneClientOnlyMods(server, template, log = () => {}) {
  const dir = safeJoin(server.dir, modDir(server, template));
  let entries = [];
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar'))
      .map((e) => e.name);
  } catch {
    return { checked: 0, moved: [] };
  }
  if (!entries.length) return { checked: 0, moved: [] };

  const crypto = require('crypto');
  const byHash = new Map();
  for (const name of entries) {
    try {
      const buf = await fsp.readFile(path.join(dir, name));
      byHash.set(crypto.createHash('sha512').update(buf).digest('hex'), name);
    } catch {
      /* unreadable file — leave it alone */
    }
  }

  const moved = [];
  try {
    const hashToProject = new Map();
    const hashes = [...byHash.keys()];
    for (let i = 0; i < hashes.length; i += 100) {
      const res = await fetch('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: hashes.slice(i, i + 100), algorithm: 'sha512' }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error(`lookup failed (${res.status})`);
      for (const [hash, version] of Object.entries(await res.json())) {
        hashToProject.set(hash, version.project_id);
      }
    }

    const ids = [...new Set(hashToProject.values())];
    const sides = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const projects = await getJson(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids.slice(i, i + 100)))}`
      );
      for (const project of projects) sides.set(project.id, project.server_side);
    }

    const quarantine = path.join(dir, '_client-only');
    for (const [hash, name] of byHash) {
      const projectId = hashToProject.get(hash);
      if (!projectId || sides.get(projectId) !== 'unsupported') continue;
      await fsp.mkdir(quarantine, { recursive: true });
      await fsp.rename(path.join(dir, name), path.join(quarantine, name));
      moved.push(name);
    }
  } catch (err) {
    logger.warn(`Could not verify which mods are server-safe: ${err.message}`);
    return { checked: byHash.size, moved, error: err.message };
  }

  if (moved.length) {
    log(
      `Moved ${moved.length} client-only mod(s) into ${modDir(server, template)}/_client-only — ` +
        `they crash a dedicated server: ${moved.slice(0, 6).join(', ')}${moved.length > 6 ? '…' : ''}`
    );
  }
  return { checked: byHash.size, moved };
}

/** Pull the Workshop ID out of a pasted URL or raw number. */
function parseWorkshopId(input) {
  const text = String(input || '').trim();
  const match = text.match(/(?:\?|&)id=(\d+)/) || text.match(/^(\d+)$/);
  if (!match) fail(400, 'Enter a Workshop item ID or the full Workshop URL');
  return match[1];
}

module.exports = {
  PROVIDERS,
  providersFor,
  requireProvider,
  modDir,
  listInstalled,
  installFile,
  removeInstalled,
  toggleInstalled,
  pruneClientOnlyMods,
  parseWorkshopId,
  safeFileName,
};
