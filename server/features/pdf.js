'use strict';

/**
 * A tiny PDF writer with no dependencies: A4 pages, the two standard
 * Helvetica fonts (no embedding needed), text, lines, rectangles, simple
 * tables and vector bar charts. Content streams are deflated.
 *
 *   const doc = new PdfDocument({ title: 'Report' });
 *   doc.h1('Hello'); doc.table(['A', 'B'], [['1', '2']]); doc.bars([{ label: 'x', value: 0.9 }]);
 *   fs.writeFileSync('r.pdf', doc.build());
 *
 * Only Latin-1 text is supported; anything else prints as "?".
 */

const zlib = require('zlib');

const W = 595.28;
const H = 841.89;
const MARGIN = 48;

// Helvetica advance widths for ASCII 32..126 (1000 units per em).
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

function textWidth(str, size, bold = false) {
  let w = 0;
  for (const ch of String(str)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? HELV[c - 32] : 556;
  }
  return (w * size * (bold ? 1.06 : 1)) / 1000;
}

/** A PDF string literal in Latin-1 with the special characters escaped. */
function pdfString(str) {
  let out = '';
  for (const ch of String(str)) {
    const c = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (c >= 32 && c <= 126) out += ch;
    else if (c >= 160 && c <= 255) out += `\\${c.toString(8).padStart(3, '0')}`;
    else if (ch === '–' || ch === '—') out += '-';
    else if (ch === '’' || ch === '‘') out += "'";
    else out += '?';
  }
  return `(${out})`;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => num(v / 255)).join(' ');
};

const COLORS = { ink: '#1b1c18', muted: '#5d5b53', faint: '#8c8a81', rule: '#d8d6cc', panel: '#f3f2ed', good: '#4f8a10', warn: '#c98000', bad: '#d63a32', accent: '#6f9a00' };

class Page {
  constructor() {
    this.ops = [];
  }

