import { api } from '../../core/api.js';
import { $, esc, fmtBytes, icon, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';
import { sideBadge } from './modpacks.js';
import { renderWorkshopPacks } from './workshop-packs.js';

/* ------------------------------------------------------------------ mods */

/**
 * One-click mods. The panel already knows the server's loader and game
 * version, so search results only list builds that fit; every install shows
 * its plan (the mod plus anything it needs) before downloading.
 *
 * Installed mods are addressed by their manifest key, or by file name for
 * files someone dropped in by hand.
 */

const modState = { provider: null, query: '', results: [] };

const PROVIDER_NOTE = {
  workshop: 'Steam Workshop items are downloaded by SteamCMD and loaded by the game.',
  curseforge: 'CurseForge needs a free API key.',
};

export async function renderModsTab(host, server) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading mods…</div>';
  let info;
  try {
    info = await api(`/api/servers/${server.id}/mods`);
  } catch (err) {
    host.innerHTML = `<div class="card">Could not load mods: ${esc(err.message)}</div>`;
    return;
  }
  if (!host.isConnected) return; // the user moved to another tab meanwhile
  if (!info.supported || !info.providers.length) {
    host.innerHTML = `
      <div class="empty">
        <h3>No mod source for this game</h3>
        <p>You can still upload mods by hand in the <a href="#/servers/${esc(server.id)}/files">file manager</a>.</p>
      </div>`;
    return;
  }

  if (!info.providers.some((p) => p.id === modState.provider)) {
    modState.provider = info.providers[0].id;
    modState.query = '';
    modState.results = [];
  }
  const provider = info.providers.find((p) => p.id === modState.provider);
  const ctx = info.context || {};
  const missingKey = provider.needsKey && !info.keys[provider.id];

  host.innerHTML = `
    <div class="split">
      <div class="stack">
        <div class="card">
          <div class="filter-note mb-16">
            ${icon('check', 13)}
            ${
              ctx.filter
                ? `Showing only mods built for <b>${esc(ctx.filter)}</b>.`
                : 'Showing mods for this game.'
            }
            <span class="faint">Installs into <span class="mono">${esc(ctx.dir || 'mods')}</span></span>
          </div>

          ${
            info.providers.length > 1
              ? `<div class="row mb-16">${info.providers
                  .map((p) => `<button class="chip ${p.id === provider.id ? 'active' : ''}" data-provider="${esc(p.id)}">${esc(p.label)}</button>`)
                  .join('')}</div>`
              : ''
          }

          ${
            provider.viaSteamcmd
              ? `<div class="input-row mb-16">
                   <input id="mod-workshop-input" placeholder="Workshop link, collection link or item ID" />
                   <button class="btn btn-primary" id="mod-workshop-install">Add</button>
                 </div>
                 <div id="ws-packs" class="mb-16"></div>`
              : ''
          }

          ${
            missingKey
              ? `<div class="hint warning mb-16">${esc(provider.label)} needs an API key. Add one in <a href="#/settings/integrations">Settings</a>.</div>`
              : ''
          }

          <div class="input-row">
            <input id="mod-search" placeholder="Search ${esc(provider.label)}" value="${esc(modState.query)}" />
            <button class="btn" id="mod-search-btn">${icon('search', 13)} Search</button>
          </div>
          ${PROVIDER_NOTE[provider.id] ? `<div class="hint">${PROVIDER_NOTE[provider.id]}</div>` : ''}
        </div>

        <div id="mod-results" class="grid-cards"></div>
      </div>

      <div class="card" id="mod-installed">
        ${installedHtml(info)}
      </div>
    </div>`;

  const refresh = () => renderModsTab(host, server);

  host.querySelectorAll('[data-provider]').forEach((el) =>
    el.addEventListener('click', () => {
      modState.provider = el.dataset.provider;
      modState.query = '';
      modState.results = [];
      refresh();
    })
  );

  const search = async () => {
    const results = $('#mod-results');
    results.innerHTML = '<div class="card"><span class="spinner"></span> Searching…</div>';
    try {
      const data = await api(
        `/api/servers/${server.id}/mods/search?provider=${encodeURIComponent(provider.id)}&query=${encodeURIComponent(modState.query)}`
      );
      modState.results = data.items;
      renderResults(server, data.items, refresh);
    } catch (err) {
      results.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    }
  };
  $('#mod-search-btn').addEventListener('click', () => {
    modState.query = $('#mod-search').value.trim();
    search();
  });
  $('#mod-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#mod-search-btn').click();
  });

  $('#mod-workshop-install')?.addEventListener('click', async (event) => {
    const input = $('#mod-workshop-input').value.trim();
    if (!input) return;
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const res = await api(`/api/servers/${server.id}/mods/install`, { method: 'POST', body: { provider: 'workshop', input } });
      toast(res.message || 'Workshop item added');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  wireInstalled(server, info, refresh);
  if ($('#ws-packs')) renderWorkshopPacks($('#ws-packs'), server, refresh);

  // Show popular mods straight away, unless searching needs a key we lack.
  if (!missingKey && !(provider.viaSteamcmd && !info.keys.workshop)) search();
  else if (modState.results.length) renderResults(server, modState.results, refresh);
}

/* ------------------------------------------------------------ results -- */

function renderResults(server, items, refresh) {
  const results = $('#mod-results');
  if (!results) return;
  if (!items.length) {
    results.innerHTML = '<div class="card faint">Nothing compatible found. Try another search.</div>';
    return;
  }
  results.innerHTML = items
    .map(
      (item, i) => `
      <div class="tile-card spot" style="cursor:default">
        <div class="t-head">
          <span class="t-icon">${item.icon ? `<img src="${esc(item.icon)}" alt="" loading="lazy" />` : icon('puzzle', 16)}</span>
          <div style="min-width:0">
            <h3 title="${esc(item.name)}">${esc(item.name)}</h3>
            <div class="t-meta">${esc(item.author || '')}${item.downloads ? ` · ${compact(item.downloads)} downloads` : ''}</div>
          </div>
        </div>
        <p>${esc(item.description || '')}</p>
        <div class="row">${sideBadge(item)}</div>
        <div class="t-foot">
          ${item.url ? `<a class="btn btn-sm btn-ghost" href="${esc(item.url)}" target="_blank" rel="noopener">${icon('external', 12)}</a>` : ''}
          <button class="btn btn-sm ${item.installed ? '' : 'btn-primary'}" style="margin-left:auto" data-install="${i}">
            ${item.installed ? 'Installed' : 'Install'}
          </button>
        </div>
      </div>`
    )
    .join('');

  results.querySelectorAll('[data-install]').forEach((el) =>
    el.addEventListener('click', () => openInstallModal(server, items[Number(el.dataset.install)], refresh))
  );
}

const compact = (n) => Intl.NumberFormat('en', { notation: 'compact' }).format(Number(n) || 0);

/** Show what an install brings in, let the user pick a version, then install. */
function openInstallModal(server, item, refresh) {
  if (item.provider === 'workshop') {
    installWorkshop(server, item, refresh);
    return;
  }
  const modal = openModal({
    title: `Install ${esc(item.name)}`,
    width: 540,
    body: `
      <label class="field"><span>Version</span>
        <select id="mi-version"><option value="">Newest that fits this server</option></select>
      </label>
      <div class="label-caps" style="margin:4px 0 6px">What gets installed</div>
      <div id="mi-plan" class="list"><div class="faint"><span class="spinner"></span> Working out dependencies…</div></div>
      <div id="mi-notes"></div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Install',
        primary: true,
        onClick: async (btn) => {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Installing';
          try {
            const res = await api(`/api/servers/${server.id}/mods/install`, {
              method: 'POST',
              body: { provider: item.provider, projectId: item.id, versionId: $('#mi-version').value || undefined },
            });
            modal.close();
            const extra = res.installed.filter((m) => m.dependency).length;
            toast(`Installed ${item.name}${extra ? ` and ${extra} required mod${extra > 1 ? 's' : ''}` : ''}${res.restartNeeded ? '. Restart to load it.' : ''}`);
            refresh();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Install';
          }
        },
      },
    ],
  });

  const plan = async () => {
    const box = $('#mi-plan');
    if (!box) return;
    box.innerHTML = '<div class="faint"><span class="spinner"></span> Working out dependencies…</div>';
    try {
      const res = await api(`/api/servers/${server.id}/mods/plan`, {
        method: 'POST',
        body: { provider: item.provider, projectId: item.id, versionId: $('#mi-version').value || undefined },
      });
      box.innerHTML = res.steps.length
        ? res.steps
            .map(
              (st) => `
              <div class="list-row ${st.dependency ? 'child' : ''}">
                <span class="thumb">${st.icon ? `<img src="${esc(st.icon)}" alt="" />` : icon('puzzle', 14)}</span>
                <div class="grow"><div class="title">${esc(st.name)}</div><div class="sub">${esc(st.version)}${st.size ? ` · ${fmtBytes(st.size)}` : ''}</div></div>
                ${st.dependency ? '<span class="badge">Required</span>' : ''}
              </div>`
            )
            .join('')
        : '<div class="faint">Already installed. Nothing new to download.</div>';
      $('#mi-notes').innerHTML = res.notes.map((n) => `<div class="hint warning">${esc(n)}</div>`).join('');
    } catch (err) {
      box.innerHTML = `<div class="warning">${esc(err.message)}</div>`;
    }
  };

  api(`/api/servers/${server.id}/mods/versions?provider=${encodeURIComponent(item.provider)}&projectId=${encodeURIComponent(item.id)}`)
    .then(({ versions }) => {
      const select = $('#mi-version');
      if (!select) return;
      select.innerHTML =
        '<option value="">Newest that fits this server</option>' +
        versions
          .map((v) => `<option value="${esc(v.id)}">${esc(v.version)}${v.channel && v.channel !== 'release' ? ` (${esc(v.channel)})` : ''}${v.gameVersions?.length ? ` · ${esc(v.gameVersions.slice(-3).join(', '))}` : ''}</option>`)
          .join('');
      if (!versions.length) select.innerHTML = '<option value="">No build fits this server</option>';
      select.addEventListener('change', plan);
    })
    .catch(() => {});
  plan();
}

async function installWorkshop(server, item, refresh) {
  try {
    const res = await api(`/api/servers/${server.id}/mods/install`, { method: 'POST', body: { provider: 'workshop', input: String(item.id) } });
    toast(res.message || `Added ${item.name}`);
    refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------------------------------------------------- installed -- */

function installedHtml(info) {
  const items = info.installed.items;
  return `
    <div class="card-head">
      <h4>Installed <span class="faint" style="letter-spacing:0">${items.length}</span></h4>
      <div class="spacer"></div>
      ${info.checkable && items.length ? `<button class="btn btn-sm" id="mod-conflicts" title="Look inside the jars for problems">${icon('check', 12)} Check</button>` : ''}
      ${items.some((i) => i.key) ? `<button class="btn btn-sm" id="mod-check-updates">${icon('refresh', 12)} Updates</button>` : ''}
    </div>
    <div id="mod-check"></div>
    <div id="mod-updates"></div>
    ${
      items.length
        ? `<div class="list">${items.map(installedRow).join('')}</div>`
        : '<p class="faint" style="margin:0">Nothing installed yet. Pick a mod on the left.</p>'
    }
    ${info.running ? '<div class="hint">Restart the server to load changes.</div>' : ''}`;
}

function installedRow(item) {
  const id = item.key || item.name;
  const meta = [
    item.version,
    item.dependency && item.requiredBy?.length ? `needed by ${item.requiredBy.join(', ')}` : null,
    item.fromPack ? 'from the modpack' : null,
    !item.key && !item.directory ? fmtBytes(item.size) : null,
  ].filter(Boolean);
  return `
    <div class="list-row ${item.disabled ? 'is-off' : ''} ${item.dependency ? 'child' : ''}" data-mod="${esc(id)}">
      <span class="thumb">${item.icon ? `<img src="${esc(item.icon)}" alt="" loading="lazy" />` : icon(item.directory ? 'folder' : 'puzzle', 14)}</span>
      <div class="grow">
        <div class="title" title="${esc(item.name)}">${esc(item.title || item.name)}</div>
        <div class="sub">${esc(meta.join(' · ') || (item.key ? '' : 'added by hand'))}</div>
      </div>
      ${item.directory ? '' : `<label class="switch" title="${item.disabled ? 'Disabled' : 'Enabled'}"><input type="checkbox" data-toggle ${item.disabled ? '' : 'checked'} /><i></i></label>`}
      <button class="btn btn-sm btn-ghost btn-danger" data-remove title="Remove">${icon('trash', 13)}</button>
    </div>`;
}

/** Shows the jar check: quietly when there is nothing wrong, unless asked. */
async function runModCheck(server, { quiet = false } = {}) {
  const out = $('#mod-check');
  if (!out) return;
  if (!quiet) out.innerHTML = '<div class="faint mb-16"><span class="spinner"></span> Looking inside the jars…</div>';
  try {
    const r = await api(`/api/servers/${server.id}/mods/check`);
    if (!out.isConnected) return;
    const errors = r.issues.filter((i) => i.severity === 'error').length;
    if (!r.issues.length) {
      out.innerHTML = quiet ? '' : `<div class="filter-note mb-16">${icon('check', 12)} ${r.checked} jar${r.checked === 1 ? '' : 's'} checked: no problems found.</div>`;
      return;
    }
    out.innerHTML = `
      <div class="share-box mod-issues mb-16">
        <div class="row mb-16"><b>${errors ? `${errors} problem${errors === 1 ? '' : 's'}` : `${r.issues.length} warning${r.issues.length === 1 ? '' : 's'}`}</b>
          <span class="faint">${r.checked} jars, ${esc([r.loader, r.gameVersion].filter(Boolean).join(' '))}</span>
          <div class="spacer"></div><button class="btn btn-sm btn-ghost" data-close-check title="Hide">${icon('kill', 12)}</button></div>
        ${r.issues
          .map(
            (i) => `<div class="mod-issue ${i.severity}">
              <span class="dot"></span>
              <div class="grow"><div>${esc(i.message)}</div><div class="faint mono">${esc(i.file)}</div></div>
            </div>`
          )
          .join('')}
      </div>`;
    out.querySelector('[data-close-check]').addEventListener('click', () => (out.innerHTML = ''));
  } catch (err) {
    if (!quiet) out.innerHTML = `<div class="filter-note mb-16">${esc(err.message)}</div>`;
  }
}

function wireInstalled(server, info, refresh) {
  const box = $('#mod-installed');
  $('#mod-conflicts')?.addEventListener('click', () => runModCheck(server));
  // A quiet look every time the list is shown: only speaks up when something is wrong.
  if (info.checkable && info.installed.items.length) runModCheck(server, { quiet: true });
  box.querySelectorAll('[data-mod]').forEach((row) => {
    const id = row.dataset.mod;
    const item = info.installed.items.find((i) => (i.key || i.name) === id);
    row.querySelector('[data-toggle]')?.addEventListener('change', async () => {
      try {
        await api(`/api/servers/${server.id}/mods/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: {} });
        refresh();
      } catch (err) {
        toast(err.message, 'error');
        refresh();
      }
    });
    row.querySelector('[data-remove]').addEventListener('click', async () => {
      const deps = info.installed.items.filter((i) => i.dependency && (i.requiredBy || []).length === 1 && i.requiredBy[0] === item.title);
      const message = deps.length
        ? `Remove ${item.title}? ${deps.map((d) => d.title).join(', ')} ${deps.length > 1 ? 'are' : 'is'} only needed by it and will be removed too.`
        : `Remove ${item.title || item.name}?`;
      if (!(await confirmModal('Remove mod', message, 'Remove'))) return;
      try {
        const res = await api(`/api/servers/${server.id}/mods/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast(res.warning || `Removed ${res.removed.join(', ')}`, res.warning ? 'warn' : 'info');
      } catch (err) {
        toast(err.message, 'error');
      }
      refresh();
    });
  });

  $('#mod-check-updates')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const out = $('#mod-updates');
    btn.disabled = true;
    out.innerHTML = '<div class="faint mb-16"><span class="spinner"></span> Checking…</div>';
    try {
      const { updates } = await api(`/api/servers/${server.id}/mods/updates`);
      if (!updates.length) {
        out.innerHTML = '<div class="filter-note mb-16">Everything is up to date.</div>';
        return;
      }
      out.innerHTML = `
        <div class="share-box mb-16">
          <div class="row mb-16"><b>${updates.length} update${updates.length > 1 ? 's' : ''}</b><div class="spacer"></div>
            <button class="btn btn-sm btn-primary" id="mod-update-all">Update all</button></div>
          ${updates
            .map(
              (u) => `<div class="row" style="justify-content:space-between;padding:3px 0">
                <span>${esc(u.name)} <span class="faint mono">${esc(u.current || '?')} → ${esc(u.latest)}</span>${u.fromPack ? ' <span class="badge">pack</span>' : ''}</span>
                <button class="btn btn-sm" data-update="${esc(u.key)}">Update</button></div>`
            )
            .join('')}
        </div>`;
      const run = async (body, el) => {
        el.disabled = true;
        try {
          const res = await api(`/api/servers/${server.id}/mods/update`, { method: 'POST', body });
          toast(`Updated ${res.updated.length}${res.failed.length ? `, ${res.failed.length} failed` : ''}${res.restartNeeded ? '. Restart to load them.' : ''}`, res.failed.length ? 'warn' : 'info');
          refresh();
        } catch (err) {
          toast(err.message, 'error');
          el.disabled = false;
        }
      };
      $('#mod-update-all').addEventListener('click', (e) => run({ all: true }, e.currentTarget));
      out.querySelectorAll('[data-update]').forEach((el) => el.addEventListener('click', () => run({ keys: [el.dataset.update] }, el)));
    } catch (err) {
      out.innerHTML = `<div class="warning mb-16">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  });
}
