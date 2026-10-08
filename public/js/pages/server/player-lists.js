import { api } from '../../core/api.js';
import { state } from '../../core/state.js';
import { esc, toast, icon } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';
import { avatar } from './players.js';
import { skeleton } from '../../ui/skeleton.js';

/* ----------------------------------------------- whitelist, ops and bans */

const HINTS = {
  whitelist: 'Only these players can join while the whitelist is on.',
  ops: 'Operators can use every in-game command. Give this out carefully.',
  bans: 'Banned players are refused when they try to join.',
  ipbans: 'Blocks every account connecting from these addresses.',
};

export async function renderLists(box, server) {
  box.innerHTML = skeleton('list', 'Reading the lists…');
  let data;
  try {
    data = await api(`/api/servers/${server.id}/player-lists`);
  } catch (err) {
    box.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  draw(box, server, data);
}

function draw(box, server, data) {
  if (!data.supported) {
    box.innerHTML = '<div class="card faint">This game has no whitelist or ban list the panel can manage. Use the console instead.</div>';
    return;
  }
  const wl = data.lists.find((l) => l.id === 'whitelist');
  box.innerHTML = `
    ${
      wl
        ? `<div class="card mb-16 row wl-toggle">
            <div style="flex:1;min-width:200px">
              <b>${esc(wl.label)} is ${wl.enabled ? '<span class="lime">on</span>' : 'off'}</b>
              <div class="faint" style="font-size:12.5px">${wl.enabled ? `Only the ${wl.entries.length} player${wl.entries.length === 1 ? '' : 's'} below can join.` : 'Anyone can join. Turn it on to make the server invite-only.'}</div>
            </div>
            <label class="switch"><input type="checkbox" id="wl-enabled" ${wl.enabled ? 'checked' : ''} /><i></i></label>
          </div>`
        : ''
    }
    ${
      wl
        ? `<div class="card mb-16 row wl-toggle">
            <div style="flex:1;min-width:200px">
              <b>Maintenance mode ${data.maintenance ? '<span class="lime">on</span>' : ''}</b>
              <div class="faint" style="font-size:12.5px">${
                data.maintenance
                  ? `Only ops and whitelisted players can join. Turning it off puts the whitelist${data.maintenance.motd !== undefined ? ' and MOTD' : ''} back.`
                  : 'Kicks everyone except ops and whitelisted players, keeps them out, and shows a message in the server list from the next start.'
              }</div>
              ${data.maintenance ? '' : '<input id="mt-message" class="mt-8" maxlength="120" placeholder="Down for maintenance, back soon!" style="margin-top:8px" />'}
            </div>
            <label class="switch"><input type="checkbox" id="mt-enabled" ${data.maintenance ? 'checked' : ''} /><i></i></label>
          </div>`
        : ''
    }
    ${wl ? '<div id="dw-card"></div>' : ''}
    ${data.running ? '' : '<div class="card mb-16 faint" style="font-size:12.5px">The server is stopped, so changes are written straight to its files and apply when it starts.</div>'}
    <div class="lists-grid">${data.lists.map((l) => listCard(server, l)).join('')}</div>`;

  if (wl) renderDiscordWhitelist(box.querySelector('#dw-card'), server, () => renderLists(box, server));

  box.querySelector('#wl-enabled')?.addEventListener('change', async (event) => {
    const input = event.currentTarget;
    input.disabled = true;
    try {
      const next = await api(`/api/servers/${server.id}/player-lists/whitelist`, { method: 'PUT', body: { enabled: input.checked } });
      toast(`Whitelist ${input.checked ? 'on' : 'off'}${next.restartNeeded ? '. Restart to apply.' : ''}`);
      draw(box, server, next);
    } catch (err) {
      toast(err.message, 'error');
      input.checked = !input.checked;
      input.disabled = false;
    }
  });

  box.querySelector('#mt-enabled')?.addEventListener('change', async (event) => {
    const input = event.currentTarget;
    input.disabled = true;
    try {
      const next = await api(`/api/servers/${server.id}/maintenance`, { method: 'PUT', body: { enabled: input.checked, message: box.querySelector('#mt-message')?.value } });
      toast(input.checked ? 'Maintenance mode on' : 'Maintenance mode off. Restart to show the normal MOTD again.');
      draw(box, server, next);
    } catch (err) {
      toast(err.message, 'error');
      input.checked = !input.checked;
      input.disabled = false;
    }
  });

  box.querySelectorAll('[data-list-form]').forEach((form) =>
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const list = form.dataset.listForm;
      const name = form.elements.name.value.trim();
      if (!name) return;
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        const next = await api(`/api/servers/${server.id}/player-lists`, {
          method: 'POST',
          body: { list, action: 'add', name, reason: form.elements.reason?.value },
        });
        toast(`Added ${name}`);
        draw(box, server, next);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    })
  );

  box.querySelectorAll('[data-list-remove]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const { listRemove: list, name } = btn.dataset;
      if (list === 'ops' && !(await confirmModal(`Remove ${esc(name)} as operator`, `${name} loses access to operator commands.`, 'Remove'))) return;
      btn.disabled = true;
      try {
        const next = await api(`/api/servers/${server.id}/player-lists`, { method: 'POST', body: { list, action: 'remove', name } });
        toast(`Removed ${name}`);
        draw(box, server, next);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    })
  );
}

