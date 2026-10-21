import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { $, can, esc, icon, toast } from '../core/util.js';
import { FIRST_SERVER_STEPS, WHATS_NEW, progress, shouldAutoOpen, tipsFor } from './onboarding-core.js';
import { openModal } from './modal.js';
import { startTour } from './tour.js';

/* ------------------------------------------------------------- onboarding */

// The getting-started checklist (per account, kept on the server), the guided
// first-server flow, and the tips card on each server's page.

const load = () => api('/api/onboarding');
const save = (body) => api('/api/onboarding', { method: 'PUT', body });

function checklistHtml(view) {
  const p = progress(view.items);
  return `
    <div class="ob-bar" role="progressbar" aria-valuenow="${p.percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${p.percent}%"></span></div>
    <div class="faint mb-16" style="font-size:12.5px">${p.done} of ${p.total} done${p.next ? ` · next: ${esc(p.next.label)}` : ' · all set'}</div>
    <ol class="ob-list">${view.items
      .map(
        (i) => `<li class="${i.done ? 'done' : ''}">
          <span class="ob-tick">${i.done ? icon('check', 12) : ''}</span>
          <div class="ob-text"><a href="${esc(i.link)}" data-ob-go>${esc(i.label)}</a><div class="faint">${esc(i.hint)}</div></div>
          ${
            i.auto
              ? '<span class="faint ob-auto">done</span>'
              : `<button class="btn btn-sm btn-ghost" data-ob-toggle="${esc(i.id)}" data-done="${i.done ? '0' : '1'}">${i.done ? 'Undo' : 'Mark done'}</button>`
          }
        </li>`
      )
      .join('')}</ol>`;
}

