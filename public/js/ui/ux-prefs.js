import { api } from '../core/api.js';
import { state } from '../core/state.js';

/* ------------------------------------------------------------ preferences */

/** The account's saved interface preferences (pins, folders, tags, dashboard layout, recent picks). */
const empty = () => ({ pinned: [], folders: [], tags: {}, widgets: { order: [], hidden: [] }, recent: [] });

export function prefs() {
  return (state.prefs ||= empty());
}

export async function loadPrefs() {
  try {
    const data = await api('/api/me/prefs');
    state.prefs = { ...empty(), ...data.prefs };
  } catch {
    state.prefs = empty();
  }
}

/** Changes show at once; the server keeps the cleaned copy. */
let queue = Promise.resolve();
export function savePrefs(patch) {
  Object.assign(prefs(), patch);
  queue = queue
    .then(() => api('/api/me/prefs', { method: 'PUT', body: patch }))
    .then((data) => {
      // Keep only what the server cleaned for the keys we sent.
      for (const key of Object.keys(patch)) state.prefs[key] = data.prefs[key];
    })
    .catch(() => {});
  return queue;
}

export const isPinned = (id) => prefs().pinned.includes(id);

export function togglePin(id) {
  const list = prefs().pinned;
  return savePrefs({ pinned: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
}

/** Servers the account can still see, pinned ones first (stable otherwise). */
export function pinnedFirst(servers) {
  const pins = prefs().pinned;
  return [...servers.filter((s) => pins.includes(s.id)), ...servers.filter((s) => !pins.includes(s.id))];
}

export function pinnedServers() {
  const byId = new Map(state.servers.map((s) => [s.id, s]));
  return prefs()
    .pinned.map((id) => byId.get(id))
    .filter(Boolean);
}

export function rememberRecent(kind, key, label) {
  const rest = prefs().recent.filter((r) => !(r.kind === kind && r.key === key));
  return savePrefs({ recent: [{ kind, key, label }, ...rest].slice(0, 10) });
}
