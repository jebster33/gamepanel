import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { $, esc, fmtBytes, toast } from '../core/util.js';
import { confirmModal } from '../ui/modal.js';

/* ----------------------------------------------------------------------
   Cards for: notification preferences (every account), monthly reports and
   extensions (administrators). Shown in Account and Settings.
---------------------------------------------------------------------- */

const lsGet = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

/* --------------------------------------------- desktop (background) push -- */

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
const urlKey = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function panelSubscription() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sw = reg?.active?.scriptURL.endsWith('/panel-sw.js') ? reg : null;
  return sw ? sw.pushManager.getSubscription() : null;
}

async function enableDesktopPush() {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed in the browser');
  const reg = await navigator.serviceWorker.register('/panel-sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const info = await api('/api/push');
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(info.publicKey) }));
  await api('/api/push', { method: 'POST', body: { subscription: sub.toJSON(), device: `${navigator.platform || 'Browser'} (panel)`, client: 'panel' } });
  lsSet('gp-desktop-push', '1');
  return sub;
}

async function disableDesktopPush() {
  const sub = await panelSubscription();
  if (sub) {
    await api('/api/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  lsSet('gp-desktop-push', null);
}

/* ------------------------------------------------ notification preferences -- */

export async function renderNotifyPrefs(el) {
  if (!el) return;
  const supported = pushSupported();
  const sub = supported ? await panelSubscription().catch(() => null) : null;
  const endpoint = sub?.endpoint || '';
  const data = await api(`/api/notify-prefs${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`).catch(() => null);
  if (!data) return;
  const muted = new Set(data.prefs.mutedCategories);
  const mutedServers = new Set(data.prefs.mutedServers);
  el.innerHTML = `
    <h4>Notifications</h4>
    <p class="faint" style="margin:0 0 12px">Choose what the bell, desktop notifications and phone alerts tell you about. Anything switched off is not sent at all. ${endpoint ? 'This browser has its own list.' : 'This list applies to all your devices.'}</p>
    ${
      supported
        ? `<label class="checkbox-row"><input type="checkbox" id="np-desktop" ${sub ? 'checked' : ''} /><span>Desktop notifications, even when the panel is closed (with Restart / Start / Open console buttons)</span></label>
           <div class="hint" id="np-desktop-note">${Notification.permission === 'denied' ? 'The browser is blocking notifications for this site. Allow them in the site settings first.' : 'Uses your browser\'s push service. Works on https:// addresses and localhost.'}</div>
           ${sub ? '<button class="btn btn-sm mt-16" id="np-test">Send a test notification</button>' : ''}`
        : '<div class="hint">Desktop notifications need this page on https:// (or localhost) in a browser that supports push.</div>'
    }
    <div class="tile-label" style="margin:16px 0 6px">Tell me about</div>
    <div class="np-list">${data.categories.map((c) => `<label class="checkbox-row"><input type="checkbox" data-cat="${esc(c.id)}" ${muted.has(c.id) ? '' : 'checked'} /><span>${esc(c.label)}</span></label>`).join('')}</div>
    ${
      data.servers.length
        ? `<div class="tile-label" style="margin:16px 0 6px">Servers</div>
           <div class="np-list">${data.servers.map((s) => `<label class="checkbox-row"><input type="checkbox" data-srv="${esc(s.id)}" ${mutedServers.has(s.id) ? '' : 'checked'} /><span>${esc(s.name)}</span></label>`).join('')}</div>`
        : ''
    }
    ${endpoint && data.scope === 'device' ? '<button class="btn btn-sm mt-16" id="np-reset">Use my account list on this browser</button>' : ''}`;

  const save = async () => {
    const body = {
      mutedCategories: [...el.querySelectorAll('[data-cat]')].filter((b) => !b.checked).map((b) => b.dataset.cat),
      mutedServers: [...el.querySelectorAll('[data-srv]')].filter((b) => !b.checked).map((b) => b.dataset.srv),
      endpoint: endpoint || undefined,
    };
    await api('/api/notify-prefs', { method: 'PUT', body }).catch((err) => toast(err.message, 'error'));
  };
  el.querySelectorAll('[data-cat],[data-srv]').forEach((box) => box.addEventListener('change', save));
  $('#np-reset', el)?.addEventListener('click', async () => {
    await api('/api/notify-prefs', { method: 'PUT', body: { endpoint, reset: true } });
    renderNotifyPrefs(el);
  });
  $('#np-desktop', el)?.addEventListener('change', async (e) => {
    e.target.disabled = true;
    try {
      if (e.target.checked) await enableDesktopPush();
      else await disableDesktopPush();
      toast(e.target.checked ? 'Desktop notifications on' : 'Desktop notifications off');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderNotifyPrefs(el);
  });
  $('#np-test', el)?.addEventListener('click', () =>
    api('/api/push/test', { method: 'POST', body: { endpoint } })
      .then(() => toast('Sent. It should arrive in a moment.'))
      .catch((err) => toast(err.message, 'error'))
  );
}

/* ---------------------------------------------------------------- reports -- */

function monthOptions() {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < 13; i++) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push(`<option value="${key}">${d.toLocaleString('en', { month: 'long', year: 'numeric' })}${i === 0 ? ' (so far)' : ''}</option>`);
    d.setMonth(d.getMonth() - 1);
  }
  return out.join('');
}

async function renderReports(el) {
  const data = await api('/api/reports').catch(() => null);
  if (!data) return;
  el.innerHTML = `
    <h4>Monthly uptime report</h4>
    <p class="faint" style="margin:0 0 12px">A PDF for the whole panel and each server: uptime, crashes, restarts, peak players, backups and disk growth. Numbers start from when the panel began recording them, so a brand new panel shows little.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
      <select id="rp-month" style="width:auto">${monthOptions()}</select>
      <select id="rp-server" style="width:auto"><option value="">All servers</option>${data.servers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
      <a class="btn" id="rp-download" href="#">Download PDF</a>
      <button class="btn" id="rp-save">Save in the reports folder</button>
    </div>
    <label class="checkbox-row mt-16"><input type="checkbox" id="rp-auto" ${data.auto ? 'checked' : ''} /><span>Make last month's report automatically on the 1st, and announce it with the alert channels (Discord, ntfy, the bell)</span></label>
    <div class="hint">Automatic reports are saved on the panel in <span class="mono">data/reports</span>. Tick "Monthly uptime report ready" under Alerts to get it on Discord.</div>
    <div id="rp-list" style="margin-top:12px">${
      data.reports.length
        ? data.reports.map((r) => `<div class="row" style="gap:12px;padding:4px 0"><span style="flex:1">${esc(r.label)}</span><span class="faint">${fmtBytes(r.size)}</span><a class="btn btn-sm" href="/api/reports/file/${encodeURIComponent(r.name)}">Download</a></div>`).join('')
        : '<div class="faint">No saved reports yet.</div>'
    }</div>`;
  const link = () => {
    const server = $('#rp-server', el).value;
    $('#rp-download', el).href = `/api/reports/uptime.pdf?month=${encodeURIComponent($('#rp-month', el).value)}${server ? `&server=${encodeURIComponent(server)}` : ''}`;
  };
  link();
  $('#rp-month', el).addEventListener('change', link);
  $('#rp-server', el).addEventListener('change', link);
  $('#rp-save', el).addEventListener('click', async () => {
    try {
      await api('/api/reports/generate', { method: 'POST', body: { month: $('#rp-month', el).value } });
      toast('Report saved');
      renderReports(el);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#rp-auto', el).addEventListener('change', (e) => api('/api/reports/settings', { method: 'PUT', body: { auto: e.target.checked } }).then(() => toast(e.target.checked ? 'Monthly reports on' : 'Monthly reports off')).catch((err) => toast(err.message, 'error')));
}

/* ------------------------------------------------------------- extensions -- */

async function renderExtensions(el) {
  const data = await api('/api/extensions').catch(() => null);
  if (!data) return;
  const kinds = (e) => [e.themes.length && `${e.themes.length} theme${e.themes.length > 1 ? 's' : ''}`, e.pages.length && 'pages', e.widgets.length && 'widgets', e.hooks.length && 'webhooks', e.code && 'runs code'].filter(Boolean).join(', ');
  el.innerHTML = `
    <h4>Extensions</h4>
    <p class="faint" style="margin:0 0 12px">Add-ons that change how the panel looks (themes) or add pages, dashboard widgets and webhooks. <b>Installing an extension means you trust its author.</b> Themes, pages and widgets are sandboxed and can only read the little they ask for. See <span class="mono">docs/extensions.md</span>.</p>
    <div id="ex-list">${data.extensions
      .map(
        (e) => `<div class="row" style="gap:12px;padding:8px 0;border-top:1px solid var(--border);align-items:center">
          <div style="flex:1;min-width:0"><b>${esc(e.title)}</b> <span class="faint">${esc(e.version)}${e.builtin ? ' · built in' : ''}${e.author ? ` · ${esc(e.author)}` : ''}</span>
            <div class="faint" style="font-size:12px">${esc(kinds(e) || 'nothing')}${e.code && !e.codeRunning ? ' (code is not running)' : ''}${e.hooks.length ? ` · ${esc(e.hooks.join('; '))}` : ''}</div>
            ${e.errors.length ? `<div style="color:var(--red);font-size:12px">${esc(e.errors.join('. '))}</div>` : ''}</div>
          ${e.valid ? `<label class="checkbox-row" style="margin:0"><input type="checkbox" data-en="${esc(e.name)}" ${e.enabled ? 'checked' : ''} /><span>On</span></label>` : ''}
          ${e.builtin ? '' : `<button class="btn btn-sm" data-rm="${esc(e.name)}">Remove</button>`}</div>`
      )
      .join('')}</div>
    <div class="row mt-16" style="gap:8px;flex-wrap:wrap">
      <input id="ex-url" placeholder="https://… link to a .zip (or a GitHub repository)" style="flex:1;min-width:220px" />
      <button class="btn" id="ex-install-url">Install from link</button>
      <label class="btn" style="cursor:pointer">Upload a .zip<input id="ex-zip" type="file" accept=".zip,application/zip" style="display:none" /></label>
    </div>
    <div class="card" style="margin-top:16px;border-color:var(--amber)">
      <label class="checkbox-row"><input type="checkbox" id="ex-code" ${data.allowCode ? 'checked' : ''} /><span><b>Allow code extensions</b> (off by default)</span></label>
      <div class="hint" style="color:var(--amber)">Warning: a code extension runs inside the panel with the same power as the panel itself: it can read every setting and file the panel can, and run commands. Only turn this on for code you have read or fully trust. Takes effect after the panel restarts.</div>
    </div>`;

  const refresh = () => renderExtensions(el);
  el.querySelectorAll('[data-en]').forEach((b) =>
    b.addEventListener('change', async () => {
      await api(`/api/extensions/${encodeURIComponent(b.dataset.en)}`, { method: 'PUT', body: { enabled: b.checked } }).catch((err) => toast(err.message, 'error'));
      // Themes, pages and widgets change what the whole panel shows.
      toast('Saved. Reload the page to see the change.');
      refresh();
    })
  );
  el.querySelectorAll('[data-rm]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmModal('Remove extension', `Delete ${b.dataset.rm} from this panel?`, 'Remove'))) return;
      await api(`/api/extensions/${encodeURIComponent(b.dataset.rm)}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      refresh();
    })
  );
  $('#ex-install-url', el).addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const url = $('#ex-url', el).value.trim();
    if (!url) return;
    if (!(await confirmModal('Install extension', 'Installing means you trust whoever wrote it. Continue?', 'Install'))) return;
    btn.disabled = true;
    try {
      const r = await api('/api/extensions/install-url', { method: 'POST', body: { url } });
      toast(`Installed ${r.installed}`);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
  $('#ex-zip', el).addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (!(await confirmModal('Install extension', `Install ${file.name}? Installing means you trust whoever wrote it.`, 'Install'))) return;
    try {
      const res = await fetch('/api/extensions/install-zip', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/zip' }, body: file });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Upload failed (${res.status})`);
      toast(`Installed ${body.installed}`);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#ex-code', el).addEventListener('change', async (event) => {
    const on = event.target.checked;
    if (on && !(await confirmModal('Allow code extensions', 'Code extensions run inside the panel with full access to it. Only continue if you trust every code extension you install.', 'Allow'))) {
      event.target.checked = false;
      return;
    }
    await api('/api/extensions/settings', { method: 'PUT', body: { allowCode: on } }).catch((err) => toast(err.message, 'error'));
    toast(on ? 'Code extensions allowed after the next restart' : 'Code extensions off after the next restart');
  });
}

/** The administrator's cards in Settings: reports, extensions, and the same notification toggles. */
export function renderExtSettings(box) {
  if (!box || state.user?.role !== 'admin') return;
  box.innerHTML = '<div class="card mb-16" id="settings-notify-prefs"></div><div class="card mb-16" id="reports"></div><div class="card mb-16" id="extensions"></div>';
  renderNotifyPrefs($('#settings-notify-prefs', box));
  renderReports($('#reports', box));
  renderExtensions($('#extensions', box));
}
