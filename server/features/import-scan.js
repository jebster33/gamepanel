'use strict';

/**
 * Finding game servers other panels left on this machine, so they can be
 * imported in a few clicks: Pterodactyl (Wings volumes), AMP (instances) and
 * LinuxGSM (lgsm installs), plus any folder, by recognising the game from its
 * files. Nothing here changes anything; servers/import.js does the import.
 *
 * A find: { source, path, name, templateId, ports, memory, maxPlayers,
 *           startCommand, note }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fail, logger } = require('../core/util');

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const dirs = (p) => {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(p, e.name));
  } catch {
    return [];
  }
};
const files = (p) => {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------ the game -- */

/** Marker files → template. First match wins, so the specific ones come first. */
const RULES = [
  { id: 'minecraft-neoforge', test: (d, f) => exists(path.join(d, 'libraries/net/neoforged')) },
  { id: 'minecraft-forge', test: (d, f) => exists(path.join(d, 'libraries/net/minecraftforge')) || f.some((n) => /^forge-.*\.jar$/i.test(n)) },
  { id: 'minecraft-fabric', test: (d, f) => f.includes('fabric-server-launch.jar') || f.includes('.fabric') || f.some((n) => /^fabric-server-mc.*\.jar$/i.test(n)) },
  { id: 'minecraft-quilt', test: (d, f) => f.includes('quilt-server-launch.jar') || f.includes('.quilt') },
  { id: 'minecraft-purpur', test: (d, f) => f.includes('purpur.yml') || f.some((n) => /^purpur.*\.jar$/i.test(n)) },
  { id: 'minecraft-paper', test: (d, f) => f.includes('paper.yml') || exists(path.join(d, 'config/paper-global.yml')) || f.some((n) => /^paper.*\.jar$/i.test(n)) || f.includes('spigot.yml') },
  { id: 'minecraft-bedrock', test: (d, f) => f.includes('bedrock_server') || f.includes('bedrock_server.exe') },
  { id: 'minecraft-vanilla', test: (d, f) => f.includes('server.properties') && f.some((n) => /\.jar$/i.test(n)) },
  { id: 'rust', test: (d, f) => f.includes('RustDedicated') || f.includes('RustDedicated.exe') },
  { id: 'valheim', test: (d, f) => f.includes('valheim_server.x86_64') || f.includes('valheim_server.exe') },
  { id: 'tmodloader', test: (d, f) => f.some((n) => /^tModLoader(Server)?(\.dll|\.exe|\.sh)?$/i.test(n)) || f.includes('start-tModLoaderServer.sh') },
  { id: 'terraria', test: (d, f) => f.some((n) => /^TerrariaServer(\.bin\.x86_64|\.exe)?$/.test(n)) },
  { id: 'factorio', test: (d, f) => exists(path.join(d, 'bin/x64/factorio')) || exists(path.join(d, 'bin/x64/factorio.exe')) },
  { id: 'seven-days-to-die', test: (d, f) => f.some((n) => /^7DaysToDieServer/.test(n)) },
  { id: 'project-zomboid', test: (d, f) => f.includes('ProjectZomboid64.json') || (f.includes('start-server.sh') && exists(path.join(d, 'java'))) },
  { id: 'palworld', test: (d, f) => f.includes('PalServer.sh') || f.includes('PalServer.exe') },
  { id: 'satisfactory', test: (d, f) => f.includes('FactoryServer.sh') || f.includes('FactoryServer.exe') },
  { id: 'ark-survival-ascended', test: (d, f) => exists(path.join(d, 'ShooterGame/Binaries/Win64/ArkAscendedServer.exe')) },
  { id: 'ark-survival-evolved', test: (d, f) => exists(path.join(d, 'ShooterGame/Binaries/Linux/ShooterGameServer')) || exists(path.join(d, 'ShooterGame/Binaries/Win64/ShooterGameServer.exe')) },
  { id: 'unturned', test: (d, f) => f.some((n) => /^Unturned(_Headless\.x86_64|\.x86_64|\.exe)$/.test(n)) },
  { id: 'v-rising', test: (d, f) => f.includes('VRisingServer.exe') },
  { id: 'enshrouded', test: (d, f) => f.includes('enshrouded_server.exe') },
  { id: 'cs2', test: (d, f) => exists(path.join(d, 'game/csgo')) || exists(path.join(d, 'game/bin/linuxsteamrt64/cs2')) },
  { id: 'garrysmod', test: (d, f) => f.includes('srcds_run') && exists(path.join(d, 'garrysmod')) },
  { id: 'tf2', test: (d, f) => f.includes('srcds_run') && exists(path.join(d, 'tf')) },
  { id: 'left4dead2', test: (d, f) => f.includes('srcds_run') && exists(path.join(d, 'left4dead2')) },
  { id: 'counter-strike-source', test: (d, f) => f.includes('srcds_run') && exists(path.join(d, 'cstrike')) },
  { id: 'dont-starve-together', test: (d, f) => exists(path.join(d, 'bin64/dontstarve_dedicated_server_nullrenderer_x64')) || exists(path.join(d, 'bin/dontstarve_dedicated_server_nullrenderer')) },
  { id: 'arma-reforger', test: (d, f) => f.includes('ArmaReforgerServer') || f.includes('ArmaReforgerServer.exe') },
  { id: 'arma3', test: (d, f) => f.includes('arma3server') || f.includes('arma3server_x64') || f.includes('arma3server_x64.exe') },
  { id: 'dayz', test: (d, f) => f.includes('DayZServer') || f.includes('DayZServer_x64.exe') },
  { id: 'space-engineers', test: (d, f) => exists(path.join(d, 'DedicatedServer64/SpaceEngineersDedicated.exe')) },
  { id: 'conan-exiles', test: (d, f) => exists(path.join(d, 'ConanSandbox')) },
  { id: 'squad', test: (d, f) => f.includes('SquadGameServer.sh') || f.includes('SquadGameServer.exe') },
  { id: 'mindustry', test: (d, f) => f.some((n) => /^server-release\.jar$|^Mindustry.*server.*\.jar$/i.test(n)) },
];

