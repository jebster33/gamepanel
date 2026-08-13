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

function statusPill(status) {
  return `<span class="status ${esc(status)}"><i class="dot"></i>${esc(STATUS_LABEL[status] || status)}</span>`;
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

  await Promise.all([loadServers(), loadTemplates(), loadSystem()]);
  connectWebSocket();
  renderSidebarServers();
  handleRoute();
}

async function loadServers() {
  const data = await api('/api/servers');
  state.servers = data.servers;
}

async function loadTemplates() {
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
  gradient.addColorStop(0, color + '55');
  gradient.addColorStop(1, color + '00');
  ctx.fillStyle = gradient;
  ctx.fill(fill);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
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
      <div class="bar" style="flex:1"><i style="width:${host.cpu.percent.toFixed(0)}%"></i></div>
      <span class="value">${host.cpu.percent.toFixed(0)}%</span></div>
    <div class="host-mini-row"><span class="label">RAM</span>
      <div class="bar blue" style="flex:1"><i style="width:${memPct.toFixed(0)}%"></i></div>
      <span class="value">${memPct.toFixed(0)}%</span></div>
    <div class="host-mini-row"><span class="label">Disk</span>
      <div class="bar amber" style="flex:1"><i style="width:${diskPct.toFixed(0)}%"></i></div>
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
      view.innerHTML = '<div class="empty"><div class="big">🤔</div><h3>Page not found</h3></div>';
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

    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">CPU</div>
        <div class="stat-value" data-host="cpu">${(host?.cpu.percent ?? 0).toFixed(0)}<span class="unit">%</span></div>
        <div class="stat-sub" data-host="cpu-sub">${host?.cpu.cores ?? 0} cores · load ${(host?.load?.[0] ?? 0).toFixed(2)}</div>
        <canvas id="chart-host-cpu"></canvas>
      </div>
      <div class="stat">
        <div class="stat-label">Memory</div>
        <div class="stat-value" data-host="mem">${memPct.toFixed(0)}<span class="unit">%</span></div>
        <div class="stat-sub" data-host="mem-sub">${fmtBytes(host?.memory.used)} of ${fmtBytes(host?.memory.total)}</div>
        <canvas id="chart-host-mem"></canvas>
      </div>
      <div class="stat">
        <div class="stat-label">Network</div>
        <div class="stat-value" data-host="net" style="font-size:20px">
          ↓ ${fmtRate(host?.network.rxBytesPerSec)} · ↑ ${fmtRate(host?.network.txBytesPerSec)}
        </div>
        <div class="stat-sub">Total ${fmtBytes(host?.network.rxTotal)} in / ${fmtBytes(host?.network.txTotal)} out</div>
        <canvas id="chart-host-net"></canvas>
      </div>
      <div class="stat">
        <div class="stat-label">Disk</div>
        <div class="stat-value">${diskPct.toFixed(0)}<span class="unit">%</span></div>
        <div class="stat-sub">${fmtBytes(host?.disk.free)} free of ${fmtBytes(host?.disk.total)}</div>
        <div class="bar amber"><i style="width:${diskPct.toFixed(0)}%"></i></div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">Servers online</div>
        <div class="stat-value" data-ov="running">${overview.running} <span class="unit">/ ${overview.total}</span></div>
      </div>
      <div class="stat">
        <div class="stat-label">Players connected</div>
        <div class="stat-value" data-ov="players">${overview.players}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Crashes recorded</div>
        <div class="stat-value" data-ov="crashes">${overview.crashes}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Panel version</div>
        <div class="stat-value" style="font-size:20px">v${esc(state.version || '1.0.0')}</div>
        <div class="stat-sub">Node ${esc(navigator.hardwareConcurrency || '')} threads client-side</div>
      </div>
    </div>

    <h2 class="section-title">Servers</h2>
    <div class="server-grid" id="server-grid">${renderServerCards()}</div>`;

  drawHostCharts();
}

function drawHostCharts() {
  drawChart($('#chart-host-cpu'), state.hostHistory.cpu, { color: '#4ade80', max: 100, grid: false, pad: 0 });
  drawChart($('#chart-host-mem'), state.hostHistory.mem, { color: '#60a5fa', max: 100, grid: false, pad: 0 });
  drawChart($('#chart-host-net'), state.hostHistory.net, { color: '#a78bfa', grid: false, pad: 0 });
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
    set('[data-ov="running"]', `${overview.running} <span class="unit">/ ${overview.total}</span>`);
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
    return `<div class="empty" style="grid-column:1/-1">
      <div class="big">🎮</div>
      <h3>No servers yet</h3>
      <p>Pick a template and have a game server running in a couple of minutes.</p>
      <a class="btn btn-primary mt-16" href="#/templates">Browse templates</a>
    </div>`;
  }
  return state.servers.map(serverCard).join('');
}

function serverCard(server) {
  const memPct = server.memoryLimit ? Math.min(100, (server.memory / server.memoryLimit) * 100) : 0;
  const cpuPct = Math.min(100, server.cpu || 0);
  const running = server.status === 'running';
  return `
  <div class="server-card" data-card="${esc(server.id)}">
    <div class="head">
      <div class="server-icon">${esc(server.templateIcon || '🎮')}</div>
      <div class="title">
        <h3><a href="#/servers/${esc(server.id)}">${esc(server.name)}</a></h3>
        <div class="sub">${esc(server.templateName)}</div>
      </div>
      <span data-field="status">${statusPill(server.status)}</span>
    </div>

    <div class="metrics-row">
      <div class="metric"><div class="k">CPU</div><div class="v" data-field="cpu">${cpuPct.toFixed(0)}<small>%</small></div></div>
      <div class="metric"><div class="k">RAM</div><div class="v" data-field="mem">${fmtBytes(server.memory)}</div></div>
      <div class="metric"><div class="k">Players</div><div class="v" data-field="players">${
        server.players ?? '—'
      }<small>${server.maxPlayers ? '/' + server.maxPlayers : ''}</small></div></div>
      <div class="metric"><div class="k">Ping</div><div class="v" data-field="ping">${
        server.ping != null ? server.ping + '<small>ms</small>' : '—'
      }</div></div>
    </div>

    <div class="bar"><i data-field="cpu-bar" style="width:${cpuPct.toFixed(0)}%"></i></div>
    <div class="bar blue"><i data-field="mem-bar" style="width:${memPct.toFixed(0)}%"></i></div>

    <div class="row">
      <span class="address" data-copy="${esc(serverAddress(server))}" title="Click to copy">${esc(serverAddress(server))}</span>
      <span class="faint" style="font-size:12px" data-field="uptime">${running ? 'up ' + fmtDuration(server.uptime) : ''}</span>
    </div>

    <div class="card-actions">
      ${
        running || server.status === 'starting'
          ? `<button class="btn btn-sm btn-warn" data-power="restart" data-id="${esc(server.id)}">↻ Restart</button>
             <button class="btn btn-sm btn-danger" data-power="stop" data-id="${esc(server.id)}">■ Stop</button>`
          : `<button class="btn btn-sm btn-primary" data-power="start" data-id="${esc(server.id)}" ${
              ['installing', 'stopping'].includes(server.status) ? 'disabled' : ''
            }>▶ Start</button>`
      }
      <a class="btn btn-sm" href="#/servers/${esc(server.id)}/console">⌨ Console</a>
      <a class="btn btn-sm" href="#/servers/${esc(server.id)}/files">📁 Files</a>
    </div>
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
    const cpuPct = Math.min(100, server.cpu || 0);
    const memPct = server.memoryLimit ? Math.min(100, (server.memory / server.memoryLimit) * 100) : 0;
    set('cpu', `${cpuPct.toFixed(0)}<small>%</small>`);
    set('mem', fmtBytes(server.memory));
    set('players', `${server.players ?? '—'}<small>${server.maxPlayers ? '/' + server.maxPlayers : ''}</small>`);
    set('ping', server.ping != null ? `${server.ping}<small>ms</small>` : '—');
    set('uptime', server.status === 'running' ? 'up ' + fmtDuration(server.uptime) : '');
    const cpuBar = card.querySelector('[data-field="cpu-bar"]');
    if (cpuBar) cpuBar.style.width = `${cpuPct.toFixed(0)}%`;
    const memBar = card.querySelector('[data-field="mem-bar"]');
    if (memBar) memBar.style.width = `${memPct.toFixed(0)}%`;
  }
}

