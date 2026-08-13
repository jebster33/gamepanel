/* GamePanel dashboard — vanilla ES modules, no build step. */

/* ----------------------------------------------------------------- state */

const state = {
  user: null,
  servers: [],
  templates: [],
  categories: [],
  host: null,
  overview: null,
  route: { name: 'dashboard', params: {} },
  consoles: new Map(),
  hostHistory: { cpu: [], mem: [], net: [] },
  serverHistory: new Map(),
  ws: null,
  wsSubs: new Set(),
  consoleSeq: new Map(),
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------- utilities */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(bytes, decimals = 1) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : decimals)} ${units[i]}`;
}

function fmtRate(bytesPerSec) {
  return `${fmtBytes(bytesPerSec, 1)}/s`;
}

function fmtDuration(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABEL = {
  offline: 'Offline',
  installing: 'Installing',
  install_failed: 'Install failed',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  crashed: 'Crashed',
};

/** Does the signed-in account hold a capability? Admins always do. */
function can(capability) {
  const user = state.user;
  if (!user) return false;
  if (user.role === 'admin') return true;
  return (user.permissions || []).includes(capability);
}

function statusPill(status) {
  return `<span class="status ${esc(status)}"><span class="dot"></span>${esc(STATUS_LABEL[status] || status)}</span>`;
}

/** Small stroked icons, drawn inline so the UI stays a single file with no assets. */
const ICON_PATHS = {
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4h-4"/>',
  kill: '<path d="M18 6 6 18M6 6l12 12"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14"/>',
  upload: '<path d="M12 20V9m0 0 4 4M12 9l-4 4M5 4h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  external: '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 6 6.3L4 8M4 13a8 8 0 0 0 14 4.7l2-1.7M4 4v4h4M20 20v-4h-4"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
};

function icon(name, size = 14) {
  const path = ICON_PATHS[name];
  if (!path) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

function toast(message, kind = 'info', ttl = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 250);
  }, ttl);
}

/* ------------------------------------------------------------------- api */

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
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
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------ auth */

function showAuth(setupRequired = false) {
  $('#app').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  $('#auth-confirm-wrap').classList.toggle('hidden', !setupRequired);
  $('#auth-subtitle').textContent = setupRequired
    ? 'Create the first administrator account'
    : 'Sign in to manage your game servers';
  $('#auth-submit').textContent = setupRequired ? 'Create account' : 'Sign in';
  $('#auth-password').autocomplete = setupRequired ? 'new-password' : 'current-password';
  $('#auth-form').dataset.mode = setupRequired ? 'setup' : 'login';
  $('#auth-username').focus();
}

async function bootstrap() {
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

async function enterApp() {
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
  connectWebSocket();
  renderSidebarServers();
  handleRoute();
}

async function loadServers() {
  const data = await api('/api/servers');
  state.servers = data.servers;
}

async function loadTemplates() {
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
}

/* ------------------------------------------------------------- websocket */

function connectWebSocket() {
  if (state.ws && state.ws.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    $('#ws-status').classList.add('online');
    for (const topic of state.wsSubs) ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
  };

  ws.onclose = () => {
    $('#ws-status').classList.remove('online');
    setTimeout(connectWebSocket, 2500);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleWsMessage(msg);
  };
}

function wsSubscribe(topic) {
  state.wsSubs.add(topic);
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
}

function wsUnsubscribe(topic) {
  state.wsSubs.delete(topic);
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: 'unsubscribe', topics: [topic] }));
}

function handleWsMessage(msg) {
  switch (msg.topic) {
    case 'servers':
      state.servers = msg.servers;
      renderSidebarServers();
      if (['dashboard', 'servers'].includes(state.route.name)) render();
      if (state.route.name === 'server') patchServerHeader();
      break;

    case 'server:status': {
      const idx = state.servers.findIndex((s) => s.id === msg.serverId);
      if (idx >= 0) state.servers[idx] = msg.server;
      renderSidebarServers();
      if (['dashboard', 'servers'].includes(state.route.name)) render();
      if (state.route.name === 'server' && state.route.params.id === msg.serverId) patchServerHeader();
      break;
    }

    case 'stats':
      applyStats(msg.servers);
      break;

    case 'system':
      state.host = msg.host;
      state.overview = msg.overview;
      pushHostHistory(msg.host);
      renderHostMini();
      if (state.route.name === 'dashboard') patchDashboard();
      break;

    case 'console':
    default:
      if (String(msg.topic || '').startsWith('console:')) handleConsoleMessage(msg);
      break;
  }
}

function applyStats(list) {
  for (const stat of list) {
    const server = state.servers.find((s) => s.id === stat.id);
    if (!server) continue;
    Object.assign(server, stat);

    if (!state.serverHistory.has(stat.id)) state.serverHistory.set(stat.id, { cpu: [], mem: [], players: [], ping: [] });
    const hist = state.serverHistory.get(stat.id);
    hist.cpu.push(stat.cpu || 0);
    hist.mem.push(stat.memory || 0);
    hist.players.push(stat.players || 0);
    hist.ping.push(stat.ping || 0);
    for (const key of Object.keys(hist)) if (hist[key].length > 180) hist[key].shift();
  }
  if (['dashboard', 'servers'].includes(state.route.name)) patchServerCards();
  if (state.route.name === 'server') patchServerDetail();
  renderSidebarServers();
}

function pushHostHistory(host) {
  const h = state.hostHistory;
  h.cpu.push(host.cpu.percent);
  h.mem.push(host.memory.total ? (host.memory.used / host.memory.total) * 100 : 0);
  h.net.push((host.network.rxBytesPerSec + host.network.txBytesPerSec) / 1024);
  for (const key of Object.keys(h)) if (h[key].length > 120) h[key].shift();
}

/**
 * Some reverse proxies and corporate networks drop WebSockets. When the socket
 * is not open we fall back to polling so the dashboard never goes stale.
 */
async function pollFallback() {
  if (!state.user || state.ws?.readyState === 1) return;
  try {
    const [system, servers] = await Promise.all([api('/api/system'), api('/api/servers')]);
    state.host = system.host;
    state.overview = system.overview;
    state.servers = servers.servers;
    pushHostHistory(system.host);
    renderHostMini();
    renderSidebarServers();

    if (state.route.name === 'dashboard') patchDashboard();
    if (['dashboard', 'servers'].includes(state.route.name)) patchServerCards();
    if (state.route.name === 'server') {
      patchServerHeader();
      patchServerDetail();
      if ((state.route.params.tab || 'console') === 'console') await pollConsole(state.route.params.id);
    }
  } catch {
    /* transient network errors are expected here */
  }
}

async function pollConsole(id) {
  const data = await api(`/api/servers/${id}/console`).catch(() => null);
  if (!data) return;
  const seen = state.consoleSeq.get(id) || 0;
  const fresh = data.lines.filter((l) => l.seq > seen);
  if (fresh.length) appendConsoleLines(fresh);
}

setInterval(pollFallback, 5000);

/* ---------------------------------------------------------------- charts */

/** Accept #rrggbb or any CSS colour and return it with an alpha channel. */
function hexAlpha(color, alpha) {
  const value = String(color).trim();
  if (value.startsWith('#') && (value.length === 7 || value.length === 4)) {
    const full =
      value.length === 4 ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}` : value;
    const r = parseInt(full.slice(1, 3), 16);
    const g = parseInt(full.slice(3, 5), 16);
    const b = parseInt(full.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return value;
}

function drawChart(canvas, series, options = {}) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 120;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const data = series.filter((n) => Number.isFinite(n));
  if (data.length < 2) {
    ctx.fillStyle = 'rgba(148,163,184,.35)';
    ctx.font = '12px system-ui';
    ctx.fillText('Collecting data…', 10, height / 2);
    return;
  }

  const color = options.color || '#4ade80';
  const pad = options.pad ?? 4;
  const max = options.max ?? Math.max(...data, 1) * 1.15;
  const min = options.min ?? 0;
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (data.length - 1);
  const yFor = (v) => height - pad - ((v - min) / span) * (height - pad * 2);

  // grid
  if (options.grid !== false) {
    ctx.strokeStyle = 'rgba(148,163,184,.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  const path = new Path2D();
  data.forEach((value, i) => {
    const x = pad + i * stepX;
    const y = yFor(value);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });

  const fill = new Path2D(path);
  fill.lineTo(pad + (data.length - 1) * stepX, height);
  fill.lineTo(pad, height);
  fill.closePath();

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, hexAlpha(color, 0.22));
  gradient.addColorStop(1, hexAlpha(color, 0));
  ctx.fillStyle = gradient;
  ctx.fill(fill);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
}

/* --------------------------------------------------------------- sidebar */

function renderSidebarServers() {
  const list = $('#sidebar-server-list');
  if (!list) return;
  if (!state.servers.length) {
    list.innerHTML = '<div class="sidebar-empty">No servers yet</div>';
    return;
  }
  list.innerHTML = state.servers
    .map(
      (s) => `
      <a class="sidebar-server ${state.route.params.id === s.id ? 'active' : ''}" href="#/servers/${esc(s.id)}">
        <span class="status ${esc(s.status)}" style="padding:0;background:none"><i class="dot"></i></span>
        <span class="name">${esc(s.name)}</span>
      </a>`
    )
    .join('');
}

function renderHostMini() {
  const host = state.host;
  if (!host) return;
  const memPct = host.memory.total ? (host.memory.used / host.memory.total) * 100 : 0;
  const diskPct = host.disk.total ? (host.disk.used / host.disk.total) * 100 : 0;
  $('#host-mini').innerHTML = `
    <div class="host-mini-row"><span class="label">CPU</span>
      <div class="meter success" style="flex:1"><i style="width:${host.cpu.percent.toFixed(0)}%"></i></div>
      <span class="value">${host.cpu.percent.toFixed(0)}%</span></div>
    <div class="host-mini-row"><span class="label">RAM</span>
      <div class="meter accent" style="flex:1"><i style="width:${memPct.toFixed(0)}%"></i></div>
      <span class="value">${memPct.toFixed(0)}%</span></div>
    <div class="host-mini-row"><span class="label">Disk</span>
      <div class="meter warning" style="flex:1"><i style="width:${diskPct.toFixed(0)}%"></i></div>
      <span class="value">${diskPct.toFixed(0)}%</span></div>`;
}

/* ---------------------------------------------------------------- router */

const ROUTES = [
  { pattern: /^\/?dashboard?$/, name: 'dashboard' },
  { pattern: /^\/servers$/, name: 'servers' },
  { pattern: /^\/servers\/([^/]+)(?:\/([^/]+))?$/, name: 'server', keys: ['id', 'tab'] },
  { pattern: /^\/templates$/, name: 'templates' },
  { pattern: /^\/activity$/, name: 'activity' },
  { pattern: /^\/users$/, name: 'users' },
  { pattern: /^\/settings$/, name: 'settings' },
];

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/dashboard';
  for (const route of ROUTES) {
    const match = hash.match(route.pattern);
    if (match) {
      const params = {};
      (route.keys || []).forEach((key, i) => {
        if (match[i + 1]) params[key] = decodeURIComponent(match[i + 1]);
      });
      return { name: route.name, params };
    }
  }
  return { name: 'dashboard', params: {} };
}

function handleRoute() {
  const previous = state.route;
  state.route = parseRoute();

  if (previous.name === 'server' && previous.params.id !== state.route.params.id) {
    wsUnsubscribe(`console:${previous.params.id}`);
  }

  $$('.nav-item').forEach((el) => {
    const target = el.getAttribute('href').replace('#', '');
    const active =
      (state.route.name === 'dashboard' && target === '/dashboard') ||
      (target !== '/dashboard' && ('/' + state.route.name + 's').startsWith(target)) ||
      target === '/' + state.route.name;
    el.classList.toggle('active', Boolean(active));
  });

  closeSidebar();
  renderSidebarServers();
  render();
}

/* ----------------------------------------------------------- interactions */

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One delegated pointer listener drives every cursor spotlight: find the
 * hovered `.spot` element and hand it the pointer position as percentages.
 * Coalesced into a rAF so a fast mouse cannot outpace the compositor.
 */
let spotTarget = null;
let spotEvent = null;
let spotQueued = false;

