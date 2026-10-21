import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, fmtTime, toast } from '../core/util.js';
import { confirmModal } from '../ui/modal.js';
import { attempt, table, ago, field } from './server/tools-kit.js';
import { drawHeatmap, drawCountries } from './server/tools-players.js';

/* ----------------------------------------------------------- Players hub */

const TABS = [
  ['records', 'Warnings and notes', false],
  ['alts', 'Alt accounts', true],
  ['protection', 'Join protection', true],
  ['insights', 'When and where', false],
];

export function renderPlayerHub(view) {
  const admin = state.user.role === 'admin';
  const tabs = TABS.filter(([, , adminOnly]) => admin || !adminOnly);
  let tab = state.route.params.tab || 'records';
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  setCrumbs('Players');
  view.innerHTML = `
    <div class="page-head"><div><h1>Players</h1><div class="lede">Warnings and notes all staff share, alt accounts, join protection and when and where people play.</div></div></div>
    <nav class="tabs">${tabs.map(([k, label]) => `<a class="tab ${tab === k ? 'active' : ''}" href="#/player-hub/${k}">${label}</a>`).join('')}</nav>
    <div id="hub-body"></div>`;
  ({ records: recordsTab, alts: altsTab, protection: protectionTab, insights: insightsTab })[tab]($('#hub-body', view));
}

/* ------------------------------------------------------------- records */

const KIND = { warning: ['⚠️', 'warning'], note: ['📝', 'note'], action: ['🤖', 'panel action'] };

async function recordsTab(body) {
  const admin = state.user.role === 'admin';
  const draw = async (q = '') => {
    const d = await api(`/api/player-records?q=${encodeURIComponent(q)}`);
    body.innerHTML = `
      <div class="card mb-16">
        <div class="tools-row">
          <input id="pr-q" placeholder="Search a player" value="${esc(q)}" style="max-width:240px" />
          <div class="spacer"></div>
          <button class="btn btn-primary" id="pr-new">Warn or add a note</button>
        </div>
        <div class="mt-16">${table(
          ['Player', 'Active points', 'Notes', 'Last entry', ''],
          d.players.map((p) => [`<b>${esc(p.name)}</b>`, p.points ? `<span class="badge bad">${p.points}</span>` : '0', p.notes, esc(ago(p.last)), `<button class="btn btn-sm" data-open="${esc(p.name)}">Open file</button>`]),
          { empty: q ? 'Nobody with that name has a record.' : 'No warnings or notes yet.' }
        )}</div>
      </div>
      ${admin ? settingsCard(d.settings) : ''}`;
    $('#pr-q', body).addEventListener('keydown', (e) => e.key === 'Enter' && draw(e.target.value));
    $('#pr-new', body).addEventListener('click', () => addDialog(draw));
    body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openFile(b.dataset.open, draw)));
    $('#prs-save', body)?.addEventListener('click', async () => {
      const g = (id) => $(id, body).value;
      if (await attempt(() => api('/api/player-records-settings', { method: 'PUT', body: { expireDays: Number(g('#prs-exp')), banAt: Number(g('#prs-ban')), banHours: Number(g('#prs-hrs')), tell: $('#prs-tell', body).checked } }), 'Saved')) draw(q);
    });
  };
  await draw();
}

const settingsCard = (s) => `<div class="card"><h4>Rules</h4><div class="tools-grid mt-8">
  ${field('Warning points fade after (days, 0 = never)', `<input id="prs-exp" type="number" min="0" value="${s.expireDays}" />`)}
  ${field('Ban at this many points (0 = never)', `<input id="prs-ban" type="number" min="0" value="${s.banAt}" />`, 'Puts the player on the shared ban list.')}
  ${field('Ban length in hours (0 = permanent)', `<input id="prs-hrs" type="number" min="0" value="${s.banHours}" />`)}</div>
  <label class="checkbox-row mt-8"><input type="checkbox" id="prs-tell" ${s.tell ? 'checked' : ''} /><label for="prs-tell">Tell the player in game when they are online</label></label>
  <div class="mt-8"><button class="btn btn-primary" id="prs-save">Save</button></div></div>`;

