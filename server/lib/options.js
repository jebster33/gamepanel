'use strict';

/**
 * Live option lists for template dropdowns.
 *
 * Templates declare `"source": "<id>"` on a variable and the deploy form turns
 * it into a select populated from here, with the newest usable choice marked
 * as recommended. Everything is cached briefly and fails soft — the form falls
 * back to a plain text field if a provider is unreachable.
 */

const { logger } = require('./util');

const UA = 'GamePanel/1.0 (+https://github.com/jebster33/gamepanel)';
const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;

const cache = new Map();

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} responded ${res.status}`);
  return res.json();
}

/** Sort Minecraft-style versions newest first ("1.21.11" > "1.21.9"). */
function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return nb - na;
    } else {
      const sa = pa[i] ?? '';
      const sb = pb[i] ?? '';
      if (sa !== sb) return sa < sb ? 1 : -1;
    }
  }
  return 0;
}

const isPrerelease = (version) => /-(rc|pre|snapshot|exp)/i.test(String(version));

const PROVIDERS = {
  /** Mojang's own release list, newest first. */
  'minecraft-release': async () => {
    const data = await getJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const latest = data.latest?.release;
    const options = data.versions
      .filter((v) => v.type === 'release')
      .slice(0, 60)
      .map((v) => ({ value: v.id, label: v.id, recommended: v.id === latest }));
    return { options, recommended: latest };
  },

  /** PaperMC builds (v3 "fill" API — v2 was sunset). */
  'paper-version': async () => {
    const data = await getJson('https://fill.papermc.io/v3/projects/paper');
    const all = Object.values(data.versions || {}).flat();
    const stable = all.filter((v) => !isPrerelease(v)).sort(compareVersions);
    const newest = stable[0];
    return {
      options: stable.slice(0, 60).map((v) => ({ value: v, label: v, recommended: v === newest })),
      recommended: newest,
    };
  },

  /** Fabric's stable game versions. */
  'fabric-game-version': async () => {
    const data = await getJson('https://meta.fabricmc.net/v2/versions/game');
    const stable = data.filter((v) => v.stable).map((v) => v.version);
    const newest = stable[0];
    return {
      options: stable.slice(0, 60).map((v) => ({ value: v, label: v, recommended: v === newest })),
      recommended: newest,
    };
  },

  /** Fabric loader builds; the API flags the current stable one. */
  'fabric-loader': async () => {
    const data = await getJson('https://meta.fabricmc.net/v2/versions/loader');
    const stable = data.find((v) => v.stable)?.version || data[0]?.version;
    return {
      options: data.slice(0, 40).map((v) => ({
        value: v.version,
        label: v.version,
        recommended: v.version === stable,
        note: v.version === stable ? 'Current stable loader' : undefined,
      })),
      recommended: stable,
    };
  },

  /**
   * Bedrock dedicated server builds. Mojang publishes no index, so this uses
   * the community-maintained Bedrock-OSS list, which tracks the same CDN the
   * installer downloads from.
   */
  'bedrock-version': async () => {
    const data = await getJson('https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json');
    const linux = data.linux || {};
    const releases = [...(linux.versions || [])].reverse().slice(0, 40);
    const stable = linux.stable;
    const options = releases.map((v) => ({
      value: v,
      label: v,
      recommended: v === stable,
      note: v === stable ? 'Current stable release' : undefined,
    }));
    if (linux.preview) {
      options.unshift({ value: linux.preview, label: `${linux.preview} (preview)`, note: 'Preview build — expect bugs' });
    }
    return { options, recommended: stable || releases[0] };
  },

  /** Terraria publishes the current dedicated-server zip name; derive builds. */
  'terraria-build': async () => {
    const names = await getJson('https://terraria.org/api/get/dedicated-servers-names');
    const builds = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n).match(/(\d+)\.zip$/)?.[1]).filter(Boolean))];
    const newest = builds[0];
    const pretty = (build) => {
      // 1449 -> 1.4.4.9
      const digits = String(build).split('');
      return digits.length === 4 ? `${digits[0]}.${digits[1]}.${digits[2]}.${digits[3]}` : String(build);
    };
    const options = builds.map((b) => ({
      value: b,
      label: `${pretty(b)} (build ${b})`,
      recommended: b === newest,
      note: b === newest ? 'Current release' : undefined,
    }));
    if (!options.length) throw new Error('no builds listed');
    return { options, recommended: newest };
  },

  /** Cfx.re artifact channels, with the build number each currently points at. */
  'fivem-build': async () => {
    const data = await getJson('https://changelogs-live.fivem.net/api/changelog/versions/linux/server');
    return {
      options: [
        {
          value: 'recommended',
          label: `Recommended — build ${data.recommended}`,
          note: 'The build Cfx.re advises for production servers',
          recommended: true,
        },
        { value: 'latest', label: `Latest — build ${data.latest}`, note: 'Newest artifacts, may be untested' },
      ],
      recommended: 'recommended',
    };
  },

  /** Popular Modrinth modpacks, newest-and-biggest first. */
  'modrinth-modpack': async (query) => {
    const params = new URLSearchParams({
      query: query || '',
      limit: '60',
      index: query ? 'relevance' : 'downloads',
      facets: JSON.stringify([['project_type:modpack']]),
    });
    const data = await getJson(`https://api.modrinth.com/v2/search?${params}`);
    const options = data.hits.map((hit) => ({
      value: hit.slug,
      label: `${hit.title} — ${Number(hit.downloads).toLocaleString()} downloads`,
      note: hit.description,
    }));
    if (options.length) options[0].recommended = true;
    return { options, recommended: options[0]?.value, searchable: true };
  },

  /** Versions of one modpack; driven by whichever pack is selected. */
  'modrinth-modpack-version': async (query) => {
    if (!query) return { options: [], error: 'Pick a modpack first' };
    const versions = await getJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(query)}/version`);
    const usable = versions.filter((v) => v.files?.some((f) => f.filename.endsWith('.mrpack')));
    const newest = usable[0];
    return {
      options: usable.slice(0, 40).map((v) => ({
        value: v.id,
        label: `${v.version_number} — MC ${(v.game_versions || []).join(', ')}${
          v.version_type !== 'release' ? ` (${v.version_type})` : ''
        }`,
        note: (v.loaders || []).join(', '),
        recommended: v.id === newest?.id,
      })),
      recommended: newest?.id,
    };
  },

  /** Factorio release channels. */
  'factorio-channel': async () => ({
    options: [
      { value: 'stable', label: 'Stable', recommended: true },
      { value: 'latest', label: 'Experimental' },
    ],
    recommended: 'stable',
  }),
};

/**
 * @param {string} source provider id
 * @param {string} [query] refines the list — a search term, or the value of a
 *   field this one depends on (a modpack's versions need the modpack)
 */
async function getOptions(source, query = '') {
  const provider = PROVIDERS[source];
  if (!provider) return { options: [], error: `Unknown option source: ${source}` };

  const key = query ? `${source}:${query}` : source;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  try {
    const value = await provider(query);
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    logger.warn(`Option source "${key}" failed: ${err.message}`);
    // Serve a stale list rather than nothing if we ever had one.
    if (cached) return { ...cached.value, stale: true };
    return { options: [], error: `Could not load choices: ${err.message}` };
  }
}

module.exports = { getOptions, SOURCES: Object.keys(PROVIDERS) };
