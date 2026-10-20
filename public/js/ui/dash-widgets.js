import { state } from '../core/state.js';
import { $, esc } from '../core/util.js';
import { pinnedServers, prefs, savePrefs } from './ux-prefs.js';

/* ------------------------------------------------------ dashboard layout */

/**
 * The dashboard is a stack of widgets (<section data-widget="id">). Each
 * account can reorder and hide them. Every action works with buttons as well
 * as drag and drop, so the layout can be changed with the keyboard alone.
 */

export const WIDGET_LABELS = { host: 'Host metrics', counts: 'Server counts', capacity: 'Capacity', pinned: 'Pinned servers', servers: 'Servers' };
const DEFAULT_ORDER = ['host', 'counts', 'capacity', 'pinned', 'servers'];

let editing = false;
let announce = '';

/** Whether the pinned widget has something to show (so the main list can skip those servers). */
export function pinnedWidgetShown() {
  return !prefs().widgets.hidden.includes('pinned') && pinnedServers().length > 0;
}

function currentOrder(present) {
  const saved = prefs().widgets.order.filter((id) => present.includes(id));
  return [...saved, ...DEFAULT_ORDER.filter((id) => present.includes(id) && !saved.includes(id))];
}

function save(order, hidden) {
  return savePrefs({ widgets: { order, hidden } });
}

/** Call after the dashboard markup is in place. */
export function decorateWidgets(view) {
  const box = $('#ux-widgets', view);
  if (!box) return;
  const sections = [...box.querySelectorAll(':scope > [data-widget]')].filter((s) => !(s.dataset.widget === 'capacity' && state.user?.role !== 'admin'));
  for (const s of box.querySelectorAll(':scope > [data-widget]')) if (!sections.includes(s)) s.remove();
  const present = sections.map((s) => s.dataset.widget);
  const order = currentOrder(present);
  const hidden = prefs().widgets.hidden;
  for (const id of order) box.appendChild(sections.find((s) => s.dataset.widget === id));

  for (const [i, id] of order.entries()) {
    const sec = sections.find((s) => s.dataset.widget === id);
    const isHidden = hidden.includes(id);
    sec.classList.toggle('ux-hidden', isHidden && !editing);
    sec.classList.toggle('ux-off', isHidden && editing);
    sec.classList.toggle('ux-editing', editing);
    sec.querySelector(':scope > .ux-wctl')?.remove();
    if (!editing) continue;
    const name = WIDGET_LABELS[id] || id;
    const ctl = document.createElement('div');
    ctl.className = 'ux-wctl';
    ctl.innerHTML = `<span class="ux-grip" aria-hidden="true" title="Drag to move">⠿</span><b>${esc(name)}</b>${isHidden ? '<span class="faint">hidden</span>' : ''}
      <span style="flex:1"></span>
      <button class="btn btn-sm" data-ux-move="left" data-w="${id}" aria-label="Move ${esc(name)} up" ${i === 0 ? 'disabled' : ''}>↑ Move up</button>
      <button class="btn btn-sm" data-ux-move="right" data-w="${id}" aria-label="Move ${esc(name)} down" ${i === order.length - 1 ? 'disabled' : ''}>↓ Move down</button>
      <button class="btn btn-sm" data-ux-hide="${id}" aria-pressed="${isHidden}" aria-label="${isHidden ? 'Show' : 'Hide'} ${esc(name)}">${isHidden ? 'Show' : 'Hide'}</button>`;
    sec.prepend(ctl);
    sec.draggable = true;
    sec.dataset.dragId = id;
  }
  if (!editing) for (const s of sections) s.draggable = false;

  // The toolbar sits above the widgets.
  view.querySelector('.ux-bar')?.remove();
  const bar = document.createElement('div');
  bar.className = 'ux-bar';
  bar.innerHTML = editing
    ? `<span class="faint">Drag a widget, or use its Move buttons. Saved to your account.</span><span style="flex:1"></span>
       <button class="btn btn-sm" data-ux-reset>Reset layout</button><button class="btn btn-sm btn-primary" data-ux-edit aria-pressed="true">Done</button>`
    : `<span style="flex:1"></span><button class="btn btn-sm btn-ghost" data-ux-edit aria-pressed="false" title="Reorder, hide or show dashboard sections">Customize</button>`;
  box.before(bar);
  let live = $('#ux-live');
  if (!live) {
    live = document.createElement('div');
    live.id = 'ux-live';
    live.className = 'sr-only';
    live.setAttribute('aria-live', 'polite');
    bar.after(live);
  }
  live.textContent = announce;
  announce = '';
}

function redraw(focusSel) {
  const view = $('#view');
  decorateWidgets(view);
  if (focusSel) {
    const el = view.querySelector(focusSel);
    (el && !el.disabled ? el : view.querySelector('[data-ux-edit]'))?.focus();
  }
}

function layout() {
  const box = $('#ux-widgets');
  const present = [...box.querySelectorAll(':scope > [data-widget]')].map((s) => s.dataset.widget);
  return { order: currentOrder(present), hidden: [...prefs().widgets.hidden] };
}

function move(id, dir) {
  const { order, hidden } = layout();
  const i = order.indexOf(id);
  const j = dir === 'left' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  save(order, hidden);
  announce = `${WIDGET_LABELS[id]} moved to position ${j + 1} of ${order.length}`;
  redraw(`[data-ux-move="${dir}"][data-w="${id}"]`);
}

function toggleHidden(id) {
  const { order, hidden } = layout();
  const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
  save(order, next);
  announce = `${WIDGET_LABELS[id]} ${next.includes(id) ? 'hidden' : 'shown'}`;
  redraw(`[data-ux-hide="${id}"]`);
}

/** Wire the buttons and drag and drop once. */
export function initDashWidgets() {
  document.addEventListener('click', (event) => {
    const t = event.target;
    if (!$('#ux-widgets')) return;
    let el;
    if (t.closest('[data-ux-edit]')) {
      editing = !editing;
      announce = editing ? 'Customize mode on' : 'Customize mode off';
      redraw('[data-ux-edit]');
    } else if ((el = t.closest('[data-ux-move]'))) move(el.dataset.w, el.dataset.uxMove);
    else if ((el = t.closest('[data-ux-hide]'))) toggleHidden(el.dataset.uxHide);
    else if (t.closest('[data-ux-reset]')) {
      savePrefs({ widgets: { order: [], hidden: [] } });
      announce = 'Layout reset';
      redraw('[data-ux-reset]');
    }
  });

  let dragging = null;
  document.addEventListener('dragstart', (event) => {
    const sec = event.target.closest?.('[data-drag-id]');
    if (!sec || !editing) return;
    dragging = sec.dataset.dragId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragging);
    sec.classList.add('ux-dragging');
  });
  document.addEventListener('dragover', (event) => {
    if (dragging && event.target.closest?.('[data-drag-id]')) event.preventDefault();
  });
  document.addEventListener('dragend', () => {
    dragging = null;
    document.querySelectorAll('.ux-dragging').forEach((el) => el.classList.remove('ux-dragging'));
  });
  document.addEventListener('drop', (event) => {
    const over = event.target.closest?.('[data-drag-id]');
    if (!dragging || !over) return;
    event.preventDefault();
    const { order, hidden } = layout();
    const from = order.indexOf(dragging);
    const to = order.indexOf(over.dataset.dragId);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    save(order, hidden);
    announce = `${WIDGET_LABELS[dragging]} moved to position ${to + 1} of ${order.length}`;
    dragging = null;
    redraw();
  });
}
