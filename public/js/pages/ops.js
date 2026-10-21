import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtTime, toast } from '../core/util.js';
import { confirmModal, openModal } from '../ui/modal.js';
import { skeleton } from '../ui/skeleton.js';
import { section, attempt, table, ago, field } from './server/tools-kit.js';

/* ------------------------------------------------------------ Operations */

const TABS = [
  ['calendar', 'Calendar', false],
  ['costs', 'Costs', true],
  ['hosting', 'Hosting', true],
  ['status', 'Status notes', true],
];

export function renderOps(view) {
  const admin = state.user.role === 'admin';
  const tabs = TABS.filter(([, , adminOnly]) => admin || !adminOnly);
  let tab = state.route.params.tab || 'calendar';
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  setCrumbs('Operations');
  view.innerHTML = `
    <div class="page-head"><div><h1>Operations</h1><div class="lede">Everything the panel will do on its own, what it costs, and the machine underneath.</div></div></div>
    <nav class="tabs">${tabs.map(([k, label]) => `<a class="tab ${tab === k ? 'active' : ''}" href="#/ops/${k}">${label}</a>`).join('')}</nav>
    <div id="ops-body"></div>`;
  const body = $('#ops-body', view);
  ({ calendar: calendarTab, costs: costsTab, hosting: hostingTab, status: statusTab })[tab](body);
}

/* -------------------------------------------------------------- calendar */

const DAY = 86400_000;