function renderServers(view) {
  setCrumbs('Servers');
  view.innerHTML = `
    <div class="page-head">
      <h1>Servers</h1>
      <div class="spacer"></div>
      ${state.user.role === 'admin' ? '<a class="btn btn-primary" href="#/templates">+ New server</a>' : ''}
    </div>
    <div class="server-grid">${renderServerCards()}</div>`;
}

/* --------------------------------------------------------- server detail */

const SERVER_TABS = [
  ['console', '⌨ Console'],
  ['metrics', '📈 Metrics'],
  ['files', '📁 Files'],
  ['backups', '💾 Backups'],
  ['settings', '⚙ Settings'],
];

function currentServer() {
  return state.servers.find((s) => s.id === state.route.params.id);
}

function renderServerDetail(view) {
  const server = currentServer();
  if (!server) {
    view.innerHTML = '<div class="empty"><div class="big">🔍</div><h3>Server not found</h3><a href="#/servers">Back to servers</a></div>';
    return;
  }
  const tab = state.route.params.tab || 'console';
  setCrumbs(`<a href="#/servers">Servers</a> <span class="dim">/</span> ${esc(server.name)}`);

  view.innerHTML = `
    <div class="page-head">
      <div class="server-icon">${esc(server.templateIcon)}</div>
      <div>
        <h1>${esc(server.name)}</h1>
        <div class="row" style="margin-top:4px">
          <span id="detail-status">${statusPill(server.status)}</span>
          <span class="address" data-copy="${esc(serverAddress(server))}">${esc(serverAddress(server))}</span>
          <span class="faint" style="font-size:12.5px" id="detail-uptime">${
            server.status === 'running' ? 'up ' + fmtDuration(server.uptime) : ''
          }</span>
        </div>
      </div>
      <div class="spacer"></div>
      <div class="row" id="detail-power">${powerButtons(server)}</div>
    </div>

    <div class="metrics-row mb-16" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="metric"><div class="k">CPU</div><div class="v" data-detail="cpu">${(server.cpu || 0).toFixed(1)}<small>%</small></div></div>
      <div class="metric"><div class="k">Memory</div><div class="v" data-detail="mem">${fmtBytes(server.memory)}<small> / ${fmtBytes(
        server.memoryLimit
      )}</small></div></div>
      <div class="metric"><div class="k">Players</div><div class="v" data-detail="players">${server.players ?? '—'}<small>${
        server.maxPlayers ? '/' + server.maxPlayers : ''
      }</small></div></div>
      <div class="metric"><div class="k">Ping</div><div class="v" data-detail="ping">${
        server.ping != null ? server.ping + '<small>ms</small>' : '—'
      }</div></div>
      <div class="metric"><div class="k">Connections</div><div class="v" data-detail="conns">${server.connections ?? 0}</div></div>
      <div class="metric"><div class="k">Disk</div><div class="v" data-detail="disk">${fmtBytes(server.diskBytes)}</div></div>
      <div class="metric"><div class="k">Crashes</div><div class="v" data-detail="crashes">${server.crashCount || 0}</div></div>
    </div>

    <div class="tabs">
      ${SERVER_TABS.map(
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
        ? `<button class="btn btn-warn" data-power="restart" data-id="${esc(server.id)}">↻ Restart</button>
           <button class="btn btn-danger" data-power="stop" data-id="${esc(server.id)}">■ Stop</button>
           <button class="btn btn-danger" data-power="kill" data-id="${esc(server.id)}" title="Force kill">✖</button>`
        : `<button class="btn btn-primary" data-power="start" data-id="${esc(server.id)}" ${busy ? 'disabled' : ''}>▶ Start</button>`
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
  set('cpu', `${(server.cpu || 0).toFixed(1)}<small>%</small>`);
  set('mem', `${fmtBytes(server.memory)}<small> / ${fmtBytes(server.memoryLimit)}</small>`);
  set('players', `${server.players ?? '—'}<small>${server.maxPlayers ? '/' + server.maxPlayers : ''}</small>`);
  set('ping', server.ping != null ? `${server.ping}<small>ms</small>` : '—');
  set('conns', String(server.connections ?? 0));
  set('crashes', String(server.crashCount || 0));
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

function appendConsoleLines(lines, replace = false) {
  const el = $('#console');
  if (lines.length) {
    const lastSeq = lines[lines.length - 1].seq;
    if (state.route.params.id) state.consoleSeq.set(state.route.params.id, lastSeq);
  }
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  const html = lines.map((l) => `<div class="l ${esc(l.stream)}">${esc(l.line)}</div>`).join('');
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
  drawChart($('#chart-cpu'), hist.cpu, { color: '#4ade80' });
  drawChart($('#chart-mem'), hist.mem, { color: '#60a5fa' });
  drawChart($('#chart-players'), hist.players, { color: '#fbbf24' });
  drawChart($('#chart-ping'), hist.ping, { color: '#a78bfa' });
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

  host.innerHTML = `
    <div class="row mb-16">
      <div class="file-path">${crumbs.join(' ')}</div>
      <div class="spacer" style="flex:1"></div>
      <button class="btn btn-sm" id="file-new-folder">+ Folder</button>
      <button class="btn btn-sm" id="file-new-file">+ File</button>
      <button class="btn btn-sm" id="file-upload">⬆ Upload</button>
      <input type="file" id="file-input" class="hidden" multiple />
    </div>
    <div class="card" style="padding:0">
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th class="nowrap">Size</th><th class="nowrap">Modified</th><th></th></tr></thead>
        <tbody>
          ${
            parts.length
              ? `<tr><td colspan="4"><a data-dir="${esc(parts.slice(0, -1).join('/'))}">📁 ..</a></td></tr>`
              : ''
          }
          ${data.items
            .map(
              (item) => `
            <tr>
              <td><span class="file-name" data-${item.directory ? 'dir' : 'file'}="${esc(item.path)}">
                ${item.directory ? '📁' : item.editable ? '📄' : '📦'} ${esc(item.name)}</span></td>
              <td class="faint nowrap">${item.directory ? '—' : fmtBytes(item.size)}</td>
              <td class="faint nowrap">${fmtTime(item.modified)}</td>
              <td class="nowrap" style="text-align:right">
                ${
                  item.directory
                    ? ''
                    : `<a class="btn btn-sm" href="/api/servers/${esc(server.id)}/files/download?path=${encodeURIComponent(
                        item.path
                      )}">⬇</a>`
                }
                <button class="btn btn-sm btn-danger" data-delete="${esc(item.path)}">🗑</button>
              </td>
            </tr>`
            )
            .join('')}
          ${data.items.length ? '' : '<tr><td colspan="4" class="faint">This folder is empty</td></tr>'}
        </tbody>
      </table></div>
    </div>`;

  host.querySelectorAll('[data-dir]').forEach((el) =>
    el.addEventListener('click', () => renderFilesTab(host, server, el.dataset.dir))
  );
  host.querySelectorAll('[data-file]').forEach((el) =>
    el.addEventListener('click', () => openFileEditor(server, el.dataset.file, () => renderFilesTab(host, server, dirPath)))
  );
  host.querySelectorAll('[data-delete]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete file', `Delete “${el.dataset.delete}”? This cannot be undone.`))) return;
      try {
        await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(el.dataset.delete)}`, { method: 'DELETE' });
        toast('Deleted');
        renderFilesTab(host, server, dirPath);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  $('#file-new-folder').addEventListener('click', async () => {
    const name = await promptModal('New folder', 'Folder name');
    if (!name) return;
    await api(`/api/servers/${server.id}/files/mkdir`, { method: 'POST', body: { path: joinPath(dirPath, name) } });
    renderFilesTab(host, server, dirPath);
  });

  $('#file-new-file').addEventListener('click', async () => {
    const name = await promptModal('New file', 'File name');
    if (!name) return;
    await api(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(joinPath(dirPath, name))}`, {
      method: 'PUT',
      body: { content: '' },
    });
    renderFilesTab(host, server, dirPath);
  });

  $('#file-upload').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (event) => {
    for (const file of event.target.files) {
      try {
        const res = await fetch(
          `/api/servers/${server.id}/files/upload?path=${encodeURIComponent(joinPath(dirPath, file.name))}`,
          { method: 'POST', body: file, credentials: 'same-origin' }
        );
        if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
        toast(`Uploaded ${file.name}`);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    renderFilesTab(host, server, dirPath);
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
    title: `📄 ${filePath}`,
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

/* --------------------------------------------------------------- backups */

async function renderBackupsTab(host, server) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading backups…</div>';
  const data = await api(`/api/servers/${server.id}/backups`).catch((err) => ({ backups: [], error: err.message }));

  host.innerHTML = `
    <div class="row mb-16">
      <button class="btn btn-primary" id="backup-create">💾 Create backup</button>
      <span class="faint">Backups are plain .tar.gz archives of the whole server directory.</span>
    </div>
    <div class="card" style="padding:0">
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
                        <a class="btn btn-sm" href="/api/servers/${esc(server.id)}/backups/${encodeURIComponent(b.name)}/download">⬇</a>
                        <button class="btn btn-sm btn-warn" data-restore="${esc(b.name)}">↺ Restore</button>
                        <button class="btn btn-sm btn-danger" data-del-backup="${esc(b.name)}">🗑</button>
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
      btn.textContent = '💾 Create backup';
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
  const isAdmin = state.user.role === 'admin';
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
      isAdmin
        ? `<div class="card">
             <h4 style="margin:0 0 6px">Danger zone</h4>
             <p class="faint" style="margin:0 0 14px">Reinstalling re-runs the template installer in place. Deleting removes the server and all of its files.</p>
             <div class="row">
               <button class="btn btn-warn" id="set-reinstall">↻ Reinstall</button>
               <button class="btn btn-danger" id="set-delete">🗑 Delete server</button>
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
    <div class="template-grid">
      ${
        filtered.length
          ? filtered
              .map(
                (tpl) => `
        <div class="template-card" data-template="${esc(tpl.id)}">
          <div class="t-head">
            <span class="t-icon">${esc(tpl.icon || '🎮')}</span>
            <div>
              <h3>${esc(tpl.name)}</h3>
              <div class="t-cat">${esc(tpl.category || 'Other')}${tpl.custom ? ' · custom' : ''}</div>
            </div>
          </div>
          <p>${esc(tpl.description || '')}</p>
          <div class="row" style="margin-top:auto">
            <span class="badge">${esc(Object.keys(tpl.ports || {}).length ? '' : '')}${(tpl.ports || [])
                  .map((p) => p.default)
                  .join(' · ')}</span>
            ${state.user.role === 'admin' ? '<button class="btn btn-sm btn-primary" style="margin-left:auto">Deploy →</button>' : ''}
          </div>
        </div>`
              )
              .join('')
          : '<div class="empty" style="grid-column:1/-1"><div class="big">🔍</div><h3>No templates match</h3></div>'
      }
    </div>`;

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

function openCreateServerModal(templateId) {
  const template = state.templates.find((t) => t.id === templateId) || state.templates[0];
  if (!template) return toast('No templates available', 'error');

  const variableFields = (template.variables || [])
    .map((v) => {
      const id = `var-${v.name}`;
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
    })
    .join('');

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
        <label><span>Memory limit (MB)</span><input id="new-memory" type="number" value="${template.defaultMemory || 2048}" /></label>
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
}

/* -------------------------------------------------------------- activity */

async function renderActivity(view) {
  setCrumbs('Activity');
  view.innerHTML = '<div class="card"><span class="spinner"></span> Loading…</div>';
  const data = await api('/api/events?limit=200').catch(() => ({ events: [] }));
  const icons = {
    'server.crashed': '💥',
    'server.started': '▶️',
    'server.created': '✨',
    'server.deleted': '🗑️',
    'server.installed': '📦',
    'server.install_failed': '⚠️',
    'backup.created': '💾',
    'backup.restored': '↺',
    'user.login': '🔑',
    'user.created': '👤',
  };
  view.innerHTML = `
    <div class="page-head"><h1>Activity</h1></div>
    <div class="card" style="padding:0">
      <div class="table-wrap"><table>
        <thead><tr><th></th><th>Event</th><th>Server</th><th class="nowrap">When</th></tr></thead>
        <tbody>
          ${
            data.events.length
              ? data.events
                  .map((e) => {
                    const server = state.servers.find((s) => s.id === e.serverId);
                    return `<tr>
                      <td style="width:32px">${icons[e.type] || '•'}</td>
                      <td>${esc(e.message)}</td>
                      <td>${server ? `<a href="#/servers/${esc(server.id)}">${esc(server.name)}</a>` : '<span class="faint">—</span>'}</td>
                      <td class="faint nowrap">${fmtTime(e.at)}</td>
                    </tr>`;
                  })
                  .join('')
              : '<tr><td colspan="4" class="faint">Nothing has happened yet</td></tr>'
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
      <button class="btn btn-primary" id="user-new">+ Add user</button>
    </div>
    <div class="card" style="padding:0">
      <div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Role</th><th>Servers</th><th>Last login</th><th></th></tr></thead>
        <tbody>
          ${data.users
            .map(
              (u) => `<tr>
                <td><strong>${esc(u.username)}</strong></td>
                <td><span class="badge ${u.role === 'admin' ? 'admin' : ''}">${esc(u.role)}</span></td>
                <td class="faint">${u.role === 'admin' ? 'All servers' : (u.servers || []).length + ' assigned'}</td>
                <td class="faint nowrap">${fmtTime(u.lastLogin)}</td>
                <td style="text-align:right" class="nowrap">
                  <button class="btn btn-sm" data-edit-user="${esc(u.id)}">Edit</button>
                  ${u.id !== state.user.id ? `<button class="btn btn-sm btn-danger" data-del-user="${esc(u.id)}">🗑</button>` : ''}
                </td></tr>`
            )
            .join('')}
        </tbody>
      </table></div>
    </div>`;

  $('#user-new').addEventListener('click', () => openUserModal(null, data.users));
  view.querySelectorAll('[data-edit-user]').forEach((el) =>
    el.addEventListener('click', () => openUserModal(data.users.find((u) => u.id === el.dataset.editUser), data.users))
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

function openUserModal(user) {
  const editing = Boolean(user);
  const modal = openModal({
    title: editing ? `Edit ${user.username}` : 'Add user',
    body: `
      <label><span>Username</span><input id="u-name" value="${esc(user?.username || '')}" ${editing ? 'disabled' : ''} /></label>
      <label><span>${editing ? 'New password (leave blank to keep)' : 'Password'}</span><input id="u-pass" type="password" autocomplete="new-password" /></label>
      <label><span>Role</span>
        <select id="u-role">
          <option value="user" ${user?.role === 'user' ? 'selected' : ''}>User — only assigned servers</option>
          <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Administrator — full access</option>
        </select>
      </label>
      <label><span>Assigned servers</span>
        <select id="u-servers" multiple size="${Math.min(6, Math.max(3, state.servers.length))}">
          ${state.servers
            .map((s) => `<option value="${esc(s.id)}" ${user?.servers?.includes(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`)
            .join('')}
        </select>
        <div class="hint">Ignored for administrators, who always see every server.</div>
      </label>`,
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
}

/* -------------------------------------------------------------- settings */

async function renderSettings(view) {
  setCrumbs('Settings');
  const data = await api('/api/settings').catch((err) => ({ settings: {}, error: err.message }));
  const s = data.settings;
  view.innerHTML = `
    <div class="page-head"><h1>Panel settings</h1></div>
    <div class="card mb-16">
      <h4 style="margin:0 0 14px">General</h4>
      <div class="form-grid">
        <label><span>Panel name</span><input id="s-name" value="${esc(s.panelName || 'GamePanel')}" /></label>
        <label><span>Port range start</span><input id="s-port-start" type="number" value="${s.portRangeStart}" /></label>
        <label><span>Port range end</span><input id="s-port-end" type="number" value="${s.portRangeEnd}" /></label>
        <label><span>Max crash restarts (per 10 min)</span><input id="s-max-crash" type="number" value="${s.maxCrashRestarts}" /></label>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="s-autorestart" ${s.autoRestart ? 'checked' : ''} /><label for="s-autorestart">Enable crash auto-restart globally</label></div>
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
      <button class="btn mt-16" id="s-reload-templates">↻ Reload templates from disk</button>
    </div>`;

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
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy).then(
      () => toast('Address copied'),
      () => {}
    );
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
  document.body.innerHTML = `<div class="empty"><div class="big">⚠️</div><h3>GamePanel could not start</h3><p>${esc(
    err.message
  )}</p></div>`;
});
