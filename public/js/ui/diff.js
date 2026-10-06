import { esc } from '../core/util.js';

/* ------------------------------------------------------------------ diff */

/**
 * Line diff of two texts: [{ op: ' ' | '-' | '+', text }]. The common start
 * and end are trimmed first, so config edits (a few changed lines in a long
 * file) stay cheap; the middle uses a longest-common-subsequence table.
 */
export function lineDiff(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out = a.slice(0, start).map((text) => ({ op: ' ', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > 4_000_000) {
    // Too big to match line by line: show it as replaced.
    out.push(...midA.map((text) => ({ op: '-', text })), ...midB.map((text) => ({ op: '+', text })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ op: ' ', text: midA[i] });
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) out.push({ op: '-', text: midA[i++] });
      else out.push({ op: '+', text: midB[j++] });
    }
    while (i < n) out.push({ op: '-', text: midA[i++] });
    while (j < m) out.push({ op: '+', text: midB[j++] });
  }
  out.push(...a.slice(endA).map((text) => ({ op: ' ', text })));
  return out;
}

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

export function diffStats(rows) {
  return { added: rows.filter((r) => r.op === '+').length, removed: rows.filter((r) => r.op === '-').length };
}
