import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtTime } from '../core/util.js';

/* -------------------------------------------------------------- activity */

export async function renderActivity(view) {
  setCrumbs('Activity');
  view.innerHTML = '<div class="card"><span class="spinner"></span> Loading…</div>';
  const data = await api('/api/events?limit=200').catch(() => ({ events: [] }));
  // A coloured dot reads faster than an icon per event type.
  const tone = (type) => {
    if (type.includes('crash') || type.includes('failed')) return 'var(--danger)';
    if (type.includes('started') || type.includes('installed') || type.includes('created')) return 'var(--success)';
    if (type.includes('deleted') || type.includes('restored')) return 'var(--warning)';
    return 'var(--text-tertiary)';
  };
  view.innerHTML = `
    <div class="page-head"><h1>Activity</h1></div>
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
}
