import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { $, esc } from '../core/util.js';
import { PANEL_STEPS, SERVER_STEPS, pickSteps, stepAfter } from './onboarding-core.js';

/* ------------------------------------------------------------------ tour */

// A short guided tour the first time someone signs in: a highlight on one
// part of the panel at a time, with a line about it. It can be skipped, and
// started again from the Account page.

const DONE_KEY = 'gp-tour-done';

let index = 0;
let steps = [];
let track = 'panel';
let opener = null;

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !el.closest('.hidden');
}

function close(done = true) {
  $('#tour')?.remove();
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', place);
  if (done && track === 'panel') {
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* private mode */
    }
    // Remembered on the account too, so a second browser does not repeat it.
    api('/api/onboarding', { method: 'PUT', body: { tourDone: true } }).catch(() => {});
    document.dispatchEvent(new CustomEvent('gp:tour-done'));
  }
  if (opener?.isConnected) opener.focus();
  opener = null;
}

function onKey(event) {
  if (event.key === 'Escape') close();
  if (event.key === 'ArrowRight') go(1);
  if (event.key === 'ArrowLeft') go(-1);
  // Keep Tab inside the bubble while the tour is up.
  if (event.key === 'Tab') {
    const buttons = [...document.querySelectorAll('#tour-bubble button')];
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement);
    const next = event.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : at === buttons.length - 1 ? 0 : at + 1;
    event.preventDefault();
    buttons[next].focus();
  }
}

function go(delta) {
  const next = stepAfter(index, delta, steps.length);
  if (next === 'done') return close();
  if (next === index) return;
  index = next;
  draw();
}

/** Position the ring around the element and the bubble next to it. */
function place() {
  const step = steps[index];
  const target = document.querySelector(step.sel);
  const ring = $('#tour-ring');
  const bubble = $('#tour-bubble');
  if (!target || !ring || !bubble) return;
  const r = target.getBoundingClientRect();
  const pad = 6;
  Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Right of the element when there is room (the sidebar), otherwise below or above it.
  let left = r.right + 16;
  let top = r.top + r.height / 2 - bh / 2;
  if (left + bw > vw - 12) {
    left = Math.min(Math.max(12, r.left + r.width / 2 - bw / 2), vw - bw - 12);
    top = r.bottom + 14 + bh < vh ? r.bottom + 14 : r.top - bh - 14;
  }
  Object.assign(bubble.style, { left: `${left}px`, top: `${Math.min(Math.max(12, top), vh - bh - 12)}px` });
}

function draw() {
  const step = steps[index];
  document.querySelector(step.sel)?.scrollIntoView({ block: 'nearest' });
  $('#tour-bubble').innerHTML = `
    <div class="tour-count">${index + 1} of ${steps.length}</div>
    <h3>${esc(step.title)}</h3>
    <p>${esc(step.text)}</p>
    <div class="tour-actions">
      <button class="btn btn-sm btn-ghost" data-tour="skip">Skip tour</button>
      <span style="flex:1"></span>
      ${index ? '<button class="btn btn-sm" data-tour="back">Back</button>' : ''}
      <button class="btn btn-sm btn-primary" data-tour="next">${index === steps.length - 1 ? 'Done' : 'Next'}</button>
    </div>`;
  place();
  $('#tour-bubble [data-tour="next"]').focus();
}

/** track: 'panel' (the whole panel) or 'server' (the page of one server). */
export function startTour(which = 'panel') {
  close(false);
  track = which === 'server' ? 'server' : 'panel';
  opener = document.activeElement;
  // On a phone the menu is a drawer; open it so the nav steps have something to point at.
  if (window.innerWidth <= 900) {
    $('#sidebar')?.classList.add('open');
    $('#sidebar-backdrop')?.classList.add('show');
  }
  steps = pickSteps(track === 'server' ? SERVER_STEPS : PANEL_STEPS, (sel) => visible(document.querySelector(sel)));
  if (!steps.length) return;
  index = 0;
  document.body.insertAdjacentHTML('beforeend', '<div id="tour" class="tour"><div id="tour-ring" class="tour-ring"></div><div id="tour-bubble" class="tour-bubble" role="dialog" aria-live="polite" aria-label="Panel tour"></div></div>');
  $('#tour').addEventListener('click', (event) => {
    const action = event.target.closest('[data-tour]')?.dataset.tour;
    if (action === 'next') go(1);
    else if (action === 'back') go(-1);
    else if (action === 'skip') close();
  });
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', place);
  draw();
}

/** Once per account: the first time someone uses the panel. */
export async function maybeStartTour() {
  if (!state.user) return;
  let local = false;
  try {
    local = localStorage.getItem(DONE_KEY) === '1';
  } catch {
    local = true;
  }
  let remote = null;
  try {
    remote = await api('/api/onboarding');
  } catch {
    /* older server or no access: fall back to this browser */
  }
  // A browser that finished the tour before accounts tracked it counts as done, and the account learns that.
  if (remote && local && !remote.tourDone) api('/api/onboarding', { method: 'PUT', body: { tourDone: true } }).catch(() => {});
  if (remote ? remote.tourDone || local : local) return;
  setTimeout(startTour, 900);
}