document.addEventListener(
  'pointermove',
  (event) => {
    const el = event.target.closest?.('.spot');
    spotTarget = el;
    spotEvent = event;
    if (!el || spotQueued) return;
    spotQueued = true;
    requestAnimationFrame(() => {
      spotQueued = false;
      if (!spotTarget || !spotEvent) return;
      const rect = spotTarget.getBoundingClientRect();
      spotTarget.style.setProperty('--mx', `${((spotEvent.clientX - rect.left) / rect.width) * 100}%`);
      spotTarget.style.setProperty('--my', `${((spotEvent.clientY - rect.top) / rect.height) * 100}%`);
    });
  },
  { passive: true }
);

/** Stagger the entrance of a freshly rendered view, cheaply and once. */
function revealChildren(root, selector = ':scope > *') {
  if (reducedMotion || !root) return;
  const nodes = [...root.querySelectorAll(selector)].slice(0, 14);
  nodes.forEach((node, i) => {
    node.style.setProperty('--i', String(i));
    node.classList.remove('reveal');
    // Force a reflow so re-renders replay the animation instead of skipping it.
    void node.offsetWidth;
    node.classList.add('reveal');
  });
}

/** Count a number up on first paint — only for values that do not tick. */
function countUp(el, target, duration = 700) {
  if (!el) return;
  const end = Number(target) || 0;
  // A hidden tab never fires requestAnimationFrame, so never animate into it —
  // the value would sit at zero until the next poll.
  if (reducedMotion || end === 0 || document.hidden) {
    el.textContent = String(end);
    return;
  }
  const started = performance.now();
  let finished = false;
  const step = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    // easeOutExpo keeps the last digits from crawling
    const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
    el.textContent = String(Math.round(end * eased));
    if (progress < 1) requestAnimationFrame(step);
    else finished = true;
  };
  requestAnimationFrame(step);
  // Backstop: some environments throttle rAF to a standstill (background tab,
  // remote/offscreen rendering). Never leave the number stuck mid-count.
  setTimeout(() => {
    if (!finished) el.textContent = String(end);
  }, duration + 400);
}

/* ----------------------------------------------------------------- views */

function render() {
  const view = $('#view');
  switch (state.route.name) {
    case 'dashboard':
      renderDashboard(view);
      break;
    case 'servers':
      renderServers(view);
      break;
    case 'server':
      renderServerDetail(view);
      break;
    case 'templates':
      renderTemplates(view);
      break;
    case 'activity':
      renderActivity(view);
      break;
    case 'users':
      renderUsers(view);
      break;
    case 'settings':
      renderSettings(view);
      break;
    default:
      view.innerHTML = '<div class="empty"><h3>Page not found</h3></div>';
  }
}

function setCrumbs(html) {
  $('#crumbs').innerHTML = html;
}

/* ------------------------------------------------------------- dashboard */

function renderDashboard(view) {
  setCrumbs('Dashboard');
  const host = state.host;
  const overview = state.overview || { total: 0, running: 0, players: 0, crashes: 0 };
  const memPct = host?.memory.total ? (host.memory.used / host.memory.total) * 100 : 0;
  const diskPct = host?.disk.total ? (host.disk.used / host.disk.total) * 100 : 0;

  view.innerHTML = `
    <div class="page-head">
      <h1>Overview</h1>
      <div class="spacer"></div>
      <span class="faint mono">${esc(host?.hostname || '')} · up ${fmtDuration((host?.uptime || 0) * 1000)}</span>
    </div>

    <div class="metrics">
      <div class="tile spot">
        <div class="tile-label">CPU</div>
        <div class="tile-value" data-host="cpu">${(host?.cpu.percent ?? 0).toFixed(0)}<span class="unit">%</span></div>
        <div class="tile-sub" data-host="cpu-sub">${host?.cpu.cores ?? 0} cores · load ${(host?.load?.[0] ?? 0).toFixed(2)}</div>
        <canvas id="chart-host-cpu"></canvas>
      </div>
      <div class="tile spot">
        <div class="tile-label">Memory</div>
        <div class="tile-value" data-host="mem">${memPct.toFixed(0)}<span class="unit">%</span></div>
        <div class="tile-sub" data-host="mem-sub">${fmtBytes(host?.memory.used)} of ${fmtBytes(host?.memory.total)}</div>
        <canvas id="chart-host-mem"></canvas>
      </div>
      <div class="tile spot">
        <div class="tile-label">Network</div>
        <div class="tile-value" data-host="net" style="font-size:20px">
          ↓ ${fmtRate(host?.network.rxBytesPerSec)} · ↑ ${fmtRate(host?.network.txBytesPerSec)}
        </div>
        <div class="tile-sub">Total ${fmtBytes(host?.network.rxTotal)} in / ${fmtBytes(host?.network.txTotal)} out</div>
        <canvas id="chart-host-net"></canvas>
      </div>
      <div class="tile spot">
        <div class="tile-label">Disk</div>
        <div class="tile-value">${diskPct.toFixed(0)}<span class="unit">%</span></div>
        <div class="tile-sub">${fmtBytes(host?.disk.free)} free of ${fmtBytes(host?.disk.total)}</div>
        <div class="meter warning"><i style="width:${diskPct.toFixed(0)}%"></i></div>
      </div>
    </div>

    <div class="metrics">
      <div class="tile spot">
        <div class="tile-label">Servers online</div>
        <div class="tile-value"><span data-ov="running" data-countup="${overview.running}">0</span><span class="unit">/ ${overview.total}</span></div>
      </div>
      <div class="tile spot">
        <div class="tile-label">Players</div>
        <div class="tile-value" data-ov="players" data-countup="${overview.players}">0</div>
      </div>
      <div class="tile spot">
        <div class="tile-label">Crashes</div>
        <div class="tile-value" data-ov="crashes" data-countup="${overview.crashes}">0</div>
      </div>
      <div class="tile spot">
        <div class="tile-label">Version</div>
        <div class="tile-value" style="font-size:17px">${esc(state.version || '1.0.0')}</div>
        <div class="tile-sub">${esc(host?.platform || '')}</div>
      </div>
    </div>

    <div class="row" style="margin-bottom:10px">
      <h2 class="section-title" style="margin:0">Servers</h2>
      <div class="spacer" style="flex:1"></div>
      <a class="btn btn-sm" href="#/servers">View all</a>
    </div>
    ${renderServerCards()}`;

  drawHostCharts();
  revealChildren(view);
  view.querySelectorAll('[data-countup]').forEach((el) => countUp(el, el.dataset.countup));
}

/** Chart colours come from the stylesheet so they follow the theme. */
function themeColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function drawHostCharts() {
  const accent = themeColor('--accent', '#5e6ad2');
  drawChart($('#chart-host-cpu'), state.hostHistory.cpu, { color: accent, max: 100, grid: false, pad: 0 });
  drawChart($('#chart-host-mem'), state.hostHistory.mem, { color: accent, max: 100, grid: false, pad: 0 });
  drawChart($('#chart-host-net'), state.hostHistory.net, { color: accent, grid: false, pad: 0 });
}

function patchDashboard() {
  const host = state.host;
  const overview = state.overview;
  if (!host) return;
  const memPct = host.memory.total ? (host.memory.used / host.memory.total) * 100 : 0;
  const set = (sel, html) => {
    const el = $(sel);
    if (el) el.innerHTML = html;
  };
  set('[data-host="cpu"]', `${host.cpu.percent.toFixed(0)}<span class="unit">%</span>`);
  set('[data-host="cpu-sub"]', `${host.cpu.cores} cores · load ${(host.load?.[0] ?? 0).toFixed(2)}`);
  set('[data-host="mem"]', `${memPct.toFixed(0)}<span class="unit">%</span>`);
  set('[data-host="mem-sub"]', `${fmtBytes(host.memory.used)} of ${fmtBytes(host.memory.total)}`);
  set('[data-host="net"]', `↓ ${fmtRate(host.network.rxBytesPerSec)} · ↑ ${fmtRate(host.network.txBytesPerSec)}`);
  if (overview) {
    // The "/ total" unit lives in a sibling span, so only the number is patched.
    set('[data-ov="running"]', String(overview.running));
    set('[data-ov="players"]', String(overview.players));
    set('[data-ov="crashes"]', String(overview.crashes));
  }
  drawHostCharts();
}

/* --------------------------------------------------------- server cards */

function serverAddress(server) {
  const port = server.ports?.game ?? Object.values(server.ports || {})[0];
  return `${location.hostname}:${port}`;
}

function renderServerCards() {
  if (!state.servers.length) {
    return `<div class="empty">
      <h3>No servers yet</h3>
      <p>Pick a template and have a game server running in a couple of minutes.</p>
      <a class="btn btn-primary" href="#/templates">Browse templates</a>
    </div>`;
  }
  return `
    <div class="srv-list">
      <div class="srv-row srv-head">
        <span>Server</span>
        <span>Status</span>
        <span class="hide-sm">CPU</span>
        <span class="hide-sm">Memory</span>
        <span class="hide-md hide-sm">Players</span>
        <span class="hide-md hide-sm">Ping</span>
        <span></span>
      </div>
      ${state.servers.map(serverRow).join('')}
    </div>`;
}

