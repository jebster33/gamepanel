import { api } from '../../core/api.js';
import { state } from '../../core/state.js';
import { $, $$, esc, icon, toast } from '../../core/util.js';
import { confirmModal, openModal, promptModal } from '../../ui/modal.js';

/* -------------------------------------------------------- workshop packs */

// Saved lists of Workshop items for one game, applied to any of its servers
// in one go. Made from a collection link or from what a server already has.

export async function renderWorkshopPacks(host, server, onApplied) {
  const data = await api(`/api/servers/${server.id}/workshop-packs`).catch(() => null);
  if (!data || !host.isConnected) return;
  host.innerHTML = `
    <div class="ws-packs">
      <div class="row" style="gap:8px;align-items:center">
        <span class="field-label" style="margin:0;flex:1">Workshop packs</span>
        <button class="btn btn-sm" id="wp-from-link">${icon('plus', 12)} From a collection</button>
        <button class="btn btn-sm" id="wp-from-server" title="Save the Workshop items this server has as a pack">Save this server's items</button>
      </div>
      ${
        data.packs.length
          ? `<div class="ws-pack-list">${data.packs
              .map(
                (p) => `<div class="ws-pack" data-pack="${esc(p.id)}">
                  <div class="grow min-w-0"><b>${esc(p.name)}</b><span class="faint"> · ${p.items.length} item${p.items.length === 1 ? '' : 's'} · ${esc(p.createdBy)}</span></div>
                  <button class="btn btn-sm btn-primary" data-pack-apply>Add to this server</button>
                  ${state.user.role === 'admin' || p.createdBy === state.user.username ? `<button class="btn btn-sm btn-ghost btn-danger" data-pack-delete title="Delete pack">${icon('trash', 12)}</button>` : ''}
                </div>`
              )
              .join('')}</div>`
          : '<div class="hint" style="margin-top:6px">Save a Workshop collection (or this server\'s items) as a pack, then add it to any server of this game in one click.</div>'
      }
    </div>`;
  const refresh = () => renderWorkshopPacks(host, server, onApplied);
  $('#wp-from-link').addEventListener('click', () => openPackModal(server, refresh));
  $('#wp-from-server').addEventListener('click', async () => {
    const name = await promptModal('Save as a pack', 'Name for the pack', `${server.name} Workshop`);
    if (!name) return;
    try {
      const { pack } = await api(`/api/servers/${server.id}/workshop-packs`, { method: 'POST', body: { name, fromServer: true } });
      toast(`Saved ${pack.name} (${pack.items.length} items)`);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $$('[data-pack]', host).forEach((row) => {
    const pack = data.packs.find((p) => p.id === row.dataset.pack);
    row.querySelector('[data-pack-apply]').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Adding…';
      try {
        const res = await api(`/api/servers/${server.id}/workshop-packs/${pack.id}/apply`, { method: 'POST', body: {} });
        toast(res.message || `${pack.name} added`);
        onApplied?.();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Add to this server';
      }
    });
    row.querySelector('[data-pack-delete]')?.addEventListener('click', async () => {
      if (!(await confirmModal('Delete pack', `Delete the pack "${pack.name}"? Servers that have its items keep them.`, 'Delete'))) return;
      await api(`/api/servers/${server.id}/workshop-packs/${pack.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      refresh();
    });
  });
}

function openPackModal(server, onSaved) {
  const modal = openModal({
    title: 'New Workshop pack',
    width: 620,
    body: `
      <label><span>Name</span><input id="wp-name" placeholder="Our server's mods" maxlength="60" /></label>
      <label><span>Collection link, or item links / IDs</span><textarea id="wp-input" rows="3" placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…"></textarea></label>
      <button class="btn btn-sm" id="wp-preview">Look up the items</button>
      <div id="wp-items" class="ws-preview mt-16"></div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save pack',
        primary: true,
        onClick: async (btn) => {
          btn.disabled = true;
          try {
            const { pack } = await api(`/api/servers/${server.id}/workshop-packs`, { method: 'POST', body: { name: $('#wp-name').value, input: $('#wp-input').value } });
            toast(`Saved ${pack.name} (${pack.items.length} items)`);
            modal.close();
            onSaved();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
  $('#wp-preview').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    $('#wp-items').innerHTML = '<span class="spinner"></span>';
    try {
      const { items, skipped } = await api(`/api/servers/${server.id}/workshop-packs/preview`, { method: 'POST', body: { input: $('#wp-input').value } });
      $('#wp-items').innerHTML = `<div class="faint mb-8">${items.length} item${items.length === 1 ? '' : 's'}${skipped.length ? `, ${skipped.length} left out (removed from the Workshop or private)` : ''}</div>${items
        .map((i) => `<a class="ws-item" href="${esc(i.url)}" target="_blank" rel="noopener">${i.icon ? `<img src="${esc(i.icon)}" alt="" loading="lazy" />` : ''}<span>${esc(i.title)}</span></a>`)
        .join('')}`;
    } catch (err) {
      $('#wp-items').innerHTML = `<span class="warning">${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });
}
