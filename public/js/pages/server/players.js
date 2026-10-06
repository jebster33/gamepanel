import { api } from '../../core/api.js';
import { can, esc, fmtDuration, fmtTime, toast } from '../../core/util.js';
import { confirmModal, openModal, promptModal } from '../../ui/modal.js';

/* --------------------------------------------------------------- players */

/*
 * Four views: who is on now, everyone who has played (BattleMetrics style),
 * the activity log, and (where the game has them) whitelist / ops / bans.
 */

const ACTION_LABELS = { kick: 'Kick', ban: 'Ban' };
const VIEWS = [
  ['online', 'Online'],
  ['history', 'Players'],
  ['activity', 'Activity'],
];

let current = { view: 'online', server: null, timer: null };

export function renderPlayersTab(host, server) {
  clearInterval(current.timer);
  current = { view: current.server === server.id ? current.view : 'online', server: server.id, templateId: server.templateId, lists: (server.playerLists || []).includes('bans'), timer: null };
  const views = [...VIEWS];
  if (server.playerLists?.length && can('command')) views.push(['lists', 'Whitelist & bans']);
  host.innerHTML = `
    <div class="seg pl-seg">${views
      .map(([id, label]) => `<button class="seg-item ${id === current.view ? 'active' : ''}" data-pl-view="${id}">${label}</button>`)
      .join('')}</div>
    <div id="pl-view"></div>`;
  host.addEventListener('click', onAction);
  host.querySelectorAll('[data-pl-view]').forEach((btn) =>
    btn.addEventListener('click', () => {
      host.querySelectorAll('[data-pl-view]').forEach((b) => b.classList.toggle('active', b === btn));
      current.view = btn.dataset.plView;
      showView(host.querySelector('#pl-view'), server);
    })
  );
  showView(host.querySelector('#pl-view'), server);
}

function showView(box, server) {
  clearInterval(current.timer);
  current.timer = null;
  if (current.view === 'online') {
    box.innerHTML = '<div class="card card-flush players-card" id="players-list"></div>';
    patchPlayersTab(server);
  } else if (current.view === 'history') renderHistory(box, server);
  else if (current.view === 'activity') renderActivity(box, server);
  else if (current.view === 'lists') import('./player-lists.js').then((m) => m.renderLists(box, server));
}

// A head that fails to load (offline, blocked) turns back into the letter tile.
document.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (img?.tagName === 'IMG' && img.dataset.fallback) img.replaceWith(document.createTextNode(img.dataset.fallback));
  },
  true
);

/** Minecraft heads where the game has them, a letter tile everywhere else. */
export function avatar(server, name, size = 26) {
  const letter = esc(String(name).slice(0, 1).toUpperCase());
  const java = String(server.templateId || '').startsWith('minecraft') && server.templateId !== 'minecraft-bedrock';
  if (java && /^[A-Za-z0-9_]{3,16}$/.test(name)) {
    return `<span class="player-avatar" style="width:${size}px;height:${size}px"><img src="https://mc-heads.net/avatar/${esc(name)}/${size * 2}" alt="" loading="lazy" data-fallback="${letter}" /></span>`;
  }
  return `<span class="player-avatar" style="width:${size}px;height:${size}px">${letter}</span>`;
}

/** Re-drawn on every stats tick, so join times count up and people come and go live. */
export function patchPlayersTab(server) {
  const box = document.getElementById('players-list');
  if (!box) return;
  box.dataset.server = server.id;
  const players = [...(server.playerDetails || [])].sort((a, b) => a.since - b.since);
  const running = server.status === 'running';
  const count = server.players ?? players.length;
  const actions = can('command') ? server.playerCommands || [] : [];
  const hasScore = players.some((p) => p.score != null);

  const head = `
    <div class="players-head">
      <div><b class="players-count">${running ? count : 0}</b><span class="faint"> / ${server.maxPlayers || '—'} online</span></div>
      <span class="faint" style="font-size:12px">${running ? 'Updates live' : 'Server is offline'}</span>
    </div>`;

  if (!running || !players.length) {
    const hidden = running && count > 0;
    box.innerHTML = `${head}<div class="empty" style="padding:28px 16px"><p style="margin:0">${
      !running
        ? 'Start the server to see who is on.'
        : hidden
          ? `${count} online, but this game does not share their names.`
          : 'Nobody is on right now.'
    }</p></div>`;
    return;
  }

  box.innerHTML = `${head}
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th>Online for</th>${hasScore ? '<th>Score</th>' : ''}<th></th></tr></thead>
      <tbody>${players
        .map(
          (p) => `<tr>
            <td><span class="player"><span class="player-dot"></span>${avatar(server, p.name)}<a href="#" data-profile="${esc(p.name)}">${esc(p.name)}</a></span></td>
            <td class="faint nowrap mono">${fmtDuration(Date.now() - p.since)}</td>
            ${hasScore ? `<td class="faint mono">${p.score ?? ''}</td>` : ''}
            <td class="nowrap" style="text-align:right">${actions
              .map(
                (a) =>
                  `<button class="btn btn-sm ${a === 'ban' ? 'btn-danger' : ''}" data-player-action="${esc(a)}" data-player="${esc(p.name)}">${esc(ACTION_LABELS[a] || a)}</button>`
              )
              .join(' ')}</td>
          </tr>`
        )
        .join('')}</tbody>
    </table></div>`;
}

