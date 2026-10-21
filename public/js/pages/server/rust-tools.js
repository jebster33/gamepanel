import { api } from '../../core/api.js';
import { $, can, esc, fmtTime, toast } from '../../core/util.js';
import { copyToClipboard } from '../../ui/clipboard.js';
import { qrSvg } from '../../ui/qr.js';

/* ------------------------------------------------------------ Rust tab */

// Presets (loot, stacks, day length), AFK and ping kick, teams, entity counts
// and the server card with a join QR. Routes: server/api/routes/rust-tools.js.

const SECTIONS = [
  ['info', 'Server card'],
  ['presets', 'Presets'],
  ['kick', 'AFK and ping kick'],
  ['teams', 'Teams'],
  ['entities', 'Entities'],
];

const url = (server, tail) => `/api/servers/${server.id}/${tail}`;
const opt = (value, label, current) => `<option value="${esc(value)}" ${String(current) === String(value) ? 'selected' : ''}>${esc(label)}</option>`;
const grid = (x, z) => `${Math.round(x)}, ${Math.round(z)}`;

export function renderRustTab(host, server) {
  const sections = SECTIONS.filter(([id]) => (id === 'teams' || id === 'entities' ? can('console') : true));
  let current = sections[0][0];
  host.innerHTML = `
    <div class="seg">${sections.map(([id, label]) => `<button class="seg-item ${id === current ? 'active' : ''}" data-rt="${id}">${label}</button>`).join('')}</div>
    <div id="rt-view" class="mt-16"></div>`;
  const show = () => {
    const box = $('#rt-view', host);
    box.innerHTML = '<p class="faint">Loading…</p>';
    ({ info: renderInfo, presets: renderPresets, kick: renderKick, teams: renderTeams, entities: renderEntities })[current](box, server).catch((err) => {
      box.innerHTML = `<div class="card"><p class="faint" style="margin:0">${esc(err.message)}</p></div>`;
    });
  };
  host.querySelectorAll('[data-rt]').forEach((btn) =>
    btn.addEventListener('click', () => {
      current = btn.dataset.rt;
      host.querySelectorAll('[data-rt]').forEach((b) => b.classList.toggle('active', b === btn));
      show();
    })
  );
  show();
}

/* ----------------------------------------------------------- server card */

async function renderInfo(box, server) {
  const info = await api(url(server, 'rust-info'));
  const link = info.connect;
  box.innerHTML = `
    <div class="card rt-card">
      ${info.headerImage ? `<img class="rt-header" src="${esc(info.headerImage)}" alt="" referrerpolicy="no-referrer" />` : ''}
      <div class="row" style="gap:20px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1 1 320px;min-width:240px">
          <h3 style="margin:0 0 4px">${esc(info.name)}</h3>
          <p class="faint" style="margin:0 0 12px">${esc(info.description) || 'No description set.'}</p>
          <table class="rt-facts"><tbody>
            <tr><th>Address</th><td class="mono">${esc(info.address || 'not known')}</td></tr>
            <tr><th>Players</th><td>${info.players} / ${info.maxPlayers}</td></tr>
            <tr><th>Map</th><td>${info.size} m, seed ${info.seed}</td></tr>
            <tr><th>Last wipe</th><td>${info.lastWipe ? esc(fmtTime(info.lastWipe)) : 'not recorded'}</td></tr>
            <tr><th>Gather rate</th><td>${info.gatherRate}x${info.teamLimit ? `, teams of up to ${info.teamLimit}` : ''}</td></tr>
            ${info.tags ? `<tr><th>Tags</th><td class="mono">${esc(info.tags)}</td></tr>` : ''}
          </tbody></table>
        </div>
        ${link ? `<div style="text-align:center"><div class="qr-box">${qrSvg(link, { size: 160 })}</div><div class="faint mono" style="font-size:11px;margin-top:6px">Scan to join (Steam)</div></div>` : ''}
      </div>
      <div class="row mt-16" style="gap:8px;flex-wrap:wrap">
        ${link ? '<button class="btn btn-sm" data-copy="connect">Copy join link</button>' : ''}
        ${info.address ? '<button class="btn btn-sm" data-copy="console">Copy client console command</button>' : ''}
      </div>
      <p class="hint" style="margin:12px 0 0">Rust+ is paired inside the game: open the game menu, choose Rust+, then Pair. Rust+ talks to the server on port <span class="mono">${esc(info.rustPlusPort ?? '?')}</span> (TCP), so that port has to be reachable from the internet. The panel cannot pair it for you.</p>
    </div>`;
  box.querySelector('[data-copy=connect]')?.addEventListener('click', (e) => copyToClipboard(link, e.currentTarget));
  box.querySelector('[data-copy=console]')?.addEventListener('click', (e) => copyToClipboard(`client.connect ${info.address}`, e.currentTarget));
}

