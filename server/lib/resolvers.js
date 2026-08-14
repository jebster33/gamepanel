'use strict';

/**
 * Download resolution, performed by the panel rather than by the install
 * script.
 *
 * Install scripts run inside the game's own container, which has no Node and
 * no jq — so anything that requires reading JSON has to happen here. Each
 * resolver returns extra template variables (usually DOWNLOAD_URL and
 * RESOLVED_VERSION) that the script can then use with a plain gp_fetch.
 */

const { fail, logger } = require('./util');

const UA = 'GamePanel/1.0 (+https://github.com/jebster33/gamepanel)';
const TIMEOUT_MS = 15000;

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
  return res.json();
}

const isPrerelease = (version) => /-(rc|pre|snapshot|exp)/i.test(String(version));
const wantsLatest = (value) => !value || String(value).toLowerCase() === 'latest';

const javaCache = new Map();

/**
 * Which Java a given Minecraft release needs. Mojang states this in the
 * version metadata (`javaVersion.majorVersion`), and it moves — 1.20 wanted
 * 17, later releases want 21, and current ones want 25. Guessing it wrong
 * produces an UnsupportedClassVersionError at boot, so ask rather than pin.
 */
async function javaForMinecraft(id) {
  if (!id) return null;
  if (javaCache.has(id)) return javaCache.get(id);
  try {
    const manifest = await getJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const entry = manifest.versions.find((v) => v.id === id);
    if (!entry) return null;
    const detail = await getJson(entry.url);
    const major = detail.javaVersion?.majorVersion || null;
    javaCache.set(id, major);
    return major;
  } catch (err) {
    logger.debug(`could not read the Java requirement for ${id}: ${err.message}`);
    return null;
  }
}