/**
 * Which game a folder holds. Looks in the folder and a couple of levels down
 * (AMP keeps files in <instance>/Minecraft, LinuxGSM in serverfiles), and
 * returns the folder the game actually lives in.
 */
function detect(dir, templates, depth = 2) {
  const f = files(dir);
  for (const rule of RULES) {
    if (templates && !templates.get(rule.id)) continue;
    try {
      if (rule.test(dir, f)) return { templateId: rule.id, path: dir };
    } catch {
      /* unreadable: try the next rule */
    }
  }
  if (depth > 0) {
    for (const sub of dirs(dir)) {
      const base = path.basename(sub).toLowerCase();
      if (/^(\.|world|logs|backups?|plugins|mods|config|libraries|cache|crash-reports|versions)/.test(base)) continue;
      const hit = detect(sub, templates, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Ports, player count and a start command the folder itself gives away. */
function details(dir, templateId) {
  const out = { ports: {}, maxPlayers: undefined, startCommand: null };
  const props = read(path.join(dir, 'server.properties'));
  if (props) {
    const port = props.match(/^server-port\s*=\s*(\d+)/m)?.[1];
    if (port) out.ports.game = Number(port);
    const players = props.match(/^max-players\s*=\s*(\d+)/m)?.[1];
    if (players) out.maxPlayers = Number(players);
    const motd = props.match(/^motd\s*=\s*(.+)$/m)?.[1];
    if (motd) out.motd = motd.replace(/\\u00a7.|§.|&[0-9a-fk-or]/gi, '').replace(/\\n.*/, '').trim().slice(0, 60) || undefined;
  }
  if (/^minecraft-(paper|purpur|vanilla|fabric|quilt)$/.test(templateId || '') && !exists(path.join(dir, 'server.jar'))) {
    // The template runs server.jar; point it at the jar this server actually uses.
    const jars = files(dir)
      .filter((n) => /\.jar$/i.test(n))
      .map((n) => ({ n, size: fs.statSync(path.join(dir, n)).size }))
      .sort((a, b) => Number(/fabric-server-launch|quilt-server-launch/i.test(b.n)) - Number(/fabric-server-launch|quilt-server-launch/i.test(a.n)) || b.size - a.size);
    if (jars[0]) out.startCommand = `java -Xms{{MEMORY}}M -Xmx{{MEMORY}}M {{JAVA_ARGS}} -jar ${jars[0].n} nogui`;
  }
  if (/^minecraft-(neo)?forge$/.test(templateId || '') && !exists(path.join(dir, 'start.sh')) && exists(path.join(dir, 'run.sh'))) out.startCommand = 'bash run.sh nogui';
  return out;
}

const shortId = (id) => String(id).slice(0, 8);

/* ----------------------------------------------------------- Pterodactyl -- */

const PTERO_VOLUMES = ['/var/lib/pterodactyl/volumes'];

function scanPterodactyl(templates, roots = PTERO_VOLUMES) {
  const out = [];
  for (const root of roots) {
    for (const dir of dirs(root)) {
      const uuid = path.basename(dir);
      if (!/^[0-9a-f-]{36}$/i.test(uuid)) continue;
      const hit = detect(dir, templates, 1);
      const d = details(hit?.path || dir, hit?.templateId);
      out.push({ source: 'pterodactyl', uuid, path: hit?.path || dir, name: d.motd || `Pterodactyl ${shortId(uuid)}`, templateId: hit?.templateId || null, ...d, note: 'Stop it in Pterodactyl first, or copy it so the original keeps running.' });
    }
  }
  return out;
}

/** Names, memory, ports and start commands from a Pterodactyl panel's application API. */
async function pterodactylApi(url, key) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(base)) fail(400, 'Enter the address of the Pterodactyl panel, like https://panel.example.com');
  if (!/^ptla_[A-Za-z0-9]{20,}$/.test(String(key || '').trim())) fail(400, 'Use an Application API key (it starts with ptla_), from Admin → Application API');
  const servers = [];
  let page = 1;
  for (; page <= 20; page++) {
    let res;
    try {
      res = await fetch(`${base}/api/application/servers?include=allocations,egg&per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${String(key).trim()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      fail(502, `Could not reach ${base}: ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) fail(400, 'Pterodactyl refused the key');
    if (!res.ok) fail(502, `Pterodactyl answered ${res.status}`);
    const body = await res.json();
    for (const { attributes: a } of body.data || []) {
      const allocations = a.relationships?.allocations?.data?.map((x) => x.attributes) || [];
      const main = allocations.find((x) => x.id === a.allocation) || allocations[0];
      const env = a.container?.environment || {};
      servers.push({
        uuid: a.uuid,
        name: a.name,
        memory: a.limits?.memory || undefined,
        port: main?.port,
        egg: a.relationships?.egg?.attributes?.name || '',
        startup: String(a.container?.startup_command || '')
          .replace(/\{\{SERVER_MEMORY\}\}/g, '{{MEMORY}}')
          .replace(/\{\{SERVER_PORT\}\}/g, '{{PORT}}')
          .replace(/\{\{SERVER_IP\}\}/g, '0.0.0.0')
          .replace(/\{\{(\w+)\}\}/g, (m, k) => (k === 'MEMORY' || k === 'PORT' ? m : env[k] !== undefined ? String(env[k]) : m)),
      });
    }
    if (!body.meta?.pagination || body.meta.pagination.current_page >= body.meta.pagination.total_pages) break;
  }
  return servers;
}

/** Local volumes, named and filled in from the panel's API. */
async function scanPterodactylWithApi(templates, { url, key }, roots) {
  const local = scanPterodactyl(templates, roots);
  const remote = await pterodactylApi(url, key);
  return local.map((f) => {
    const r = remote.find((x) => x.uuid === f.uuid);
    if (!r) return f;
    return {
      ...f,
      name: r.name,
      memory: r.memory || f.memory,
      ports: { ...f.ports, ...(r.port ? { game: r.port } : {}) },
      // Keep the template's own start when the server is one we recognise; otherwise run it the way Pterodactyl did.
      startCommand: f.templateId ? f.startCommand : r.startup || f.startCommand,
      note: `${r.egg ? `${r.egg} egg. ` : ''}${f.note}`,
    };
  });
}

/* ------------------------------------------------------------------- AMP -- */

function ampRoots() {
  const roots = ['/home/amp/.ampdata/instances', '/root/.ampdata/instances', 'C:\\AMPDatastore\\Instances'];
  for (const home of dirs('/home')) roots.push(path.join(home, '.ampdata/instances'));
  return [...new Set(roots)];
}

/** AMP's .kvp files: Key=Value lines. */
function kvp(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => l.match(/^([^#=][^=]*)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1].trim(), m[2].trim()])
  );
}

function scanAmp(templates, roots = ampRoots()) {
  const out = [];
  for (const root of roots) {
    let meta = [];
    try {
      meta = JSON.parse(read(path.join(path.dirname(root), 'instances.json')) || '[]');
    } catch {
      meta = [];
    }
    for (const dir of dirs(root)) {
      const instance = path.basename(dir);
      if (instance === 'ADS01' || /^ADS/i.test(instance)) continue; // AMP's own controller
      const info = (Array.isArray(meta) ? meta : []).find((m) => m.InstanceName === instance) || {};
      const hit = detect(dir, templates, 3);
      const kv = Object.assign({}, ...files(dir).filter((n) => n.endsWith('.kvp')).map((n) => kvp(read(path.join(dir, n)))));
      const d = details(hit?.path || dir, hit?.templateId);
      const port = Number(kv['Minecraft.PortNumber'] || kv['Meta.GenericModule.ApplicationPort1'] || 0) || undefined;
      out.push({
        source: 'amp',
        path: hit?.path || dir,
        name: info.FriendlyName || instance,
        templateId: hit?.templateId || null,
        ...d,
        ports: { ...(port ? { game: port } : {}), ...d.ports },
        memory: Number(kv['Java.MaxHeapSizeMB'] || kv['Limits.MemoryLimitMB'] || 0) || undefined,
        note: 'Stop the instance in AMP first, or copy it so the original keeps running.',
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------- LinuxGSM -- */

/** LinuxGSM's script names → templates. */
const LGSM = {
  mcserver: 'minecraft-vanilla',
  pmcserver: 'minecraft-paper',
  mcbserver: 'minecraft-bedrock',
  rustserver: 'rust',
  vhserver: 'valheim',
  terrariaserver: 'terraria',
  fctrserver: 'factorio',
  sdtdserver: 'seven-days-to-die',
  pzserver: 'project-zomboid',
  pwserver: 'palworld',
  sfserver: 'satisfactory',
  arkserver: 'ark-survival-evolved',
  untserver: 'unturned',
  cs2server: 'cs2',
  gmodserver: 'garrysmod',
  tf2server: 'tf2',
  l4d2server: 'left4dead2',
  l4dserver: 'left4dead',
  cssserver: 'counter-strike-source',
  dodsserver: 'day-of-defeat-source',
  hl2dmserver: 'half-life-2-deathmatch',
  insserver: 'insurgency-2014',
  inssserver: 'insurgency-sandstorm',
  kf2server: 'killing-floor-2',
  dstserver: 'dont-starve-together',
  arma3server: 'arma3',
  armarserver: 'arma-reforger',
  dayzserver: 'dayz',
  squadserver: 'squad',
  sqdserver: 'squad',
  emserver: 'empyrion',
  ecoserver: 'eco',
  bt2server: 'barotrauma',
  btserver: 'barotrauma',
  ckserver: 'core-keeper',
  mhserver: 'mordhau',
  nmrihserver: 'no-more-room-in-hell',
  scpslserver: 'scp-secret-laboratory',
  svenserver: 'sven-coop',
  vintsserver: null,
  mindserver: 'mindustry',
};

/** LinuxGSM settings for one instance: _default.cfg, then common.cfg, then <instance>.cfg. */
function lgsmConfig(cfgDir, instance) {
  const vars = {};
  for (const file of ['_default.cfg', 'common.cfg', `${instance}.cfg`]) {
    for (const m of read(path.join(cfgDir, file)).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/gm)) vars[m[1]] = m[2];
  }
  return vars;
}

function lgsmRoots() {
  return [...new Set(['/root', ...dirs('/home'), os.homedir()])];
}

function scanLinuxGsm(templates, roots = lgsmRoots()) {
  const out = [];
  for (const home of roots) {
    const configs = path.join(home, 'lgsm/config-lgsm');
    for (const cfgDir of dirs(configs)) {
      const script = path.basename(cfgDir);
      const mapped = LGSM[script] || null;
      for (const file of files(cfgDir)) {
        if (!file.endsWith('.cfg') || ['_default.cfg', 'common.cfg', 'secrets-common.cfg'].includes(file) || file.startsWith('secrets-')) continue;
        const instance = file.slice(0, -4);
        const vars = lgsmConfig(cfgDir, instance);
        const serverfiles = path.join(home, 'serverfiles');
        const hit = detect(serverfiles, templates, 1);
        const id = mapped && (!templates || templates.get(mapped)) ? mapped : hit?.templateId || null;
        const d = details(serverfiles, id);
        out.push({
          source: 'linuxgsm',
          path: serverfiles,
          name: (vars.servername || vars.hostname || instance).replace(/\$\{?\w+\}?/g, '').trim().slice(0, 60) || instance,
          templateId: id,
          ...d,
          ports: { ...(Number(vars.port) ? { game: Number(vars.port) } : {}), ...(Number(vars.queryport) ? { query: Number(vars.queryport) } : {}), ...(Number(vars.rconport) ? { rcon: Number(vars.rconport) } : {}), ...d.ports },
          maxPlayers: Number(vars.maxplayers) || d.maxPlayers,
          note: `LinuxGSM ${script} (${instance}). Stop it with ./${script} stop first, or copy it.`,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------- all -- */

function scanAll(manager) {
  const templates = manager.templates;
  const found = [];
  for (const [name, fn] of [
    ['Pterodactyl', () => scanPterodactyl(templates)],
    ['AMP', () => scanAmp(templates)],
    ['LinuxGSM', () => scanLinuxGsm(templates)],
  ]) {
    try {
      found.push(...fn());
    } catch (err) {
      logger.warn(`Import scan (${name}): ${err.message}`);
    }
  }
  // Leave out folders the panel already runs.
  const used = new Set(manager.servers.flatMap((s) => [path.resolve(s.dir), s.imported?.from && path.resolve(s.imported.from)]).filter(Boolean));
  return found.filter((f) => !used.has(path.resolve(f.path)));
}

/** One folder the user pointed at. */
function inspect(manager, dir) {
  const p = String(dir || '').trim();
  if (!p || !path.isAbsolute(p)) fail(400, 'Enter the full path of the server folder');
  if (!exists(p)) fail(400, `The panel cannot see ${p}`);
  const hit = detect(p, manager.templates, 2);
  return { source: 'folder', path: hit?.path || p, name: path.basename(p), templateId: hit?.templateId || null, ...details(hit?.path || p, hit?.templateId) };
}

module.exports = { detect, details, scanPterodactyl, scanPterodactylWithApi, pterodactylApi, scanAmp, scanLinuxGsm, scanAll, inspect, kvp, lgsmConfig, LGSM };
