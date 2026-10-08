import { state } from '../core/state.js';
import { $, icon } from '../core/util.js';
import { drawHostCharts } from '../pages/dashboard.js';
import { drawServerCharts } from '../pages/server/metrics.js';

/** Crossfade the switch where the browser supports view transitions. */
export function switchTheme(theme) {
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
