'use strict';

const { fail, clamp, logger } = require('../../core/util');
const mods = require('../../features/mods');
const { installWorkshop } = require('../../features/mods/workshop');
const { describe } = require('../../features/mods/compat');

module.exports = (router, { store, manager }, { serverFor, integrations }) => {
  /** The server, its template and the version the game itself reports. */
  const modTarget = (user, id, capability = 'mods') => {
    const server = serverFor(user, id, capability);
    const template = manager.template(server);
    if (!template?.mods) fail(400, 'This game has no mod support');
    return { server, template, liveVersion: manager.rt(server.id).version };
  };

  router.get('/api/servers/:id/mods', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'mods');
    const template = manager.template(server);
    if (!template?.mods) return { supported: false, providers: [] };
    const ctx = mods.context(server, template, manager.rt(server.id).version);
    const keys = integrations();
    return {
      supported: true,
      providers: mods.providersFor(template),
      context: { loader: ctx.loader, loaderLabel: ctx.loaderLabel, gameVersion: ctx.gameVersion || null, projectType: ctx.projectType, dir: ctx.dir, filter: describe(ctx) },
      workshop: template.mods.workshop?.strategy ? { strategy: template.mods.workshop.strategy } : template.mods.providers?.includes('workshop') ? { strategy: 'copy' } : null,
      installed: await mods.listInstalled(server, template),
      keys: { curseforge: Boolean(keys.curseforgeKey), workshop: Boolean(keys.steamApiKey), factorio: Boolean(keys.factorio?.token) },
      running: manager.isActive(server.id),
    };
  });

  router.get('/api/servers/:id/mods/search', async ({ user, params, url }) => {
    const { server, template, liveVersion } = modTarget(user, params.id);
    return mods.search(
      server,
      template,
      {
        provider: url.searchParams.get('provider') || template.mods.providers[0],
        query: url.searchParams.get('query') || '',
        page: clamp(url.searchParams.get('page') || 0, 0, 200),
        liveVersion,
      },
      integrations()
    );
  });

  router.get('/api/servers/:id/mods/versions', async ({ user, params, url }) => {
    const { server, template, liveVersion } = modTarget(user, params.id);
    return {
      versions: await mods.versions(server, template, { provider: url.searchParams.get('provider'), projectId: url.searchParams.get('projectId'), liveVersion }, integrations()),
    };
  });

  /** What an install would bring in (the mod plus its dependencies), without downloading anything. */
  router.post('/api/servers/:id/mods/plan', async ({ user, params, body }) => {
    const { server, template, liveVersion } = modTarget(user, params.id);
    const provider = mods.requireProvider(String(body.provider || ''));
    if (provider.id === 'workshop') return { steps: [], notes: [] };
    const ctx = mods.context(server, template, liveVersion);
    const { steps, notes } = await mods.plan(
      provider,
      { projectId: body.projectId, versionId: body.versionId },
      ctx,
      mods.credsFor(provider.id, integrations()),
      require('../../features/mods/manifest').load(server)
    );
    return {
      steps: steps.map((s) => ({ name: s.project.name, version: s.version.version, dependency: s.auto, icon: s.project.icon, size: s.version.file?.size })),
      notes,
    };
  });

  router.post('/api/servers/:id/mods/install', async ({ user, params, body }) => {
    const { server, template, liveVersion } = modTarget(user, params.id);
    const providerId = String(body.provider || '');
    mods.requireProvider(providerId);

    if (providerId === 'workshop') {
      const result = await installWorkshop(server, template, manager, { input: body.input || body.projectId }, integrations());
      store.addEvent('mod.installed', `Workshop ${result.items.join(', ')} added to ${server.name}`, { serverId: server.id });
      return result;
    }

    const result = await mods.install(server, template, { provider: providerId, projectId: body.projectId, versionId: body.versionId, liveVersion }, integrations());
    const main = result.installed.find((i) => !i.dependency) || result.installed[0];
    const extra = result.installed.length - 1;
    store.addEvent('mod.installed', `${main?.name || 'Mod'} installed on ${server.name}${extra > 0 ? ` (+${extra} required)` : ''}`, { serverId: server.id });
    return { ok: true, ...result, restartNeeded: manager.isActive(server.id) };
  });

  router.get('/api/servers/:id/mods/updates', async ({ user, params }) => {
    const { server, template, liveVersion } = modTarget(user, params.id);
    return mods.checkUpdates(server, template, integrations(), { liveVersion });
  });

  router.post('/api/servers/:id/mods/update', async ({ user, params, body }) => {
    const { server, template, liveVersion } = modTarget(user, params.id);
    let keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
    if (body.all) {
      const { updates } = await mods.checkUpdates(server, template, integrations(), { liveVersion });
      // Mods that came with a modpack are left to the pack unless picked one by one.
      keys = updates.filter((u) => !u.fromPack).map((u) => u.key);
    }
    if (!keys.length) return { updated: [], failed: [] };
    const result = await mods.update(server, template, keys, integrations(), { liveVersion, manager, integrations: integrations() });
    if (result.updated.length) store.addEvent('mod.updated', `${result.updated.length} mod(s) updated on ${server.name}`, { serverId: server.id });
    return { ...result, restartNeeded: manager.isActive(server.id) };
  });

  router.delete('/api/servers/:id/mods/:name', async ({ user, params, url }) => {
    const { server, template } = modTarget(user, params.id);
    const result = await mods.remove(server, template, params.name, { keepDependencies: url.searchParams.get('keepDependencies') === '1' });
    store.addEvent('mod.removed', `${result.removed.join(', ')} removed from ${server.name}`, { serverId: server.id });
    return result;
  });

  router.post('/api/servers/:id/mods/:name/toggle', async ({ user, params }) => {
    const { server, template } = modTarget(user, params.id);
    return mods.toggle(server, template, params.name);
  });

  /* ------------------------------------------------------ workshop packs -- */

  const packs = require('../../features/mods/workshop-packs');
  /** The server and its game's Workshop app id. */
  const packTarget = (user, id) => {
    const { server, template } = modTarget(user, id);
    const appId = require('../../features/mods/compat').modContext(server, template).appId;
    if (!appId || !mods.providersFor(template).some((p) => p.id === 'workshop')) fail(400, 'This game has no Steam Workshop');
    return { server, template, appId };
  };

  router.get('/api/servers/:id/workshop-packs', ({ user, params }) => {
    const { appId } = packTarget(user, params.id);
    return { appId, packs: packs.list(store, appId) };
  });

  router.post('/api/servers/:id/workshop-packs/preview', async ({ user, params, body }) => {
    const { appId } = packTarget(user, params.id);
    return packs.preview(body?.input, appId);
  });

  router.post('/api/servers/:id/workshop-packs', async ({ user, params, body }) => {
    const { server, appId } = packTarget(user, params.id);
    const pack = await packs.create(store, { name: body?.name, appId, input: body?.input, fromServer: body?.fromServer ? server : null }, user);
    store.addEvent('mod.pack_saved', `${user.username} saved the Workshop pack ${pack.name} (${pack.items.length} items)`, { serverId: server.id });
    return { pack };
  });

  router.post('/api/servers/:id/workshop-packs/:packId/apply', async ({ user, params }) => {
    const { server, template, appId } = packTarget(user, params.id);
    const pack = packs.get(store, params.packId);
    if (pack.appId !== appId) fail(400, `${pack.name} is a pack for a different game`);
    const result = await installWorkshop(server, template, manager, { input: pack.items.join(',') }, integrations());
    store.addEvent('mod.installed', `Workshop pack ${pack.name} added to ${server.name}`, { serverId: server.id });
    return result;
  });

  router.delete('/api/servers/:id/workshop-packs/:packId', ({ user, params }) => {
    packTarget(user, params.id);
    const pack = packs.get(store, params.packId);
    if (user.role !== 'admin' && pack.createdBy !== user.username) fail(403, 'Only the person who saved a pack, or an administrator, can delete it');
    packs.remove(store, pack.id);
    return { ok: true };
  });

  /* ----------------------------------------------------------- modpacks -- */

  router.get('/api/servers/:id/modpacks', ({ user, params }) => {
    const server = serverFor(user, params.id, 'mods');
    const template = manager.template(server);
    if (!template?.modpacks) return { supported: false };
    const slug = server.pack?.slug || server.vars?.MODPACK;
    return {
      supported: true,
      current: server.vars?.MODPACK
        ? {
            slug,
            versionId: server.vars.MODPACK_VERSION || null,
            label: server.resolvedVersion || server.vars.MODPACK,
            url: server.vars.MODPACK_SOURCE === 'curseforge' ? undefined : `https://modrinth.com/modpack/${slug}`,
            ...(server.pack || {}),
          }
        : null,
      running: manager.isActive(server.id),
    };
  });

  router.get('/api/servers/:id/modpacks/search', async ({ user, params, url }) => {
    serverFor(user, params.id, 'mods');
    const page = clamp(url.searchParams.get('page') || 0, 0, 200);
    if (url.searchParams.get('source') === 'curseforge') {
      // classId 4471 is Minecraft modpacks.
      return mods.PROVIDERS.curseforge.search({ query: url.searchParams.get('query') || '', page, limit: 24, ctx: { cfClass: 4471 }, apiKey: integrations().curseforgeKey });
    }
    return mods.PROVIDERS.modrinth.search({
      query: url.searchParams.get('query') || '',
      page,
      limit: 24,
      ctx: {},
      projectType: 'modpack',
    });
  });

  router.get('/api/servers/:id/modpacks/versions', async ({ user, params, url }) => {
    serverFor(user, params.id, 'mods');
    if (url.searchParams.get('source') === 'curseforge') {
      const key = integrations().curseforgeKey;
      if (!key) fail(400, 'Add a CurseForge API key in Settings, Integrations to use CurseForge.');
      const res = await fetch(`https://api.curseforge.com/v1/mods/${encodeURIComponent(url.searchParams.get('project'))}/files?pageSize=40`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) fail(502, `CurseForge answered ${res.status}`);
      const files = (await res.json()).data || [];
      return {
        versions: files
          .filter((f) => !f.isServerPack && /\.zip$/i.test(f.fileName))
          .sort((a, b) => String(b.fileDate).localeCompare(String(a.fileDate)))
          .map((f) => ({ id: String(f.id), name: f.displayName, version: f.displayName, channel: ({ 1: 'release', 2: 'beta', 3: 'alpha' })[f.releaseType], gameVersions: (f.gameVersions || []).filter((t) => /^\d/.test(t)), loaders: (f.gameVersions || []).filter((t) => /^(forge|fabric|quilt|neoforge)$/i.test(t)).map((t) => t.toLowerCase()), published: f.fileDate, filename: f.fileName })),
      };
    }
    const versions = await mods.PROVIDERS.modrinth.versions({ projectId: url.searchParams.get('project'), ctx: {}, projectType: 'modpack' });
    return {
      versions: versions
        .filter((v) => String(v.file?.filename || '').endsWith('.mrpack'))
        .map((v) => ({ id: v.id, name: v.name, version: v.version, channel: v.channel, gameVersions: v.gameVersions, loaders: v.loaders, published: v.published, filename: v.file.filename })),
    };
  });

  /**
   * What would change going from the installed version of the pack to another
   * one: mods added, removed and updated. Only for the pack already installed.
   */
  router.get('/api/servers/:id/modpacks/diff', async ({ user, url, params }) => {
    const server = serverFor(user, params.id, 'mods');
    const source = url.searchParams.get('source') === 'curseforge' ? 'curseforge' : 'modrinth';
    const project = String(url.searchParams.get('project') || '');
    const target = String(url.searchParams.get('version') || '');
    const pack = server.pack || {};
    const installedSource = pack.source || (server.vars?.MODPACK_SOURCE === 'curseforge' ? 'curseforge' : 'modrinth');
    const sameProject = installedSource === source && [pack.slug, server.vars?.MODPACK].filter(Boolean).map(String).includes(project);
    if (!sameProject) return { available: false, reason: 'A different pack: everything is replaced.' };
    let current = pack.versionId || (source === 'curseforge' ? server.vars?.MODPACK_VERSION : null);
    if (!current && source === 'modrinth' && pack.version) {
      // Installed before the panel kept the version id: find it by its number.
      const versions = await mods.PROVIDERS.modrinth.versions({ projectId: project, ctx: {}, projectType: 'modpack' }).catch(() => []);
      current = versions.find((v) => v.version === pack.version)?.id || null;
    }
    if (!current) return { available: false, reason: 'The panel does not know which version is installed now.' };
    if (current === target) return { available: true, same: true };
    const packDiff = require('../../games/pack-diff');
    try {
      const key = integrations().curseforgeKey;
      const [from, to] = await Promise.all([packDiff.contents({ source, project, version: current, key }), packDiff.contents({ source, project, version: target, key })]);
      return { available: true, ...packDiff.diff(from, to) };
    } catch (err) {
      return { available: false, reason: `Could not compare the versions: ${err.message}` };
    }
  });

  /** Switch the server to a modpack (or another version of it) and reinstall. */
  router.post('/api/servers/:id/modpacks/install', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'mods');
    const template = manager.template(server);
    if (!template?.modpacks) fail(400, 'This server does not use modpacks');
    if (manager.isActive(server.id)) fail(409, 'Stop the server before changing its modpack');
    if (!body.project) fail(400, 'Pick a modpack first');
    // Both end up in the install script's variables: ids only.
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(String(body.project)) || !/^[A-Za-z0-9._-]{0,100}$/.test(String(body.versionId || ''))) fail(400, 'That is not a modpack id');
    const source = body.source === 'curseforge' ? 'curseforge' : 'modrinth';
    if (source === 'curseforge' && !integrations().curseforgeKey) fail(400, 'Add a CurseForge API key in Settings, Integrations first.');
    manager.update(server.id, { vars: { MODPACK: String(body.project), MODPACK_VERSION: String(body.versionId || ''), MODPACK_SOURCE: source } });
    manager.install(server.id, { reinstall: true }).catch((err) => logger.error('Modpack install failed:', err.message));
    store.addEvent('modpack.installed', `${server.name} switched to modpack ${body.project}`, { serverId: server.id });
    return { ok: true, queued: true, message: 'Installing the pack. Watch the console.' };
  });
};
