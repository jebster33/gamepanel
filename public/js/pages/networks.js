import { api } from '../core/api.js';
import { loadServers } from '../core/boot.js';
import { setCrumbs } from '../core/router.js';
import { $, esc, statusPill, toast } from '../core/util.js';
import { confirmModal, openModal } from '../ui/modal.js';
import { skeleton } from '../ui/skeleton.js';

/* -------------------------------------------------------------- networks */

/** Velocity proxies and the Paper/Purpur servers behind them. */
export async function renderNetworks(view) {
  setCrumbs('<a href="#/servers">Servers</a> <span class="sep">/</span> Networks');
  view.innerHTML = `<div class="page-head"><div><h1>Minecraft networks</h1></div></div><div id="net-body">${skeleton('list', 'Loading networks…', 3)}</div>`;
  let data;
  try {
    data = await api('/api/networks');
  } catch (err) {
    $('#net-body').innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }
  draw(view, data);
}

function draw(view, data) {
  const body = $('#net-body');
  if (!body) return;
  body.innerHTML = `
    <p class="faint" style="margin:0 0 16px;max-width:760px;line-height:1.6">One address for several Minecraft servers: players join the Velocity proxy and move between a lobby, survival and minigames with <span class="mono">/server</span>, without reconnecting. The panel sets up both ends (modern forwarding with a secret), so the servers behind the proxy cannot be joined directly.</p>
    <div class="row mb-16"><button class="btn btn-primary" id="net-new">New network</button>
      ${data.proxies.length ? '' : '<span class="faint">First create a <b>Minecraft: Velocity proxy</b> server on the Games page, and Paper or Purpur servers to put behind it.</span>'}</div>
    ${
      data.networks.length
        ? data.networks
            .map(
              (n) => `<div class="card mb-16">
          <div class="card-head"><h4>${esc(n.name)}</h4><div class="spacer"></div>
            <button class="btn btn-sm" data-edit="${esc(n.id)}">Edit</button>
            <button class="btn btn-sm btn-ghost btn-danger" data-del="${esc(n.id)}">Remove</button></div>
          <div class="list">
            <a class="list-row" href="#/servers/${esc(n.proxy.id)}/console"><span class="chip chip-sm">proxy</span><div class="grow"><div class="title">${esc(n.proxy.name || 'missing')}</div><div class="sub">Players join here${n.proxy.port ? ` · port ${n.proxy.port}` : ''}</div></div>${n.proxy.status ? statusPill(n.proxy.status) : ''}</a>
            ${n.servers
              .map(
                (e, i) => `<a class="list-row child" href="#/servers/${esc(e.serverId)}/console"><span class="chip chip-sm mono">${esc(e.name)}</span><div class="grow"><div class="title">${esc(e.server.name || 'missing')}</div><div class="sub">${i === 0 ? 'Players land here' : `/server ${esc(e.name)}`}</div></div>${e.server.status ? statusPill(e.server.status) : ''}</a>`
              )
              .join('')}
          </div>
          ${n.restart.length ? '<div class="hint">Restart the running servers in this network to apply the latest changes.</div>' : ''}
        </div>`
            )
            .join('')
        : '<div class="card faint">No networks yet.</div>'
    }`;

  const reload = async () => draw(view, await api('/api/networks'));
  $('#net-new').addEventListener('click', () => openNetworkModal(data, null, reload));
  body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openNetworkModal(data, data.networks.find((n) => n.id === b.dataset.edit), reload)));
  body.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const n = data.networks.find((x) => x.id === b.dataset.del);
      if (!(await confirmModal('Remove network', `The servers in ${n.name} go back to normal (online mode on, proxy off) after their next restart. The servers themselves are kept.`, 'Remove'))) return;
      try {
        await api(`/api/networks/${encodeURIComponent(n.id)}`, { method: 'DELETE' });
        toast('Network removed');
        reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function openNetworkModal(data, network, onDone) {
  if (!data.proxies.length) return toast('Create a Minecraft: Velocity proxy server first (Games page)', 'error');
  if (!data.backends.length) return toast('Create a Paper or Purpur server to put behind the proxy first', 'error');
  const chosen = new Map((network?.servers || []).map((e) => [e.serverId, e.name]));
  const order = [...(network?.servers || []).map((e) => e.serverId), ...data.backends.map((b) => b.id).filter((id) => !chosen.has(id))];
  const short = (name) => String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'server';
  const modal = openModal({
    title: network ? `Edit ${network.name}` : 'New network',
    width: 560,
    body: `
      <div class="form-grid">
        <label><span>Name</span><input id="nw-name" value="${esc(network?.name || 'Main network')}" maxlength="40" /></label>
        <label><span>Velocity proxy</span><select id="nw-proxy">${data.proxies.map((p) => `<option value="${esc(p.id)}" ${network?.proxy.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      </div>
      <div class="field-label mt-16">Servers behind it <span class="faint">(the first ticked one is where players land)</span></div>
      <div class="list" id="nw-list">${order
        .map((id) => {
          const b = data.backends.find((x) => x.id === id);
          if (!b) return '';
          return `<div class="list-row" data-row="${esc(id)}">
            <input type="checkbox" data-pick ${chosen.has(id) ? 'checked' : ''} />
            <div class="grow"><div class="title">${esc(b.name)}</div></div>
            <input data-short class="mono" style="width:130px" value="${esc(chosen.get(id) || short(b.name))}" title="Name in /server" />
            <button class="btn btn-sm btn-ghost" data-up title="Move up">↑</button>
          </div>`;
        })
        .join('')}</div>
      <div class="hint">The panel turns online mode off on these servers and gives them the proxy's secret, so only the proxy can let players in. Restart them (and the proxy) afterwards.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: network ? 'Save' : 'Create network',
        primary: true,
        onClick: async (btn) => {
          const servers = [...document.querySelectorAll('#nw-list [data-row]')]
            .filter((row) => row.querySelector('[data-pick]').checked)
            .map((row) => ({ serverId: row.dataset.row, name: row.querySelector('[data-short]').value.trim() }));
          const body = { name: $('#nw-name').value, proxyId: $('#nw-proxy').value, servers };
          btn.disabled = true;
          try {
            await api(network ? `/api/networks/${encodeURIComponent(network.id)}` : '/api/networks', { method: network ? 'PUT' : 'POST', body });
            modal.close();
            toast(network ? 'Network saved. Restart its servers to apply.' : 'Network created. Restart its servers to apply.', 'info', 7000);
            await loadServers();
            onDone();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
  document.querySelectorAll('#nw-list [data-up]').forEach((b) =>
    b.addEventListener('click', () => {
      const row = b.closest('[data-row]');
      if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
    })
  );
}