const RESOLVERS = {
  /** PaperMC: pick a version, then its newest stable build. */
  async paper(vars) {
    let version = vars.MC_VERSION;
    if (wantsLatest(version)) {
      const project = await getJson('https://fill.papermc.io/v3/projects/paper');
      const all = Object.values(project.versions || {}).flat();
      version = all.find((v) => !isPrerelease(v));
    }
    if (!version) throw new Error('could not work out which Minecraft version to install');

    const data = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
    const builds = Array.isArray(data) ? data : data.builds || [];
    const stable = builds.filter((b) => b.channel === 'STABLE');
    const build = (stable.length ? stable : builds)[0];
    const url = build?.downloads?.['server:default']?.url;
    if (!url) throw new Error(`no Paper build published for ${version}`);
    return {
      DOWNLOAD_URL: url,
      RESOLVED_VERSION: version,
      RESOLVED_BUILD: String(build.id ?? ''),
      JAVA_VERSION: String((await javaForMinecraft(version)) || 21),
    };
  },

  /** Mojang's own server jar for a release. */
  async vanilla(vars) {
    const manifest = await getJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const id = wantsLatest(vars.MC_VERSION) ? manifest.latest.release : vars.MC_VERSION;
    const entry = manifest.versions.find((v) => v.id === id);
    if (!entry) throw new Error(`unknown Minecraft version "${id}"`);
    const detail = await getJson(entry.url);
    const url = detail.downloads?.server?.url;
    if (!url) throw new Error(`Minecraft ${id} has no dedicated server download`);
    return {
      DOWNLOAD_URL: url,
      RESOLVED_VERSION: id,
      JAVA_VERSION: String(detail.javaVersion?.majorVersion || 21),
    };
  },

  /** Fabric's prebuilt server launcher for game + loader + installer. */
  async fabric(vars) {
    let game = vars.MC_VERSION;
    if (wantsLatest(game)) {
      const games = await getJson('https://meta.fabricmc.net/v2/versions/game');
      game = games.find((v) => v.stable)?.version;
    }
    let loader = vars.LOADER_VERSION;
    if (wantsLatest(loader)) {
      const loaders = await getJson('https://meta.fabricmc.net/v2/versions/loader');
      loader = (loaders.find((v) => v.stable) || loaders[0])?.version;
    }
    const installers = await getJson('https://meta.fabricmc.net/v2/versions/installer');
    const installer = (installers.find((v) => v.stable) || installers[0])?.version;
    if (!game || !loader || !installer) throw new Error('could not resolve the Fabric version combination');

    return {
      DOWNLOAD_URL: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(game)}/${encodeURIComponent(
        loader
      )}/${encodeURIComponent(installer)}/server/jar`,
      RESOLVED_VERSION: `${game} (loader ${loader})`,
      JAVA_VERSION: String((await javaForMinecraft(game)) || 21),
    };
  },

  /** Bedrock dedicated server zip from Mojang's CDN. */
  async bedrock(vars) {
    let version = vars.BEDROCK_VERSION;
    if (wantsLatest(version)) {
      const index = await getJson('https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json');
      version = index.linux?.stable;
    }
    if (!version) throw new Error('could not work out the current Bedrock version');
    return {
      DOWNLOAD_URL: `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${version}.zip`,
      RESOLVED_VERSION: version,
    };
  },

  /** Terraria's dedicated server zip. */
  async terraria(vars) {
    let build = vars.TERRARIA_BUILD;
    if (wantsLatest(build)) {
      const names = await getJson('https://terraria.org/api/get/dedicated-servers-names');
      build = String(names?.[0] || '').match(/(\d+)\.zip$/)?.[1];
    }
    if (!build) throw new Error('could not work out the current Terraria build');
    return {
      DOWNLOAD_URL: `https://terraria.org/api/download/pc-dedicated-server/terraria-server-${build}.zip`,
      RESOLVED_VERSION: build,
      RESOLVED_BUILD: String(build),
    };
  },

  /**
   * A Modrinth modpack (.mrpack).
   *
   * The pack index is JSON inside a zip, which the container cannot read, so
   * the panel unpacks the index here and hands the install script a finished
   * list of downloads, a loader install snippet and a start script.
   */
  async 'modrinth-modpack'(vars) {
    const slug = String(vars.MODPACK || '').trim();
    if (!slug) throw new Error('no modpack selected');

    const versions = await getJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version`);
    const usable = versions.filter((v) => v.files?.some((f) => f.filename.endsWith('.mrpack')));
    if (!usable.length) throw new Error(`"${slug}" has no server-installable versions`);
    const version = (vars.MODPACK_VERSION && usable.find((v) => v.id === vars.MODPACK_VERSION)) || usable[0];
    const file = version.files.find((f) => f.primary && f.filename.endsWith('.mrpack')) ||
      version.files.find((f) => f.filename.endsWith('.mrpack'));

    // Read the pack index straight out of the zip.
    const index = await readMrpackIndex(file.url);
    const game = index.dependencies?.minecraft;
    const loader = detectLoader(index.dependencies);

    // Whether players have to install the pack locally, and where they get it.
    const project = await getJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}`).catch(() => ({}));
    if (!game) throw new Error('the pack does not say which Minecraft version it needs');
    if (!loader) throw new Error('the pack uses a mod loader GamePanel cannot install yet');

    // Client-only mods crash a dedicated server (Forge and NeoForge abort the
    // whole load). `env` is optional in the mrpack spec, so anything the pack
    // did not label gets looked up on Modrinth by file hash before we decide.
    const wanted = await filterServerFiles(index.files || []);
    const skipped = (index.files || []).length - wanted.length;

    const downloads = wanted
      .map((entry) => {
        const target = String(entry.path).replace(/^[/\\]+/, '');
        if (target.includes('..')) return null;
        const url = entry.downloads?.[0];
        if (!url) return null;
        return `mkdir -p "$(dirname ${shq(target)})"\ngp_fetch ${shq(url)} ${shq(target)}`;
      })
      .filter(Boolean);

    const loaderInstall = await loaderInstallScript(loader, game);

    return {
      DOWNLOAD_URL: file.url,
      MRPACK_FILE: file.filename,
      RESOLVED_VERSION: `${index.name || slug} ${index.versionId || version.version_number}`,
      PACK_NAME: index.name || project.title || slug,
      PACK_SLUG: project.slug || slug,
      PACK_VERSION_NUMBER: version.version_number,
      PACK_URL: `https://modrinth.com/modpack/${project.slug || slug}`,
      PACK_VERSION_URL: `https://modrinth.com/modpack/${project.slug || slug}/version/${encodeURIComponent(
        version.version_number
      )}`,
      PACK_CLIENT_REQUIRED: String(project.client_side !== 'unsupported'),
      PACK_ICON: project.icon_url || '',
      PACK_MC_VERSION: game,
      PACK_LOADER: `${loader.name} ${loader.version}`,
      PACK_FILE_COUNT: String(downloads.length),
      PACK_SKIPPED: String(skipped),
      PACK_DOWNLOADS:
        (downloads.join('\n') || 'gp_log "This pack ships no separate downloads"') +
        (skipped ? `\ngp_log "Skipped ${skipped} client-only mod(s) — they would crash a dedicated server"` : ''),
      LOADER_INSTALL: loaderInstall.install,
      START_SCRIPT: loaderInstall.start,
      JAVA_VERSION: String((await javaForMinecraft(game)) || 21),
    };
  },

  /** Cfx.re server artifacts for the chosen channel. */
  async fivem(vars) {
    const data = await getJson('https://changelogs-live.fivem.net/api/changelog/versions/linux/server');
    const latest = String(vars.FIVEM_BUILD || 'recommended').toLowerCase() === 'latest';
    const url = latest ? data.latest_download : data.recommended_download;
    if (!url) throw new Error('Cfx.re did not return an artifact download');
    return { DOWNLOAD_URL: url, RESOLVED_VERSION: latest ? data.latest : data.recommended };
  },
};

