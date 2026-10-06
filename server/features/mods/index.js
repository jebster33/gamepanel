'use strict';

/**
 * One-click mods.
 *
 *   compat.js     works out what a server can load (loader, game version)
 *   providers/    Modrinth, Hangar, CurseForge, uMod, Factorio, Steam Workshop
 *   manifest.js   what the panel installed, from where, and why
 *   workshop.js   getting Workshop items onto each kind of game
 *
 * Installing a mod also installs every mod it requires, picks the newest
 * stable release that matches the server, and replaces an older copy of the
 * same mod instead of leaving two side by side (which crashes most loaders).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { fail, logger, safeJoin } = require('../../core/util');
const { downloadTo, safeFileName, mapLimit } = require('./http');
const compat = require('./compat');
const manifest = require('./manifest');

const PROVIDERS = {
  modrinth: require('./providers/modrinth'),
  curseforge: require('./providers/curseforge'),
  umod: require('./providers/umod'),
  hangar: require('./providers/hangar'),
  spigot: require('./providers/spigot'),
  factorio: require('./providers/factorio'),
  workshop: require('./providers/workshop'),
};

/* ---------------------------------------------------------------- helpers -- */

function requireProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) fail(400, `Unknown mod source: ${id}`);
  return provider;
}

function providersFor(template) {
  return (template?.mods?.providers || [])
    .filter((id) => PROVIDERS[id])
    .map((id) => ({
      id,
      label: PROVIDERS[id].label,
      needsKey: PROVIDERS[id].needsKey,
      site: PROVIDERS[id].site,
      viaSteamcmd: Boolean(PROVIDERS[id].viaSteamcmd),
    }));
}

const modDir = compat.modDir;

/** One mod operation per server at a time, so the manifest never races. */
const locks = new Map();
async function locked(serverId, fn) {
  const previous = locks.get(serverId) || Promise.resolve();
  let release;
  const current = new Promise((r) => (release = r));
  locks.set(serverId, previous.then(() => current));
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(serverId) === current) locks.delete(serverId);
  }
}

