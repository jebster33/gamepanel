import { state } from '../core/state.js';
import { $, esc } from '../core/util.js';

/* --------------------------------------------------------------- sidebar */

export function renderSidebarServers() {
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
        <span class="name">${esc(s.name)}</span>${s.node ? `<span class="faint" style="font-size:11px;margin-left:auto">${esc(s.node.name)}</span>` : ''}
      </a>`
    )
    .join('');
}

export function renderHostMini() {
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

/** "Connections" only exists while the bridge is on (and only for admins). */
export function setBridgeNav(enabled) {
  $('#nav-connections')?.classList.toggle('hidden', !(enabled && state.user?.role === 'admin'));
}

export function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('show');
}
