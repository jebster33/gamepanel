import { api } from '../core/api.js';
import { esc } from '../core/util.js';
import { openModal } from '../ui/modal.js';

/* ------------------------------------------------ ban and kick templates */

let cache = null;

/** The shared reason templates (kept for a minute so dialogs open quickly). */
export async function loadReasonTemplates(force = false) {
  if (cache && !force && Date.now() - cache.at < 60_000) return cache.list;
  try {
    cache = { at: Date.now(), list: (await api('/api/staff/reasons')).templates };
  } catch {
    cache = { at: Date.now(), list: [] };
  }
  return cache.list;
}

export const forgetReasonTemplates = () => {
  cache = null;
};

/** The template <select>; call wireReasonPicker afterwards. Empty when there are no templates. */
export function reasonPickerHtml(templates, id = 'rt-pick') {
  if (!templates.length) return '';
  return `<select id="${esc(id)}" aria-label="Reason template" style="width:auto;max-width:200px"><option value="">Template…</option>${templates
    .map((t) => `<option value="${esc(t.id)}">${esc(t.name)}${t.hours ? ` (${t.hours}h)` : ''}</option>`)
    .join('')}</select>`;
}

/** Picking a template fills the reason box (and the duration box when there is one). */
export function wireReasonPicker(root, templates, { id = 'rt-pick', reason, hours } = {}) {
  const pick = root.querySelector(`#${id}`);
  if (!pick) return;
  pick.addEventListener('change', () => {
    const t = templates.find((x) => x.id === pick.value);
    if (!t) return;
    const box = typeof reason === 'string' ? root.querySelector(reason) : reason;
    if (box) box.value = [t.reason, t.appeal].filter(Boolean).join(' - ').slice(0, 200);
    const hbox = typeof hours === 'string' ? root.querySelector(hours) : hours;
    if (!hbox) return;
    // A select only has a fixed set of lengths: add this one when it is missing.
    if (t.hours && hbox.tagName === 'SELECT' && ![...hbox.options].some((o) => Number(o.value) === t.hours)) hbox.add(new Option(`${t.hours} hours`, String(t.hours)));
    hbox.value = String(t.hours || 0);
  });
}

/**
 * A ban or kick dialog with a template picker and a reason box.
 * Resolves to { reason, hours, template } or null when cancelled.
 */
export async function reasonDialog({ title, confirmLabel = 'Confirm', message = '', withHours = false, danger = true }) {
  const templates = await loadReasonTemplates();
  return new Promise((resolve) => {
    const modal = openModal({
      title: esc(title),
      width: 480,
      body: `${message ? `<p style="margin:0 0 12px;line-height:1.6">${esc(message)}</p>` : ''}
        <label><span>Reason</span><span class="row" style="gap:6px;flex-wrap:wrap"><input id="rd-reason" maxlength="200" placeholder="Reason (optional)" style="flex:1;min-width:160px" />${reasonPickerHtml(templates, 'rd-pick')}</span></label>
        ${withHours ? '<label class="mt-8"><span>Hours (0 = permanent)</span><input id="rd-hours" type="number" min="0" max="8760" value="0" /></label>' : ''}`,
      actions: [
        {
          label: 'Cancel',
          onClick: () => {
            modal.close();
            resolve(null);
          },
        },
        {
          label: confirmLabel,
          danger,
          primary: !danger,
          onClick: () => {
            const tpl = templates.find((t) => t.id === document.querySelector('#rd-pick')?.value);
            const out = { reason: document.querySelector('#rd-reason').value.trim(), hours: withHours ? Number(document.querySelector('#rd-hours').value) || 0 : undefined, template: tpl?.id };
            modal.close();
            resolve(out);
          },
        },
      ],
    });
    wireReasonPicker(document, templates, { id: 'rd-pick', reason: '#rd-reason', hours: '#rd-hours' });
  });
}
