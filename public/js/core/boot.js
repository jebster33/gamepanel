import { api } from './api.js';
import { connectWebSocket } from './live.js';
import { handleRoute } from './router.js';
import { state } from './state.js';
import { $, $$, can } from './util.js';
import { renderSidebarServers, setBridgeNav } from '../ui/sidebar.js';

/* ------------------------------------------------------------------ auth */

export function showAuth(setupRequired = false) {
  $('#app').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  $('#auth-form').classList.remove('hidden');
  $('#otp-form').classList.add('hidden');
  $('#auth-confirm-wrap').classList.toggle('hidden', !setupRequired);
  $('#auth-title').textContent = setupRequired ? 'Set up your panel' : 'Welcome back';
  $('#auth-subtitle').textContent = setupRequired
    ? 'Create the first administrator account'
    : 'Sign in to manage your game servers';
  $('#auth-submit').textContent = setupRequired ? 'Create account' : 'Sign in';
  $('#auth-password').autocomplete = setupRequired ? 'new-password' : 'current-password';
  $('#auth-form').dataset.mode = setupRequired ? 'setup' : 'login';
  $('#auth-username').focus();
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
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));

  // Hide navigation the account cannot use at all, so nothing dead-ends in a
  // permission error.
  $$('[data-needs]').forEach((el) => el.classList.toggle('hidden', !can(el.dataset.needs)));

  // Restricted accounts may not be allowed every one of these; a refused
  // request must not stop the panel from loading.
  await Promise.allSettled([loadServers(), loadTemplates(), loadSystem()]);
  setBridgeNav(state.bridgeEnabled);
  connectWebSocket();
  renderSidebarServers();
  handleRoute();
}

export async function loadServers() {
  const data = await api('/api/servers');
  state.servers = data.servers;
}

export async function loadTemplates() {
  if (!can('templates')) {
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