async function sha512Of(file) {
  const hash = crypto.createHash('sha512');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

const dirOf = (server, ctx) => safeJoin(server.dir, ctx.dir);

/** Remove a file and its disabled twin. */
async function removeFile(server, ctx, file) {
  if (!file) return;
  const base = safeFileName(file);
  for (const name of [base, base.endsWith('.disabled') ? base.slice(0, -9) : `${base}.disabled`]) {
    await fsp.rm(path.join(dirOf(server, ctx), name), { recursive: true, force: true });
  }
}

/* ----------------------------------------------------------------- browse -- */

function credsFor(providerId, integrations = {}) {
  switch (providerId) {
    case 'curseforge':
      return { apiKey: integrations.curseforgeKey };
    case 'workshop':
      return { apiKey: integrations.steamApiKey };
    case 'factorio':
      return { credentials: integrations.factorio || {} };
    default:
      return {};
  }
}

async function search(server, template, { provider: providerId, query, page = 0, liveVersion }, integrations) {
  const ctx = compat.modContext(server, template, liveVersion);
  const provider = requireProvider(providerId || template.mods.providers[0]);
  if (!provider.search) fail(400, `${provider.label} cannot be searched from the panel`);
  const result = await provider.search({ query: query || '', page, limit: 24, ctx, ...credsFor(provider.id, integrations) });
  const installed = new Set(manifest.load(server).filter((m) => m.provider === provider.id).map((m) => String(m.projectId)));
  for (const item of result.items) item.installed = installed.has(String(item.id)) || installed.has(String(item.slug));
  return { ...result, filter: compat.describe(ctx) };
}

async function versions(server, template, { provider: providerId, projectId, liveVersion }, integrations) {
  const ctx = compat.modContext(server, template, liveVersion);
  const provider = requireProvider(providerId);
  const list = await provider.versions({ projectId, ctx, ...credsFor(provider.id, integrations) });
  return list.map((v, i) => ({
    id: v.id,
    name: v.name,
    version: v.version,
    channel: v.channel,
    gameVersions: (v.gameVersions || []).slice(-6),
    loaders: v.loaders,
    published: v.published,
    filename: v.file?.filename,
    size: v.file?.size,
    recommended: i === 0,
  }));
}

/* ---------------------------------------------------------------- install -- */

/**
 * Work out everything that has to be downloaded for one mod: the mod itself
 * and, recursively, every mod it requires that is not already there.
 */
async function plan(provider, { projectId, versionId }, ctx, creds, mods) {
  const out = new Map();
  const notes = [];
  const queue = [{ projectId: String(projectId), versionId: versionId || null, requiredBy: null }];
  const describe = () => `${ctx.loaderLabel ? `${ctx.loaderLabel} ` : ''}${ctx.gameVersion || ''}`.trim() || 'this server';

  while (queue.length) {
    const item = queue.shift();

    // A versionId with no project (Modrinth deps can do that): look the project up.
    if (!item.projectId && item.versionId && provider.version) {
      const v = await provider.version(item.versionId, creds).catch(() => null);
      if (!v) continue;
      item.projectId = String(v.projectId);
    }
    if (!item.projectId) continue;

    const planned = [...out.values()].find((p) => p.project.id === item.projectId || p.project.slug === item.projectId);
    if (planned) {
      if (item.requiredBy) planned.requiredBy.add(item.requiredBy);
      continue;
    }
    const existing = manifest.find(mods, provider.id, item.projectId);
    if (item.requiredBy && existing && !existing.disabled) {
      existing.requiredBy = [...new Set([...(existing.requiredBy || []), item.requiredBy])];
      continue;
    }

    const project = await provider.project(item.projectId, creds).catch((err) => {
      if (!item.requiredBy) throw err;
      notes.push(`Could not look up a required mod (${item.projectId}): ${err.message}`);
      return null;
    });
    if (!project) continue;
    if (existing && item.requiredBy) continue;
    if (!project.serverSupported) {
      if (!item.requiredBy) fail(400, `${project.name} is a client-side mod. It does nothing on a server and can stop it from starting.`);
      notes.push(`Skipped ${project.name}: it is client-side only`);
      continue;
    }

    let version = null;
    if (item.versionId && provider.version) {
      version = await provider.version(item.versionId, { ...creds, projectId: project.id }).catch(() => null);
      if (version && !provider.fits(version, ctx)) {
        if (!item.requiredBy) fail(400, `${project.name} ${version.version} is not made for ${describe()}. Pick a version from the list instead.`);
        version = null; // the pinned dependency does not fit; look for one that does
      }
    }
    if (!version) version = await provider.best({ projectId: project.id, ctx, ...creds });
    if (!version) {
      if (!item.requiredBy) fail(404, `${project.name} has no release for ${describe()}.`);
      const parent = out.get(item.requiredBy)?.project.name || 'A mod you picked';
      fail(404, `${parent} needs ${project.name}, which has no release for ${describe()}. Nothing was installed.`);
    }
    if (!version.file?.url) {
      const message = provider.downloadError ? provider.downloadError(project.name) : `${project.name} has no downloadable file`;
      fail(400, message);
    }

    // Refuse anything an installed mod says it cannot coexist with, and the other way round.
    for (const dep of version.dependencies || []) {
      if (dep.type !== 'incompatible' || !dep.projectId) continue;
      const clash = manifest.find(mods, provider.id, dep.projectId);
      if (clash && !clash.disabled) fail(409, `${project.name} does not work together with ${clash.name}, which is installed. Remove one of them first.`);
    }
    const blocker = mods.find((m) => !m.disabled && (m.incompatible || []).includes(project.id));
    if (blocker) fail(409, `${blocker.name} does not work together with ${project.name}. Remove ${blocker.name} first.`);

    out.set(project.id, { project, version, requiredBy: new Set(item.requiredBy ? [item.requiredBy] : []), auto: Boolean(item.requiredBy) });
    for (const dep of version.dependencies || []) {
      if (dep.type === 'required') queue.push({ projectId: dep.projectId ? String(dep.projectId) : null, versionId: dep.versionId, requiredBy: project.id });
    }
  }
  return { steps: [...out.values()], notes };
}

/**
 * Install a mod and what it needs.
 * @returns {{installed: object[], notes: string[]}}
 */
async function install(server, template, { provider: providerId, projectId, versionId, liveVersion }, integrations) {
  const provider = requireProvider(providerId);
  if (provider.id === 'workshop') fail(400, 'Workshop items are installed with installWorkshop');
  const ctx = compat.modContext(server, template, liveVersion);
  const creds = credsFor(provider.id, integrations);

  return locked(server.id, async () => {
    const mods = manifest.load(server);
    if (provider.id === 'modrinth' && ctx.game === 'minecraft') await adoptUntracked(server, ctx, mods).catch(() => {});

    const { steps, notes } = await plan(provider, { projectId, versionId }, ctx, creds, mods);
    const dir = dirOf(server, ctx);
    const installed = [];

    // Download everything first; only touch the mod folder once all of it arrived.
    const staged = await mapLimit(steps, 3, async (step) => {
      const filename = safeFileName(step.version.file.filename, `${step.project.slug || step.project.id}.jar`);
      const url = provider.authorize ? provider.authorize(step.version.file.url, creds) : step.version.file.url;
      const temp = path.join(server.dir, '.gamepanel', 'downloads', `${crypto.randomBytes(4).toString('hex')}-${filename}`);
      const result = await downloadTo(url, temp);
      if (step.version.file.sha1 && result.sha1 !== step.version.file.sha1) {
        await fsp.rm(temp, { force: true });
        fail(502, `The download of ${step.project.name} was corrupted (checksum mismatch). Try again.`);
      }
      return { step, filename, temp, size: result.size };
    }).catch(async (err) => {
      await fsp.rm(path.join(server.dir, '.gamepanel', 'downloads'), { recursive: true, force: true });
      throw err;
    });

    await fsp.mkdir(dir, { recursive: true });
    for (const { step, filename, temp, size } of staged) {
      const { project, version } = step;
      const previous = manifest.find(mods, provider.id, project.id) || manifest.find(mods, provider.id, project.slug);
      if (previous && previous.file !== filename) await removeFile(server, ctx, previous.file);
      await fsp.rm(path.join(dir, `${filename}.disabled`), { force: true });
      await fsp.rename(temp, path.join(dir, filename));

      const entry = {
        key: manifest.keyOf(provider.id, project.id),
        provider: provider.id,
        projectId: project.id,
        slug: project.slug,
        name: project.name,
        icon: project.icon,
        url: project.url,
        version: version.version,
        versionId: version.id,
        channel: version.channel,
        file: filename,
        size,
        // An explicit install of something that was only a dependency makes it "yours".
        auto: previous ? previous.auto && step.auto : step.auto,
        requiredBy: [...new Set([...(previous?.requiredBy || []), ...[...step.requiredBy].map((id) => manifest.keyOf(provider.id, id))])],
        incompatible: (version.dependencies || []).filter((d) => d.type === 'incompatible' && d.projectId).map((d) => String(d.projectId)),
        installedAt: Date.now(),
      };
      const index = mods.indexOf(previous);
      if (index >= 0) mods[index] = entry;
      else mods.push(entry);
      installed.push({ name: entry.name, version: entry.version, file: filename, dependency: entry.auto, replaced: previous?.version || null });
    }
    // requiredBy was recorded with bare project ids during planning; normalise to keys.
    for (const m of mods) m.requiredBy = (m.requiredBy || []).map((r) => (r.includes(':') ? r : manifest.keyOf(m.provider, r)));
    manifest.save(server, mods);
    await fsp.rm(path.join(server.dir, '.gamepanel', 'downloads'), { recursive: true, force: true });
    logger.info(`Installed ${installed.map((i) => i.file).join(', ')} into ${server.name}/${ctx.dir}`);
    return { installed, notes, dir: ctx.dir };
  });
}

/**
 * Recognise jars that were not installed through the panel (uploaded by
 * hand, or part of a modpack) so updates and duplicate checks know about them.
 */
async function adoptUntracked(server, ctx, mods) {
  const dir = dirOf(server, ctx);
  let names = [];
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && /\.(jar|zip)$/i.test(e.name)).map((e) => e.name);
  } catch {
    return 0;
  }
  const tracked = new Set(mods.map((m) => m.file));
  const loose = names.filter((n) => !tracked.has(n));
  if (!loose.length) return 0;

  const byHash = new Map();
  for (const name of loose) byHash.set(await sha512Of(path.join(dir, name)), name);
  const found = await PROVIDERS.modrinth.identify([...byHash.keys()]);
  const ids = [...new Set(Object.values(found).map((v) => v.project_id))];
  const projects = new Map((ids.length ? await PROVIDERS.modrinth.projects(ids) : []).map((p) => [p.id, p]));
  let adopted = 0;
  for (const [hash, v] of Object.entries(found)) {
    const project = projects.get(v.project_id);
    if (!project || manifest.find(mods, 'modrinth', project.id)) continue;
    mods.push({
      key: manifest.keyOf('modrinth', project.id),
      provider: 'modrinth',
      projectId: project.id,
      slug: project.slug,
      name: project.title,
      icon: project.icon_url || null,
      url: `https://modrinth.com/${project.project_type}/${project.slug}`,
      version: v.version_number,
      versionId: v.id,
      file: byHash.get(hash),
      auto: false,
      fromPack: ctx.modpack,
      requiredBy: [],
      incompatible: [],
      installedAt: Date.now(),
    });
    adopted++;
  }
  return adopted;
}