async function calendarTab(body) {
  let month = new Date();
  month.setDate(1);
  month.setHours(0, 0, 0, 0);
  const draw = async () => {
    const first = new Date(month);
    const startGrid = new Date(first);
    startGrid.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start on Monday
    const endGrid = new Date(startGrid.getTime() + 42 * DAY);
    body.innerHTML = skeleton('page', 'Loading the calendar…');
    let data;
    try {
      data = await api(`/api/calendar?from=${startGrid.getTime()}&to=${endGrid.getTime()}`);
    } catch (err) {
      body.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
      return;
    }
    const byDay = new Map();
    for (const it of data.items) {
      const key = new Date(it.at).toDateString();
      (byDay.get(key) || byDay.set(key, []).get(key)).push(it);
    }
    const today = new Date().toDateString();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(startGrid.getTime() + i * DAY);
      const items = byDay.get(d.toDateString()) || [];
      const merged = [];
      for (const it of items) {
        // Hourly schedules would fill a day: group repeats of the same one.
        const same = merged.find((m) => m.title === it.title && m.serverId === it.serverId && m.kind === it.kind);
        if (same) same.times.push(it.at);
        else merged.push({ ...it, times: [it.at] });
      }
      const shown = merged.slice(0, 4);
      cells.push(`<div class="day ${d.getMonth() !== month.getMonth() ? 'dim' : ''} ${d.toDateString() === today ? 'today' : ''}"><b>${d.getDate()}</b>${shown
        .map((m) => {
          const t = new Date(m.times[0]);
          const label = m.times.length > 1 ? `${m.times.length}× ${m.title}` : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} ${m.title}`;
          return `<span class="ev ${esc(m.kind)}" title="${esc(`${m.server ? `${m.server}: ` : ''}${m.title}${m.waits ? ' (waits for the server to empty)' : ''}${m.hours ? ` for ${m.hours} h` : ''}`)}">${esc(label)}</span>`;
        })
        .join('')}${merged.length > shown.length ? `<span class="faint">+${merged.length - shown.length} more</span>` : ''}</div>`);
    }
    body.innerHTML = `
      <div class="card">
        <div class="row" style="gap:8px;margin-bottom:12px">
          <button class="btn btn-sm" id="cal-prev">‹</button>
          <h3 style="margin:0;min-width:160px;text-align:center">${month.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</h3>
          <button class="btn btn-sm" id="cal-next">›</button>
          <button class="btn btn-sm btn-ghost" id="cal-today">Today</button>
          <div class="spacer"></div>
          <span class="hint"><span class="badge">schedule</span> <span class="badge bad">wipe</span> <span class="badge warn">forced wipe</span> <span class="badge accent">event</span></span>
        </div>
        <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n) => `<div class="dow">${n}</div>`).join('')}${cells.join('')}</div>
        <div class="hint mt-8">Times are the machine's local time, like the schedules. Rust's forced wipe is the first Thursday of the month at 19:00 UTC. Schedules, wipes and game events of every server you can manage are shown.</div>
      </div>`;
    $('#cal-prev', body).addEventListener('click', () => {
      month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
      draw();
    });
    $('#cal-next', body).addEventListener('click', () => {
      month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
      draw();
    });
    $('#cal-today', body).addEventListener('click', () => {
      month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      draw();
    });
  };
  draw();
}

/* ----------------------------------------------------------------- costs */

async function costsTab(body, monthKey) {
  let r;
  try {
    r = await api(`/api/ops/costs${monthKey ? `?month=${monthKey}` : ''}`);
  } catch (err) {
    body.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  const s = r.settings;
  const money = (n) => `${s.currency} ${n.toFixed(n < 10 ? 2 : 0)}`;
  body.innerHTML = `
    <div class="card mb-16">
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        <h3 style="margin:0">Cost of running servers</h3>
        <select id="cost-month">${(r.months.includes(r.month) ? r.months : [r.month, ...r.months]).map((m) => `<option ${m === r.month ? 'selected' : ''}>${m}</option>`).join('')}</select>
      </div>
      <div class="tools-grid mt-16">
        <div><div class="faint">This month so far</div><div style="font-size:26px;font-weight:600">${money(r.total)}</div></div>
        <div><div class="faint">Electricity</div><div style="font-size:20px">${money(r.power)}</div><div class="hint">${r.kwh.toFixed(1)} kWh measured over ${r.hoursSampled.toFixed(0)} h</div></div>
        <div><div class="faint">Fixed (VPS, internet)</div><div style="font-size:20px">${money(r.fixed)}</div></div>
        <div><div class="faint">Overhead (panel, idle)</div><div style="font-size:20px">${money(r.overhead)}</div></div>
      </div>
    </div>
    <div class="card mb-16">${table(
      ['Server', 'Share', 'Cost', 'CPU hours', 'Memory GB·h', 'Running'],
      r.servers.map((x) => [`<a href="#/servers/${esc(x.id)}">${esc(x.name)}</a>`, `${(x.share * 100).toFixed(0)}%`, `<b>${esc(money(x.cost))}</b>`, x.cpuHours.toFixed(1), x.memGbHours.toFixed(1), `${x.runHours.toFixed(0)} h`]),
      { empty: 'Nothing recorded yet. The panel samples running servers every minute.' }
    )}
    <div class="hint mt-8">Each server's share is half its CPU time and half its memory, out of what all servers used. Servers on other nodes are not counted. Costs are an estimate from the settings below.</div></div>
    <div class="card"><h4>How the cost is worked out</h4>
      <div class="tools-grid mt-8">
        ${field('Currency', `<input id="c-cur" value="${esc(s.currency)}" maxlength="3" style="width:80px" />`)}
        ${field('Electricity price per kWh', `<input id="c-kwh" type="number" min="0" step="0.01" value="${s.kwhPrice}" />`)}
        ${field('Machine power when idle (watts)', `<input id="c-idle" type="number" min="0" value="${s.idleWatts}" />`, 'A small server uses about 30 to 60 W; a VPS: set 0 and use the fixed amount.')}
        ${field('Machine power at full load (watts)', `<input id="c-max" type="number" min="0" value="${s.maxWatts}" />`)}
        ${field('Fixed cost per month', `<input id="c-fixed" type="number" min="0" step="0.5" value="${s.fixedMonthly}" />`, 'VPS bill, internet share, hardware per month.')}
        ${field('Overhead not charged to servers (%)', `<input id="c-over" type="number" min="0" max="90" value="${s.overheadPercent}" />`)}
      </div>
      <div class="mt-8"><button class="btn btn-primary" id="c-save">Save</button></div></div>`;
  $('#cost-month', body).addEventListener('change', (e) => costsTab(body, e.target.value));
  $('#c-save', body).addEventListener('click', async () => {
    const v = (id) => $(id, body).value;
    const ok = await attempt(() => api('/api/ops/costs', { method: 'PUT', body: { currency: v('#c-cur'), kwhPrice: Number(v('#c-kwh')), idleWatts: Number(v('#c-idle')), maxWatts: Number(v('#c-max')), fixedMonthly: Number(v('#c-fixed')), overheadPercent: Number(v('#c-over')) } }), 'Saved');
    if (ok) costsTab(body, r.month);
  });
}

/* --------------------------------------------------------------- hosting */

function hostingTab(body) {
  body.innerHTML = '<div id="hosting"></div>';
  const box = $('#hosting', body);
  section(box, { id: 'benchmark', title: 'Host benchmark', lead: 'Which games fit this machine', open: true, load: benchmarkCard });
  section(box, { id: 'pressure', title: 'Memory pressure', lead: 'Warn before the system starts killing servers', load: pressureCard });
  section(box, { id: 'ddns', title: 'Dynamic DNS', lead: 'Keep names pointed at a changing home address', load: ddnsCard });
  section(box, { id: 'prom', title: 'Prometheus and Grafana', lead: 'Metrics for your own dashboards', load: promCard });
  section(box, { id: 'widgets', title: 'Phone widgets', lead: 'Server status on a home screen', load: widgetsCard });
}

async function benchmarkCard(body) {
  const draw = (job) => {
    const run = `<button class="btn btn-primary" id="bm-run" ${job.state === 'running' ? 'disabled' : ''}>${job.state === 'running' ? 'Running…' : job.state === 'done' ? 'Run again' : 'Run the benchmark'}</button>`;
    if (job.state !== 'done') {
      body.innerHTML = `<p class="hint" style="margin:0 0 10px">About 15 seconds. It tests the processor (one core and all cores), memory and disk, then lists which games fit. Servers that are running slow the result down. It writes and removes a 256 MB scratch file.</p>${job.state === 'failed' ? `<div class="faint">Failed: ${esc(job.error)}</div>` : ''}${run}`;
    } else {
      const r = job.result;
      const tone = { good: 'accent', tight: 'warn', no: 'bad' };
      body.innerHTML = `
        <div class="tools-grid">
          <div><div class="faint">One core</div><div style="font-size:22px;font-weight:600">${r.cpu.single}</div></div>
          <div><div class="faint">All ${r.cpu.cores} cores</div><div style="font-size:22px;font-weight:600">${r.cpu.multi}</div></div>
          <div><div class="faint">Memory copy</div><div style="font-size:22px;font-weight:600">${r.memory.gbPerSec} GB/s</div></div>
          <div><div class="faint">Disk write / read</div><div style="font-size:22px;font-weight:600">${r.disk.skipped ? esc(r.disk.skipped) : `${r.disk.writeMBs} / ${r.disk.readMBs} MB/s`}</div></div>
        </div>
        <div class="hint mt-8">${esc(r.model)} · ${(r.totalMb / 1024).toFixed(1)} GB memory${r.busyServers ? ` · ${r.busyServers} server(s) were running, so the numbers are lower than an idle machine would give` : ''}. The disk read is often served from cache.</div>
        <h4 class="mt-16">Games that fit</h4>
        ${table(['Game', 'Weight', 'At once', 'Fit'], job.fits.map((f) => [esc(f.name), esc(f.class), f.count || '–', `<span class="badge ${tone[f.verdict]}">${f.verdict === 'good' ? 'fits' : f.verdict === 'tight' ? 'tight' : 'no'}</span> <span class="faint">${esc(f.reason)}</span>`]))}
        <div class="mt-16">${run}</div>`;
    }
    $('#bm-run', body)?.addEventListener('click', async () => {
      const j = await attempt(() => api('/api/ops/benchmark', { method: 'POST' }));
      if (j) poll();
    });
  };
  const poll = async () => {
    const job = await api('/api/ops/benchmark');
    draw(job);
    if (job.state === 'running' && body.isConnected) setTimeout(poll, 2000);
  };
  await poll();
}

async function pressureCard(body) {
  const p = await api('/api/ops/pressure');
  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  body.innerHTML = `
    <div class="tools-grid">
      <div><div class="faint">State</div><div style="font-size:20px"><span class="badge ${p.level === 'ok' ? 'accent' : p.level === 'warn' ? 'warn' : 'bad'}">${p.level === 'ok' ? 'fine' : esc(p.level)}</span></div><div class="hint">${esc(p.why.join('; '))}</div></div>
      <div><div class="faint">Memory available</div><div style="font-size:20px">${gb(p.available)} of ${gb(p.total)} GB (${p.availablePct.toFixed(0)}%)</div></div>
      <div><div class="faint">Swap</div><div style="font-size:20px">${p.swapTotal ? `${p.swapPct.toFixed(0)}% of ${gb(p.swapTotal)} GB` : 'none'}</div></div>
      ${p.psi != null ? `<div><div class="faint">Waiting on memory</div><div style="font-size:20px">${p.psi.toFixed(1)}%</div></div>` : ''}
    </div>
    ${p.top.length ? `<h4 class="mt-16">Using the most</h4>${table(['Server', 'Memory', 'Cap'], p.top.map((s) => [esc(s.name), `${gb(s.memory)} GB`, `${gb(s.limit)} GB`]))}` : ''}
    <label class="checkbox-row mt-16"><input type="checkbox" id="pr-on" ${p.enabled ? 'checked' : ''} /><label for="pr-on">Alert when memory runs low (Discord, ntfy, phone and the bell)</label></label>
    <div class="hint">Warns at 12% available, swap over half full, or the system waiting on memory; critical at 6%. Which channels hear it is set under Settings, Notifications.</div>`;
  $('#pr-on', body).addEventListener('change', (e) => attempt(() => api('/api/ops/pressure', { method: 'PUT', body: { enabled: e.target.checked } }), 'Saved'));
}

async function ddnsCard(body) {
  const draw = async () => {
    const d = await api('/api/ops/ddns');
    body.innerHTML = `
      <p class="hint" style="margin:0 0 10px">Home internet addresses change. Every 5 minutes the panel checks its public address and, when it changed, updates the names below${d.cloudflareReady ? ', and the play.example.com names it made for servers' : ''}.</p>
      <label class="checkbox-row"><input type="checkbox" id="dd-on" ${d.enabled ? 'checked' : ''} /><label for="dd-on">Keep names up to date</label></label>
      <div class="tools-grid mt-16">
        ${field('DuckDNS names (the part before .duckdns.org)', `<input id="dd-duck" value="${esc(d.duckdns.domains)}" placeholder="mygames, mygames2" />`)}
        ${field('DuckDNS token', `<input id="dd-token" type="password" placeholder="${d.duckdns.tokenSet ? 'saved (leave empty to keep)' : 'from duckdns.org'}" autocomplete="off" />`)}
        ${field('Cloudflare names', `<input id="dd-cf" value="${esc(d.cloudflareNames.join(', '))}" placeholder="home.example.com" />`, d.cloudflareReady ? 'Uses the Cloudflare token from Settings, Integrations. Missing records are created.' : 'Add a Cloudflare token under Settings, Integrations first.')}
      </div>
      <div class="tools-row mt-16"><button class="btn btn-primary" id="dd-save">Save</button><button class="btn" id="dd-check">Check now</button></div>
      <div class="hint mt-8">${d.lastCheck ? `Last check ${esc(ago(d.lastCheck))}${d.lastIp ? `, address ${esc(d.lastIp)}` : ''}. ` : ''}${esc(d.lastResult || '')}</div>`;
    $('#dd-save', body).addEventListener('click', async () => {
      const payload = { enabled: $('#dd-on', body).checked, duckdns: { domains: $('#dd-duck', body).value }, cloudflareNames: $('#dd-cf', body).value };
      if ($('#dd-token', body).value.trim()) payload.duckdns.token = $('#dd-token', body).value.trim();
      if (await attempt(() => api('/api/ops/ddns', { method: 'PUT', body: payload }), 'Saved')) draw();
    });
    $('#dd-check', body).addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const r = await attempt(() => api('/api/ops/ddns/check', { method: 'POST' }));
      if (r) toast(r.problems?.length ? r.problems.join('; ') : `Public address ${r.ip}`);
      draw();
    });
  };
  await draw();
}

async function promCard(body) {
  const draw = async () => {
    const p = await api('/api/ops/prometheus');
    body.innerHTML = `
      <p class="hint" style="margin:0 0 10px">Exposes players, CPU, memory, disk, TPS and crashes of every server, plus the host, in Prometheus format. Scrape it with Prometheus and draw it in Grafana.</p>
      ${
        p.enabled
          ? `<div class="mb-8">Endpoint: <span class="mono">${esc(p.url)}</span> <span class="faint">(Bearer token, created ${esc(ago(p.createdAt))})</span></div>
             <div class="tools-row"><a class="btn btn-sm" href="/api/ops/prometheus/dashboard.json">Grafana dashboard (JSON)</a><button class="btn btn-sm" id="pm-new">New token</button><button class="btn btn-sm btn-danger" id="pm-off">Turn off</button></div>
             <h4 class="mt-16">prometheus.yml</h4><div class="tools-pre">${esc(p.config)}</div>`
          : '<button class="btn btn-primary" id="pm-on">Turn on and make a token</button>'
      }`;
    const create = async () => {
      const r = await attempt(() => api('/api/ops/prometheus', { method: 'POST' }));
      if (!r) return;
      openModal({ title: 'Your scrape token', body: `<p>Shown once. Put it in <span class="mono">credentials</span> of prometheus.yml.</p><div class="tools-pre">${esc(r.token)}</div>`, actions: [{ label: 'Done', close: true, primary: true }] });
      draw();
    };
    $('#pm-on', body)?.addEventListener('click', create);
    $('#pm-new', body)?.addEventListener('click', create);
    $('#pm-off', body)?.addEventListener('click', async () => {
      if (await attempt(() => api('/api/ops/prometheus', { method: 'DELETE' }), 'Turned off')) draw();
    });
  };
  await draw();
}

async function widgetsCard(body) {
  const draw = async () => {
    const w = await api('/api/ops/widgets');
    body.innerHTML = `
      <p class="hint" style="margin:0 0 10px">A widget link shows the status and player count of the servers you pick, without signing in. Use it in iOS (Scriptable), Android (KWGT, Glance) or any app that shows an image or reads JSON. The link is shown once.</p>
      ${table(['Widget', 'Servers', 'Last used', ''], w.widgets.map((x) => [esc(x.name), esc(String(x.serverIds.length || 'first 6')), x.lastUsed ? esc(ago(x.lastUsed)) : 'never', `<button class="btn btn-sm btn-ghost" data-del="${esc(x.id)}">Delete</button>`]), { empty: 'No widgets yet.' })}
      <div class="tools-row mt-16">
        <input id="wg-name" placeholder="Name, e.g. My phone" maxlength="40" style="max-width:220px" />
        <select id="wg-servers" multiple size="3" style="min-width:200px">${state.servers.filter((s) => !s.node).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
        <button class="btn btn-primary" id="wg-make">Make a widget link</button>
      </div>
      <details class="mt-16"><summary class="faint">iOS: Scriptable script</summary><div class="tools-pre mt-8">${esc(w.script)}</div><div class="hint">In Scriptable make a new script with this text, add a Scriptable widget to the home screen, and put the link's token in its Parameter field.</div></details>`;
    body.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (await attempt(() => api(`/api/ops/widgets/${b.dataset.del}`, { method: 'DELETE' }))) draw();
      })
    );
    $('#wg-make', body).addEventListener('click', async () => {
      const r = await attempt(() => api('/api/ops/widgets', { method: 'POST', body: { name: $('#wg-name', body).value, serverIds: [...$('#wg-servers', body).selectedOptions].map((o) => o.value) } }));
      if (!r) return;
      openModal({
        title: 'Widget link',
        body: `<p>Shown once. JSON: </p><div class="tools-pre">${esc(r.url)}</div><p>As an image (for widgets that show a picture):</p><div class="tools-pre">${esc(r.url)}/badge.svg</div><p>Scriptable token:</p><div class="tools-pre">${esc(r.token)}</div>`,
        actions: [{ label: 'Done', close: true, primary: true }],
      });
      draw();
    });
  };
  await draw();
}

