import { api } from '../../core/api.js';
import { $, can, esc, icon, toast } from '../../core/util.js';
import { openModal } from '../../ui/modal.js';

/* -------------------------------------------------------------- modpacks */

/**
 * Where a mod or pack actually runs. Modrinth publishes this per project, and
 * it is the difference between "drop it in and go" and "every player has to
 * install it too" — worth saying plainly.
 */
export function sideBadge(item) {
  const client = item.clientSide;
  const server = item.serverSide;
  if (!client && !server) return '';

  if (server === 'unsupported') {
    return `<span class="badge warn-badge" title="This is a client-side mod — installing it on the server does nothing">Client only</span>`;
  }
  if (client === 'required') {
    return `<span class="badge accent" title="Players must install this too, or they cannot join">Players need it too</span>`;
  }
  if (client === 'unsupported' || client === 'optional') {
    return `<span class="badge" title="Runs on the server; players need nothing">Server only</span>`;
  }
  return '';
}

// Which store the search below looks in.
let source = 'modrinth';

export async function renderModpacksTab(host, server) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading modpacks…</div>';
  let info;
  try {
    info = await api(`/api/servers/${server.id}/modpacks`);
  } catch (err) {
    host.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }
  if (!info.supported) {
    host.innerHTML = '<div class="empty"><h3>This server does not use modpacks</h3></div>';
    return;
  }

  const pack = info.current;
  host.innerHTML = `
    <div class="card mb-16">
      <div class="row">
        ${pack?.icon ? `<span class="t-icon" style="width:38px;height:38px"><img src="${esc(pack.icon)}" alt="" /></span>` : ''}
        <div style="min-width:0">
          <h4 style="margin:0 0 3px">${pack ? esc(pack.name || pack.slug) : 'No pack installed yet'}</h4>
          <div class="faint" style="font-size:12.5px">${
            pack
              ? `${esc(pack.version || pack.label)}${pack.mcVersion ? ` · Minecraft ${esc(pack.mcVersion)}` : ''}${
                  pack.loader ? ` · ${esc(pack.loader)}` : ''
                }`
              : 'Pick one below and the panel installs the loader, the mods and the pack’s configs.'
          }</div>
        </div>
        <div style="flex:1"></div>
        ${
          pack?.url
            ? `<a class="btn btn-sm" href="${esc(pack.url)}" target="_blank" rel="noopener">${icon(
                'external',
                12
              )} Pack page</a>`
            : ''
        }
      </div>

      ${
        pack && pack.clientRequired !== false
          ? `<div class="share-box mt-16">
               <div class="row" style="gap:7px;margin-bottom:6px">
                 <span class="badge accent">Players need this pack</span>
                 <span class="faint" style="font-size:12px">They must install the same version locally to join.</span>
               </div>
               <div class="row">
                 <code class="share-link" id="pack-share">${esc(pack.versionUrl || pack.url)}</code>
                 <button class="btn btn-sm" data-copy="${esc(pack.versionUrl || pack.url)}">${icon('copy', 12)} Copy</button>
                 <a class="btn btn-sm" href="${esc(pack.versionUrl || pack.url)}" target="_blank" rel="noopener">Open</a>
               </div>
               <div class="hint">
                 Send this to your players. In the Modrinth app or Prism/ATLauncher they can install it
                 straight from that page — the exact version this server runs.
               </div>
             </div>`
          : pack
            ? '<div class="hint mt-16">This pack is server-side only — players join with vanilla Minecraft ' +
              (pack.mcVersion ? esc(pack.mcVersion) : '') +
              ', nothing to install.</div>'
            : ''
      }

      ${
        info.running
          ? '<div class="hint" style="color:var(--warning)">Stop the server before changing its pack.</div>'
          : '<div class="hint">Changing the pack replaces the mods and the pack’s configs. Your world is kept.</div>'
      }
    </div>

    <div class="row mb-16">
      <select id="pack-source" style="width:auto"><option value="modrinth" ${source === 'modrinth' ? 'selected' : ''}>Modrinth</option><option value="curseforge" ${source === 'curseforge' ? 'selected' : ''}>CurseForge</option></select>
      <input id="pack-search" placeholder="Search ${source === 'curseforge' ? 'CurseForge' : 'Modrinth'} modpacks…" style="flex:1" />
      <button class="btn" id="pack-search-btn">Search</button>
    </div>
    <div id="pack-results" class="grid-cards"></div>`;

  const runSearch = async () => {
    const results = $('#pack-results');
    results.innerHTML = '<div class="card"><span class="spinner"></span> Searching…</div>';
    try {
      const data = await api(
        `/api/servers/${server.id}/modpacks/search?source=${source}&query=${encodeURIComponent($('#pack-search').value.trim())}`
      );
      renderPackResults(server, data.items, info);
    } catch (err) {
      results.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    }
  };

  $('#pack-source').addEventListener('change', (e) => {
    source = e.target.value;
    renderModpacksTab(host, server);
  });
  $('#pack-search-btn').addEventListener('click', runSearch);
  $('#pack-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
  runSearch();
}