/* ----------------------------------------------------------- installed -- */

async function listInstalled(server, template) {
  const ctx = compat.modContext(server, template);
  const mods = manifest.load(server);
  const byFile = new Map(mods.filter((m) => m.file).map((m) => [m.file, m]));
  const items = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dirOf(server, ctx), { withFileTypes: true });
  } catch {
    /* the folder appears once the first mod is installed */
  }
  const seen = new Set();
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '_client-only') continue;
    const full = path.join(dirOf(server, ctx), entry.name);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) continue;
    const disabled = entry.name.endsWith('.disabled');
    const base = disabled ? entry.name.slice(0, -9) : entry.name;
    const meta = byFile.get(base) || byFile.get(entry.name) || null;
    // Minecraft mods and plugins are single .jar files; a folder next to them
    // (plugins/bStats, plugins/spark) is a plugin's config, not another mod.
    if (ctx.game === 'minecraft' && entry.isDirectory() && !meta) continue;
    if (meta) seen.add(meta.key);
    items.push({
      name: entry.name,
      title: meta?.name || base.replace(/\.(jar|zip|cs|gma)$/i, ''),
      size: stat.size,
      modified: stat.mtimeMs,
      directory: entry.isDirectory(),
      disabled,
      key: meta?.key || null,
      provider: meta?.provider || null,
      version: meta?.version || null,
      icon: meta?.icon || null,
      url: meta?.url || null,
      dependency: Boolean(meta?.auto),
      requiredBy: (meta?.requiredBy || []).map((k) => mods.find((m) => m.key === k)?.name).filter(Boolean),
      fromPack: Boolean(meta?.fromPack),
    });
  }
  // Items the game downloads itself (Workshop lists) have no file in the folder.
  for (const meta of mods) {
    if (seen.has(meta.key) || meta.file) continue;
    items.push({
      name: meta.key,
      title: meta.name,
      size: meta.size || 0,
      modified: meta.installedAt,
      directory: false,
      disabled: Boolean(meta.disabled),
      key: meta.key,
      provider: meta.provider,
      version: meta.version || null,
      icon: meta.icon || null,
      url: meta.url || null,
      dependency: Boolean(meta.auto),
      requiredBy: (meta.requiredBy || []).map((k) => mods.find((m) => m.key === k)?.name).filter(Boolean),
      managedByGame: true,
    });
  }
  items.sort((a, b) => Number(a.dependency) - Number(b.dependency) || a.title.localeCompare(b.title));
  return { dir: ctx.dir, items, filter: compat.describe(ctx) };
}

