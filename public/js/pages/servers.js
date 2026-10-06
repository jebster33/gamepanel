import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { $, can, esc, fmtBytes, gameArt, icon, statusPill, toast } from '../core/util.js';
import { revealChildren } from '../ui/fx.js';

/* --------------------------------------------------------- server cards */

export function serverAddress(server) {
  const sub = server.subdomain;
  if (sub) return sub.srv || !sub.port ? sub.host : `${sub.host}:${sub.port}`;
  const port = server.ports?.game ?? Object.values(server.ports || {})[0];
  return `${server.node?.host || location.hostname}:${port}`;
}

export function renderServerCards({ selectable = false } = {}) {
  if (!state.servers.length) {
    return `<div class="empty">
      <img class="line-art" src="/img/empty-rack.png" alt="" width="140" height="135" />
      <h3>No servers yet</h3>
      <p>Pick a game and the panel installs it, opens the ports and starts it for you.</p>
      ${state.user?.role === 'admin' ? '<div class="row" style="justify-content:center"><a class="btn btn-primary" href="#/templates">Pick a game</a><button class="btn" data-import>Import existing</button></div>' : ''}
    </div>`;
  }
  return `
    <div class="srv-list">
      <div class="srv-row srv-head">
        <span class="srv-first">${selectable ? '<input type="checkbox" id="srv-check-all" title="Select all" aria-label="Select all servers" />' : ''}<span>Server</span></span>
        <span>Status</span>
        <span class="hide-sm">CPU</span>
        <span class="hide-sm">Memory</span>
        <span class="hide-md hide-sm">Players</span>
        <span class="hide-md hide-sm">Ping</span>
        <span></span>
      </div>
      ${state.servers.map((server) => serverRow(server, selectable)).join('')}
    </div>`;
}

