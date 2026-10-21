import { api } from '../../core/api.js';
import { $, esc, fmtBytes, toast } from '../../core/util.js';
import { confirmModal, promptModal } from '../../ui/modal.js';
import { renderCs2Tools } from './gametools-cs2.js';

/** Which game-specific tools tab (if any) a server gets, and what it is called. */
export const GAME_TOOLS = {
  cs2: 'CS2 tools',
  squad: 'Layers',
  garrysmod: 'Gamemode',
  satisfactory: 'Saves',
  palworld: 'Player data',
  'space-engineers': 'World cleanup',
};

export const gameToolsLabel = (server) => GAME_TOOLS[server.templateId] || null;

const url = (server, tail) => `/api/servers/${server.id}/gametools/${tail}`;
const call = async (fn, okMessage) => {
  try {
    const out = await fn();
    if (okMessage) toast(okMessage);
    return out;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
};

export function renderGameTools(host, server) {
  const fn = { cs2: renderCs2Tools, squad: renderSquad, garrysmod: renderGmod, satisfactory: renderSatisfactory, palworld: renderPalworld, 'space-engineers': renderSe }[server.templateId];
  if (fn) fn(host, server);
  else host.innerHTML = '<div class="empty"><h3>No tools for this game</h3></div>';
}

/* ------------------------------------------------- reorderable list -- */

/**
 * A list the user can reorder by dragging, with up/down buttons, or from the keyboard:
 * focus a row, Alt+Up / Alt+Down moves it, Up / Down moves focus, Delete removes it.
 */
export function sortableList(host, items, { label = (v) => v, badge = () => '', onChange = () => {} } = {}) {
  let focusAt = null;
  const draw = () => {
    host.innerHTML = `<ol class="gt-list" aria-label="Order, top plays first">${items
      .map(
        (v, i) => `<li class="gt-row" draggable="true" tabindex="0" data-i="${i}" aria-label="${esc(label(v))}, position ${i + 1} of ${items.length}">
          <span class="gt-grip" aria-hidden="true">⋮⋮</span><span class="gt-n">${i + 1}</span>
          <span class="gt-name mono">${esc(label(v))}</span>${badge(v)}
          <button type="button" class="btn btn-sm btn-ghost" data-act="up" title="Move up" aria-label="Move ${esc(label(v))} up" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" class="btn btn-sm btn-ghost" data-act="down" title="Move down" aria-label="Move ${esc(label(v))} down" ${i === items.length - 1 ? 'disabled' : ''}>▼</button>
          <button type="button" class="btn btn-sm btn-ghost" data-act="del" title="Remove" aria-label="Remove ${esc(label(v))}">✕</button></li>`
      )
      .join('')}</ol>${items.length ? '' : '<div class="hint">Nothing here yet.</div>'}`;
    if (focusAt !== null) host.querySelector(`.gt-row[data-i="${focusAt}"]`)?.focus();
    focusAt = null;
  };
  const move = (from, to) => {
    if (to < 0 || to >= items.length || from === to) return;
    items.splice(to, 0, items.splice(from, 1)[0]);
    focusAt = to;
    draw();
    onChange();
  };
  const remove = (i) => {
    items.splice(i, 1);
    focusAt = Math.min(i, items.length - 1);
    draw();
    onChange();
  };
  let dragFrom = null;
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const i = Number(b.closest('.gt-row').dataset.i);
    if (b.dataset.act === 'up') move(i, i - 1);
    else if (b.dataset.act === 'down') move(i, i + 1);
    else remove(i);
  });
  host.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('.gt-row');
    if (!row || e.target !== row) return;
    const i = Number(row.dataset.i);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = e.key === 'ArrowUp' ? -1 : 1;
      if (e.altKey) move(i, i + d);
      else host.querySelector(`.gt-row[data-i="${i + d}"]`)?.focus();
    } else if (e.key === 'Delete') remove(i);
  });
  host.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.gt-row');
    if (!row) return;
    dragFrom = Number(row.dataset.i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });
  host.addEventListener('dragover', (e) => {
    if (dragFrom !== null && e.target.closest('.gt-row')) e.preventDefault();
  });
  host.addEventListener('drop', (e) => {
    const row = e.target.closest('.gt-row');
    if (row && dragFrom !== null) {
      e.preventDefault();
      move(dragFrom, Number(row.dataset.i));
    }
    dragFrom = null;
  });
  draw();
  return { add: (v) => { items.push(v); draw(); onChange(); }, redraw: draw };
}