/** Remove a mod, and any dependency that nothing else needs any more. */
async function remove(server, template, nameOrKey, { keepDependencies = false } = {}) {
  const ctx = compat.modContext(server, template);
  return locked(server.id, async () => {
    const mods = manifest.load(server);
    const plain = String(nameOrKey).replace(/\.disabled$/, '');
    const entry = mods.find((m) => m.key === nameOrKey || m.file === plain);
    const removed = [];

    if (!entry) {
      // Not panel-installed: just delete the file.
      await removeFile(server, ctx, plain);
      return { ok: true, removed: [plain] };
    }

    const needs = mods.filter((m) => m !== entry && (entry.requiredBy || []).includes(m.key));
    const left = mods.filter((m) => m !== entry);
    const drop = [entry, ...(keepDependencies ? [] : manifest.orphans(left))];
    for (const mod of drop) {
      if (mod.file) await removeFile(server, ctx, mod.file);
      else await require('./workshop').unlist(server, template, mod);
      removed.push(mod.name);
    }
    manifest.save(server, mods.filter((m) => !drop.includes(m)));
    return { ok: true, removed, warning: needs.length ? `${needs.map((m) => m.name).join(', ')} needed ${entry.name} and may stop working.` : null };
  });
}

/** Disable a mod by renaming it (easy to undo), or take it off the game's Workshop list. */
async function toggle(server, template, nameOrKey) {
  const ctx = compat.modContext(server, template);
  return locked(server.id, async () => {
    const mods = manifest.load(server);
    const plain = String(nameOrKey).replace(/\.disabled$/, '');
    const entry = mods.find((m) => m.key === nameOrKey || m.file === plain);

    if (entry && !entry.file) {
      entry.disabled = !entry.disabled;
      const workshop = require('./workshop');
      if (entry.disabled) await workshop.unlist(server, template, entry);
      else await workshop.relist(server, template, entry);
      manifest.save(server, mods);
      return { name: entry.key, disabled: entry.disabled };
    }

    const safe = safeFileName(nameOrKey);
    const dir = dirOf(server, ctx);
    const from = path.join(dir, safe);
    const to = path.join(dir, safe.endsWith('.disabled') ? safe.slice(0, -9) : `${safe}.disabled`);
    await fsp.rename(from, to);
    if (entry) {
      entry.disabled = to.endsWith('.disabled');
      manifest.save(server, mods);
    }
    return { name: path.basename(to), disabled: to.endsWith('.disabled') };
  });
}