function addDialog(done, presetName = '') {
  import('../ui/modal.js').then(({ openModal }) => {
    openModal({
      title: 'Warn or add a note',
      width: 520,
      body: `${field('Player', `<input id="ad-name" maxlength="32" value="${esc(presetName)}" />`)}
        ${field('Kind', '<select id="ad-kind"><option value="warning">Warning (counts points)</option><option value="note">Note (history only)</option></select>')}
        ${field('Points', '<input id="ad-points" type="number" min="1" max="10" value="1" />')}
        ${field('What happened', '<textarea id="ad-text" rows="3" maxlength="500" style="width:100%"></textarea>')}
        ${field('Server (optional)', `<select id="ad-server"><option value="">Not tied to a server</option>${state.servers.filter((s) => !s.node).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`)}`,
      actions: [
        { label: 'Cancel', close: true },
        {
          label: 'Save',
          primary: true,
          onClick: async (btn, m) => {
            const box = document.querySelector('.modal-backdrop:last-child');
            const g = (id) => box.querySelector(id).value;
            const r = await attempt(() => api('/api/player-records', { method: 'POST', body: { name: g('#ad-name'), kind: g('#ad-kind'), points: Number(g('#ad-points')), text: g('#ad-text'), serverId: g('#ad-server') || undefined } }));
            if (!r) return;
            m.close();
            toast(r.told?.length ? `Saved. Told on ${r.told.join(', ')}.` : r.banned ? 'Saved. The player reached the ban limit and was banned.' : 'Saved');
            done();
          },
        },
      ],
    });
  });
}

async function openFile(name, done) {
  const f = await attempt(() => api(`/api/player-records/${encodeURIComponent(name)}`));
  if (!f) return;
  const { openModal } = await import('../ui/modal.js');
  const admin = state.user.role === 'admin';
  const m = openModal({
    title: esc(f.name),
    width: 640,
    body: `<div class="hint mb-8">${f.points} active warning point${f.points === 1 ? '' : 's'}</div>${
      f.records
        .map(
          (r) => `<div class="mb-8" style="${r.revokedAt || (r.kind === 'warning' && !r.active) ? 'opacity:.55' : ''}">
            <span class="badge ${r.kind === 'warning' ? 'bad' : r.kind === 'action' ? '' : 'accent'}">${KIND[r.kind][0]} ${KIND[r.kind][1]}${r.kind === 'warning' ? ` · ${r.points}` : ''}</span>
            <span class="faint">${esc(fmtTime(r.at))}${r.by ? ` · ${esc(r.by)}` : ''}${r.revokedAt ? ' · taken back' : r.kind === 'warning' && !r.active ? ' · expired' : ''}</span>
            <div>${esc(r.text)}</div>
            ${admin && r.kind === 'warning' && !r.revokedAt ? `<button class="btn btn-sm btn-ghost" data-revoke="${esc(r.id)}">Take back</button>` : ''}</div>`
        )
        .join('') || '<div class="faint">Nothing on file.</div>'
    }`,
    actions: [{ label: 'Add entry', onClick: () => { m.close(); addDialog(done, f.name); } }, { label: 'Close', close: true, primary: true }],
  });
  document.querySelectorAll('[data-revoke]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmModal('Take back this warning', 'Its points stop counting. It stays in the history.', 'Take back'))) return;
      if (await attempt(() => api(`/api/player-records/${b.dataset.revoke}`, { method: 'DELETE' }))) {
        m.close();
        done();
      }
    })
  );
}

/* ----------------------------------------------------------------- alts */

async function altsTab(body) {
  const d = await api('/api/player-insights/alts');
  body.innerHTML = `
    <div class="card mb-16"><p class="hint" style="margin:0">Accounts that joined from the same address. Two accounts on one address is often family or friends; a banned account in the group is worth a look. Only Minecraft Java, Rust and Source games report addresses.</p></div>
    ${
      d.clusters
        .map(
          (c) => `<div class="card mb-16"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><span class="badge ${c.strong ? 'bad' : 'warn'}">${c.strong ? 'several shared addresses' : 'one shared address'}</span><span class="faint mono">${c.ips.map(esc).join(', ')}</span></div>
          <div class="mt-8">${c.accounts.map((a) => `<span class="badge ${a.banned ? 'bad' : ''}" title="${a.banned ? 'banned' : ''}${a.points ? ` · ${a.points} warning points` : ''}">${esc(a.name)}${a.banned ? ' (banned)' : ''}</span>`).join(' ')}</div></div>`
        )
        .join('') || '<div class="card faint">No accounts share an address yet.</div>'
    }
    ${d.busy.length ? `<div class="card"><h4>Busy addresses</h4><div class="hint">Many names from one address is usually a shared network (a school, a mobile carrier), so these are not used to link accounts.</div>${table(['Address', 'Names'], d.busy.map((b) => [`<span class="mono">${esc(b.ip)}</span>`, b.names]))}</div>` : ''}`;
}