function serverRow(server) {
  const memPct = server.memoryLimit ? Math.min(100, (server.memory / server.memoryLimit) * 100) : 0;
  const running = ['running', 'starting'].includes(server.status);
  return `
  <div class="srv-row spot" data-card="${esc(server.id)}">
    <a class="srv-identity" href="#/servers/${esc(server.id)}">
      <span class="srv-icon">${esc(server.templateIcon || '🎮')}</span>
      <span class="srv-name">
        <span class="title">${esc(server.name)}</span>
        <span class="sub">${esc(server.templateName)}${
          server.gameVersion ? ` · <span class="ver">${esc(server.gameVersion)}</span>` : ''
        } · ${esc(serverAddress(server))}</span>
      </span>
    </a>

    <span data-field="status">${statusPill(server.status)}</span>

    <span class="srv-metric hide-sm">
      <b data-field="cpu">${(server.cpu || 0).toFixed(0)}%</b>
    </span>

    <span class="srv-metric hide-sm">
      <b data-field="mem">${fmtBytes(server.memory)}</b>
      <span class="meter accent" style="width:52px;margin-top:5px"><i data-field="mem-bar" style="width:${memPct.toFixed(
        0
      )}%"></i></span>
    </span>

    <span class="srv-metric hide-md hide-sm" data-field="players">${
      server.players ?? '—'
    }${server.maxPlayers ? ` <span class="faint">/ ${server.maxPlayers}</span>` : ''}</span>

    <span class="srv-metric hide-md hide-sm" data-field="ping">${server.ping != null ? server.ping + ' ms' : '—'}</span>

    <span class="srv-actions">
      ${
        running
          ? `<button class="btn btn-sm btn-ghost" data-power="restart" data-id="${esc(
              server.id
            )}" title="Restart">${icon('restart')}</button>
             <button class="btn btn-sm btn-ghost btn-danger" data-power="stop" data-id="${esc(
               server.id
             )}" title="Stop">${icon('stop', 12)}</button>`
          : `<button class="btn btn-sm" data-power="start" data-id="${esc(server.id)}" ${
              ['installing', 'stopping'].includes(server.status) ? 'disabled' : ''
            }>${icon('play', 12)} Start</button>`
      }
      <a class="btn btn-sm" href="#/servers/${esc(server.id)}/console">Console</a>
    </span>
  </div>`;
}

function patchServerCards() {
  for (const server of state.servers) {
    const card = $(`[data-card="${CSS.escape(server.id)}"]`);
    if (!card) continue;
    const set = (field, html) => {
      const el = card.querySelector(`[data-field="${field}"]`);
      if (el) el.innerHTML = html;
    };
    const memPct = server.memoryLimit ? Math.min(100, (server.memory / server.memoryLimit) * 100) : 0;
    set('cpu', `${(server.cpu || 0).toFixed(0)}%`);
    set('mem', fmtBytes(server.memory));
    set(
      'players',
      `${server.players ?? '—'}${server.maxPlayers ? ` <span class="faint">/ ${server.maxPlayers}</span>` : ''}`
    );
    set('ping', server.ping != null ? `${server.ping} ms` : '—');
    const memBar = card.querySelector('[data-field="mem-bar"]');
    if (memBar) memBar.style.width = `${memPct.toFixed(0)}%`;
  }
}

function renderServers(view) {
  setCrumbs('Servers');
  setTimeout(() => revealChildren($('.srv-list'), ':scope > .srv-row'), 0);
  view.innerHTML = `
    <div class="page-head">
      <h1>Servers</h1>
      <div class="spacer"></div>
      ${state.user.role === 'admin' ? '<a class="btn btn-primary" href="#/templates">New server</a>' : ''}
    </div>
    ${renderServerCards()}`;
}

/* --------------------------------------------------------- server detail */

function serverTabs(server) {
  const allowed = (cap) => can(cap);
  return [
    ...(allowed('console') ? [['console', 'Console']] : []),
    ['metrics', 'Metrics'],
    ...(allowed('files') ? [['files', 'Files']] : []),
    ...(server.hasMods && allowed('mods') ? [['mods', 'Mods']] : []),
    ...(allowed('backups') ? [['backups', 'Backups']] : []),
    ...(allowed('settings') ? [['settings', 'Settings']] : []),
  ];
}

function currentServer() {
  return state.servers.find((s) => s.id === state.route.params.id);
}

function renderServerDetail(view) {
  const server = currentServer();
  if (!server) {
    view.innerHTML = '<div class="empty"><h3>Server not found</h3><a href="#/servers">Back to servers</a></div>';
    return;
  }
  const tab = state.route.params.tab || 'console';
  setCrumbs(`<a href="#/servers">Servers</a> <span class="sep">/</span> ${esc(server.name)}`);

  view.innerHTML = `
    <div class="page-head">
      <div class="srv-icon" style="width:34px;height:34px;font-size:17px">${esc(server.templateIcon)}</div>
      <div>
        <h1>${esc(server.name)}</h1>
        <div class="row" style="margin-top:3px">
          <span id="detail-status">${statusPill(server.status)}</span>
          <span class="address" data-copy="${esc(serverAddress(server))}">${esc(serverAddress(server))}</span>
          ${server.gameVersion ? `<span class="badge">${esc(server.gameVersion)}</span>` : ''}
          <span class="badge" title="${
            server.runtime === 'docker' ? 'Isolated in its own container' : 'Running as a plain process on the host'
          }">${server.runtime === 'docker' ? 'Container' : 'Process'}</span>
          <span class="faint" style="font-size:12px" id="detail-uptime">${
            server.status === 'running' ? 'up ' + fmtDuration(server.uptime) : ''
          }</span>
        </div>
      </div>
      <div class="spacer"></div>
      <div class="row" id="detail-power">${powerButtons(server)}</div>
    </div>

    <div class="metrics" style="grid-template-columns:repeat(auto-fit,minmax(132px,1fr))">
      <div class="tile spot" style="min-height:0;padding:11px 13px">
        <div class="tile-label">CPU</div>
        <div class="tile-value" style="font-size:17px" data-detail="cpu">${(server.cpu || 0).toFixed(1)}<span class="unit">%</span></div>
      </div>
      <div class="tile spot" style="min-height:0;padding:11px 13px">
        <div class="tile-label">Memory</div>
        <div class="tile-value" style="font-size:17px" data-detail="mem">${fmtBytes(server.memory)}<span class="unit">/ ${fmtBytes(
          server.memoryLimit
        )}</span></div>
      </div>
      <div class="tile spot" style="min-height:0;padding:11px 13px">
        <div class="tile-label">Players</div>
        <div class="tile-value" style="font-size:17px" data-detail="players">${server.players ?? '—'}<span class="unit">${
          server.maxPlayers ? '/ ' + server.maxPlayers : ''
        }</span></div>
      </div>
      <div class="tile spot" style="min-height:0;padding:11px 13px">
        <div class="tile-label">Ping</div>
        <div class="tile-value" style="font-size:17px" data-detail="ping">${
          server.ping != null ? server.ping + '<span class="unit">ms</span>' : '—'
        }</div>
      </div>
      <div class="tile spot" style="min-height:0;padding:11px 13px">
        <div class="tile-label">Connections</div>
        <div class="tile-value" style="font-size:17px" data-detail="conns">${server.connections ?? 0}</div>
      </div>
      <div class="tile spot" style="min-height:0;padding:11px 13px">
        <div class="tile-label">Network</div>
        <div class="tile-value" style="font-size:13px" data-detail="net">${
          server.runtime === 'docker'
            ? `↓ ${fmtRate(server.networkRx)}<br>↑ ${fmtRate(server.networkTx)}`
            : '<span class="faint" style="font-size:13px">host-wide only</span>'
        }</div>
      </div>
      <div class="tile spot" style="min-height:0;padding:11px 13px">
        <div class="tile-label">Disk</div>
        <div class="tile-value" style="font-size:17px" data-detail="disk">${fmtBytes(server.diskBytes)}</div>
      </div>
      <div class="tile spot" style="min-height:0;padding:11px 13px">
        <div class="tile-label">Crashes</div>
        <div class="tile-value" style="font-size:17px" data-detail="crashes">${server.crashCount || 0}</div>
      </div>
    </div>

    <div class="tabs">
      ${serverTabs(server).map(
        ([key, label]) =>
          `<a class="tab ${tab === key ? 'active' : ''}" href="#/servers/${esc(server.id)}/${key}">${label}</a>`
      ).join('')}
    </div>
    <div id="tab-content"></div>`;

  renderServerTab(server, tab);
}

function powerButtons(server) {
  const busy = ['installing', 'stopping'].includes(server.status);
  const running = ['running', 'starting'].includes(server.status);
  return `
    ${
      running
        ? `<button class="btn" data-power="restart" data-id="${esc(server.id)}">${icon('restart', 13)} Restart</button>
           <button class="btn btn-danger" data-power="stop" data-id="${esc(server.id)}">${icon('stop', 12)} Stop</button>
           <button class="btn btn-danger btn-ghost" data-power="kill" data-id="${esc(
             server.id
           )}" title="Force kill">${icon('kill', 13)}</button>`
        : `<button class="btn btn-primary" data-power="start" data-id="${esc(server.id)}" ${
            busy ? 'disabled' : ''
          }>${icon('play', 12)} Start</button>`
    }`;
}

function patchServerHeader() {
  const server = currentServer();
  if (!server) return;
  const status = $('#detail-status');
  if (status) status.innerHTML = statusPill(server.status);
  const power = $('#detail-power');
  if (power) power.innerHTML = powerButtons(server);
}

function patchServerDetail() {
  const server = currentServer();
  if (!server) return;
  const set = (field, html) => {
    const el = $(`[data-detail="${field}"]`);
    if (el) el.innerHTML = html;
  };
  set('cpu', `${(server.cpu || 0).toFixed(1)}<span class="unit">%</span>`);
  set('mem', `${fmtBytes(server.memory)}<span class="unit">/ ${fmtBytes(server.memoryLimit)}</span>`);
  set(
    'players',
    `${server.players ?? '—'}<span class="unit">${server.maxPlayers ? '/ ' + server.maxPlayers : ''}</span>`
  );
  set('ping', server.ping != null ? `${server.ping}<span class="unit">ms</span>` : '—');
  set('conns', String(server.connections ?? 0));
  set('crashes', String(server.crashCount || 0));
  if (server.runtime === 'docker') set('net', `↓ ${fmtRate(server.networkRx)}<br>↑ ${fmtRate(server.networkTx)}`);
  const uptime = $('#detail-uptime');
  if (uptime) uptime.textContent = server.status === 'running' ? 'up ' + fmtDuration(server.uptime) : '';
  if (state.route.params.tab === 'metrics') drawServerCharts(server.id);
}

function renderServerTab(server, tab) {
  const host = $('#tab-content');
  switch (tab) {
    case 'metrics':
      renderMetricsTab(host, server);
      break;
    case 'files':
      renderFilesTab(host, server, '');
      break;
    case 'mods':
      renderModsTab(host, server);
      break;
    case 'backups':
      renderBackupsTab(host, server);
      break;
    case 'settings':
      renderServerSettingsTab(host, server);
      break;
    case 'console':
    default:
      renderConsoleTab(host, server);
      break;
  }
}

/* -------------------------------------------------------------- console */

function renderConsoleTab(host, server) {
  host.innerHTML = `
    <div class="console-wrap">
      <div class="console" id="console"></div>
      <form class="console-form" id="console-form">
        <input id="console-input" placeholder="Type a command and press Enter…" autocomplete="off" spellcheck="false" />
        <button class="btn" type="submit">Send</button>
      </form>
    </div>`;

  const buffered = state.consoles.get(server.id) || [];
  appendConsoleLines(buffered, true);
  wsSubscribe(`console:${server.id}`);

  api(`/api/servers/${server.id}/console`)
    .then((data) => {
      state.consoles.set(server.id, data.lines);
      const el = $('#console');
      if (el) {
        el.innerHTML = '';
        appendConsoleLines(data.lines, true);
      }
    })
    .catch(() => {});

  $('#console-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#console-input');
    const command = input.value.trim();
    if (!command) return;
    input.value = '';
    try {
      await api(`/api/servers/${server.id}/command`, { method: 'POST', body: { command } });
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function handleConsoleMessage(msg) {
  const id = msg.serverId || msg.topic.slice(8);
  if (msg.type === 'clear') {
    state.consoles.set(id, []);
    if (state.route.params.id === id) {
      const el = $('#console');
      if (el) el.innerHTML = '';
    }
    return;
  }
  const buffer = state.consoles.get(id) || [];
  buffer.push(...(msg.lines || []));
  if (buffer.length > 600) buffer.splice(0, buffer.length - 600);
  state.consoles.set(id, buffer);

  if (state.route.name === 'server' && state.route.params.id === id && (state.route.params.tab || 'console') === 'console') {
    appendConsoleLines(msg.lines || []);
  }
}

/**
 * Light syntax colouring for console output: the timestamp/thread prefix is
 * dimmed so the message itself reads first, and the severity decides the tone.
 */
function consoleLineHtml(entry) {
  const raw = String(entry.line ?? '');
  let tone = entry.stream === 'stderr' ? 'err' : entry.stream;

  if (entry.stream === 'stdout') {
    if (/\b(error|severe|fatal|exception|failed|traceback)\b/i.test(raw)) tone = 'err';
    else if (/\b(warn(ing)?|deprecated)\b/i.test(raw)) tone = 'warn';
    else tone = 'out';
  }

  // Split a leading "[12:34:56] [Server thread/INFO]:" style prefix.
  const match = raw.match(/^((?:\[[^\]]*\]\s*)+:?\s*)(.*)$/s);
  const body = match ? match[2] : raw;
  const prefix = match ? match[1] : '';

  return `<div class="l ${esc(tone)}">${prefix ? `<span class="ts">${esc(prefix)}</span>` : ''}${esc(body)}</div>`;
}

function appendConsoleLines(lines, replace = false) {
  const el = $('#console');
  if (lines.length) {
    const lastSeq = lines[lines.length - 1].seq;
    if (state.route.params.id) state.consoleSeq.set(state.route.params.id, lastSeq);
  }
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const html = lines.map(consoleLineHtml).join('');
  el.insertAdjacentHTML('beforeend', html);
  while (el.childElementCount > 600) el.firstElementChild.remove();
  if (atBottom || replace) el.scrollTop = el.scrollHeight;
}

/* -------------------------------------------------------------- metrics */

function renderMetricsTab(host, server) {
  host.innerHTML = `
    <div class="chart-grid">
      <div class="chart-card"><h4>CPU usage</h4><div class="chart-value" id="mv-cpu">—</div><canvas id="chart-cpu"></canvas></div>
      <div class="chart-card"><h4>Memory</h4><div class="chart-value" id="mv-mem">—</div><canvas id="chart-mem"></canvas></div>
      <div class="chart-card"><h4>Players online</h4><div class="chart-value" id="mv-players">—</div><canvas id="chart-players"></canvas></div>
      <div class="chart-card"><h4>Ping</h4><div class="chart-value" id="mv-ping">—</div><canvas id="chart-ping"></canvas></div>
    </div>
    <div class="card mt-16">
      <h4 style="margin:0 0 12px">Details</h4>
      <div class="table-wrap"><table>
        <tr><th>Template</th><td>${esc(server.templateName)}</td></tr>
        <tr><th>Directory</th><td class="mono">${esc(server.dir)}</td></tr>
        <tr><th>Ports</th><td class="mono">${Object.entries(server.ports || {})
          .map(([k, v]) => `${esc(k)}: ${v}`)
          .join(' · ')}</td></tr>
        <tr><th>Disk usage</th><td>${fmtBytes(server.diskBytes)}</td></tr>
        <tr><th>Created</th><td>${fmtTime(server.createdAt)} by ${esc(server.createdBy || '—')}</td></tr>
        <tr><th>Installed</th><td>${server.installedAt ? fmtTime(server.installedAt) : 'Not installed'}</td></tr>
        <tr><th>Crashes</th><td>${server.crashCount || 0}${
          server.lastExit ? ` — last exit code ${esc(server.lastExit.code)} at ${fmtTime(server.lastExit.at)}` : ''
        }</td></tr>
        <tr><th>Query</th><td>${server.queryError ? '<span class="faint">' + esc(server.queryError) + '</span>' : 'OK'}</td></tr>
      </table></div>
    </div>`;

  api(`/api/servers/${server.id}/history`)
    .then((data) => {
      const hist = { cpu: [], mem: [], players: [], ping: [] };
      for (const point of data.history) {
        hist.cpu.push(point.cpu);
        hist.mem.push(point.mem);
        hist.players.push(point.players);
        hist.ping.push(point.ping);
      }
      state.serverHistory.set(server.id, hist);
      drawServerCharts(server.id);
    })
    .catch(() => drawServerCharts(server.id));
}

function drawServerCharts(id) {
  const hist = state.serverHistory.get(id);
  if (!hist) return;
  const server = state.servers.find((s) => s.id === id);
  const accent = themeColor('--accent', '#5e6ad2');
  const success = themeColor('--success', '#4cb782');
  drawChart($('#chart-cpu'), hist.cpu, { color: accent });
  drawChart($('#chart-mem'), hist.mem, { color: accent });
  drawChart($('#chart-players'), hist.players, { color: success });
  drawChart($('#chart-ping'), hist.ping, { color: themeColor('--text-tertiary', '#6a6d73') });
  const set = (sel, text) => {
    const el = $(sel);
    if (el) el.textContent = text;
  };
  if (server) {
    set('#mv-cpu', `${(server.cpu || 0).toFixed(1)} %`);
    set('#mv-mem', fmtBytes(server.memory));
    set('#mv-players', `${server.players ?? 0}${server.maxPlayers ? ' / ' + server.maxPlayers : ''}`);
    set('#mv-ping', server.ping != null ? `${server.ping} ms` : '—');
  }
}

/* ----------------------------------------------------------------- files */

async function renderFilesTab(host, server, dirPath) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading files…</div>';
  let data;
  try {
    data = await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(dirPath)}`);
  } catch (err) {
    host.innerHTML = `<div class="card">Could not list files: ${esc(err.message)}</div>`;
    return;
  }

  const parts = String(data.path || '').split('/').filter(Boolean);
  const crumbs = [`<a data-dir="">${esc(server.name)}</a>`];
  parts.forEach((part, i) => {
    crumbs.push(`<span class="faint">/</span><a data-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</a>`);
  });

  const isArchive = (name) => /\.(zip|tar|tar\.gz|tgz|tar\.xz|tar\.bz2)$/i.test(name);

  host.innerHTML = `
    <div class="row mb-16">
      <div class="file-path">${crumbs.join(' ')}</div>
      <div style="flex:1"></div>
      <span class="faint" id="file-selection" style="font-size:12.5px"></span>
      <button class="btn btn-sm hidden" id="file-compress">${icon('archive',12)} Compress</button>
      <button class="btn btn-sm btn-danger hidden" id="file-delete-selected">${icon('trash',12)} Delete</button>
      <button class="btn btn-sm" id="file-new-folder">New folder</button>
      <button class="btn btn-sm" id="file-new-file">New file</button>
      <button class="btn btn-sm btn-primary" id="file-upload">${icon('upload',12)} Upload</button>
      <input type="file" id="file-input" class="hidden" multiple />
    </div>

    <div class="card dropzone" id="file-dropzone" style="padding:0">
      <div class="dropzone-hint" id="dropzone-hint">Drop files here to upload into <span class="mono">${esc(
        data.path || '/'
      )}</span></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:34px"><input type="checkbox" id="file-select-all" /></th>
          <th>Name</th><th class="nowrap">Size</th><th class="nowrap">Modified</th><th></th>
        </tr></thead>
        <tbody>
          ${
            parts.length
              ? `<tr><td></td><td colspan="4"><a data-dir="${esc(parts.slice(0, -1).join('/'))}">${icon('folder',13)} ..</a></td></tr>`
              : ''
          }
          ${data.items
            .map(
              (item) => `
            <tr>
              <td><input type="checkbox" class="file-check" data-path="${esc(item.path)}" /></td>
              <td><span class="file-name" data-${item.directory ? 'dir' : 'file'}="${esc(item.path)}">
                ${item.directory ? icon('folder', 14) : isArchive(item.name) ? icon('archive', 14) : icon('file', 14)} ${esc(item.name)}</span></td>
              <td class="faint nowrap">${item.directory ? '—' : fmtBytes(item.size)}</td>
              <td class="faint nowrap">${fmtTime(item.modified)}</td>
              <td class="nowrap" style="text-align:right">
                ${
                  isArchive(item.name)
                    ? `<button class="btn btn-sm" data-extract="${esc(item.path)}" title="Unpack here">Unpack</button>`
                    : ''
                }
                <button class="btn btn-sm" data-rename="${esc(item.path)}" title="Rename or move">${icon('edit',12)}</button>
                ${
                  item.directory
                    ? ''
                    : `<a class="btn btn-sm" href="/api/servers/${esc(server.id)}/files/download?path=${encodeURIComponent(
                        item.path
                      )}" title="Download">${icon('download',12)}</a>`
                }
                <button class="btn btn-sm btn-danger" data-delete="${esc(item.path)}">${icon('trash',12)}</button>
              </td>
            </tr>`
            )
            .join('')}
          ${data.items.length ? '' : '<tr><td colspan="5" class="faint">This folder is empty — drop files here or use Upload</td></tr>'}
        </tbody>
      </table></div>
    </div>`;

  const refresh = () => renderFilesTab(host, server, dirPath);

  host.querySelectorAll('[data-dir]').forEach((el) =>
    el.addEventListener('click', () => renderFilesTab(host, server, el.dataset.dir))
  );
  host.querySelectorAll('[data-file]').forEach((el) =>
    el.addEventListener('click', () => openFileEditor(server, el.dataset.file, refresh))
  );

  /* selection ------------------------------------------------------------ */

  const checks = [...host.querySelectorAll('.file-check')];
  const selected = () => checks.filter((c) => c.checked).map((c) => c.dataset.path);
  const updateSelection = () => {
    const count = selected().length;
    $('#file-selection').textContent = count ? `${count} selected` : '';
    $('#file-compress').classList.toggle('hidden', count === 0);
    $('#file-delete-selected').classList.toggle('hidden', count === 0);
  };
  checks.forEach((c) => c.addEventListener('change', updateSelection));
  $('#file-select-all').addEventListener('change', (event) => {
    checks.forEach((c) => (c.checked = event.target.checked));
    updateSelection();
  });

  $('#file-compress').addEventListener('click', async () => {
    const paths = selected();
    const name = await promptModal('Compress', 'Archive name', `archive-${Date.now()}.tar.gz`);
    if (!name) return;
    try {
      const res = await api(`/api/servers/${server.id}/files/compress`, { method: 'POST', body: { paths, name } });
      toast(`Created ${res.name} (${fmtBytes(res.size)})`);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#file-delete-selected').addEventListener('click', async () => {
    const paths = selected();
    if (!(await confirmModal('Delete files', `Delete ${paths.length} item(s)? This cannot be undone.`, 'Delete'))) return;
    for (const path of paths) {
      await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).catch((err) =>
        toast(err.message, 'error')
      );
    }
    toast('Deleted');
    refresh();
  });

  /* per-row actions ------------------------------------------------------ */

  host.querySelectorAll('[data-extract]').forEach((el) =>
    el.addEventListener('click', async () => {
      el.disabled = true;
      el.innerHTML = '<span class="spinner"></span>';
      try {
        await api(`/api/servers/${server.id}/files/extract`, { method: 'POST', body: { path: el.dataset.extract } });
        toast('Archive unpacked');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
        el.textContent = 'Unpack';
      }
    })
  );

  host.querySelectorAll('[data-rename]').forEach((el) =>
    el.addEventListener('click', async () => {
      const from = el.dataset.rename;
      const to = await promptModal('Rename or move', 'New path (relative to the server root)', from);
      if (!to || to === from) return;
      try {
        await api(`/api/servers/${server.id}/files/rename`, { method: 'POST', body: { from, to } });
        toast('Moved');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  host.querySelectorAll('[data-delete]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete', `Delete “${el.dataset.delete}”? This cannot be undone.`, 'Delete'))) return;
      try {
        await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(el.dataset.delete)}`, { method: 'DELETE' });
        toast('Deleted');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  /* creating and uploading ----------------------------------------------- */

  $('#file-new-folder').addEventListener('click', async () => {
    const name = await promptModal('New folder', 'Folder name');
    if (!name) return;
    await api(`/api/servers/${server.id}/files/mkdir`, { method: 'POST', body: { path: joinPath(dirPath, name) } });
    refresh();
  });

  $('#file-new-file').addEventListener('click', async () => {
    const name = await promptModal('New file', 'File name');
    if (!name) return;
    await api(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(joinPath(dirPath, name))}`, {
      method: 'PUT',
      body: { content: '' },
    });
    refresh();
  });

  async function uploadFiles(fileList) {
    let done = 0;
    for (const file of fileList) {
      try {
        const res = await fetch(
          `/api/servers/${server.id}/files/upload?path=${encodeURIComponent(joinPath(dirPath, file.name))}`,
          { method: 'POST', body: file, credentials: 'same-origin' }
        );
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
        done++;
        toast(`Uploaded ${file.name}`);
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    if (done) refresh();
  }

  $('#file-upload').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (event) => uploadFiles([...event.target.files]));

  // Drag and drop straight onto the listing — the quickest way to add mods.
  const dropzone = $('#file-dropzone');
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      if (type === 'dragleave' && dropzone.contains(event.relatedTarget)) return;
      dropzone.classList.remove('dragging');
    })
  );
  dropzone.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) uploadFiles(files);
  });
}

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

