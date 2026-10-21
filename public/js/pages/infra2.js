import { api } from '../core/api.js';
import { $, esc, fmtBytes, fmtDuration, fmtTime, toast } from '../core/util.js';
import { confirmModal } from '../ui/modal.js';

/* Storage tab, vault tools, host health card, log rules and update extras. */

const COLORS = { world: '#c6f432', mods: '#6cb6ff', logs: '#ffb340', cache: '#b48cff', other: '#8a8880' };
const num = (el) => Math.max(0, Number(el?.value) || 0);
const bar = (pct, color = 'var(--accent)') => `<div class="infra2-bar"><i style="width:${Math.max(1, Math.min(100, pct))}%;background:${color}"></i></div>`;
const rate = (n) => `${fmtBytes(n || 0)}/s`;

/* ------------------------------------------------------------- storage -- */

export async function renderStorageTab(host, server) {
  host.innerHTML = '<div class="faint"><span class="spinner"></span> Scanning the server folder…</div>';
  let data;
  try {
    data = await api(`/api/servers/${server.id}/storage`);
  } catch (err) {
    host.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  if (!host.isConnected) return;
  const d = data.disk;
  const max = Math.max(1, ...d.folders.map((f) => f.bytes));
  const kinds = Object.entries(data.kinds).sort((a, b) => b[1] - a[1]);
  host.innerHTML = `
    <div class="card mb-16">
      <div class="row mb-16"><h4 style="margin:0">Disk use</h4><span class="faint" style="flex:1">${fmtBytes(d.total)} in the server folder${d.truncated ? ' (scan stopped early: the folder is huge, so this is partial)' : ''}. Scanned ${esc(fmtTime(d.at))}.</span>
        <button class="btn btn-sm" id="st-rescan">Scan again</button></div>
      <div class="infra2-stack">${kinds.map(([k, v]) => `<i title="${esc(k)} ${esc(fmtBytes(v))}" style="flex:${v};background:${COLORS[k] || COLORS.other}"></i>`).join('')}</div>
      <div class="faint mb-16" style="font-size:12.5px;margin-top:6px">${kinds.map(([k, v]) => `<span style="margin-right:12px"><b style="color:${COLORS[k] || COLORS.other}">&#9632;</b> ${esc(k)} ${esc(fmtBytes(v))}</span>`).join('')}</div>
      <table><tbody>${d.folders
        .slice(0, 25)
        .map((f) => `<tr><td class="mono" style="width:30%">${esc(f.name)}</td><td style="width:50%">${bar((f.bytes / max) * 100, COLORS[f.kind] || COLORS.other)}</td><td class="faint nowrap">${esc(fmtBytes(f.bytes))}</td><td class="faint nowrap">${f.files} files</td></tr>`)
        .join('')}</tbody></table>
      <h4 style="margin:18px 0 8px">Biggest files</h4>
      <table><tbody>${d.biggest.map((f) => `<tr><td class="mono">${esc(f.path)}</td><td class="faint nowrap">${esc(fmtBytes(f.size))}</td><td class="faint nowrap">${esc(fmtTime(f.mtime))}</td></tr>`).join('') || '<tr><td class="faint">No files</td></tr>'}</tbody></table>
      ${data.backups ? `<p class="faint" style="margin:12px 0 0">Incremental backups of this server take ${esc(fmtBytes(data.backups.bytes))} (outside this folder).</p>` : ''}
    </div>
    <div class="card mb-16" id="st-net"></div>
    <div class="card mb-16" id="st-logs"></div>`;
  $('#st-rescan').addEventListener('click', async () => {
    $('#st-rescan').disabled = true;
    await api(`/api/servers/${server.id}/storage?refresh=1`).catch((err) => toast(err.message, 'error'));
    renderStorageTab(host, server);
  });
  renderNetwork($('#st-net'), server, data.network);
  renderLogRules($('#st-logs'), server);
}

async function renderNetwork(box, server, net) {
  const month = new Date().toISOString().slice(0, 7);
  if (!net.available) {
    box.innerHTML = `<h4>Bandwidth</h4><p class="faint" style="margin:0">${esc(net.reason)}</p>`;
    return;
  }
  const history = await api(`/api/servers/${server.id}/history?range=24h`).then((r) => r.history).catch(() => []);
  const peak = Math.max(1, ...history.map((p) => Math.max(p.rx || 0, p.tx || 0)));
  const bars = history
    .filter((_, i) => i % Math.max(1, Math.ceil(history.length / 96)) === 0)
    .map((p) => `<i title="${esc(fmtTime(p.t))}: in ${esc(rate(p.rx))}, out ${esc(rate(p.tx))}" style="height:${Math.max(2, ((p.rx || 0) / peak) * 100)}%"></i>`)
    .join('');
  box.innerHTML = `<h4>Bandwidth</h4>
    <p class="faint" style="margin:0 0 10px">Now: in ${esc(rate(net.rx))}, out ${esc(rate(net.tx))}. ${esc(net.note)}</p>
    <div class="infra2-spark" title="Last 24 hours, incoming">${bars || '<span class="faint">No history yet</span>'}</div>
    <table style="margin-top:12px"><thead><tr><th>Month</th><th>In</th><th>Out</th></tr></thead><tbody>${
      net.months.length ? net.months.map((m) => `<tr><td class="mono">${esc(m.month)}${m.month === month ? ' (so far)' : ''}</td><td>${esc(fmtBytes(m.rx))}</td><td>${esc(fmtBytes(m.tx))}</td></tr>`).join('') : '<tr><td class="faint" colspan="3">Totals appear once traffic has been counted.</td></tr>'
    }</tbody></table>`;
}

/* ----------------------------------------------------------- log rules -- */

function rulesForm(prefix, r) {
  return `<div class="row" style="gap:14px;flex-wrap:wrap;align-items:end">
    <label class="field" style="margin:0"><span>Delete logs older than (days, 0 = never)</span><input type="number" min="0" id="${prefix}-del" value="${r.deleteDays}" style="width:110px" /></label>
    <label class="field" style="margin:0"><span>Compress logs older than (days)</span><input type="number" min="0" id="${prefix}-gz" value="${r.gzipDays}" style="width:110px" /></label>
    <label class="field" style="margin:0"><span>Keep a log folder under (MB)</span><input type="number" min="0" id="${prefix}-max" value="${r.maxMb}" style="width:110px" /></label>
  </div>`;
}
const readRules = (prefix, enabled) => ({ enabled, deleteDays: num($(`#${prefix}-del`)), gzipDays: num($(`#${prefix}-gz`)), maxMb: num($(`#${prefix}-max`)) });

function reportHtml(rep) {
  const groups = [...rep.servers, ...(rep.panel ? [rep.panel] : [])];
  const rows = groups.flatMap((g) => g.actions.map((a) => `<tr><td>${esc(g.name)}</td><td class="mono">${esc(a.rel)}</td><td>${esc(a.action)}</td><td class="faint nowrap">${esc(fmtBytes(a.size))}</td><td class="faint">${esc(a.reason)}</td></tr>`));
  const head = rep.dryRun ? `Preview: ${rep.totals.planned} file${rep.totals.planned === 1 ? '' : 's'} would be changed. Nothing was touched.` : `Done: ${rep.totals.deleted} deleted, ${rep.totals.gzipped} compressed, ${fmtBytes(rep.totals.freed)} freed.`;
  return `<p style="margin:10px 0 6px">${esc(head)}</p>${rows.length ? `<div class="table-wrap" style="max-height:260px;overflow:auto"><table><tbody>${rows.join('')}</tbody></table></div>` : ''}`;
}

async function renderLogRules(box, server) {
  let data;
  try {
    data = await api(`/api/servers/${server.id}/log-rules`);
  } catch {
    box.remove();
    return;
  }
  const r = data.rules;
  box.innerHTML = `<h4>Log rules</h4>
    <p class="faint" style="margin:0 0 10px">Tidy this server's logs (${data.dirs.map(esc).join(', ')} and *.log files) once a day. The log being written right now and anything changed in the last hour are never touched. Global rules live under Settings.</p>
    <div class="checkbox-row"><input type="checkbox" id="lr-over" ${r.override ? 'checked' : ''} /><label for="lr-over">Use rules for this server instead of the global ones</label></div>
    <div class="checkbox-row"><input type="checkbox" id="lr-on" ${r.enabled ? 'checked' : ''} /><label for="lr-on">Turn these rules on</label></div>
    ${rulesForm('lr', r)}
    <div class="row" style="gap:8px;margin-top:12px"><button class="btn" id="lr-save">Save</button><button class="btn" id="lr-preview">Preview</button><button class="btn btn-danger" id="lr-run">Run now</button></div>
    <div id="lr-out"></div>`;
  const body = () => ({ ...readRules('lr', $('#lr-on').checked), override: $('#lr-over').checked });
  $('#lr-save').addEventListener('click', () => api(`/api/servers/${server.id}/log-rules`, { method: 'PUT', body: body() }).then(() => toast('Saved'), (e) => toast(e.message, 'error')));
  const go = async (dryRun) => {
    try {
      await api(`/api/servers/${server.id}/log-rules`, { method: 'PUT', body: body() });
      $('#lr-out').innerHTML = reportHtml(await api(`/api/servers/${server.id}/log-rules/run`, { method: 'POST', body: { dryRun } }));
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  $('#lr-preview').addEventListener('click', () => go(true));
  $('#lr-run').addEventListener('click', async () => {
    if (await confirmModal('Run log rules', 'Old logs matching these rules are deleted or compressed now. Preview first if unsure.', 'Run')) go(false);
  });
}

/* --------------------------------------------------------- vault tools -- */

export function renderVaultTools(host, server, data) {
  if (data.mode !== 'incremental' && !data.vault) return;
  const box = document.createElement('div');
  box.className = 'card mt-16';
  box.innerHTML = `<h4>Incremental backup tools</h4>
    <p class="faint" style="margin:0 0 10px">Check that every stored piece is present (deep check re-reads them all), remove old backups by age or count, and free the space of pieces nothing uses any more.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
      <button class="btn" id="vt-check">Check</button><button class="btn" id="vt-deep">Deep check</button><button class="btn" id="vt-compact">Free unused space</button>
      <label class="field" style="margin:0"><span>Keep newest</span><input type="number" min="0" id="vt-last" value="${data.retention || 0}" style="width:80px" /></label>
      <label class="field" style="margin:0"><span>and younger than (days)</span><input type="number" min="0" id="vt-days" value="0" style="width:80px" /></label>
      <button class="btn" id="vt-preview">Preview removal</button><button class="btn btn-danger" id="vt-prune">Remove old</button>
    </div><div id="vt-out" class="faint" style="margin-top:10px"></div>`;
  host.appendChild(box);
  const out = (t) => ($('#vt-out').textContent = t);
  const call = async (path, body, fmt) => {
    out('Working…');
    try {
      out(fmt(await api(`/api/servers/${server.id}/backups/vault/${path}`, { method: 'POST', body })));
    } catch (e) {
      out('');
      toast(e.message, 'error');
    }
  };
  const chk = (r) => `${r.ok ? 'All good' : 'PROBLEMS FOUND'}: ${r.snapshots} backups, ${r.files} files, ${r.pieces} pieces${r.deep ? ' (every piece re-read)' : ''}. ${r.missing.length} missing, ${r.damaged.length} damaged, ${r.unreadable.length} unreadable. ${r.orphans} unused pieces (${fmtBytes(r.orphanBytes)}). ${r.ms} ms.`;
  $('#vt-check').addEventListener('click', () => call('check', {}, chk));
  $('#vt-deep').addEventListener('click', () => call('check', { deep: true }, chk));
  $('#vt-compact').addEventListener('click', () => call('compact', {}, (r) => `Freed ${fmtBytes(r.freed)}.`));
  const prune = (dryRun) => call('retention', { keepLast: num($('#vt-last')), keepDays: num($('#vt-days')), dryRun }, (r) => `${r.dryRun ? 'Would remove' : 'Removed'} ${r.removed.length} backup${r.removed.length === 1 ? '' : 's'}${r.dryRun ? '' : `, freed ${fmtBytes(r.freed)}`}.${r.removed.length ? ` ${r.removed.slice(0, 5).join(', ')}` : ''}`);
  $('#vt-preview').addEventListener('click', () => prune(true));
  $('#vt-prune').addEventListener('click', async () => {
    if (await confirmModal('Remove old backups', 'Old incremental backups are deleted for good, and the pieces only they used.', 'Remove')) prune(false);
  });
}

/* ------------------------------------------------------- host health card -- */

let last = 0;
export async function renderHostCard(box, force = false) {
  if (!box || (!force && Date.now() - last < 60_000)) return;
  last = Date.now();
  let h;
  try {
    h = await api('/api/system/host-health');
  } catch {
    box.innerHTML = '';
    return;
  }
  if (!box.isConnected) return;
  const f = h.disk?.forecast;
  const drives = h.smart.available ? h.smart.drives.map((d) => `<div>${esc(d.model)}: <b style="color:${d.passed === false ? 'var(--danger)' : 'var(--success)'}">${d.passed === false ? 'FAILING' : d.passed ? 'healthy' : esc(d.health || 'unknown')}</b>${d.temperature != null ? `, ${d.temperature} °C` : ''}${d.wearUsedPercent != null ? `, ${d.wearUsedPercent}% worn` : ''}</div>`).join('') || `<span class="faint">${esc(h.smart.hint || 'No drives reported')}</span>` : `<span class="faint">${esc(h.smart.hint || h.smart.error || 'Not available')}</span>`;
  const temps = h.temps.available ? h.temps.sensors.slice(0, 6).map((s) => `<div>${esc(s.name)}: ${s.celsius != null ? `${s.celsius} °C` : ''} ${s.warning ? `<b style="color:var(--danger)">${esc(s.warning)}</b>` : ''}</div>`).join('') : `<span class="faint">${esc(h.temps.hint || 'Not available')}</span>`;
  box.innerHTML = `
    <div class="row" style="margin-bottom:10px"><h2 class="section-title" style="margin:0">Host health</h2><div class="spacer" style="flex:1"></div>
      <button class="btn btn-sm" id="hh-refresh">Refresh</button> <button class="btn btn-sm" id="hh-restart">Restart host…</button> <button class="btn btn-sm btn-danger" id="hh-shutdown">Shut down host…</button></div>
    <div class="card mb-16">
      ${h.problems.length ? `<div style="color:var(--danger);margin-bottom:10px">${h.problems.map((p) => `<div>${esc(p.text)}</div>`).join('')}</div>` : ''}
      <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
        <div><div class="tile-label">Uptime</div>${esc(fmtDuration(h.uptime * 1000))}${h.reboot.required ? '<div style="color:var(--warn,#ffb340)">Reboot required</div>' : ''}</div>
        <div><div class="tile-label">Disk full forecast</div>${f?.days != null ? `about ${f.days} days (+${esc(fmtBytes(f.perDay))}/day)` : `<span class="faint">${esc(f?.note || 'unknown')}</span>`}</div>
        <div><div class="tile-label">OS updates</div>${h.updates.available ? `${h.updates.count} pending${h.updates.security ? ` (${h.updates.security} security)` : ''} <span class="faint">${esc(h.updates.manager)}</span>` : `<span class="faint">${esc(h.updates.hint || h.updates.error || 'Not available')}</span>`}</div>
        <div><div class="tile-label">Disk health (SMART)</div>${drives}</div>
        <div><div class="tile-label">Temperatures</div>${temps}</div>
      </div>
      <div id="hh-power" class="faint" style="margin-top:10px"></div>
    </div>`;
  $('#hh-refresh').addEventListener('click', () => renderHostCard(box, true).then(() => api('/api/system/host-health?refresh=1').then(() => renderHostCard(box, true))));
  $('#hh-restart').addEventListener('click', () => powerFlow('reboot', box));
  $('#hh-shutdown').addEventListener('click', () => powerFlow('shutdown', box));
  watchPower(box, h.power);
}

function watchPower(box, st) {
  const el = $('#hh-power');
  if (!el || !st || st.phase === 'idle') return;
  el.innerHTML = `${esc(st.action)} ${esc(st.phase)}${st.phase === 'countdown' ? `, in ${st.remaining}s` : ''}: ${st.servers.map((s) => `${esc(s.name)} (${esc(s.state)})`).join(', ') || 'no servers running'} ${st.cancellable ? '<button class="btn btn-sm" id="hh-cancel">Cancel</button>' : ''} ${st.error ? `<b style="color:var(--danger)">${esc(st.error)}</b>` : ''}`;
  $('#hh-cancel')?.addEventListener('click', () => api('/api/system/host-power', { method: 'DELETE' }).then(() => renderHostCard(box, true), (e) => toast(e.message, 'error')));
  if (st.phase !== 'cancelled' && st.phase !== 'failed' && st.phase !== 'rebooting') setTimeout(async () => box.isConnected && watchPower(box, await api('/api/system/host-power').catch(() => null)), 3000);
}

async function powerFlow(action, box) {
  const seconds = 60;
  let plan;
  try {
    plan = await api('/api/system/host-power/plan', { method: 'POST', body: { action, seconds } });
  } catch (e) {
    return toast(e.message, 'error');
  }
  const list = plan.servers.length ? plan.servers.map((s) => s.name).join(', ') : 'none';
  if (!plan.permission.ok) return toast(plan.permission.hint, 'error', 12000);
  const word = action === 'shutdown' ? 'shut down' : 'restart';
  if (!(await confirmModal(`${word[0].toUpperCase()}${word.slice(1)} the host`, `Players get a ${seconds} second warning, then these servers are stopped cleanly: ${list}. The machine then runs "${plan.command}". ${action === 'reboot' ? 'When it is back the panel starts the same servers.' : 'Starting the machine again is up to you; the same servers start when the panel is back.'}`, word[0].toUpperCase() + word.slice(1)))) return;
  try {
    const st = await api('/api/system/host-power', { method: 'POST', body: { action, seconds } });
    watchPower(box, st);
    renderHostCard(box, true);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ------------------------------------------------------------ settings -- */

export async function renderSettingsInfra2(card) {
  const [lr, hist] = await Promise.all([api('/api/settings/log-rules').catch(() => null), api('/api/system/update/history').catch(() => null)]);
  if (!card?.isConnected) return;
  if (hist) {
    const extra = document.createElement('div');
    extra.style.marginTop = '14px';
    extra.innerHTML = `<div class="checkbox-row"><input type="checkbox" id="up-auto" ${hist.autoCheck ? 'checked' : ''} /><label for="up-auto">Check for updates every 6 hours and send an alert when one is out</label></div>
      ${hist.rollback ? `<div class="row" style="gap:10px;align-items:center"><button class="btn btn-danger" id="up-rollback">Roll back to ${esc(String(hist.rollback.from).slice(0, 12))}</button><span class="faint">the version before the update of ${esc(fmtTime(hist.rollback.at))}</span></div>` : '<div class="faint">No earlier version to roll back to yet.</div>'}
      ${hist.history.length ? `<div class="faint" style="margin-top:8px;font-size:12.5px">${hist.history.slice(0, 5).map((e) => `${esc(fmtTime(e.at))}: ${esc(String(e.from).slice(0, 12))} → ${esc(String(e.to).slice(0, 12))}${e.rollback ? ' (rollback)' : ''}`).join('<br>')}</div>` : ''}`;
    card.appendChild(extra);
    $('#up-auto').addEventListener('change', (e) => api('/api/system/update/auto-check', { method: 'PUT', body: { enabled: e.target.checked } }).catch((er) => toast(er.message, 'error')));
    $('#up-rollback')?.addEventListener('click', async () => {
      if (!(await confirmModal('Roll back the panel', 'The panel goes back to the earlier version and restarts. Container servers keep running.', 'Roll back'))) return;
      try {
        await api('/api/system/update/rollback', { method: 'POST', body: {} });
        toast('Rolled back. The panel is restarting…');
        setTimeout(() => location.reload(), 6000);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
  if (lr) {
    const box = document.createElement('div');
    box.className = 'card mb-16';
    box.id = 'log-rules';
    box.innerHTML = `<h4>Log retention</h4>
      <p class="faint" style="margin:0 0 10px">Runs once a day for every server (unless it has its own rules on its Storage tab) and for the panel's own logs. Never touches the log being written.${lr.last ? ` Last run freed ${esc(fmtBytes(lr.last.freed))}.` : ''}</p>
      <div class="checkbox-row"><input type="checkbox" id="g-on" ${lr.rules.enabled ? 'checked' : ''} /><label for="g-on">Turn on global log rules</label></div>
      ${rulesForm('g', lr.rules)}
      <div class="row" style="gap:8px;margin-top:12px"><button class="btn" id="g-save">Save</button><button class="btn" id="g-preview">Preview</button></div><div id="g-out"></div>`;
    card.after(box);
    $('#g-save').addEventListener('click', () => api('/api/settings/log-rules', { method: 'PUT', body: readRules('g', $('#g-on').checked) }).then(() => toast('Saved'), (e) => toast(e.message, 'error')));
    $('#g-preview').addEventListener('click', async () => {
      try {
        await api('/api/settings/log-rules', { method: 'PUT', body: readRules('g', $('#g-on').checked) });
        $('#g-out').innerHTML = reportHtml(await api('/api/settings/log-rules/run', { method: 'POST', body: { dryRun: true } }));
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
}