/**
 * @param {string} name  resolver id from the template's `resolve` field
 * @param {object} vars  the server's resolved template variables
 * @returns {Promise<Record<string,string>>} extra variables for the install script
 */
async function resolveDownload(name, vars) {
  const resolver = RESOLVERS[name];
  if (!resolver) fail(400, `Template refers to an unknown resolver: ${name}`);
  try {
    const extra = await resolver(vars);
    logger.info(`Resolved ${name} download: ${extra.RESOLVED_VERSION || ''} ${extra.DOWNLOAD_URL}`);
    return extra;
  } catch (err) {
    // Surfaced in the install console, so the message has to make sense there.
    throw new Error(`Could not work out what to download: ${err.message}`);
  }
}

/* ------------------------------------------------------------- modpacks -- */

const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Pull modrinth.index.json out of a .mrpack without a zip library: read the
 * end-of-central-directory, find the entry, then inflate it.
 */
async function readMrpackIndex(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`could not download the modpack (${res.status})`);
  const zip = Buffer.from(await res.arrayBuffer());

  // End of central directory: signature 0x06054b50, scanned from the tail.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i > zip.length - 66000; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('the modpack file is not a valid zip');

  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) break;
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (name === 'modrinth.index.json') {
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = zip.subarray(start, start + compressedSize);
      const zlib = require('zlib');
      const json = method === 0 ? raw : zlib.inflateRawSync(raw);
      return JSON.parse(json.toString('utf8'));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('the modpack has no modrinth.index.json');
}

/**
 * Decide which of a pack's files belong on a dedicated server.
 *
 * The pack's own `env` block wins when present. For the rest, Modrinth is
 * asked in bulk — hashes to versions, versions to projects — and any project
 * marked `server_side: unsupported` is dropped. Getting this wrong is not
 * cosmetic: a single client mod aborts a Forge/NeoForge server at boot.
 */
