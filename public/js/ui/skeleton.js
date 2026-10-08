/* ------------------------------------------------------------- skeletons

   Grey placeholders in the shape of what is coming, shown while a page or a
   panel waits on the server. They fade in only after a beat (so fast loads
   never flash them) and whatever replaces them fades in too (see fx.js). */

const line = (width, cls = '') => `<i class="skel skel-line ${cls}" style="width:${width}"></i>`;
const WIDTHS = ['62%', '48%', '71%', '55%', '66%', '44%'];

/** A list row: a square thumbnail, a name and a quieter line under it. */
const row = (i) => `<div class="skel-row"><i class="skel skel-thumb"></i><div class="skel-stack">${line(WIDTHS[i % WIDTHS.length])}${line('28%', 'skel-sm')}</div>${line('64px', 'skel-pill')}</div>`;

/**
 * Placeholder markup. `kind` picks the shape:
 *   list  a card of rows (mods, backups, players…)   — the default
 *   card  a card with a heading and a few lines
 *   lines a few bare lines, for a panel inside an existing card
 *   page  a page heading, a row of tiles and a list
 */
export function skeleton(kind = 'list', label = 'Loading…', count = 4) {
  const sr = `<span class="sr-only">${label}</span>`;
  const wrap = (inner, cls = '') => `<div class="skel-wrap ${cls}" role="status" aria-busy="true">${sr}${inner}</div>`;
  if (kind === 'lines') return wrap(`${line('58%')}${line('74%')}${line('40%')}`, 'skel-lines');
  if (kind === 'card') return wrap(`<div class="card">${line('30%', 'skel-title')}${line('82%')}${line('64%')}${line('46%')}</div>`);
  const list = `<div class="card skel-list">${Array.from({ length: count }, (_, i) => row(i)).join('')}</div>`;
  if (kind === 'page')
    return wrap(
      `<div class="skel-head">${line('180px', 'skel-h1')}${line('260px', 'skel-sm')}</div>
       <div class="skel-tiles">${'<div class="card"><i class="skel skel-line skel-sm" style="width:40%"></i><i class="skel skel-line skel-big" style="width:55%"></i></div>'.repeat(3)}</div>
       ${list}`
    );
  return wrap(list);
}

/** Table body rows for a table whose header is already drawn. */
export function skeletonRows(cols, count = 6, label = 'Loading…') {
  const cells = (r) => Array.from({ length: cols }, (_, c) => `<td>${line(c === 0 ? WIDTHS[r % WIDTHS.length] : '60%')}</td>`).join('');
  return Array.from({ length: count }, (_, r) => `<tr class="skel-wrap" role="status" aria-busy="true">${cells(r)}</tr>`).join('').replace('<td>', `<td><span class="sr-only">${label}</span>`);
}