  text(x, y, str, { size = 10, bold = false, color = COLORS.ink, align = 'left', maxWidth } = {}) {
    let s = String(str ?? '');
    if (maxWidth) {
      if (textWidth(s, size, bold) > maxWidth) {
        while (s.length > 3 && textWidth(`${s}..`, size, bold) > maxWidth) s = s.slice(0, -1);
        s = `${s}..`;
      }
    }
    const w = textWidth(s, size, bold);
    const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${num(px)} ${num(H - y)} Td ${pdfString(s)} Tj ET`);
  }

  line(x1, y1, x2, y2, { color = COLORS.rule, width = 0.7 } = {}) {
    this.ops.push(`${num(width)} w ${rgb(color)} RG ${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S`);
  }

  rect(x, y, w, h, { fill, stroke, width = 0.7 } = {}) {
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.ops.push(`${fill ? `${rgb(fill)} rg ` : ''}${stroke ? `${rgb(stroke)} RG ${num(width)} w ` : ''}${num(x)} ${num(H - y - h)} ${num(w)} ${num(h)} re ${op}`);
  }

  stream() {
    return Buffer.from(this.ops.join('\n'), 'latin1');
  }
}

class PdfDocument {
  constructor({ title = 'Document', author = 'GamePanel', footer = '' } = {}) {
    this.title = title;
    this.author = author;
    this.footer = footer;
    this.pages = [];
    this.y = 0;
    this.newPage();
  }

  newPage() {
    this.page = new Page();
    this.pages.push(this.page);
    this.y = MARGIN;
    return this.page;
  }

  /** Start a new page unless `height` still fits on this one. */
  ensure(height) {
    if (this.y + height > H - MARGIN - 18) this.newPage();
  }

  h1(str) {
    this.ensure(40);
    this.page.text(MARGIN, this.y + 22, str, { size: 22, bold: true });
    this.y += 34;
  }

  h2(str) {
    this.ensure(34);
    this.y += 8;
    this.page.text(MARGIN, this.y + 13, str, { size: 13, bold: true });
    this.page.line(MARGIN, this.y + 20, W - MARGIN, this.y + 20);
    this.y += 28;
  }

  para(str, { size = 10, color = COLORS.muted } = {}) {
    const max = W - MARGIN * 2;
    const words = String(str).split(/\s+/);
    let line = '';
    const lines = [];
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size) > max && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      this.ensure(size + 5);
      this.page.text(MARGIN, this.y + size, l, { size, color });
      this.y += size + 4;
    }
    this.y += 4;
  }

  /** A row of big numbers: [{label, value, tone}] */
  stats(items) {
    this.ensure(58);
    const gap = 10;
    const w = (W - MARGIN * 2 - gap * (items.length - 1)) / items.length;
    items.forEach((it, i) => {
      const x = MARGIN + i * (w + gap);
      this.page.rect(x, this.y, w, 48, { fill: COLORS.panel });
      this.page.text(x + 10, this.y + 17, String(it.label).toUpperCase(), { size: 7, color: COLORS.faint, bold: true });
      this.page.text(x + 10, this.y + 38, String(it.value), { size: 17, bold: true, color: COLORS[it.tone] || COLORS.ink, maxWidth: w - 16 });
    });
    this.y += 58;
  }

  /** widths are fractions of the page width (summing to 1); `align` per column: 'left' | 'right'. */
  table(headers, rows, { widths, align = [] } = {}) {
    const total = W - MARGIN * 2;
    const cols = widths || headers.map(() => 1 / headers.length);
    const xs = [];
    let acc = MARGIN;
    for (const f of cols) {
      xs.push(acc);
      acc += f * total;
    }
    const cell = (page, r, y, str, bold, color) => {
      const right = align[r] === 'right';
      const x = right ? xs[r] + cols[r] * total - 6 : xs[r] + 6;
      page.text(x, y, str, { size: 9, bold, color, align: right ? 'right' : 'left', maxWidth: cols[r] * total - 12 });
    };
    const header = () => {
      this.ensure(40);
      this.page.rect(MARGIN, this.y, total, 20, { fill: COLORS.panel });
      headers.forEach((h, i) => cell(this.page, i, this.y + 14, String(h).toUpperCase(), true, COLORS.muted));
      this.y += 20;
    };
    header();
    rows.forEach((row) => {
      if (this.y + 20 > H - MARGIN - 18) {
        this.newPage();
        header();
      }
      row.forEach((v, i) => cell(this.page, i, this.y + 14, v?.text ?? v, false, v?.color || COLORS.ink));
      this.page.line(MARGIN, this.y + 20, W - MARGIN, this.y + 20, { color: '#e8e6dd', width: 0.5 });
      this.y += 20;
    });
    this.y += 8;
  }

  /** Horizontal bars: items [{label, value (0..max), text?, color?}]. */
  bars(items, { max = 1, labelWidth = 130 } = {}) {
    const barX = MARGIN + labelWidth;
    const barW = W - MARGIN - barX - 56;
    for (const it of items) {
      this.ensure(22);
      this.page.text(MARGIN, this.y + 11, it.label, { size: 9, maxWidth: labelWidth - 8 });
      this.page.rect(barX, this.y + 2, barW, 11, { fill: '#eceae2' });
      const frac = it.value == null ? 0 : Math.max(0, Math.min(1, it.value / max));
      if (frac > 0) this.page.rect(barX, this.y + 2, Math.max(1.5, barW * frac), 11, { fill: it.color || COLORS.accent });
      this.page.text(W - MARGIN, this.y + 11, it.text ?? (it.value == null ? 'no data' : String(it.value)), { size: 9, align: 'right', bold: true, color: it.value == null ? COLORS.faint : COLORS.ink });
      this.y += 20;
    }
    this.y += 6;
  }

  /** Vertical bars, one per value (null = a gap): used for uptime per day. */
  columns(values, { height = 70, max = 1, label = '', color = COLORS.accent } = {}) {
    this.ensure(height + 30);
    if (label) {
      this.page.text(MARGIN, this.y + 9, label, { size: 8, color: COLORS.faint, bold: true });
      this.y += 14;
    }
    const total = W - MARGIN * 2;
    const step = total / values.length;
    this.page.rect(MARGIN, this.y, total, height, { fill: '#f7f6f1' });
    values.forEach((v, i) => {
      if (v == null) return;
      const h = Math.max(1, (Math.min(max, v) / max) * (height - 4));
      this.page.rect(MARGIN + i * step + 1, this.y + height - h - 2, Math.max(1, step - 2), h, { fill: v >= 0.99 * max ? color : v >= 0.9 * max ? COLORS.warn : COLORS.bad });
    });
    this.y += height + 6;
    this.page.text(MARGIN, this.y + 8, '1', { size: 7, color: COLORS.faint });
    this.page.text(W - MARGIN, this.y + 8, String(values.length), { size: 7, color: COLORS.faint, align: 'right' });
    this.y += 20;
  }

  space(n = 10) {
    this.y += n;
  }

  /** Assemble the file: header, objects, cross-reference table, trailer. */
  build() {
    const objects = []; // index = object number - 1
    const add = (body) => objects.push(body) && objects.length;
    const catalog = add(null);
    const pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const info = add(`<< /Title ${pdfString(this.title)} /Author ${pdfString(this.author)} /Producer (GamePanel) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);

    const kids = [];
    this.pages.forEach((page, i) => {
      if (this.footer) {
        page.line(MARGIN, H - 34, W - MARGIN, H - 34);
        page.text(MARGIN, H - 22, this.footer, { size: 8, color: COLORS.faint });
        page.text(W - MARGIN, H - 22, `Page ${i + 1} of ${this.pages.length}`, { size: 8, color: COLORS.faint, align: 'right' });
      }
      const data = zlib.deflateSync(page.stream());
      const content = add({ dict: `<< /Length ${data.length} /Filter /FlateDecode >>`, data });
      const pageObj = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(W)} ${num(H)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`);
      kids.push(`${pageObj} 0 R`);
    });
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

    const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    const offsets = [];
    let pos = chunks[0].length;
    objects.forEach((obj, i) => {
      offsets.push(pos);
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const body = typeof obj === 'string' ? Buffer.from(`${obj}\nendobj\n`, 'latin1') : Buffer.concat([Buffer.from(`${obj.dict}\nstream\n`, 'latin1'), obj.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      chunks.push(head, body);
      pos += head.length + body.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}

module.exports = { PdfDocument, textWidth, pdfString, COLORS, W, H, MARGIN };
