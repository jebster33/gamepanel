import { api } from '../../core/api.js';
import { can, esc, fmtDuration, toast } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';

/* --------------------------------------------------------------- players */

const ACTION_LABELS = { kick: 'Kick', ban: 'Ban' };

export function renderPlayersTab(host, server) {
  host.innerHTML = '<div class="card card-flush players-card" id="players-list"></div>';
  host.addEventListener('click', onAction);
  patchPlayersTab(server);
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
            <td><span class="player"><span class="player-dot"></span><span class="player-avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>${esc(p.name)}</span></td>
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
  const btn = event.target.closest('[data-player-action]');
  if (!btn) return;
  const serverId = document.getElementById('players-list')?.dataset.server;
  const { playerAction: action, player } = btn.dataset;
  if (action === 'ban' && !(await confirmModal(`Ban ${player}`, `${player} is removed and cannot join again until unbanned in the game's console.`, 'Ban'))) return;
  btn.disabled = true;
  try {
    await api(`/api/servers/${serverId}/players/action`, { method: 'POST', body: { action, name: player } });
    toast(`${ACTION_LABELS[action] || action}: ${player}`);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
  }
}