/* --------------------------------------------------------- status notes */

async function statusTab(body) {
  const draw = async () => {
    const d = await api('/api/ops/incidents');
    const names = new Map(state.servers.map((s) => [s.id, s.name]));
    const tone = { investigating: 'bad', identified: 'warn', monitoring: 'warn', resolved: 'accent' };
    body.innerHTML = `
      <div class="card mb-16">
        <h4>Post a note on the public status page</h4>
        <p class="hint" style="margin:0 0 10px">Incidents and maintenance show on the status page with their updates. A server that crashes and stays down for two minutes gets one automatically (only for servers on the page). The page also shows 90 days of uptime per server.</p>
        <div class="tools-grid">
          ${field('Title', '<input id="in-title" maxlength="120" placeholder="Rust server restarting for an update" />')}
          ${field('Kind', `<select id="in-impact"><option value="minor">Minor problem</option><option value="major">Major outage</option><option value="maintenance">Maintenance</option></select>`)}
          ${field('Servers', `<select id="in-servers" multiple size="3">${state.servers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`, 'None picked = the whole panel.')}
        </div>
        ${field('What is happening', '<textarea id="in-text" rows="2" maxlength="1000" style="width:100%"></textarea>')}
        <button class="btn btn-primary" id="in-add">Post</button>
      </div>
      ${d.incidents.map((i) => `<div class="card mb-16"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><b>${esc(i.title)}</b><span class="badge ${tone[i.status]}">${esc(i.status)}</span><span class="badge">${esc(i.impact)}</span>${i.auto ? '<span class="badge">automatic</span>' : ''}<span class="faint">${esc(fmtTime(i.startedAt))}</span><div class="spacer"></div><button class="btn btn-sm btn-ghost" data-del="${esc(i.id)}">Delete</button></div>
        <div class="hint">${i.serverIds.map((id) => esc(names.get(id) || id)).join(', ') || 'Whole panel'}</div>
        ${i.updates.map((u) => `<div class="mt-8"><span class="faint">${esc(fmtTime(u.at))} · ${esc(u.status)}</span><div>${esc(u.text)}</div></div>`).join('')}
        ${i.status === 'resolved' ? '' : `<div class="tools-row mt-8"><select data-st="${esc(i.id)}">${d.statuses.map((s) => `<option ${s === i.status ? 'selected' : ''}>${s}</option>`).join('')}</select><input data-tx="${esc(i.id)}" placeholder="Add an update" style="flex:1;min-width:200px" /><button class="btn btn-sm" data-up="${esc(i.id)}">Update</button></div>`}</div>`).join('') || '<div class="faint">No incidents yet.</div>'}`;
    $('#in-add', body).addEventListener('click', async () => {
      const ok = await attempt(() => api('/api/ops/incidents', { method: 'POST', body: { title: $('#in-title', body).value, impact: $('#in-impact', body).value, text: $('#in-text', body).value, serverIds: [...$('#in-servers', body).selectedOptions].map((o) => o.value), status: $('#in-impact', body).value === 'maintenance' ? 'monitoring' : 'investigating' } }), 'Posted');
      if (ok) draw();
    });
    body.querySelectorAll('[data-up]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = b.dataset.up;
        const ok = await attempt(() => api(`/api/ops/incidents/${id}`, { method: 'POST', body: { status: $(`[data-st="${id}"]`, body).value, text: $(`[data-tx="${id}"]`, body).value } }), 'Updated');
        if (ok) draw();
      })
    );
    body.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await confirmModal('Delete this incident', 'It disappears from the status page.', 'Delete'))) return;
        if (await attempt(() => api(`/api/ops/incidents/${b.dataset.del}`, { method: 'DELETE' }))) draw();
      })
    );
  };
  await draw();
}
