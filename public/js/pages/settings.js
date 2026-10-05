import { api } from '../core/api.js';
import { loadTemplates } from '../core/boot.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtBytes, fmtDuration, fmtTime, toast } from '../core/util.js';
import { confirmModal } from '../ui/modal.js';

/* -------------------------------------------------------------- settings */

const EVENT_LABELS = {
  'server.crashed': 'A server crashes',
  'server.install_failed': 'An install or update fails',
  'server.installed': 'A server finishes installing',
  'server.ready': 'A server comes online',
  'server.stopped': 'A server stops',
  'backup.created': 'A backup is made',
  'backup.failed': 'A backup fails',
  'schedule.failed': 'A scheduled task fails',
  'panel.updated': 'The panel updates itself',
  'user.login': 'Someone signs in',
};

export async function renderSettings(view) {
  setCrumbs('Settings');
  const data = await api('/api/settings').catch((err) => ({ settings: {}, error: err.message }));
  const s = data.settings;
  const integrations = s.integrations || {};
  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="lede">Panel-wide options. Per-server options live on each server's Settings tab.</div></div></div>

    <div class="card mb-16" id="notifications">
      <h4>Alerts</h4>
      <p class="faint" style="margin:0 0 14px">Post to a Discord channel when something needs you. In Discord: channel settings, Integrations, Webhooks, New webhook, Copy URL.</p>
      <label class="field"><span>Discord webhook URL</span>
        <div class="input-row">
          <input id="n-webhook" type="url" value="${esc(s.notifications?.discordWebhook || '')}" placeholder="https://discord.com/api/webhooks/…" />
          <button class="btn" id="n-test">Send test</button>
        </div>
      </label>
      <div class="field-label">Send an alert when</div>
      <div class="perm-grid" style="gap:2px 14px">${(data.notificationEvents || [])
        .map(
          (e) => `<label class="perm-row"><input type="checkbox" data-event="${esc(e)}" ${
            (s.notifications?.events || data.notificationEvents).includes(e) ? 'checked' : ''
          } /><span>${esc(EVENT_LABELS[e] || e)}</span></label>`
        )
        .join('')}</div>
      <button class="btn btn-primary mt-16" id="n-save">Save alerts</button>
    </div>

    <div class="card mb-16" id="updates">
      <h4>Panel updates</h4>
      <p class="faint" style="margin:0 0 14px">
        Updates pull the latest code and restart the panel. Servers running in containers keep running —
        the panel re-attaches to them when it comes back.
      </p>
      <div class="row"><button class="btn" id="update-check">Check for updates</button>
        <span id="update-status" class="faint"></span></div>
      <div id="update-detail" class="mt-16"></div>
    </div>

    <div class="card mb-16">
      <h4>Runtime</h4>
      <div id="runtime-info" class="faint" style="margin-bottom:12px">Checking Docker…</div>
      <div class="checkbox-row"><input type="checkbox" id="s-containerize" ${
        s.containerize !== false ? 'checked' : ''
      } /><label for="s-containerize">Run each game server in its own container (isolation, hard memory/CPU limits, per-server network stats)</label></div>
      <div class="hint">Applies the next time a server starts. Without Docker the panel falls back to plain processes.</div>
    </div>

    <div class="card mb-16" id="integrations">
      <h4>Integrations</h4>
      <p class="faint" style="margin:0 0 14px">Optional API keys for the mod browser. Modrinth and uMod work without any key.</p>
      <div class="form-grid">
        <label><span>CurseForge API key</span><input id="i-curseforge" type="password" value="${esc(
          integrations.curseforgeKey || ''
        )}" placeholder="console.curseforge.com" /></label>
        <label><span>Steam Web API key</span><input id="i-steam" type="password" value="${esc(
          integrations.steamApiKey || ''
        )}" placeholder="steamcommunity.com/dev/apikey" /></label>
        <label><span>Factorio username</span><input id="i-factorio-user" value="${esc(
          integrations.factorio?.username || ''
        )}" /></label>
        <label><span>Factorio token</span><input id="i-factorio-token" type="password" value="${esc(
          integrations.factorio?.token || ''
        )}" /></label>
      </div>
      <button class="btn mt-16" id="i-save">Save integrations</button>
    </div>

    <div class="card mb-16">
      <h4>General</h4>
      <div class="form-grid">
        <label><span>Panel name</span><input id="s-name" value="${esc(s.panelName || 'GamePanel')}" /></label>
        <label><span>Port range start</span><input id="s-port-start" type="number" value="${s.portRangeStart}" /></label>
        <label><span>Port range end</span><input id="s-port-end" type="number" value="${s.portRangeEnd}" /></label>
        <label><span>Max crash restarts (per 10 min)</span><input id="s-max-crash" type="number" value="${s.maxCrashRestarts}" /></label>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="s-autorestart" ${s.autoRestart ? 'checked' : ''} /><label for="s-autorestart">Enable crash auto-restart globally</label></div>
      <div class="checkbox-row"><input type="checkbox" id="s-geo" ${
        s.geoLookup !== false ? 'checked' : ''
      } /><label for="s-geo">Show sign-in locations in the activity log</label></div>
      <div class="hint">Looks public sign-in IPs up via ipwho.is. Private and LAN addresses are labelled locally and never leave the machine.</div>
      <button class="btn btn-primary mt-16" id="s-save">Save settings</button>
    </div>

    <div class="card mb-16">
      <h4>Change your password</h4>
      <div class="form-grid">
        <label><span>Current password</span><input id="p-current" type="password" autocomplete="current-password" /></label>
        <label><span>New password</span><input id="p-new" type="password" autocomplete="new-password" /></label>
      </div>
      <button class="btn mt-16" id="p-save">Update password</button>
    </div>

    <div class="card">
      <h4>System</h4>
      <div class="table-wrap"><table>
        <tr><th>Panel version</th><td>v${esc(state.version || '')}</td></tr>
        <tr><th>Host</th><td>${esc(state.host?.hostname || '')} · ${esc(state.host?.platform || '')}</td></tr>
        <tr><th>CPU</th><td>${esc(state.host?.cpu.model || '')} (${state.host?.cpu.cores} cores)</td></tr>
        <tr><th>Memory</th><td>${fmtBytes(state.host?.memory.total)}</td></tr>
        <tr><th>Uptime</th><td>${fmtDuration((state.host?.uptime || 0) * 1000)}</td></tr>
        <tr><th>Templates loaded</th><td>${state.templates.length}</td></tr>
      </table></div>
      <button class="btn mt-16" id="s-reload-templates">Reload templates</button>
    </div>`;

  $('#n-test').addEventListener('click', async () => {
    try {
      await api('/api/settings/notifications/test', { method: 'POST', body: { discordWebhook: $('#n-webhook').value.trim() } });
      toast('Test message sent. Check the channel.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#n-save').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: {
          notifications: {
            discordWebhook: $('#n-webhook').value.trim(),
            events: [...document.querySelectorAll('[data-event]')].filter((el) => el.checked).map((el) => el.dataset.event),
          },
        },
      });
      toast('Alerts saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  if (state.route.params.section) $(`#${CSS.escape(state.route.params.section)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Runtime status
  api('/api/system/runtime')
    .then((data) => {
      const el = $('#runtime-info');
      if (!el) return;
      el.innerHTML = data.docker.available
        ? `Docker ${esc(data.docker.info?.version || '')} detected — servers run isolated in containers.`
        : `Docker not found at <span class="mono">${esc(
            data.docker.socket
          )}</span>. Servers run as plain processes and share the host. Install Docker and restart the panel for isolation.`;
    })
    .catch(() => {});

  $('#s-containerize').addEventListener('change', async (event) => {
    try {
      await api('/api/settings', { method: 'PATCH', body: { containerize: event.target.checked } });
      toast(event.target.checked ? 'Containers enabled for new starts' : 'Containers disabled');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#i-save').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: {
          integrations: {
            curseforgeKey: $('#i-curseforge').value,
            steamApiKey: $('#i-steam').value,
            factorio: { username: $('#i-factorio-user').value, token: $('#i-factorio-token').value },
          },
        },
      });
      toast('Integrations saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#update-check').addEventListener('click', () => checkForUpdates(true));
  checkForUpdates(false);

  $('#s-save').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: {
          panelName: $('#s-name').value,
          portRangeStart: Number($('#s-port-start').value),
          portRangeEnd: Number($('#s-port-end').value),
          maxCrashRestarts: Number($('#s-max-crash').value),
          autoRestart: $('#s-autorestart').checked,
          geoLookup: $('#s-geo').checked,
        },
      });
      $('#brand-name').textContent = $('#s-name').value;
      toast('Settings saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#p-save').addEventListener('click', async () => {
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: $('#p-current').value, newPassword: $('#p-new').value },
      });
      toast('Password updated');
      $('#p-current').value = '';
      $('#p-new').value = '';
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#s-reload-templates').addEventListener('click', async () => {
    const data = await api('/api/templates/reload', { method: 'POST', body: {} });
    await loadTemplates();
    toast(`${data.count} templates loaded`);
  });
}

