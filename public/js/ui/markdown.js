import { esc } from '../core/util.js';

/* ------------------------------------------------------------- markdown */

/*
 * A small, safe markdown renderer for server notes: headings, bold, italic,
 * `code`, fenced code, lists, task lists, quotes, rules and http(s) links.
 * All text is escaped first and raw HTML is never passed through.
 */

function inline(text) {
  let out = esc(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

export function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let list = null; // 'ul' | 'ol'
  let fence = null;
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (fence) {
      if (/^```/.test(line)) {
        html.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      closeList();
      fence = [];
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      html.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
    } else if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/))) {
      if (list !== 'ul') (closeList(), html.push('<ul class="md-tasks">'), (list = 'ul'));
      html.push(`<li><input type="checkbox" disabled ${m[1] === ' ' ? '' : 'checked'} /> ${inline(m[2])}</li>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== 'ul') (closeList(), html.push('<ul>'), (list = 'ul'));
      html.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') (closeList(), html.push('<ol>'), (list = 'ol'));
      html.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      html.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      html.push('<hr />');
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  if (fence) html.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  closeList();
  return html.join('\n');
}
