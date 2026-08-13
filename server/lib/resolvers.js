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

module.exports = { resolveDownload, RESOLVERS };