function listCard(server, list) {
  const removeLabel = list.id === 'bans' || list.id === 'ipbans' ? 'Unban' : 'Remove';
  return `
    <div class="card card-flush list-card">
      <div class="players-head">
        <div><b>${esc(list.label)}</b> <span class="faint mono">${list.entries.length}</span></div>
      </div>
      <p class="faint list-hint">${esc(HINTS[list.id] || '')}</p>
      <form class="list-add" data-list-form="${esc(list.id)}">
        <input name="name" placeholder="${list.ip ? 'IP address' : 'Player name'}" autocomplete="off" spellcheck="false" />
        ${list.reason ? '<input name="reason" placeholder="Reason (optional)" autocomplete="off" />' : ''}
        <button class="btn ${list.id.includes('ban') ? 'btn-danger' : 'btn-primary'}" type="submit">${list.id.includes('ban') ? 'Ban' : 'Add'}</button>
      </form>
      <div class="list-entries">${
        list.entries.length
          ? list.entries
              .map(
                (e) => `<div class="list-entry">
                  ${list.ip ? `<span class="player-avatar">${icon('network', 14)}</span>` : avatar(server, e.name || '?')}
                  <div style="min-width:0;flex:1">
                    <div class="list-name">${esc(e.name || e.uuid || '?')}${e.level ? ` <span class="badge">level ${esc(e.level)}</span>` : ''}</div>
                    ${e.reason || e.source ? `<div class="faint list-meta">${esc([e.reason, e.source && `by ${e.source}`].filter(Boolean).join(' · '))}</div>` : ''}
                  </div>
                  <button class="btn btn-sm btn-ghost" data-list-remove="${esc(list.id)}" data-name="${esc(e.name)}">${removeLabel}</button>
                </div>`
              )
              .join('')
          : '<div class="faint list-empty">Empty</div>'
      }</div>
    </div>`;
}

/* ------------------------------------------------ whitelist from Discord */

