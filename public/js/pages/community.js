import { api } from '../core/api.js';
import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { $, esc, toast } from '../core/util.js';

/* ------------------------------------------------------------- community */

/**
 * Leaderboards across every game and server this account can see, plus (for
 * administrators) the switches for what the public status page and the
 * player portal show.
 */
export async function renderCommunity(view) {
  setCrumbs('Community');
  const admin = state.user?.role === 'admin';
  view.innerHTML = `<div class="page-head"><h1>Community</h1></div>
    <div class="card mb-16">
      <div class="card-head"><h4>Leaderboards</h4></div>
      <div class="row" style="gap:8px;margin-bottom:10px"><select id="cm-game" style="width:auto"></select><select id="cm-metric" style="width:auto"></select></div>
      <div id="cm-board" class="faint">Loading…</div>
    </div>
    ${admin ? '<div class="card mb-16" id="cm-public"><div class="faint">Loading…</div></div>' : ''}`;
  let choice = { game: '', metric: '' };

  const draw = async () => {
    try {
      const q = new URLSearchParams();
      if (choice.game) q.set('game', choice.game);
      if (choice.metric) q.set('metric', choice.metric);
      const data = await api(`/api/leaderboards?${q}`);
      if (!$('#cm-board')) return;
      choice = { game: data.game || '', metric: data.metric };
      $('#cm-game').innerHTML = `<option value="">All games</option>${data.games.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}`;
      $('#cm-game').value = choice.game;
      $('#cm-metric').innerHTML = data.metrics.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
      $('#cm-metric').value = choice.metric;
      $('#cm-board').classList.remove('faint');
      $('#cm-board').innerHTML = data.rows.length
        ? `<div class="list">${data.rows
            .map((r) => `<div class="list-row"><div class="mono faint" style="width:28px">${r.rank}</div><div class="grow"><div class="title">${esc(r.name)}</div>${r.servers > 1 ? `<div class="sub">${r.servers} servers</div>` : ''}</div><b>${esc(r.display)}</b></div>`)
            .join('')}</div>`
        : '<div class="faint">Nobody on the board yet. It fills as players join your servers.</div>';
    } catch (err) {
      if ($('#cm-board')) $('#cm-board').textContent = err.message;
    }
  };
  $('#cm-game').addEventListener('change', () => {
    choice = { game: $('#cm-game').value, metric: '' };
    draw();
  });
  $('#cm-metric').addEventListener('change', () => {
    choice.metric = $('#cm-metric').value;
    draw();
  });
  draw();
  if (admin) renderPublic();
}

async function renderPublic() {
  const host = $('#cm-public');
  const [community, portal] = await Promise.all([api('/api/community/settings'), api('/api/portal/settings')]).catch((err) => {
    if (host) host.textContent = err.message;
    return [];
  });
  if (!community || !host?.isConnected) return;
  const check = (id, label, on, hint) => `<div class="checkbox-row"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} /><label for="${id}">${label}</label></div>${hint ? `<div class="faint" style="margin:-4px 0 10px 26px">${hint}</div>` : ''}`;
  host.innerHTML = `
    <div class="card-head"><h4>Public pages</h4></div>
    <p class="faint" style="margin:0 0 12px">What visitors can see. The public status page (Settings) lists the servers; ${community.publicServers} ${community.publicServers === 1 ? 'is' : 'are'} on it now${community.enabled ? '' : ', and the page itself is off'}.</p>
    ${check('cm-boards', 'Show a leaderboard on the status page', community.showBoards)}
    ${check('cm-feed', 'Show recent joins and leaves on the status page', community.showFeed, 'Names, server and time only. Off by default because it shows who is playing.')}
    ${check('cm-portal', 'Open the player portal', portal.enabled, `Players sign in at <span class="mono">${esc(location.origin)}/portal</span> to see their own stats and bans. Steam sign-in is ${portal.steam ? 'on' : 'off (turn it on under Settings, Sign-in providers)'}, Discord is ${portal.discord ? 'on' : 'off'}. Players can also prove their name with a code in game chat.`)}
    <button class="btn btn-primary mt-16" id="cm-save-public">Save</button>`;
  $('#cm-save-public').addEventListener('click', async () => {
    try {
      await api('/api/community/settings', { method: 'PUT', body: { showBoards: $('#cm-boards').checked, showFeed: $('#cm-feed').checked } });
      await api('/api/portal/settings', { method: 'PUT', body: { enabled: $('#cm-portal').checked } });
      toast('Saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
