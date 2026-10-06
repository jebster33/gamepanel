import { api } from '../../core/api.js';
import { drawChart } from '../../core/charts.js';
import { state } from '../../core/state.js';
import { $, esc, fmtBytes, fmtTime, toast } from '../../core/util.js';
import { themeColor } from '../dashboard.js';

/* -------------------------------------------------------------- metrics */

// Which window the graphs show: live (last few minutes, streaming) or a saved range.
let range = 'live';
let rangeData = null;
const RANGES = [
  ['live', 'Live'],
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
];

export function renderMetricsTab(host, server) {
  host.innerHTML = `
    <div class="row mb-16" style="gap:6px;flex-wrap:wrap;align-items:center">
      ${RANGES.map(([key, label]) => `<button class="btn btn-sm ${range === key ? 'btn-primary' : ''}" data-range="${key}">${label}</button>`).join('')}
      <span class="faint" id="mv-span" style="font-size:12px;margin-left:8px"></span>
    </div>
    <div class="chart-grid">
      <div class="chart-card"><h4>CPU usage</h4><div class="chart-value" id="mv-cpu">—</div><canvas id="chart-cpu"></canvas></div>
      <div class="chart-card"><h4>Memory</h4><div class="chart-value" id="mv-mem">—</div><canvas id="chart-mem"></canvas></div>
      <div class="chart-card"><h4>Players online</h4><div class="chart-value" id="mv-players">—</div><canvas id="chart-players"></canvas></div>
      <div class="chart-card"><h4>Ping</h4><div class="chart-value" id="mv-ping">—</div><canvas id="chart-ping"></canvas></div>
    </div>
    <div class="card mt-16" id="mv-advice"><h4 style="margin:0 0 12px">Advice</h4><div class="faint"><span class="spinner"></span> Looking at how it runs…</div></div>
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

  host.querySelectorAll('[data-range]').forEach((el) =>
    el.addEventListener('click', () => {
      range = el.dataset.range;
      rangeData = null;
      renderMetricsTab(host, server);
    })
  );

  renderAdvice(host.querySelector('#mv-advice'), server);

  if (range !== 'live') {
    api(`/api/servers/${server.id}/history?range=${range}`)
      .then((data) => {
        rangeData = { id: server.id, points: data.history };
        drawServerCharts(server.id);
      })
      .catch(() => {});
    return;
  }

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

function peaks(id) {
  const set = (sel, text) => {
    const el = $(sel);
    if (el) el.textContent = text;
  };
  const points = rangeData?.id === id ? rangeData.points : [];
  if (!points.length) {
    set('#mv-span', 'Nothing recorded for this range yet. The panel keeps a point every minute for a day and every 15 minutes for 30 days.');
    return null;
  }
  const max = (key) => Math.max(...points.map((p) => p[key] || 0));
  const avg = (key) => points.reduce((n, p) => n + (p[key] || 0), 0) / points.length;
  set('#mv-span', `${fmtTime(points[0].t)} to ${fmtTime(points.at(-1).t)}`);
  set('#mv-cpu', `avg ${avg('cpu').toFixed(1)} % · peak ${max('cpu').toFixed(0)} %`);
  set('#mv-mem', `avg ${fmtBytes(avg('mem'))} · peak ${fmtBytes(max('memMax'))}`);
  set('#mv-players', `avg ${avg('players').toFixed(1)} · peak ${max('playersMax')}`);
  set('#mv-ping', 'Live view only');
  return points;
}

export function drawServerCharts(id) {
  if (range !== 'live') {
    const points = peaks(id);
    if (!points) return;
    const accent = themeColor('--accent', '#5e6ad2');
    drawChart($('#chart-cpu'), points.map((p) => p.cpu), { color: accent });
    drawChart($('#chart-mem'), points.map((p) => p.mem), { color: accent });
    drawChart($('#chart-players'), points.map((p) => p.players), { color: themeColor('--success', '#4cb782') });
    drawChart($('#chart-ping'), [], {});
    return;
  }
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

/* -------------------------------------------------------------- advice */

const ADVICE_ICON = { warn: '⚠', tip: '💡', good: '✓' };

/** Memory and settings advice, with one-click fixes for administrators. */
async function renderAdvice(box, server) {
  if (!box) return;
  let data;
  try {
    data = await api(`/api/servers/${server.id}/advice`);
  } catch (err) {
    box.querySelector('.faint').textContent = err.message;
    return;
  }
  if (!box.isConnected) return;
  const f = data.facts;
  const known = [
    f.memPeak ? `memory peak ${fmtBytes(f.memPeak * 1024 * 1024)} this week` : null,
    f.playersPeak ? `up to ${f.playersPeak} players` : null,
    f.mods ? `${f.mods} mods` : f.plugins ? `${f.plugins} plugins` : null,
    f.tps !== null && f.tps !== undefined ? `${f.tps} TPS` : null,
  ].filter(Boolean);
  const admin = state.user?.role === 'admin';
  box.innerHTML = `
    <div class="card-head" style="margin-bottom:8px"><h4>Advice</h4><div class="spacer"></div>${known.length ? `<span class="faint" style="font-size:12px">${esc(known.join(' · '))}</span>` : ''}</div>
    <div class="advice-list">${data.advice
      .map(
        (a) => `<div class="advice ${a.level}">
          <span class="advice-icon">${ADVICE_ICON[a.level]}</span>
          <div class="grow"><b>${esc(a.title)}</b><div class="faint">${esc(a.detail)}</div></div>
          ${a.action && admin ? `<button class="btn btn-sm" data-advice="${esc(a.id)}">${esc(a.action.label)}</button>` : ''}
        </div>`
      )
      .join('')}</div>`;
  box.querySelectorAll('[data-advice]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api(`/api/servers/${server.id}/advice/${encodeURIComponent(btn.dataset.advice)}/apply`, { method: 'POST', body: {} });
        toast(`${r.applied}: done${r.restartNeeded ? '. Restart the server to use it.' : ''}`);
        renderAdvice(box, server);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    })
  );
}
