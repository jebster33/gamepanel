import { showAuth } from './boot.js';
import { $ } from './util.js';

/* ------------------------------------------------------------------- api */

export async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (options.confirmCode) init.headers['X-Confirm-Code'] = options.confirmCode;
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    // The browser's own text ("Failed to fetch") says nothing a person can act on.
    throw new Error(navigator.onLine === false ? 'You are offline. Check your connection and try again.' : 'Cannot reach the panel. It may be restarting. Try again in a moment.');
  }
  if (res.status === 401 && !path.includes('/auth/login') && !path.includes('/status')) {
    showAuth();
    throw new Error('Session expired — please sign in again');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  // The panel requires two-factor for admins and this one has none yet: send them to set it up.
  if (res.status === 403 && /Two-factor sign-in is required/.test(data?.error || '') && location.hash !== '#/account') location.hash = '#/account';
  // Wipes, deletes and rollbacks ask accounts with two-factor sign-in for an authenticator code, then try again.
  if (res.status === 403 && data?.confirmRequired) {
    const { codeModal } = await import('../ui/modal.js');
    const code = await codeModal(data.error);
    if (code) return api(path, { ...options, confirmCode: code });
    throw new Error('Cancelled');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