async function openFileEditor(server, filePath, onClose) {
  let data;
  try {
    data = await api(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(filePath)}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const modal = openModal({
    title: esc(filePath),
    width: 900,
    body: `<textarea class="editor" id="file-editor" spellcheck="false">${esc(data.content)}</textarea>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          try {
            await api(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(filePath)}`, {
              method: 'PUT',
              body: { content: $('#file-editor').value },
            });
            toast('Saved');
            modal.close();
            onClose?.();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ mods */

const modState = { provider: null, query: '', page: 0, results: [], loading: false };

async function renderModsTab(host, server) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading mod sources…</div>';
  let info;
  try {
    info = await api(`/api/servers/${server.id}/mods`);
  } catch (err) {
    host.innerHTML = `<div class="card">Could not load mods: ${esc(err.message)}</div>`;
    return;
  }
  if (!info.supported || !info.providers.length) {
    host.innerHTML = `
      <div class="empty">
        
        <h3>No mod source for this game</h3>
        <p>You can still upload mods by hand in the <a href="#/servers/${esc(server.id)}/files">file manager</a>${
          info.installed ? ` — this game loads them from <span class="mono">${esc(info.installed.dir)}</span>` : ''
        }.</p>
      </div>`;
    return;
  }

  if (!modState.provider || !info.providers.some((p) => p.id === modState.provider)) {
    modState.provider = info.providers[0].id;
    modState.results = [];
    modState.query = '';
  }
  const provider = info.providers.find((p) => p.id === modState.provider);
  const context = info.context || {};

  host.innerHTML = `
    <div class="card mb-16">
      <div class="row mb-16">
        ${info.providers
          .map(
            (p) =>
              `<span class="chip ${p.id === modState.provider ? 'active' : ''}" data-provider="${esc(p.id)}">${esc(
                p.label
              )}</span>`
          )
          .join('')}
        <div style="flex:1"></div>
        <span class="faint" style="font-size:12.5px">
          Installs into <span class="mono">${esc(context.dir || 'mods')}</span>
          ${context.loader ? ` · loader <b>${esc(context.loader)}</b>` : ''}
          ${context.gameVersion ? ` · ${esc(context.gameVersion)}` : ''}
        </span>
      </div>

      ${
        provider.viaSteamcmd
          ? `<div class="row">
               <input id="mod-workshop-input" placeholder="Workshop item ID or URL — e.g. https://steamcommunity.com/sharedfiles/filedetails/?id=104604764" style="flex:1" />
               <button class="btn btn-primary" id="mod-workshop-install">Install item</button>
             </div>
             <div class="hint">SteamCMD downloads the item into the server. ${
               info.keys.workshop ? 'You can also search below.' : 'Add a Steam Web API key in Settings to search the Workshop from here.'
             }</div>`
          : ''
      }

      ${
        provider.needsKey && !info.keys[provider.id]
          ? `<div class="hint" style="color:var(--amber)">${esc(provider.label)} needs a free API key — add one in <a href="#/settings">Settings → Integrations</a>.</div>`
          : ''
      }

      <div class="row mt-16">
        <input id="mod-search" placeholder="Search ${esc(provider.label)}…" value="${esc(modState.query)}" style="flex:1" />
        <button class="btn" id="mod-search-btn">Search</button>
      </div>
    </div>

    <div id="mod-results" class="grid-cards mb-16"></div>

    <div class="card">
      <h4 style="margin:0 0 12px">Installed <span class="faint mono" style="font-weight:400">${esc(
        info.installed.dir
      )}</span></h4>
      <div class="table-wrap"><table>
        <tbody>
          ${
            info.installed.items.length
              ? info.installed.items
                  .map(
                    (item) => `<tr>
                      <td>${item.directory ? icon('folder', 13) : icon('file', 13)} <span class="${item.disabled ? 'faint' : ''}">${esc(item.name)}</span>
                        ${item.disabled ? '<span class="badge">disabled</span>' : ''}</td>
                      <td class="faint nowrap">${item.directory ? '—' : fmtBytes(item.size)}</td>
                      <td class="faint nowrap">${fmtTime(item.modified)}</td>
                      <td style="text-align:right" class="nowrap">
                        ${
                          item.directory
                            ? ''
                            : `<button class="btn btn-sm" data-mod-toggle="${esc(item.name)}">${
                                item.disabled ? 'Enable' : 'Disable'
                              }</button>`
                        }
                        <button class="btn btn-sm btn-danger" data-mod-delete="${esc(item.name)}">${icon('trash',12)}</button>
                      </td></tr>`
                  )
                  .join('')
              : '<tr><td class="faint">Nothing installed yet</td></tr>'
          }
        </tbody>
      </table></div>
      <div class="hint">Restart the server for mod changes to take effect.</div>
    </div>`;

  const runSearch = async () => {
    const results = $('#mod-results');
    results.innerHTML = '<div class="card"><span class="spinner"></span> Searching…</div>';
    try {
      const data = await api(
        `/api/servers/${server.id}/mods/search?provider=${encodeURIComponent(modState.provider)}&query=${encodeURIComponent(
          modState.query
        )}&page=${modState.page}`
      );
      modState.results = data.items;
      renderModResults(server, data.items);
    } catch (err) {
      results.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    }
  };

  host.querySelectorAll('[data-provider]').forEach((el) =>
    el.addEventListener('click', () => {
      modState.provider = el.dataset.provider;
      modState.query = '';
      modState.page = 0;
      modState.results = [];
      renderModsTab(host, server);
    })
  );

  $('#mod-search-btn').addEventListener('click', () => {
    modState.query = $('#mod-search').value.trim();
    modState.page = 0;
    runSearch();
  });
  $('#mod-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#mod-search-btn').click();
  });

  $('#mod-workshop-install')?.addEventListener('click', async () => {
    const input = $('#mod-workshop-input').value.trim();
    if (!input) return;
    try {
      const res = await api(`/api/servers/${server.id}/mods/install`, {
        method: 'POST',
        body: { provider: 'workshop', projectId: input },
      });
      toast(res.message || 'Workshop item queued');
      $('#mod-workshop-input').value = '';
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  host.querySelectorAll('[data-mod-delete]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Remove mod', `Delete ${el.dataset.modDelete}?`))) return;
      await api(`/api/servers/${server.id}/mods/${encodeURIComponent(el.dataset.modDelete)}`, { method: 'DELETE' });
      renderModsTab(host, server);
    })
  );
  host.querySelectorAll('[data-mod-toggle]').forEach((el) =>
    el.addEventListener('click', async () => {
      await api(`/api/servers/${server.id}/mods/${encodeURIComponent(el.dataset.modToggle)}/toggle`, {
        method: 'POST',
        body: {},
      });
      renderModsTab(host, server);
    })
  );

  // Show something useful before the user types anything.
  if (!provider.viaSteamcmd || info.keys.workshop) runSearch();
}