/** The checklist as a dialog, with what is new and the tour buttons. */
export async function openGettingStarted() {
  let view;
  try {
    view = await load();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const modal = openModal({
    title: 'Getting started',
    width: 640,
    body: '<div id="ob-body"></div>',
    actions: [
      { label: 'Take the tour', onClick: () => { modal.close(); startTour(); } },
      ...(state.route.name === 'server' ? [{ label: 'Tour this server page', onClick: () => { modal.close(); startTour('server'); } }] : []),
      { label: 'Close', primary: true, close: true },
    ],
  });
  const body = $('#ob-body');
  const draw = () => {
    body.innerHTML = `${checklistHtml(view)}
      <h4 class="mt-16">What is new</h4>
      <ul class="ob-news">${WHATS_NEW.map((n) => `<li><b>${esc(n.title)}</b> <span class="faint">${esc(n.text)}</span></li>`).join('')}</ul>
      <div class="row mt-16" style="gap:8px">
        <label class="checkbox-row" style="margin:0"><input type="checkbox" id="ob-hide" ${view.hidden ? 'checked' : ''} /><span>Do not offer this by itself</span></label>
        <span class="spacer" style="flex:1"></span>
        <button class="btn btn-sm btn-ghost" id="ob-reset">Reset progress</button>
      </div>`;
    $('#ob-hide').addEventListener('change', async (e) => {
      view = await save({ hidden: e.target.checked }).catch(() => view);
    });
    $('#ob-reset').addEventListener('click', async () => {
      view = await api('/api/onboarding/reset', { method: 'POST', body: {} }).catch(() => view);
      draw();
    });
  };
  draw();
  save({ seenNews: view.newsId }).catch(() => {});
  body.addEventListener('click', async (event) => {
    if (event.target.closest('[data-ob-go]')) return modal.close();
    const btn = event.target.closest('[data-ob-toggle]');
    if (!btn) return;
    try {
      view = await save({ id: btn.dataset.obToggle, done: btn.dataset.done === '1' });
      draw();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/** Step by step for a panel with nothing on it yet. */
export function openFirstServerGuide() {
  let at = 0;
  const modal = openModal({ title: 'Your first server', width: 520, body: '<div id="fs-guide"></div>', actions: [] });
  const foot = $('#fs-guide').closest('.modal').querySelector('.modal-foot');
  const draw = () => {
    const step = FIRST_SERVER_STEPS[at];
    $('#fs-guide').innerHTML = `
      <div class="tour-count">${at + 1} of ${FIRST_SERVER_STEPS.length}</div>
      <h3 style="margin:4px 0 8px">${esc(step.title)}</h3>
      <p class="faint" style="line-height:1.6;margin:0">${esc(step.text)}</p>
      ${step.link ? `<p><a class="btn btn-primary" href="${esc(step.link)}" id="fs-link">${esc(step.cta)}</a></p>` : ''}`;
    foot.innerHTML = '';
    const add = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      foot.appendChild(b);
      return b;
    };
    add('Skip', 'btn-ghost', modal.close);
    if (at) add('Back', '', () => { at--; draw(); });
    const next = add(at === FIRST_SERVER_STEPS.length - 1 ? 'Done' : 'Next', 'btn-primary', () => {
      if (at === FIRST_SERVER_STEPS.length - 1) return modal.close();
      at++;
      draw();
    });
    next.focus();
    $('#fs-link')?.addEventListener('click', modal.close);
  };
  draw();
}

/** The card on the Account page: progress, and the buttons that replay everything. */
export async function renderOnboardingCard(host) {
  if (!host) return;
  let view;
  try {
    view = await load();
  } catch {
    return;
  }
  const p = progress(view.items);
  host.innerHTML = `
    <div class="card mb-16" id="onboarding">
      <h4>Getting started</h4>
      <div class="ob-bar" role="progressbar" aria-valuenow="${p.percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${p.percent}%"></span></div>
      <div class="row mt-16" style="gap:12px;align-items:center">
        <div class="faint" style="flex:1;min-width:220px">${p.done} of ${p.total} steps done${p.next ? `. Next: ${esc(p.next.label)}.` : '.'}</div>
        <button class="btn" id="ob-open">Open checklist</button>
        <button class="btn" id="ob-tour">Take the tour</button>
        ${can('deploy') ? '<button class="btn" id="ob-first">First server guide</button>' : ''}
      </div>
    </div>`;
  $('#ob-open').addEventListener('click', async () => {
    await openGettingStarted();
  });
  $('#ob-tour').addEventListener('click', () => startTour());
  $('#ob-first')?.addEventListener('click', openFirstServerGuide);
}

/** After the tour: a brand-new panel gets the first-server flow, everyone else the checklist. */
export async function offerNextSteps() {
  try {
    const view = await load();
    if (view.hidden) return;
    const servers = state.servers?.length || 0;
    if (!servers && can('deploy')) return openFirstServerGuide();
    if (shouldAutoOpen(view)) openGettingStarted();
  } catch {
    /* nothing to offer */
  }
}
document.addEventListener('gp:tour-done', () => setTimeout(offerNextSteps, 300));

/* --------------------------------------------------------------- server tips */

const tipsKey = (templateId) => `gp-tips-${templateId}`;

function tipsSeen(templateId) {
  try {
    return localStorage.getItem(tipsKey(templateId)) === '1';
  } catch {
    return true;
  }
}

function tipsHtml(server) {
  const g = tipsFor(server.templateId);
  return `<div class="card ob-tips mb-16" id="srv-tips">
    <div class="row" style="gap:8px"><h4 style="margin:0;flex:1">Tips for ${esc(g.title)}</h4><button class="btn btn-sm btn-ghost" data-tips-close>Got it</button></div>
    <ul>${g.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
  </div>`;
}

/** A Tips button next to the server's badges, and the tips open by themselves the first time for each game. */
export function mountServerTips(server) {
  const meta = $('.srv-header .meta');
  const tabs = $('.tabs');
  if (!meta || !tabs || $('#srv-tips-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'srv-tips-btn';
  btn.type = 'button';
  btn.className = 'btn btn-sm btn-ghost';
  btn.textContent = 'Tips';
  meta.appendChild(btn);
  const show = () => {
    if ($('#srv-tips')) return;
    tabs.insertAdjacentHTML('beforebegin', tipsHtml(server));
    $('#srv-tips [data-tips-close]').addEventListener('click', () => {
      $('#srv-tips')?.remove();
      try {
        localStorage.setItem(tipsKey(server.templateId), '1');
      } catch {
        /* private mode */
      }
      btn.focus();
    });
  };
  btn.addEventListener('click', () => ($('#srv-tips') ? $('#srv-tips').remove() : show()));
  if (!tipsSeen(server.templateId) && ['running', 'starting', 'installing', 'offline', 'stopped'].includes(server.status)) show();
}
