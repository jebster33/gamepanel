'use strict';

/**
 * Steam Workshop.
 *
 * Looking items up by ID needs no key (ISteamRemoteStorage). Searching, and
 * finding the items an item requires, use the Steam Web API and need a free
 * key in Settings → Integrations.
 *
 * How an item gets onto the server depends on the game (template
 * mods.workshop.strategy):
 *   copy     download with SteamCMD and copy the folder into the mod directory
 *   gma      Garry's Mod: download and drop the .gma into garrysmod/addons
 *   list     the game downloads Workshop items itself; add the ID to its config
 *            (Unturned's WorkshopDownloadConfig.json, ARK's ActiveMods)
 *   zomboid  Project Zomboid: WorkshopItems= and Mods= in the server ini
 */

const { fail } = require('../../../core/util');
const { getJson, UA, TIMEOUT } = require('../http');

const API = 'https://api.steampowered.com';

async function postForm(url, fields) {
  const body = new URLSearchParams(fields);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    fail(502, `Could not reach Steam: ${err.cause?.code || err.message}`);
  }
  if (!res.ok) fail(502, `Steam responded ${res.status}`);
  return res.json();
}

const indexed = (name, ids) => Object.fromEntries(ids.map((id, i) => [`${name}[${i}]`, String(id)]));

/** Keyless details for up to 100 items. */
async function details(ids) {
  if (!ids.length) return [];
  const data = await postForm(`${API}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`, {
    itemcount: String(ids.length),
    ...indexed('publishedfileids', ids),
  });
  return (data.response?.publishedfiledetails || []).map((d) => ({
    id: String(d.publishedfileid),
    ok: d.result === 1,
    title: d.title || `Workshop item ${d.publishedfileid}`,
    appId: String(d.consumer_app_id || ''),
    description: d.description || '',
    icon: d.preview_url || null,
    size: Number(d.file_size) || 0,
    updated: Number(d.time_updated) || 0,
    url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${d.publishedfileid}`,
  }));
}

/** The items inside a collection, or null when the ID is not a collection. */
async function collection(id) {
  const data = await postForm(`${API}/ISteamRemoteStorage/GetCollectionDetails/v1/`, {
    collectioncount: '1',
    'publishedfileids[0]': String(id),
  });
  const entry = data.response?.collectiondetails?.[0];
  if (!entry || entry.result !== 1 || !entry.children?.length) return null;
  return entry.children.map((c) => String(c.publishedfileid));
}

/** Items that an item says it requires (needs a Web API key). */
async function requiredItems(ids, apiKey) {
  if (!apiKey || !ids.length) return new Map();
  const params = new URLSearchParams({ key: apiKey, includechildren: 'true', ...indexed('publishedfileids', ids) });
  const data = await getJson(`${API}/IPublishedFileService/GetDetails/v1/?${params}`).catch(() => null);
  const out = new Map();
  for (const d of data?.response?.publishedfiledetails || []) {
    out.set(String(d.publishedfileid), (d.children || []).map((c) => String(c.publishedfileid)));
  }
  return out;
}

/** Pull Workshop IDs out of pasted text: IDs, item URLs, several separated by commas or spaces. */
function parseIds(input) {
  const text = String(input || '');
  const ids = new Set();
  for (const m of text.matchAll(/[?&]id=(\d{4,})/g)) ids.add(m[1]);
  if (!ids.size) for (const m of text.matchAll(/\b(\d{4,})\b/g)) ids.add(m[1]);
  if (!ids.size) fail(400, 'Paste a Workshop item or collection link, or its numeric ID');
  return [...ids];
}

/** Project Zomboid uploads add "Mod ID: xyz" lines to the description. */
function zomboidModIds(description) {
  const ids = new Set();
  for (const m of String(description || '').matchAll(/Mod ?ID:\s*([^\r\n\[<]+)/gi)) {
    for (const part of m[1].split(/[;,]/)) {
      const id = part.trim();
      if (id && id.length < 120) ids.add(id);
    }
  }
  return [...ids];
}

const workshop = {
  id: 'workshop',
  label: 'Steam Workshop',
  needsKey: false, // installing by ID works without one; searching does not
  site: 'https://steamcommunity.com/workshop',
  viaSteamcmd: true,

  async search({ query = '', page = 0, limit = 24, ctx, apiKey }) {
    if (!apiKey) {
      fail(400, 'Searching the Workshop needs a free Steam Web API key (Settings → Integrations). You can still paste any item or collection link below.');
    }
    const params = new URLSearchParams({
      key: apiKey,
      appid: String(ctx.appId || ''),
      search_text: query,
      page: String(page + 1),
      numperpage: String(limit),
      return_metadata: 'true',
      return_previews: 'true',
      query_type: query ? '12' : '9', // 12 = relevance, 9 = most subscribed
      filetype: '0', // items only, not collections or guides
    });
    const data = await getJson(`${API}/IPublishedFileService/QueryFiles/v1/?${params}`);
    return {
      total: data.response?.total ?? 0,
      items: (data.response?.publishedfiledetails || []).map((item) => ({
        provider: 'workshop',
        id: String(item.publishedfileid),
        name: item.title,
        author: item.creator,
        description: (item.short_description || item.file_description || '').slice(0, 220),
        downloads: item.lifetime_subscriptions || item.subscriptions,
        icon: item.preview_url || null,
        url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`,
        categories: (item.tags || []).map((t) => t.tag || t.display_name).filter(Boolean).slice(0, 4),
        updated: item.time_updated ? new Date(item.time_updated * 1000).toISOString() : null,
      })),
    };
  },

  async versions() {
    return [{ id: 'latest', name: 'Current Workshop version', version: 'latest', channel: 'release' }];
  },

  details,
  collection,
  requiredItems,
  parseIds,
  zomboidModIds,
};

module.exports = workshop;