function renderModResults(server, items) {
  const results = $('#mod-results');
  if (!items.length) {
    results.innerHTML = '<div class="card faint">No results</div>';
    return;
  }
  results.innerHTML = items
    .map(
      (item, index) => `
      <div class="tile-card spot" style="cursor:default">
        <div class="t-head">
          ${
            item.icon
              ? `<img src="${esc(item.icon)}" alt="" style="width:38px;height:38px;border-radius:9px;object-fit:cover" loading="lazy" />`
              : `<span class="t-icon">${icon('file', 15)}</span>`
          }
          <div style="min-width:0">
            <h3 style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.name)}</h3>
            <div class="t-meta">${esc(item.author || '')}${
        item.downloads ? ` · ${Number(item.downloads).toLocaleString()} downloads` : ''
      }</div>
          </div>
        </div>
        <p style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(
          item.description || ''
        )}</p>
        <div class="row" style="margin-top:auto">
          ${item.url ? `<a class="btn btn-sm" href="${esc(item.url)}" target="_blank" rel="noopener">Open page</a>` : ''}
          <button class="btn btn-sm btn-primary" style="margin-left:auto" data-install="${index}">Install</button>
        </div>
      </div>`
    )
    .join('');

  results.querySelectorAll('[data-install]').forEach((el) =>
    el.addEventListener('click', async () => {
      const item = items[Number(el.dataset.install)];
      el.disabled = true;
      el.innerHTML = '<span class="spinner"></span>';
      try {
        const res = await api(`/api/servers/${server.id}/mods/install`, {
          method: 'POST',
          body: { provider: item.provider, projectId: item.id },
        });
        toast(res.queued ? res.message : `Installed ${res.mod.name}`);
        el.textContent = '✓ Installed';
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
        el.textContent = 'Install';
      }
    })
  );
}

/* --------------------------------------------------------------- backups */

