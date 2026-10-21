/* ---------------------------------------------------------- onboarding core */

// The data and the plain logic behind the tour, the getting-started checklist
// and the per-game tips. No DOM and no imports, so it can be unit tested.

/** The tour of the whole panel. `needs` names a selector that must be on screen. */
export const PANEL_STEPS = [
  { sel: '#nav [data-page="dashboard"]', title: 'Dashboard', text: 'How the machine is doing, every server at a glance, and a checklist for a fresh panel.' },
  { sel: '#nav [data-page="servers"]', title: 'Servers', text: 'All your servers in one list, with their status, players and a Start or Stop button each.' },
  { sel: '#nav [data-page="templates"]', title: 'Games', text: 'Pick a game here. The panel downloads it, gives it free ports and starts it, usually within a few minutes.' },
  { sel: '#sidebar-server-list', title: 'Your servers', text: 'Each server has its console, players, files, mods, backups and schedules on its own page.' },
  { sel: '#new-server-btn', title: 'New server', text: 'The shortcut to the Games page. From the keyboard, press n.' },
  { sel: '#nav [data-page="activity"]', title: 'Activity', text: 'Who did what and when: sign-ins, restarts, file changes and crashes.' },
  { sel: '#bell-btn', title: 'Notifications', text: 'Crashes, finished installs, backups and sign-ins show up here, with a pop-up for the important ones.' },
  { sel: '#nav [data-page="users"]', title: 'Users', text: 'Give friends an account with exactly the servers and permissions you choose, or let them create their own servers within a quota.' },
  { sel: '#nav [data-page="nodes"]', title: 'Nodes', text: 'Run servers on other machines and manage them from this one panel.' },
  { sel: '#nav [data-page="settings"]', title: 'Settings', text: 'Alerts to Discord, cloud backups, the public server list, limits and panel updates.' },
  { sel: '.user-link', title: 'Your account', text: 'Turn on two-factor sign-in here, pick a language, reopen the getting-started checklist and take this tour again any time.' },
];

/** The tour of one server's page; only runs while a server page is open. */
export const SERVER_STEPS = [
  { sel: '#detail-power', title: 'Power', text: 'Start, restart, stop, or force kill. Stopping saves the world first where the game supports it.' },
  { sel: '.srv-header .address', title: 'Address', text: 'What friends type to join. Click it to copy.' },
  { sel: '.metrics.compact', title: 'Live numbers', text: 'CPU, memory, players, latency and disk, updated while you watch.' },
  { sel: '.tabs a[href$="/console"]', title: 'Console', text: 'The live server log and a command line. Press Up for earlier commands, Tab to finish a name.' },
  { sel: '.tabs a[href$="/files"]', title: 'Files', text: 'Browse, edit and upload files. Open several files as tabs and compare two side by side.' },
  { sel: '.tabs a[href$="/backups"]', title: 'Backups', text: 'Make and restore backups. Restoring is previewed before anything is overwritten.' },
  { sel: '.tabs a[href$="/schedules"]', title: 'Schedules', text: 'Restart at 4 am, back up every night, announce things. Set once, runs by itself.' },
  { sel: '.tabs a[href$="/settings"]', title: 'Settings', text: 'Name, memory, ports, start command and the one-click port opener.' },
];

/** Steps whose target is on screen, in order. `isVisible(selector)` does the looking. */
export function pickSteps(steps, isVisible) {
  return steps.filter((s) => isVisible(s.sel));
}

/** Where a Next or Back press lands: a number, 'done' past the end, or the same index. */
export function stepAfter(index, delta, count) {
  const next = index + delta;
  if (next < 0) return index;
  if (next >= count) return 'done';
  return next;
}

/* -------------------------------------------------------------- checklist */

/** { done, total, percent, next } for the items the server sent. */
export function progress(items) {
  const list = Array.isArray(items) ? items : [];
  const done = list.filter((i) => i.done).length;
  return { done, total: list.length, percent: list.length ? Math.round((done / list.length) * 100) : 100, next: list.find((i) => !i.done) || null };
}

/** The checklist pops up by itself only while something is left, and never after "Hide". */
export function shouldAutoOpen(view) {
  if (!view || view.hidden) return false;
  return progress(view.items).done < progress(view.items).total && view.items.length > 0;
}

/** What is new in this release, shown once from the checklist dialog. */
export const WHATS_NEW = [
  { title: 'Several files at once', text: 'The file editor opens files as tabs, remembers them per server, and can split into two panes.' },
  { title: 'Compare files and versions', text: 'Pick any two files, or a file and an earlier saved version, and see the differences side by side.' },
  { title: 'Keyboard control', text: 'Press ? for every shortcut. g then d goes to the dashboard, / searches, n creates a server.' },
  { title: 'Getting started checklist', text: 'Backups, two-factor, staff and Discord alerts, ticked off per account. Find it under Account.' },
];

/* ---------------------------------------------------------- per-game tips */

/**
 * Tips by game. Each entry matches a template id exactly or by prefix (a
 * trailing "*"), and lists a few things people usually trip over.
 */
