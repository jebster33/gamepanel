import { api } from './api.js';
import { passkeysSupported } from './passkey.js';
import { connectWebSocket } from './live.js';
import { handleRoute } from './router.js';
import { state } from './state.js';
import { $, $$, can, esc } from './util.js';
import { initNotifications } from '../ui/notifications.js';
import { maybeStartTour } from '../ui/tour.js';
import { renderSidebarServers, setBridgeNav } from '../ui/sidebar.js';

/* ------------------------------------------------------------------ auth */

export function showAuth(setupRequired = false) {
  $('#app').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  $('#auth-form').classList.remove('hidden');
  $('#otp-form').classList.add('hidden');
  $('#auth-confirm-wrap').classList.toggle('hidden', !setupRequired);
  $('#auth-code-wrap').classList.toggle('hidden', !setupRequired);
  $('#auth-title').textContent = setupRequired ? 'Set up your panel' : 'Welcome back';
  $('#auth-subtitle').textContent = setupRequired
    ? 'Create the first administrator account'
    : 'Sign in to manage your game servers';
  $('#auth-submit').textContent = setupRequired ? 'Create account' : 'Sign in';
  $('#auth-password').autocomplete = setupRequired ? 'new-password' : 'current-password';
  $('#auth-form').dataset.mode = setupRequired ? 'setup' : 'login';
  $('#auth-username').focus();
  showOauthButtons(!setupRequired);
}

/** "Sign in with Discord" and friends, for the providers an administrator set up. */
async function showOauthButtons(show) {
  const box = $('#oauth-buttons');
  if (!box) return;
  const data = show ? await api('/api/auth/oauth/providers').catch(() => null) : null;
  const providers = data?.providers || [];
  const passkey = show && passkeysSupported();
  box.classList.toggle('hidden', !providers.length && !passkey);
  box.innerHTML =
    providers.length || passkey
      ? `<div class="oauth-or"><span>or</span></div>${passkey ? '<button type="button" class="btn btn-block oauth-btn" data-passkey-signin>Sign in with a passkey</button>' : ''}${providers
          .map((p) => `<a class="btn btn-block oauth-btn oauth-${esc(p.id)}" href="/api/auth/oauth/${encodeURIComponent(p.id)}/start">Sign in with ${esc(p.label)}</a>`)
          .join('')}`
      : '';
}

export async function bootstrap() {
  const status = await api('/api/status');
  $('#brand-name').textContent = status.panelName || 'GamePanel';
  document.title = status.panelName || 'GamePanel';

  if (status.setupRequired) return showAuth(true);

  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    await enterApp();
  } catch {
    showAuth(false);
  }
}

export async function enterApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');

  $('#user-name').textContent = state.user.username;
  $('#user-role').textContent = state.user.role;
  $('#user-avatar').textContent = state.user.username.slice(0, 1).toUpperCase();
  const isAdmin = state.user.role === 'admin';
  loadNodes();
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));

  // Hide navigation the account cannot use at all, so nothing dead-ends in a
  // permission error.
  $$('[data-needs]').forEach((el) => el.classList.toggle('hidden', !el.dataset.needs.split('|').some((cap) => can(cap))));
  // Self-service accounts deploy their own servers.
  $('#new-server-btn').classList.toggle('hidden', !can('deploy'));

  // Restricted accounts may not be allowed every one of these; a refused
  // request must not stop the panel from loading.
  await Promise.allSettled([loadServers(), loadTemplates(), loadSystem()]);
  setBridgeNav(state.bridgeEnabled);
  connectWebSocket();
  initNotifications();
  renderSidebarServers();
  handleRoute();
  maybeStartTour();
}

/** Other machines this panel controls (administrators only). */
export async function loadNodes() {
  if (state.user?.role !== 'admin') return;
  state.nodes = await api('/api/nodes').catch(() => null);
}

export async function loadServers() {
  const data = await api('/api/servers');
  state.servers = data.servers;
}

export async function loadTemplates() {
  if (!can('templates') && !can('deploy')) {
    state.templates = [];
    state.categories = [];
    return;
  }
  const data = await api('/api/templates');
  state.templates = data.templates;
  state.categories = data.categories;
}

async function loadSystem() {
  const data = await api('/api/system');
  state.host = data.host;
  state.overview = data.overview;
  state.version = data.version;
  state.bridgeEnabled = Boolean(data.bridgeEnabled);
}
