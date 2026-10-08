import { api } from '../../core/api.js';
import { esc, fmtBytes, icon, toast, can } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';
import { skeleton } from '../../ui/skeleton.js';

/* ------------------------------------------------------ Minecraft datapacks */

/*
 * The "Datapacks" card on the Game settings tab: what is in the loaded
 * world's datapacks folder, whether each one is made for this version, and
 * adding packs from Modrinth or a zip.
 */

const compact = (n) => Intl.NumberFormat('en', { notation: 'compact' }).format(Number(n) || 0);

export async function renderDatapacksCard(host, server) {
  if (!host || !can('mods') || !/^minecraft-(?!bedrock$|velocity$)/.test(server.templateId || '')) return;
  let data;
  try {
    data = await api(`/api/servers/${server.id}/datapacks`);
  } catch {
    return;
  }
  if (!host.isConnected) return;
  const redraw = () => renderDatapacksCard(host, server);
  const fitBadge = (p) =>
    p.broken
      ? `<span class="badge bad" title="${esc(p.broken)}">Broken</span>`
      : p.fits === false
        ? `<span class="badge warn" title="Made for data pack format ${esc(p.format)}; ${esc(data.gameVersion)} uses ${esc(data.format)}. It may not work.">Other version</span>`
        : '';

  host.innerHTML = `
    <div class="card mb-16">
      <div class="card-head" style="flex-wrap:wrap">
        <h4>Datapacks <span class="faint" style="letter-spacing:0">${data.packs.length}</span></h4>
        <div class="spacer"></div>
        ${data.packs.some((p) => p.source) ? `<button class="btn btn-sm btn-ghost" id="dp-updates">${icon('refresh', 12)} Updates</button>` : ''}
        <label class="btn btn-sm btn-ghost" style="display:inline-flex">Upload zip<input type="file" id="dp-file" accept=".zip" hidden /></label>
        <button class="btn btn-sm btn-primary" id="dp-browse">Browse</button>
      </div>
      <div class="faint mb-8" style="font-size:12.5px">In <span class="mono">${esc(data.world)}/datapacks</span>${data.gameVersion ? ` · Minecraft ${esc(data.gameVersion)}${data.format ? ` (format ${esc(data.format)})` : ''}` : ''}</div>
      <div id="dp-update-list"></div>
      ${
        data.packs.length
          ? `<div class="list">${data.packs
              .map(
                (p) => `
            <div class="list-row ${p.on ? '' : 'is-off'}" data-dp="${esc(p.name)}">
              <span class="thumb">${p.source?.icon ? `<img src="${esc(p.source.icon)}" alt="" loading="lazy" />` : icon(p.folder ? 'folder' : 'puzzle', 14)}</span>
              <div class="grow" style="min-width:0">
                <div class="title" title="${esc(p.name)}">${esc(p.title)} ${fitBadge(p)}${p.offInGame && !data.running ? ' <span class="badge">Off in game</span>' : ''}</div>
                <div class="sub">${esc([p.source?.version, p.description, p.size ? fmtBytes(p.size) : null].filter(Boolean).join(' · ') || p.name)}</div>
              </div>
              ${p.broken ? '' : `<label class="switch" title="${p.on ? 'On' : 'Off'}"><input type="checkbox" data-dp-toggle ${p.on ? 'checked' : ''} /><i></i></label>`}
              <button class="btn btn-sm btn-ghost btn-danger" data-dp-remove title="Remove">${icon('trash', 13)}</button>
            </div>`
              )
              .join('')}</div>`
          : '<p class="faint" style="margin:0">No datapacks yet. Browse Modrinth or upload a zip.</p>'
      }
      <div class="hint">${data.running ? 'Changes apply right away (the panel runs /reload).' : 'Changes apply when the server starts.'}${data.packs.some((p) => p.fits === false) ? ' Packs marked "Other version" were made for another Minecraft version and may not work.' : ''}</div>
    </div>`;

  host.querySelector('#dp-browse').addEventListener('click', () => openBrowser(server, data, redraw));

  host.querySelectorAll('[data-dp-toggle]').forEach((box) =>
    box.addEventListener('change', async () => {
      const name = box.closest('[data-dp]').dataset.dp;
      try {
        await api(`/api/servers/${server.id}/datapacks/${encodeURIComponent(name)}/toggle`, { method: 'POST', body: { on: box.checked } });
        toast(`${name} turned ${box.checked ? 'on' : 'off'}${data.running ? '' : '. It applies on the next start.'}`);
        redraw();
      } catch (err) {
        box.checked = !box.checked;
        toast(err.message, 'error');
      }
    })
  );

  host.querySelectorAll('[data-dp-remove]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const name = btn.closest('[data-dp]').dataset.dp;
      if (!(await confirmModal('Remove datapack', `Delete ${esc(name)}? Things it added to the world (blocks, structures already built) stay.`, 'Remove'))) return;
      try {
        await api(`/api/servers/${server.id}/datapacks/${encodeURIComponent(name)}`, { method: 'DELETE' });
        toast(`${name} removed`);
        redraw();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  host.querySelector('#dp-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    toast(`Uploading ${file.name}…`);
    try {
      const res = await fetch(`/api/servers/${server.id}/datapacks/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, credentials: 'same-origin' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Upload failed');
      toast(`${out.name} added${out.reloaded ? ' and loaded' : ''}`);
      redraw();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  host.querySelector('#dp-updates')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const box = host.querySelector('#dp-update-list');
    btn.disabled = true;
    try {
      const { updates } = await api(`/api/servers/${server.id}/datapacks/updates`);
      if (!updates.length) {
        box.innerHTML = `<div class="filter-note mb-8">${icon('check', 12)} Every datapack from Modrinth is up to date.</div>`;
        return;
      }
      box.innerHTML = `<div class="share-box mb-8">${updates
        .map(
          (u, i) => `<div class="row" style="gap:8px;flex-wrap:wrap;padding:4px 0"><b>${esc(u.title)}</b><span class="faint">${esc(u.current)} → ${esc(u.latest)}</span><div class="spacer"></div><button class="btn btn-sm" data-dp-up="${i}">Update</button></div>`
        )
        .join('')}</div>`;
      box.querySelectorAll('[data-dp-up]').forEach((b) =>
        b.addEventListener('click', async () => {
          const u = updates[Number(b.dataset.dpUp)];
          b.disabled = true;
          b.innerHTML = '<span class="spinner"></span>';
          try {
            await api(`/api/servers/${server.id}/datapacks/install`, { method: 'POST', body: { projectId: u.projectId, versionId: u.versionId } });
            toast(`${u.title} updated to ${u.latest}`);
            redraw();
          } catch (err) {
            toast(err.message, 'error');
            b.disabled = false;
            b.textContent = 'Update';
          }
        })
      );
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

/** Search Modrinth for datapacks that fit the server's version. */
function openBrowser(server, data, done) {
  const modal = openModal({
    title: 'Add a datapack',
    width: 720,
    body: `
      <div class="row mb-8" style="gap:8px">
        <input id="dp-q" placeholder="Search Modrinth datapacks" style="flex:1" />
      </div>
      <div class="faint mb-8" style="font-size:12.5px">${data.gameVersion ? `Only packs with a release for Minecraft ${esc(data.gameVersion)}.` : 'The server version is not known yet, so every pack is listed.'}</div>
      <div id="dp-results" class="list">${skeleton('lines')}</div>`,
    actions: [{ label: 'Close', close: true }],
  });
  const root = document.querySelector('.modal-backdrop:last-child');
  const out = root.querySelector('#dp-results');
  let timer = null;
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    try {
      const r = await api(`/api/servers/${server.id}/datapacks/search?query=${encodeURIComponent(root.querySelector('#dp-q').value.trim())}`);
      if (mine !== seq || !out.isConnected) return;
      out.innerHTML = r.items.length
        ? r.items
            .map(
              (it, i) => `
          <div class="list-row">
            <span class="thumb">${it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy" />` : icon('puzzle', 14)}</span>
            <div class="grow" style="min-width:0">
              <div class="title">${esc(it.name)} <span class="faint" style="font-weight:400">${compact(it.downloads)} downloads</span></div>
              <div class="sub">${esc(it.description || '')}</div>
            </div>
            <a class="btn btn-sm btn-ghost" href="${esc(it.url)}" target="_blank" rel="noopener" title="Open on Modrinth">${icon('external', 12)}</a>
            <button class="btn btn-sm ${it.installed ? '' : 'btn-primary'}" data-dp-add="${i}" ${it.installed ? 'disabled' : ''}>${it.installed ? 'Added' : 'Add'}</button>
          </div>`
            )
            .join('')
        : '<div class="faint">Nothing found for this version.</div>';
      out.querySelectorAll('[data-dp-add]').forEach((b) =>
        b.addEventListener('click', async () => {
          const it = r.items[Number(b.dataset.dpAdd)];
          b.disabled = true;
          b.innerHTML = '<span class="spinner"></span>';
          try {
            const res = await api(`/api/servers/${server.id}/datapacks/install`, { method: 'POST', body: { projectId: it.id } });
            b.textContent = 'Added';
            toast(`${it.name} ${res.version} added${res.reloaded ? ' and loaded' : ''}${res.worldMissing ? '. It loads when the world is generated.' : ''}`);
            done();
          } catch (err) {
            toast(err.message, 'error');
            b.disabled = false;
            b.textContent = 'Add';
          }
        })
      );
    } catch (err) {
      if (mine === seq) out.innerHTML = `<div class="warning">${esc(err.message)}</div>`;
    }
  };
  root.querySelector('#dp-q').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 350);
  });
  load();
  return modal;
}