async function renderBackupsTab(host, server) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading backups…</div>';
  const data = await api(`/api/servers/${server.id}/backups`).catch((err) => ({ backups: [], error: err.message }));

  host.innerHTML = `
    <div class="row mb-16">
      <button class="btn btn-primary" id="backup-create">Create backup</button>
      <span class="faint">Backups are plain .tar.gz archives of the whole server directory.</span>
    </div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${
            data.backups.length
              ? data.backups
                  .map(
                    (b) => `<tr>
                      <td class="mono">${esc(b.name)}</td>
                      <td class="faint nowrap">${fmtBytes(b.size)}</td>
                      <td class="faint nowrap">${fmtTime(b.createdAt)}</td>
                      <td class="nowrap" style="text-align:right">
                        <a class="btn btn-sm" href="/api/servers/${esc(server.id)}/backups/${encodeURIComponent(b.name)}/download">${icon('download',12)}</a>
                        <button class="btn btn-sm" data-restore="${esc(b.name)}">Restore</button>
                        <button class="btn btn-sm btn-danger" data-del-backup="${esc(b.name)}">${icon('trash',12)}</button>
                      </td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="4" class="faint">No backups yet</td></tr>'
          }
        </tbody>
      </table></div>
    </div>`;

  $('#backup-create').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating…';
    try {
      await api(`/api/servers/${server.id}/backups`, { method: 'POST', body: {} });
      toast('Backup created');
      renderBackupsTab(host, server);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Create backup';
    }
  });

  host.querySelectorAll('[data-restore]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Restore backup', 'This overwrites current files with the archive contents. The server must be stopped. Continue?')))
        return;
      try {
        await api(`/api/servers/${server.id}/backups/${encodeURIComponent(el.dataset.restore)}/restore`, { method: 'POST', body: {} });
        toast('Backup restored');
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  host.querySelectorAll('[data-del-backup]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete backup', `Delete ${el.dataset.delBackup}?`))) return;
      await api(`/api/servers/${server.id}/backups/${encodeURIComponent(el.dataset.delBackup)}`, { method: 'DELETE' });
      renderBackupsTab(host, server);
    })
  );
}

/* ------------------------------------------------- server settings tab -- */

function renderServerSettingsTab(host, server) {
  // Editing follows the "settings" capability; the danger zone stays admin-only.
  const isAdmin = can('settings');
  const isOwner = state.user.role === 'admin';
  host.innerHTML = `
    <div class="card mb-16">
      <h4 style="margin:0 0 14px">General</h4>
      <div class="form-grid">
        <label><span>Server name</span><input id="set-name" value="${esc(server.name)}" ${isAdmin ? '' : 'disabled'} /></label>
        <label><span>Memory limit (MB)</span><input id="set-memory" type="number" value="${
          server.memoryMb ?? Math.round((server.memoryLimit || 0) / 1048576)
        }" ${isAdmin ? '' : 'disabled'} /></label>
        <label><span>Max players</span><input id="set-maxplayers" type="number" value="${server.maxPlayers || 20}" ${
    isAdmin ? '' : 'disabled'
  } /></label>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="set-autostart" ${server.autoStart ? 'checked' : ''} ${
    isAdmin ? '' : 'disabled'
  } /><label for="set-autostart">Start automatically when the panel boots</label></div>
      <div class="checkbox-row"><input type="checkbox" id="set-autorestart" ${server.autoRestart ? 'checked' : ''} ${
    isAdmin ? '' : 'disabled'
  } /><label for="set-autorestart">Restart automatically after a crash</label></div>
      <label><span>Start command</span><textarea id="set-startcmd" rows="3" ${isAdmin ? '' : 'disabled'}>${esc(
    server.startCommand
  )}</textarea><div class="hint">Runs inside the server directory. Placeholders like {{PORT}} and {{MEMORY}} are substituted at launch.</div></label>
      ${isAdmin ? '<button class="btn btn-primary mt-16" id="set-save">Save changes</button>' : ''}
    </div>

    <div class="card mb-16">
      <h4 style="margin:0 0 14px">Ports</h4>
      <div class="form-grid">
        ${Object.entries(server.ports || {})
          .map(
            ([name, port]) =>
              `<label><span>${esc(name)}</span><input data-port="${esc(name)}" type="number" value="${port}" ${
                isAdmin ? '' : 'disabled'
              } /></label>`
          )
          .join('')}
      </div>
      <div class="hint">Changing a port takes effect on the next start. Remember to open it in your firewall.</div>
    </div>

    <div class="card mb-16">
      <h4 style="margin:0 0 14px">Template variables</h4>
      <div class="form-grid">
        ${Object.entries(server.vars || {})
          .map(
            ([name, value]) =>
              `<label><span>${esc(name)}</span><input data-var="${esc(name)}" value="${esc(value)}" ${
                isAdmin ? '' : 'disabled'
              } /></label>`
          )
          .join('')}
      </div>
      <div class="hint">Applied on the next start (and to config files the template manages).</div>
    </div>

    ${
      isOwner
        ? `<div class="card">
             <h4 style="margin:0 0 6px">Danger zone</h4>
             <p class="faint" style="margin:0 0 14px">Reinstalling re-runs the template installer in place. Deleting removes the server and all of its files.</p>
             <div class="row">
               <button class="btn" id="set-reinstall">Reinstall</button>
               <button class="btn btn-danger" id="set-delete">Delete server</button>
             </div>
           </div>`
        : ''
    }`;

  if (!isAdmin) return;

  $('#set-save').addEventListener('click', async () => {
    const ports = {};
    host.querySelectorAll('[data-port]').forEach((el) => (ports[el.dataset.port] = Number(el.value)));
    const vars = {};
    host.querySelectorAll('[data-var]').forEach((el) => (vars[el.dataset.var] = el.value));
    try {
      await api(`/api/servers/${server.id}`, {
        method: 'PATCH',
        body: {
          name: $('#set-name').value.trim(),
          memory: Number($('#set-memory').value),
          maxPlayers: Number($('#set-maxplayers').value),
          autoStart: $('#set-autostart').checked,
          autoRestart: $('#set-autorestart').checked,
          startCommand: $('#set-startcmd').value,
          ports,
          vars,
        },
      });
      await loadServers();
      toast('Settings saved');
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  if (!isOwner) return; // the danger zone below is not rendered for non-admins

  $('#set-reinstall').addEventListener('click', async () => {
    if (!(await confirmModal('Reinstall server', 'Re-run the installer for this server? Game files may be overwritten; worlds and configs are normally kept.')))
      return;
    await api(`/api/servers/${server.id}/install`, { method: 'POST', body: { reinstall: true } });
    toast('Reinstall started — watch the console');
    location.hash = `#/servers/${server.id}/console`;
  });

  $('#set-delete').addEventListener('click', async () => {
    if (!(await confirmModal('Delete server', `Permanently delete “${server.name}” and all of its files?`, 'Delete'))) return;
    try {
      await api(`/api/servers/${server.id}`, { method: 'DELETE' });
      await loadServers();
      toast('Server deleted');
      location.hash = '#/servers';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------------------------------------- templates */

let templateFilter = { category: 'all', search: '' };

function renderTemplates(view) {
  setCrumbs('Templates');
  const filtered = state.templates.filter((tpl) => {
    const categoryOk = templateFilter.category === 'all' || (tpl.category || 'Other') === templateFilter.category;
    const term = templateFilter.search.toLowerCase();
    const searchOk =
      !term ||
      tpl.name.toLowerCase().includes(term) ||
      String(tpl.description || '').toLowerCase().includes(term) ||
      String(tpl.category || '').toLowerCase().includes(term);
    return categoryOk && searchOk;
  });

  view.innerHTML = `
    <div class="page-head">
      <h1>Templates</h1>
      <div class="spacer"></div>
      <input class="search-input" id="tpl-search" placeholder="Search games…" value="${esc(templateFilter.search)}" />
    </div>
    <div class="filter-bar">
      <span class="chip ${templateFilter.category === 'all' ? 'active' : ''}" data-cat="all">All (${state.templates.length})</span>
      ${state.categories
        .map(
          (c) =>
            `<span class="chip ${templateFilter.category === c.name ? 'active' : ''}" data-cat="${esc(c.name)}">${esc(
              c.name
            )} (${c.count})</span>`
        )
        .join('')}
    </div>
    <div class="grid-cards">
      ${
        filtered.length
          ? filtered
              .map(
                (tpl) => `
        <div class="tile-card spot" data-template="${esc(tpl.id)}">
          <div class="t-head">
            <span class="t-icon">${esc(tpl.icon || '🎮')}</span>
            <div>
              <h3>${esc(tpl.name)}</h3>
              <div class="t-meta">${esc(tpl.category || 'Other')}${tpl.custom ? ' · custom' : ''}</div>
            </div>
          </div>
          <p>${esc(tpl.description || '')}</p>
          <div class="t-foot">
            <span class="badge mono" title="Default ports">${(tpl.ports || []).map((p) => p.default).join(' · ')}</span>
            ${
              state.user.role === 'admin'
                ? '<button class="btn btn-sm" style="margin-left:auto">Deploy</button>'
                : ''
            }
          </div>
        </div>`
              )
              .join('')
          : '<div class="empty" style="grid-column:1/-1"><h3>No templates match</h3></div>'
      }
    </div>`;

  revealChildren(view.querySelector('.grid-cards'));

  $('#tpl-search').addEventListener('input', (event) => {
    templateFilter.search = event.target.value;
    render();
    $('#tpl-search').focus();
  });
  view.querySelectorAll('[data-cat]').forEach((el) =>
    el.addEventListener('click', () => {
      templateFilter.category = el.dataset.cat;
      render();
    })
  );
  view.querySelectorAll('[data-template]').forEach((el) =>
    el.addEventListener('click', () => {
      if (state.user.role !== 'admin') return toast('Only administrators can create servers', 'warn');
      openCreateServerModal(el.dataset.template);
    })
  );
}

/* --------------------------------------------------------- create server */

/** Fill every `data-source` select from the panel's live option providers. */
async function hydrateOptionFields(root = document) {
  const fields = [...root.querySelectorAll('select[data-source]')];
  if (!fields.length) return;
  const sources = [...new Set(fields.map((f) => f.dataset.source))];

  await Promise.all(
    sources.map(async (source) => {
      let data;
      try {
        data = await api(`/api/options/${encodeURIComponent(source)}`);
      } catch (err) {
        data = { options: [], error: err.message };
      }
      for (const field of fields.filter((f) => f.dataset.source === source)) {
        const hint = root.querySelector(`[data-hint-for="${CSS.escape(field.dataset.var)}"]`);

        // Unreachable provider: degrade to a plain text box rather than a
        // dropdown with nothing in it.
        if (!data.options?.length) {
          const input = document.createElement('input');
          input.id = field.id;
          input.dataset.var = field.dataset.var;
          input.value = field.dataset.default || '';
          field.replaceWith(input);
          if (hint) hint.textContent = data.error || 'Could not load the list — type a value instead.';
          continue;
        }

        field.innerHTML = data.options
          .map(
            (o) =>
              `<option value="${esc(o.value)}">${esc(o.label)}${o.recommended ? ' — recommended' : ''}</option>`
          )
          .join('');

        // Honour an explicit template default when it still exists, otherwise
        // take the newest/recommended entry.
        const wanted = field.dataset.default;
        const usable = wanted && wanted !== 'latest' && data.options.some((o) => o.value === wanted);
        field.value = usable ? wanted : data.recommended ?? data.options[0].value;

        const describe = () => {
          if (!hint) return;
          const chosen = data.options.find((o) => o.value === field.value);
          const note = chosen?.note || (chosen?.recommended ? 'Newest stable release.' : '');
          hint.textContent = [note, data.stale ? '(cached list)' : ''].filter(Boolean).join(' ');
        };
        field.addEventListener('change', describe);
        describe();
      }
    })
  );
}

/** Warn before submitting if a chosen port is already taken by another server. */
function checkPortConflicts(root = document) {
  const used = new Map();
  for (const server of state.servers) {
    for (const [name, port] of Object.entries(server.ports || {})) used.set(Number(port), server.name);
  }
  root.querySelectorAll('[data-port]').forEach((input) => {
    const update = () => {
      const owner = used.get(Number(input.value));
      let hint = input.parentElement.querySelector('.port-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'hint port-hint';
        input.parentElement.appendChild(hint);
      }
      hint.textContent = owner ? `In use by “${owner}” — pick another or it will be reassigned.` : '';
      hint.style.color = owner ? 'var(--warning)' : '';
    };
    input.addEventListener('input', update);
    update();
  });
}

/** Wire the memory preset dropdown to its hidden numeric input. */
function wireMemoryField(root = document) {
  const preset = root.querySelector('#new-memory-preset');
  const input = root.querySelector('#new-memory');
  if (!preset || !input) return;
  preset.addEventListener('change', () => {
    if (preset.value === 'custom') {
      input.classList.remove('hidden');
      input.focus();
      input.select();
    } else {
      input.classList.add('hidden');
      input.value = preset.value;
    }
  });
}

/** Reroll button on generated secrets. */
function wireGenerateButtons(root = document) {
  root.querySelectorAll('[data-generate]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const field = root.querySelector(`[data-var="${CSS.escape(btn.dataset.generate)}"]`);
      if (!field) return;
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      field.value = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 16);
      field.focus();
    })
  );
}

/** Everything a freshly opened deploy form needs. */
function wireDeployForm(root = document) {
  wireMemoryField(root);
  wireGenerateButtons(root);
  checkPortConflicts(root);
  hydrateOptionFields(root);
}

/**
 * Memory picker: common sizes as a dropdown, with an escape hatch to type an
 * exact number. The hidden #new-memory input stays the single source of truth.
 */
function memoryField(defaultMb) {
  const presets = [1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768];
  if (!presets.includes(defaultMb)) presets.push(defaultMb);
  presets.sort((a, b) => a - b);
  const label = (mb) => (mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`);
  return `
    <label><span>Memory limit</span>
      <select id="new-memory-preset">
        ${presets
          .map(
            (mb) =>
              `<option value="${mb}" ${mb === defaultMb ? 'selected' : ''}>${label(mb)}${
                mb === defaultMb ? ' — recommended' : ''
              }</option>`
          )
          .join('')}
        <option value="custom">Custom…</option>
      </select>
      <input id="new-memory" type="number" min="256" step="256" value="${defaultMb}" class="hidden" />
      <div class="hint">The container is capped at this; a server that exceeds it is restarted rather than taking the host down.</div>
    </label>`;
}

function variableField(v) {
  const id = `var-${v.name}`;

  // Choices fetched live from the panel (game versions, build channels…).
  if (v.source) {
    return `<label><span>${esc(v.label || v.name)}</span>
      <select id="${id}" data-var="${esc(v.name)}" data-source="${esc(v.source)}" data-default="${esc(v.default ?? '')}">
        <option>Loading choices…</option>
      </select>
      <div class="hint" data-hint-for="${esc(v.name)}">${esc(v.description || '')}</div></label>`;
  }

  // Secrets: prefilled with something strong, with a button to reroll.
  if (v.generate === 'password') {
    return `<label><span>${esc(v.label || v.name)}</span>
      <span class="input-row">
        <input id="${id}" data-var="${esc(v.name)}" type="text" value="${esc(v.default ?? '')}"
               placeholder="generated automatically" spellcheck="false" />
        <button type="button" class="btn btn-sm" data-generate="${esc(v.name)}">Generate</button>
      </span>
      <div class="hint">${esc(v.description || 'Leave blank and one will be generated for you.')}</div></label>`;
  }

  if (v.options?.length) {
    return `<label><span>${esc(v.label || v.name)}</span>
      <select id="${id}" data-var="${esc(v.name)}">
        ${v.options.map((o) => `<option ${String(v.default) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
      ${v.description ? `<div class="hint">${esc(v.description)}</div>` : ''}</label>`;
  }
  const isLong = String(v.default || '').length > 60;
  const field = isLong
    ? `<textarea id="${id}" data-var="${esc(v.name)}" rows="3">${esc(v.default ?? '')}</textarea>`
    : `<input id="${id}" data-var="${esc(v.name)}" type="${v.type === 'number' ? 'number' : 'text'}" value="${esc(
        v.default ?? ''
      )}" ${v.generate === 'password' ? 'placeholder="generated automatically"' : ''} />`;
  return `<label><span>${esc(v.label || v.name)}</span>${field}${
    v.description ? `<div class="hint">${esc(v.description)}</div>` : ''
  }</label>`;
}

function openCreateServerModal(templateId) {
  const template = state.templates.find((t) => t.id === templateId) || state.templates[0];
  if (!template) return toast('No templates available', 'error');
  if (template.wizard?.length) return openWizardModal(template);

  const variableFields = (template.variables || []).map(variableField).join('');

  const portFields = (template.ports || [])
    .map(
      (p) =>
        `<label><span>Port · ${esc(p.name)} (${esc(p.protocol || 'tcp')})</span>
           <input data-port="${esc(p.name)}" type="number" value="${p.default}" /></label>`
    )
    .join('');

  const modal = openModal({
    title: `${template.icon || '🎮'} Deploy ${template.name}`,
    width: 660,
    body: `
      <p class="faint" style="margin-top:0">${esc(template.description || '')}</p>
      <div class="form-grid">
        <label><span>Server name</span><input id="new-name" value="${esc(template.name)}" /></label>
        ${memoryField(template.defaultMemory || 2048)}
      </div>
      ${portFields ? `<h4 class="section-title mt-16">Ports</h4><div class="form-grid">${portFields}</div>` : ''}
      ${variableFields ? `<h4 class="section-title mt-16">Game settings</h4><div class="form-grid">${variableFields}</div>` : ''}
      <div class="checkbox-row mt-16"><input type="checkbox" id="new-autostart" checked /><label for="new-autostart">Start with the panel</label></div>
      <div class="checkbox-row"><input type="checkbox" id="new-autorestart" checked /><label for="new-autorestart">Restart after crashes</label></div>
      <div class="hint">Installation starts immediately and streams to the server console. Large games can take a while.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Create & install',
        primary: true,
        onClick: async (btn) => {
          const vars = {};
          document.querySelectorAll('[data-var]').forEach((el) => (vars[el.dataset.var] = el.value));
          const ports = {};
          document.querySelectorAll('[data-port]').forEach((el) => {
            const value = Number(el.value);
            if (value) ports[el.dataset.port] = value;
          });
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Creating…';
          try {
            const data = await api('/api/servers', {
              method: 'POST',
              body: {
                templateId: template.id,
                name: $('#new-name').value.trim(),
                memory: Number($('#new-memory').value),
                autoStart: $('#new-autostart').checked,
                autoRestart: $('#new-autorestart').checked,
                vars,
                ports,
              },
            });
            await loadServers();
            modal.close();
            toast('Server created — installation started');
            location.hash = `#/servers/${data.server.id}/console`;
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Create & install';
          }
        },
      },
    ],
  });

  wireDeployForm(document);
  return modal;
}

