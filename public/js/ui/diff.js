import { esc } from '../core/util.js';
import * as core from './diff-core.js';

const { visibleRows } = core;

// The algorithm lives in diff-core.js (no DOM, so tests load it); these are the names the pages import.
export const lineDiff = (before, after) => core.lineDiff(before, after);
export const diffStats = (rows) => core.diffStats(rows);
export const sideBySide = (rows) => core.sideBySide(rows);
export const changeStarts = (paired) => core.changeStarts(paired);

/* ------------------------------------------------------------------ diff */

/** The diff as HTML, with unchanged runs folded down to a few lines of context. */
export function renderDiff(rows, context = 3) {
  const changed = rows.map((r) => r.op !== ' ');
  if (!changed.some(Boolean)) return '<div class="faint" style="padding:12px">No differences.</div>';
  const keep = rows.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) if (changed[k]) return true;
    return false;
  });
  let html = '';
  let skipped = 0;
  rows.forEach((row, i) => {
    if (!keep[i]) {
      skipped++;
      return;
    }
    if (skipped) html += `<div class="diff-fold">… ${skipped} unchanged line${skipped === 1 ? '' : 's'}</div>`;
    skipped = 0;
    const cls = row.op === '+' ? 'add' : row.op === '-' ? 'del' : '';
    html += `<div class="diff-line ${cls}"><span class="diff-op">${row.op === ' ' ? '' : row.op}</span>${esc(row.text) || ' '}</div>`;
  });
  if (skipped) html += `<div class="diff-fold">… ${skipped} unchanged line${skipped === 1 ? '' : 's'}</div>`;
  return `<div class="diff">${html}</div>`;
}

/**
 * Two columns, old on the left and new on the right, with the changed lines
 * highlighted. Unchanged runs fold. Returns HTML; `labels` names the columns.
 */
export function renderSideBySide(rows, { context = 3, labels = ['Left', 'Right'] } = {}) {
  const paired = sideBySide(rows);
  if (!rows.some((r) => r.op !== ' ')) return '<div class="faint" style="padding:12px">The two are identical.</div>';
  const keep = visibleRows(paired.map((p) => p.op), context);
  const cell = (side, cls) => `<div class="sbs-cell ${side ? cls : 'empty'}"><span class="sbs-n">${side ? side.n : ''}</span><span class="sbs-t">${side ? esc(side.text) || ' ' : ''}</span></div>`;
  let html = '';
  let skipped = 0;
  const fold = () => {
    if (skipped) html += `<div class="sbs-fold">… ${skipped} unchanged line${skipped === 1 ? '' : 's'}</div>`;
    skipped = 0;
  };
  paired.forEach((row, i) => {
    if (!keep[i]) {
      skipped++;
      return;
    }
    fold();
    const change = row.op !== ' ';
    html += `<div class="sbs-row${change ? ' change' : ''}" data-sbs-row="${i}">${cell(row.left, row.op === '+' ? '' : change ? 'del' : '')}${cell(row.right, row.op === '-' ? '' : change ? 'add' : '')}</div>`;
  });
  fold();
  return `<div class="sbs"><div class="sbs-head"><span>${esc(labels[0])}</span><span>${esc(labels[1])}</span></div><div class="sbs-body">${html}</div></div>`;
}
