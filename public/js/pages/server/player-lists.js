import { api } from '../../core/api.js';
import { esc, toast } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';
import { avatar } from './players.js';

/* ----------------------------------------------- whitelist, ops and bans */

const HINTS = {
  whitelist: 'Only these players can join while the whitelist is on.',
  ops: 'Operators can use every in-game command. Give this out carefully.',
  bans: 'Banned players are refused when they try to join.',
  ipbans: 'Blocks every account connecting from these addresses.',
};

export async function renderLists(box, server) {
  box.innerHTML = '<div class="card"><span class="spinner"></span> Reading the lists…</div>';
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
    ${data.running ? '' : '<div class="card mb-16 faint" style="font-size:12.5px">The server is stopped, so changes are written straight to its files and apply when it starts.</div>'}
    <div class="lists-grid">${data.lists.map((l) => listCard(server, l)).join('')}</div>`;

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
                  ${list.ip ? '<span class="player-avatar">⌁</span>' : avatar(server, e.name || '?')}
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