/* ---------------------------------------------------------------- updates -- */

async function checkUpdates(server, template, integrations, { liveVersion } = {}) {
  const ctx = compat.modContext(server, template, liveVersion);
  const mods = manifest.load(server);
  if (ctx.game === 'minecraft' && (template.mods?.providers || []).includes('modrinth')) {
    const before = mods.length;
    await adoptUntracked(server, ctx, mods).catch((err) => logger.debug(`adopt: ${err.message}`));
    if (mods.length !== before) manifest.save(server, mods);
  }
  const candidates = mods.filter((m) => m.file && !m.disabled && PROVIDERS[m.provider]?.best && m.provider !== 'umod');
  const results = await mapLimit(candidates, 4, async (mod) => {
    try {
      const provider = PROVIDERS[mod.provider];
      const latest = await provider.best({ projectId: mod.projectId, ctx, ...credsFor(mod.provider, integrations) });
      if (!latest || latest.id === mod.versionId) return null;
      return { key: mod.key, name: mod.name, current: mod.version, latest: latest.version, versionId: latest.id, fromPack: Boolean(mod.fromPack) };
    } catch {
      return null;
    }
  });
  const workshopUpdates = await require('./workshop').checkUpdates(server, mods).catch(() => []);
  return { updates: [...results.filter(Boolean), ...workshopUpdates], checked: candidates.length, filter: compat.describe(ctx) };
}

