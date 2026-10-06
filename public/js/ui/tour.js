import { state } from '../core/state.js';
import { $, esc } from '../core/util.js';

/* ------------------------------------------------------------------ tour */

// A short guided tour the first time someone signs in: a highlight on one
// part of the panel at a time, with a line about it. It can be skipped, and
// started again from the Account page.

const DONE_KEY = 'gp-tour-done';

const STEPS = [
  { sel: '#nav [data-page="dashboard"]', title: 'Dashboard', text: 'How the machine is doing, every server at a glance, and a checklist for a fresh panel.' },
  { sel: '#nav [data-page="templates"]', title: 'Games', text: 'Pick a game here. The panel downloads it, gives it free ports and starts it, usually within a few minutes.' },
  { sel: '#sidebar-server-list', title: 'Your servers', text: 'Each server has its console, players, files, mods, backups and schedules on its own page.' },
  { sel: '#bell-btn', title: 'Notifications', text: 'Crashes, finished installs, backups and sign-ins show up here, with a pop-up for the important ones.' },
  { sel: '#nav [data-page="users"]', title: 'Users', text: 'Give friends an account with exactly the servers and permissions you choose, or let them create their own servers within a quota.' },
  { sel: '#nav [data-page="settings"]', title: 'Settings', text: 'Alerts to Discord, cloud backups, the public server list, limits and panel updates.' },
  { sel: '.user-link', title: 'Your account', text: 'Turn on two-factor sign-in here, pick a language, and take this tour again any time.' },
];

let index = 0;
let steps = [];

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !el.closest('.hidden');
}

function close(done = true) {
  $('#tour')?.remove();
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', place);
  if (done) {
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* private mode */
    }
  }
}

function onKey(event) {
  if (event.key === 'Escape') close();
  if (event.key === 'ArrowRight') go(1);
  if (event.key === 'ArrowLeft') go(-1);
}

function go(delta) {
  const next = index + delta;
  if (next < 0) return;
  if (next >= steps.length) return close();
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

export function startTour() {
  close(false);
  // On a phone the menu is a drawer; open it so the nav steps have something to point at.
  if (window.innerWidth <= 900) {
    $('#sidebar')?.classList.add('open');
    $('#sidebar-backdrop')?.classList.add('show');
  }
  steps = STEPS.filter((s) => visible(document.querySelector(s.sel)));
  if (!steps.length) return;
  index = 0;
  document.body.insertAdjacentHTML('beforeend', '<div id="tour" class="tour"><div id="tour-ring" class="tour-ring"></div><div id="tour-bubble" class="tour-bubble" role="dialog" aria-live="polite"></div></div>');
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

/** Once, the first time someone uses the panel in this browser. */
export function maybeStartTour() {
  let done = false;
  try {
    done = localStorage.getItem(DONE_KEY) === '1';
  } catch {
    done = true;
  }
  if (done || !state.user) return;
  setTimeout(startTour, 900);
}