async function onAction(event) {
  const profile = event.target.closest('[data-profile]');
  if (profile) {
    event.preventDefault();
    openProfile(current.server, profile.dataset.profile);
    return;
  }
  const btn = event.target.closest('[data-player-action]');
  if (!btn) return;
  const serverId = current.server;
  const { playerAction: action, player } = btn.dataset;
  if (action === 'ban' && !(await confirmModal(`Ban ${player}`, `${player} is removed and cannot join again until unbanned.`, 'Ban'))) return;
  btn.disabled = true;
  try {
    await api(`/api/servers/${serverId}/players/action`, { method: 'POST', body: { action, name: player } });
    toast(`${ACTION_LABELS[action] || action}: ${player}`);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}

/* ------------------------------------------------------- player history */

const RANGES = [
  ['24h', 86_400_000],
  ['7d', 7 * 86_400_000],
  ['30d', 30 * 86_400_000],
];

function fmtPlaytime(seconds) {
  const h = seconds / 3600;
  if (h >= 10) return `${Math.round(h)}h`;
  if (h >= 1) return `${Number(h.toFixed(1))}h`;
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

async function renderHistory(box, server) {
  box.innerHTML = '<div class="card"><span class="spinner"></span> Loading player history…</div>';
  let data;
  try {
    data = await api(`/api/servers/${server.id}/player-history`);
  } catch (err) {
    box.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  const s = data.summary;
  let range = RANGES[0][1];
  let sort = 'last';
  let term = '';

  box.innerHTML = `
    <div class="kpi-grid mb-16">
      ${kpi('Unique players', s.unique)}
      ${kpi('Online now', s.online, true)}
      ${kpi('New today', s.new24h)}
      ${kpi('Active this week', s.active7d)}
      ${kpi('Peak today', s.peak24h)}
      ${kpi('Hours played', s.hours)}
    </div>
    <div class="card mb-16">
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <h4 style="margin:0">Players online</h4>
        <div class="row" style="gap:6px">${RANGES.map(([l, ms], i) => `<button class="chip ${i ? '' : 'active'}" data-range="${ms}">${l}</button>`).join('')}</div>
      </div>
      <div id="pl-chart" class="pl-chart"></div>
    </div>
    ${popularTimes(data.samples)}
    <div class="card card-flush players-card">
      <div class="players-head">
        <div><b class="players-count">${s.unique}</b><span class="faint"> player${s.unique === 1 ? '' : 's'} seen</span></div>
        <input class="search-input" id="pl-search" placeholder="Find a player…" style="max-width:220px" />
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Player</th>
          <th class="hide-sm"><a href="#" data-sort="first">First seen</a></th>
          <th><a href="#" data-sort="last">Last seen</a></th>
          <th><a href="#" data-sort="seconds">Play time</a></th>
          <th class="hide-sm"><a href="#" data-sort="sessions">Sessions</a></th>
        </tr></thead>
        <tbody id="pl-rows"></tbody>
      </table></div>
    </div>`;

  const drawRows = () => {
    const rows = data.players
      .filter((p) => !term || p.name.toLowerCase().includes(term))
      .sort((a, b) => (sort === 'last' ? b.online - a.online || b.last - a.last : sort === 'first' ? a.first - b.first : b[sort] - a[sort]));
    box.querySelector('#pl-rows').innerHTML = rows.length
      ? rows
          .slice(0, 500)
          .map(
            (p) => `<tr>
              <td><span class="player">${p.online ? '<span class="player-dot"></span>' : '<span class="player-dot off"></span>'}${avatar(server, p.name)}<a href="#" data-profile="${esc(p.name)}">${esc(p.name)}</a></span></td>
              <td class="faint nowrap hide-sm" title="${esc(new Date(p.first).toLocaleString())}">${esc(ago(p.first))}</td>
              <td class="nowrap ${p.online ? 'lime' : 'faint'}" title="${esc(new Date(p.last).toLocaleString())}">${p.online ? 'Online now' : esc(ago(p.last))}</td>
              <td class="mono nowrap">${fmtPlaytime(p.seconds)}</td>
              <td class="mono faint hide-sm">${p.sessions}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="faint" style="padding:22px 18px">${data.players.length ? 'Nobody matches.' : 'Nobody has played yet. Players show up here the first time they join.'}</td></tr>`;
  };
  drawRows();
  box.querySelector('#pl-chart').innerHTML = areaChart(data.samples, range, server.maxPlayers);

  box.querySelector('#pl-search').addEventListener('input', (e) => {
    term = e.target.value.trim().toLowerCase();
    drawRows();
  });
  box.querySelectorAll('[data-sort]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      sort = a.dataset.sort;
      drawRows();
    })
  );
  box.querySelectorAll('[data-range]').forEach((chip) =>
    chip.addEventListener('click', () => {
      box.querySelectorAll('[data-range]').forEach((c) => c.classList.toggle('active', c === chip));
      range = Number(chip.dataset.range);
      box.querySelector('#pl-chart').innerHTML = areaChart(data.samples, range, server.maxPlayers);
    })
  );
}

function kpi(label, value, lit = false) {
  return `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value ${lit && value ? 'lime' : ''}">${esc(value)}</div></div>`;
}

/** An SVG area chart of players online over time; offline stretches leave gaps. */
function areaChart(samples, range, maxPlayers) {
  const now = Date.now();
  const from = now - range;
  const points = samples.filter(([t]) => t >= from);
  if (points.filter(([, n]) => n != null).length < 2) {
    return '<div class="faint" style="padding:30px 0;text-align:center">Not enough data yet. A point is recorded every 5 minutes.</div>';
  }
  const W = 800;
  const H = 160;
  const top = Math.max(1, maxPlayers || 0, ...points.map(([, n]) => n || 0));
  const x = (t) => ((t - from) / range) * W;
  const y = (n) => H - (n / top) * (H - 12);
  const segments = [];
  let seg = [];
  for (const [t, n] of points) {
    if (n == null) {
      if (seg.length) segments.push(seg);
      seg = [];
    } else seg.push([x(t), y(n)]);
  }
  if (seg.length) segments.push(seg);
  const line = segments.map((s) => `M${s.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')}`).join('');
  const area = segments
    .filter((s) => s.length > 1)
    .map((s) => `M${s[0][0].toFixed(1)},${H}L${s.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')}L${s[s.length - 1][0].toFixed(1)},${H}Z`)
    .join('');
  const peak = points.reduce((m, p) => (p[1] != null && p[1] > (m?.[1] ?? -1) ? p : m), null);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const t = from + f * range;
    const label = range <= 86_400_000 ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `<span class="${f === 0.25 || f === 0.75 ? 'hide-sm' : ''}" style="left:${f * 100}%">${esc(label)}</span>`;
  });
  return `
    <div class="pl-chart-wrap">
      <span class="pl-chart-top mono faint">${top}</span>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="pl-svg">
        <defs><linearGradient id="plg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--lime)" stop-opacity=".28"/><stop offset="1" stop-color="var(--lime)" stop-opacity="0"/></linearGradient></defs>
        <line x1="0" x2="${W}" y1="${y(top / 2)}" y2="${y(top / 2)}" class="pl-grid"/>
        <path d="${area}" fill="url(#plg)"/>
        <path d="${line}" fill="none" stroke="var(--lime)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      </svg>
      <div class="pl-ticks faint">${ticks.join('')}</div>
    </div>
    ${peak ? `<div class="faint" style="font-size:12px;margin-top:22px">Peak <b class="lime">${peak[1]}</b> at ${esc(fmtTime(peak[0]))}</div>` : ''}`;
}