/** Update the given mods (by manifest key) to their newest fitting release. */
async function update(server, template, keys, integrations, opts = {}) {
  const mods = manifest.load(server);
  const done = [];
  const failed = [];
  for (const key of keys) {
    const mod = mods.find((m) => m.key === key);
    if (!mod) continue;
    try {
      if (mod.provider === 'workshop') {
        await require('./workshop').refresh(server, template, mod, opts);
      } else {
        const result = await install(server, template, { provider: mod.provider, projectId: mod.projectId, liveVersion: opts.liveVersion }, integrations);
        done.push(...result.installed);
      }
    } catch (err) {
      failed.push({ name: mod.name, error: err.message });
    }
  }
  return { updated: done, failed };
}

/* -------------------------------------------------------------- modpacks -- */

/**
 * Move client-only mods out of a server's mods folder.
 *
 * A pack's overrides folder carries jars with no metadata, so the only
 * reliable check is to hash what landed and ask Modrinth what each one is.
 * Forge and NeoForge refuse to start with a client mod present, so this runs
 * after every modpack install. Files are moved aside, never deleted.
 */
async function pruneClientOnlyMods(server, template, log = () => {}) {
  const ctx = compat.modContext(server, template);
  const dir = dirOf(server, ctx);
  let names = [];
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar')).map((e) => e.name);
  } catch {
    return { checked: 0, moved: [] };
  }
  if (!names.length) return { checked: 0, moved: [] };

  const byHash = new Map();
  for (const name of names) byHash.set(await sha512Of(path.join(dir, name)).catch(() => null), name);
  byHash.delete(null);
  const moved = [];
  try {
    const found = await PROVIDERS.modrinth.identify([...byHash.keys()]);
    const ids = [...new Set(Object.values(found).map((v) => v.project_id))];
    const sides = new Map((await PROVIDERS.modrinth.projects(ids)).map((p) => [p.id, p.server_side]));
    const quarantine = path.join(dir, '_client-only');
    for (const [hash, name] of byHash) {
      const projectId = found[hash]?.project_id;
      if (!projectId || sides.get(projectId) !== 'unsupported') continue;
      await fsp.mkdir(quarantine, { recursive: true });
      await fsp.rename(path.join(dir, name), path.join(quarantine, name));
      moved.push(name);
    }
  } catch (err) {
    logger.warn(`Could not check which mods are server-safe: ${err.message}`);
    return { checked: byHash.size, moved, error: err.message };
  }
  if (moved.length) {
    log(`Moved ${moved.length} client-only mod(s) to ${ctx.dir}/_client-only (they stop a server from starting): ${moved.slice(0, 6).join(', ')}${moved.length > 6 ? '…' : ''}`);
  }
  return { checked: byHash.size, moved };
}

module.exports = {
  PROVIDERS,
  providersFor,
  requireProvider,
  credsFor,
  modDir,
  context: compat.modContext,
  search,
  versions,
  install,
  plan,
  listInstalled,
  remove,
  toggle,
  checkUpdates,
  update,
  pruneClientOnlyMods,
  safeFileName,
  parseWorkshopIds: PROVIDERS.workshop.parseIds,
};