/* ------------------------------------------------------------ protection */

async function protectionTab(body) {
  const draw = async () => {
    const p = await api('/api/join-protection');
    body.innerHTML = `
      <div class="card mb-16">
        <h4>VPN and proxy blocking</h4>
        <p class="hint" style="margin:0 0 10px">Checks the address of each new connection on proxycheck.io (the address is sent there, so this is off until you turn it on). A failed check never blocks anyone. Works on games that report addresses: Minecraft Java, Rust and Source engine games.</p>
        <div class="tools-grid">
          ${field('When a VPN or proxy joins', `<select id="jp-mode"><option value="off" ${p.mode === 'off' ? 'selected' : ''}>Do nothing</option><option value="log" ${p.mode === 'log' ? 'selected' : ''}>Only record it</option><option value="kick" ${p.mode === 'kick' ? 'selected' : ''}>Kick the player</option></select>`)}
          ${field('proxycheck.io key (optional)', `<input id="jp-key" type="password" autocomplete="off" placeholder="${p.apiKeySet ? 'saved (leave empty to keep)' : 'free to 100 lookups a day without one'}" />`)}
        </div>
        <label class="checkbox-row mt-8"><input type="checkbox" id="jp-ban" ${p.ban ? 'checked' : ''} /><label for="jp-ban">Also put them on the shared ban list</label></label>
        <div class="tools-grid mt-16">
          ${field('Always allow these addresses or ranges', `<input id="jp-ips" value="${esc(p.allowIps.join(', '))}" placeholder="203.0.113.7, 198.51.100.0/24" />`)}
          ${field('Always allow these players', `<input id="jp-names" value="${esc(p.allowNames.join(', '))}" placeholder="name1, name2" />`)}
        </div>
      </div>
      <div class="card mb-16"><h4>Alt accounts</h4>
        <label class="checkbox-row"><input type="checkbox" id="jp-alts" ${p.flagAlts ? 'checked' : ''} /><label for="jp-alts">Flag a player who joins from the address of a banned player (shows in the events and on their file)</label></label>
        <label class="checkbox-row mt-8"><input type="checkbox" id="jp-altkick" ${p.altKick ? 'checked' : ''} /><label for="jp-altkick">Also kick them</label></label>
      </div>
      <button class="btn btn-primary" id="jp-save">Save</button>`;
    $('#jp-save', body).addEventListener('click', async () => {
      const payload = { mode: $('#jp-mode', body).value, ban: $('#jp-ban', body).checked, allowIps: $('#jp-ips', body).value, allowNames: $('#jp-names', body).value, flagAlts: $('#jp-alts', body).checked, altKick: $('#jp-altkick', body).checked };
      if ($('#jp-key', body).value.trim()) payload.apiKey = $('#jp-key', body).value.trim();
      if (await attempt(() => api('/api/join-protection', { method: 'PUT', body: payload }), 'Saved')) draw();
    });
  };
  await draw();
}

/* -------------------------------------------------------------- insights */

async function insightsTab(body) {
  body.innerHTML = '<div class="card"><h4>When people play</h4><div id="hub-heat"><span class="spinner"></span></div></div><div class="card mt-16" id="hub-country-card" style="margin-top:16px"><h4>Where they connect from</h4><div id="hub-countries"><span class="spinner"></span></div></div>';
  drawHeatmap($('#hub-heat', body), '/api/player-insights/heatmap');
  if (state.user.role === 'admin') drawCountries($('#hub-countries', body), '/api/player-insights/countries');
  else $('#hub-country-card', body).remove();
}
