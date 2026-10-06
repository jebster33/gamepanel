import { api } from '../../core/api.js';
import { esc, toast, fmtBytes, fmtTime, can } from '../../core/util.js';
import { openModal, confirmModal } from '../../ui/modal.js';

/* ------------------------------------------------------- Minecraft worlds */

/*
 * The "Worlds" card on the Game settings tab: which world the server loads,
 * and switching, importing, downloading and resetting worlds.
 */

export async function renderWorldsCard(host, server) {
  let data;
  try {
    data = await api(`/api/servers/${server.id}/worlds`);
  } catch {
    return;
  }
  if (!data.supported) return;
  const write = can('files.write');
  const running = ['running', 'starting'].includes(server.status);
  const redraw = () => renderWorldsCard(host, server);

  host.innerHTML = `
    <div class="card mb-16">
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <h4 style="margin:0">Worlds</h4>
        ${write ? `<label class="btn btn-sm" style="display:inline-flex">Import a world<input type="file" id="gw-file" accept=".zip,.tar.gz,.tgz,.tar" hidden /></label>` : ''}
      </div>
      ${
        data.worlds.length
          ? `<div class="world-list">${data.worlds
              .map(
                (w) => `
            <div class="world-row ${w.active ? 'active' : ''}">
              <div class="world-icon">🌍</div>
              <div style="flex:1;min-width:0">
                <div class="world-name">${esc(w.name)}${w.active ? ' <span class="badge accent">Loaded</span>' : ''}</div>
                <div class="faint" style="font-size:12px">${fmtBytes(w.size)} · ${w.dimensions > 1 ? `${w.dimensions} dimensions · ` : ''}saved ${esc(fmtTime(w.modified))}</div>
              </div>
              <div class="row" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
                ${!w.active && can('settings') ? `<button class="btn btn-sm" data-use="${esc(w.name)}">Load this</button>` : ''}
                <a class="btn btn-sm btn-ghost" href="/api/servers/${server.id}/worlds/download?name=${encodeURIComponent(w.name)}" download>Download</a>
                ${write ? `<button class="btn btn-sm btn-ghost" data-reset="${esc(w.name)}" ${running ? 'disabled title="Stop the server first"' : ''}>${w.active ? 'Reset' : 'Delete'}</button>` : ''}
              </div>
            </div>`
              )
              .join('')}</div>`
          : '<div class="faint">No worlds yet. Start the server once and it generates one.</div>'
      }
      ${!data.activeExists && data.worlds.length ? `<div class="hint">The server is set to load <span class="mono">${esc(data.active)}</span>, which does not exist yet, so a new world is generated on the next start.</div>` : ''}
      ${data.seed ? `<div class="hint">Seed for new worlds: <span class="mono">${esc(data.seed)}</span></div>` : ''}
    </div>`;

  host.querySelectorAll('[data-use]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        const r = await api(`/api/servers/${server.id}/worlds/use`, { method: 'POST', body: { name: btn.dataset.use } });
        toast(r.restartNeeded ? 'Restart the server to load that world.' : 'That world loads on the next start.');
        redraw();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  host.querySelectorAll('[data-reset]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const world = data.worlds.find((w) => w.name === btn.dataset.reset);
      if (world.active) return openReset(server, world, redraw);
      confirmModal('Delete world', `Delete ${esc(world.name)}? A backup of the whole server is made first.`, 'Delete').then(async (ok) => {
        if (!ok) return;
        try {
          await api(`/api/servers/${server.id}/worlds/delete`, { method: 'POST', body: { name: world.name } });
          toast('World deleted. The backup is on the Backups tab.');
          redraw();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    })
  );

  host.querySelector('#gw-file')?.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const suggested = file.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '').replace(/[^A-Za-z0-9 _.\-]/g, '_').slice(0, 64) || 'imported';
    const upload = `.gp-upload-${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    toast(`Uploading ${file.name}…`);
    try {
      const res = await fetch(`/api/servers/${server.id}/files/upload?path=${encodeURIComponent(upload)}`, { method: 'POST', body: file, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
      await api(`/api/servers/${server.id}/worlds/import`, { method: 'POST', body: { path: upload, name: suggested, use: false } });
      toast(`Imported ${suggested}. Press "Load this" to play on it.`, 'info', 6000);
      redraw();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function openReset(server, world, done) {
  openModal({
    title: `Reset ${world.name}`,
    width: 480,
    body: `
      <p style="margin-top:0">The world is deleted and a fresh one is generated the next time the server starts. Player inventories in this world go with it.</p>
      <label class="field"><span>Seed for the new world</span><input id="gw-seed" placeholder="Leave empty for a random seed" maxlength="64" /></label>
      <div class="checkbox-row"><input type="checkbox" id="gw-backup" checked /><label for="gw-backup">Back up the whole server first (recommended)</label></div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Reset world',
        danger: true,
        onClick: async (btn, m) => {
          const root = document.querySelector('.modal-backdrop:last-child');
          btn.disabled = true;
          btn.textContent = root.querySelector('#gw-backup').checked ? 'Backing up…' : 'Resetting…';
          try {
            const r = await api(`/api/servers/${server.id}/worlds/reset`, {
              method: 'POST',
              body: { name: world.name, seed: root.querySelector('#gw-seed').value.trim(), backup: root.querySelector('#gw-backup').checked },
            });
            m.close();
            toast(r.backup ? 'World reset. The old one is in the backup.' : 'World reset.');
            done();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Reset world';
          }
        },
      },
    ],
  });
}
