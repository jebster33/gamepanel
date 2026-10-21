/* The diff algorithm and its side-by-side layout. No DOM and no imports, so tests can load it. */

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

export function diffStats(rows) {
  return { added: rows.filter((r) => r.op === '+').length, removed: rows.filter((r) => r.op === '-').length };
}

/**
 * Lay a line diff out in two columns. Runs of removed lines are matched
 * with the added lines that follow them, so a changed line shows old and new
 * on one row. Each side is { n, text } (n is its 1-based line number) or null.
 */
export function sideBySide(rows) {
  const out = [];
  let l = 0;
  let r = 0;
  let i = 0;
  while (i < rows.length) {
    if (rows[i].op === ' ') {
      out.push({ op: ' ', left: { n: ++l, text: rows[i].text }, right: { n: ++r, text: rows[i].text } });
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].op === '-') dels.push(rows[i++].text);
    while (i < rows.length && rows[i].op === '+') adds.push(rows[i++].text);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const left = k < dels.length ? { n: ++l, text: dels[k] } : null;
      const right = k < adds.length ? { n: ++r, text: adds[k] } : null;
      out.push({ op: left && right ? '~' : left ? '-' : '+', left, right });
    }
  }
  return out;
}

/** Row indexes to show: changed rows and `context` rows around them. Everything else folds. */
export function visibleRows(ops, context = 3) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  return keep;
}

/** Row indexes (in the side-by-side list) where each change block starts, for "next change". */
export function changeStarts(paired) {
  const starts = [];
  paired.forEach((row, i) => {
    if (row.op !== ' ' && (i === 0 || paired[i - 1].op === ' ')) starts.push(i);
  });
  return starts;
}