/* --------------------------------------------------------- player profile */

export async function openProfile(serverId, name, ctx = current) {
  let p;
  try {
    p = await api(`/api/servers/${serverId}/player-history/${encodeURIComponent(name)}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const server = { id: serverId, templateId: ctx.templateId };
  const modal = openModal({
    title: 'Player',
    width: 520,
    body: `
      <div class="profile-head">
        ${avatar(server, p.name, 52)}
        <div>
          <div class="profile-name">${esc(p.name)}</div>
          <div class="faint" style="font-size:12.5px">${p.online ? '<span class="lime">● Online now</span>' : `Last seen ${esc(ago(p.last))}`}</div>
        </div>
      </div>
      <div class="kpi-grid kpi-small">
        ${kpi('Play time', fmtPlaytime(p.seconds))}
        ${kpi('Sessions', p.sessions)}
        ${kpi('First seen', new Date(p.first).toLocaleDateString())}
      </div>
      <h4 style="margin:18px 0 6px">Recent sessions</h4>
      <div class="pl-sessions">${
        p.recent.length
          ? p.recent
              .slice(0, 15)
              .map(
                (s) => `<div class="pl-session"><span>${esc(fmtTime(s.start))}</span><span class="mono faint">${s.end ? fmtDuration(s.end - s.start) : '<span class="lime">playing</span>'}</span></div>`
              )
              .join('')
          : '<div class="faint">No finished sessions yet.</div>'
      }</div>
      ${
        p.addresses
          ? `<h4 style="margin:18px 0 6px">Addresses <span class="faint" style="font-weight:400;font-size:12px">(only admins see this)</span></h4>
             ${p.addresses.length ? `<div class="pl-sessions">${p.addresses.map((a) => `<div class="pl-session"><span><span class="mono">${esc(a.ip)}</span>${a.where ? ` <span class="faint">· ${esc(a.where)}</span>` : ''}</span><span class="faint">${esc(ago(a.last))}</span></div>`).join('')}</div>` : '<div class="faint">None recorded yet. Minecraft logs it when they join.</div>'}
             ${p.alts?.length ? `<div class="card warn-card" style="margin-top:10px;font-size:13px">Same address as ${p.alts.map((a) => `<a href="#" data-profile="${esc(a.name)}">${esc(a.name)}</a>`).join(', ')}. Could be an alt account, or someone in the same house.</div>` : ''}`
          : ''
      }
      ${
        can('command')
          ? `<h4 style="margin:18px 0 6px">Staff note</h4>
             <textarea id="pl-note" rows="2" maxlength="1000" placeholder="Only staff see this. Shared across every server.">${esc(p.note?.note || '')}</textarea>
             <div class="row" style="justify-content:space-between;margin-top:8px">
               <div class="checkbox-row" style="margin:0"><input type="checkbox" id="pl-watch" ${p.note?.watch ? 'checked' : ''} /><label for="pl-watch">Alert me when they join any server</label></div>
               <button class="btn btn-sm" id="pl-note-save">Save note</button>
             </div>
             ${p.note?.by ? `<div class="faint" style="font-size:12px;margin-top:4px">Last edited by ${esc(p.note.by)} ${esc(ago(p.note.at))}</div>` : ''}`
          : p.note?.note
            ? `<div class="card warn-card" style="margin-top:14px;font-size:13px">${esc(p.note.note)}</div>`
            : ''
      }
      ${p.log.length ? `<h4 style="margin:18px 0 6px">Activity</h4><div class="act-list act-compact">${p.log.slice(0, 60).map(logRow).join('')}</div>` : ''}`,
    actions:
      can('command') && ctx.lists
        ? [
            { label: 'Unban everywhere', onClick: () => banEverywhere(p.name, true) },
            { label: 'Ban on all servers', danger: true, onClick: () => banEverywhere(p.name, false) },
          ]
        : [],
  });
  document.querySelector('#pl-note-save')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      await api(`/api/players/${encodeURIComponent(p.name)}/note`, { method: 'PUT', body: { note: document.querySelector('#pl-note').value, watch: document.querySelector('#pl-watch').checked } });
      toast(document.querySelector('#pl-watch').checked ? `Saved. You'll get an alert when ${p.name} joins.` : 'Note saved');
    } catch (err) {
      toast(err.message, 'error');
    }
    event.target.disabled = false;
  });
  document.querySelector('.modal-backdrop:last-child')?.querySelectorAll('[data-profile]').forEach((a) =>
    a.addEventListener('click', (event) => {
      event.preventDefault();
      modal.close();
      openProfile(serverId, a.dataset.profile, ctx);
    })
  );
}