/* --------------------------------------------------------------- updates */

async function checkForUpdates(interactive) {
  const status = $('#update-status');
  const detail = $('#update-detail');
  if (!status) return;
  status.innerHTML = '<span class="spinner"></span> Checking…';
  detail.innerHTML = '';

  let data;
  try {
    data = await api('/api/system/update');
  } catch (err) {
    status.textContent = err.message;
    return;
  }

  if (!data.supported) {
    status.textContent = data.reason;
    return;
  }
  if (data.error) {
    status.textContent = data.error;
    return;
  }

  const current = data.current ? `${data.current.commit} · ${fmtTime(Date.parse(data.current.date))}` : 'unknown';
  if (!data.updateAvailable) {
    status.innerHTML = `Up to date — v${esc(data.version)} (${esc(current)})`;
    return;
  }

  status.innerHTML = `<b>${data.behind} update${data.behind === 1 ? '' : 's'} available</b> — you are on ${esc(current)}`;
  detail.innerHTML = `
    <div class="card" style="background:rgba(74,222,128,.06)">
      <div class="table-wrap"><table>
        ${data.commits
          .map(
            (c) => `<tr><td class="mono faint nowrap" style="width:80px">${esc(c.commit)}</td>
                      <td>${esc(c.subject)}</td>
                      <td class="faint nowrap">${fmtTime(Date.parse(c.date))}</td></tr>`
          )
          .join('')}
      </table></div>
      <button class="btn btn-primary mt-16" id="update-apply">Update and restart</button>
    </div>`;

  $('#update-apply').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    if (!(await confirmModal('Update the panel', 'The panel will restart. Containerised game servers keep running; plain processes are stopped and restarted.', 'Update'))) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Updating…';
    try {
      const result = await api('/api/system/update', { method: 'POST', body: {} });
      detail.innerHTML = `<div class="card">Updated ${esc(result.from)} → ${esc(result.to)}. Waiting for the panel to come back…</div>`;
      waitForPanel();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Update and restart';
    }
  });
}

/** Poll /api/status after an update until the new panel answers, then reload. */
function waitForPanel(attempt = 0) {
  setTimeout(async () => {
    try {
      await api('/api/status');
      toast('Panel updated — reloading');
      setTimeout(() => location.reload(), 800);
    } catch {
      if (attempt < 40) waitForPanel(attempt + 1);
      else toast('The panel did not come back. Check: journalctl -u gamepanel -n 50', 'error', 15000);
    }
  }, 2000);
}
