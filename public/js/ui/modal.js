import { api } from '../core/api.js';
import { $, esc, icon } from '../core/util.js';
import { reducedMotion } from './fx.js';

/* ---------------------------------------------------------------- modals */

export function openModal({ title, body, actions = [], width = 620 }) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" style="width:min(${width}px,100%)">
      <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">${icon('close', 14)}</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"></div>
    </div>`;
  root.appendChild(backdrop);

  let closed = false;
  const api = {
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      if (reducedMotion || !backdrop.animate) return backdrop.remove();
      // Fade out rather than vanish. Ids go first so a modal opened right
      // after this one never finds this one's fields.
      // It also moves to the back, so ".modal-backdrop:last-child" lookups
      // keep finding the modal that is still open.
      backdrop.parentNode?.prepend(backdrop);
      backdrop.inert = true;
      backdrop.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      backdrop.style.pointerEvents = 'none';
      backdrop.querySelector('.modal').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(0.98)' }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
      backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 170, easing: 'ease-in', fill: 'forwards' }).finished.finally(() => backdrop.remove());
    },
  };

  const foot = backdrop.querySelector('.modal-foot');
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = `btn ${action.primary ? 'btn-primary' : ''} ${action.danger ? 'btn-danger' : ''}`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => (action.close ? api.close() : action.onClick?.(btn, api)));
    foot.appendChild(btn);
  }

  backdrop.querySelector('[data-close]').addEventListener('click', api.close);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) api.close();
  });
  const onKey = (event) => {
    if (event.key === 'Escape') api.close();
  };
  document.addEventListener('keydown', onKey);

  // Focus the first field only if it's in view, so a long modal opens at the top.
  const firstInput = backdrop.querySelector('input, textarea, select');
  const bodyBox = backdrop.querySelector('.modal-body').getBoundingClientRect();
  if (firstInput && firstInput.getBoundingClientRect().bottom <= bodyBox.bottom) firstInput.focus();
  return api;
}

export function confirmModal(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      width: 460,
      body: `<p style="margin:0;line-height:1.6">${esc(message)}</p>`,
      actions: [
        { label: 'Cancel', onClick: () => { modal.close(); resolve(false); } },
        { label: confirmLabel, danger: true, onClick: () => { modal.close(); resolve(true); } },
      ],
    });
  });
}

export function promptModal(title, label, value = '', { type = 'text', hint = '' } = {}) {
  return new Promise((resolve) => {
    // Passwords keep their spaces; everything else is trimmed.
    const read = () => (type === 'password' ? $('#prompt-input').value : $('#prompt-input').value.trim());
    const modal = openModal({
      title,
      width: 440,
      body: `<label><span>${esc(label)}</span><input id="prompt-input" type="${esc(type)}" value="${esc(value)}" ${type === 'password' ? 'autocomplete="current-password"' : ''} /></label>${hint ? `<div class="hint mt-8">${esc(hint)}</div>` : ''}`,
      actions: [
        { label: 'Cancel', onClick: () => { modal.close(); resolve(null); } },
        {
          label: 'OK',
          primary: true,
          onClick: () => {
            const result = read();
            modal.close();
            resolve(result || null);
          },
        },
      ],
    });
    $('#prompt-input')?.focus();
    $('#prompt-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const result = read();
        modal.close();
        resolve(result || null);
      }
    });
  });
}