/** BattleMetrics-style network ban: every Minecraft server this account moderates. */
async function banEverywhere(name, unban) {
  let reason = '';
  if (!unban) {
    reason = await promptModal(`Ban ${name} on every server`, 'Reason players see', 'Banned from the network');
    if (reason === null) return;
  }
  try {
    const { results } = await api('/api/players/ban-everywhere', { method: 'POST', body: { name, reason, unban } });
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    toast(`${unban ? 'Unbanned' : 'Banned'} ${name} on ${ok} server${ok === 1 ? '' : 's'}${failed.length ? `. Failed on ${failed.map((r) => r.server).join(', ')}: ${failed[0].error}` : ''}`, failed.length ? 'warn' : 'info', 7000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* --------------------------------------------------------- activity log */

const FILTERS = [
  ['all', 'All', null],
  ['sessions', 'Joins & leaves', 'join,leave'],
  ['chat', 'Chat', 'chat'],
  ['admin', 'Moderation', 'kick,ban,unban,whitelist,unwhitelist,op,deop,whitelist-on,whitelist-off'],
  ['server', 'Server', 'start,stop,crash,version,idle'],
];

const LOG_TEXT = {
  join: (e) => `<b>${esc(e.name)}</b> joined`,
  leave: (e) => `<b>${esc(e.name)}</b> left${e.dur ? ` <span class="faint">after ${fmtDuration(e.dur)}</span>` : ''}`,
  chat: (e) => `<b>${esc(e.name)}</b> <span class="act-chat">${esc(e.text)}</span>`,
  kick: (e) => `<b>${esc(e.name)}</b> was kicked${e.by ? ` by ${esc(e.by)}` : ''}`,
  ban: (e) => `<b>${esc(e.name)}</b> was banned${e.by ? ` by ${esc(e.by)}` : ''}${e.text ? ` <span class="faint">(${esc(e.text)})</span>` : ''}`,
  unban: (e) => `<b>${esc(e.name)}</b> was unbanned${e.by ? ` by ${esc(e.by)}` : ''}`,
  whitelist: (e) => `<b>${esc(e.name)}</b> added to the whitelist${e.by ? ` by ${esc(e.by)}` : ''}`,
  unwhitelist: (e) => `<b>${esc(e.name)}</b> removed from the whitelist${e.by ? ` by ${esc(e.by)}` : ''}`,
  op: (e) => `<b>${esc(e.name)}</b> made an operator${e.by ? ` by ${esc(e.by)}` : ''}`,
  deop: (e) => `<b>${esc(e.name)}</b> is no longer an operator${e.by ? ` (${esc(e.by)})` : ''}`,
  'whitelist-on': (e) => `Whitelist turned on${e.by ? ` by ${esc(e.by)}` : ''}`,
  'whitelist-off': (e) => `Whitelist turned off${e.by ? ` by ${esc(e.by)}` : ''}`,
  version: (e) => `Switched to <b>${esc(e.text)}</b>${e.by ? ` by ${esc(e.by)}` : ''}`,
  idle: () => 'Stopped because nobody was on',
  start: () => 'Server started',
  stop: () => 'Server stopped',
  crash: () => '<span class="bad-text">Server crashed</span>',
};
const LOG_ICON = { join: '→', leave: '←', chat: '💬', kick: '⤫', ban: '⛔', unban: '✓', whitelist: '＋', unwhitelist: '−', op: '★', deop: '☆', start: '▶', stop: '■', crash: '⚠', version: '⇅' };

function logRow(e) {
  const text = (LOG_TEXT[e.type] || ((x) => esc(x.type)))(e);
  return `<div class="act-row act-${esc(e.type)}">
    <span class="act-time mono faint" title="${esc(new Date(e.t).toLocaleString())}">${esc(new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
    <span class="act-icon">${LOG_ICON[e.type] || '•'}</span>
    <span class="act-text">${text}</span>
  </div>`;
}

function renderActivity(box, server) {
  let filter = FILTERS[0];
  let term = '';
  let entries = [];
  let more = false;

  box.innerHTML = `
    <div class="row mb-16" style="gap:6px">
      ${FILTERS.map(([id, label], i) => `<button class="chip ${i ? '' : 'active'}" data-filter="${id}">${label}</button>`).join('')}
      <input class="search-input" id="act-search" placeholder="Search names and chat…" />
    </div>
    <div class="card card-flush"><div class="act-list" id="act-list"></div></div>
    <div style="text-align:center;margin-top:12px"><button class="btn hidden" id="act-more">Load older</button></div>`;

  const query = (before) => {
    const qs = new URLSearchParams({ limit: '150' });
    if (filter[2]) qs.set('types', filter[2]);
    if (term) qs.set('q', term);
    if (before) qs.set('before', before);
    return api(`/api/servers/${server.id}/activity?${qs}`);
  };

  const draw = () => {
    const list = box.querySelector('#act-list');
    if (!entries.length) {
      list.innerHTML = '<div class="empty" style="padding:28px 16px"><p style="margin:0">Nothing logged yet. Joins, leaves, chat and restarts show up here.</p></div>';
    } else {
      let day = '';
      list.innerHTML = entries
        .map((e) => {
          const d = new Date(e.t).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
          const header = d !== day ? `<div class="act-day">${esc(d)}</div>` : '';
          day = d;
          return header + logRow(e);
        })
        .join('');
    }
    box.querySelector('#act-more').classList.toggle('hidden', !more);
  };

  const reload = async () => {
    try {
      const r = await query();
      entries = r.entries;
      more = r.more;
      draw();
    } catch (err) {
      box.querySelector('#act-list').innerHTML = `<div class="faint" style="padding:18px">${esc(err.message)}</div>`;
    }
  };

  box.querySelectorAll('[data-filter]').forEach((chip) =>
    chip.addEventListener('click', () => {
      box.querySelectorAll('[data-filter]').forEach((c) => c.classList.toggle('active', c === chip));
      filter = FILTERS.find((f) => f[0] === chip.dataset.filter);
      reload();
    })
  );
  let debounce;
  box.querySelector('#act-search').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      term = e.target.value.trim();
      reload();
    }, 250);
  });
  box.querySelector('#act-more').addEventListener('click', async () => {
    const r = await query(entries[entries.length - 1]?.t);
    entries = entries.concat(r.entries);
    more = r.more;
    draw();
  });

  reload();
  // Keep the newest page live while it is on screen.
  current.timer = setInterval(() => {
    if (!box.isConnected) return clearInterval(current.timer);
    if (entries.length <= 150 && document.visibilityState === 'visible') reload();
  }, 10_000);
}

