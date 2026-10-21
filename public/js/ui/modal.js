import { api } from '../core/api.js';
import { $, esc, icon } from '../core/util.js';
import { reducedMotion } from './fx.js';
import { state } from '../core/state.js';

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
  const opener = document.activeElement;
  root.appendChild(backdrop);

  let closed = false;
  const api = {
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      // Keyboard users land back where they were, unless something else has taken focus meanwhile.
      if (opener?.isConnected && opener.focus && (document.activeElement === document.body || backdrop.contains(document.activeElement))) opener.focus({ preventScroll: true });
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
  const modalBox = backdrop.querySelector('.modal');
  modalBox.tabIndex = -1;
  const isTop = () => [...root.children].filter((el) => !el.inert).pop() === backdrop;
  const onKey = (event) => {
    if (!isTop()) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      api.close();
    } else if (event.key === 'Tab') {
      // Keep Tab inside the dialog.
      const items = [...modalBox.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
      if (!items.length) return event.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      if (!modalBox.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === modalBox)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', onKey);

  // Focus the first field only if it's in view, so a long modal opens at the top.
  const firstInput = backdrop.querySelector('input, textarea, select');
  const bodyBox = backdrop.querySelector('.modal-body').getBoundingClientRect();
  if (firstInput && firstInput.getBoundingClientRect().bottom <= bodyBox.bottom) firstInput.focus();
  else modalBox.focus({ preventScroll: true });
  return api;
}

/**
 * Yes/no. With { type: 'name' } the button stays off until that text is typed:
 * for the actions that cannot be undone.
 */
export function confirmModal(title, message, confirmLabel = 'Confirm', { type: typed = '' } = {}) {
  // Accounts with two-factor sign-in give a code instead (the API asks for it).
  const type = state.user?.twoFactor ? '' : typed;
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      width: 460,
      body: `<p style="margin:0;line-height:1.6">${esc(message)}</p>${type ? `<label class="mt-8"><span>Type <b>${esc(type)}</b> to confirm</span><input id="confirm-typed" autocomplete="off" spellcheck="false" /></label>` : ''}`,
      actions: [
        { label: 'Cancel', onClick: () => { modal.close(); resolve(false); } },
        { label: confirmLabel, danger: true, onClick: () => { modal.close(); resolve(true); } },
      ],
    });
    if (type) {
      const input = $('#confirm-typed');
      const button = [...document.querySelectorAll('.modal-backdrop:last-child .modal-foot .btn')].pop();
      button.disabled = true;
      input.addEventListener('input', () => { button.disabled = input.value.trim() !== type; });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !button.disabled) button.click();
      });
    }
  });
}

/** Asks for an authenticator code (or a recovery code) before a destructive action. Resolves the code, or null. */
export function codeModal(message) {
  return new Promise((resolve) => {
    const modal = openModal({
      title: 'Confirm with your code',
      width: 420,
      body: `<p style="margin:0 0 10px;line-height:1.6">${esc(message || 'Enter a code from your authenticator app to confirm this.')}</p><label><span>Authenticator code</span><input id="danger-code" inputmode="numeric" autocomplete="one-time-code" maxlength="20" /></label><div class="hint mt-8">A recovery code works too. One code covers the next two minutes.</div>`,
      actions: [
        { label: 'Cancel', onClick: () => { modal.close(); resolve(null); } },
        { label: 'Confirm', danger: true, onClick: () => submit() },
      ],
    });
    const input = $('#danger-code');
    const submit = () => {
      const code = input.value.trim();
      if (!code) return;
      modal.close();
      resolve(code);
    };
    input.focus();
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
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
