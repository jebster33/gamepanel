import { state } from '../core/state.js';
import { $, icon } from '../core/util.js';
import { drawHostCharts } from '../pages/dashboard.js';
import { drawServerCharts } from '../pages/server/metrics.js';

/** Crossfade the switch where the browser supports view transitions. */
export function switchTheme(theme) {
  // The dark/light toggle goes back to the plain panel look: it drops a picked theme.
  if (document.documentElement.hasAttribute('data-ext-theme')) {
    clearExtTheme();
    fetch('/api/account/theme', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{"theme":""}' }).catch(() => {});
  }
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || calm) return applyTheme(theme);
  document.startViewTransition(() => applyTheme(theme));
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('gp-theme', theme);
  const el = $('#theme-icon');
  if (el) el.outerHTML = icon(theme === 'dark' ? 'moon' : 'sun', 15).replace('<svg', '<svg id="theme-icon"');
  // Canvas charts are painted, not styled — redraw them for the new palette.
  if (state.route.name === 'dashboard') drawHostCharts();
  if (state.route.name === 'server' && state.route.params.tab === 'metrics') drawServerCharts(state.route.params.id);
}

const EXT_KEY = 'gp-ext-theme';

/** A theme from an extension ({id, mode, css}): its CSS variables sit on top of the dark or light base. */
export function applyExtTheme(theme) {
  if (!theme) return clearExtTheme();
  let style = document.getElementById('gp-ext-theme-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'gp-ext-theme-style';
    document.head.appendChild(style);
  }
  style.textContent = theme.css;
  document.documentElement.setAttribute('data-ext-theme', theme.id);
  try {
    localStorage.setItem(EXT_KEY, JSON.stringify(theme));
  } catch {
    /* private mode */
  }
  applyTheme(theme.mode);
}

export function clearExtTheme() {
  document.getElementById('gp-ext-theme-style')?.remove();
  document.documentElement.removeAttribute('data-ext-theme');
  try {
    localStorage.removeItem(EXT_KEY);
  } catch {
    /* private mode */
  }
}