function serverRow(server, selectable) {
  const memPct = server.memoryLimit ? Math.min(100, (server.memory / server.memoryLimit) * 100) : 0;
  const running = ['running', 'starting'].includes(server.status);
  return `
  <div class="srv-row spot" data-card="${esc(server.id)}">
    <span class="srv-first">${selectable ? `<input type="checkbox" class="srv-check" data-select="${esc(server.id)}" aria-label="Select ${esc(server.name)}" ${picked.has(server.id) ? 'checked' : ''} />` : ''}
    <a class="srv-identity" href="#/servers/${esc(server.id)}">
      <span class="srv-icon">${gameArt({ icon: server.templateIcon, logo: server.templateLogo, storeAppId: server.templateStoreAppId })}</span>
      <span class="srv-name">
        <span class="title">${esc(server.name)}</span>
        <span class="sub">${esc(server.templateName)}${
          server.gameVersion ? ` · <span class="ver">${esc(server.gameVersion)}</span>` : ''
        } · ${esc(serverAddress(server))}${server.node ? ` · <span class="badge" title="Runs on another machine">${esc(server.node.name)}</span>` : ''}</span>
      </span>
    </a>
    </span>

    <span data-field="status">${statusPill(server.status)}</span>

    <span class="srv-metric hide-sm">
      <b data-field="cpu">${(server.cpu || 0).toFixed(0)}%</b>
    </span>

    <span class="srv-metric hide-sm">
      <b data-field="mem">${fmtBytes(server.memory)}</b>
      <span class="meter accent" style="width:52px;margin-top:5px"><i data-field="mem-bar" style="width:${memPct.toFixed(
        0
      )}%"></i></span>
    </span>

    <span class="srv-metric hide-md hide-sm" data-field="players">${
      server.players ?? (server.playerList?.length || '—')
    }${server.maxPlayers ? ` <span class="faint">/ ${server.maxPlayers}</span>` : ''}</span>

    <span class="srv-metric hide-md hide-sm" data-field="ping">${server.ping != null ? server.ping + ' ms' : '—'}</span>

    <span class="srv-actions">
      ${
        running
          ? `<button class="btn btn-sm btn-ghost" data-power="restart" data-id="${esc(
              server.id
            )}" title="Restart">${icon('restart')}</button>
             <button class="btn btn-sm btn-ghost btn-danger" data-power="stop" data-id="${esc(
               server.id
             )}" title="Stop">${icon('stop', 12)}</button>`
          : `<button class="btn btn-sm" data-power="start" data-id="${esc(server.id)}" ${
              ['installing', 'stopping'].includes(server.status) ? 'disabled' : ''
            }>${icon('play', 12)} Start</button>`
      }
      <a class="btn btn-sm" href="#/servers/${esc(server.id)}/console">Console</a>
    </span>
  </div>`;
}

export function patchServerCards() {
  for (const server of state.servers) {
    const card = $(`[data-card="${CSS.escape(server.id)}"]`);
    if (!card) continue;
    const set = (field, html) => {
      const el = card.querySelector(`[data-field="${field}"]`);
      if (el) el.innerHTML = html;
    };
    const memPct = server.memoryLimit ? Math.min(100, (server.memory / server.memoryLimit) * 100) : 0;
    set('cpu', `${(server.cpu || 0).toFixed(0)}%`);
    set('mem', fmtBytes(server.memory));
    set(
      'players',
      `${server.players ?? (server.playerList?.length || '—')}${server.maxPlayers ? ` <span class="faint">/ ${server.maxPlayers}</span>` : ''}`
    );
    set('ping', server.ping != null ? `${server.ping} ms` : '—');
    const memBar = card.querySelector('[data-field="mem-bar"]');
    if (memBar) memBar.style.width = `${memPct.toFixed(0)}%`;
  }
}

export function renderServers(view) {
  setCrumbs('Servers');
  setTimeout(() => revealChildren($('.srv-list'), ':scope > .srv-row'), 0);
  view.innerHTML = `
    <div class="page-head">
      <h1>Servers</h1>
      <div class="spacer"></div>
      ${can('power') && state.servers.length > 1 ? '<button class="btn btn-ghost" id="start-all" title="Start every installed server that is stopped">Start all</button><button class="btn btn-ghost" id="stop-all" title="Stop every running server">Stop all</button>' : ''}
      ${can('command') && state.servers.length ? '<button class="btn" id="broadcast-all" title="Say something in the chat of every running server">Message all</button>' : ''}
      ${state.user.role === 'admin' ? '<button class="btn" data-import>Import existing</button><a class="btn btn-primary" href="#/templates">New server</a>' : ''}
    </div>
    <div class="batch-bar hidden" id="batch-bar">
      <b id="batch-count"></b>
      ${can('power') ? `<button class="btn btn-sm" data-batch="start">${icon('play', 11)} Start</button><button class="btn btn-sm" data-batch="restart">${icon('restart', 12)} Restart</button><button class="btn btn-sm btn-danger" data-batch="stop">${icon('stop', 11)} Stop</button><button class="btn btn-sm" data-batch="update" title="Steam games: pull the newest build (while stopped)">Update</button>` : ''}
      ${can('backups') ? `<button class="btn btn-sm" data-batch="backup">${icon('archive', 12)} Back up</button>` : ''}
      <span style="flex:1"></span>
      <button class="btn btn-sm btn-ghost" data-batch="clear">Clear</button>
    </div>
    ${renderServerCards({ selectable: state.servers.length > 1 })}`;
  wireBatch(view);
  $('#broadcast-all')?.addEventListener('click', broadcastAll);
  $('#start-all')?.addEventListener('click', () => powerAll('start'));
  $('#stop-all')?.addEventListener('click', () => powerAll('stop'));
}

async function powerAll(action) {
  const targets = state.servers.filter((s) => (action === 'start' ? ['offline', 'crashed'].includes(s.status) && s.installedAt : ['running', 'starting'].includes(s.status)));
  if (!targets.length) return toast(action === 'start' ? 'Everything is already running' : 'Nothing is running');
  const { confirmModal } = await import('../ui/modal.js');
  const names = targets.map((s) => s.name).join(', ');
  if (!(await confirmModal(`${action === 'start' ? 'Start' : 'Stop'} ${targets.length} server${targets.length === 1 ? '' : 's'}`, names, action === 'start' ? 'Start all' : 'Stop all'))) return;
  const results = await Promise.allSettled(targets.map((s) => api(`/api/servers/${s.id}/power`, { method: 'POST', body: { action } })));
  const failed = results.filter((r) => r.status === 'rejected').length;
  toast(`${action === 'start' ? 'Starting' : 'Stopping'} ${targets.length - failed} server${targets.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`, failed ? 'warn' : 'info');
}

/* -------------------------------------------------------- batch actions */

// Survives the page redrawing itself whenever a server's status changes.
const picked = new Set();

const BATCH = {
  start: { label: 'Start', run: (s) => api(`/api/servers/${s.id}/power`, { method: 'POST', body: { action: 'start' } }), fits: (s) => ['offline', 'crashed'].includes(s.status) },
  stop: { label: 'Stop', run: (s) => api(`/api/servers/${s.id}/power`, { method: 'POST', body: { action: 'stop' } }), fits: (s) => ['running', 'starting'].includes(s.status) },
  restart: { label: 'Restart', run: (s) => api(`/api/servers/${s.id}/power`, { method: 'POST', body: { action: 'restart' } }), fits: (s) => ['running', 'starting'].includes(s.status) },
  update: { label: 'Update', run: (s) => api(`/api/servers/${s.id}/update`, { method: 'POST', body: {} }), fits: (s) => s.canUpdate && !['running', 'starting', 'installing'].includes(s.status) },
  backup: { label: 'Back up', run: (s) => api(`/api/servers/${s.id}/backups`, { method: 'POST', body: {} }), fits: (s) => s.installedAt && s.status !== 'installing' },
};

function wireBatch(view) {
  // Servers that were deleted meanwhile drop out of the selection.
  for (const id of [...picked]) if (!state.servers.some((s) => s.id === id)) picked.delete(id);
  const selected = () => [...picked];
  const sync = () => {
    picked.clear();
    view.querySelectorAll('[data-select]:checked').forEach((el) => picked.add(el.dataset.select));
    const ids = selected();
    $('#batch-bar').classList.toggle('hidden', !ids.length);
    $('#batch-count').textContent = `${ids.length} selected`;
    const all = $('#srv-check-all');
    if (all) {
      const boxes = view.querySelectorAll('[data-select]');
      all.checked = ids.length > 0 && ids.length === boxes.length;
      all.indeterminate = ids.length > 0 && ids.length < boxes.length;
    }
  };
  view.querySelectorAll('[data-select]').forEach((el) => el.addEventListener('change', sync));
  sync();
  $('#srv-check-all')?.addEventListener('change', (e) => {
    view.querySelectorAll('[data-select]').forEach((el) => (el.checked = e.target.checked));
    sync();
  });
  view.querySelectorAll('[data-batch]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const action = btn.dataset.batch;
      if (action === 'clear') {
        view.querySelectorAll('[data-select]').forEach((el) => (el.checked = false));
        return sync();
      }
      const job = BATCH[action];
      const chosen = selected().map((id) => state.servers.find((s) => s.id === id)).filter(Boolean);
      const targets = chosen.filter(job.fits);
      const skipped = chosen.length - targets.length;
      if (!targets.length) return toast(`None of the selected servers can ${job.label.toLowerCase()} right now`, 'warn');
      if (['stop', 'restart'].includes(action)) {
        const { confirmModal } = await import('../ui/modal.js');
        if (!(await confirmModal(`${job.label} ${targets.length} server${targets.length === 1 ? '' : 's'}`, targets.map((s) => s.name).join(', '), job.label))) return;
      }
      btn.disabled = true;
      // A few at a time, so twenty backups do not all hit the disk at once.
      const results = [];
      for (let i = 0; i < targets.length; i += 3) results.push(...(await Promise.allSettled(targets.slice(i, i + 3).map(job.run))));
      btn.disabled = false;
      const failed = results.map((r, i) => (r.status === 'rejected' ? `${targets[i].name}: ${r.reason.message}` : null)).filter(Boolean);
      const done = targets.length - failed.length;
      toast(`${job.label}: ${done} server${done === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped (not in a state for it)` : ''}${failed.length ? `. Failed: ${failed.join('; ')}` : ''}`, failed.length ? 'warn' : 'info', failed.length ? 9000 : 4200);
    })
  );
}

async function broadcastAll() {
  const { promptModal } = await import('../ui/modal.js');
  const message = await promptModal('Message every server', 'Shown in the chat of every running server', '', { hint: 'Handy for "Restarting everything in 5 minutes".' });
  if (!message?.trim()) return;
  try {
    const { results } = await api('/api/servers/broadcast', { method: 'POST', body: { message } });
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    toast(`Sent to ${ok} server${ok === 1 ? '' : 's'}${failed.length ? `. Failed on ${failed.map((r) => r.server).join(', ')}` : ''}`, failed.length ? 'warn' : 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}
