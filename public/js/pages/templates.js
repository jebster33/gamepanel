import { render, setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { $, can, esc, gameArt, icon, toast } from '../core/util.js';
import { openCreateServerModal } from './deploy.js';
import { renderSetups } from './setups.js';
import { revealChildren } from '../ui/fx.js';
import { openModal } from '../ui/modal.js';

/* ------------------------------------------------------------- templates */

const fmtRam = (mb) => (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

/** The first couple of default ports, with the rest folded into "+N" so long lists fit. */
function portBadge(ports) {
  if (!ports.length) return '';
  const all = ports.map((p) => p.default);
  const shown = all.slice(0, 2).join(' · ') + (all.length > 2 ? ` +${all.length - 2}` : '');
  return `<span class="badge mono" title="Default ports: ${esc(all.join(', '))}">${esc(shown)}</span>`;
}

let templateFilter = { category: 'all', search: '' };

/** Administrators deploy anything; people with "create their own servers" anything not marked admin-only. */
const canDeploy = (tpl) => state.user.role === 'admin' || (can('deploy') && tpl && !tpl.adminOnly);

const fmtUse = (used, limit, unit) => (limit ? `${used} of ${limit} ${unit}` : `${used} ${unit}, no limit`);

/** What a self-service account has left to deploy with. */
async function showQuota() {
  const data = await api('/api/quota').catch(() => null);
  const host = $('#quota-note');
  if (!data?.quota || !host) return;
  const { quota: q, usage: u } = data;
  host.innerHTML = `<div class="card mb-16 quota-card">
    <b>Your quota</b>
    <span>${fmtUse(u.servers, q.servers, 'servers')}</span>
    <span>${fmtUse(Math.round((u.memoryMb / 1024) * 10) / 10, q.memoryMb ? Math.round((q.memoryMb / 1024) * 10) / 10 : 0, 'GB memory')}</span>
    <span>${fmtUse(Math.round((u.diskBytes / 1024 ** 3) * 10) / 10, q.diskGb, 'GB disk')}</span>
  </div>`;
}

export function renderTemplates(view) {
  setCrumbs('Games');
  const filtered = state.templates.filter((tpl) => {
    const categoryOk = templateFilter.category === 'all' || (tpl.category || 'Other') === templateFilter.category;
    const term = templateFilter.search.toLowerCase();
    const searchOk =
      !term ||
      tpl.name.toLowerCase().includes(term) ||
      String(tpl.description || '').toLowerCase().includes(term) ||
      String(tpl.category || '').toLowerCase().includes(term);
    return categoryOk && searchOk;
  });

  view.innerHTML = `
    <div class="page-head">
      <h1>Games</h1>
      <div class="spacer"></div>
      <input class="search-input" id="tpl-search" placeholder="Search games…" value="${esc(templateFilter.search)}" />
 ${state.user.role === 'admin' ? '<button class="btn" id="egg-import" title="Turn a Pterodactyl egg into a game">Import egg</button>' : ''}
      ${state.user.role === 'admin' ? '<a class="btn" href="#/templates/new" title="Add a game the panel does not ship">Build a game</a>' : ''}
    </div>
    <div id="quota-note"></div>
    ${templateFilter.category === 'all' && !templateFilter.search ? '<div id="setups"></div>' : ''}
    <div class="filter-bar">
      <span class="chip ${templateFilter.category === 'all' ? 'active' : ''}" data-cat="all">All (${state.templates.length})</span>
      ${state.categories
        .map(
          (c) =>
            `<span class="chip ${templateFilter.category === c.name ? 'active' : ''}" data-cat="${esc(c.name)}">${esc(
              c.name
            )} (${c.count})</span>`
        )
        .join('')}
    </div>
    <div class="grid-cards">
      ${
        filtered.length
          ? filtered
              .map(
                (tpl) => `
        <div class="tile-card spot game-card" data-template="${esc(tpl.id)}">
          <div class="g-art">${gameArt(tpl, { wide: true })}</div>
          <div class="t-head">
            <div class="min-w-0">
              <h3>${esc(tpl.name)}</h3>
              <div class="t-meta">${esc(tpl.category || 'Other')}${tpl.custom ? ' · custom' : ''}</div>
            </div>
          </div>
          <p>${esc(tpl.description || '')}</p>
          <div class="t-foot">
            ${tpl.defaultMemory ? `<span class="badge" title="Recommended memory for this game">${fmtRam(tpl.defaultMemory)} RAM</span>` : ''}
            ${portBadge(tpl.ports || [])}
            ${tpl.compat && /^arm/.test(tpl.compat.arch) ? `<span class="badge ${tpl.compat.status === 'ok' || tpl.compat.status === 'box64' ? 'accent' : ''}" title="${esc(tpl.compat.note)}">${esc(tpl.compat.label)}</span>` : ''}
            ${tpl.custom && state.user.role === 'admin' ? `<a class="btn btn-sm btn-ghost" href="#/templates/edit/${esc(tpl.id)}" data-no-deploy>Edit</a>` : ''}
            ${canDeploy(tpl) ? '<button class="btn btn-sm t-deploy">Deploy</button>' : ''}
          </div>
        </div>`
              )
              .join('')
          : '<div class="empty" style="grid-column:1/-1"><h3>No templates match</h3></div>'
      }
    </div>`;

  revealChildren(view.querySelector('.grid-cards'));
  renderSetups($('#setups'));
  if (state.user.role !== 'admin' && can('deploy')) showQuota();

  $('#egg-import')?.addEventListener('click', openEggImport);
  $('#tpl-search').addEventListener('input', (event) => {
    templateFilter.search = event.target.value;
    const caret = event.target.selectionStart;
    render();
    const box = $('#tpl-search');
    box.focus();
    box.setSelectionRange(caret, caret);
  });
  view.querySelectorAll('[data-cat]').forEach((el) =>
    el.addEventListener('click', () => {
      templateFilter.category = el.dataset.cat;
      render();
    })
  );
  view.querySelectorAll('[data-template]').forEach((el) =>
    el.addEventListener('click', (event) => {
      if (event.target.closest('[data-no-deploy]')) return;
      const tpl = state.templates.find((t) => t.id === el.dataset.template);
      if (!canDeploy(tpl)) return toast(can('deploy') ? 'Only administrators can create this kind of server' : 'Only administrators can create servers', 'warn');
      openCreateServerModal(el.dataset.template);
    })
  );
}

/** Import a Pterodactyl egg (file, address or pasted JSON) as a draft game and open it in the builder. */
function openEggImport() {
  let draft = null;
  const modal = openModal({
    title: 'Import a Pterodactyl egg',
    width: 680,
    body: `<p class="faint" style="margin-top:0">Eggs from the <a href="https://github.com/pelican-eggs/eggs" target="_blank" rel="noopener">community egg repository</a> become a game you can review and edit before it is added. Imported games are administrator-only and run the egg's install script, so only import eggs you trust.</p>
      <label class="field"><span>Egg file</span><input type="file" id="egg-file" accept=".json,application/json" /></label>
      <label class="field"><span>Or an address</span><input id="egg-url" placeholder="https://raw.githubusercontent.com/…/egg-paper.json" /></label>
      <label class="field"><span>Or paste the JSON</span><textarea id="egg-text" class="mono" rows="6" spellcheck="false"></textarea></label>
      <div id="egg-report"></div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Convert',
        primary: true,
        onClick: async (btn) => {
          if (draft) {
            try {
              sessionStorage.setItem('gp-template-draft', JSON.stringify(draft));
            } catch {
              return toast('This browser blocked saving the draft', 'error');
            }
            modal.close();
            location.hash = '#/templates/new';
            return;
          }
          const file = $('#egg-file').files[0];
          const url = $('#egg-url').value.trim();
          const text = $('#egg-text').value.trim();
          const body = file ? { egg: await file.text() } : text ? { egg: text } : url ? { url } : null;
          if (!body) return toast('Choose a file, an address or paste the egg', 'error');
          btn.disabled = true;
          try {
            const r = await api('/api/templates/import-egg', { method: 'POST', body });
            const list = (title, items, cls) => (items.length ? `<div class="mt-8"><b>${title}</b><ul class="${cls}" style="margin:4px 0 0 18px">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>` : '');
            $('#egg-report').innerHTML = `<div class="card" style="margin-top:12px"><b>${esc(r.template.name)}</b> converted: ${r.template.variables.length} settings, ${r.template.install.length ? 'an install script' : 'no install script'}, image ${esc(r.template.image || 'default')}.
              ${list('Cannot be imported', r.unsupported, 'bad')}${list('Changed or assumed', r.notes, '')}${list('Needs fixing before it can be added', r.errors, 'bad')}${list('Check', r.warnings, '')}</div>`;
            draft = r.template;
            btn.textContent = 'Open in the builder';
            btn.disabled = false;
          } catch (err) {
            btn.disabled = false;
            toast(err.message, 'error');
          }
        },
      },
    ],
  });
}
