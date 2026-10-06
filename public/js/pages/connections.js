import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtTime, icon, toast } from '../core/util.js';
import { confirmModal, openModal } from '../ui/modal.js';
import { setBridgeNav } from '../ui/sidebar.js';

/* ----------------------------------------------------------- connections */

/*
 * Manage connections: people who reach servers through GamePanel Bridge.
 * Each one gets a personal client download; this page decides which servers
 * and extra ports it carries, and can reset the password or revoke it.
 */

let timer = null;

export async function renderConnections(view) {
  setCrumbs('Connections');
  clearInterval(timer);
  let data;
  try {
    data = await api('/api/bridge');
  } catch (err) {
    view.innerHTML = `<div class="empty"><h3>Could not load connections</h3><p>${esc(err.message)}</p></div>`;
    return;
  }
  state.bridgeEnabled = data.enabled;
  setBridgeNav(data.enabled);
  if (!data.enabled) {
    renderOff(view);
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Manage connections</h1>
        <div class="lede">People who play on your servers through GamePanel Bridge. They run their personal client and your servers appear on their own computer, with no ports opened on yours.</div></div>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="c-new">${icon('plus', 13)} Add connection</button>
    </div>
    <div class="card card-flush mb-16"><div class="table-wrap"><table>
      <thead><tr><th>User</th><th>Status</th><th>Servers</th><th>Extra ports</th><th>Password</th><th></th></tr></thead>
      <tbody id="c-rows"></tbody>
    </table></div></div>
    <div class="card" id="c-settings"></div>`;

  drawRows(view, data);
  drawSettings(view, data);
  $('#c-new').addEventListener('click', () => openNewModal(data));

  // Online status and tunnel counts change on their own; keep them fresh.
  timer = setInterval(async () => {
    if (state.route.name !== 'connections' || !document.body.contains(view)) return clearInterval(timer);
    if (document.querySelector('.modal-backdrop')) return;
    try {
      const next = await api('/api/bridge');
      if (!next.enabled) return renderConnections(view);
      Object.assign(data, next);
      drawRows(view, data);
    } catch {
      /* try again next tick */
    }
  }, 5000);
}

function renderOff(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Manage connections</h1></div></div>
    <div class="card">
      <h4>GamePanel Bridge is off</h4>
      <p class="faint" style="margin:0 0 14px;line-height:1.6">Turn it on in Settings, then add the people who should reach your servers.</p>
      <a class="btn btn-primary" href="#/settings">Open settings</a>
    </div>`;
}

function serverName(id) {
  return state.servers.find((s) => s.id === id)?.name;
}

function drawRows(view, data) {
  const rows = $('#c-rows', view);
  if (!rows) return;
  if (!data.connections.length) {
    rows.innerHTML = `<tr><td colspan="6" class="faint" style="padding:22px 16px">No connections yet. Add one, download the client and send it to that person.</td></tr>`;
    return;
  }
  rows.innerHTML = data.connections
    .map((c) => {
      const lastSeen = Math.max(0, ...c.devices.map((d) => d.lastSeen || 0));
      const statusHtml = !c.enabled
        ? '<span class="status crashed"><span class="dot"></span>Turned off</span>'
        : c.online
          ? `<span class="status running"><span class="dot"></span>Online${c.tunnels ? ` · ${c.tunnels} open` : ''}</span>`
          : `<span class="status"><span class="dot"></span>${lastSeen ? `Seen ${esc(fmtTime(lastSeen))}` : 'Never connected'}</span>`;
      const servers = c.servers.map(serverName).filter(Boolean);
      return `<tr>
        <td><strong>${esc(c.username)}</strong></td>
        <td>${statusHtml}</td>
        <td class="faint">${servers.length ? esc(servers.join(', ')) : 'None'}</td>
        <td class="faint">${c.ports.length ? c.ports.map((p) => `${esc(p.name)} <span class="mono">${p.port}</span>`).join(', ') : 'None'}</td>
        <td>${c.passwordSet ? '<span class="badge accent">Set</span>' : '<span class="badge warn">Set on first launch</span>'}</td>
        <td style="text-align:right" class="nowrap">
          <button class="btn btn-sm" data-dl="${esc(c.id)}">${icon('download', 12)} Client</button>
          <button class="btn btn-sm" data-manage="${esc(c.id)}">Manage</button>
        </td></tr>`;
    })
    .join('');
  rows.querySelectorAll('[data-dl]').forEach((el) => el.addEventListener('click', () => openDownloadModal(data, data.connections.find((c) => c.id === el.dataset.dl))));
  rows.querySelectorAll('[data-manage]').forEach((el) =>
    el.addEventListener('click', () => openManageModal(view, data, data.connections.find((c) => c.id === el.dataset.manage)))
  );
}

function drawSettings(view, data) {
  const box = $('#c-settings', view);
  box.innerHTML = `
    <h4>How clients reach this panel</h4>
    <p class="faint" style="margin:0 0 14px;line-height:1.6">
      Clients connect to the panel's own address (port ${data.port}), so that is the only port that has to be reachable, instead of one per game.
      Everything inside is encrypted and pinned to this panel. A domain behind a reverse proxy or Cloudflare Tunnel works too.
    </p>
    <label class="field"><span>Public address clients connect to</span>
      <div class="input-row">
        <input id="c-url" value="${esc(data.publicUrl)}" placeholder="http://203.0.113.5:${data.port}" spellcheck="false" />
        <button class="btn" id="c-url-save">Save</button>
      </div>
      <div class="hint warn-text" id="c-url-warn"></div>
      <div class="hint">Already-downloaded clients learn a new address the next time they connect. If the old one stops working first, send them a new download.</div>
    </label>
    <div class="row mt-16" style="gap:8px;flex-wrap:wrap">
      <button class="btn" id="c-reach" style="white-space:normal;height:auto;min-height:34px;padding-top:6px;padding-bottom:6px">Open port ${data.port} on this machine and the router</button>
      <span class="faint" id="c-reach-out"></span>
    </div>`;

  const warn = () => {
    $('#c-url-warn').textContent = reachWarning($('#c-url').value.trim());
  };
  $('#c-url').addEventListener('input', warn);
  warn();

  $('#c-url-save').addEventListener('click', async () => {
    try {
      Object.assign(data, await api('/api/bridge/settings', { method: 'PATCH', body: { publicUrl: $('#c-url').value.trim() } }));
      toast('Saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#c-reach').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const out = $('#c-reach-out');
    btn.disabled = true;
    out.textContent = 'Working…';
    try {
      const r = await api('/api/bridge/reachable', { method: 'POST', body: {} });
      const fw = (r.firewall || []).every((x) => x.ok) ? 'firewall open' : `firewall: ${(r.firewall || []).find((x) => !x.ok)?.error || 'failed'}`;
      const upnp = r.upnp?.error ? `router: ${r.upnp.error}` : `router forwarded${r.upnp?.externalIp ? ` (public IP ${r.upnp.externalIp})` : ''}`;
      out.textContent = `${fw}; ${upnp}.`;
      if (r.upnp?.externalIp && !$('#c-url').value.trim()) $('#c-url').value = `http://${r.upnp.externalIp}:${data.port}`;
    } catch (err) {
      out.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

/** Addresses that only work nearby: say so before clients get stamped with one. */
function reachWarning(value) {
  if (!value) return 'Set the address people outside your network use to reach this panel, or clients have nowhere to connect.';
  let host = '';
  try {
    host = new URL(value).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return 'That is not a full address. Use something like http://203.0.113.5:8420.';
  }
  if (/^(localhost|127\.|::1$|0\.0\.0\.0)/.test(host)) return 'This address only works on this computer. Use your public IP or domain so others can connect.';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fd|fe80)/i.test(host) || host.endsWith('.local')) {
    return 'This address only works inside your own network. For friends elsewhere, use your public IP or domain.';
  }
  return '';
}

/* ---------------------------------------------------------------- modals */

function serverChecks(selected = []) {
  if (!state.servers.length) return '<div class="faint">No servers yet.</div>';
  return `<div class="perm-grid" style="gap:2px 14px">${state.servers
    .map(
      (s) => `<label class="perm-row"><input type="checkbox" data-srv="${esc(s.id)}" ${selected.includes(s.id) ? 'checked' : ''} /><span>${esc(s.name)} <span class="faint mono" style="font-size:11.5px">${Object.values(s.ports || {}).join(', ')}</span></span></label>`
    )
    .join('')}</div>`;
}

const pickedServers = () => [...document.querySelectorAll('[data-srv]')].filter((c) => c.checked).map((c) => c.dataset.srv);

function openNewModal(data) {
  const modal = openModal({
    title: 'Add connection',
    width: 560,
    body: `
      <label><span>Username</span><input id="cn-user" spellcheck="false" autocomplete="off" placeholder="alex" /></label>
      <div class="hint" style="margin-bottom:14px">They choose their own password the first time they open the client.</div>
      <div class="field-label">Servers they can reach</div>
      ${serverChecks()}`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Add',
        primary: true,
        onClick: async (btn) => {
          btn.disabled = true;
          try {
            const { connection } = await api('/api/bridge/connections', { method: 'POST', body: { username: $('#cn-user').value.trim(), servers: pickedServers() } });
            modal.close();
            data.connections.push(connection);
            drawRows($('#view'), data);
            openDownloadModal(data, connection, true);
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
}

function openDownloadModal(data, conn, fresh = false) {
  const platforms = data.platforms || [];
  const modal = openModal({
    title: `Client for ${esc(conn.username)}`,
    width: 560,
    body: `
      ${fresh ? `<p style="margin:0 0 12px">${esc(conn.username)} is added. Download their personal client and send it to them.</p>` : ''}
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">
        ${platforms
          .map((p) => `<button class="btn ${p.id === 'windows-amd64' ? 'btn-primary' : ''}" data-platform="${esc(p.id)}">${icon('download', 13)} ${esc(p.label)}</button>`)
          .join('')}
      </div>
      <ol class="faint" style="margin:0;padding-left:18px;line-height:1.7">
        <li>Send the file to ${esc(conn.username)} privately: it only works for this account.</li>
        <li>They run it. ${conn.passwordSet ? 'They sign in with their password.' : 'The first time, it asks them to choose a password.'}</li>
        <li>The window lists an address for each server, like <span class="mono">127.0.0.1:25565</span>. They connect their game to it and keep the window open while playing.</li>
      </ol>
      <div class="hint mt-16">Windows may warn about an unrecognised app the first time: More info, then Run anyway. On Linux: <span class="mono">chmod +x</span> the file and run it in a terminal.</div>`,
    actions: [{ label: 'Done', close: true }],
  });
  document.querySelectorAll('[data-platform]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const label = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Preparing…';
      try {
        await download(conn, btn.dataset.platform);
      } catch (err) {
        toast(err.message, 'error', 8000);
      } finally {
        btn.disabled = false;
        btn.innerHTML = label;
      }
    })
  );
  return modal;
}

/** Fetch first, so a failure shows as a message instead of a page of JSON. */
async function download(conn, platform) {
  const res = await fetch(`/api/bridge/connections/${encodeURIComponent(conn.id)}/client?platform=${encodeURIComponent(platform)}`, { credentials: 'same-origin' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'GamePanel-Bridge';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

function portRow(p = {}) {
  return `<div class="bridge-port" data-port-row data-id="${esc(p.id || '')}">
    <input data-f="name" placeholder="SSH" value="${esc(p.name || '')}" />
    <input data-f="port" type="number" min="1" max="65535" placeholder="22" value="${esc(p.port ?? '')}" />
    <select data-f="protocol">
      ${['tcp', 'udp', 'both'].map((x) => `<option value="${x}" ${(p.protocol || 'tcp') === x ? 'selected' : ''}>${x.toUpperCase()}</option>`).join('')}
    </select>
    <input data-f="localPort" type="number" min="1" max="65535" placeholder="same" value="${esc(p.localPort ?? '')}" />
    <input data-f="host" placeholder="127.0.0.1" value="${esc(p.host && p.host !== '127.0.0.1' ? p.host : '')}" spellcheck="false" />
    <button class="icon-btn" type="button" data-port-del title="Remove">${icon('trash', 13)}</button>
  </div>`;
}

function openManageModal(view, data, conn) {
  const devices = conn.devices.length
    ? conn.devices
        .map(
          (d) => `<div class="row" style="gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
            <span class="led ${d.online ? 'on' : ''}"></span>
            <div style="flex:1;min-width:0"><strong>${esc(d.name)}</strong> <span class="faint">${esc(d.os || '')}</span>
              <div class="faint" style="font-size:12px">${d.online ? 'Connected now' : `Last seen ${esc(fmtTime(d.lastSeen))}`}${d.lastIp ? ` from ${esc(d.lastIp)}` : ''}</div></div>
            <button class="btn btn-sm" data-dev="${esc(d.id)}">Sign out</button>
          </div>`
        )
        .join('')
    : '<div class="faint">No devices signed in.</div>';

  const modal = openModal({
    title: `Manage ${esc(conn.username)}`,
    width: 720,
    body: `
      <div class="checkbox-row" style="margin-top:0"><input type="checkbox" id="cm-enabled" ${conn.enabled ? 'checked' : ''} /><label for="cm-enabled">Connection is on</label></div>
      <div class="hint" style="margin-bottom:16px">Turning it off disconnects them right away; their client and password stay as they are.</div>

      <div class="field-label">Servers they can reach</div>
      ${serverChecks(conn.servers)}
      <div class="hint" style="margin-bottom:8px">Every port of a ticked server is carried, on the same port number on their computer.</div>
      <div class="checkbox-row" style="margin-top:0"><input type="checkbox" id="cm-rcon" ${conn.shareRcon ? 'checked' : ''} /><label for="cm-rcon">Also share RCON (remote admin) ports</label></div>
      <div class="hint" style="margin-bottom:16px">Off by default. Only turn it on for people you trust to run server commands.</div>

      <div class="field-label">Extra ports</div>
      <div class="hint" style="margin:0 0 8px">For anything else on this machine or its network, like SSH (22) or a web map. Local port is what they connect to on their computer (blank = same). Host is where the panel sends it (blank = this machine).</div>
      <div class="bridge-port bridge-port-head faint"><span>Name</span><span>Port</span><span>Protocol</span><span>Local port</span><span>Host</span><span></span></div>
      <div id="cm-ports">${conn.ports.map(portRow).join('')}</div>
      <button class="btn btn-sm mt-8" id="cm-add-port" type="button">${icon('plus', 12)} Add port</button>

      <div class="field-label" style="margin-top:20px">Devices</div>
      <div id="cm-devices">${devices}</div>

      <div class="field-label" style="margin-top:20px">Access</div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn" id="cm-reset" type="button">Reset password</button>
        <button class="btn" id="cm-rekey" type="button">Revoke old downloads</button>
        <button class="btn btn-danger" id="cm-delete" type="button">${icon('trash', 12)} Delete connection</button>
      </div>
      <div class="hint">Reset password signs them out; the next time they open the client it asks for a new one. Revoke old downloads makes every copy sent so far stop working, so you can send a new one.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async (btn) => {
          const ports = [...document.querySelectorAll('[data-port-row]')]
            .map((row) => {
              const f = (k) => row.querySelector(`[data-f="${k}"]`).value.trim();
              return { id: row.dataset.id || undefined, name: f('name'), port: f('port') === '' ? '' : Number(f('port')), protocol: f('protocol'), localPort: f('localPort') === '' ? null : Number(f('localPort')), host: f('host') || '127.0.0.1' };
            })
            .filter((p) => p.name || p.port !== '');
          btn.disabled = true;
          try {
            await api(`/api/bridge/connections/${conn.id}`, { method: 'PATCH', body: { enabled: $('#cm-enabled').checked, shareRcon: $('#cm-rcon').checked, servers: pickedServers(), ports } });
            modal.close();
            toast('Saved');
            renderConnections(view);
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });

  const portsBox = $('#cm-ports');
  const wireDelete = () =>
    portsBox.querySelectorAll('[data-port-del]').forEach((el) => {
      el.onclick = () => el.closest('[data-port-row]').remove();
    });
  wireDelete();
  $('#cm-add-port').addEventListener('click', () => {
    portsBox.insertAdjacentHTML('beforeend', portRow());
    wireDelete();
    portsBox.lastElementChild.querySelector('input').focus();
  });

  const act = async (title, message, label, call, done) => {
    if (!(await confirmModal(title, message, label))) return;
    try {
      await call();
      modal.close();
      toast(done);
      renderConnections(view);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  document.querySelectorAll('[data-dev]').forEach((el) =>
    el.addEventListener('click', () =>
      act('Sign out device', 'This device will have to sign in with the password again.', 'Sign out', () => api(`/api/bridge/connections/${conn.id}/devices/${el.dataset.dev}`, { method: 'DELETE' }), 'Device signed out')
    )
  );
  $('#cm-reset').addEventListener('click', () =>
    act(
      'Reset password',
      `${conn.username} is disconnected now, and the next time they open the client it asks them to choose a new password.`,
      'Reset password',
      () => api(`/api/bridge/connections/${conn.id}/reset-password`, { method: 'POST', body: {} }),
      'Password reset'
    )
  );
  $('#cm-rekey').addEventListener('click', () =>
    act(
      'Revoke old downloads',
      `Every copy of the client sent to ${conn.username} so far stops working, and they are disconnected. Download a new one for them afterwards. Their password stays.`,
      'Revoke',
      () => api(`/api/bridge/connections/${conn.id}/new-key`, { method: 'POST', body: {} }),
      'Old downloads revoked. Send them a new one.'
    )
  );
  $('#cm-delete').addEventListener('click', () =>
    act('Delete connection', `Remove ${conn.username}? They are disconnected and their client stops working.`, 'Delete', () => api(`/api/bridge/connections/${conn.id}`, { method: 'DELETE' }), 'Connection deleted')
  );
}
