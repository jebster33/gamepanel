'use strict';

/**
 * Thunderstore (thunderstore.io): the mod site for BepInEx games such as
 * Valheim, V Rising, Lethal Company and Risk of Rain 2. No key needed.
 *
 * Each game is a "community" (the template says which one with
 * mods.thunderstore). A package is "Owner-Name"; its releases list their
 * dependencies as "Owner-Name-1.2.3". Downloads are zips whose layout is
 * mapped the way mod managers do it:
 *
 *   BepInExPack*          unpacked into the server folder (the loader itself)
 *   plugins/ patchers/ monomod/ core/   BepInEx/<folder>/<Owner-Name>/...
 *   config/               BepInEx/config/...
 *   anything else         BepInEx/plugins/<Owner-Name>/...
 *
 * Not tested against the live site in the panel's own test run.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { fail } = require('../../../core/util');
const zip = require('../../../core/zip');
const { getJson } = require('../http');
const { containedPath } = require('../../files');

const SITE = 'https://thunderstore.io';
const CACHE_MS = 10 * 60_000;
const COMMUNITY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACKAGE = /^[A-Za-z0-9_]{1,128}-[A-Za-z0-9_]{1,128}$/;
const MAX_FILE = 128 * 1024 * 1024;
const MAX_FILES = 5000;
const DISABLED = '.old';

const lists = new Map(); // community -> { at, byId, all }

function communityOf(ctx) {
  const community = String(ctx?.thunderstore || '').toLowerCase();
  if (!COMMUNITY.test(community)) fail(400, 'This game has no Thunderstore community set up');
  return community;
}

const downloadsOf = (pkg) => (pkg.versions || []).reduce((n, v) => n + (v.downloads || 0), 0);
const newestFirst = (pkg) => [...pkg.versions].sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));

/** The whole community listing (one request, cached): Thunderstore has no search endpoint for it. */
async function listing(community) {
  const cached = lists.get(community);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  const data = await getJson(`${SITE}/c/${community}/api/v1/package/`);
  if (!Array.isArray(data)) fail(502, 'Thunderstore answered with something unexpected');
  const all = data.filter(
    (p) => p && PACKAGE.test(String(p.full_name)) && Array.isArray(p.versions) && p.versions.length && !p.is_deprecated && !p.has_nsfw_content
  );
  const entry = { at: Date.now(), all, byId: new Map(all.map((p) => [p.full_name.toLowerCase(), p])) };
  lists.set(community, entry);
  return entry;
}

const isLoader = (name) => /^BepInExPack/i.test(String(name));

/** "Owner-Name-1.2.3" -> { projectId: "Owner-Name", versionId: "1.2.3" } */
function parseDependency(text) {
  const m = String(text).match(/^([A-Za-z0-9_]+-[A-Za-z0-9_]+)-(\d+\.\d+\.\d+)$/);
  return m ? { projectId: m[1], versionId: m[2] } : null;
}

function normalizeVersion(v, projectId) {
  return {
    id: String(v.version_number),
    projectId,
    name: `${v.name || projectId} ${v.version_number}`,
    version: String(v.version_number),
    channel: 'release',
    gameVersions: [],
    loaders: [],
    published: v.date_created,
    downloads: v.downloads,
    file: v.download_url ? { url: v.download_url, filename: `${projectId}-${v.version_number}.zip`, size: v.file_size } : null,
    dependencies: (v.dependencies || [])
      .map(parseDependency)
      .filter(Boolean)
      .map((d) => ({ ...d, type: 'required' })),
  };
}

/* ----------------------------------------------------------------- layout -- */

const METADATA = new Set(['manifest.json', 'icon.png', 'readme.md', 'changelog.md', 'license', 'license.txt', 'license.md']);
const BEPINEX_FOLDERS = new Set(['plugins', 'patchers', 'monomod', 'core']);

