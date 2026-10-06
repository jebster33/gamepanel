'use strict';

/**
 * A CurseForge modpack, resolved into the same variables the Modrinth modpack
 * resolver produces, so the minecraft-modpack template installs either one.
 *
 * The pack zip carries manifest.json (Minecraft version, loader, and a list of
 * project/file ids). The panel reads it here, asks CurseForge where each file
 * lives, and hands the install script finished URLs. Needs the free API key
 * from Settings, Integrations.
 */

const API = 'https://api.curseforge.com/v1';
const UA = 'GamePanel/1.0 (+https://github.com/jebster33/gamepanel)';

async function cf(path, key, init = {}) {
  if (!key) throw new Error('add a CurseForge API key in Settings, Integrations (it is free at console.curseforge.com)');
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'x-api-key': key, 'User-Agent': UA, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`CurseForge answered ${res.status}`);
  return (await res.json()).data;
}

const cdnUrl = (f) => f.downloadUrl || `https://edge.forgecdn.net/files/${Math.floor(f.id / 1000)}/${f.id % 1000}/${encodeURIComponent(f.fileName)}`;

/** "forge-47.2.0" -> { name: "forge", version: "47.2.0" } */
function parseLoader(id = '') {
  const m = String(id).match(/^(forge|neoforge|fabric|quilt)-(.+)$/i);
  return m ? { name: m[1].toLowerCase(), version: m[2] } : null;
}

async function resolveCurseforgePack(vars, key, { readZipJson, loaderInstallScript, javaForMinecraft, shq }) {
  const projectId = String(vars.MODPACK || '').trim();
  if (!/^\d+$/.test(projectId)) throw new Error('pick a CurseForge modpack first');

  const project = await cf(`/mods/${projectId}`, key);
  let file;
  if (vars.MODPACK_VERSION) file = await cf(`/mods/${projectId}/files/${encodeURIComponent(vars.MODPACK_VERSION)}`, key);
  else {
    const files = await cf(`/mods/${projectId}/files?pageSize=30`, key);
    file = files.filter((f) => f.releaseType === 1).sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)))[0] || files[0];
  }
  if (!file) throw new Error(`"${project.name}" has no downloadable files`);
  const url = cdnUrl(file);

  const manifest = await readZipJson(url, 'manifest.json');
  const game = manifest.minecraft?.version;
  const loaderEntry = (manifest.minecraft?.modLoaders || []).find((l) => l.primary) || manifest.minecraft?.modLoaders?.[0];
  const loader = parseLoader(loaderEntry?.id);
  if (!game) throw new Error('the pack does not say which Minecraft version it needs');
  if (!loader) throw new Error('the pack uses a mod loader GamePanel cannot install yet');

  // Where each mod file lives.
  const ids = (manifest.files || []).map((f) => f.fileID);
  const found = [];
  for (let i = 0; i < ids.length; i += 100) {
    found.push(...(await cf('/mods/files', key, { method: 'POST', body: JSON.stringify({ fileIds: ids.slice(i, i + 100) }) })));
  }
  const files = found
    .filter((f) => /\.jar$/i.test(f.fileName))
    .map((f) => ({ url: cdnUrl(f), path: `mods/${f.fileName.replace(/[\\/]/g, '_')}` }));
  const missing = ids.length - found.length;
  const skipped = found.length - files.length;
  const downloads = files.map((f) => `gp_fetch ${shq(f.url)} ${shq(f.path)}`);
  const loaderInstall = await loaderInstallScript(loader, game);
  const page = project.links?.websiteUrl || `https://www.curseforge.com/minecraft/modpacks/${project.slug}`;

  return {
    DOWNLOAD_URL: url,
    RESOLVED_VERSION: `${manifest.name || project.name} ${manifest.version || file.displayName}`,
    PACK_NAME: manifest.name || project.name,
    PACK_SLUG: String(project.id),
    PACK_VERSION_NUMBER: manifest.version || file.displayName,
    PACK_URL: page,
    PACK_VERSION_URL: `${page}/files/${file.id}`,
    // CurseForge does not say which side a pack needs; players need it for any pack with client content.
    PACK_CLIENT_REQUIRED: 'true',
    PACK_ICON: project.logo?.thumbnailUrl || '',
    PACK_MC_VERSION: game,
    PACK_LOADER: `${loader.name} ${loader.version}`,
    PACK_FILE_COUNT: String(files.length),
    PACK_SKIPPED: String(skipped + missing),
    PACK_DOWNLOADS: downloads.join('\n') || 'gp_log "This pack ships no separate downloads"',
    PACK_FILES: JSON.stringify(files),
    LOADER_INSTALL: loaderInstall.install,
    LOADER_URL: loaderInstall.url,
    LOADER_FILE: loaderInstall.file,
    LOADER_RUN: loaderInstall.run,
    START_SCRIPT: loaderInstall.start,
    START_CMD: loaderInstall.startCmd,
    GAME_VERSION: game,
    LOADER: loader.name,
    JAVA_VERSION: String((await javaForMinecraft(game)) || 21),
  };
}

module.exports = { resolveCurseforgePack };
