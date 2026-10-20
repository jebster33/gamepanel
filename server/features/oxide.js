'use strict';

/**
 * Keeps uMod/Oxide matched to the game on Rust servers. A Rust update replaces
 * the game files Oxide patched, so the template's update steps put Oxide back
 * right after SteamCMD (see "update" in templates/rust.json). Oxide also ships
 * its own releases, often hours after the game on force-wipe day: the panel
 * remembers which release a server has (server.oxideTag) and, when a newer
 * one appears, updates it as soon as nobody is playing.
 */

const LATEST = 'https://api.github.com/repos/OxideMod/Oxide.Rust/releases/latest';
let cached = null; // { tag, at }

/** Does this server run Rust with Oxide installed? */
const enabled = (manager, server) => server.templateId === 'rust' && String(manager.vars(server).INSTALL_OXIDE) === 'true';

async function latestTag() {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.tag;
  const res = await fetch(LATEST, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'gamepanel' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the Oxide release`);
  const tag = (await res.json()).tag_name;
  if (!tag) throw new Error('the latest Oxide release has no tag');
  cached = { tag: String(tag), at: Date.now() };
  return cached.tag;
}

/** The template's "put Oxide back" step, with the server's variables filled in. */
function step(manager, server) {
  const template = manager.template(server);
  const found = (Array.isArray(template?.update) ? template.update : []).find((s) => s.id === 'oxide');
  return found || null;
}

/** Remember which Oxide release the server now has. Best effort: a failed lookup just leaves it unknown. */
async function record(manager, server) {
  server.oxideTag = await latestTag();
  manager.store.save();
}

module.exports = { enabled, latestTag, step, record };
