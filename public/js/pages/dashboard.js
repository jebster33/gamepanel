import { api } from '../core/api.js';
import { drawChart } from '../core/charts.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtBytes, fmtDuration, fmtRate } from '../core/util.js';
import { renderServerCards } from './servers.js';
import { countUp, flash, revealChildren } from '../ui/fx.js';

/* ------------------------------------------------------------- dashboard */

export function renderDashboard(view) {
  setCrumbs('Dashboard');
  const host = state.host;
  const overview = state.overview || { total: 0, running: 0, players: 0, crashes: 0 };
  const memPct = host?.memory.total ? (host.memory.used / host.memory.total) * 100 : 0;
  const diskPct = host?.disk.total ? (host.disk.used / host.disk.total) * 100 : 0;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Overview</h1>
        <div class="lede">${esc(host?.hostname || '')} · up ${fmtDuration((host?.uptime || 0) * 1000)}</div>
      </div>
    </div>
    <div id="checklist"></div>

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
        <div class="tile-value" data-host="net" style="font-size:clamp(13px,1.3vw,17px);line-height:1.25">
          ${netRates(host)}
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

    <div class="metrics compact">
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
  if (state.user?.role === 'admin') renderChecklist();
  revealChildren(view);
  view.querySelectorAll('[data-countup]').forEach((el) => countUp(el, el.dataset.countup));
}

/** Chart colours come from the stylesheet so they follow the theme. */
export function themeColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function drawHostCharts() {
  const accent = themeColor('--accent', '#5e6ad2');
  drawChart($('#chart-host-cpu'), state.hostHistory.cpu, { color: accent, max: 100, grid: false, pad: 0 });
  drawChart($('#chart-host-mem'), state.hostHistory.mem, { color: accent, max: 100, grid: false, pad: 0 });
  drawChart($('#chart-host-net'), state.hostHistory.net, { color: accent, grid: false, pad: 0 });
}

export function patchDashboard() {
  const host = state.host;
  const overview = state.overview;
  if (!host) return;
  const memPct = host.memory.total ? (host.memory.used / host.memory.total) * 100 : 0;
  const set = (sel, html, glow = true) => {
    const el = $(sel);
    if (!el || el.innerHTML === html) return;
    el.innerHTML = html;
    if (glow) flash(el);
  };
  set('[data-host="cpu"]', `${host.cpu.percent.toFixed(0)}<span class="unit">%</span>`);
  set('[data-host="cpu-sub"]', `${host.cpu.cores} cores · load ${(host.load?.[0] ?? 0).toFixed(2)}`, false);
  set('[data-host="mem"]', `${memPct.toFixed(0)}<span class="unit">%</span>`);
  set('[data-host="mem-sub"]', `${fmtBytes(host.memory.used)} of ${fmtBytes(host.memory.total)}`, false);
  set('[data-host="net"]', netRates(host), false);
  if (overview) {
    // The "/ total" unit lives in a sibling span, so only the number is patched.
    set('[data-ov="running"]', String(overview.running));
    set('[data-ov="players"]', String(overview.players));
    set('[data-ov="crashes"]', String(overview.crashes));
  }
  drawHostCharts();
}

/* ----------------------------------------------------------- checklist */

/** What a fresh panel still needs. Hidden once everything is done or dismissed. */
async function renderChecklist() {
  let data;
  try {
    data = await api('/api/system/checklist');
  } catch {
    return;
  }
  const box = $('#checklist');
  if (!box || data.dismissed || data.items.every((i) => i.done)) return;
  const done = data.items.filter((i) => i.done).length;
  box.innerHTML = `
    <div class="card checklist">
      <img class="line-art" src="/img/empty-rack.png" alt="" width="150" height="145" />
      <div>
        <div class="row mb-16">
          <h3 style="font-size:16px">Get your panel ready</h3>
          <span class="badge accent">${done} of ${data.items.length}</span>
          <div class="spacer"></div>
          <button class="btn btn-sm btn-ghost" id="checklist-dismiss">Hide</button>
        </div>
        <ol>${data.items
          .map(
            (i) => `<li class="${i.done ? 'done' : ''}"><a href="${esc(i.link)}"><span class="tick">✓</span><span class="text">${esc(i.label)}</span></a></li>`
          )
          .join('')}</ol>
      </div>
    </div>`;
  $('#checklist-dismiss').addEventListener('click', async () => {
    box.innerHTML = '';
    await api('/api/settings', { method: 'PATCH', body: { checklistDismissed: true } }).catch(() => {});
  });
}

/** Down and up rates; they wrap onto two lines when the tile is narrow. */
function netRates(host) {
  return `<span class="nowrap">↓ ${fmtRate(host?.network.rxBytesPerSec)}</span> <span class="nowrap">↑ ${fmtRate(host?.network.txBytesPerSec)}</span>`;
}
