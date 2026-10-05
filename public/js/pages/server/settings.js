import { api } from '../../core/api.js';
import { loadServers } from '../../core/boot.js';
import { render } from '../../core/router.js';
import { state } from '../../core/state.js';
import { $, can, esc, toast } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';

/* ------------------------------------------------- server settings tab -- */

export function renderServerSettingsTab(host, server) {
  // Editing follows the "settings" capability; the danger zone stays admin-only.
  const isAdmin = can('settings');
  const isOwner = state.user.role === 'admin';
  host.innerHTML = `
    <div class="card mb-16">
      <h4 style="margin:0 0 14px">General</h4>
      <div class="form-grid">
        <label><span>Server name</span><input id="set-name" value="${esc(server.name)}" ${isAdmin ? '' : 'disabled'} /></label>
        <label><span>Memory limit (MB)</span><input id="set-memory" type="number" value="${
          server.memoryMb ?? Math.round((server.memoryLimit || 0) / 1048576)
        }" ${isAdmin ? '' : 'disabled'} /></label>
        <label><span>Max players</span><input id="set-maxplayers" type="number" value="${server.maxPlayers || 20}" ${
    isAdmin ? '' : 'disabled'
  } /></label>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="set-autostart" ${server.autoStart ? 'checked' : ''} ${
    isAdmin ? '' : 'disabled'
  } /><label for="set-autostart">Start automatically when the panel boots</label></div>
      <div class="checkbox-row"><input type="checkbox" id="set-autorestart" ${server.autoRestart ? 'checked' : ''} ${
    isAdmin ? '' : 'disabled'
  } /><label for="set-autorestart">Restart automatically after a crash</label></div>
      <label><span>Start command</span><textarea id="set-startcmd" rows="3" ${isAdmin ? '' : 'disabled'}>${esc(
    server.startCommand
  )}</textarea><div class="hint">Runs inside the server directory. Placeholders like {{PORT}} and {{MEMORY}} are substituted at launch.</div></label>
      ${isAdmin ? '<button class="btn btn-primary mt-16" id="set-save">Save changes</button>' : ''}
    </div>

    <div class="card mb-16" id="network-card">
      <h4 style="margin:0 0 6px">Reachability</h4>
      <p class="faint" style="margin:0 0 12px">Checking the firewall and your router…</p>
    </div>

    <div class="card mb-16">
      <h4 style="margin:0 0 14px">Ports</h4>
      <div class="form-grid">
        ${Object.entries(server.ports || {})
          .map(
            ([name, port]) =>
              `<label><span>${esc(name)}</span><input data-port="${esc(name)}" type="number" value="${port}" ${
                isAdmin ? '' : 'disabled'
              } /></label>`
          )
          .join('')}
      </div>
      <div class="hint">Changing a port takes effect on the next start. Remember to open it in your firewall.</div>
    </div>

    <div class="card mb-16">
      <h4 style="margin:0 0 14px">Template variables</h4>
      <div class="form-grid">
        ${Object.entries(server.vars || {})
          .map(
            ([name, value]) =>
              `<label><span>${esc(name)}</span><input data-var="${esc(name)}" value="${esc(value)}" ${
                isAdmin ? '' : 'disabled'
              } /></label>`
          )
          .join('')}
      </div>
      <div class="hint">Applied on the next start (and to config files the template manages).</div>
    </div>

    ${
      isOwner
        ? `<div class="card">
             <h4 style="margin:0 0 6px">Danger zone</h4>
             <p class="faint" style="margin:0 0 14px">Reinstalling re-runs the template installer in place. Deleting removes the server and all of its files.</p>
             <div class="row">
               <button class="btn" id="set-reinstall">Reinstall</button>
               <button class="btn btn-danger" id="set-delete">Delete server</button>
             </div>
           </div>`
        : ''
    }`;

  renderNetworkCard(server);

  if (!isAdmin) return;

  $('#set-save').addEventListener('click', async () => {
    const ports = {};
    host.querySelectorAll('[data-port]').forEach((el) => (ports[el.dataset.port] = Number(el.value)));
    const vars = {};
    host.querySelectorAll('[data-var]').forEach((el) => (vars[el.dataset.var] = el.value));
    try {
      await api(`/api/servers/${server.id}`, {
        method: 'PATCH',
        body: {
          name: $('#set-name').value.trim(),
          memory: Number($('#set-memory').value),
          maxPlayers: Number($('#set-maxplayers').value),
          autoStart: $('#set-autostart').checked,
          autoRestart: $('#set-autorestart').checked,
          startCommand: $('#set-startcmd').value,
          ports,
          vars,
        },
      });
      await loadServers();
      toast('Settings saved');
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  if (!isOwner) return; // the danger zone below is not rendered for non-admins

  $('#set-reinstall').addEventListener('click', async () => {
    if (!(await confirmModal('Reinstall server', 'Re-run the installer for this server? Game files may be overwritten; worlds and configs are normally kept.')))
      return;
    await api(`/api/servers/${server.id}/install`, { method: 'POST', body: { reinstall: true } });
    toast('Reinstall started — watch the console');
    location.hash = `#/servers/${server.id}/console`;
  });

  $('#set-delete').addEventListener('click', async () => {
    if (!(await confirmModal('Delete server', `Permanently delete “${server.name}” and all of its files?`, 'Delete'))) return;
    try {
      await api(`/api/servers/${server.id}`, { method: 'DELETE' });
      await loadServers();
      toast('Server deleted');
      location.hash = '#/servers';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/**
 * Firewall and router state for one server, with one-click opening. Routers
 * without UPnP still get exact copy-paste instructions.
 */
async function renderNetworkCard(server) {
  const card = $('#network-card');
  if (!card) return;

  let data;
  try {
    data = await api(`/api/servers/${server.id}/network`);
  } catch (err) {
    card.innerHTML = `<h4 style="margin:0 0 6px">Reachability</h4><p class="faint" style="margin:0">${esc(
      err.message
    )}</p>`;
    return;
  }

  const dot = (ok, label, title) =>
    `<span class="status ${ok ? 'running' : 'crashed'}" title="${esc(title || '')}"><span class="dot"></span>${esc(
      label
    )}</span>`;

  const fw = data.firewall;
  const fwAllOpen = data.ports.every((p) => p.openInFirewall);
  const fwLine = !fw.available
    ? dot(true, 'No host firewall', 'ufw is not installed, so nothing is blocking locally')
    : !fw.active
      ? dot(true, 'Firewall inactive', 'ufw is installed but not enabled — nothing is blocked')
      : fwAllOpen
        ? dot(true, 'Ports open in firewall')
        : dot(false, 'Blocked by the firewall');

  const upnpLine = data.upnp.available
    ? dot(true, `Router supports UPnP${data.upnp.externalIp ? ` · public IP ${data.upnp.externalIp}` : ''}`)
    : dot(false, 'No UPnP router', data.upnp.reason || '');

  card.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <h4 style="margin:0">Reachability</h4>
      <div style="flex:1"></div>
      <span class="faint mono" style="font-size:12px">LAN ${esc(data.lanIp || 'unknown')}</span>
    </div>

    <div class="row mb-16" style="gap:14px">${fwLine}${upnpLine}</div>

    <div class="table-wrap mb-16">
      <table>
        <thead><tr><th>Port</th><th>Protocol</th><th>Firewall</th></tr></thead>
        <tbody>
          ${data.ports
            .map(
              (p) => `<tr>
                <td class="mono">${p.port}<span class="faint"> · ${esc(p.name)}</span></td>
                <td class="faint">${esc(p.protocol.toUpperCase())}</td>
                <td>${
                  !fw.active
                    ? '<span class="faint">not filtered</span>'
                    : p.openInFirewall
                      ? '<span style="color:var(--success)">open</span>'
                      : '<span style="color:var(--danger)">closed</span>'
                }</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="row">
      <button class="btn btn-primary" id="net-open">Open these ports</button>
      ${data.upnp.available ? '<button class="btn" id="net-forward">Forward on router (UPnP)</button>' : ''}
      <button class="btn btn-danger" id="net-close">Close</button>
      <button class="btn btn-ghost" id="net-manual">Do it manually</button>
    </div>
    <div id="net-result" class="hint"></div>

    <div id="net-manual-box" class="hidden mt-16">
      <div class="field-label">On this machine</div>
      <pre class="share-box mono" style="white-space:pre-wrap;margin:0 0 12px">${esc(data.manual.ufw.join('\n'))}</pre>
      <div class="field-label">On your router — forward to ${esc(data.lanIp || 'this machine')}</div>
      <pre class="share-box mono" style="white-space:pre-wrap;margin:0">${esc(data.manual.forward.join('\n'))}</pre>
      <div class="hint">
        Router settings are usually under “Port forwarding”, “Virtual server” or “NAT”.
        ${data.upnp.externalIp ? `Players connect to <span class="mono">${esc(data.upnp.externalIp)}</span>.` : ''}
      </div>
    </div>`;

  const act = async (btn, body, label) => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span> Working…';
    try {
      const result = await api(`/api/servers/${server.id}/network`, { method: 'POST', body });
      const all = [...(result.firewall || []), ...(result.upnp?.mappings || [])];
      const failed = all.filter((r) => !r.ok);
      $('#net-result').innerHTML = failed.length
        ? `<span style="color:var(--warning)">${failed.length} of ${all.length} failed — ${esc(
            failed[0].error || ''
          )}</span>`
        : `<span style="color:var(--success)">${label} (${all.length} rule${all.length === 1 ? '' : 's'})</span>`;
      toast(failed.length ? 'Some rules failed — see the details' : label, failed.length ? 'warn' : 'info');
      setTimeout(() => renderNetworkCard(server), 900);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = original;
    }
  };

  $('#net-open').addEventListener('click', (e) => act(e.currentTarget, { open: true, firewall: true }, 'Ports opened'));
  $('#net-forward')?.addEventListener('click', (e) =>
    act(e.currentTarget, { open: true, firewall: true, upnp: true }, 'Firewall opened and router forwarded')
  );
  $('#net-close').addEventListener('click', (e) =>
    act(e.currentTarget, { open: false, firewall: true, upnp: data.upnp.available }, 'Ports closed')
  );
  $('#net-manual').addEventListener('click', () => $('#net-manual-box').classList.toggle('hidden'));
}
