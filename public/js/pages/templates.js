import { render, setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { $, can, esc, gameArt, icon, toast } from '../core/util.js';
import { openCreateServerModal } from './deploy.js';
import { renderSetups } from './setups.js';
import { revealChildren } from '../ui/fx.js';

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
      <div><h1>Games</h1><div class="lede">Pick one and the panel installs it, gives it ports and starts it.</div></div>
      <div class="spacer"></div>
      <input class="search-input" id="tpl-search" placeholder="Search games…" value="${esc(templateFilter.search)}" />
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

  $('#tpl-search').addEventListener('input', (event) => {
    templateFilter.search = event.target.value;
    render();
    $('#tpl-search').focus();
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
