import { render, setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, can, esc, icon, toast } from '../core/util.js';
import { openCreateServerModal } from './deploy.js';
import { revealChildren } from '../ui/fx.js';

/* ------------------------------------------------------------- templates */

let templateFilter = { category: 'all', search: '' };

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
    </div>
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
        <div class="tile-card spot" data-template="${esc(tpl.id)}">
          <div class="t-head">
            <span class="t-icon">${esc(tpl.icon || '🎮')}</span>
            <div>
              <h3>${esc(tpl.name)}</h3>
              <div class="t-meta">${esc(tpl.category || 'Other')}${tpl.custom ? ' · custom' : ''}</div>
            </div>
          </div>
          <p>${esc(tpl.description || '')}</p>
          <div class="t-foot">
            <span class="badge mono" title="Default ports">${(tpl.ports || []).map((p) => p.default).join(' · ')}</span>
            ${
              state.user.role === 'admin'
                ? '<button class="btn btn-sm" style="margin-left:auto">Deploy</button>'
                : ''
            }
          </div>
        </div>`
              )
              .join('')
          : '<div class="empty" style="grid-column:1/-1"><h3>No templates match</h3></div>'
      }
    </div>`;

  revealChildren(view.querySelector('.grid-cards'));

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
    el.addEventListener('click', () => {
      if (state.user.role !== 'admin') return toast('Only administrators can create servers', 'warn');
      openCreateServerModal(el.dataset.template);
    })
  );
}
