import { api } from './api.js';
import { render } from './router.js';
import { state } from './state.js';
import { $ } from './util.js';
import { patchDashboard } from '../pages/dashboard.js';
import { appendConsoleLines, handleConsoleMessage } from '../pages/server/console.js';
import { patchServerDetail, patchServerHeader } from '../pages/server/detail.js';
import { patchServerCards } from '../pages/servers.js';
import { renderHostMini, renderSidebarServers } from '../ui/sidebar.js';

/* ------------------------------------------------------------- websocket */

export function connectWebSocket() {
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

export function wsSubscribe(topic) {
  state.wsSubs.add(topic);
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
}

export function wsUnsubscribe(topic) {
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
    hist.players.push(stat.players ?? stat.playerList?.length ?? 0);
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
