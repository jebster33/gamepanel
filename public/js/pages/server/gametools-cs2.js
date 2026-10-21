import { api } from '../../core/api.js';
import { $, esc, toast } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';
import { sortableList } from './gametools.js';

const url = (server, tail) => `/api/servers/${server.id}/gametools/cs2${tail ? `/${tail}` : ''}`;
const call = async (fn, ok) => {
  try {
    const out = await fn();
    if (ok) toast(ok);
    return out;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
};

export async function renderCs2Tools(host, server) {
  const info = await call(() => api(url(server)));
  if (!info) return (host.innerHTML = '<div class="card mt-16">Could not read the server.</div>');
  const admin = (await import('../../core/state.js')).state.user.role === 'admin';
  const p = info.plugins;
  host.innerHTML = `
    <div class="card mt-16"><div class="card-head"><h4>Game mode preset</h4></div>
      <p class="faint" style="margin:0 0 12px">A preset sets the game type and mode and writes the matching settings file. It applies on the next start. Presets only change the settings listed on the card; they never touch plugins.</p>
      <div class="gt-presets" role="radiogroup" aria-label="Preset">${info.presets
        .map(
          (x) => `<label class="gt-preset ${info.preset === x.id ? 'on' : ''}"><input type="radio" name="gt-preset" value="${esc(x.id)}" ${info.preset === x.id ? 'checked' : ''} />
          <strong>${esc(x.label)}</strong><span class="faint">${esc(x.description)}</span>${x.cheats ? '<span class="badge bad">cheats on</span>' : ''}</label>`
        )
        .join('')}</div>
      <div class="row mt-16" style="gap:12px;align-items:end"><label>Bots <input id="gt-bots" type="number" min="0" max="32" value="${info.bots}" style="width:80px" /></label>
        <button class="btn btn-sm btn-primary" id="gt-apply">Apply preset</button></div>
      <div class="hint mt-8">Currently: game type ${esc(info.gameMode.type ?? '?')}, mode ${esc(info.gameMode.mode ?? '?')}${info.preset ? `, preset ${esc(info.preset)}` : ''}.</div>
    </div>

    <div class="card mt-16"><div class="card-head"><h4>Map pool and end-of-match vote</h4></div>
      <p class="faint" style="margin:0 0 12px">At the end of a match players vote for the next map from this pool, using the game's own vote. Workshop maps: <span class="mono">workshop/&lt;id&gt;/&lt;map name&gt;</span>. Saving writes <span class="mono">gamemodes_server.txt</span> and <span class="mono">mapcycle.txt</span> (with a backup) and sets the map group to <span class="mono">mg_gamepanel</span>. Current group: <span class="mono">${esc(info.mapgroup || 'mg_active')}</span>.</p>
      <div id="gt-pool"></div>
      <div class="row mt-16" style="gap:8px;flex-wrap:wrap">
        <select id="gt-official" aria-label="Official map"><option value="">Add an official map…</option>${info.officialMaps.map((m) => `<option>${esc(m)}</option>`).join('')}</select>
        <input id="gt-custom" placeholder="or type a map or workshop/123/de_name" style="max-width:300px" aria-label="Custom map" /><button class="btn btn-sm" id="gt-add">Add</button></div>
      <div class="row mt-16" style="gap:16px;align-items:center;flex-wrap:wrap">
        <label class="checkbox-row"><input type="checkbox" id="gt-vote" ${info.vote ? 'checked' : ''} /> Vote at the end of the match</label>
        <label>Vote time (s) <input id="gt-vsec" type="number" min="10" max="60" value="${info.voteSeconds}" style="width:80px" /></label>
        <button class="btn btn-sm btn-primary" id="gt-pool-save">Save map pool</button></div>
    </div>

    <div class="card mt-16"><div class="card-head"><h4>Plugins</h4></div>
      <p class="faint" style="margin:0 0 12px">Metamod and CounterStrikeSharp are what most CS2 plugins run on. The panel downloads them from their official sources and unpacks them (server stopped). A game update puts <span class="mono">gameinfo.gi</span> back, so run the Metamod step again if plugins stop loading.</p>
      <table class="table"><tbody>
        ${[
          ['metamod', 'Metamod:Source', p.metamodFiles, p.gameinfoPatched ? 'installed and enabled' : p.metamodFiles ? 'files present, gameinfo.gi not patched' : 'not installed'],
          ['gameinfo', 'Enable Metamod (patch gameinfo.gi)', p.gameinfoPatched, p.gameinfoPatched ? 'done' : 'not done'],
          ['css', 'CounterStrikeSharp (with runtime)', p.css, p.css ? 'installed' : 'not installed'],
          ['mapchooser', 'MapChooserSharp (optional community map vote, no longer maintained, untested)', p.mapchooser, p.mapchooser ? 'installed' : 'not installed'],
        ]
          .map(([id, name, ok, text]) => `<tr><td>${esc(name)}</td><td><span class="badge ${ok ? 'accent' : ''}">${esc(text)}</span></td><td style="text-align:right">${admin ? `<button class="btn btn-sm" data-plugin="${id}">${ok ? 'Reinstall' : 'Install'}</button>` : ''}</td></tr>`)
          .join('')}
      </tbody></table>
      ${admin ? '' : '<div class="hint">Only an administrator can install plugins.</div>'}
    </div>
    <div id="gt-skins"></div>`;

  host.querySelectorAll('.gt-preset input').forEach((i) => i.addEventListener('change', () => host.querySelectorAll('.gt-preset').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked))));
  $('#gt-apply').addEventListener('click', async () => {
    const preset = host.querySelector('.gt-preset input:checked')?.value;
    if (!preset) return toast('Pick a preset first', 'error');
    if (preset === 'practice' && !(await confirmModal('Cheats on', 'The practice preset turns cheats on. Anyone with access can use cheat commands. Use it on a private server.', 'Apply'))) return;
    if (await call(() => api(url(server, 'preset'), { method: 'POST', body: { preset, bots: $('#gt-bots').value } }), 'Preset saved. Restart the server to use it.')) renderCs2Tools(host, server);
  });

  const maps = [...info.maps];
  const pool = sortableList($('#gt-pool'), maps, {});
  $('#gt-add').addEventListener('click', () => {
    const v = ($('#gt-custom').value || $('#gt-official').value).trim();
    if (!v) return;
    if (maps.includes(v)) return toast('Already in the pool', 'error');
    pool.add(v);
    $('#gt-custom').value = '';
    $('#gt-official').value = '';
  });
  $('#gt-pool-save').addEventListener('click', async () => {
    const out = await call(() => api(url(server, 'maps'), { method: 'PUT', body: { maps, vote: $('#gt-vote').checked, voteSeconds: $('#gt-vsec').value } }), 'Map pool saved. Restart the server to use it.');
    if (out) renderCs2Tools(host, server);
  });
  host.querySelectorAll('[data-plugin]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Working…';
      const out = await call(() => api(url(server, `plugins/${b.dataset.plugin}`), { method: 'POST', body: {} }));
      if (out) toast(out.installed ? `Installed ${out.installed}` : 'Done');
      renderCs2Tools(host, server);
    })
  );
  if (admin) renderSkins($('#gt-skins'), server, info, () => renderCs2Tools(host, server));
}