function renderPackResults(server, items, info) {
  const results = $('#pack-results');
  if (!items.length) {
    results.innerHTML = '<div class="card faint">No packs found</div>';
    return;
  }
  results.innerHTML = items
    .map(
      (item, index) => `
      <div class="tile-card spot" style="cursor:default">
        <div class="t-head">
          ${
            item.icon
              ? `<span class="t-icon"><img src="${esc(item.icon)}" alt="" loading="lazy" /></span>`
              : `<span class="t-icon">${icon('file', 15)}</span>`
          }
          <div style="min-width:0">
            <h3>${esc(item.name)}</h3>
            <div class="t-meta">${esc(item.author || '')}${
        item.downloads ? ` · ${Number(item.downloads).toLocaleString()} downloads` : ''
      }</div>
          </div>
        </div>
        <p>${esc(item.description || '')}</p>
        <div class="row" style="gap:6px">${sideBadge(item)}${
        String(item.slug) === String(info.current?.slug) || String(item.id) === String(info.current?.slug) ? '<span class="badge accent">Installed</span>' : ''
      }</div>
        <div class="t-foot">
          <a class="btn btn-sm" href="${esc(item.url)}" target="_blank" rel="noopener">Open page</a>
          <button class="btn btn-sm btn-primary" style="margin-left:auto" data-pack="${index}" ${
        info.running ? 'disabled title="Stop the server first"' : ''
      }>${item.slug === info.current?.slug ? 'Change version' : 'Install'}</button>
        </div>
      </div>`
    )
    .join('');

  results.querySelectorAll('[data-pack]').forEach((el) =>
    el.addEventListener('click', () => openPackInstallModal(server, items[Number(el.dataset.pack)]))
  );
}

/** Pick a version of a pack, then reinstall the server onto it. */
async function openPackInstallModal(server, pack) {
  const modal = openModal({
    title: `Install ${pack.name}`,
    width: 560,
    body: `
      <p class="faint" style="margin-top:0">${esc(pack.description || '')}</p>
      <div class="row mb-16" style="gap:6px">${sideBadge(pack)}</div>
      <label><span>Version</span>
        <select id="pack-version"><option>Loading versions…</option></select>
        <div class="hint" id="pack-version-hint"></div>
      </label>
      <div class="hint" style="color:var(--warning)">
        This replaces the mods folder and the pack's own configs. Worlds, player data and
        server.properties are left alone.
      </div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Install pack',
        primary: true,
        onClick: async (btn) => {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Starting…';
          try {
            const res = await api(`/api/servers/${server.id}/modpacks/install`, {
              method: 'POST',
              body: { project: source === 'curseforge' ? pack.id : pack.slug || pack.id, versionId: $('#pack-version').value, source },
            });
            modal.close();
            toast(res.message || 'Installing the pack');
            location.hash = `#/servers/${server.id}/console`;
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Install pack';
          }
        },
      },
    ],
  });

  try {
    const data = await api(
      `/api/servers/${server.id}/modpacks/versions?source=${source}&project=${encodeURIComponent(source === 'curseforge' ? pack.id : pack.slug || pack.id)}`
    );
    const select = $('#pack-version');
    if (!data.versions.length) {
      select.innerHTML = '<option value="">No installable versions</option>';
      $('#pack-version-hint').textContent = 'This pack publishes no .mrpack file.';
      return;
    }
    select.innerHTML = data.versions
      .map(
        (v, i) =>
          `<option value="${esc(v.id)}">${esc(v.version)} — MC ${esc((v.gameVersions || []).join(', '))}${
            i === 0 ? ' — newest' : ''
          }</option>`
      )
      .join('');
    const describe = () => {
      const chosen = data.versions.find((v) => v.id === select.value);
      $('#pack-version-hint').textContent = chosen ? `Loader: ${(chosen.loaders || []).join(', ') || 'unknown'}` : '';
    };
    select.addEventListener('change', describe);
    describe();
  } catch (err) {
    $('#pack-version').innerHTML = `<option value="">${esc(err.message)}</option>`;
  }
}