/** A zip entry name as a clean list of segments, or null when it is unsafe. */
function segmentsOf(name) {
  const text = String(name).replace(/\\/g, '/');
  if (!text || text.endsWith('/') || text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.includes('\0')) return null;
  const parts = text.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  return parts;
}

/**
 * Where each file of a package zip goes, relative to the server folder.
 * @param {string[]} names zip entry names
 * @param {{id: string, loader: boolean, root: string}} opts root is the BepInEx folder ("BepInEx")
 * @returns {{from: string, to: string, config: boolean}[]}
 */
function mapLayout(names, { id, loader, root }) {
  const entries = names.map((from) => ({ from, parts: segmentsOf(from) })).filter((e) => e.parts);
  const out = [];
  if (loader) {
    // The pack is the server's loader: its files go to the server folder, minus a wrapper folder.
    const real = entries.filter((e) => !(e.parts.length === 1 && METADATA.has(e.parts[0].toLowerCase())));
    const tops = new Set(real.map((e) => e.parts[0]));
    const strip = tops.size === 1 && real.every((e) => e.parts.length > 1) && [...tops][0].toLowerCase() !== 'bepinex' ? 1 : 0;
    for (const e of real) {
      const config = e.parts[strip]?.toLowerCase() === 'bepinex' && e.parts[strip + 1]?.toLowerCase() === 'config';
      out.push({ from: e.from, to: e.parts.slice(strip).join('/'), config });
    }
    return out;
  }
  for (const e of entries) {
    let parts = e.parts;
    if (parts.length === 1 && METADATA.has(parts[0].toLowerCase())) continue;
    if (parts[0].toLowerCase() === 'bepinex' && parts.length > 1) parts = parts.slice(1);
    const top = parts[0].toLowerCase();
    let to;
    let config = false;
    if (top === 'config' && parts.length > 1) {
      to = [root, 'config', ...parts.slice(1)];
      config = true;
    } else if (BEPINEX_FOLDERS.has(top) && parts.length > 1) to = [root, top, id, ...parts.slice(1)];
    else to = [root, 'plugins', id, ...parts];
    out.push({ from: e.from, to: to.join('/'), config });
  }
  return out;
}