/**
 * Step-by-step create flow for templates that declare a `wizard`
 * (FiveM walks you through license key, framework and database this way).
 */
function openWizardModal(template) {
  const byName = Object.fromEntries((template.variables || []).map((v) => [v.name, v]));
  const used = new Set();
  const steps = template.wizard.map((step) => ({
    title: step.title,
    description: step.description,
    fields: (step.fields || []).filter((name) => byName[name]).map((name) => {
      used.add(name);
      return byName[name];
    }),
  }));

  // Anything the wizard did not mention goes on a final "advanced" step.
  const leftovers = (template.variables || []).filter((v) => !used.has(v.name));
  const allSteps = [
    {
      title: 'Server name and resources',
      description: `Deploying ${template.name}.`,
      html: `<div class="form-grid">
          <label><span>Server name</span><input id="new-name" value="${esc(template.name)}" /></label>
          ${memoryField(template.defaultMemory || 2048)}
          ${(template.ports || [])
            .map(
              (p) =>
                `<label><span>Port · ${esc(p.name)} (${esc(p.protocol || 'tcp')})</span><input data-port="${esc(
                  p.name
                )}" type="number" value="${p.default}" /></label>`
            )
            .join('')}
        </div>`,
    },
    ...steps.map((step) => ({
      title: step.title,
      description: step.description,
      html: `<div class="form-grid">${step.fields.map(variableField).join('')}</div>`,
    })),
    ...(leftovers.length
      ? [
          {
            title: 'Advanced',
            description: 'Fine — leave these alone unless you know you need them.',
            html: `<div class="form-grid">${leftovers.map(variableField).join('')}</div>`,
          },
        ]
      : []),
  ];

  let current = 0;
  const body = allSteps
    .map(
      (step, i) => `
      <div class="wizard-step ${i === 0 ? '' : 'hidden'}" data-step="${i}">
        <div class="wizard-head">
          <span class="wizard-count">Step ${i + 1} of ${allSteps.length}</span>
          <h3>${esc(step.title)}</h3>
          ${step.description ? `<p class="hint">${esc(step.description)}</p>` : ''}
        </div>
        ${step.html}
      </div>`
    )
    .join('');

  const modal = openModal({
    title: `${template.icon || '🎮'} ${template.name} setup`,
    width: 660,
    body: `<div class="wizard-progress">${allSteps
      .map((_, i) => `<i data-dot="${i}" class="${i === 0 ? 'active' : ''}"></i>`)
      .join('')}</div>${body}`,
    actions: [
      { label: 'Back', onClick: () => show(current - 1) },
      { label: 'Next', primary: true, onClick: (btn) => (current === allSteps.length - 1 ? submit(btn) : show(current + 1)) },
    ],
  });

  wireDeployForm(document);

  const [backBtn, nextBtn] = [...document.querySelectorAll('.modal-foot .btn')];

  function show(index) {
    current = Math.max(0, Math.min(allSteps.length - 1, index));
    document.querySelectorAll('.wizard-step').forEach((el) => {
      el.classList.toggle('hidden', Number(el.dataset.step) !== current);
    });
    document.querySelectorAll('[data-dot]').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.dot) <= current);
    });
    backBtn.disabled = current === 0;
    nextBtn.textContent = current === allSteps.length - 1 ? 'Create & install' : 'Next →';
    document.querySelector('.modal-body').scrollTop = 0;
  }
  show(0);

  async function submit(btn) {
    const vars = {};
    document.querySelectorAll('[data-var]').forEach((el) => (vars[el.dataset.var] = el.value));
    const ports = {};
    document.querySelectorAll('[data-port]').forEach((el) => {
      const value = Number(el.value);
      if (value) ports[el.dataset.port] = value;
    });
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating…';
    try {
      const data = await api('/api/servers', {
        method: 'POST',
        body: {
          templateId: template.id,
          name: $('#new-name').value.trim(),
          memory: Number($('#new-memory').value),
          autoStart: true,
          autoRestart: true,
          vars,
          ports,
        },
      });
      await loadServers();
      modal.close();
      toast('Server created — installation started');
      location.hash = `#/servers/${data.server.id}/console`;
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Create & install';
    }
  }
}

/* -------------------------------------------------------------- activity */

async function renderActivity(view) {
  setCrumbs('Activity');
  view.innerHTML = '<div class="card"><span class="spinner"></span> Loading…</div>';
  const data = await api('/api/events?limit=200').catch(() => ({ events: [] }));
  // A coloured dot reads faster than an icon per event type.
  const tone = (type) => {
    if (type.includes('crash') || type.includes('failed')) return 'var(--danger)';
    if (type.includes('started') || type.includes('installed') || type.includes('created')) return 'var(--success)';
    if (type.includes('deleted') || type.includes('restored')) return 'var(--warning)';
    return 'var(--text-tertiary)';
  };
  view.innerHTML = `
    <div class="page-head"><h1>Activity</h1></div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th style="width:30px"></th><th>Event</th><th>Server</th><th>Origin</th><th class="nowrap">When</th></tr></thead>
        <tbody>
          ${
            data.events.length
              ? data.events
                  .map((e) => {
                    const server = state.servers.find((s) => s.id === e.serverId);
                    return `<tr>
                      <td><span style="display:block;width:5px;height:5px;border-radius:50%;background:${tone(
                        e.type
                      )}"></span></td>
                      <td>${esc(e.message)}</td>
                      <td>${server ? `<a href="#/servers/${esc(server.id)}">${esc(server.name)}</a>` : '<span class="faint">—</span>'}</td>
                      <td class="faint nowrap">${
                        e.ip
                          ? `<span class="mono">${esc(e.ip)}</span>${e.location ? ` · ${esc(e.location)}` : ''}`
                          : '—'
                      }</td>
                      <td class="faint nowrap">${fmtTime(e.at)}</td>
                    </tr>`;
                  })
                  .join('')
              : '<tr><td colspan="5" class="faint">Nothing has happened yet</td></tr>'
          }
        </tbody>
      </table></div>
    </div>`;
}

/* ----------------------------------------------------------------- users */

