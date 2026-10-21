'use strict';

/**
 * Nexus Mods links. Nexus has no server-side install the panel can use
 * without an account, so this is only a catalogue of each game's page name
 * ("nexusmods.com/<domain>") and a search link. Nothing is fetched.
 * Domains are best-known names; a wrong one lands on a Nexus 404, not
 * anything unsafe, because only the fixed domains below are ever linked.
 */

const SITE = 'https://www.nexusmods.com';

/** template id -> { domain, name } */
const GAMES = {
  'seven-days-to-die': { domain: '7daystodie', name: '7 Days to Die' },
  'project-zomboid': { domain: 'projectzomboid', name: 'Project Zomboid' },
  terraria: { domain: 'terraria', name: 'Terraria' },
  valheim: { domain: 'valheim', name: 'Valheim' },
  'v-rising': { domain: 'vrising', name: 'V Rising' },
  palworld: { domain: 'palworld', name: 'Palworld' },
  enshrouded: { domain: 'enshrouded', name: 'Enshrouded' },
  'conan-exiles': { domain: 'conanexiles', name: 'Conan Exiles' },
  'ark-survival-evolved': { domain: 'arksurvivalevolved', name: 'ARK: Survival Evolved' },
  'ark-survival-ascended': { domain: 'arksurvivalascended', name: 'ARK: Survival Ascended' },
  satisfactory: { domain: 'satisfactory', name: 'Satisfactory' },
  'space-engineers': { domain: 'spaceengineers', name: 'Space Engineers' },
  'killing-floor-2': { domain: 'killingfloor2', name: 'Killing Floor 2' },
  arma3: { domain: 'arma3', name: 'Arma 3' },
  'arma-reforger': { domain: 'armareforger', name: 'Arma Reforger' },
  'dont-starve-together': { domain: 'dontstarvetogether', name: "Don't Starve Together" },
  left4dead2: { domain: 'left4dead2', name: 'Left 4 Dead 2' },
  garrysmod: { domain: 'garrysmod', name: "Garry's Mod" },
  tf2: { domain: 'teamfortress2', name: 'Team Fortress 2' },
  cs2: { domain: 'counterstrike2', name: 'Counter-Strike 2' },
  icarus: { domain: 'icarus', name: 'Icarus' },
  'core-keeper': { domain: 'corekeeper', name: 'Core Keeper' },
  'sons-of-the-forest': { domain: 'sonsoftheforest', name: 'Sons of the Forest' },
  soulmask: { domain: 'soulmask', name: 'Soulmask' },
  'abiotic-factor': { domain: 'abioticfactor', name: 'Abiotic Factor' },
  barotrauma: { domain: 'barotrauma', name: 'Barotrauma' },
  factorio: { domain: 'factorio', name: 'Factorio' },
  mordhau: { domain: 'mordhau', name: 'Mordhau' },
  empyrion: { domain: 'empyriongalacticsurvival', name: 'Empyrion: Galactic Survival' },
  avorion: { domain: 'avorion', name: 'Avorion' },
  'insurgency-sandstorm': { domain: 'insurgencysandstorm', name: 'Insurgency: Sandstorm' },
  necesse: { domain: 'necesse', name: 'Necesse' },
  rust: { domain: 'rust', name: 'Rust' },
  tmodloader: { domain: 'terraria', name: 'Terraria' },
};
for (const id of ['minecraft-vanilla', 'minecraft-paper', 'minecraft-purpur', 'minecraft-fabric', 'minecraft-forge', 'minecraft-neoforge', 'minecraft-quilt', 'minecraft-velocity', 'minecraft-modpack', 'minecraft-bedrock']) {
  GAMES[id] = { domain: 'minecraft', name: 'Minecraft' };
}

const DOMAIN = /^[a-z0-9]{1,48}$/;

const searchUrl = (domain, query) => `${SITE}/${domain}/search/?${new URLSearchParams({ gsearch: String(query || '').slice(0, 100), gsearchtype: 'mods' })}`;

/** Links for a template, or null when the catalogue has no entry. */
function forTemplate(templateId) {
  const game = GAMES[templateId];
  if (!game || !DOMAIN.test(game.domain)) return null;
  return { domain: game.domain, name: game.name, url: `${SITE}/${game.domain}`, mods: `${SITE}/${game.domain}/mods/`, searchUrl: searchUrl(game.domain, '') };
}

/** The whole catalogue, for a picker. */
function catalogue() {
  return Object.entries(GAMES).map(([id, g]) => ({ id, ...g, url: `${SITE}/${g.domain}` }));
}

module.exports = { forTemplate, catalogue, searchUrl, GAMES, SITE };
