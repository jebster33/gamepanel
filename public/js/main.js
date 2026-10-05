/*
 * GamePanel dashboard: plain ES modules, no build step.
 *
 *   core/    state, API calls, live updates, router, formatting helpers
 *   ui/      shell pieces shared by every page (modal, sidebar, theme)
 *   pages/   one file per page; pages/server/ holds the server tabs
 *
 * This file wires the global handlers and starts the app.
 */
import { api } from './core/api.js';
import { bootstrap, enterApp } from './core/boot.js';
import { handleRoute } from './core/router.js';
import { state } from './core/state.js';
import { $, esc, toast } from './core/util.js';
import { drawHostCharts } from './pages/dashboard.js';
import { drawServerCharts } from './pages/server/metrics.js';
import { copyToClipboard } from './ui/clipboard.js';
import { closeSidebar } from './ui/sidebar.js';
import { applyTheme } from './ui/theme.js';

/* ------------------------------------------------------- global handlers */

document.addEventListener('click', async (event) => {
  const powerBtn = event.target.closest('[data-power]');
  if (powerBtn) {
    const { power, id } = powerBtn.dataset;
    powerBtn.disabled = true;
    try {
      await api(`/api/servers/${id}/power`, { method: 'POST', body: { action: power } });
      toast(`${power[0].toUpperCase() + power.slice(1)} requested`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setTimeout(() => (powerBtn.disabled = false), 1200);
    }
    return;
  }

  const copy = event.target.closest('[data-copy]');
  if (copy) copyToClipboard(copy.dataset.copy, copy);
});


$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const mode = event.currentTarget.dataset.mode;
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const error = $('#auth-error');
  error.classList.add('hidden');

  try {
    if (mode === 'setup') {
      if (password !== $('#auth-confirm').value) throw new Error('Passwords do not match');
      await api('/api/setup', { method: 'POST', body: { username, password } });
    }
    const data = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    state.user = data.user;
    $('#auth-password').value = '';
    await enterApp();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  state.ws?.close();
  location.reload();
});

$('#new-server-btn').addEventListener('click', () => {
  location.hash = '#/templates';
});

/* ----------------------------------------------------------------- theme */


$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
});

applyTheme(localStorage.getItem('gp-theme') || 'dark');

$('#menu-btn').addEventListener('click', () => {
  $('#sidebar').classList.add('open');
  $('#sidebar-backdrop').classList.add('show');
});
$('#sidebar-close').addEventListener('click', closeSidebar);
$('#sidebar-backdrop').addEventListener('click', closeSidebar);


window.addEventListener('hashchange', handleRoute);
window.addEventListener('resize', () => {
  if (state.route.name === 'dashboard') drawHostCharts();
  if (state.route.name === 'server' && state.route.params.tab === 'metrics') drawServerCharts(state.route.params.id);
});

bootstrap().catch((err) => {
  document.body.innerHTML = `<div class="empty"><h3>GamePanel could not start</h3><p>${esc(
    err.message
  )}</p></div>`;
});
