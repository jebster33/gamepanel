'use strict';

/**
 * What changes when a modpack goes from one version to another: mods added,
 * removed and updated, and the Minecraft and loader versions. Read straight
 * from the two pack files (modrinth.index.json, or CurseForge's manifest.json),
 * so it is known before anything is installed.
 *
 * Mods are matched by project, not by file name, so "sodium-0.5.8.jar" and
 * "sodium-0.6.0.jar" count as one mod updated rather than one removed and
 * one added.
 */

const UA = 'GamePanel/1.0 (+https://github.com/jebster33/gamepanel)';
const cache = new Map(); // "source:project:version" -> contents (pack versions never change)

async function json(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

const fileName = (p) => String(p).split('/').pop();

async function modrinthContents(project, versionId) {
  const { readZipJson, detectLoader } = require('./resolvers');
  const version = await json(`https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`);
  if (version.project_id && project && version.project_id !== project) {
    // `project` may be a slug; compare through the project itself.
    const p = await json(`https://api.modrinth.com/v2/project/${encodeURIComponent(project)}`);
    if (p.id !== version.project_id) throw new Error('that version belongs to a different pack');
  }
  const file = version.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) || version.files.find((f) => f.filename.endsWith('.mrpack'));
  if (!file) throw new Error('that version has no .mrpack file');
  const index = await readZipJson(file.url, 'modrinth.index.json');
  const files = index.files || [];

  // Which Modrinth project each file is, from its hash.
  const hashes = files.map((f) => f.hashes?.sha1).filter(Boolean);
  const byHash = hashes.length
    ? await json('https://api.modrinth.com/v2/version_files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes, algorithm: 'sha1' }) }).catch(() => ({}))
    : {};
  const projectIds = [...new Set(Object.values(byHash).map((v) => v.project_id))];
  const names = new Map();
  for (let i = 0; i < projectIds.length; i += 200) {
    const batch = await json(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds.slice(i, i + 200)))}`).catch(() => []);
    for (const p of batch) names.set(p.id, p.title);
  }

  const mods = new Map();
  for (const f of files) {
    const known = byHash[f.hashes?.sha1];
    const key = known ? `mr:${known.project_id}` : `file:${f.path}`;
    mods.set(key, { name: (known && names.get(known.project_id)) || fileName(f.path), version: known?.version_number || fileName(f.path), path: f.path });
  }
  const loader = detectLoader(index.dependencies || {});
  return { name: index.name, version: index.versionId || version.version_number, minecraft: index.dependencies?.minecraft || null, loader: loader ? `${loader.name} ${loader.version}` : null, mods };
}

async function curseforgeContents(project, fileId, key) {
  if (!key) throw new Error('add a CurseForge API key in Settings, Integrations');
  const cf = (path, init = {}) => json(`https://api.curseforge.com/v1${path}`, { ...init, headers: { 'x-api-key': key, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } }).then((d) => d.data);
  const { readZipJson } = require('./resolvers');
  const file = await cf(`/mods/${encodeURIComponent(project)}/files/${encodeURIComponent(fileId)}`);
  const url = file.downloadUrl || `https://edge.forgecdn.net/files/${Math.floor(file.id / 1000)}/${file.id % 1000}/${encodeURIComponent(file.fileName)}`;
  const manifest = await readZipJson(url, 'manifest.json');
  const entries = manifest.files || [];
  const fileIds = entries.map((f) => f.fileID);
  const modIds = [...new Set(entries.map((f) => f.projectID))];
  const files = new Map();
  for (let i = 0; i < fileIds.length; i += 100) for (const f of await cf('/mods/files', { method: 'POST', body: JSON.stringify({ fileIds: fileIds.slice(i, i + 100) }) })) files.set(f.id, f);
  const names = new Map();
  for (let i = 0; i < modIds.length; i += 100) for (const m of await cf('/mods', { method: 'POST', body: JSON.stringify({ modIds: modIds.slice(i, i + 100) }) })) names.set(m.id, m.name);
  const mods = new Map();
  for (const e of entries) {
    const f = files.get(e.fileID);
    mods.set(`cf:${e.projectID}`, { name: names.get(e.projectID) || f?.displayName || `Project ${e.projectID}`, version: f?.displayName || f?.fileName || String(e.fileID) });
  }
  const loader = (manifest.minecraft?.modLoaders || []).find((l) => l.primary) || manifest.minecraft?.modLoaders?.[0];
  return { name: manifest.name, version: manifest.version || file.displayName, minecraft: manifest.minecraft?.version || null, loader: loader?.id?.replace('-', ' ') || null, mods };
}

async function contents({ source, project, version, key }) {
  const id = `${source}:${project}:${version}`;
  if (cache.has(id)) return cache.get(id);
  const result = source === 'curseforge' ? await curseforgeContents(project, version, key) : await modrinthContents(project, version);
  cache.set(id, result);
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return result;
}

/** The difference between two pack contents. */
function diff(from, to) {
  const added = [];
  const removed = [];
  const updated = [];
  let unchanged = 0;
  for (const [key, mod] of to.mods) {
    const before = from.mods.get(key);
    if (!before) added.push({ name: mod.name, version: mod.version });
    else if (before.version !== mod.version) updated.push({ name: mod.name, from: before.version, to: mod.version });
    else unchanged++;
  }
  for (const [key, mod] of from.mods) if (!to.mods.has(key)) removed.push({ name: mod.name, version: mod.version });
  const byName = (a, b) => a.name.localeCompare(b.name);
  return {
    from: { version: from.version, minecraft: from.minecraft, loader: from.loader },
    to: { version: to.version, minecraft: to.minecraft, loader: to.loader },
    added: added.sort(byName),
    removed: removed.sort(byName),
    updated: updated.sort(byName),
    unchanged,
  };
}

module.exports = { contents, diff };