/* --------------------------------------------------------------- presets */

async function renderPresets(box, server) {
  const v = await api(url(server, 'rust-tools'));
  const writable = can('files.write');
  const plugin = (key, p) => `
    <div class="hint" style="margin:0 0 8px">${esc(p.plugin)}: ${p.installed ? 'installed' : 'not installed'}${p.installed && !p.configReady ? '. Start the server once so it can make its config' : ''}.
      ${!p.installed && writable ? `<button class="btn btn-sm" data-install="${key}">Install ${esc(p.plugin)}</button>` : ''}</div>`;
  const cur = (p) => (p.current ? `<span class="badge accent">Applied: ${esc(p.current.preset)}</span>` : '');
  const t = v.time;
  const timeOpts = (value) => ['<option value="">Rust default</option>', ...t.values.map((n) => opt(n, `${n} min`, value))].join('');
  box.innerHTML = `
    ${v.oxide ? '' : '<div class="card mt-0"><p style="margin:0" class="faint">Loot and stack presets need uMod/Oxide. Turn on "Install uMod/Oxide" in Settings and update the server first. Day length works without it.</p></div>'}
    <div class="card mt-16">
      <div class="card-head"><h4>Loot multiplier</h4>${cur(v.loot)}</div>
      <p class="faint" style="margin:0 0 10px">How much more loot crates, barrels and scientists give. Uses the BetterLoot plugin.</p>
      ${plugin('loot', v.loot)}
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        ${v.loot.presets.map((p) => `<button class="btn btn-sm" data-loot="${p}">${p}</button>`).join('')}
        <input id="rt-loot-x" type="number" min="0.1" max="100" step="0.1" placeholder="Custom" style="width:96px" />
        <button class="btn btn-sm" data-loot="custom">Apply custom</button>
      </div>
    </div>
    <div class="card mt-16">
      <div class="card-head"><h4>Stack sizes</h4>${cur(v.stack)}</div>
      <p class="faint" style="margin:0 0 10px">Makes stacks bigger. Uses the StackSizeController plugin. Fully applies after a restart.</p>
      ${plugin('stack', v.stack)}
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        ${v.stack.presets.map((p) => `<button class="btn btn-sm" data-stack="${p}">${p}</button>`).join('')}
        <button class="btn btn-sm" data-stack="custom">Apply custom</button>
      </div>
      <div class="rt-cats mt-16">
        <label>Everything <input type="number" min="1" max="1000" id="rt-stack-all" placeholder="1" /></label>
        ${v.stack.categories.map((c) => `<label>${esc(c)} <input type="number" min="1" max="1000" data-cat="${esc(c)}" placeholder="-" /></label>`).join('')}
      </div>
      <p class="hint" style="margin:8px 0 0">Custom: a category left empty follows Everything; leave both empty to skip.</p>
    </div>
    <div class="card mt-16">
      <div class="card-head"><h4>Day and night length</h4></div>
      <p class="faint" style="margin:0 0 10px">Real minutes for a full day and a full night. Applies at once while the server runs, and again on every start.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        ${t.presets.map((p) => `<button class="btn btn-sm" data-time="${p.id}" title="${p.day ? `${p.day} / ${p.night} minutes` : 'Rust default'}">${esc(p.label)}</button>`).join('')}
      </div>
      <div class="row mt-16" style="gap:10px;flex-wrap:wrap;align-items:center">
        <label>Day <select id="rt-day">${timeOpts(t.day)}</select></label>
        <label>Night <select id="rt-night">${timeOpts(t.night)}</select></label>
        <button class="btn btn-sm btn-primary" data-time="custom">Save</button>
      </div>
    </div>`;
  const run = async (what, tail, method, body) => {
    try {
      const res = await api(url(server, tail), { method, body });
      toast(what + (res.restartNeeded ? '. Restart the server for it to fully apply.' : res.reloaded || res.live ? '. Applied.' : '. Saved.'), 'success');
      renderPresets(box, server);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  box.querySelectorAll('[data-install]').forEach((b) => b.addEventListener('click', () => run('Plugin installed', 'rust-tools/plugin', 'POST', { plugin: b.dataset.install })));
  box.querySelectorAll('[data-loot]').forEach((b) =>
    b.addEventListener('click', () => run('Loot multiplier set', 'rust-tools/loot', 'POST', b.dataset.loot === 'custom' ? { preset: 'custom', multiplier: $('#rt-loot-x', box).value } : { preset: b.dataset.loot }))
  );
  box.querySelectorAll('[data-stack]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.stack !== 'custom') return run('Stack sizes set', 'rust-tools/stack', 'POST', { preset: b.dataset.stack });
      const categories = Object.fromEntries([...box.querySelectorAll('[data-cat]')].map((i) => [i.dataset.cat, i.value]));
      run('Stack sizes set', 'rust-tools/stack', 'POST', { preset: 'custom', all: $('#rt-stack-all', box).value, categories });
    })
  );
  box.querySelectorAll('[data-time]').forEach((b) =>
    b.addEventListener('click', () => run('Day and night length set', 'rust-tools/time', 'PUT', b.dataset.time === 'custom' ? { day: $('#rt-day', box).value, night: $('#rt-night', box).value } : { preset: b.dataset.time }))
  );
}

