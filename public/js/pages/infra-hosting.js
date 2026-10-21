import { api } from '../core/api.js';
import { copyToClipboard } from '../ui/clipboard.js';
import { $, esc, fmtTime, toast } from '../core/util.js';
import { confirmModal } from '../ui/modal.js';

/*
 * Settings cards for hosting without port forwarding (playit.gg, Tailscale and
 * ZeroTier, the connectivity wizard), config sync to a repository, and
 * servers as a file. Mounted into Settings by settings.js.
 */

const copyBtn = (text) => `<button class="btn btn-sm" data-ih-copy="${esc(text)}">Copy</button>`;

function wireCopy(root) {
  root.querySelectorAll('[data-ih-copy]').forEach((b) => {
    b.onclick = () => copyToClipboard(b.dataset.ihCopy, b);
  });
}

async function action(btn, fn, done) {
  btn.disabled = true;
  try {
    const r = await fn();
    if (done) toast(done);
    return r;
  } catch (err) {
    toast(err.message, 'error', 9000);
  } finally {
    btn.disabled = false;
  }
  return null;
}

/* ------------------------------------------------------------ playit.gg */

async function drawPlayit(body, timer) {
  const st = await api('/api/hosting/playit').catch((err) => ({ error: err.message }));
  if (!body.isConnected) return clearInterval(timer.id);
  if (st.error) {
    body.innerHTML = `<span class="faint">${esc(st.error)}</span>`;
    return undefined;
  }
  const rows = st.servers
    .flatMap((s) => s.ports.filter((p) => p.name !== 'rcon').map((p) => ({ s, p })))
    .map(({ s, p }) => `<tr><td>${esc(s.name)}</td><td class="mono">${esc(p.name)} ${p.port}/${esc(p.protocol)}</td><td>${p.addresses.length ? p.addresses.map((a) => `<span class="mono">${esc(a)}</span> ${copyBtn(a)}`).join('<br>') : '<span class="faint">no tunnel yet</span>'}</td></tr>`)
    .join('');
  body.innerHTML = `
    <p class="faint" style="margin:0 0 12px">playit.gg gives your server a public address and a small program on this machine carries the traffic, so you do not open any ports and players install nothing. Free account at playit.gg.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <span class="mono faint">AGENT: ${st.installed ? `INSTALLED ${esc(st.version || '')}` : 'NOT INSTALLED'} · ${esc(st.status.toUpperCase())}</span>
      ${st.installed ? '' : st.platformSupported ? '<button class="btn btn-primary btn-sm" id="pl-install">Install agent</button>' : '<span class="faint">No agent build for this system: install it from playit.gg/download.</span>'}
      ${st.installed ? `<button class="btn btn-sm" id="pl-install">Update agent</button>` : ''}
      ${st.installed && !st.running ? '<button class="btn btn-primary btn-sm" id="pl-start">Start</button>' : ''}
      ${st.running ? '<button class="btn btn-sm" id="pl-stop">Stop</button>' : ''}
      ${st.claimed ? '<button class="btn btn-sm btn-danger" id="pl-reset">Unlink this machine</button>' : ''}
      <label class="checkbox-row" style="margin:0"><input type="checkbox" id="pl-auto" ${st.autoStart ? 'checked' : ''} ${st.claimed ? '' : 'disabled'} /><span>Start with the panel</span></label>
    </div>
    <div class="faint" style="margin-bottom:8px">Installing downloads the agent for ${esc(navigator.platform || 'this system')} from github.com/playit-cloud/playit-agent releases and checks its size, file type and, when GitHub lists one, its SHA-256.</div>
    ${st.claim ? `<div class="filter-note mb-16">Approve this machine: open <a href="${esc(st.claim.url)}" target="_blank" rel="noopener noreferrer">${esc(st.claim.url)}</a> (code <span class="mono">${esc(st.claim.code)}</span>) and sign in to playit.gg. This page updates by itself.</div>` : ''}
    ${st.error ? `<div class="filter-note mb-16">${esc(st.error)}</div>` : ''}
    ${st.running && st.claimed ? `<div class="hint" style="margin-bottom:8px">Create a tunnel for each port on <a href="${esc(st.dashboard)}" target="_blank" rel="noopener noreferrer">playit.gg</a> (Add tunnel, pick the game, local address <span class="mono">127.0.0.1</span> and the port below). The public address then shows up here.${st.tunnelError ? ` (${esc(st.tunnelError)})` : ''}</div>` : ''}
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>Server</th><th>Port</th><th>Public address</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    ${st.seenAddresses.length ? `<div class="hint">Seen in the agent log: ${st.seenAddresses.map((a) => `<span class="mono">${esc(a)}</span>`).join(', ')}</div>` : ''}
    ${st.logs.length ? `<details><summary class="faint">Agent log</summary><pre class="mono" style="max-height:200px;overflow:auto;font-size:11px">${esc(st.logs.join('\n'))}</pre></details>` : ''}`;
  wireCopy(body);
  const post = (path, label) => (e) => action(e.currentTarget, () => api(path, { method: 'POST', body: {} }), label).then(() => drawPlayit(body, timer));
  if ($('#pl-install', body)) $('#pl-install', body).onclick = post('/api/hosting/playit/install', 'Agent installed');
  if ($('#pl-start', body)) $('#pl-start', body).onclick = post('/api/hosting/playit/start', 'Agent started');
  if ($('#pl-stop', body)) $('#pl-stop', body).onclick = post('/api/hosting/playit/stop', 'Agent stopping');
  if ($('#pl-reset', body)) {
    $('#pl-reset', body).onclick = async (e) => {
      if (await confirmModal('Unlink playit', 'This machine forgets its playit login. Tunnels on playit.gg are not deleted, but you will approve this machine again to use them.', 'Unlink')) post('/api/hosting/playit/reset', 'Unlinked')(e);
    };
  }
  $('#pl-auto', body).onchange = (e) => api('/api/hosting/playit', { method: 'PUT', body: { autoStart: e.target.checked } }).catch((err) => toast(err.message, 'error'));
  return undefined;
}

