import { setCrumbs } from '../../core/router.js';
import { state } from '../../core/state.js';
import { $, can, esc, fmtBytes, fmtDuration, fmtRate, icon, statusPill } from '../../core/util.js';
import { renderBackupsTab } from './backups.js';
import { renderConsoleTab } from './console.js';
import { renderFilesTab } from './files.js';
import { drawServerCharts, renderMetricsTab } from './metrics.js';
import { renderModpacksTab } from './modpacks.js';
import { renderModsTab } from './mods.js';
import { patchPlayersTab, renderPlayersTab } from './players.js';
import { renderSchedulesTab } from './schedules.js';
import { renderServerSettingsTab } from './settings.js';
import { serverAddress } from '../servers.js';

/* --------------------------------------------------------- server detail */

function serverTabs(server) {
  return [
    can('console') && ['console', 'Console'],
    ['players', 'Players'],
    ['metrics', 'Metrics'],
    can('files') && ['files', 'Files'],
    server.hasModpacks && can('mods') && ['modpacks', 'Modpack'],
    server.hasMods && can('mods') && ['mods', 'Mods'],
    can('backups') && ['backups', 'Backups'],
    can('schedules') && ['schedules', 'Schedules'],
    can('settings') && ['settings', 'Settings'],
  ].filter(Boolean);
}

function currentServer() {
  return state.servers.find((s) => s.id === state.route.params.id);
}

const tile = (label, field, html) => `
  <div class="tile spot">
    <div class="tile-label">${label}</div>
    <div class="tile-value" data-detail="${field}">${html}</div>
  </div>`;

export function renderServerDetail(view) {
  const server = currentServer();
  if (!server) {
    view.innerHTML = '<div class="empty"><h3>Server not found</h3><a href="#/servers">Back to servers</a></div>';
    return;
  }
  // "network" is a card on the settings tab; old links still land there.
  let tab = state.route.params.tab || 'console';
  if (tab === 'network') tab = 'settings';
  setCrumbs(`<a href="#/servers">Servers</a> <span class="sep">/</span> ${esc(server.name)}`);
  const address = serverAddress(server);

  view.innerHTML = `
    <div class="srv-header">
      <span class="srv-icon">${esc(server.templateIcon || '🎮')}</span>
      <div style="min-width:0;flex:1">
        <h1>${esc(server.name)}</h1>
        <div class="meta">
          <span id="detail-status">${statusPill(server.status)}</span>
          <span class="address" data-copy="${esc(address)}" title="Click to copy">${esc(address)}</span>
          <span class="badge">${esc(server.templateName || '')}${server.gameVersion ? ` · ${esc(server.gameVersion)}` : ''}</span>
          <span class="badge" title="${
            server.runtime === 'docker' ? 'Isolated in its own container' : 'Runs as a normal process on this machine'
          }">${server.runtime === 'docker' ? 'Container' : 'Process'}</span>
          ${server.crashCount ? `<span class="badge bad">${server.crashCount} crash${server.crashCount > 1 ? 'es' : ''}</span>` : ''}
          <span class="faint" style="font-size:12px" id="detail-uptime">${
            server.status === 'running' ? 'up ' + fmtDuration(server.uptime) : ''
          }</span>
        </div>
      </div>
      <div class="row" id="detail-power">${powerButtons(server)}</div>
    </div>

    <div class="metrics compact" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      ${tile('CPU', 'cpu', `${(server.cpu || 0).toFixed(1)}<span class="unit">%</span>`)}
      ${tile('Memory', 'mem', `${fmtBytes(server.memory)}<span class="unit">/ ${fmtBytes(server.memoryLimit)}</span>`)}
      ${tile('Players', 'players', `${server.players ?? (server.playerList?.length || '—')}<span class="unit">${server.maxPlayers ? '/ ' + server.maxPlayers : ''}</span>`)}
      ${tile('Ping', 'ping', server.ping != null ? server.ping + '<span class="unit">ms</span>' : '—')}
      ${tile(
        'Network',
        'net',
        server.runtime === 'docker'
          ? `<span style="font-size:12.5px;white-space:nowrap">↓ ${fmtRate(server.networkRx)} ↑ ${fmtRate(server.networkTx)}</span>`
          : '<span class="faint" style="font-size:12px">host-wide only</span>'
      )}
      ${tile('Disk', 'disk', fmtBytes(server.diskBytes))}
    </div>

    <nav class="tabs">
      ${serverTabs(server)
        .map(([key, label]) => `<a class="tab ${tab === key ? 'active' : ''}" href="#/servers/${esc(server.id)}/${key}">${label}</a>`)
        .join('')}
    </nav>
    <div id="tab-content"></div>`;

  renderServerTab(server, tab);
  if (state.route.params.tab === 'network') setTimeout(() => $('#network-card')?.scrollIntoView({ behavior: 'smooth' }), 300);
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

export function patchServerHeader() {
  const server = currentServer();
  if (!server) return;
  const status = $('#detail-status');
  if (status) status.innerHTML = statusPill(server.status);
  const power = $('#detail-power');
  if (power) power.innerHTML = powerButtons(server);
}

export function patchServerDetail() {
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
    `${server.players ?? (server.playerList?.length || '—')}<span class="unit">${server.maxPlayers ? '/ ' + server.maxPlayers : ''}</span>`
  );
  set('ping', server.ping != null ? `${server.ping}<span class="unit">ms</span>` : '—');
  set('conns', String(server.connections ?? 0));
  set('crashes', String(server.crashCount || 0));
  if (server.runtime === 'docker') set('net', `<span style="font-size:12.5px;white-space:nowrap">↓ ${fmtRate(server.networkRx)} ↑ ${fmtRate(server.networkTx)}</span>`);
  const uptime = $('#detail-uptime');
  if (uptime) uptime.textContent = server.status === 'running' ? 'up ' + fmtDuration(server.uptime) : '';
  if (state.route.params.tab === 'metrics') drawServerCharts(server.id);
  if (state.route.params.tab === 'players') patchPlayersTab(server);
}

function renderServerTab(server, tab) {
  const host = $('#tab-content');
  switch (tab) {
    case 'metrics':
      renderMetricsTab(host, server);
      break;
    case 'players':
      renderPlayersTab(host, server);
      break;
    case 'files':
      renderFilesTab(host, server, '');
      break;
    case 'modpacks':
      renderModpacksTab(host, server);
      break;
    case 'mods':
      renderModsTab(host, server);
      break;
    case 'backups':
      renderBackupsTab(host, server);
      break;
    case 'schedules':
      renderSchedulesTab(host, server);
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
