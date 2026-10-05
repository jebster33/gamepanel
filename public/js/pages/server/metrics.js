import { api } from '../../core/api.js';
import { drawChart } from '../../core/charts.js';
import { state } from '../../core/state.js';
import { $, esc, fmtBytes, fmtTime } from '../../core/util.js';
import { themeColor } from '../dashboard.js';

/* -------------------------------------------------------------- metrics */

export function renderMetricsTab(host, server) {
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

export function drawServerCharts(id) {
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
