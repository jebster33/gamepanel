import { render, setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, can, esc, gameArt, icon, toast } from '../core/util.js';
import { openCreateServerModal } from './deploy.js';
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
            ${
              state.user.role === 'admin'
                ? '<button class="btn btn-sm t-deploy">Deploy</button>'
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
