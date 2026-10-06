import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtTime } from '../core/util.js';

/* ------------------------------------------------------------ audit log */

/** Every change made through the panel or the API: who, what, where, from which address. */
export async function renderAudit(view) {
  setCrumbs('Audit log');
  view.innerHTML = `
    <div class="page-head"><h1>Audit log</h1></div>
    <div class="card mb-16 row" style="gap:8px;flex-wrap:wrap">
      <input id="au-q" type="search" placeholder="Search actions, paths, addresses" style="flex:2;min-width:200px" />
      <select id="au-user" style="flex:1;min-width:140px"><option value="">Everyone</option></select>
      <select id="au-server" style="flex:1;min-width:140px"><option value="">Any server</option>${state.servers
        .filter((s) => !s.node)
        .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`)
        .join('')}</select>
    </div>
    <div class="card card-flush"><div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Who</th><th>Did</th><th>Server</th><th>From</th><th></th></tr></thead>
      <tbody id="au-rows"><tr><td colspan="6"><span class="spinner"></span></td></tr></tbody>
    </table></div></div>
    <div class="row mt-16"><button class="btn" id="au-more" hidden>Older</button></div>`;

  api('/api/users')
    .then((d) => {
      $('#au-user')?.insertAdjacentHTML('beforeend', d.users.map((u) => `<option>${esc(u.username)}</option>`).join(''));
    })
    .catch(() => {});

  let entries = [];
  const load = async (append = false) => {
    const qs = new URLSearchParams({ q: $('#au-q').value.trim(), user: $('#au-user').value, server: $('#au-server').value, limit: '200' });
    if (append && entries.length) qs.set('before', String(entries[entries.length - 1].at));
    const data = await api(`/api/audit?${qs}`).catch(() => ({ entries: [] }));
    if (!$('#au-rows')) return; // the user moved to another page meanwhile
    entries = append ? entries.concat(data.entries) : data.entries;
    $('#au-rows').innerHTML = entries.length
      ? entries
          .map((e) => {
            const ok = e.status < 400;
            const extra = e.details ? Object.entries(e.details).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
            return `<tr>
              <td class="faint nowrap">${fmtTime(e.at)}</td>
              <td><strong>${esc(e.user || 'anonymous')}</strong></td>
              <td>${esc(e.action)}${extra ? `<div class="faint" style="font-size:12px">${esc(extra)}</div>` : ''}${e.error ? `<div style="font-size:12px;color:var(--danger)">${esc(e.error)}</div>` : ''}</td>
              <td class="faint">${esc(e.server || '')}</td>
              <td class="faint mono nowrap">${esc(e.ip || '')}</td>
              <td><span class="badge ${ok ? '' : 'bad'}">${ok ? 'ok' : e.status}</span></td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="6" class="faint">Nothing logged yet. Every change anyone makes shows up here.</td></tr>';
    $('#au-more').hidden = data.entries.length < 200;
  };

  let timer;
  $('#au-q').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(), 300);
  });
  $('#au-user').addEventListener('change', () => load());
  $('#au-server').addEventListener('change', () => load());
  $('#au-more').addEventListener('click', () => load(true));
  load();
}
