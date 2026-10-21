import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, toast } from '../core/util.js';
import { applyExtTheme, clearExtTheme } from './theme.js';

/* ------------------------------------------------------------ extensions */

// Themes, extra pages and dashboard widgets from installed extensions.
// Pages and widgets live in sandboxed iframes; the only way out is the small
// read-only bridge below.

const THEME_VARS = ['--bg', '--surface', '--raised', '--border', '--text', '--muted', '--lime', '--lime-ink', '--amber', '--red', '--blue'];

export async function loadExtensions() {
  const data = await api('/api/extensions/active');
  state.ext = data;
  // The account's theme from the server wins over whatever this browser cached.
  const have = document.documentElement.getAttribute('data-ext-theme') || '';
  if ((data.current?.id || '') !== have) {
    if (data.current) applyExtTheme(data.current);
    else if (have) clearExtTheme();
  }
  renderExtNav();
}

function renderExtNav() {
  const nav = $('#nav-ext');
  if (!nav) return;
  const pages = state.ext?.pages || [];
  nav.innerHTML = pages
    .map((p) => `<a class="nav-item" href="#/x/${esc(p.ext)}/${esc(p.id)}" data-page="ext" data-key="${esc(p.ext)}/${esc(p.id)}">${esc(p.title)}</a>`)
    .join('');
}

/* ---------------------------------------------------------------- bridge */

const servers = () => (state.servers || []).map((s) => ({ id: s.id, name: s.name, status: s.status, players: s.players ?? s.playerList?.length ?? 0, game: s.templateId || null }));

const METHODS = {
  'theme.get': () => ({ mode: document.documentElement.getAttribute('data-theme'), vars: themeVars() }),
  'user.me': () => ({ username: state.user?.username, role: state.user?.role }),
  'servers.list': (params, scopes) => (scopes.includes('servers') ? { servers: servers() } : denied('servers')),
  'server.get': (params, scopes) => {
    if (!scopes.includes('servers')) return denied('servers');
    const s = servers().find((x) => x.id === String(params.id));
    if (!s) throw new Error('No such server');
    return s;
  },
  'host.get': (params, scopes) => {
    if (!scopes.includes('host')) return denied('host');
    const h = state.host;
    return h ? { cpuPercent: h.cpu.percent, memoryUsed: h.memory.used, memoryTotal: h.memory.total, diskUsed: h.disk.used, diskTotal: h.disk.total } : null;
  },
};
function denied(scope) {
  throw new Error(`This extension did not ask for "${scope}" in its manifest`);
}

function themeVars() {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(THEME_VARS.map((v) => [v, style.getPropertyValue(v).trim()]));
}

/** An iframe for a page or widget, wired to the bridge. */
function mountFrame(container, item, { height } = {}) {
  const frame = document.createElement('iframe');
  // No allow-same-origin: the page gets an opaque origin, with no cookies and no access to the panel.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = item.title;
  frame.className = 'ext-frame';
  frame.style.cssText = `width:100%;border:0;border-radius:var(--radius);background:transparent;height:${height ? `${Number(height)}px` : 'calc(100vh - 190px)'};min-height:${height ? 0 : 320}px`;
  const sendTheme = () => frame.contentWindow?.postMessage({ gp: 1, event: 'theme', mode: document.documentElement.getAttribute('data-theme'), vars: themeVars() }, '*');
  const onMessage = async (event) => {
    if (!frame.isConnected) return window.removeEventListener('message', onMessage);
    if (event.source !== frame.contentWindow) return;
    const m = event.data;
    if (!m || m.gp !== 1) return;
    if (m.event === 'ready') return sendTheme();
    if (typeof m.id !== 'number' || typeof m.method !== 'string') return;
    const reply = { gp: 1, id: m.id };
    try {
      const fn = Object.hasOwn(METHODS, m.method) ? METHODS[m.method] : null;
      if (!fn) throw new Error('Unknown method');
      reply.result = await fn(m.params && typeof m.params === 'object' ? m.params : {}, item.api || []);
    } catch (err) {
      reply.error = err.message;
    }
    frame.contentWindow?.postMessage(reply, '*');
  };
  window.addEventListener('message', onMessage);
  frame.addEventListener('load', sendTheme);
  frame.src = item.src;
  container.appendChild(frame);
}

export function renderExtPage(view) {
  const { ext, page } = state.route.params;
  const item = (state.ext?.pages || []).find((p) => p.ext === ext && p.id === page);
  setCrumbs(item?.title || 'Extension');
  document.querySelectorAll('#nav-ext .nav-item').forEach((a) => a.classList.toggle('active', a.dataset.key === `${ext}/${page}`));
  if (!item) {
    view.innerHTML = '<div class="empty"><h3>Page not found</h3><p>That extension page is not installed or is turned off.</p></div>';
    return;
  }
  view.innerHTML = `<div class="page-head"><h1>${esc(item.title)}</h1></div><div id="ext-host"></div>`;
  mountFrame($('#ext-host'), item);
}

export function renderExtWidgets(box) {
  if (!box) return;
  const widgets = state.ext?.widgets || [];
  if (!widgets.length) return;
  box.innerHTML = '<div class="ext-widgets" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:16px"></div>';
  const grid = box.firstElementChild;
  for (const w of widgets) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '0';
    card.style.overflow = 'hidden';
    grid.appendChild(card);
    mountFrame(card, w, { height: w.height });
  }
}

/* ----------------------------------------------------------- theme picker */

export function renderThemePicker(el) {
  if (!el) return;
  const themes = state.ext?.themes || [];
  const selected = state.ext?.selected || '';
  const swatch = (colors) => `<span style="display:flex;height:34px;border-radius:6px;overflow:hidden;border:1px solid var(--border-strong)"><i style="flex:2;background:${esc(colors[0])}"></i><i style="flex:2;background:${esc(colors[1])}"></i><i style="flex:1;background:${esc(colors[2])}"></i></span>`;
  el.innerHTML = `
    <h4>Appearance</h4>
    <p class="faint" style="margin:0 0 12px">Pick a colour theme for your account. It follows you to other devices. The moon/sun button in the top bar goes back to the plain dark or light look.</p>
    <div class="theme-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px">
      ${themes
        .map(
          (t) => `<button type="button" class="theme-opt ${t.id === selected ? 'active' : ''}" data-theme-id="${esc(t.id)}" title="${esc(t.extension)}" style="text-align:left;padding:8px;border:1px solid ${t.id === selected ? 'var(--lime)' : 'var(--border)'};border-radius:var(--radius);background:var(--raised);color:var(--text);cursor:pointer">
            ${swatch(t.swatch)}<span style="display:block;margin-top:6px;font-size:12px">${esc(t.name)}${t.id === selected ? ' (current)' : ''}</span></button>`
        )
        .join('')}
    </div>
    ${themes.length ? '' : '<div class="faint">No themes are installed.</div>'}`;
  el.querySelectorAll('[data-theme-id]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        const data = await api('/api/account/theme', { method: 'PUT', body: { theme: btn.dataset.themeId } });
        state.ext.selected = data.theme;
        applyExtTheme(data.current);
        renderThemePicker(el);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}
