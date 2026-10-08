import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, can, esc, fmtTime } from '../core/util.js';
import { skeleton } from '../ui/skeleton.js';

/* -------------------------------------------------------------- activity */

export async function renderActivity(view) {
  setCrumbs('Activity');
  view.innerHTML = skeleton('page', 'Loading activity…');
  const data = await api('/api/events?limit=200').catch(() => ({ events: [] }));
  if (state.route.name !== 'activity') return; // the user moved to another page meanwhile
  // A coloured dot reads faster than an icon per event type.
  const tone = (type) => {
    if (type.includes('crash') || type.includes('failed')) return 'var(--danger)';
    if (type.includes('started') || type.includes('installed') || type.includes('created')) return 'var(--success)';
    if (type.includes('deleted') || type.includes('restored')) return 'var(--warning)';
    return 'var(--text-tertiary)';
  };
  view.innerHTML = `
    <div class="page-head"><h1>Activity</h1></div>
    ${
      can('console')
        ? `<div class="card" style="margin-bottom:16px">
             <input id="ps-q" type="search" placeholder="Find a player on any server${state.user.role === 'admin' ? ', by name or address' : ''}" autocomplete="off" spellcheck="false" />
             <div id="ps-results"></div>
           </div>`
        : ''
    }
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th style="width:30px"></th><th>Event</th><th>Server</th><th>Origin</th><th class="nowrap">When</th></tr></thead>
        <tbody>
          ${
            data.events.length
              ? data.events
                  .map((e) => {
                    const server = state.servers.find((s) => s.id === e.serverId);
                    return `<tr>
                      <td><span style="display:block;width:5px;height:5px;border-radius:50%;background:${tone(
                        e.type
                      )}"></span></td>
                      <td>${esc(e.message)}</td>
                      <td>${server ? `<a href="#/servers/${esc(server.id)}">${esc(server.name)}</a>` : '<span class="faint">—</span>'}</td>
                      <td class="faint nowrap">${
                        e.ip
                          ? `<span class="mono">${esc(e.ip)}</span>${e.location ? ` · ${esc(e.location)}` : ''}`
                          : '—'
                      }</td>
                      <td class="faint nowrap">${fmtTime(e.at)}</td>
                    </tr>`;
                  })
                  .join('')
              : '<tr><td colspan="5" class="faint">Nothing has happened yet</td></tr>'
          }
        </tbody>
      </table></div>
    </div>`;
  if ($('#ps-q')) wirePlayerSearch();
}

function ago(at) {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function hours(seconds) {
  return seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`;
}

/** BattleMetrics-style lookup: every server a name (or address) has been seen on. */
function wirePlayerSearch() {
  const input = $('#ps-q');
  const box = $('#ps-results');
  let timer = null;
  let rows = [];
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) return (box.innerHTML = '');
      const { players } = await api(`/api/players/search?q=${encodeURIComponent(q)}`).catch(() => ({ players: [] }));
      if (input.value.trim() !== q) return;
      rows = players;
      box.innerHTML = players.length
        ? `<div class="table-wrap" style="margin-top:12px"><table>
             <thead><tr><th>Player</th><th>Server</th><th>Play time</th><th class="nowrap">Last seen</th></tr></thead>
             <tbody>${players
               .map((p, i) => {
                 const server = state.servers.find((s) => s.id === p.serverId);
                 return `<tr class="clickable" data-row="${i}">
                   <td><b>${esc(p.name)}</b>${p.note?.watch ? ' <span class="badge warn">watched</span>' : p.note?.note ? ' <span class="badge">note</span>' : ''}</td>
                   <td>${esc(server?.name || p.serverId)}</td>
                   <td class="mono">${hours(p.seconds)}</td>
                   <td class="faint nowrap">${p.online ? '<span class="lime inline-icon"><span class="led on"></span> online</span>' : ago(p.last)}</td>
                 </tr>`;
               })
               .join('')}</tbody></table></div>`
        : '<div class="faint" style="margin-top:12px">Nobody by that name has played on your servers.</div>';
    }, 250);
  });
  box.addEventListener('click', async (event) => {
    const tr = event.target.closest('[data-row]');
    if (!tr) return;
    const p = rows[Number(tr.dataset.row)];
    const server = state.servers.find((s) => s.id === p.serverId) || {};
    const { openProfile } = await import('./server/players.js');
    openProfile(p.serverId, p.name, { templateId: server.templateId, lists: (server.playerLists || []).includes('bans') });
  });
}