async function renderUsers(view) {
  setCrumbs('Users');
  const data = await api('/api/users').catch((err) => ({ users: [], error: err.message }));
  view.innerHTML = `
    <div class="page-head">
      <h1>Users</h1>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="user-new">New user</button>
    </div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Role</th><th>Servers</th><th>Permissions</th><th>Last login</th><th></th></tr></thead>
        <tbody>
          ${data.users
            .map(
              (u) => `<tr>
                <td><strong>${esc(u.username)}</strong></td>
                <td><span class="badge ${u.role === 'admin' ? 'admin' : ''}">${esc(u.role)}</span></td>
                <td class="faint">${u.role === 'admin' ? 'All servers' : (u.servers || []).length + ' assigned'}</td>
                <td class="faint">${
                  u.role === 'admin'
                    ? 'Everything'
                    : `${(u.permissions || []).length} of ${(data.capabilities || []).length}`
                }</td>
                <td class="faint nowrap">${fmtTime(u.lastLogin)}</td>
                <td style="text-align:right" class="nowrap">
                  <button class="btn btn-sm" data-edit-user="${esc(u.id)}">Edit</button>
                  ${u.id !== state.user.id ? `<button class="btn btn-sm btn-danger" data-del-user="${esc(u.id)}">${icon('trash',12)}</button>` : ''}
                </td></tr>`
            )
            .join('')}
        </tbody>
      </table></div>
    </div>`;

  $('#user-new').addEventListener('click', () => openUserModal(null, data.capabilities, data.defaults));
  view.querySelectorAll('[data-edit-user]').forEach((el) =>
    el.addEventListener('click', () =>
      openUserModal(data.users.find((u) => u.id === el.dataset.editUser), data.capabilities, data.defaults)
    )
  );
  view.querySelectorAll('[data-del-user]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete user', 'Remove this user account?'))) return;
      try {
        await api(`/api/users/${el.dataset.delUser}`, { method: 'DELETE' });
        renderUsers(view);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function openUserModal(user, capabilities = [], defaults = []) {
  const editing = Boolean(user);
  const held = new Set(user ? user.permissions || [] : defaults);

  // Group the capability checkboxes the way they are grouped server-side.
  const groups = {};
  for (const cap of capabilities) (groups[cap.group] = groups[cap.group] || []).push(cap);

  const permissionUi = Object.entries(groups)
    .map(
      ([group, caps]) => `
      <div class="perm-group">
        <div class="perm-group-title">${esc(group)}</div>
        ${caps
          .map(
            (cap) => `
          <label class="checkbox-row perm-row">
            <input type="checkbox" data-cap="${esc(cap.id)}" ${held.has(cap.id) ? 'checked' : ''} />
            <span>${esc(cap.label)}</span>
          </label>`
          )
          .join('')}
      </div>`
    )
    .join('');

  const modal = openModal({
    title: editing ? `Edit ${user.username}` : 'New user',
    width: 640,
    body: `
      <div class="form-grid">
        <label><span>Username</span><input id="u-name" value="${esc(user?.username || '')}" ${
      editing ? 'disabled' : ''
    } /></label>
        <label><span>${
          editing ? 'New password (blank keeps it)' : 'Password'
        }</span><input id="u-pass" type="password" autocomplete="new-password" /></label>
      </div>

      <label><span>Role</span>
        <select id="u-role">
          <option value="user" ${user?.role === 'user' || !editing ? 'selected' : ''}>User — only what you allow below</option>
          <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Administrator — full access to everything</option>
        </select>
      </label>

      <div id="u-scoped" class="${user?.role === 'admin' ? 'hidden' : ''}">
        <label><span>Assigned servers</span>
          <select id="u-servers" multiple size="${Math.min(6, Math.max(3, state.servers.length))}">
            ${state.servers
              .map(
                (s) =>
                  `<option value="${esc(s.id)}" ${user?.servers?.includes(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`
              )
              .join('')}
          </select>
          <div class="hint">Hold ⌘/Ctrl to pick several. This user sees nothing else.</div>
        </label>

        <div class="row" style="margin:16px 0 8px">
          <span class="field-label" style="margin:0">Permissions</span>
          <div style="flex:1"></div>
          <button type="button" class="btn btn-sm" id="u-all">Select all</button>
          <button type="button" class="btn btn-sm" id="u-none">Clear</button>
        </div>
        <div class="perm-grid">${permissionUi}</div>
      </div>

      <div id="u-admin-note" class="hint ${user?.role === 'admin' ? '' : 'hidden'}">
        Administrators hold every permission on every server, including panel settings,
        user management and updates — which is effectively shell access on this machine.
      </div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async (btn) => {
          const body = {
            username: $('#u-name').value.trim(),
            role: $('#u-role').value,
            servers: [...$('#u-servers').selectedOptions].map((o) => o.value),
            permissions: [...document.querySelectorAll('[data-cap]')].filter((c) => c.checked).map((c) => c.dataset.cap),
          };
          const password = $('#u-pass').value;
          if (password) body.password = password;
          btn.disabled = true;
          try {
            if (editing) await api(`/api/users/${user.id}`, { method: 'PATCH', body });
            else await api('/api/users', { method: 'POST', body });
            modal.close();
            toast('Saved');
            render();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });

  // Role switch hides the per-server scoping, since admins bypass all of it.
  const roleSelect = $('#u-role');
  roleSelect.addEventListener('change', () => {
    const isAdmin = roleSelect.value === 'admin';
    $('#u-scoped').classList.toggle('hidden', isAdmin);
    $('#u-admin-note').classList.toggle('hidden', !isAdmin);
  });

  const setAll = (checked) =>
    document.querySelectorAll('[data-cap]').forEach((box) => {
      box.checked = checked;
    });
  $('#u-all').addEventListener('click', () => setAll(true));
  $('#u-none').addEventListener('click', () => setAll(false));

  return modal;
}

/* -------------------------------------------------------------- settings */

async function renderSettings(view) {
  setCrumbs('Settings');
  const data = await api('/api/settings').catch((err) => ({ settings: {}, error: err.message }));
  const s = data.settings;
  const integrations = s.integrations || {};
  view.innerHTML = `
    <div class="page-head"><h1>Panel settings</h1></div>

    <div class="card mb-16" id="update-card">
      <h4 style="margin:0 0 6px">Panel updates</h4>
      <p class="faint" style="margin:0 0 14px">
        Updates pull the latest code and restart the panel. Servers running in containers keep running —
        the panel re-attaches to them when it comes back.
      </p>
      <div class="row"><button class="btn" id="update-check">Check for updates</button>
        <span id="update-status" class="faint"></span></div>
      <div id="update-detail" class="mt-16"></div>
    </div>

    <div class="card mb-16">
      <h4 style="margin:0 0 6px">Runtime</h4>
      <div id="runtime-info" class="faint" style="margin-bottom:12px">Checking Docker…</div>
      <div class="checkbox-row"><input type="checkbox" id="s-containerize" ${
        s.containerize !== false ? 'checked' : ''
      } /><label for="s-containerize">Run each game server in its own container (isolation, hard memory/CPU limits, per-server network stats)</label></div>
      <div class="hint">Applies the next time a server starts. Without Docker the panel falls back to plain processes.</div>
    </div>

    <div class="card mb-16">
      <h4 style="margin:0 0 6px">Integrations</h4>
      <p class="faint" style="margin:0 0 14px">Optional API keys for the mod browser. Modrinth and uMod work without any key.</p>
      <div class="form-grid">
        <label><span>CurseForge API key</span><input id="i-curseforge" type="password" value="${esc(
          integrations.curseforgeKey || ''
        )}" placeholder="console.curseforge.com" /></label>
        <label><span>Steam Web API key</span><input id="i-steam" type="password" value="${esc(
          integrations.steamApiKey || ''
        )}" placeholder="steamcommunity.com/dev/apikey" /></label>
        <label><span>Factorio username</span><input id="i-factorio-user" value="${esc(
          integrations.factorio?.username || ''
        )}" /></label>
        <label><span>Factorio token</span><input id="i-factorio-token" type="password" value="${esc(
          integrations.factorio?.token || ''
        )}" /></label>
      </div>
      <button class="btn mt-16" id="i-save">Save integrations</button>
    </div>

    <div class="card mb-16">
      <h4 style="margin:0 0 14px">General</h4>
      <div class="form-grid">
        <label><span>Panel name</span><input id="s-name" value="${esc(s.panelName || 'GamePanel')}" /></label>
        <label><span>Port range start</span><input id="s-port-start" type="number" value="${s.portRangeStart}" /></label>
        <label><span>Port range end</span><input id="s-port-end" type="number" value="${s.portRangeEnd}" /></label>
        <label><span>Max crash restarts (per 10 min)</span><input id="s-max-crash" type="number" value="${s.maxCrashRestarts}" /></label>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="s-autorestart" ${s.autoRestart ? 'checked' : ''} /><label for="s-autorestart">Enable crash auto-restart globally</label></div>
      <div class="checkbox-row"><input type="checkbox" id="s-geo" ${
        s.geoLookup !== false ? 'checked' : ''
      } /><label for="s-geo">Show sign-in locations in the activity log</label></div>
      <div class="hint">Looks public sign-in IPs up via ipwho.is. Private and LAN addresses are labelled locally and never leave the machine.</div>
      <button class="btn btn-primary mt-16" id="s-save">Save settings</button>
    </div>

    <div class="card mb-16">
      <h4 style="margin:0 0 14px">Change your password</h4>
      <div class="form-grid">
        <label><span>Current password</span><input id="p-current" type="password" autocomplete="current-password" /></label>
        <label><span>New password</span><input id="p-new" type="password" autocomplete="new-password" /></label>
      </div>
      <button class="btn mt-16" id="p-save">Update password</button>
    </div>

    <div class="card">
      <h4 style="margin:0 0 14px">System</h4>
      <div class="table-wrap"><table>
        <tr><th>Panel version</th><td>v${esc(state.version || '')}</td></tr>
        <tr><th>Host</th><td>${esc(state.host?.hostname || '')} · ${esc(state.host?.platform || '')}</td></tr>
        <tr><th>CPU</th><td>${esc(state.host?.cpu.model || '')} (${state.host?.cpu.cores} cores)</td></tr>
        <tr><th>Memory</th><td>${fmtBytes(state.host?.memory.total)}</td></tr>
        <tr><th>Uptime</th><td>${fmtDuration((state.host?.uptime || 0) * 1000)}</td></tr>
        <tr><th>Templates loaded</th><td>${state.templates.length}</td></tr>
      </table></div>
      <button class="btn mt-16" id="s-reload-templates">Reload templates</button>
    </div>`;

  // Runtime status
  api('/api/system/runtime')
    .then((data) => {
      const el = $('#runtime-info');
      if (!el) return;
      el.innerHTML = data.docker.available
        ? `Docker ${esc(data.docker.info?.version || '')} detected — servers run isolated in containers.`
        : `Docker not found at <span class="mono">${esc(
            data.docker.socket
          )}</span>. Servers run as plain processes and share the host. Install Docker and restart the panel for isolation.`;
    })
    .catch(() => {});

  $('#s-containerize').addEventListener('change', async (event) => {
    try {
      await api('/api/settings', { method: 'PATCH', body: { containerize: event.target.checked } });
      toast(event.target.checked ? 'Containers enabled for new starts' : 'Containers disabled');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#i-save').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: {
          integrations: {
            curseforgeKey: $('#i-curseforge').value,
            steamApiKey: $('#i-steam').value,
            factorio: { username: $('#i-factorio-user').value, token: $('#i-factorio-token').value },
          },
        },
      });
      toast('Integrations saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#update-check').addEventListener('click', () => checkForUpdates(true));
  checkForUpdates(false);

  $('#s-save').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: {
          panelName: $('#s-name').value,
          portRangeStart: Number($('#s-port-start').value),
          portRangeEnd: Number($('#s-port-end').value),
          maxCrashRestarts: Number($('#s-max-crash').value),
          autoRestart: $('#s-autorestart').checked,
          geoLookup: $('#s-geo').checked,
        },
      });
      $('#brand-name').textContent = $('#s-name').value;
      toast('Settings saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#p-save').addEventListener('click', async () => {
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: $('#p-current').value, newPassword: $('#p-new').value },
      });
      toast('Password updated');
      $('#p-current').value = '';
      $('#p-new').value = '';
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#s-reload-templates').addEventListener('click', async () => {
    const data = await api('/api/templates/reload', { method: 'POST', body: {} });
    await loadTemplates();
    toast(`${data.count} templates loaded`);
  });
}

/* --------------------------------------------------------------- updates */

async function checkForUpdates(interactive) {
  const status = $('#update-status');
  const detail = $('#update-detail');
  if (!status) return;
  status.innerHTML = '<span class="spinner"></span> Checking…';
  detail.innerHTML = '';

  let data;
  try {
    data = await api('/api/system/update');
  } catch (err) {
    status.textContent = err.message;
    return;
  }

  if (!data.supported) {
    status.textContent = data.reason;
    return;
  }
  if (data.error) {
    status.textContent = data.error;
    return;
  }

  const current = data.current ? `${data.current.commit} · ${fmtTime(Date.parse(data.current.date))}` : 'unknown';
  if (!data.updateAvailable) {
    status.innerHTML = `Up to date — v${esc(data.version)} (${esc(current)})`;
    return;
  }

  status.innerHTML = `<b>${data.behind} update${data.behind === 1 ? '' : 's'} available</b> — you are on ${esc(current)}`;
  detail.innerHTML = `
    <div class="card" style="background:rgba(74,222,128,.06)">
      <div class="table-wrap"><table>
        ${data.commits
          .map(
            (c) => `<tr><td class="mono faint nowrap" style="width:80px">${esc(c.commit)}</td>
                      <td>${esc(c.subject)}</td>
                      <td class="faint nowrap">${fmtTime(Date.parse(c.date))}</td></tr>`
          )
          .join('')}
      </table></div>
      <button class="btn btn-primary mt-16" id="update-apply">Update and restart</button>
    </div>`;

  $('#update-apply').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    if (!(await confirmModal('Update the panel', 'The panel will restart. Containerised game servers keep running; plain processes are stopped and restarted.', 'Update'))) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Updating…';
    try {
      const result = await api('/api/system/update', { method: 'POST', body: {} });
      detail.innerHTML = `<div class="card">Updated ${esc(result.from)} → ${esc(result.to)}. Waiting for the panel to come back…</div>`;
      waitForPanel();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Update and restart';
    }
  });
}

/** Poll /api/status after an update until the new panel answers, then reload. */
function waitForPanel(attempt = 0) {
  setTimeout(async () => {
    try {
      await api('/api/status');
      toast('Panel updated — reloading');
      setTimeout(() => location.reload(), 800);
    } catch {
      if (attempt < 40) waitForPanel(attempt + 1);
      else toast('The panel did not come back. Check: journalctl -u gamepanel -n 50', 'error', 15000);
    }
  }, 2000);
}

/* ---------------------------------------------------------------- modals */

function openModal({ title, body, actions = [], width = 620 }) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" style="width:min(${width}px,100%)">
      <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"></div>
    </div>`;
  root.appendChild(backdrop);

  const api = {
    close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
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

  const firstInput = backdrop.querySelector('input, textarea, select');
  firstInput?.focus();
  return api;
}

function confirmModal(title, message, confirmLabel = 'Confirm') {
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

function promptModal(title, label, value = '') {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      width: 440,
      body: `<label><span>${esc(label)}</span><input id="prompt-input" value="${esc(value)}" /></label>`,
      actions: [
        { label: 'Cancel', onClick: () => { modal.close(); resolve(null); } },
        {
          label: 'OK',
          primary: true,
          onClick: () => {
            const result = $('#prompt-input').value.trim();
            modal.close();
            resolve(result || null);
          },
        },
      ],
    });
    $('#prompt-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const result = $('#prompt-input').value.trim();
        modal.close();
        resolve(result || null);
      }
    });
  });
}

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

/**
 * navigator.clipboard only exists on secure origins, and the panel is usually
 * reached over plain http on a LAN address — so fall back to the old
 * execCommand path instead of silently doing nothing.
 */
async function copyToClipboard(text, sourceEl) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }

  if (!ok) {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(scratch);
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    scratch.remove();
  }

  if (ok) {
    toast(`Copied ${text}`);
    // Brief inline confirmation on the element itself.
    if (sourceEl && !sourceEl.dataset.copying) {
      const original = sourceEl.textContent;
      sourceEl.dataset.copying = '1';
      sourceEl.classList.add('copied');
      sourceEl.textContent = 'Copied';
      setTimeout(() => {
        sourceEl.textContent = original;
        sourceEl.classList.remove('copied');
        delete sourceEl.dataset.copying;
      }, 1100);
    }
  } else if (sourceEl) {
    // Last resort: select it so the user only has to press Ctrl+C.
    const range = document.createRange();
    range.selectNodeContents(sourceEl);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('Selected the address — press Ctrl+C to copy', 'warn');
  } else {
    toast('Could not copy to the clipboard', 'warn');
  }
}

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

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('gp-theme', theme);
  const el = $('#theme-icon');
  if (el) el.outerHTML = icon(theme === 'dark' ? 'moon' : 'sun', 15).replace('<svg', '<svg id="theme-icon"');
  // Canvas charts are painted, not styled — redraw them for the new palette.
  if (state.route.name === 'dashboard') drawHostCharts();
  if (state.route.name === 'server' && state.route.params.tab === 'metrics') drawServerCharts(state.route.params.id);
}

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

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('show');
}

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
