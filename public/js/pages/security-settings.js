import { api } from '../core/api.js';
import { $, esc, fmtBytes, fmtTime, toast } from '../core/util.js';
import { confirmModal } from '../ui/modal.js';

/* Settings, "Security and access": single sign-on (OpenID Connect), IP allowlist, connection flood blocking, backup test restores. */

const lines = (text) => String(text || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
const card = (id, title, intro) => `<div class="sec2-block" id="${id}"><h4>${esc(title)}</h4><p class="faint" style="margin:0 0 12px;line-height:1.6">${intro}</p><div class="sec2-body faint">Loading...</div></div>`;

export function renderSecuritySettings(host) {
  if (!host) return;
  host.innerHTML = `<h3 style="margin-top:0">Security and access</h3>
    ${card('sec2-oidc', 'Single sign-on (OpenID Connect)', 'Let people sign in with Authentik, Keycloak, Authelia, Microsoft Entra or any other OpenID Connect provider. They link it once on their Account page; accounts are never created this way.')}
    ${card('sec2-ip', 'IP allowlist', 'Only the listed addresses can sign in or use the panel. This machine (localhost) is always allowed.')}
    ${card('sec2-flood', 'Connection flood blocking', 'Temporarily blocks addresses that open far too many connections to a game server, with a firewall rule that removes itself. Turn it on per server.')}
    ${card('sec2-tests', 'Backup test restores', 'Proves a backup really restores: unpacks it into a scratch folder, checks the files and the game saves, then deletes the scratch copy.')}`;
  oidc();
  ipAllowlist();
  flood();
  backupTests();
}

const body = (id) => $(`#${id} .sec2-body`);
function mount(id, html) {
  const el = body(id);
  if (!el?.isConnected) return null;
  el.classList.remove('faint');
  el.innerHTML = html;
  return el;
}
const fail = (id, err) => {
  const el = body(id);
  if (el) el.textContent = err.message;
};

/* ------------------------------------------------------------------ OIDC */

async function oidc() {
  let d;
  try {
    d = await api('/api/settings/oidc');
  } catch (err) {
    return fail('sec2-oidc', err);
  }
  const el = mount(
    'sec2-oidc',
    `<div class="form-grid">
      <label><span>Button label</span><input id="oi-label" value="${esc(d.label)}" placeholder="Authentik" /></label>
      <label><span>Discovery address (issuer)</span><input id="oi-issuer" value="${esc(d.issuer)}" placeholder="https://auth.example.com/application/o/gamepanel/" autocomplete="off" /></label>
      <label><span>Client ID</span><input id="oi-id" value="${esc(d.clientId)}" autocomplete="off" /></label>
      <label><span>Client secret</span><input id="oi-secret" type="password" placeholder="${d.hasSecret ? 'Saved (leave empty to keep)' : ''}" autocomplete="off" /></label>
      <label><span>Scopes</span><input id="oi-scopes" value="${esc(d.scopes)}" /></label>
    </div>
    <div class="hint">Redirect URL to register with the provider: <span class="mono" style="overflow-wrap:anywhere">${esc(d.redirectUri)}</span></div>
    <div class="field-label" style="margin-top:12px">Only allow sign-in through SSO for these accounts</div>
    <div class="hint">They must have linked their SSO account first. Passwords and passkeys stop working for them.</div>
    <div class="row" style="flex-wrap:wrap;gap:12px;margin-top:6px">${d.accounts
      .map((a) => `<label class="row" style="gap:6px"><input type="checkbox" data-oi-only="${esc(a.id)}" ${d.ssoOnly.includes(a.id) ? 'checked' : ''} ${a.linked ? '' : 'disabled'} /> ${esc(a.username)}${a.linked ? '' : ' <span class="faint">(not linked)</span>'}</label>`)
      .join('')}</div>
    <div class="row" style="gap:8px;margin-top:14px"><button class="btn btn-primary" id="oi-save">Save</button><button class="btn" id="oi-test">Test the connection</button><button class="btn btn-ghost btn-danger" id="oi-clear">Remove</button></div>`
  );
  if (!el) return;
  const payload = () => ({
    label: $('#oi-label').value,
    issuer: $('#oi-issuer').value,
    clientId: $('#oi-id').value,
    clientSecret: $('#oi-secret').value,
    scopes: $('#oi-scopes').value,
    ssoOnly: [...el.querySelectorAll('[data-oi-only]:checked')].map((c) => c.dataset.oiOnly),
  });
  $('#oi-save').onclick = async () => {
    try {
      await api('/api/settings/oidc', { method: 'PUT', body: payload() });
      toast('Single sign-on saved');
      oidc();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  };
  $('#oi-test').onclick = async () => {
    try {
      await api('/api/settings/oidc', { method: 'PUT', body: payload() });
      const r = await api('/api/settings/oidc/test', { method: 'POST', body: {} });
      toast(`Connected to ${r.issuer}${r.pkce ? '' : ' (provider does not list PKCE support)'}`);
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  };
  $('#oi-clear').onclick = async () => {
    if (!(await confirmModal('Remove single sign-on', 'Everyone loses their SSO link. Passwords still work.', 'Remove'))) return;
    await api('/api/settings/oidc', { method: 'PUT', body: { clear: true } }).catch((e) => toast(e.message, 'error'));
    oidc();
  };
}

/* ----------------------------------------------------------- IP allowlist */

async function ipAllowlist() {
  let d;
  try {
    d = await api('/api/settings/ip-allowlist');
  } catch (err) {
    return fail('sec2-ip', err);
  }
  const el = mount(
    'sec2-ip',
    `<div class="callout" style="margin-bottom:12px">Your current address: <b class="mono">${esc(d.yourIp)}</b> ${d.loopback ? '(this machine, always allowed)' : d.yourIpAllowed ? '(on the list)' : '(<b>not</b> on the list)'}
      ${d.loopback && d.behindProxy ? '<div class="hint">You are behind a proxy that shows up as this machine. Check GP_PROXY_HOPS, or every visitor will look like localhost.</div>' : ''}</div>
    <label class="row" style="gap:8px"><input type="checkbox" id="ip-on" ${d.enabled ? 'checked' : ''} /> Turn the allowlist on</label>
    <label class="field" style="margin-top:10px"><span>Allowed addresses and ranges (one per line)</span><textarea id="ip-list" rows="5" placeholder="203.0.113.7&#10;192.168.1.0/24&#10;2001:db8::/32">${esc(d.cidrs.join('\n'))}</textarea></label>
    <div class="row" style="gap:16px"><span>Applies to:</span>
      <label class="row" style="gap:6px"><input type="checkbox" data-ip-role="admin" ${d.roles.includes('admin') ? 'checked' : ''} /> administrators</label>
      <label class="row" style="gap:6px"><input type="checkbox" data-ip-role="user" ${d.roles.includes('user') ? 'checked' : ''} /> other accounts</label></div>
    <div class="row" style="gap:8px;margin-top:10px"><button class="btn" id="ip-add-mine">Add my address</button><button class="btn btn-primary" id="ip-save">Save</button></div>
    <details style="margin-top:14px"><summary>Per-account lists</summary>
      <div class="hint">An account with its own list can only sign in from there, instead of the shared list. Empty means it uses the shared list.</div>
      ${d.accounts.map((a) => `<label class="field"><span>${esc(a.username)} (${esc(a.role)})</span><input data-ip-acct="${esc(a.id)}" value="${esc(a.allowedIps.join(', '))}" placeholder="none" /></label>`).join('')}
      <button class="btn" id="ip-save-accounts">Save per-account lists</button></details>
    <div class="hint" style="margin-top:12px">Locked out? Stop the panel and run <span class="mono">node server/reset-allowlist.js</span> on the machine.</div>`
  );
  if (!el) return;
  $('#ip-add-mine').onclick = () => {
    const box = $('#ip-list');
    if (!lines(box.value).includes(d.yourIp)) box.value = `${box.value.trim()}${box.value.trim() ? '\n' : ''}${d.yourIp}`;
  };
  $('#ip-save').onclick = async () => {
    try {
      await api('/api/settings/ip-allowlist', { method: 'PUT', body: { enabled: $('#ip-on').checked, cidrs: lines($('#ip-list').value), roles: [...el.querySelectorAll('[data-ip-role]:checked')].map((c) => c.dataset.ipRole) } });
      toast('IP allowlist saved');
      ipAllowlist();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  };
  $('#ip-save-accounts').onclick = async () => {
    try {
      for (const input of el.querySelectorAll('[data-ip-acct]')) {
        const next = lines(input.value);
        const was = d.accounts.find((a) => a.id === input.dataset.ipAcct)?.allowedIps || [];
        if (next.join() !== was.join()) await api(`/api/settings/ip-allowlist/accounts/${encodeURIComponent(input.dataset.ipAcct)}`, { method: 'PUT', body: { allowedIps: next } });
      }
      toast('Saved');
      ipAllowlist();
    } catch (err) {
      toast(err.message, 'error', 9000);
    }
  };
}

/* ------------------------------------------------------------------ flood */

async function flood() {
  let d;
  try {
    d = await api('/api/security/flood');
  } catch (err) {
    return fail('sec2-flood', err);
  }
  const s = d.settings;
  const el = mount(
    'sec2-flood',
    `${d.error ? `<div class="callout" style="margin-bottom:10px">${esc(d.error)}</div>` : ''}
    <div class="faint" style="margin-bottom:8px">Method: ${esc(d.platform)} / ${esc(d.backend || 'not checked')}${d.method ? `, counting with ${esc(d.method)}` : ''}${d.method === 'ss' || d.platform === 'windows' ? ' (TCP only)' : ''}</div>
    <div class="field-label">Protected servers</div>
    <div class="row" style="flex-wrap:wrap;gap:12px">${d.servers.map((v) => `<label class="row" style="gap:6px"><input type="checkbox" data-fl-server="${esc(v.id)}" ${v.enabled ? 'checked' : ''} /> ${esc(v.name)} <span class="faint mono">${esc(v.ports.join(' '))}</span></label>`).join('') || '<span class="faint">No servers</span>'}</div>
    <div class="form-grid" style="margin-top:12px">
      <label><span>Block above this many connections from one address</span><input id="fl-conn" type="number" value="${s.maxConnections}" /></label>
      <label><span>...or packets per second (where counted)</span><input id="fl-pps" type="number" value="${s.maxPackets}" /></label>
      <label><span>Block for (minutes)</span><input id="fl-min" type="number" value="${s.blockMinutes}" /></label>
      <label><span>Never block (addresses or ranges, one per line)</span><textarea id="fl-allow" rows="3">${esc(s.allow.join('\n'))}</textarea></label>
    </div>
    <div class="hint">Local and private addresses, addresses your staff signed in from, and bridge devices are never blocked.</div>
    <button class="btn btn-primary" id="fl-save" style="margin-top:10px">Save</button>
    <div class="field-label" style="margin-top:16px">Blocked right now</div>
    ${
      d.blocks.length
        ? `<div class="list">${d.blocks.map((b) => `<div class="list-row"><div class="grow"><div class="title mono">${esc(b.ip)}</div><div class="sub">${esc(b.serverName)} · ${esc(b.reason)} · until ${esc(fmtTime(b.until))}</div></div><button class="btn btn-sm" data-fl-unblock="${esc(b.id)}">Unblock</button></div>`).join('')}</div>`
        : '<div class="faint">Nobody is blocked.</div>'
    }
    <div class="row" style="gap:8px;margin-top:10px"><input id="fl-ip" placeholder="Block an address by hand" /><select id="fl-srv">${d.servers.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select><button class="btn" id="fl-block">Block</button></div>`
  );
  if (!el) return;
  const refresh = () => flood();
  el.querySelectorAll('[data-fl-server]').forEach((box) =>
    box.addEventListener('change', async () => {
      try {
        await api(`/api/security/flood/servers/${encodeURIComponent(box.dataset.flServer)}`, { method: 'PUT', body: { enabled: box.checked } });
        refresh();
      } catch (err) {
        toast(err.message, 'error');
        box.checked = !box.checked;
      }
    })
  );
  $('#fl-save').onclick = async () => {
    try {
      await api('/api/security/flood', { method: 'PUT', body: { maxConnections: $('#fl-conn').value, maxPackets: $('#fl-pps').value, blockMinutes: $('#fl-min').value, allow: lines($('#fl-allow').value) } });
      toast('Saved');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  el.querySelectorAll('[data-fl-unblock]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/security/flood/blocks/${encodeURIComponent(btn.dataset.flUnblock)}`, { method: 'DELETE' });
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
  $('#fl-block').onclick = async () => {
    try {
      await api('/api/security/flood/blocks', { method: 'POST', body: { ip: $('#fl-ip').value, serverId: $('#fl-srv').value } });
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

/* ---------------------------------------------------------- backup tests */

async function backupTests() {
  let d;
  try {
    d = await api('/api/security/backup-tests');
  } catch (err) {
    return fail('sec2-tests', err);
  }
  const el = mount(
    'sec2-tests',
    `<label class="row" style="gap:8px"><input type="checkbox" id="bt-weekly" ${d.weekly ? 'checked' : ''} /> Test each server's newest backup every week, and alert me if it fails</label>
    <div class="row" style="gap:8px;margin:10px 0"><select id="bt-server">${d.servers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${s.backups} backups)</option>`).join('')}</select><button class="btn" id="bt-run">Test the newest backup now</button></div>
    ${
      d.results.length
        ? `<div class="list">${d.results
            .slice(0, 15)
            .map((r) => `<div class="list-row"><div class="grow"><div class="title">${r.ok ? '<span class="badge accent">Restores</span>' : '<span class="badge" style="color:var(--red)">Failed</span>'} ${esc(r.serverName)} <span class="faint mono">${esc(r.backup)}</span></div><div class="sub">${esc(fmtTime(r.at))} · ${r.ok ? `${r.files ?? '?'} files, ${fmtBytes(r.bytes || 0)}${r.mode === 'read' ? ', read through (low disk space)' : ''}` : esc(r.error || 'failed')}${(r.checks || []).length ? ` · ${r.checks.filter((c) => c.ok).length}/${r.checks.length} game checks` : ''}</div></div></div>`)
            .join('')}</div>`
        : '<div class="faint">No tests yet.</div>'
    }`
  );
  if (!el) return;
  $('#bt-weekly').onchange = async (e) => {
    try {
      await api('/api/security/backup-tests', { method: 'PUT', body: { weekly: e.target.checked } });
      toast(e.target.checked ? 'Weekly tests on' : 'Weekly tests off');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('#bt-run').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/security/backup-tests/run', { method: 'POST', body: { serverId: $('#bt-server').value } });
      toast(r.result?.ok ? 'The backup restores correctly' : `Test failed: ${r.result?.error}`, r.result?.ok ? 'info' : 'error', 8000);
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
    backupTests();
  };
}
