import { api } from '../core/api.js';
import { loadServers } from '../core/boot.js';
import { setCrumbs } from '../core/router.js';
import { $, esc, statusPill, toast } from '../core/util.js';
import { confirmModal, openModal } from '../ui/modal.js';
import { skeleton } from '../ui/skeleton.js';

/* -------------------------------------------------------------- clusters */

const TRANSFERS = [
  ['Survivors', 'Survivors', 'Characters'],
  ['Items', 'Items', 'Items'],
  ['Dinos', 'Dinos', 'Dinos'],
];
const TIMERS = [
  ['survivorExpirySeconds', 'Uploaded characters expire after'],
  ['itemExpirySeconds', 'Uploaded items expire after'],
  ['dinoExpirySeconds', 'Uploaded dinos expire after'],
  ['dinoReuploadSeconds', 'Wait before a dino can be uploaded again'],
];

/** ARK servers that share characters, items and dinos. */
export async function renderClusters(view) {
  setCrumbs('<a href="#/servers">Servers</a> <span class="sep">/</span> ARK clusters');
  view.innerHTML = `<div class="page-head"><div><h1>ARK clusters</h1></div></div><div id="cl-body">${skeleton('list', 'Loading clusters…', 3)}</div>`;
  let data;
  try {
    data = await api('/api/clusters');
  } catch (err) {
    $('#cl-body').innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }
  draw(view, data);
}

function summary(o) {
  const off = TRANSFERS.flatMap(([k, , label]) => [!o[`upload${k}`] && `${label} upload`, !o[`download${k}`] && `${label} download`]).filter(Boolean);
  return off.length ? `Blocked: ${off.join(', ')}` : 'All transfers allowed';
}

function draw(view, data) {
  const body = $('#cl-body');
  if (!body) return;
  body.innerHTML = `
    <p class="faint" style="margin:0 0 16px;max-width:760px;line-height:1.6">Link ARK servers (maps) so players can upload a character, items or dinos at an obelisk or terminal on one map and download them on another. Only servers on this machine can join, and Evolved and Ascended servers cannot be mixed. Restart the servers after changing a cluster.</p>
    <div class="row mb-16"><button class="btn btn-primary" id="cl-new">New cluster</button>
      ${data.servers.length ? '' : '<span class="faint">First create ARK servers on the Games page.</span>'}</div>
    ${
      data.clusters.length
        ? data.clusters
            .map(
              (c) => `<div class="card mb-16">
          <div class="card-head"><h4>${esc(c.name)}</h4><span class="chip chip-sm">${esc(c.game)}</span><div class="spacer"></div>
            <button class="btn btn-sm" data-edit="${esc(c.id)}">Edit</button>
            <button class="btn btn-sm btn-ghost btn-danger" data-del="${esc(c.id)}">Remove</button></div>
          <div class="list">
            ${c.servers
              .map(
                (e) => `<a class="list-row" href="#/servers/${esc(e.id)}/console"><div class="grow"><div class="title">${esc(e.name || 'missing')}</div><div class="sub">${e.map ? esc(e.map) : ''}${e.port ? ` · port ${e.port}` : ''}</div></div>${e.status ? statusPill(e.status) : ''}</a>`
              )
              .join('')}
          </div>
          <div class="hint">${esc(summary(c.options))}</div>
          ${c.restart.length ? '<div class="hint">Restart the running servers in this cluster to apply the latest changes.</div>' : ''}
        </div>`
            )
            .join('')
        : '<div class="card faint">No clusters yet.</div>'
    }`;

  const reload = async () => draw(view, await api('/api/clusters'));
  $('#cl-new').addEventListener('click', () => openClusterModal(data, null, reload));
  body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openClusterModal(data, data.clusters.find((c) => c.id === b.dataset.edit), reload)));
  body.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const c = data.clusters.find((x) => x.id === b.dataset.del);
      if (!(await confirmModal('Remove cluster', `The servers in ${c.name} stop sharing characters, items and dinos after their next restart. The servers and the uploaded data are kept.`, 'Remove'))) return;
      try {
        await api(`/api/clusters/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        toast('Cluster removed');
        await loadServers();
        reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function openClusterModal(data, cluster, onDone) {
  if (!data.servers.length) return toast('Create ARK servers first (Games page)', 'error');
  const o = { ...data.defaults, ...(cluster?.options || {}) };
  const chosen = new Set((cluster?.servers || []).map((e) => e.id));
  const modal = openModal({
    title: cluster ? `Edit ${cluster.name}` : 'New cluster',
    width: 600,
    body: `
      <label class="block"><span>Name</span><input id="cl-name" value="${esc(cluster?.name || 'My cluster')}" maxlength="40" /></label>
      <div class="field-label mt-16">Servers <span class="faint">(all of the same game)</span></div>
      <div class="list" id="cl-list">${data.servers
        .map(
          (s) => `<label class="list-row" data-game="${esc(s.templateId)}">
            <input type="checkbox" data-pick="${esc(s.id)}" ${chosen.has(s.id) ? 'checked' : ''} />
            <div class="grow"><div class="title">${esc(s.name)}</div><div class="sub">${esc(data.games[s.templateId])}${s.map ? ` · ${esc(s.map)}` : ''}</div></div></label>`
        )
        .join('')}</div>
      <div class="field-label mt-16">What players may transfer</div>
      <div class="list">${TRANSFERS.map(
        ([k, , label]) => `<div class="list-row"><div class="grow"><div class="title">${label}</div></div>
          <label><input type="checkbox" data-opt="upload${k}" ${o[`upload${k}`] ? 'checked' : ''} /> upload</label>
          <label style="margin-left:12px"><input type="checkbox" data-opt="download${k}" ${o[`download${k}`] ? 'checked' : ''} /> download</label></div>`
      ).join('')}</div>
      <label class="mt-16" style="display:block"><input type="checkbox" data-opt="noTransferFromFiltering" ${o.noTransferFromFiltering ? 'checked' : ''} /> Allow transfers from every server in the cluster <span class="faint">(recommended)</span></label>
      <details class="mt-16"><summary>Expiry timers (seconds, 0 = game default)</summary>
        <div class="form-grid mt-16">${TIMERS.map(([k, label]) => `<label><span>${label}</span><input type="number" min="0" data-timer="${k}" value="${Number(o[k]) || 0}" /></label>`).join('')}</div></details>
      <div class="hint">Every server gets the same cluster ID and shared folder. Restart them afterwards. Maps in one cluster need different ports; the panel already gives each server its own.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: cluster ? 'Save' : 'Create cluster',
        primary: true,
        onClick: async (btn) => {
          const options = {};
          document.querySelectorAll('[data-opt]').forEach((el) => (options[el.dataset.opt] = el.checked));
          document.querySelectorAll('[data-timer]').forEach((el) => (options[el.dataset.timer] = Number(el.value) || 0));
          const servers = [...document.querySelectorAll('#cl-list [data-pick]')].filter((el) => el.checked).map((el) => el.dataset.pick);
          btn.disabled = true;
          try {
            await api(cluster ? `/api/clusters/${encodeURIComponent(cluster.id)}` : '/api/clusters', { method: cluster ? 'PUT' : 'POST', body: { name: $('#cl-name').value, servers, options } });
            modal.close();
            toast(cluster ? 'Cluster saved. Restart its servers to apply.' : 'Cluster created. Restart its servers to apply.', 'info', 7000);
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
}