/* ---------------------------------------------------- Tailscale / ZeroTier */

async function drawVpn(body) {
  const st = await api('/api/hosting/vpn').catch((err) => ({ error: err.message }));
  if (!body.isConnected) return;
  if (st.error) {
    body.innerHTML = `<span class="faint">${esc(st.error)}</span>`;
    return;
  }
  const ts = st.tailscale;
  const zt = st.zerotier;
  const addr = st.servers
    .flatMap((s) => s.ports.filter((p) => p.addresses.length).map((p) => `<tr><td>${esc(s.name)}</td><td class="mono">${esc(p.name)}/${esc(p.protocol)}</td><td>${p.addresses.map((a) => `<span class="mono">${esc(a.address)}</span> <span class="faint">${esc(a.via)}</span> ${copyBtn(a.address)}`).join('<br>')}</td></tr>`))
    .join('');
  const install = (which, label) => `<div class="hint">${esc(st.install[which].says)}${st.canInstall ? '' : ` Download it from ${esc(st.install[which].download)}.`}<br>By hand: <span class="mono">${esc(st.install[which].manual)}</span></div>${st.canInstall ? `<button class="btn btn-sm" data-ih-install="${which}">Install ${label}</button>` : ''}`;
  body.innerHTML = `
    <p class="faint" style="margin:0 0 12px">A fallback if the bridge does not work: you and your players join one private network (Tailscale or ZeroTier) and connect to this machine's private address. Everyone needs the app installed.</p>
    <div class="grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
      <div>
        <h4 style="margin-top:0">Tailscale</h4>
        ${ts.installed ? `<div class="mono faint">${esc(ts.up ? `CONNECTED · ${ts.ipv4 || ''}${ts.dnsName ? ` · ${ts.dnsName}` : ''}` : (ts.state || 'NOT CONNECTED').toUpperCase())}</div>
          ${ts.up ? '<button class="btn btn-sm" id="ts-leave">Disconnect</button>' : `<label class="field"><span>Auth key (tskey-…, from the Tailscale admin console, Settings, Keys)</span><input type="password" id="ts-key" autocomplete="off" placeholder="${ts.keySaved ? 'saved: leave empty to reuse' : 'tskey-auth-…'}" /></label>
          <label class="checkbox-row"><input type="checkbox" id="ts-remember" /><span>Remember the key (kept encrypted)</span></label>
          <button class="btn btn-primary btn-sm" id="ts-join">Connect</button>`}` : install('tailscale', 'Tailscale')}
      </div>
      <div>
        <h4 style="margin-top:0">ZeroTier</h4>
        ${zt.installed ? `<div class="mono faint">${zt.running ? `NODE ${esc(zt.nodeId || '')}` : 'NOT RUNNING'}${zt.error ? ` · ${esc(zt.error)}` : ''}</div>
          ${(zt.networks || []).map((n) => `<div class="row" style="gap:8px;align-items:center"><span class="mono">${esc(n.id)}</span> <span class="faint">${esc(n.name)} ${esc(n.status)} ${esc(n.ips.join(', '))}</span><button class="btn btn-sm" data-ih-zleave="${esc(n.id)}">Leave</button></div>`).join('')}
          <label class="field"><span>Network id (16 characters, from my.zerotier.com)</span><input id="zt-id" maxlength="16" value="${esc(zt.savedNetwork)}" /></label>
          <div class="hint">After joining, approve this machine in ZeroTier Central (tick Auth).</div>
          <button class="btn btn-primary btn-sm" id="zt-join">Join network</button>` : install('zerotier', 'ZeroTier')}
      </div>
    </div>
    ${addr ? `<h4>Connect addresses over the private network</h4><div class="table-wrap"><table><thead><tr><th>Server</th><th>Port</th><th>Address for players</th></tr></thead><tbody>${addr}</tbody></table></div>` : ''}`;
  wireCopy(body);
  body.querySelectorAll('[data-ih-install]').forEach((b) => {
    b.onclick = async () => {
      const which = b.dataset.ihInstall;
      if (!(await confirmModal(`Install ${which}`, st.install[which].says, 'Run installer'))) return;
      const r = await action(b, () => api('/api/hosting/vpn/install', { method: 'POST', body: { which } }), 'Installed');
      if (r) drawVpn(body);
    };
  });
  const post = (path, payload, label) => (e) => action(e.currentTarget, () => api(path, { method: 'POST', body: payload() }), label).then((r) => r && drawVpn(body));
  if ($('#ts-join', body)) $('#ts-join', body).onclick = post('/api/hosting/vpn/join', () => ({ which: 'tailscale', authKey: $('#ts-key').value, remember: $('#ts-remember').checked }), 'Connected to Tailscale');
  if ($('#ts-leave', body)) $('#ts-leave', body).onclick = post('/api/hosting/vpn/leave', () => ({ which: 'tailscale' }), 'Disconnected');
  if ($('#zt-join', body)) $('#zt-join', body).onclick = post('/api/hosting/vpn/join', () => ({ which: 'zerotier', networkId: $('#zt-id').value }), 'Join request sent');
  body.querySelectorAll('[data-ih-zleave]').forEach((b) => {
    b.onclick = post('/api/hosting/vpn/leave', () => ({ which: 'zerotier', networkId: b.dataset.ihZleave }), 'Left the network');
  });
}

