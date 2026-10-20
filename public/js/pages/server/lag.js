import { api } from '../../core/api.js';
import { $, can, esc, fmtTime, icon, toast } from '../../core/util.js';

/* ---------------------------------------------------------- lag reports */

const POLL_MS = 3000;
/** The "Lag report" card on the Metrics tab. */
export function renderLagCard(box, server) {
  if (!box) return;
  let timer = null;
  let seconds = 60;

  const load = async () => {
    if (!box.isConnected) return clearTimeout(timer);
    let data;
    try {
      data = await api(`/api/servers/${server.id}/lag`);
    } catch (err) {
      box.innerHTML = `<h4 style="margin:0 0 12px">Lag report</h4><div class="faint">${esc(err.message)}</div>`;
      return;
    }
    if (!box.isConnected) return;
    draw(data);
    clearTimeout(timer);
    if (data.active && data.active.state !== 'failed') timer = setTimeout(load, POLL_MS);
  };

  const run = async (body) => {
    try {
      await api(`/api/servers/${server.id}/lag`, { method: 'POST', body });
      toast(body.mode === 'health' || !body.seconds ? 'Report started' : `Profiling for ${body.seconds} seconds. The link appears here when it is done.`);
    } catch (err) {
      toast(err.message, 'error');
    }
    load();
  };

  const draw = (data) => {
    const canRun = can('command', server.id);
    const lead =
      data.kind === 'spark'
        ? 'Runs the spark profiler on the live server and gives you a link that shows which plugin, mod or method takes the time.'
        : data.kind === 'rust'
          ? 'Asks the server for its frame rate and sets it beside the plugins it loads and how the machine has been doing. Rust has no profiler to trace plugins, so this points at suspects.'
          : 'Takes a snapshot of how the server has been doing: processor, memory, players and what the console says.';
    box.innerHTML = `
      <div class="card-head" style="margin-bottom:8px"><h4>Lag report</h4><div class="spacer"></div></div>
      <p class="faint" style="margin:0 0 12px">${esc(lead)}</p>
      <div id="lag-controls" class="row" style="gap:8px;flex-wrap:wrap;align-items:center"></div>
      <div id="lag-note" class="faint" style="margin-top:8px"></div>
      <div id="lag-list" class="mt-16"></div>`;
    const controls = $('#lag-controls', box);
    const note = $('#lag-note', box);

    if (data.active) {
      const a = data.active;
      note.innerHTML =
        a.state === 'failed'
          ? `<span class="mod-issue error"><span class="dot"></span> ${esc(a.error)}</span>`
          : `<span class="spinner"></span> ${a.state === 'profiling' ? `Profiling for ${a.seconds} seconds. Keep playing; the link shows up here.` : 'Waiting for the report link…'}`;
    } else if (!data.running) {
      note.textContent = 'Start the server to take a report.';
    } else if (data.kind === 'spark' && !data.sparkInstalled) {
      controls.innerHTML = can('mods', server.id) ? `<button class="btn btn-primary btn-sm" id="lag-install">${icon('puzzle', 12)} Install spark</button>` : '';
      note.textContent = 'The spark profiler is not installed on this server. It is free and loads with the server; restart once after installing.';
    } else if (canRun) {
      controls.innerHTML =
        data.kind === 'spark'
          ? `<label class="faint" for="lag-seconds">Profile for</label>
             <select id="lag-seconds">${[30, 60, 120, 300].map((s) => `<option value="${s}" ${s === seconds ? 'selected' : ''}>${s < 120 ? `${s} seconds` : `${s / 60} minutes`}</option>`).join('')}</select>
             <button class="btn btn-primary btn-sm" id="lag-profile">${icon('play', 12)} Profile now</button>
             <button class="btn btn-sm" id="lag-health" title="A quick look at memory, disk and tick times, without profiling">Quick health report</button>`
          : `<button class="btn btn-primary btn-sm" id="lag-snap">${data.kind === 'rust' ? 'Check performance' : 'Take a snapshot'}</button>`;
      note.textContent = data.kind === 'spark' ? 'Profile while the lag is happening for the clearest result.' : '';
    }

    $('#lag-install', box)?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api(`/api/servers/${server.id}/mods/install`, { method: 'POST', body: { provider: 'modrinth', projectId: 'spark' } });
        toast('spark installed. Restart the server to load it.');
      } catch (err) {
        toast(err.message, 'error');
      }
      load();
    });
    $('#lag-seconds', box)?.addEventListener('change', (e) => (seconds = Number(e.target.value)));
    $('#lag-profile', box)?.addEventListener('click', () => run({ mode: 'profile', seconds }));
    $('#lag-health', box)?.addEventListener('click', () => run({ mode: 'health' }));
    $('#lag-snap', box)?.addEventListener('click', () => run({}));

    const list = $('#lag-list', box);
    list.innerHTML = data.reports.map(reportHtml).join('');
    list.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/servers/${server.id}/lag/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' });
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
  };

  box.innerHTML = '<h4 style="margin:0 0 12px">Lag report</h4><span class="spinner"></span>';
  load();
}

function reportHtml(r) {
  const s = r.snapshot || {};
  const facts = [
    s.tps != null ? `${s.tps} TPS` : null,
    r.fps != null ? `${r.fps} FPS` : null,
    s.cpuAvg != null ? `CPU ${s.cpuAvg} % (peak ${Math.round(s.cpuPeak)} %)` : null,
    s.memoryMb != null ? `memory ${s.memoryMb}${s.memoryLimitMb ? ` of ${s.memoryLimitMb}` : ''} MB` : null,
    s.players != null ? `${s.players} players` : null,
    r.plugins ? `${r.plugins} plugins` : null,
  ].filter(Boolean);
  const what = r.kind === 'spark' ? (r.mode === 'health' ? 'Health report' : `Profile, ${r.seconds} s`) : r.kind === 'rust' ? 'Performance check' : 'Snapshot';
  return `
    <div class="list-row" style="align-items:flex-start">
      <div class="grow">
        <div class="title">${esc(what)} <span class="faint" style="font-weight:400">${esc(fmtTime(r.at))}${r.by ? ` · ${esc(r.by)}` : ''}</span></div>
        ${r.url ? `<div><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a></div>` : ''}
        <div class="sub">${esc(facts.join(' · '))}</div>
        ${(r.findings || []).map((f) => `<div class="faint" style="margin-top:2px">• ${esc(f)}</div>`).join('')}
      </div>
      ${can('command') ? `<button class="btn btn-sm btn-ghost btn-danger" data-del="${esc(r.id)}" title="Delete">${icon('trash', 13)}</button>` : ''}
    </div>`;
}