/* -------------------------------------------------------------- AFK kick */

async function renderKick(box, server) {
  if (!can('command')) {
    box.innerHTML = '<div class="card"><p class="faint" style="margin:0">Your account is not allowed to run console commands, so it cannot change this.</p></div>';
    return;
  }
  const { afk: c } = await api(url(server, 'rust-tools'));
  const num = (id, label, value, min, max, hint) => `<div class="form-row"><label for="${id}">${label}</label><input id="${id}" type="number" min="${min}" max="${max}" value="${value}" />${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  box.innerHTML = `
    <div class="card">
      <div class="card-head"><h4>AFK and high-ping kick</h4></div>
      <p class="faint" style="margin:0 0 12px">Off by default. The panel checks players every 20 seconds, warns in chat, and kicks if nothing changes before the warning time ends. Server owners and moderators are never kicked. AFK needs the live map plugin (Live map tab) because it watches how far a player moved.</p>
      <label class="checkbox-row"><input type="checkbox" id="k-enabled" ${c.enabled ? 'checked' : ''} /> Turn it on</label>
      <label class="checkbox-row"><input type="checkbox" id="k-afk" ${c.afk ? 'checked' : ''} /> Kick players who stand still</label>
      ${num('k-afkm', 'Standing still for (minutes)', c.afkMinutes, 3, 240)}
      <label class="checkbox-row"><input type="checkbox" id="k-ping" ${c.highPing ? 'checked' : ''} /> Kick players with a high ping</label>
      ${num('k-maxping', 'Ping limit (ms)', c.maxPing, 80, 2000)}
      ${num('k-checks', 'Checks in a row over the limit', c.pingChecks, 2, 30, 'Each check is 20 seconds, so 6 means two minutes.')}
      ${num('k-grace', 'Warning time (seconds)', c.graceSeconds, 20, 600)}
      ${num('k-min', 'Only kick when at least this many are online', c.minPlayers, 0, 500, '0 means always.')}
      <label class="checkbox-row"><input type="checkbox" id="k-admins" ${c.ignoreAdmins ? 'checked' : ''} /> Never kick owners and moderators</label>
      <div class="form-row"><label for="k-ignore">Also never kick these Steam IDs</label><input id="k-ignore" value="${esc(c.ignoreIds.join(', '))}" placeholder="76561198000000000, …" /></div>
      <div class="row mt-16"><button class="btn btn-sm btn-primary" id="k-save">Save</button></div>
    </div>`;
  $('#k-save', box).addEventListener('click', async () => {
    try {
      await api(url(server, 'rust-tools/afk'), {
        method: 'PUT',
        body: {
          enabled: $('#k-enabled', box).checked,
          afk: $('#k-afk', box).checked,
          afkMinutes: $('#k-afkm', box).value,
          highPing: $('#k-ping', box).checked,
          maxPing: $('#k-maxping', box).value,
          pingChecks: $('#k-checks', box).value,
          graceSeconds: $('#k-grace', box).value,
          minPlayers: $('#k-min', box).value,
          ignoreAdmins: $('#k-admins', box).checked,
          ignoreIds: $('#k-ignore', box).value,
        },
      });
      toast('Saved', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ----------------------------------------------------------------- teams */

const who = (m) => `${m.leader ? '★ ' : ''}${esc(m.name || m.id)}${m.online ? ' <span class="badge accent">online</span>' : ''}${m.clan ? ` <span class="badge">${esc(m.clan)}</span>` : ''}`;

async function renderTeams(box, server) {
  const res = await api(url(server, 'rust-teams'));
  if (!res.available) {
    box.innerHTML = `<div class="card"><p class="faint" style="margin:0">${esc(res.reason)}</p></div>`;
    return;
  }
  box.innerHTML = `
    <div class="card card-flush"><div class="table-wrap"><table>
      <thead><tr><th>Team</th><th>Members</th><th>Bases</th></tr></thead>
      <tbody>${res.teams.length ? res.teams.map((t) => `<tr>
        <td class="mono nowrap">#${esc(t.id)}<div class="faint">${t.online} online</div></td>
        <td>${t.members.map((m) => `<div>${who(m)}</div>`).join('')}</td>
        <td class="mono">${t.bases.length ? t.bases.map((b) => `<div>${grid(b.x, b.z)}${b.authorized ? ` <span class="faint">(${b.authorized} authed)</span>` : ''}</div>`).join('') : '<span class="faint">none found</span>'}</td>
      </tr>`).join('') : '<tr><td colspan="3" class="faint">Nobody is in a team.</td></tr>'}</tbody>
    </table></div></div>
    ${res.clans.length ? `<div class="card card-flush mt-16"><div class="card-head" style="padding:12px 14px"><h4>Clans</h4></div><div class="table-wrap"><table>
      <thead><tr><th>Clan</th><th>Members</th><th>Bases</th></tr></thead>
      <tbody>${res.clans.map((c) => `<tr><td class="mono">${esc(c.tag)}</td>
        <td>${c.members.map((m) => `<div>${esc(m.name || m.id)}${m.online ? ' <span class="badge accent">online</span>' : ''}${m.id === c.owner ? ' ★' : ''}</div>`).join('')}</td>
        <td class="mono">${c.bases.map((b) => `<div>${grid(b.x, b.z)}</div>`).join('') || '<span class="faint">none found</span>'}</td></tr>`).join('')}</tbody>
    </table></div></div>` : '<p class="hint">No clans shown. If you run the Clans plugin, its data file is read automatically.</p>'}`;
}

/* -------------------------------------------------------------- entities */

async function renderEntities(box, server) {
  const res = await api(url(server, 'rust-entities'));
  if (!res.available) {
    box.innerHTML = `<div class="card"><p class="faint" style="margin:0">${esc(res.reason)}</p></div>`;
    return;
  }
  box.innerHTML = `
    <p class="faint" style="margin:0 0 10px">${res.all.toLocaleString()} entities on the server. Players with ${res.caution.toLocaleString()} or more are marked as heavy. The count refreshes once a minute. Click Copy to get a console command that teleports you to the middle of their build.</p>
    <div class="card card-flush"><div class="table-wrap"><table>
      <thead><tr><th>Player</th><th>Total</th><th>Building parts</th><th>Deployables</th><th>Position</th><th></th></tr></thead>
      <tbody>${res.owners.map((o, i) => `<tr>
        <td>${esc(o.name || o.id)}${o.online ? ' <span class="badge accent">online</span>' : ''}${o.heavy ? ' <span class="badge warn">heavy</span>' : ''}</td>
        <td class="mono">${o.total.toLocaleString()}</td><td class="mono">${o.blocks.toLocaleString()}</td><td class="mono">${o.deployables.toLocaleString()}</td>
        <td class="mono">${grid(o.x, o.z)}</td>
        <td><button class="btn btn-sm" data-tp="${i}">Copy teleport</button></td></tr>`).join('') || '<tr><td colspan="6" class="faint">Nothing owned yet.</td></tr>'}</tbody>
    </table></div></div>`;
  box.querySelectorAll('[data-tp]').forEach((b) => b.addEventListener('click', () => copyToClipboard(res.owners[Number(b.dataset.tp)].teleport, b)));
}
