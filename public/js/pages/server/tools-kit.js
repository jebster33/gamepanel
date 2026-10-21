import { esc, toast } from '../../core/util.js';

/* ------------------------------------------------- shared bits for the Tools tab */

/**
 * A collapsible card that loads its content the first time it is opened.
 * `def` is { id, title, lead, open?, load(body, card) }.
 */
export function section(host, def) {
  const card = document.createElement('details');
  card.className = 'card tools-sec';
  card.dataset.tool = def.id;
  card.innerHTML = `<summary><span class="tools-title">${esc(def.title)}</span><span class="faint tools-lead">${esc(def.lead || '')}</span></summary><div class="tools-body"></div>`;
  const body = card.querySelector('.tools-body');
  let loaded = false;
  const open = () => {
    if (loaded) return;
    loaded = true;
    body.innerHTML = '<span class="spinner"></span>';
    Promise.resolve(def.load(body, card)).catch((err) => {
      body.innerHTML = `<div class="faint">${esc(err.message)}</div>`;
    });
  };
  card.addEventListener('toggle', () => card.open && open());
  host.appendChild(card);
  if (def.open) {
    card.open = true;
    open();
  }
  return card;
}

/** Run an action; shows errors as a toast and returns null on failure. */
export async function attempt(fn, okMessage) {
  try {
    const out = await fn();
    if (okMessage) toast(okMessage);
    return out ?? true;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

export const table = (head, rows, { empty = 'Nothing here yet.' } = {}) =>
  rows.length
    ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="faint">${esc(empty)}</div>`;

export const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

export const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Triggers a download of text/blob the browser already has. */
export function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const field = (label, control, hint = '') => `<label class="field"><span>${esc(label)}</span>${control}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</label>`;
