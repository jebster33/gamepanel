import { api } from '../../core/api.js';
import { loadServers } from '../../core/boot.js';
import { render } from '../../core/router.js';
import { state } from '../../core/state.js';
import { $, can, esc, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';

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
      ${
        server.canAutoUpdate
          ? `<label style="margin-top:12px"><span>Automatic game updates</span><select id="set-autoupdate" ${isAdmin ? '' : 'disabled'}>
               <option value="" ${server.autoUpdate == null ? 'selected' : ''}>Follow the panel setting</option>
               <option value="on" ${server.autoUpdate === true ? 'selected' : ''}>Always on</option>
               <option value="off" ${server.autoUpdate === false ? 'selected' : ''}>Off</option>
             </select><div class="hint">Checks Steam every 30 minutes and updates once nobody is playing, then starts the server again.${
               server.autoUpdateInfo?.updatedAt ? ` Last updated ${esc(new Date(server.autoUpdateInfo.updatedAt).toLocaleString())}.` : ''
             }${server.autoUpdateInfo?.error ? ` Last check failed: ${esc(server.autoUpdateInfo.error)}.` : ''}</div></label>`
          : ''
      }
      <label style="margin-top:12px"><span>Stop when empty for (minutes)</span><input id="set-idle" type="number" min="0" max="1440" value="${server.idleStopMinutes || 0}" ${
    isAdmin ? '' : 'disabled'
  } /><div class="hint">Saves RAM and CPU on a server nobody is using. 0 keeps it running.</div></label>
      <label><span>Restart when frozen for (minutes)</span><input id="set-hang" type="number" min="0" max="60" value="${server.hangRestartMinutes || 0}" ${
    isAdmin ? '' : 'disabled'
  } /><div class="hint">Restarts the server if it stops answering players while still running. 0 turns this off.</div></label>
      <label><span>Start command</span><textarea id="set-startcmd" rows="3" ${isAdmin ? '' : 'disabled'}>${esc(
    server.startCommand
  )}</textarea><div class="hint">Runs inside the server directory. Placeholders like {{PORT}} and {{MEMORY}} are substituted at launch.</div></label>
      ${isAdmin ? '<button class="btn btn-primary mt-16" id="set-save">Save changes</button>' : ''}
    </div>

    <div class="card mb-16">
      <h4 style="margin:0 0 6px">Alerts</h4>
      <p class="faint" style="margin:0 0 12px">Get a Discord message or phone notification when this server runs hot. 0 turns one off.</p>
      <div class="form-grid">
        <label><span>CPU above (%)</span><input id="al-cpu" type="number" min="0" value="${server.alerts?.cpu || 0}" ${isAdmin ? '' : 'disabled'} /><div class="hint">For 2 minutes. 100% is one full core.</div></label>
        <label><span>Memory above (% of limit)</span><input id="al-memory" type="number" min="0" max="100" value="${server.alerts?.memory || 0}" ${isAdmin ? '' : 'disabled'} /><div class="hint">For 2 minutes.</div></label>
        <label><span>Folder bigger than (GB)</span><input id="al-disk" type="number" min="0" value="${server.alerts?.disk || 0}" ${isAdmin ? '' : 'disabled'} /><div class="hint">Worlds, logs and mods together.</div></label>
        ${['minecraft-paper', 'minecraft-purpur'].includes(server.templateId) ? `<label><span>TPS below</span><input id="al-tps" type="number" min="0" max="20" value="${server.alerts?.tps || 0}" ${isAdmin ? '' : 'disabled'} /><div class="hint">20 is perfect; 15 or less feels laggy. For 2 minutes.</div></label>` : ''}
      </div>
      ${isAdmin ? '<button class="btn mt-16" id="al-save">Save alerts</button>' : ''}
    </div>

    ${
      isOwner
        ? `<div class="card mb-16" id="address-card">
      <h4 style="margin:0 0 6px">Address</h4>
      ${
        server.subdomain
          ? `<p style="margin:0 0 12px">Players connect to <b class="mono">${esc(server.subdomain.srv || !server.subdomain.port ? server.subdomain.host : `${server.subdomain.host}:${server.subdomain.port}`)}</b>${server.subdomain.srv ? ' (no port needed)' : ''}. It points at ${esc(server.subdomain.ip)}.</p>
             <button class="btn" id="dns-remove">Remove address</button>`
          : `<p class="faint" style="margin:0 0 12px">Give it a name like play.yourdomain.com through Cloudflare. Minecraft Java players then do not need the port.</p>
             <div class="row" style="gap:8px;flex-wrap:wrap">
               <input id="dns-name" placeholder="play" maxlength="63" style="max-width:200px" />
               <button class="btn" id="dns-save">Create address</button>
             </div>
             <div class="hint">Needs a Cloudflare token and domain under Settings, Integrations. Uses this machine's public IP; if it changes, create the address again.</div>`
      }
    </div>`
        : ''
    }

    ${
      isAdmin
        ? `<div class="card mb-16" id="feed-card">
      <h4 style="margin:0 0 6px">Discord channel</h4>
      <p class="faint" style="margin:0 0 12px">Post this server's chat, joins and leaves, and starts and crashes into a Discord channel. In Discord: channel settings, Integrations, Webhooks, New Webhook, Copy URL.</p>
      <input id="feed-url" class="mono" placeholder="${server.discordFeed?.connected ? 'Connected. Paste a new webhook URL to change channel.' : 'https://discord.com/api/webhooks/…'}" spellcheck="false" />
      <div class="row" style="gap:16px;flex-wrap:wrap;margin-top:10px">
        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="feed-chat" ${server.discordFeed?.chat === false ? '' : 'checked'} /><label for="feed-chat">Chat</label></div>
        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="feed-joins" ${server.discordFeed?.joins === false ? '' : 'checked'} /><label for="feed-joins">Joins and leaves</label></div>
        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="feed-status" ${server.discordFeed?.status === false ? '' : 'checked'} /><label for="feed-status">Online, stopped, crashed</label></div>
        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="feed-in" ${server.discordFeed?.fromDiscord ? 'checked' : ''} /><label for="feed-in">Messages in the channel show up in game</label></div>
      </div>
      <div class="hint">Discord to game uses the panel's Discord bot (panel Settings), which must be in that Discord server with Message Content Intent turned on.</div>
      <div class="row mt-16" style="gap:8px">
        <button class="btn" id="feed-save">${server.discordFeed?.connected ? 'Save' : 'Save and send a test'}</button>
        ${server.discordFeed ? '<button class="btn btn-ghost" id="feed-off">Disconnect</button>' : ''}
      </div>
    </div>`
        : ''
    }

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
             <p class="faint" style="margin:0 0 14px">Duplicating makes a copy on new ports. Exporting downloads the whole server, which another GamePanel can import. Reinstalling re-runs the template installer in place. Deleting removes the server and all of its files.</p>
             <div class="row">
               <button class="btn" id="set-clone">Duplicate</button>
               <a class="btn" href="/api/servers/${server.id}/export" download>Export</a>
               <button class="btn" id="set-reinstall">Reinstall</button>
               <button class="btn btn-danger" id="set-delete">Delete server</button>
             </div>
           </div>`
        : ''
    }`;

  renderNetworkCard(server);

  const saveFeed = async (webhook, btn) => {
    btn.disabled = true;
    try {
      const { discordFeed } = await api(`/api/servers/${server.id}/discord-feed`, {
        method: 'PUT',
        body: { webhook, keep: webhook !== '' || !btn.matches('#feed-off'), chat: $('#feed-chat').checked, joins: $('#feed-joins').checked, status: $('#feed-status').checked, fromDiscord: $('#feed-in').checked, test: Boolean(webhook) || !server.discordFeed?.connected },
      });
      server.discordFeed = discordFeed || undefined;
      toast(webhook ? 'Connected. Check the channel for a test message.' : 'Disconnected from Discord');
      renderServerSettingsTab(host, server);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  };
  $('#feed-save')?.addEventListener('click', (e) => saveFeed($('#feed-url').value.trim(), e.currentTarget));
  $('#feed-off')?.addEventListener('click', (e) => saveFeed('', e.currentTarget));

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
          ...($('#set-autoupdate') ? { autoUpdate: { '': null, on: true, off: false }[$('#set-autoupdate').value] } : {}),
          idleStopMinutes: Number($('#set-idle').value) || 0,
          hangRestartMinutes: Number($('#set-hang').value) || 0,
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

  $('#al-save').addEventListener('click', async () => {
    try {
      await api(`/api/servers/${server.id}`, {
        method: 'PATCH',
        body: { alerts: { cpu: Number($('#al-cpu').value), memory: Number($('#al-memory').value), disk: Number($('#al-disk').value), tps: Number($('#al-tps')?.value || 0) } },
      });
      await loadServers();
      toast('Alerts saved. Pick where they go under Settings, Notifications, or on the phone app.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  if (!isOwner) return; // the danger zone below is not rendered for non-admins

  $('#dns-save')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const r = await api(`/api/servers/${server.id}/subdomain`, { method: 'PUT', body: { name: $('#dns-name').value } });
      toast(`Players can now use ${r.address}. DNS can take a few minutes to reach everyone.`, 'info', 7000);
      await loadServers();
      render();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
  $('#dns-remove')?.addEventListener('click', async () => {
    try {
      await api(`/api/servers/${server.id}/subdomain`, { method: 'DELETE' });
      await loadServers();
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#set-clone').addEventListener('click', () => {
    openModal({
      title: 'Duplicate server',
      width: 460,
      body: `
        <label class="field"><span>Name</span><input id="cl-name" value="${esc(`${server.name} copy`)}" maxlength="60" /></label>
        <div class="checkbox-row"><input type="checkbox" id="cl-files" checked /><label for="cl-files">Copy worlds, mods and configs</label></div>
        <div class="hint">Unticked, the copy is a fresh install of the same game and version. The copy gets its own ports and does not start by itself.</div>`,
      actions: [
        { label: 'Cancel', close: true },
        {
          label: 'Duplicate',
          primary: true,
          onClick: async (btn, m) => {
            const root = document.querySelector('.modal-backdrop:last-child');
            btn.disabled = true;
            btn.textContent = 'Copying…';
            try {
              const r = await api(`/api/servers/${server.id}/clone`, {
                method: 'POST',
                body: { name: root.querySelector('#cl-name').value.trim(), copyFiles: root.querySelector('#cl-files').checked },
              });
              m.close();
              await loadServers();
              toast(`Created ${r.server.name}`);
              location.hash = `#/servers/${r.server.id}/console`;
            } catch (err) {
              toast(err.message, 'error');
              btn.disabled = false;
              btn.textContent = 'Duplicate';
            }
          },
        },
      ],
    });
  });

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
  if (!card.isConnected) return; // left the page while it loaded

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
