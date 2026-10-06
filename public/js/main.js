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
import { startTranslating } from './core/i18n.js';
import { handleRoute } from './core/router.js';
import { state } from './core/state.js';
import { $, esc, toast } from './core/util.js';
import { drawHostCharts } from './pages/dashboard.js';
import { openImportModal } from './pages/deploy.js';
import { drawServerCharts } from './pages/server/metrics.js';
import { copyToClipboard } from './ui/clipboard.js';
import { wireOtp } from './ui/otp.js';
import { closeSidebar } from './ui/sidebar.js';
import { applyTheme } from './ui/theme.js';
import { signInWithPasskey } from './core/passkey.js';

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

  if (event.target.closest('[data-import]')) return openImportModal();

  const copy = event.target.closest('[data-copy]');
  if (copy) copyToClipboard(copy.dataset.copy, copy);
});


document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-passkey-signin]');
  if (!btn) return;
  const error = $('#auth-error');
  error.classList.add('hidden');
  btn.disabled = true;
  try {
    const data = await signInWithPasskey();
    if (data.twoFactor) return showOtpStep(data.ticket);
    state.user = data.user;
    await enterApp();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
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
      await api('/api/setup', { method: 'POST', body: { username, password, setupCode: $('#auth-code').value } });
    }
    const data = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    $('#auth-password').value = '';
    if (data.twoFactor) return showOtpStep(data.ticket);
    state.user = data.user;
    await enterApp();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
});

/* ------------------------------------------------- two-factor sign-in */

let otpTicket = null;

async function submitSecondFactor(code) {
  const error = $('#otp-error');
  error.classList.add('hidden');
  try {
    const data = await api('/api/auth/login/2fa', { method: 'POST', body: { ticket: otpTicket, code } });
    state.user = data.user;
    return data;
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
    // The ticket ran out: back to the password.
    if (/took too long/.test(err.message)) setTimeout(hideOtpStep, 1600);
    return null;
  }
}

const otp = wireOtp($('#otp-form'), async (code) => {
  const data = await submitSecondFactor(code);
  if (!data) return false;
  $('#auth-subtitle').textContent = 'Verified. Signing you in…';
  await otp.success();
  finishOtp(data);
  return true;
});

async function finishOtp(data) {
  hideOtpStep();
  await enterApp();
  if (data.usedRecoveryCode) toast(`Recovery code used. ${data.recoveryCodesLeft} left. Make new ones under Account.`, 'warn', 10000);
}

function showOtpStep(ticket) {
  otpTicket = ticket;
  otp.reset();
  setOtpMode('app');
  $('#auth-form').classList.add('hidden');
  $('#otp-form').classList.remove('hidden');
  $('#auth-title').textContent = 'Two-step verification';
  $('#auth-subtitle').textContent = 'Enter the 6-digit code from your authenticator app';
  otp.focus();
}

function hideOtpStep() {
  otpTicket = null;
  $('#otp-form').classList.add('hidden');
  $('#otp-error').classList.add('hidden');
  $('#auth-form').classList.remove('hidden');
  $('#auth-title').textContent = 'Welcome back';
  $('#auth-subtitle').textContent = 'Sign in to manage your game servers';
}

function setOtpMode(mode) {
  document.querySelectorAll('[data-otp-mode]').forEach((el) => el.classList.toggle('active', el.dataset.otpMode === mode));
  document.querySelectorAll('#otp-form [data-otp-pane]').forEach((el) => el.classList.toggle('hidden', el.dataset.otpPane !== mode));
  $('#auth-subtitle').textContent = mode === 'app' ? 'Enter the 6-digit code from your authenticator app' : 'Enter one of the recovery codes you saved';
  if (mode === 'app') otp.focus();
  else $('#otp-recovery').focus();
}

document.querySelectorAll('[data-otp-mode]').forEach((el) => el.addEventListener('click', () => setOtpMode(el.dataset.otpMode)));
$('#otp-back').addEventListener('click', hideOtpStep);
$('#otp-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('#otp-recovery').value.trim();
  if (!code) return;
  const data = await submitSecondFactor(code);
  if (data) {
    $('#otp-recovery').value = '';
    finishOtp(data);
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

startTranslating();

// Back from Google/Discord/GitHub: an error to show, a code step, or a freshly linked account.
const returned = new URLSearchParams(location.search);
if (returned.has('oauth_error') || returned.has('oauth2fa') || returned.has('oauth_linked')) history.replaceState(null, '', `/${location.hash}`);

bootstrap()
  .then(() => {
    if (returned.get('oauth2fa') && !state.user) showOtpStep(returned.get('oauth2fa'));
    if (returned.get('oauth_error')) {
      if (state.user) toast(returned.get('oauth_error'), 'error', 9000);
      else {
        $('#auth-error').textContent = returned.get('oauth_error');
        $('#auth-error').classList.remove('hidden');
      }
    }
    if (returned.get('oauth_linked') && state.user) toast(`${returned.get('oauth_linked')} linked. You can sign in with it from now on.`);
  })
  .catch((err) => {
    document.body.innerHTML = `<div class="empty"><h3>GamePanel could not start</h3><p>${esc(err.message)}</p></div>`;
  });