/* ------------------------------------------------------------ Squad -- */

async function renderSquad(host, server) {
  let file = 'LayerRotation';
  const load = async () => {
    const info = await call(() => api(`${url(server, 'squad')}?file=${file}`));
    if (!info) return (host.innerHTML = '<div class="card">Could not load the rotation.</div>');
    const layers = info.layers.map((l) => l.id);
    const official = new Set(info.catalog.flatMap((m) => m.layers.map((l) => l.id)));
    host.innerHTML = `
      <div class="card mt-16"><div class="card-head"><h4>Layer rotation</h4></div>
        <p class="faint" style="margin:0 0 12px">Squad plays these layers from the top, then starts over. Drag a row, use the arrows, or focus a row and press Alt+Up / Alt+Down. A backup is kept every time you save.</p>
        <div class="form-row"><label for="gt-file">File</label><select id="gt-file">${info.files.map((f) => `<option ${f === file ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
          <div class="hint mono">${esc(info.file)}${info.exists ? '' : ' (does not exist yet, saving creates it)'}</div></div>
        <div id="gt-sort"></div>
        <div class="row mt-16" style="gap:8px;flex-wrap:wrap">
          <select id="gt-map" aria-label="Map"><option value="">Pick a map…</option>${info.catalog.map((m) => `<option>${esc(m.map)}</option>`).join('')}</select>
          <select id="gt-layer" aria-label="Layer" disabled><option value="">Layer…</option></select>
          <button class="btn btn-sm" id="gt-add" disabled>Add layer</button>
          <input id="gt-custom" placeholder="or type a layer name" aria-label="Custom layer name" style="max-width:240px" />
          <button class="btn btn-sm" id="gt-add-custom">Add</button>
        </div>
        <div class="row mt-16"><button class="btn btn-sm btn-primary" id="gt-save">Save rotation</button><span class="hint" id="gt-msg"></span></div>
      </div>`;
    const list = sortableList($('#gt-sort'), layers, { badge: (v) => (official.has(v) ? '' : '<span class="badge" title="Not in the built-in list, saved as typed">custom</span>') });
    $('#gt-file').addEventListener('change', (e) => {
      file = e.target.value;
      load();
    });
    $('#gt-map').addEventListener('change', (e) => {
      const m = info.catalog.find((x) => x.map === e.target.value);
      $('#gt-layer').innerHTML = `<option value="">Layer…</option>${(m?.layers || []).map((l) => `<option value="${esc(l.id)}">${esc(l.mode)} ${esc(l.version)}</option>`).join('')}`;
      $('#gt-layer').disabled = !m;
      $('#gt-add').disabled = true;
    });
    $('#gt-layer').addEventListener('change', (e) => ($('#gt-add').disabled = !e.target.value));
    $('#gt-add').addEventListener('click', () => list.add($('#gt-layer').value));
    $('#gt-add-custom').addEventListener('click', () => {
      const v = $('#gt-custom').value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_]{2,79}$/.test(v)) return toast('Layer names use letters, digits and underscores, like Gorodok_RAAS_v1', 'error');
      list.add(v);
      $('#gt-custom').value = '';
    });
    $('#gt-save').addEventListener('click', async () => {
      const out = await call(() => api(`${url(server, 'squad')}?file=${file}`, { method: 'PUT', body: { layers } }), 'Rotation saved');
      if (out) $('#gt-msg').textContent = out.note + (out.backup ? ` Backup: ${out.backup}` : '');
    });
  };
  load();
}

/* ------------------------------------------------- Garry's Mod -- */

async function renderGmod(host, server) {
  const info = await call(() => api(url(server, 'garrysmod')));
  if (!info) return (host.innerHTML = '<div class="card">Could not read the server files.</div>');
  let gm = info.current.gamemode;
  const draw = () => {
    const mode = info.gamemodes.find((g) => g.id === gm);
    const prefixes = mode?.prefixes || [];
    const maps = info.maps.filter((m) => !prefixes.length || prefixes.some((p) => m.name.toLowerCase().startsWith(p)));
    host.innerHTML = `
      <div class="card mt-16"><div class="card-head"><h4>Gamemode and map</h4></div>
        <p class="faint" style="margin:0 0 12px">Pick the gamemode the server starts with and a map that suits it. It applies on the next start. Gamemodes show here when their files are on the server; Workshop gamemodes are read from the downloaded .gma files.</p>
        <div class="form-row"><label for="gm-mode">Gamemode</label><select id="gm-mode">${info.gamemodes
          .map((g) => `<option value="${esc(g.id)}" ${g.id === gm ? 'selected' : ''}>${esc(g.title)}${g.source ? '' : ' (not installed)'}</option>`)
          .join('')}${info.gamemodes.some((g) => g.id === gm) ? '' : `<option selected>${esc(gm)}</option>`}</select>
          <div class="hint">${mode?.source ? `From: ${esc(mode.source)}.` : 'Not found on disk.'} ${prefixes.length ? `Map prefix: <span class="mono">${esc(prefixes.join(', '))}</span>` : ''}</div></div>
        <div class="form-row"><label for="gm-map">Map</label>
          <select id="gm-map">${maps.map((m) => `<option value="${esc(m.name)}" ${m.name === info.current.map ? 'selected' : ''}>${esc(m.name)} (${esc(m.source)})</option>`).join('')}${maps.some((m) => m.name === info.current.map) ? '' : `<option value="${esc(info.current.map)}" selected>${esc(info.current.map)} (current)</option>`}</select>
          <div class="hint">Showing ${maps.length} of ${info.maps.length} maps found. ${prefixes.length ? 'Filtered by the gamemode prefix.' : ''}</div></div>
        <div class="row mt-16"><button class="btn btn-sm btn-primary" id="gm-save">Save</button></div>
        <div id="gm-warn" class="hint warn-text mt-8"></div>
      </div>
      <div class="card mt-16"><div class="card-head"><h4>Install a Workshop gamemode</h4></div>
        <p class="faint" style="margin:0 0 12px">Paste a Workshop item or collection link or id. The server downloads it; then it appears above after a refresh.</p>
        <div class="row" style="gap:8px"><input id="gm-ws" placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=..." style="flex:1" aria-label="Workshop link or id" /><button class="btn btn-sm" id="gm-ws-go">Install</button></div>
      </div>`;
    $('#gm-mode').addEventListener('change', (e) => {
      gm = e.target.value;
      info.current.map = '';
      draw();
    });
    $('#gm-save').addEventListener('click', async () => {
      const out = await call(() => api(url(server, 'garrysmod'), { method: 'PUT', body: { gamemode: gm, map: $('#gm-map').value } }), 'Saved. Restart the server to switch.');
      if (out) {
        Object.assign(info, out);
        $('#gm-warn').textContent = out.warnings.join(' ');
      }
    });
    $('#gm-ws-go').addEventListener('click', async () => {
      const input = $('#gm-ws').value.trim();
      if (!input) return;
      const out = await call(() => api(url(server, 'garrysmod/workshop'), { method: 'POST', body: { input } }));
      if (out) toast(out.message);
    });
  };
  draw();
}

/* ---------------------------------------------------- Satisfactory -- */

async function renderSatisfactory(host, server) {
  const info = await call(() => api(url(server, 'satisfactory')));
  if (!info) return (host.innerHTML = '<div class="card">Could not read the server.</div>');
  const admin = (await import('../../core/state.js')).state.user.role === 'admin';
  const running = server.status === 'running';
  host.innerHTML = `
    <div class="card mt-16"><div class="card-head"><h4>Connection to the server API</h4></div>
      <p class="faint" style="margin:0 0 12px">The panel talks to the game's own HTTPS API (port ${info.port}). Its certificate is self-signed, so you trust it once and the panel checks it is the same every time. Sign in with the admin password (only the token the server returns is kept, sealed) or paste an API token made with <span class="mono">server.GenerateAPIToken</span> in the server console.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <span class="badge ${info.certTrusted ? 'accent' : ''}">${info.certTrusted ? 'Certificate trusted' : 'Certificate not trusted'}</span>
        <span class="badge ${info.signedIn ? 'accent' : ''}">${info.signedIn ? 'Signed in' : 'Not signed in'}</span>
        ${admin ? `<button class="btn btn-sm" id="sf-trust" ${running ? '' : 'disabled title="Start the server first"'}>Trust certificate</button>
        <button class="btn btn-sm" id="sf-login" ${info.certTrusted ? '' : 'disabled'}>Sign in…</button>
        <button class="btn btn-sm" id="sf-token" ${info.certTrusted ? '' : 'disabled'}>Paste token…</button>
        ${info.signedIn ? '<button class="btn btn-sm" id="sf-logout">Forget token</button>' : ''}` : '<span class="hint">Only an administrator can set this up.</span>'}
      </div>
      ${info.certFingerprint ? `<div class="hint mono mt-8" style="word-break:break-all">SHA-256 ${esc(info.certFingerprint)}</div>` : ''}
    </div>
    <div id="sf-api"></div>
    <div class="card mt-16"><div class="card-head"><h4>Save files on disk</h4></div>
      <p class="faint" style="margin:0 0 12px">${info.folder ? `Folder: <span class="mono">${esc(info.folder)}</span>. ` : 'The save folder was not found inside the server folder (start the server once). '}These work without the API; changes need the server stopped. Deleted saves go to a <span class="mono">.gamepanel-trash</span> folder next to them.</p>
      <div id="sf-files"></div>
      <div class="row mt-8"><button class="btn btn-sm" id="sf-fup" ${info.folder ? '' : 'disabled'}>Upload .sav…</button><input type="file" id="sf-fin" accept=".sav" class="hidden" /></div>
    </div>`;
  const reload = () => renderSatisfactory(host, server);
  $('#sf-trust')?.addEventListener('click', async () => (await call(() => api(url(server, 'satisfactory/trust'), { method: 'POST', body: {} }), 'Certificate trusted')) && reload());
  $('#sf-login')?.addEventListener('click', async () => {
    const password = await promptModal('Sign in to the server API', 'Admin password', '', { type: 'password', hint: 'The password is sent to the game once and not stored.' });
    if (password && (await call(() => api(url(server, 'satisfactory/login'), { method: 'POST', body: { password } }), 'Signed in'))) reload();
  });
  $('#sf-token')?.addEventListener('click', async () => {
    const token = await promptModal('API token', 'Token', '', { type: 'password' });
    if (token && (await call(() => api(url(server, 'satisfactory/login'), { method: 'POST', body: { token } }), 'Token saved'))) reload();
  });
  $('#sf-logout')?.addEventListener('click', async () => (await call(() => api(url(server, 'satisfactory/logout'), { method: 'POST', body: {} }))) && reload());

  const dl = (kind, name) => `${url(server, `satisfactory/${kind}`)}?name=${encodeURIComponent(name)}`;
  const files = $('#sf-files');
  files.innerHTML = info.files.length
    ? `<table class="table"><tbody>${info.files.map((f) => `<tr><td class="mono">${esc(f.name)}</td><td>${fmtBytes(f.size)}</td><td>${new Date(f.modified).toLocaleString()}</td><td style="text-align:right"><a class="btn btn-sm" href="${dl('file', f.name)}">Download</a> <button class="btn btn-sm btn-danger" data-del="${esc(f.name)}">Delete</button></td></tr>`).join('')}</tbody></table>`
    : '<div class="hint">No .sav files found.</div>';
  files.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (await confirmModal('Delete save file', `Move ${b.dataset.del}.sav to the trash folder? The server must be stopped.`, 'Delete')) {
        if (await call(() => api(dl('file', b.dataset.del), { method: 'DELETE' }), 'Moved to trash')) reload();
      }
    })
  );
  $('#sf-fup')?.addEventListener('click', () => $('#sf-fin').click());
  $('#sf-fin')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const name = file.name.replace(/\.sav$/i, '');
    try {
      const res = await fetch(dl('file', name), { method: 'POST', body: file, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
      toast('Uploaded');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  if (!info.signedIn || !running) {
    $('#sf-api').innerHTML = `<div class="hint mt-16">${running ? 'Sign in above' : 'Start the server'} to list sessions, load saves and start a new game through the API.</div>`;
    return;
  }
  const data = await call(() => api(url(server, 'satisfactory/sessions')));
  if (!data) return;
  const box = $('#sf-api');
  box.innerHTML = `
    <div class="card mt-16"><div class="card-head"><h4>Sessions and saves (from the game)</h4></div>
      ${data.sessions.map((s, i) => `<h5 style="margin:12px 0 4px">${esc(s.name)} ${i === data.current ? '<span class="badge accent">current</span>' : ''}
        <button class="btn btn-sm btn-danger btn-ghost" data-ses="${esc(s.name)}">Delete session</button></h5>
        <table class="table"><tbody>${s.saves.map((v) => `<tr><td class="mono">${esc(v.name)}</td><td>${v.date ? esc(String(v.date)) : ''}</td><td style="text-align:right">
          <button class="btn btn-sm" data-load="${esc(v.name)}">Load</button> <a class="btn btn-sm" href="${dl('download', v.name)}">Download</a> <button class="btn btn-sm btn-danger" data-sdel="${esc(v.name)}">Delete</button></td></tr>`).join('')}</tbody></table>`).join('') || '<div class="hint">No saves yet.</div>'}
      <div class="row mt-16" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" id="sf-new">New game…</button>
        <button class="btn btn-sm" id="sf-savenow">Save now…</button>
        <button class="btn btn-sm" id="sf-apiup">Upload .sav to the game…</button><input type="file" id="sf-apiin" accept=".sav" class="hidden" />
      </div></div>`;
  const again = () => renderSatisfactory(host, server);
  box.querySelectorAll('[data-load]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (await confirmModal('Load save', `Load ${b.dataset.load}? Everyone on the server is returned to the lobby and the current game is replaced.`, 'Load')) {
        if (await call(() => api(url(server, 'satisfactory/load'), { method: 'POST', body: { name: b.dataset.load } }), 'Loading')) again();
      }
    })
  );
  box.querySelectorAll('[data-sdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (await confirmModal('Delete save', `Permanently delete ${b.dataset.sdel}? This cannot be undone.`, 'Delete')) {
        if (await call(() => api(dl('save', b.dataset.sdel), { method: 'DELETE' }), 'Deleted')) again();
      }
    })
  );
  box.querySelectorAll('[data-ses]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (await confirmModal('Delete session', `Permanently delete every save of "${b.dataset.ses}"? This cannot be undone.`, 'Delete everything')) {
        if (await call(() => api(`${url(server, 'satisfactory/session')}?name=${encodeURIComponent(b.dataset.ses)}`, { method: 'DELETE' }), 'Deleted')) again();
      }
    })
  );
  $('#sf-new').addEventListener('click', async () => {
    const sessionName = await promptModal('New game', 'Session name');
    if (sessionName && (await confirmModal('Start a new game', `Create "${sessionName}" and switch the server to it? The current game stays saved.`, 'Create'))) {
      if (await call(() => api(url(server, 'satisfactory/new'), { method: 'POST', body: { sessionName } }), 'Creating')) again();
    }
  });
  $('#sf-savenow').addEventListener('click', async () => {
    const name = await promptModal('Save now', 'Save name');
    if (name && (await call(() => api(url(server, 'satisfactory/save'), { method: 'POST', body: { name } }), 'Saved'))) again();
  });
  $('#sf-apiup').addEventListener('click', () => $('#sf-apiin').click());
  $('#sf-apiin').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const res = await fetch(dl('upload', file.name.replace(/\.sav$/i, '')), { method: 'POST', body: file, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
      toast('Uploaded to the game');
      again();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* -------------------------------------------------------- Palworld -- */

async function renderPalworld(host, server) {
  const info = await call(() => api(url(server, 'palworld/players')));
  if (!info) return (host.innerHTML = '<div class="card">Could not read the world.</div>');
  const admin = (await import('../../core/state.js')).state.user.role === 'admin';
  host.innerHTML = `
    <div class="card mt-16"><div class="card-head"><h4>Player data reset</h4></div>
      <div class="gt-warn" role="alert"><strong>Careful.</strong> Resetting deletes a player's save file, so they start again with a new character: level, inventory, tech and position are gone. Their pals, guild and bases stay in the world save and are not touched. The file is copied to <span class="mono">gamepanel-backups/palworld/</span> first and can be restored. The server must be <strong>stopped</strong>.</div>
      <p class="faint mt-8">${info.running ? 'The server is running: names are shown for players who are online now and remembered afterwards. Stop it to reset anyone.' : 'Names are remembered from earlier visits to this page while the server ran.'}</p>
      ${info.worlds.map((w) => `<h5 style="margin:12px 0 4px" class="mono">World ${esc(w.world)}</h5>
        <table class="table"><tbody>${w.players.map((p) => `<tr><td>${p.name ? esc(p.name) : '<span class="faint">unknown name</span>'} ${p.online ? '<span class="badge accent">online</span>' : ''}</td><td class="mono">${esc(p.guid)}</td><td>${new Date(p.modified).toLocaleString()}</td>
          <td style="text-align:right">${admin ? `<button class="btn btn-sm btn-danger" data-reset="${esc(p.guid)}" data-world="${esc(w.world)}" data-box="${p.hasPalBox ? 1 : 0}" ${info.running ? 'disabled' : ''}>Reset…</button>` : ''}</td></tr>`).join('') || '<tr><td class="faint">No player files.</td></tr>'}</tbody></table>`).join('') || '<div class="hint mt-8">No world found yet.</div>'}
    </div>
    <div class="card mt-16"><div class="card-head"><h4>Backups of reset players</h4></div>
      ${info.backups.length ? `<table class="table"><tbody>${info.backups.map((b) => `<tr><td>${b.name ? esc(b.name) : '<span class="faint">unknown name</span>'}</td><td class="mono">${esc(b.guid)}</td><td class="mono">${esc(b.stamp)}</td><td style="text-align:right">${admin ? `<button class="btn btn-sm" data-restore="${esc(b.stamp)}" data-world="${esc(b.world)}" ${info.running ? 'disabled' : ''}>Restore</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="hint">None yet.</div>'}
    </div>`;
  host.querySelectorAll('[data-reset]').forEach((b) =>
    b.addEventListener('click', async () => {
      const guid = b.dataset.reset;
      const typed = await promptModal('Reset this player', 'Type the player id to confirm', '', { hint: guid });
      if (typed === null) return;
      const includePalBox = b.dataset.box === '1' && (await confirmModal('Pal box', 'Also remove their pal box file (the pals they stored in the Palbox)? Cancel keeps it.', 'Remove it too'));
      if (await call(() => api(url(server, 'palworld/reset'), { method: 'POST', body: { guid, confirm: typed, world: b.dataset.world, includePalBox } }), 'Player reset. A backup was kept.')) renderPalworld(host, server);
    })
  );
  host.querySelectorAll('[data-restore]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (await call(() => api(url(server, 'palworld/restore'), { method: 'POST', body: { world: b.dataset.world, stamp: b.dataset.restore } }), 'Restored')) renderPalworld(host, server);
    })
  );
}

/* ------------------------------------------------ Space Engineers -- */

async function renderSe(host, server) {
  let query = { days: 60, smallBlocks: 5, world: '' };
  const selected = new Set();
  const load = async () => {
    host.innerHTML = '<div class="card mt-16">Reading the world…</div>';
    const q = new URLSearchParams({ days: query.days, smallBlocks: query.smallBlocks, ...(query.world ? { world: query.world } : {}) });
    const data = await call(() => api(`${url(server, 'space-engineers')}?${q}`));
    if (!data) return (host.innerHTML = '<div class="card mt-16">Could not read the world. It needs a Instance/Saves/&lt;world&gt;/SANDBOX_0_0_0_.sbc; start or save the world once. Only administrators can use this.</div>');
    query.world = data.world;
    const stopped = !['running', 'starting', 'stopping'].includes(server.status);
    host.innerHTML = `
      <div class="card mt-16"><div class="card-head"><h4>World cleanup</h4></div>
        <div class="gt-warn" role="alert"><strong>Offline edit.</strong> Removing entities rewrites <span class="mono">SANDBOX_0_0_0_.sbc</span>. A backup is saved first and the result is checked before it replaces the file, but check the list: NPC and pirate grids, and grids of players who simply have not logged in lately, can look abandoned. The server must be stopped.</div>
        <div class="row mt-8" style="gap:12px;flex-wrap:wrap;align-items:end">
          <label>World <select id="se-world">${data.worlds.map((w) => `<option ${w === data.world ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
          <label>Owner away for (days) <input id="se-days" type="number" min="1" max="3650" value="${data.days}" style="width:90px" /></label>
          <label>Debris up to (blocks) <input id="se-small" type="number" min="0" max="100" value="${data.smallBlocks}" style="width:90px" /></label>
          <button class="btn btn-sm" id="se-scan">Scan again</button></div>
        <p class="faint mt-8">${data.total} entities in the world, ${data.entities.length} flagged. ${data.oldPlayers.length} of ${data.players} players have not logged in for ${data.days} days.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap" id="se-filters">${['all', 'unowned', 'abandoned', 'debris', 'floating'].map((f) => `<button class="btn btn-sm ${f === 'all' ? 'btn-primary' : ''}" data-f="${f}">${f}</button>`).join('')}</div>
        <div style="max-height:420px;overflow:auto" class="mt-8"><table class="table"><thead><tr><th><input type="checkbox" id="se-all" aria-label="Select all shown" /></th><th>Name</th><th>Type</th><th>Blocks</th><th>Owners</th><th>Why</th><th>Position</th></tr></thead>
          <tbody id="se-rows"></tbody></table></div>
        <div class="row mt-16"><button class="btn btn-sm btn-danger" id="se-remove" ${stopped ? '' : 'disabled title="Stop the server first"'}>Remove selected (<span id="se-count">0</span>)…</button></div>
      </div>
      <div class="card mt-16"><div class="card-head"><h4>Players away for ${data.days}+ days</h4></div>
        <div class="hint">Shown for reference. Removing players themselves is not offered; their abandoned grids are flagged above.</div>
        <table class="table"><tbody>${data.oldPlayers.map((p) => `<tr><td>${esc(p.name || p.id)}</td><td class="mono">${esc(p.id)}</td><td>${new Date(p.lastLogin).toLocaleDateString()}</td></tr>`).join('')}</tbody></table></div>`;
    let filter = 'all';
    const rows = () => data.entities.filter((e) => filter === 'all' || e.categories.includes(filter));
    const draw = () => {
      $('#se-rows').innerHTML = rows()
        .map(
          (e) => `<tr><td><input type="checkbox" data-id="${esc(e.id)}" ${selected.has(e.id) ? 'checked' : ''} aria-label="Select ${esc(e.name || e.id)}" /></td><td>${esc(e.name || '(unnamed)')}</td><td>${esc(e.type)}</td><td>${e.blocks || ''}</td>
          <td>${e.owners.map((o) => esc(o.name || o.id)).join(', ') || '<span class="faint">nobody</span>'}</td><td>${e.categories.map((c) => `<span class="badge">${esc(c)}</span>`).join(' ')}</td><td class="mono">${e.position ? `${e.position.x}, ${e.position.y}, ${e.position.z}` : ''}</td></tr>`
        )
        .join('') || '<tr><td colspan="7" class="faint">Nothing flagged with these settings.</td></tr>';
      $('#se-count').textContent = selected.size;
    };
    draw();
    $('#se-rows').addEventListener('change', (ev) => {
      const id = ev.target.dataset.id;
      if (!id) return;
      ev.target.checked ? selected.add(id) : selected.delete(id);
      $('#se-count').textContent = selected.size;
    });
    $('#se-all').addEventListener('change', (ev) => {
      for (const e of rows()) ev.target.checked ? selected.add(e.id) : selected.delete(e.id);
      draw();
    });
    $('#se-filters').addEventListener('click', (ev) => {
      if (!ev.target.dataset.f) return;
      filter = ev.target.dataset.f;
      $('#se-filters').querySelectorAll('button').forEach((b) => b.classList.toggle('btn-primary', b === ev.target));
      draw();
    });
    $('#se-scan').addEventListener('click', () => {
      query = { days: $('#se-days').value, smallBlocks: $('#se-small').value, world: $('#se-world').value };
      selected.clear();
      load();
    });
    $('#se-remove').addEventListener('click', async () => {
      if (!selected.size) return toast('Tick what to remove first', 'error');
      if (!(await confirmModal('Remove from the world', `Permanently remove ${selected.size} entities from the world file? A backup is made first.`, 'Remove'))) return;
      const out = await call(() => api(url(server, 'space-engineers/remove'), { method: 'POST', body: { world: data.world, ids: [...selected] } }));
      if (out) {
        toast(`Removed ${out.removed}. Backup: ${out.backup}`);
        selected.clear();
        load();
      }
    });
  };
  load();
}
