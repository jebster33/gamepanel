'use strict';

const { json, fail, clamp } = require('../../core/util');
const { config } = require('../../core/config');
const { describeHost, HOST_PLATFORM } = require('../../core/platform');
const updater = require('../../features/updater');
const secrets = require('../../core/secrets');
const { EVENT_CHOICES } = require('../../features/notify');
const VERSION = require('../../../package.json').version;

module.exports = (router, { store, auth, manager, hostMetrics, notifier, bridge }, { requireAdmin, requireCap }) => {
  // For uptime monitors and load balancers: no account needed, nothing about the host given away.
  router.get(
    '/api/health',
    ({ res }) => {
      const ok = !store.lastWriteError;
      json(res, ok ? 200 : 503, { ok, ...(ok ? {} : { problem: 'The panel cannot save its settings (is the disk full?)' }) });
    },
    { public: true }
  );

  router.get('/api/system', ({ user }) => ({
    host: hostMetrics.last,
    overview: manager.overview(),
    version: VERSION,
    nodeName: store.state.settings.nodeName || require('os').hostname(),
    platform: HOST_PLATFORM,
    os: describeHost(),
    docker: { available: manager.dockerAvailable },
    isAdmin: user.role === 'admin',
    bridgeEnabled: user.role === 'admin' ? bridge.enabled : undefined,
    dataDir: user.role === 'admin' ? config.dataDir : undefined,
  }));

  router.get('/api/events', ({ user, url }) => {
    requireCap(user, 'activity');
    const limit = clamp(url.searchParams.get('limit') || 100, 1, 500);
    const all = store.state.events;
    // Panel-level events (nodes with their URLs, bridge connections, ban appeals, sign-ins) are for administrators; everyone else sees their own servers'.
    const visible = all.filter((e) => require('../../features/live-notifications').visibleTo(auth, user, e));
    return { events: visible.slice(0, limit) };
  });

  /** The bell in the top bar: recent events this account may see. */
  router.get('/api/notifications', ({ user }) => ({ notifications: require('../../features/live-notifications').list(store, auth, user) }));

  /** Who changed what, from the audit log. Administrators only. */
  router.get('/api/audit', ({ user, url }) => {
    requireAdmin(user);
    const q = url.searchParams;
    return {
      entries: require('../../features/audit').list({
        q: q.get('q') || '',
        user: q.get('user') || '',
        serverId: q.get('server') || '',
        before: Number(q.get('before')) || Infinity,
        limit: clamp(q.get('limit') || 200, 1, 1000),
      }),
    };
  });

  /** What a fresh panel still needs, shown as a checklist on the dashboard. */
  router.get('/api/system/checklist', ({ user }) => {
    requireAdmin(user);
    const s = store.state.settings;
    const servers = manager.servers;
    return {
      items: [
        { id: 'server', label: 'Create your first server', done: servers.length > 0, link: '#/deploy' },
        { id: 'online', label: 'Start a server and see it come online', done: servers.some((x) => manager.isActive(x.id) || x.lastExit), link: '#/' },
        { id: 'ports', label: 'Open its ports so friends can join', done: store.state.events.some((e) => e.type === 'network.opened'), link: servers[0] ? `#/servers/${servers[0].id}/network` : '#/' },
        { id: 'backup', label: 'Schedule a backup', done: servers.some((x) => (x.schedules || []).some((sc) => sc.action === 'backup')), link: servers[0] ? `#/servers/${servers[0].id}/schedules` : '#/' },
        { id: 'alerts', label: 'Get crash alerts on Discord', done: Boolean(s.notifications?.discordWebhook), link: '#/settings/notifications' },
      ],
      dismissed: Boolean(s.checklistDismissed),
    };
  });

  /* ------------------------------------------------------------ updates -- */

  router.get('/api/system/update', async ({ user }) => {
    requireAdmin(user);
    return updater.checkForUpdate({ channel: store.state.settings.updateChannel });
  });

  router.post(
    '/api/system/update',
    async ({ user, res }) => {
      requireAdmin(user);
      const lines = [];
      const result = await updater.applyUpdate({ onLog: (line) => lines.push(line), channel: store.state.settings.updateChannel });
      store.addEvent('panel.updated', `Panel updated ${result.from} → ${result.to} by ${user.username}`);
      // Reply first, then restart. Containerised servers keep running.
      json(res, 200, { ok: true, ...result, log: lines, restarting: true });
      updater.scheduleRestart();
      return undefined;
    },
    { raw: true }
  );

  router.get('/api/system/runtime', async ({ user }) => {
    requireAdmin(user);
    return {
      platform: HOST_PLATFORM,
      docker: { available: manager.dockerAvailable, info: manager.dockerInfo, socket: config.dockerSocket },
      containerize: store.state.settings.containerize !== false,
      servers: manager.servers.map((s) => ({ id: s.id, name: s.name, platform: s.platform, runtime: manager.runtimeFor(s) })),
    };
  });

  /* ----------------------------------------------------------- settings -- */

  /** Every token, key, secret, password and webhook address in a settings tree, blanked. */
  const blankSecrets = (value) => {
    if (Array.isArray(value)) return value.map(blankSecrets);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /token|secret|key|password|passphrase|webhook/i.test(k) && typeof v === 'string' ? '' : blankSecrets(v)]));
  };

  /** The settings page's copy: sealed tokens are never sent back, only whether one is saved. */
  const settingsView = () => {
    const s = store.state.settings;
    const view = secrets.maskSealed({ ...s, nodes: undefined, oauth: undefined, backupPassphrase: undefined, backupPassphraseSet: Boolean(s.backupPassphrase) });
    if (view.integrations?.cloudflare) view.integrations.cloudflare = { ...view.integrations.cloudflare, tokenSet: Boolean(s.integrations?.cloudflare?.token) };
    return view;
  };

  router.get('/api/settings', ({ user, req }) => {
    requireAdmin(user);
    // Sign-in provider secrets have their own endpoint that never sends them back.
    const settings = settingsView();
    // A read-only API key (a status bot, a dashboard) never sees the keys and tokens the panel holds.
    return { settings: req.gpApiKey?.readOnly ? blankSecrets(settings) : settings, notificationEvents: EVENT_CHOICES };
  });

  router.patch('/api/settings', ({ user, body }) => {
    requireAdmin(user);
    const s = store.state.settings;
    if (body.panelName) s.panelName = String(body.panelName).slice(0, 40);
    if (body.portRangeStart) s.portRangeStart = clamp(body.portRangeStart, 1024, 65535);
    if (body.portRangeEnd) s.portRangeEnd = clamp(body.portRangeEnd, 1024, 65535);
    if (s.portRangeEnd < s.portRangeStart) fail(400, 'The port range ends before it starts');
    if (body.autoRestart !== undefined) s.autoRestart = Boolean(body.autoRestart);
    if (body.autoUpdateGames !== undefined) s.autoUpdateGames = Boolean(body.autoUpdateGames);
    if (body.maxCrashRestarts !== undefined) s.maxCrashRestarts = clamp(body.maxCrashRestarts, 0, 100);
    if (body.containerize !== undefined) s.containerize = Boolean(body.containerize);
    if (body.geoLookup !== undefined) s.geoLookup = Boolean(body.geoLookup);
    if (body.updateChannel !== undefined) s.updateChannel = updater.CHANNELS.includes(body.updateChannel) ? body.updateChannel : undefined;
    if (body.verifyBackups !== undefined) s.verifyBackups = Boolean(body.verifyBackups);
    if (body.scheduledEvents !== undefined) s.scheduledEvents = Boolean(body.scheduledEvents);
    if (body.limits) {
      const n = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
      const l = { ...(s.limits || {}) };
      if (body.limits.memoryMb !== undefined) l.memoryMb = Math.round(n(body.limits.memoryMb, 4 * 1024 * 1024));
      if (body.limits.cpuCores !== undefined) l.cpuCores = +n(body.limits.cpuCores, 1024).toFixed(2);
      if (body.limits.diskGb !== undefined) l.diskGb = Math.round(n(body.limits.diskGb, 1024 * 1024));
      s.limits = l;
    }
    if (body.checklistDismissed !== undefined) s.checklistDismissed = Boolean(body.checklistDismissed);
    if (body.notifications) {
      const n = { ...(s.notifications || {}) };
      if (body.notifications.discordWebhook !== undefined) {
        const url = String(body.notifications.discordWebhook).trim();
        if (url && !/^https:\/\//.test(url)) fail(400, 'The webhook must start with https://');
        n.discordWebhook = url;
      }
      if (Array.isArray(body.notifications.events)) n.events = body.notifications.events.filter((e) => EVENT_CHOICES.includes(e));
      s.notifications = n;
    }
    if (body.integrations) {
      s.integrations = { ...(s.integrations || {}) };
      const { curseforgeKey, steamApiKey, factorio } = body.integrations;
      if (curseforgeKey !== undefined) s.integrations.curseforgeKey = String(curseforgeKey).trim();
      if (steamApiKey !== undefined) s.integrations.steamApiKey = String(steamApiKey).trim();
      const { cloudflare } = body.integrations;
      if (cloudflare !== undefined) {
        const domain = String(cloudflare.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) fail(400, 'Enter the domain like example.com');
        // The saved token is never shown, so leaving the box empty keeps it; `clearToken` removes it.
        const typed = String(cloudflare.token || '').trim();
        const token = cloudflare.clearToken ? '' : typed ? secrets.seal(typed) : s.integrations.cloudflare?.token || '';
        s.integrations.cloudflare = { token, domain };
      }
      if (factorio !== undefined) {
        s.integrations.factorio = { username: String(factorio.username || '').trim(), token: String(factorio.token || '').trim() };
      }
    }
    store.save();
    return { settings: settingsView() };
  });

  /* --------------------------------------------------------- status bots -- */

  const statusBots = require('../../features/status-bots');
  router.get('/api/settings/status-bots', ({ user }) => {
    requireAdmin(user);
    return statusBots.view(store);
  });
  router.put('/api/settings/status-bots', ({ user, body }) => {
    requireAdmin(user);
    return statusBots.update(store, manager, body || {});
  });

  /* -------------------------------------------------------------- HTTPS -- */

  const httpsFeature = require('../../features/https');
  router.get('/api/settings/https', ({ user }) => {
    requireAdmin(user);
    return httpsFeature.status(store);
  });
  router.put('/api/settings/https', async ({ user, body }) => {
    requireAdmin(user);
    httpsFeature.update(store, body || {});
    // Turning it off (or on with a certificate already there) applies right away.
    await httpsFeature.serve(store).catch((err) => fail(400, err.message));
    store.addEvent('panel.settings', `${user.username} changed the HTTPS settings`);
    return httpsFeature.status(store);
  });
  /** Get or renew the certificate now. Runs in the background; the status shows how it goes. */
  router.post('/api/settings/https/issue', ({ user }) => {
    requireAdmin(user);
    httpsFeature.issue(store).catch(() => {});
    return httpsFeature.status(store);
  });

  /* --------------------------------------------------------------- SFTP -- */

  const sftp = require('../../features/sftp');
  /** For the Files tab: whether SFTP is on, and where. */
  router.get('/api/sftp', () => {
    const st = sftp.status(store);
    return { enabled: Boolean(st.listening), port: st.listening, fingerprint: st.fingerprint };
  });
  router.get('/api/settings/sftp', ({ user }) => {
    requireAdmin(user);
    return sftp.status(store);
  });
  router.put('/api/settings/sftp', async ({ user, body }) => {
    requireAdmin(user);
    try {
      sftp.update(store, body || {});
      await sftp.start({ store, auth, manager });
    } catch (err) {
      fail(400, err.message);
    }
    store.addEvent('panel.settings', `${user.username} ${store.state.settings.sftp.enabled ? 'turned on' : 'turned off'} SFTP`);
    return sftp.status(store);
  });

  router.post('/api/settings/notifications/test', async ({ user, body }) => {
    requireAdmin(user);
    try {
      return await notifier.test(body.discordWebhook);
    } catch (err) {
      return fail(400, `Discord did not accept the message: ${err.message}`);
    }
  });

  /**
   * The panel's own state (accounts, settings, keys, player history) as one
   * .tar.gz, for moving to a new machine or recovering from a dead disk.
   * Server files and backups are left out; they have their own exports.
   * Holds password hashes and secrets, so it asks for the password again.
   */
  router.post('/api/system/panel-backup', ({ user, body, res }) => {
    requireAdmin(user);
    const record = auth.users.find((u) => u.id === user.id);
    auth.checkPassword(record, body?.password);
    const fs = require('fs');
    const path = require('path');
    const { spawn } = require('child_process');
    const parts = ['panel.json', 'secret.key', 'push-keys.json', 'players', 'templates'].filter((p) => fs.existsSync(path.join(config.dataDir, p)));
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    store.addEvent('panel.backup', `${user.username} downloaded a backup of the panel's settings and accounts`);
    store.saveNow();
    manager.saveHistories?.();
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="gamepanel-settings-${new Date().toISOString().slice(0, 10)}.tar.gz"` });
    const proc = spawn(tar, ['-czf', '-', ...parts], { cwd: config.dataDir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    proc.stdout.pipe(res);
    proc.on('error', () => res.destroy());
    res.on('close', () => proc.kill());
    return undefined;
  });

  /** The Discord bot (slash commands). */
  const discordBot = require('../../features/discord-bot').init({ store, manager });

  router.get('/api/settings/discord-bot', ({ user }) => {
    requireAdmin(user);
    return discordBot.status();
  });

  router.put('/api/settings/discord-bot', ({ user, body }) => {
    requireAdmin(user);
    const s = store.state.settings;
    const controllers = String(body?.controllers || '')
      .split(/[\s,]+/)
      .filter((id) => /^\d{15,22}$/.test(id))
      .join(',');
    const token = body?.token === undefined ? s.integrations?.discordBot?.token || '' : secrets.seal(String(body.token).trim());
    // Spread first: the status-bot presence settings live beside the token.
    s.integrations = { ...(s.integrations || {}), discordBot: { ...(s.integrations?.discordBot || {}), token, controllers } };
    store.save();
    discordBot.reload();
    return discordBot.status();
  });
};
