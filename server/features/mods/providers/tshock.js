'use strict';

/**
 * tShock plugins for Terraria, found through GitHub: repositories tagged with
 * the "tshock-plugin" topic, installed from their newest release. A release
 * asset is either the plugin's .dll or a .zip holding one or more .dll files;
 * both end up in ServerPlugins/. tShock loads every *.dll in that folder, so
 * a plugin is switched off by renaming it to ".dll.disabled".
 *
 * A project id is "owner~repo" (GitHub names never contain "~", and a "/"
 * would not survive in a URL path).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { fail } = require('../../../core/util');
const zip = require('../../../core/zip');
const { getJson, safeFileName } = require('../http');
const { containedPath } = require('../../files');

const API = 'https://api.github.com';
const GH_HEADERS = { Accept: 'application/vnd.github+json' };
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_DLL = 64 * 1024 * 1024;
const PLUGIN_DIR = 'ServerPlugins';

function parseId(id) {
  const [owner, repo, extra] = String(id).split('~');
  if (extra !== undefined || !NAME.test(owner || '') || !NAME.test(repo || '')) fail(400, 'That is not a plugin from the catalogue');
  return { owner, repo };
}

/** The file to install out of a release: a .dll, else a .zip. */
function pickAsset(release) {
  const assets = (release.assets || []).filter((a) => a?.browser_download_url && /\.(dll|zip)$/i.test(a.name || ''));
  return assets.find((a) => /\.dll$/i.test(a.name)) || assets.find((a) => !/(source|src)/i.test(a.name)) || null;
}

function normalize(release, projectId) {
  const asset = pickAsset(release);
  return {
    id: String(release.id),
    projectId,
    name: release.name || release.tag_name,
    version: String(release.tag_name || release.name || release.id),
    channel: release.prerelease ? 'beta' : 'release',
    gameVersions: [],
    loaders: [],
    published: release.published_at,
    file: asset ? { url: asset.browser_download_url, filename: safeFileName(asset.name, 'plugin.dll'), size: asset.size } : null,
    dependencies: [],
  };
}

/** .dll files inside a zip: [{ name, data }] with plain names (folders in the zip are dropped). */
function dllsInZip(file) {
  const archive = zip.open(file);
  try {
    const out = [];
    for (const entry of archive.names) {
      if (entry.endsWith('/') || !/\.dll$/i.test(entry)) continue;
      const name = safeFileName(entry.split(/[\\/]/).pop(), '');
      if (!name || out.some((o) => o.name === name)) continue;
      const data = archive.read(entry, MAX_DLL);
      if (data && data.length > 64 && data[0] === 0x4d && data[1] === 0x5a) out.push({ name, data });
      if (out.length >= 25) break;
    }
    return out;
  } finally {
    archive.close();
  }
}

const tshock = {
  id: 'tshock',
  label: 'tShock plugins',
  needsKey: false,
  site: 'https://github.com/topics/tshock-plugin',
  parseId,
  dllsInZip,

  fits: (version) => Boolean(version?.file),

  async search({ query = '', page = 0, limit = 24 }) {
    const words = String(query).replace(/[^A-Za-z0-9 ._-]/g, ' ').trim();
    const q = `topic:tshock-plugin${words ? ` ${words} in:name,description` : ''}`;
    const params = new URLSearchParams({ q, sort: 'stars', order: 'desc', per_page: String(limit), page: String(page + 1) });
    const data = await getJson(`${API}/search/repositories?${params}`, GH_HEADERS);
    return {
      total: data.total_count ?? (data.items || []).length,
      items: (data.items || []).map((r) => ({
        provider: 'tshock',
        id: `${r.owner.login}~${r.name}`,
        slug: r.name,
        name: r.name,
        author: r.owner.login,
        description: r.description,
        downloads: r.stargazers_count,
        icon: r.owner.avatar_url || null,
        url: r.html_url,
        categories: ['tShock plugin'],
        updated: r.pushed_at,
        version: null,
      })),
    };
  },

  async project(id) {
    const { owner, repo } = parseId(id);
    const r = await getJson(`${API}/repos/${owner}/${repo}`, GH_HEADERS);
    return { id: `${owner}~${repo}`, slug: repo, name: r.name, icon: r.owner?.avatar_url || null, url: r.html_url, serverSupported: true };
  },

  async versions({ projectId }) {
    const { owner, repo } = parseId(projectId);
    const releases = await getJson(`${API}/repos/${owner}/${repo}/releases?per_page=15`, GH_HEADERS);
    return releases.filter((r) => !r.draft).map((r) => normalize(r, projectId)).filter((v) => v.file);
  },

  async version(versionId, { projectId }) {
    return (await tshock.versions({ projectId })).find((v) => v.id === String(versionId)) || null;
  },

  async best({ projectId }) {
    const list = await tshock.versions({ projectId });
    return list.find((v) => v.channel === 'release') || list[0] || null;
  },

  downloadError: (name) => `${name} has no .dll or .zip in its releases, so it cannot be installed from here.`,

  /** A .zip release: take the .dll files out of it. A plain .dll is moved into place by the installer. */
  async place({ server, temp, project, version, previous }) {
    if (!/\.zip$/i.test(version.file.filename || '')) return null;
    const dlls = dllsInZip(temp);
    if (!dlls.length) fail(400, `${project.name} has no plugin .dll inside its download`);
    if (previous?.files) await tshock.removeEntry(server, null, previous);
    await fsp.mkdir(containedPath(server.dir, PLUGIN_DIR), { recursive: true });
    const files = [];
    for (const { name, data } of dlls) {
      const rel = `${PLUGIN_DIR}/${name}`;
      await fsp.rm(containedPath(server.dir, `${rel}.disabled`), { force: true });
      await fsp.writeFile(containedPath(server.dir, rel), data);
      files.push(rel);
    }
    return { file: path.posix.basename(files[0]), files, loader: false };
  },

  async removeEntry(server, ctx, entry) {
    const files = entry.files?.length ? entry.files : entry.file ? [`${PLUGIN_DIR}/${String(entry.file).replace(/\.disabled$/, '')}`] : [];
    for (const rel of files) {
      const target = containedPath(server.dir, rel);
      await fsp.rm(target, { force: true });
      await fsp.rm(`${target}.disabled`, { force: true });
    }
  },

  async toggleEntry(server, ctx, entry) {
    const files = entry.files?.length ? entry.files : [`${PLUGIN_DIR}/${String(entry.file).replace(/\.disabled$/, '')}`];
    const disabling = !entry.disabled;
    for (const rel of files) {
      const target = containedPath(server.dir, rel);
      const [from, to] = disabling ? [target, `${target}.disabled`] : [`${target}.disabled`, target];
      if (fs.existsSync(from)) await fsp.rename(from, to);
    }
    return disabling;
  },
};

module.exports = tshock;