async function filterServerFiles(files) {
  const explicit = [];
  const unknown = [];
  for (const file of files) {
    const env = file.env?.server;
    if (env === 'unsupported') continue;
    if (env) explicit.push(file);
    else unknown.push(file);
  }
  if (!unknown.length) return explicit;

  const sides = new Map();
  try {
    const hashes = unknown.map((f) => f.hashes?.sha512).filter(Boolean);
    const hashToProject = new Map();

    for (const batch of chunk(hashes, 100)) {
      const res = await fetch('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: batch, algorithm: 'sha512' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`version lookup failed (${res.status})`);
      const found = await res.json();
      for (const [hash, version] of Object.entries(found)) hashToProject.set(hash, version.project_id);
    }

    const ids = [...new Set([...hashToProject.values()])];
    for (const batch of chunk(ids, 100)) {
      const projects = await getJson(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`
      );
      for (const project of projects) sides.set(project.id, project.server_side);
    }

    for (const file of unknown) {
      const projectId = hashToProject.get(file.hashes?.sha512);
      const side = projectId ? sides.get(projectId) : null;
      if (side !== 'unsupported') explicit.push(file);
    }
    return explicit;
  } catch (err) {
    // If the lookup fails, keep everything rather than silently gutting a pack.
    logger.warn(`Could not check which pack files are server-safe: ${err.message}`);
    return [...explicit, ...unknown];
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Which loader a pack wants, from its dependency map. */
function detectLoader(dependencies = {}) {
  const map = [
    ['fabric-loader', 'fabric'],
    ['quilt-loader', 'quilt'],
    ['neoforge', 'neoforge'],
    ['forge', 'forge'],
  ];
  for (const [key, name] of map) {
    if (dependencies[key]) return { name, version: dependencies[key] };
  }
  return null;
}

/**
 * Shell to install a loader's server, plus the start script that suits it.
 * Fabric and Quilt publish a ready-made launcher jar; Forge and NeoForge ship
 * an installer that generates run.sh.
 */
async function loaderInstallScript(loader, game) {
  const memory = '${MEMORY:-2048}';

  if (loader.name === 'fabric' || loader.name === 'quilt') {
    const base = loader.name === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
    const installers = await getJson(`${base}/versions/installer`);
    const installer = (installers.find((v) => v.stable) || installers[0])?.version;
    const url = `${base}/versions/loader/${encodeURIComponent(game)}/${encodeURIComponent(
      loader.version
    )}/${encodeURIComponent(installer)}/server/jar`;
    return {
      install: `gp_fetch ${shq(url)} server.jar`,
      start: `#!/usr/bin/env bash\nexec java -Xms${memory}M -Xmx${memory}M \${JAVA_ARGS:-} -jar server.jar nogui\n`,
    };
  }

  if (loader.name === 'neoforge') {
    const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loader.version}/neoforge-${loader.version}-installer.jar`;
    return {
      install: [
        `gp_fetch ${shq(url)} loader-installer.jar`,
        'gp_log "Running the NeoForge installer"',
        'java -jar loader-installer.jar --installServer || gp_die "The NeoForge installer failed"',
        'rm -f loader-installer.jar',
        `printf -- '-Xms%sM\\n-Xmx%sM\\n' "\${MEMORY:-2048}" "\${MEMORY:-2048}" > user_jvm_args.txt`,
      ].join('\n'),
      start: `#!/usr/bin/env bash\nprintf -- '-Xms%sM\\n-Xmx%sM\\n' "\${MEMORY:-2048}" "\${MEMORY:-2048}" > user_jvm_args.txt\nexec ./run.sh nogui\n`,
    };
  }

  // Forge
  const full = `${game}-${loader.version}`;
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  return {
    install: [
      `gp_fetch ${shq(url)} loader-installer.jar`,
      'gp_log "Running the Forge installer"',
      'java -jar loader-installer.jar --installServer || gp_die "The Forge installer failed"',
      'rm -f loader-installer.jar',
    ].join('\n'),
    start:
      `#!/usr/bin/env bash\n` +
      `printf -- '-Xms%sM\\n-Xmx%sM\\n' "\${MEMORY:-2048}" "\${MEMORY:-2048}" > user_jvm_args.txt\n` +
      `if [ -f run.sh ]; then exec ./run.sh nogui; fi\n` +
      `exec java -Xms\${MEMORY:-2048}M -Xmx\${MEMORY:-2048}M -jar "$(ls forge-*.jar | head -1)" nogui\n`,
  };
}

module.exports = { resolveDownload, RESOLVERS, readMrpackIndex, detectLoader };
