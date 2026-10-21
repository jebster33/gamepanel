'use strict';

/**
 * Storage, host health and ARM routes:
 *   server storage (disk breakdown, bandwidth), log rules, vault backup tools,
 *   host health, graceful host reboot/shutdown, ARM/box64, update history and rollback.
 */

const { fail, json } = require('../../core/util');
const backups = require('../../features/backups');
const vaultTools = require('../../features/vault-tools');
const storage = require('../../features/storage-usage');
const logRules = require('../../features/log-rules');
const hostHealth = require('../../features/host-health');
const { HostPower } = require('../../features/host-power');
const arch = require('../../features/arch');
const updater = require('../../features/updater');
const updateExtras = require('../../features/update-extras');

module.exports = (router, { store, manager }, { requireAdmin, requireCap, serverFor }) => {
  const power = new HostPower({ manager, store });

  // Background jobs: bandwidth totals, daily log rules, host health alerts, scheduled update checks.
  storage.start(manager);
  logRules.start({ manager, store });
  hostHealth.startMonitor({ store });
  updateExtras.startChecks({ store });

  /* ------------------------------------------------------------- storage -- */

  router.get('/api/servers/:id/storage', async ({ user, params, url }) => {
    const server = serverFor(user, params.id, 'files');
    const disk = await storage.disk(server, { refresh: url?.searchParams.get('refresh') === '1' });
    return { disk, kinds: storage.byKind(disk), backups: backups.vault.stats(backups.dirFor(server.id)), network: storage.network(manager, server) };
  });

  /* ----------------------------------------------------------- log rules -- */

  router.get('/api/servers/:id/log-rules', ({ user, params }) => {
    const server = serverFor(user, params.id, 'settings');
    return { rules: server.logRules || { ...logRules.DEFAULTS, override: false }, global: logRules.clean(store.state.settings.logRules), dirs: logRules.LOG_DIRS, last: store.state.settings.logRulesLast || null };
  });

  router.put('/api/servers/:id/log-rules', ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    server.logRules = { ...logRules.clean(body), override: Boolean(body?.override) };
    store.save();
    return { rules: server.logRules };
  });

  router.post('/api/servers/:id/log-rules/run', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'settings');
    const dryRun = body?.dryRun !== false;
    if (!dryRun) requireCap(user, 'files.write', server.id);
    const report = await logRules.run({ manager, store, dryRun, serverId: server.id });
    if (!dryRun && (report.totals.deleted || report.totals.gzipped)) store.addEvent('server.logs_cleaned', `${user.username} cleaned logs of ${server.name}: ${report.totals.deleted} deleted, ${report.totals.gzipped} compressed`, { serverId: server.id });
    return report;
  });

  router.get('/api/settings/log-rules', ({ user }) => {
    requireAdmin(user);
    return { rules: logRules.clean(store.state.settings.logRules), last: store.state.settings.logRulesLast || null, lastRun: store.state.settings.logRulesLastRun || null };
  });

  router.put('/api/settings/log-rules', ({ user, body }) => {
    requireAdmin(user);
    store.state.settings.logRules = logRules.clean(body);
    store.save();
    store.addEvent('panel.settings', `${user.username} changed the log retention rules`);
    return { rules: store.state.settings.logRules };
  });

  router.post('/api/settings/log-rules/run', async ({ user, body }) => {
    requireAdmin(user);
    const dryRun = body?.dryRun !== false;
    const report = await logRules.run({ manager, store, dryRun });
    if (!dryRun) {
      store.state.settings.logRulesLast = { at: report.at, ...report.totals };
      store.save();
    }
    return report;
  });

  /* ---------------------------------------------------------- vault tools -- */

  router.post('/api/servers/:id/backups/vault/check', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'backups');
    return vaultTools.check(backups.dirFor(server.id), { deep: Boolean(body?.deep) });
  });

  router.post('/api/servers/:id/backups/vault/compact', async ({ user, params }) => {
    const server = serverFor(user, params.id, 'backups');
    requireCap(user, 'backups.restore', server.id);
    return backups.vault.compact(backups.dirFor(server.id));
  });

  router.post('/api/servers/:id/backups/vault/retention', async ({ user, params, body }) => {
    const server = serverFor(user, params.id, 'backups');
    requireCap(user, 'backups.restore', server.id);
    const policy = { keepLast: Math.max(0, Math.min(1000, Number(body?.keepLast) || 0)), keepDays: Math.max(0, Math.min(3650, Number(body?.keepDays) || 0)) };
    if (!policy.keepLast && !policy.keepDays) fail(400, 'Set how many backups or how many days to keep');
    const out = await vaultTools.applyRetention(backups.dirFor(server.id), backups.list(server.id), policy, [server.safeUpdate?.backup].filter(Boolean), { dryRun: body?.dryRun !== false });
    if (!out.dryRun && out.removed.length) store.addEvent('backup.pruned', `${user.username} removed ${out.removed.length} old incremental backup${out.removed.length === 1 ? '' : 's'} of ${server.name}`, { serverId: server.id });
    return out;
  });

  /* ---------------------------------------------------------- host health -- */

  router.get('/api/system/host-health', async ({ user, url }) => {
    requireAdmin(user);
    const report = await hostHealth.report({ refresh: url?.searchParams.get('refresh') === '1' });
    return { ...report, problems: hostHealth.problems(report), power: power.status() };
  });

  router.get('/api/system/host-power', ({ user }) => {
    requireAdmin(user);
    return power.status();
  });

  router.post('/api/system/host-power/plan', async ({ user, body }) => {
    requireAdmin(user);
    return power.plan(body?.action === 'shutdown' ? 'shutdown' : 'reboot', Number(body?.seconds) || 60);
  });

  router.post('/api/system/host-power', async ({ user, body }) => {
    requireAdmin(user);
    return power.start({ action: body?.action, seconds: body?.seconds ?? 60, by: user.username });
  });

  router.delete('/api/system/host-power', async ({ user }) => {
    requireAdmin(user);
    return power.cancel(user.username);
  });

  /* ------------------------------------------------------------------ ARM -- */

  router.get('/api/system/arch', ({ user }) => {
    requireAdmin(user);
    return arch.info();
  });

  router.post('/api/system/arch/box64', async ({ user, body }) => {
    requireAdmin(user);
    const result = await arch.installBox({ confirm: body?.confirm === true });
    if (result.ok) store.addEvent('panel.settings', `${user.username} installed box64 for ARM game servers`);
    return result;
  });

  /* -------------------------------------------------------------- updates -- */

  router.get('/api/system/update/history', ({ user }) => {
    requireAdmin(user);
    const s = store.state.settings;
    return { history: updateExtras.history(), rollback: updateExtras.rollbackTarget(), autoCheck: s.updateAutoCheck !== false, lastCheck: s.updateLastCheck || null };
  });

  router.put('/api/system/update/auto-check', ({ user, body }) => {
    requireAdmin(user);
    store.state.settings.updateAutoCheck = body?.enabled !== false;
    store.save();
    return { autoCheck: store.state.settings.updateAutoCheck };
  });

  router.post(
    '/api/system/update/rollback',
    async ({ user, res }) => {
      requireAdmin(user);
      const lines = [];
      const result = await updateExtras.rollback({ onLog: (l) => lines.push(l), user: user.username });
      store.addEvent('panel.updated', `Panel rolled back ${result.from} → ${result.to} by ${user.username}`);
      json(res, 200, { ok: true, ...result, log: lines, restarting: true });
      updater.scheduleRestart();
      return undefined;
    },
    { raw: true }
  );
};