export const GAME_TIPS = [
  { match: ['rust'], title: 'Rust', tips: ['Wipe day: the Players tab and Schedules can run a wipe and set a new map seed or size.', 'The Live map tab shows players and events on the real map while the server runs.', 'First start downloads the game and builds the map, so give it several minutes. Rust wants 8 GB of memory or more.', 'Oxide or uMod plugins go in through the Mods tab; scheduled events can switch settings for a weekend.'] },
  { match: ['ark-survival-ascended', 'ark-survival-evolved'], title: 'ARK', tips: ['Put several ARK servers in a cluster (Servers, then ARK clusters) so characters and dinos can travel between maps.', 'Each map needs its own memory (8 GB or more) and its own ports; the panel picks free ones.', 'Mods are Workshop IDs in the Mods tab. Save a set as a Workshop pack to reuse on another server.', 'Mod updates need a restart; use a schedule to restart and update in the early morning.'] },
  { match: ['cs2', 'counter-strike*', 'tf2', 'garrysmod', 'left4dead*', 'half-life*', 'insurgency*', 'day-of-*', 'no-more-room-in-hell', 'sven-coop'], title: 'Source-engine game', tips: ['Some Steam games want a game server login token (GSLT) to appear in the public list; if yours does, its settings say so.', 'Commands typed in the Console tab are sent to the game over RCON; the panel sets the password for you.', 'Maps and workshop collections are chosen in Game settings. Changing the map restarts the server.', 'Plugin frameworks such as Metamod go in through the Files tab.'] },
  { match: ['palworld'], title: 'Palworld', tips: ['The server uses a lot of memory over time; schedule a daily restart and a backup before it.', 'Settings such as XP and capture rate are on the Game settings tab; changes need a restart.', 'Players join by address and port; open the UDP port on your router or use the port opener.'] },
  { match: ['minecraft-velocity'], title: 'Minecraft proxy', tips: ['A Velocity proxy sits in front of several Paper or Purpur servers. Create the link under Servers, then Minecraft networks.', 'Only the proxy port needs to be reachable from the internet; keep the backend servers private.', 'Plugins like Geyser on the proxy let Bedrock players join the whole network.'] },
  { match: ['minecraft-bedrock'], title: 'Minecraft Bedrock', tips: ['Bedrock players on phones and consoles join with the address and the UDP port (19132 by default).', 'Add a Java server to let both editions in: the Game settings tab of a Java server has a Bedrock crossplay card.', 'Back up before changing the game version; Bedrock worlds do not always load on older versions.'] },
  { match: ['minecraft-paper', 'minecraft-purpur', 'minecraft-fabric', 'minecraft-forge', 'minecraft-neoforge', 'minecraft-quilt', 'minecraft-vanilla', 'minecraft-modpack'], title: 'Minecraft Java', tips: ['The Bedrock crossplay card on the Game settings tab lets phone and console players join this server too.', 'Join several servers into one network behind a Velocity proxy under Minecraft networks.', 'Pre-generate the world and the live web map on the Game settings tab, to cut lag when people explore.', 'Edit server.properties from the Files tab or the Game settings form. A restart applies it.'] },
  { match: ['project-zomboid', 'dont-starve-together', 'space-engineers', 'unturned', 'dayz', 'conan-exiles', 'killing-floor-2', 'tmodloader', 'arma3'], title: 'Workshop game', tips: ['Mods come from the Steam Workshop: paste IDs or a collection link in the Mods tab.', 'Save your mod list as a Workshop pack to put the same set on another server in one click.', 'Mods that change the world can break saves; make a backup before adding or removing one.'] },
  { match: ['valheim', 'enshrouded', 'v-rising', 'satisfactory', 'abiotic-factor', 'sons-of-the-forest', 'icarus', 'soulmask', 'core-keeper', 'necesse', 'terraria', 'factorio', 'eco', 'mindustry'], title: 'Survival game', tips: ['Worlds are saved on a timer, so stop the server from the panel (it saves first) before copying files.', 'Friends join by the address shown at the top of this page. Open its ports on your router first.', 'Schedule a backup before your nightly restart so a bad update never costs a world.'] },
];

function matches(pattern, id) {
  return pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : pattern === id;
}

/** Tips for a template id, or a short general set. */
export function tipsFor(templateId) {
  const id = String(templateId || '');
  const found = GAME_TIPS.find((g) => g.match.some((m) => matches(m, id)));
  if (found) return found;
  return { title: 'Your server', tips: ['Watch the Console tab on first start; it shows what the game is doing.', 'Open the server\'s ports on your router so friends can join, or use the bridge or port opener.', 'Set up a backup schedule before you invite anyone.'] };
}

/* ------------------------------------------------------- first-server flow */

/** The guided flow for a panel with no servers yet. */
export const FIRST_SERVER_STEPS = [
  { title: 'Pick a game', text: 'Open the Games page and choose what you want to host. Each card says how much memory it needs.', link: '#/templates', cta: 'Open Games' },
  { title: 'Name it and choose memory', text: 'Give it a name friends will recognise. The defaults are a good start; you can change memory later in Settings.' },
  { title: 'Start it and watch the console', text: 'The first start downloads the game, which takes a few minutes. The console tells you when it is ready.' },
  { title: 'Let friends join', text: 'Copy the address at the top of the server page. If friends are outside your home, open its ports on your router with the port opener in Settings.', },
  { title: 'Protect your work', text: 'Add a nightly backup under Schedules, and turn on two-factor sign-in on the Account page.', link: '#/account', cta: 'Open Account' },
];