async function renderDiscordWhitelist(card, server, onChange) {
  let data;
  try {
    data = await api(`/api/servers/${server.id}/discord-whitelist`);
  } catch {
    return;
  }
  if (!card.isConnected) return;
  const s = data.settings;
  const sync = data.sync;
  card.innerHTML = `
    <div class="card mb-16">
      <div class="row wl-toggle" style="margin:0">
        <div style="flex:1;min-width:200px">
          <b>Whitelist from Discord roles ${s.enabled ? '<span class="lime">on</span>' : ''}</b>
          <div class="faint" style="font-size:12.5px">${
            s.enabled
              ? `${data.managed.length} player${data.managed.length === 1 ? '' : 's'} added from Discord${sync?.error ? ` · <span class="bad-text">${esc(sync.error)}</span>` : sync?.at ? ` · checked ${esc(new Date(sync.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : ''}. Players type <span class="mono">/link name</span> to the bot.`
              : 'Members with the roles you pick are whitelisted, and taken off again when they lose the role. People you added by hand stay.'
          }</div>
        </div>
        <button class="btn btn-sm" id="dw-edit">${s.enabled ? 'Change' : 'Set up'}</button>
      </div>
      <div id="dw-form" class="hidden mt-16"></div>
    </div>`;

  card.querySelector('#dw-edit').addEventListener('click', async () => {
    const form = card.querySelector('#dw-form');
    if (!form.classList.contains('hidden')) {
      form.classList.add('hidden');
      return;
    }
    form.classList.remove('hidden');
    form.innerHTML = '<span class="spinner"></span> Asking Discord for your roles…';
    let guilds;
    try {
      ({ guilds } = await api('/api/discord/guilds'));
    } catch (err) {
      form.innerHTML = `<p class="faint" style="margin:0">${esc(err.message)} ${state.user.role === 'admin' ? '<a href="#/settings/discord-bot">Discord bot settings</a>' : ''}</p>`;
      return;
    }
    if (!guilds.length) {
      form.innerHTML = '<p class="faint" style="margin:0">The bot is not in any Discord server yet. Invite it from Settings → Discord bot.</p>';
      return;
    }
    let guildId = s.guildId && guilds.some((g) => g.id === s.guildId) ? s.guildId : guilds[0].id;
    const roleBoxes = () => {
      const g = guilds.find((x) => x.id === guildId);
      return g.roles.length
        ? g.roles
            .map(
              (r) => `<label class="dw-role"><input type="checkbox" value="${esc(r.id)}" ${s.roles.includes(r.id) ? 'checked' : ''} />
                <span class="dot" style="background:${esc(r.color || 'var(--faint)')}"></span>${esc(r.name)}</label>`
            )
            .join('')
        : '<span class="faint">This Discord server has no roles yet.</span>';
    };
    form.innerHTML = `
      <label class="field"><span>Discord server</span>
        <select id="dw-guild">${guilds.map((g) => `<option value="${esc(g.id)}" ${g.id === guildId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
      </label>
      <div class="field"><span>Roles that get on the whitelist</span><div class="dw-roles" id="dw-roles">${roleBoxes()}</div></div>
      <label class="field"><span>Their Minecraft name comes from</span>
        <select id="dw-source">
          <option value="link" ${s.source !== 'nickname' ? 'selected' : ''}>/link name, typed to the bot</option>
          <option value="nickname" ${s.source === 'nickname' ? 'selected' : ''}>/link, or else their Discord nickname</option>
        </select>
      </label>
      <div class="hint">The bot needs "Server Members Intent" switched on in the Discord developer portal (Bot page) to see who has which role.</div>
      <div class="row mt-16" style="justify-content:flex-end;gap:8px">
        ${s.enabled ? '<button class="btn btn-ghost" id="dw-off">Turn off</button>' : ''}
        <button class="btn btn-primary" id="dw-save">Save and sync</button>
      </div>`;
    form.querySelector('#dw-guild').addEventListener('change', (event) => {
      guildId = event.target.value;
      form.querySelector('#dw-roles').innerHTML = roleBoxes();
    });
    const save = async (enabled, btn) => {
      btn.disabled = true;
      try {
        const roles = [...form.querySelectorAll('#dw-roles input:checked')].map((i) => i.value);
        const r = await api(`/api/servers/${server.id}/discord-whitelist`, { method: 'PUT', body: { enabled, guildId, roles, source: form.querySelector('#dw-source').value } });
        toast(enabled ? `Synced: ${r.added.length} added, ${r.removed.length} removed` : 'Whitelist from Discord roles is off');
        onChange();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    };
    form.querySelector('#dw-save').addEventListener('click', (e) => save(true, e.currentTarget));
    form.querySelector('#dw-off')?.addEventListener('click', (e) => save(false, e.currentTarget));
  });
}
