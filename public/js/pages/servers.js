import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtBytes, gameArt, icon, statusPill } from '../core/util.js';
import { revealChildren } from '../ui/fx.js';

/* --------------------------------------------------------- server cards */

export function serverAddress(server) {
  const port = server.ports?.game ?? Object.values(server.ports || {})[0];
  return `${location.hostname}:${port}`;
}

export function renderServerCards() {
  if (!state.servers.length) {
    return `<div class="empty">
      <img class="line-art" src="/img/empty-rack.png" alt="" width="140" height="135" />
      <h3>No servers yet</h3>
      <p>Pick a game and the panel installs it, opens the ports and starts it for you.</p>
      ${state.user?.role === 'admin' ? '<a class="btn btn-primary" href="#/templates">Pick a game</a>' : ''}
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
      <span class="srv-icon">${gameArt({ icon: server.templateIcon, logo: server.templateLogo, storeAppId: server.templateStoreAppId })}</span>
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

export function patchServerCards() {
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

export function renderServers(view) {
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