/* --------------------------------------------------------------- wizard */

async function drawWizard(body) {
  const { servers } = await api('/api/servers').catch(() => ({ servers: [] }));
  body.innerHTML = `
    <p class="faint" style="margin:0 0 12px">Not sure how to let people in? This tests what it can and recommends a way, in order: port forward, the bridge, playit.gg, then Tailscale or ZeroTier.</p>
    <div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
      <label class="field" style="margin:0;min-width:220px"><span>Server to test (optional, must be running)</span><select id="wz-server"><option value="">No server: just look at this network</option>${servers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.status)})</option>`).join('')}</select></label>
      <button class="btn btn-primary" id="wz-run">Check and recommend</button>
    </div>
    <div id="wz-out" style="margin-top:14px"></div>`;
  $('#wz-run', body).onclick = async (e) => {
    const serverId = $('#wz-server', body).value;
    const r = await action(e.currentTarget, () => api('/api/hosting/wizard', { method: 'POST', body: { serverId: serverId || undefined, check: Boolean(serverId) } }));
    if (!r) return;
    const label = { working: 'WORKS', ready: 'READY', available: 'NOT SET UP', unlikely: 'WILL NOT WORK' };
    $('#wz-out', body).innerHTML = `
      <div class="filter-note mb-16"><strong>${esc(r.summary)}</strong>${r.notes.length ? `<br>${r.notes.map(esc).join('<br>')}` : ''}</div>
      ${r.methods.map((m) => `<div class="card mb-16" style="${m.id === r.recommended ? 'border-color:var(--accent)' : ''}"><div class="mono faint">${esc(label[m.status] || m.status)}${m.id === r.recommended ? ' · RECOMMENDED' : ''}</div><h4 style="margin:4px 0 8px">${esc(m.title)}</h4><ol style="margin:0;padding-left:20px">${m.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>`).join('')}`;
  };
}

/* ---------------------------------------------------------- config sync */

async function drawSync(body) {
  const st = await api('/api/config-sync').catch((err) => ({ error: err.message }));
  if (!body.isConnected) return;
  if (st.error) {
    body.innerHTML = `<span class="faint">${esc(st.error)}</span>`;
    return;
  }
  body.innerHTML = `
    <p class="faint" style="margin:0 0 12px">Keeps the panel's settings and each server's config files in a git repository (a private repository on GitHub works well), so you have an off-site history and can restore or copy a setup to another machine. ${esc(st.never)}</p>
    ${st.gitInstalled ? '' : '<div class="filter-note mb-16">Git is not installed on this machine. Install it first (Linux: sudo apt install git).</div>'}
    <label class="field"><span>Repository address (https://github.com/you/panel-config.git)</span><input id="cs-remote" value="${esc(st.remote)}" placeholder="https://github.com/you/panel-config.git" /></label>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <label class="field" style="width:140px"><span>Branch</span><input id="cs-branch" value="${esc(st.branch)}" /></label>
      <label class="field" style="width:200px"><span>Access token ${st.tokenSet ? '(saved)' : ''}</span><input type="password" id="cs-token" autocomplete="off" placeholder="${st.tokenSet ? 'leave empty to keep' : 'GitHub token with repo access'}" /></label>
      <label class="field" style="width:160px"><span>Token username</span><input id="cs-user" value="${esc(st.username)}" /></label>
      <label class="field" style="width:160px"><span>Sync every (hours, 0 = by hand)</span><input type="number" id="cs-hours" min="0" max="720" value="${st.everyHours}" /></label>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cs-on" ${st.enabled ? 'checked' : ''} /><label for="cs-on">Sync automatically on that schedule</label></div>
    <details style="margin:10px 0"><summary class="faint">Which config files per server (one per line; a folder ends with /)</summary>
      <div class="hint">Empty means the defaults: ${st.defaults.map((d) => `<span class="mono">${esc(d)}</span>`).join(', ')}. Only small text config files; world folders, jars and files named like secrets are always skipped; lines with passwords are blanked.</div>
      ${st.servers.map((s) => `<label class="field"><span>${esc(s.name)}</span><textarea rows="3" data-cs-server="${esc(s.id)}" placeholder="plugins/Essentials/">${esc((s.files || []).join('\n'))}</textarea></label>`).join('')}
    </details>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" id="cs-save">Save</button>
      <button class="btn" id="cs-run">Sync now</button>
      <button class="btn" id="cs-preview">Restore preview…</button>
    </div>
    <div class="hint">${st.lastRun ? `Last run ${esc(fmtTime(st.lastRun))}${st.lastCommit ? `, commit ${esc(st.lastCommit)}` : ''}${st.lastPush ? `, pushed ${esc(fmtTime(st.lastPush))}` : ''}.` : 'Never run.'} ${st.lastError ? `<span style="color:var(--red)">${esc(st.lastError)}</span>` : ''}</div>
    <div id="cs-out" style="margin-top:12px"></div>`;
  const save = async (btn) => {
    const files = {};
    body.querySelectorAll('[data-cs-server]').forEach((t) => {
      files[t.dataset.csServer] = t.value.trim() ? t.value : null;
    });
    return action(btn, () => api('/api/config-sync', { method: 'PUT', body: { remote: $('#cs-remote', body).value, branch: $('#cs-branch', body).value, token: $('#cs-token', body).value, username: $('#cs-user', body).value, everyHours: Number($('#cs-hours', body).value), enabled: $('#cs-on', body).checked, files } }), 'Saved');
  };
  $('#cs-save', body).onclick = async (e) => {
    if (await save(e.currentTarget)) drawSync(body);
  };
  $('#cs-run', body).onclick = async (e) => {
    const btn = e.currentTarget;
    if (!(await save(btn))) return;
    const r = await action(btn, () => api('/api/config-sync/run', { method: 'POST', body: {} }));
    if (!r) return;
    toast(`${r.result.committed ? 'Committed' : 'Nothing changed'}${r.result.pushed ? ' and pushed' : ''} (${r.result.files} files)`);
    drawSync(body);
  };
  $('#cs-preview', body).onclick = async (e) => {
    const p = await action(e.currentTarget, () => api('/api/config-sync/restore/preview', { method: 'POST', body: {} }));
    if (!p) return;
    const plan = p.servers;
    $('#cs-out', body).innerHTML = `
      <div class="filter-note mb-16">Repository at <span class="mono">${esc(p.commit)}</span>. Nothing has been changed yet. Pick what to restore.</div>
      <label class="checkbox-row"><input type="checkbox" id="rs-settings" /><span>Panel settings (${p.settings.length ? `changes: ${p.settings.map(esc).join(', ')}` : 'no differences'})</span></label>
      <label class="checkbox-row"><input type="checkbox" id="rs-servers" /><span>Servers: ${plan?.error ? esc(plan.error) : plan ? `${plan.counts.create} to create, ${plan.counts.update} to update, ${plan.counts.unchanged} unchanged${plan.counts.error ? `, ${plan.counts.error} with problems` : ''}` : 'none'} (nothing is deleted)</span></label>
      <label class="checkbox-row"><input type="checkbox" id="rs-files" /><span>Config files (${p.files.filter((f) => f.status !== 'same').length} differ)</span></label>
      ${p.files.filter((f) => f.status !== 'same').slice(0, 40).map((f) => `<div class="mono faint">${esc(f.server)}/${esc(f.path)}: ${esc(f.status)}</div>`).join('')}
      <button class="btn btn-primary" id="rs-apply" style="margin-top:10px">Restore selected</button>`;
    $('#rs-apply', body).onclick = async (ev) => {
      const payload = { settings: $('#rs-settings', body).checked, servers: $('#rs-servers', body).checked, files: $('#rs-files', body).checked };
      if (!payload.settings && !payload.servers && !payload.files) return toast('Tick something to restore');
      if (!(await confirmModal('Restore from the repository', 'This overwrites the ticked panel settings, creates or changes servers, and rewrites the listed config files. Running servers need a restart to use new files.', 'Restore'))) return undefined;
      const r = await action(ev.currentTarget, () => api('/api/config-sync/restore/apply', { method: 'POST', body: payload }), 'Restored');
      if (r) $('#cs-out', body).innerHTML = `<div class="filter-note">Done: ${r.settings ? 'settings, ' : ''}${r.servers ? `${r.servers.applied.length} server change(s), ` : ''}${r.files.filter((f) => f.written).length} file(s) written${r.files.some((f) => f.skipped) ? `, ${r.files.filter((f) => f.skipped).length} kept as they were (they hold passwords)` : ''}.</div>`;
      return undefined;
    };
  };
}

/* ------------------------------------------------------ servers as a file */

function drawIac(body) {
  body.innerHTML = `
    <p class="faint" style="margin:0 0 12px">All your servers as one YAML file (or JSON). Export, edit, then preview what would change and apply it in one go. Fields you leave out are not touched; nothing is deleted unless the file says <span class="mono">prune: true</span>. Secret variables (passwords, tokens) are never in the file: set them in the panel. Also available as <span class="mono">gamepanel apply servers.yaml</span>.</p>
    <textarea id="iac-text" rows="14" class="mono" spellcheck="false" placeholder="Press Export, or paste a file here"></textarea>
    <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
      <button class="btn" id="iac-export">Export current servers</button>
      <input type="file" id="iac-file" accept=".yaml,.yml,.json,text/plain" style="max-width:240px" />
      <button class="btn btn-primary" id="iac-plan">Preview plan</button>
    </div>
    <div id="iac-out" style="margin-top:12px"></div>`;
  $('#iac-export', body).onclick = async (e) => {
    const r = await action(e.currentTarget, () => api('/api/infra/export'));
    if (r) $('#iac-text', body).value = r.yaml;
  };
  $('#iac-file', body).onchange = async (e) => {
    const f = e.target.files[0];
    if (f && f.size < 2_000_000) $('#iac-text', body).value = await f.text();
  };
  $('#iac-plan', body).onclick = async (e) => {
    const text = $('#iac-text', body).value;
    const plan = await action(e.currentTarget, () => api('/api/infra/plan', { method: 'POST', body: { text } }));
    if (!plan) return;
    const mark = { create: '+', update: '~', unchanged: '=', delete: '-', error: '!' };
    $('#iac-out', body).innerHTML = `
      <div class="filter-note mb-16">${plan.counts.create} to create, ${plan.counts.update} to update, ${plan.counts.unchanged} unchanged, ${plan.counts.delete} to remove, ${plan.counts.error} with problems.</div>
      <pre class="mono" style="font-size:12px;overflow:auto">${plan.actions.map((a) => `${mark[a.action]} ${esc(a.name)} ${a.action}${a.errors ? `\n    ${a.errors.map(esc).join('\n    ')}` : ''}${(a.changes || []).map((c) => `\n    ${esc(c.field)}: ${esc(JSON.stringify(c.from))} -> ${esc(JSON.stringify(c.to))}`).join('')}`).join('\n')}</pre>
      ${plan.ok && plan.counts.create + plan.counts.update + plan.counts.delete ? `<button class="btn btn-primary" id="iac-apply">Apply${plan.counts.delete ? ' (removes servers)' : ''}</button>` : ''}`;
    const apply = $('#iac-apply', body);
    if (!apply) return;
    apply.onclick = async (ev) => {
      if (plan.counts.delete && !(await confirmModal('Remove servers', `${plan.counts.delete} server(s) not in the file will be removed from the panel (their folders stay on disk).`, 'Apply and remove'))) return;
      const r = await action(ev.currentTarget, () => api('/api/infra/apply', { method: 'POST', body: { text, confirmPrune: plan.counts.delete > 0 } }), 'Applied');
      if (r) $('#iac-out', body).innerHTML = `<div class="filter-note">${r.applied.map((a) => `${esc(a.action)} ${esc(a.name)}${a.error ? ` failed: ${esc(a.error)}` : ''}`).join('<br>')}${r.restartNeeded.length ? `<br>Restart to use the changes: ${r.restartNeeded.map(esc).join(', ')}` : ''}</div>`;
    };
  };
}

/** Fill the cards the Settings page left empty. Safe to call when they are not on the page. */
export function mountInfraCards() {
  const timer = { id: null };
  const playit = $('#ih-playit-body');
  if (playit) {
    drawPlayit(playit, timer);
    timer.id = setInterval(() => drawPlayit(playit, timer), 5000);
  }
  const vpn = $('#ih-vpn-body');
  if (vpn) drawVpn(vpn);
  const wiz = $('#ih-wizard-body');
  if (wiz) drawWizard(wiz);
  const sync = $('#ih-sync-body');
  if (sync) drawSync(sync);
  const iac = $('#ih-iac-body');
  if (iac) drawIac(iac);
}