/**
 * "Popular times": average players for each weekday and hour over the last
 * 30 days, from the same 5-minute samples as the graph. Local time.
 */
function popularTimes(samples) {
  const sum = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const count = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let seen = 0;
  for (const [t, n] of samples || []) {
    if (n == null) continue;
    const d = new Date(t);
    const day = (d.getDay() + 6) % 7; // Monday first
    sum[day][d.getHours()] += n;
    count[day][d.getHours()] += 1;
    seen += 1;
  }
  if (seen < 24 * 12) return ''; // under a day of data says nothing yet
  const avg = sum.map((row, d) => row.map((s, h) => (count[d][h] ? s / count[d][h] : null)));
  const max = Math.max(0.01, ...avg.flat().filter((v) => v != null));
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hourLabel = (h) => new Date(2026, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
  const cells = avg
    .map(
      (row, d) =>
        `<span class="pt-day">${days[d]}</span>${row
          .map((v, h) => `<i style="${v == null ? '' : `--a:${(0.08 + 0.92 * (v / max)).toFixed(2)}`}" class="${v == null ? 'none' : ''}" title="${days[d]} ${hourLabel(h)}: ${v == null ? 'no data' : `${v.toFixed(1)} on average`}"></i>`)
          .join('')}`
    )
    .join('');
  return `
    <div class="card mb-16">
      <h4 style="margin:0 0 10px">Popular times <span class="faint" style="font-weight:400;font-size:12px">average players, last 30 days</span></h4>
      <div class="pt-grid">${cells}
        <span></span>${[0, 6, 12, 18].map((h) => `<span class="pt-hour" style="grid-column:${h + 2} / span 6">${hourLabel(h)}</span>`).join('')}
      </div>
    </div>`;
}