/** Remove a package's files and any folders that end up empty (never above the server folder). */
async function removeFiles(server, files) {
  const dirs = new Set();
  for (const rel of files || []) {
    const target = containedPath(server.dir, rel);
    await fsp.rm(target, { force: true });
    await fsp.rm(`${target}${DISABLED}`, { force: true });
    dirs.add(path.dirname(target));
  }
  const floor = path.resolve(server.dir);
  for (const start of [...dirs].sort((a, b) => b.length - a.length)) {
    let dir = start;
    while (dir.startsWith(floor + path.sep)) {
      try {
        await fsp.rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }
}

/* --------------------------------------------------------------- provider -- */

const thunderstore = {
  id: 'thunderstore',
  label: 'Thunderstore',
  needsKey: false,
  site: SITE,
  _reset: () => lists.clear(),
  mapLayout,
  parseDependency,

  fits: (version) => Boolean(version?.file),

  async search({ query = '', page = 0, limit = 24, ctx }) {
    const { all } = await listing(communityOf(ctx));
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const matches = all.filter((p) => {
      if (isLoader(p.name)) return false; // the loader comes in as a dependency
      if (!words.length) return true;
      const text = `${p.full_name} ${newestFirst(p)[0].description || ''}`.toLowerCase().replace(/_/g, ' ');
      return words.every((w) => text.includes(w));
    });
    matches.sort((a, b) => downloadsOf(b) - downloadsOf(a));
    return {
      total: matches.length,
      items: matches.slice(page * limit, page * limit + limit).map((p) => {
        const latest = newestFirst(p)[0];
        return {
          provider: 'thunderstore',
          id: p.full_name,
          slug: p.full_name,
          name: p.name.replace(/_/g, ' '),
          author: p.owner,
          description: latest.description,
          downloads: downloadsOf(p),
          icon: latest.icon || null,
          url: p.package_url,
          categories: (p.categories || []).slice(0, 4),
          updated: p.date_updated,
          version: latest.version_number,
        };
      }),
    };
  },

  async project(id, { ctx } = {}) {
    const pkg = (await listing(communityOf(ctx))).byId.get(String(id).toLowerCase());
    if (!pkg) fail(404, `${id} was not found on Thunderstore for this game`);
    const cats = (pkg.categories || []).map((c) => String(c).toLowerCase());
    // Only mods tagged client-only are refused; most BepInEx mods do not say.
    const clientSide = cats.includes('client-side') && !cats.includes('server-side');
    return {
      id: pkg.full_name,
      slug: pkg.full_name,
      name: pkg.name.replace(/_/g, ' '),
      icon: newestFirst(pkg)[0].icon || null,
      url: pkg.package_url,
      clientSide,
      serverSupported: !clientSide,
      loader: isLoader(pkg.name),
    };
  },

  async versions({ projectId, ctx }) {
    const pkg = (await listing(communityOf(ctx))).byId.get(String(projectId).toLowerCase());
    if (!pkg) fail(404, `${projectId} was not found on Thunderstore for this game`);
    return newestFirst(pkg).map((v) => normalizeVersion(v, pkg.full_name));
  },

  async version(versionId, { projectId, ctx }) {
    return (await thunderstore.versions({ projectId, ctx })).find((v) => v.id === String(versionId)) || null;
  },

  async best({ projectId, ctx }) {
    return (await thunderstore.versions({ projectId, ctx }))[0] || null;
  },

  /**
   * Unpack a downloaded zip into the server (instead of dropping it in the mods folder).
   * @returns {{file: string|null, files: string[], loader: boolean}}
   */
  async place({ server, ctx, temp, project, previous }) {
    const root = path.posix.dirname(String(ctx.dir || 'BepInEx/plugins').replace(/\\/g, '/'));
    const loader = Boolean(project.loader);
    const archive = zip.open(temp);
    try {
      const names = archive.names.filter((n) => !n.endsWith('/'));
      if (names.length > MAX_FILES) fail(400, `${project.name} has too many files (${names.length})`);
      const layout = mapLayout(names, { id: project.id, loader, root: root === '.' ? 'BepInEx' : root });
      if (!layout.length) fail(400, `${project.name} is empty`);

      // Read everything before touching the server, so a bad zip changes nothing.
      const staged = layout.map((item) => {
        const data = archive.read(item.from, MAX_FILE);
        if (!data) fail(400, `${project.name} contains a file that cannot be read (${item.from})`);
        return { ...item, data };
      });
      if (previous?.files) await removeFiles(server, previous.files);

      const written = [];
      for (const item of staged) {
        const target = containedPath(server.dir, item.to);
        // A config the owner already edited is theirs: a new release never overwrites it.
        if (item.config && fs.existsSync(target)) continue;
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, item.data);
        if (!item.config) written.push(item.to);
      }
      if (!loader) await fsp.mkdir(containedPath(server.dir, `${ctx.dir}/${project.id}`), { recursive: true });
      return { file: loader ? null : project.id, files: written, loader };
    } finally {
      archive.close();
    }
  },

  /** Delete what a package put in the server. */
  async removeEntry(server, ctx, entry) {
    await removeFiles(server, entry.files || []);
  },

  /** BepInEx loads every .dll under plugins, so a mod is switched off by renaming its dlls. */
  async toggleEntry(server, ctx, entry) {
    if (entry.loader) fail(400, 'The BepInEx loader cannot be switched off. Remove it instead (mods that need it will stop working).');
    const disabling = !entry.disabled;
    for (const rel of (entry.files || []).filter((f) => /\.dll$/i.test(f))) {
      const target = containedPath(server.dir, rel);
      const [from, to] = disabling ? [target, `${target}${DISABLED}`] : [`${target}${DISABLED}`, target];
      await fsp.rename(from, to).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
    return disabling;
  },
};

module.exports = thunderstore;