/* ------------------------------------------------------ skin changer -- */

async function renderSkins(box, server, info, reload) {
  const sk = await call(() => api(url(server, 'skins')));
  if (!sk) return;
  const warning = `<div class="gt-warn gt-warn-red" role="alert"><strong>Skin changer: Valve can ban your server token.</strong> ${esc(sk.warning)} It is off by default, no preset turns it on, and everything here is at your own risk.</div>`;
  if (!sk.enabled) {
    box.innerHTML = `<div class="card mt-16"><div class="card-head"><h4>Skin changer (WeaponPaints)</h4></div>${warning}
      <p class="faint mt-8">WeaponPaints lets players pick knife and gun skins in game. It needs a MariaDB or MySQL database and CounterStrikeSharp, and it needs the server's guidelines switch turned off. Read the guide page "CS2 tools" before enabling.</p>
      <label class="checkbox-row mt-8"><input type="checkbox" id="sk-ack" /> I understand that Valve has banned GSLT tokens of servers using skin changers and I accept the risk.</label>
      <div class="row mt-8"><button class="btn btn-sm btn-danger" id="sk-on" disabled>Enable the skin changer</button></div></div>`;
    $('#sk-ack').addEventListener('change', (e) => ($('#sk-on').disabled = !e.target.checked));
    $('#sk-on').addEventListener('click', async () => {
      if (await call(() => api(url(server, 'skins/enabled'), { method: 'PUT', body: { enabled: true, acknowledge: $('#sk-ack').checked } }))) reload();
    });
    return;
  }
  const db = sk.db;
  box.innerHTML = `<div class="card mt-16"><div class="card-head"><h4>Skin changer (WeaponPaints)</h4><button class="btn btn-sm" id="sk-off">Turn off</button></div>${warning}
    <h5 class="mt-16" style="margin-bottom:4px">1. Database</h5>
    <p class="faint" style="margin:0 0 8px">WeaponPaints stores every player's choices in MariaDB or MySQL. Run one with <span class="mono">docker run -d --name wp-db -e MARIADB_ROOT_PASSWORD=... -e MARIADB_DATABASE=weaponpaints -e MARIADB_USER=wp -e MARIADB_PASSWORD=... -p 127.0.0.1:3306:3306 mariadb:11</span>, then enter its details. The password is sealed in the panel and written to the plugin's config file.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <input id="db-host" placeholder="host" value="${esc(db.host || '127.0.0.1')}" style="width:150px" aria-label="Database host" />
      <input id="db-port" type="number" placeholder="port" value="${esc(db.port)}" style="width:90px" aria-label="Database port" />
      <input id="db-user" placeholder="user" value="${esc(db.user)}" style="width:130px" aria-label="Database user" />
      <input id="db-pass" type="password" placeholder="${db.hasPassword ? 'password (saved, leave blank to keep)' : 'password'}" style="width:230px" autocomplete="new-password" aria-label="Database password" />
      <input id="db-name" placeholder="database" value="${esc(db.name)}" style="width:150px" aria-label="Database name" />
      <button class="btn btn-sm" id="db-save">Save</button></div>
    <h5 class="mt-16" style="margin-bottom:4px">2. Install and configure (server stopped)</h5>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${[['weaponpaints-playersettings', 'PlayerSettings'], ['weaponpaints-anybase', 'AnyBaseLibCS2'], ['weaponpaints-menumanager', 'MenuManagerCS2'], ['weaponpaints', 'WeaponPaints']].map(([id, n]) => `<button class="btn btn-sm" data-sk-plugin="${id}">Install ${n}</button>`).join('')}
      <button class="btn btn-sm" id="sk-config">Write plugin config</button></div>
    <div class="hint mt-8">Start the server once after installing so the plugin creates its tables, then sync. The config step also sets <span class="mono">FollowCS2ServerGuidelines</span> to false in CounterStrikeSharp's core.json, which the plugin requires.</div>
    <h5 class="mt-16" style="margin-bottom:4px">3. Pick skins</h5>
    <p class="faint" style="margin:0 0 8px">Players can also pick their own in game with <span class="mono">!ws</span> and <span class="mono">!knife</span>. Here you pick for a SteamID64, for example your own. Admins have no special access; the same database holds everyone.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
      <input id="sk-steam" placeholder="SteamID64 (7656119...)" style="width:220px" aria-label="SteamID64" />
      <input id="sk-q" placeholder="Search skins" style="width:200px" aria-label="Search skins" />
      <select id="sk-w" aria-label="Weapon"><option value="">All weapons</option></select>
      <select id="sk-team" aria-label="Team"><option value="0">Both teams</option><option value="3">CT</option><option value="2">T</option></select>
      <button class="btn btn-sm" id="sk-refresh">Refresh catalog</button></div>
    <div class="hint" id="sk-source">Loading the catalog…</div>
    <div id="sk-grid" class="gt-grid mt-8" role="list"></div>
    <h5 class="mt-16" style="margin-bottom:4px">Saved picks</h5><div id="sk-picks"></div>
    <h5 class="mt-16" style="margin-bottom:4px">4. Send picks to the database</h5>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn btn-sm btn-primary" id="sk-sync">Sync to database</button><a class="btn btn-sm" href="${url(server, 'skins/sql')}">Download SQL</a></div>
    <div class="hint mt-8">Sync needs the <span class="mono">mariadb</span> or <span class="mono">mysql</span> command line client on the panel machine. Without it, download the SQL and run it against your database yourself. ${sk.lastSync ? `Last sync: ${new Date(sk.lastSync.at).toLocaleString()} (${sk.lastSync.ok ? 'ok' : 'failed'}).` : ''}</div></div>`;
  $('#sk-off').addEventListener('click', async () => {
    if (await call(() => api(url(server, 'skins/enabled'), { method: 'PUT', body: { enabled: false } }), 'Skin changer turned off. Remove the plugin files yourself if you no longer want it loaded.')) reload();
  });
  $('#db-save').addEventListener('click', () =>
    call(() => api(url(server, 'skins/database'), { method: 'PUT', body: { host: $('#db-host').value, port: $('#db-port').value, user: $('#db-user').value, password: $('#db-pass').value, name: $('#db-name').value } }), 'Saved')
  );
  box.querySelectorAll('[data-sk-plugin]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      const out = await call(() => api(url(server, `plugins/${b.dataset.skPlugin}`), { method: 'POST', body: {} }));
      if (out) toast(`Installed ${out.installed}`);
      b.disabled = false;
    })
  );
  $('#sk-config').addEventListener('click', async () => {
    const out = await call(() => api(url(server, 'skins/config'), { method: 'POST', body: {} }));
    if (out) toast(out.note);
  });
  $('#sk-sync').addEventListener('click', async () => {
    const out = await call(() => api(url(server, 'skins/sync'), { method: 'POST', body: {} }));
    if (out) toast(`Synced ${out.statements} picks using ${out.client}`);
  });

  const drawPicks = (picks) => {
    const rows = Object.entries(picks).flatMap(([sid, m]) => Object.entries(m.weapons).map(([key, w]) => ({ sid, key, w })));
    $('#sk-picks').innerHTML = rows.length
      ? `<table class="table"><tbody>${rows.map((r) => `<tr><td class="mono">${esc(r.sid)}</td><td>${esc(r.w.name)}</td><td>${r.w.team === 3 ? 'CT' : r.w.team === 2 ? 'T' : 'both'}</td><td style="text-align:right"><button class="btn btn-sm btn-ghost" data-rm="${esc(r.sid)}" data-key="${esc(r.key)}">Remove</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="hint">No picks yet.</div>';
    $('#sk-picks').querySelectorAll('[data-rm]').forEach((b) =>
      b.addEventListener('click', async () => {
        const out = await call(() => api(`${url(server, `skins/players/${b.dataset.rm}`)}?key=${encodeURIComponent(b.dataset.key)}`, { method: 'DELETE' }));
        if (out) drawPicks(out.picks);
      })
    );
  };
  drawPicks(sk.picks);

  let catalog = [];
  const drawGrid = () => {
    const q = $('#sk-q').value.trim().toLowerCase();
    const w = $('#sk-w').value;
    const shown = catalog.filter((i) => (!w || i.w === w) && (!q || `${i.wn} ${i.n}`.toLowerCase().includes(q))).slice(0, 120);
    $('#sk-grid').innerHTML = shown
      .map((i) => `<button class="gt-skin" role="listitem" data-d="${i.d}" data-p="${i.p}" style="border-color:${esc(i.c)}" title="${esc(i.wn)} | ${esc(i.n)}">
        ${i.i ? `<img src="${esc(i.i)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="gt-noimg"></span>'}<span>${esc(i.wn)}</span><strong>${esc(i.n)}</strong></button>`)
      .join('') || '<div class="hint">No skins match.</div>';
  };
  const loadCatalog = async (refresh) => {
    $('#sk-source').textContent = 'Loading the catalog…';
    const data = await call(() => api(`${url(server, 'skins/catalog')}${refresh ? '?refresh=1' : ''}`));
    if (!data) return;
    catalog = data.items;
    $('#sk-source').textContent = `${catalog.length} skins from ${data.source}${data.error ? ` (${data.error})` : ''}. Showing the first 120 matches; search to narrow.`;
    const weapons = [...new Map(catalog.map((i) => [i.w, i.wn])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    $('#sk-w').innerHTML = `<option value="">All weapons</option>${weapons.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('')}`;
    drawGrid();
  };
  $('#sk-q').addEventListener('input', drawGrid);
  $('#sk-w').addEventListener('change', drawGrid);
  $('#sk-refresh').addEventListener('click', () => loadCatalog(true));
  $('#sk-grid').addEventListener('click', async (e) => {
    const b = e.target.closest('.gt-skin');
    if (!b) return;
    const sid = $('#sk-steam').value.trim();
    if (!/^7656119\d{10}$/.test(sid)) return toast('Enter a SteamID64 first (17 digits starting with 7656119)', 'error');
    const out = await call(() => api(url(server, `skins/players/${sid}`), { method: 'PUT', body: { defindex: Number(b.dataset.d), paint: Number(b.dataset.p), team: Number($('#sk-team').value) } }), 'Saved. Sync to send it to the database.');
    if (out) drawPicks(out.picks);
  });
  loadCatalog(false);
}
