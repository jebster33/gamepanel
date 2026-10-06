import { api } from '../../core/api.js';
import { state } from '../../core/state.js';
import { $, $$, can, esc, fmtTime, icon, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';

/* ------------------------------------------------------ scheduled events */

// "Double XP weekend": some game settings change for a while, then go back.
// Optional: an administrator turns the feature on in Settings.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "every Friday at 18:00" from the simple crons the form makes. */
function whenLabel(cron) {
  const m = String(cron).match(/^(\d+) (\d+) \* \* (\*|\d)$/);
  if (!m) return `cron ${cron}`;
  const time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
  return m[3] === '*' ? `every day at ${time}` : `every ${WEEKDAYS[Number(m[3]) % 7]} at ${time}`;
}

const lasts = (hours) => (hours >= 24 && hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`);

export async function renderEventsCard(host, server) {
  const data = await api(`/api/servers/${server.id}/events`).catch(() => null);
  if (!data || !host.isConnected) return;
  const isAdmin = state.user.role === 'admin';
  if (!data.enabled && !data.events.length) {
    host.innerHTML = isAdmin
      ? `<div class="card mt-16"><h4>Scheduled events</h4><p class="faint" style="margin:0">Change game settings for a while, like a double XP weekend, then put them back automatically. Turn it on under <a href="#/settings">Settings → Scheduled events</a>.</p></div>`
      : '';
    return;
  }
  const editable = can('settings', server.id) && can('schedules', server.id);
  host.innerHTML = `
    <div class="card mt-16">
      <div class="card-head">
        <h4>Scheduled events</h4>
        <div class="spacer"></div>
        ${editable && data.enabled ? `<button class="btn btn-sm btn-primary" id="ev-add">${icon('plus', 12)} Add event</button>` : ''}
      </div>
      ${data.enabled ? '' : '<p class="warning" style="margin:0 0 10px;font-size:13px">Scheduled events are turned off in Settings. Events that are running still end on time.</p>'}
      ${
        data.events.length
          ? `<div class="list">${data.events.map((e) => eventRow(e, editable)).join('')}</div>`
          : '<p class="faint" style="margin:0">No events yet. For example: every Friday at 18:00 for 48 hours, double the XP rate and tell the players.</p>'
      }
    </div>`;
  const refresh = () => renderEventsCard(host, server);
  $('#ev-add')?.addEventListener('click', () => openEventModal(server, null, refresh));
  $$('[data-ev]', host).forEach((row) => {
    const event = data.events.find((e) => e.id === row.dataset.ev);
    row.querySelector('[data-ev-toggle]')?.addEventListener('change', async (e) => {
      try {
        await api(`/api/servers/${server.id}/events/${event.id}`, { method: 'PATCH', body: { enabled: e.target.checked } });
      } catch (err) {
        toast(err.message, 'error');
        e.target.checked = !e.target.checked;
      }
    });
    row.querySelector('[data-ev-now]')?.addEventListener('click', async (e) => {
      const action = event.active ? 'end' : 'start';
      e.currentTarget.disabled = true;
      try {
        await api(`/api/servers/${server.id}/events/${event.id}/${action}`, { method: 'POST', body: {} });
        toast(`${event.name} ${action === 'start' ? 'started' : 'ended'}`);
        refresh();
      } catch (err) {
        toast(err.message, 'error');
        refresh();
      }
    });
    row.querySelector('[data-ev-edit]')?.addEventListener('click', () => openEventModal(server, event, refresh));
    row.querySelector('[data-ev-delete]')?.addEventListener('click', async () => {
      if (!(await confirmModal('Delete event', `Delete "${event.name}"?${event.active ? ' It is running, so its settings are put back first.' : ''}`, 'Delete'))) return;
      await api(`/api/servers/${server.id}/events/${event.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      refresh();
    });
  });
}

function eventRow(e, editable) {
  const changes = Object.entries(e.changes)
    .map(([k, v]) => `<span class="mono">${esc(k)}=${esc(typeof v === 'boolean' ? (v ? 'on' : 'off') : v)}</span>`)
    .join(', ');
  return `
    <div class="list-row ${e.enabled || e.active ? '' : 'is-off'}" data-ev="${esc(e.id)}">
      ${editable ? `<label class="switch" title="${e.enabled ? 'On' : 'Off'}"><input type="checkbox" data-ev-toggle ${e.enabled ? 'checked' : ''} /><i></i></label>` : ''}
      <div class="grow">
        <div class="title">${esc(e.name)} ${e.active ? '<span class="badge accent">Running</span>' : ''}</div>
        <div class="sub">${esc(whenLabel(e.cron))} for ${lasts(e.hours)} · ${changes}${e.restart ? ' · restarts' : ''}</div>
      </div>
      <div class="hide-sm" style="text-align:right;font-size:12px">
        <div class="muted">${e.active ? `Ends ${fmtTime(e.active.endsAt)}` : e.nextRun ? `Next ${fmtTime(e.nextRun)}` : 'Paused'}</div>
      </div>
      ${
        editable
          ? `<button class="btn btn-sm" data-ev-now>${e.active ? 'End now' : 'Start now'}</button>
             <button class="btn btn-sm btn-ghost" data-ev-edit title="Edit">${icon('edit', 13)}</button>
             <button class="btn btn-sm btn-ghost btn-danger" data-ev-delete title="Delete">${icon('trash', 13)}</button>`
          : ''
      }
    </div>`;
}

async function openEventModal(server, event, onSaved) {
  const settings = await api(`/api/servers/${server.id}/game-settings`).catch((err) => ({ error: err.message }));
  if (settings.error || !settings.supported || settings.missing) {
    toast(settings.error || 'This server has no game settings the panel can change yet. Install and start it once first.', 'warn');
    return;
  }
  const fields = settings.groups.filter((g) => !g.managedGroup).flatMap((g) => g.fields).filter((f) => !f.managed);
  const m = String(event?.cron || '0 18 * * 5').match(/^(\d+) (\d+) \* \* (\*|\d)$/) || [null, '0', '18', '5'];
  const fieldOptions = (selected) =>
    fields.map((f) => `<option value="${esc(f.key)}" ${f.key === selected ? 'selected' : ''}>${esc(f.label || f.key)}</option>`).join('');
  const valueInput = (field, value) => {
    if (!field) return '<input data-ev-value disabled />';
    if (field.type === 'bool') return `<select data-ev-value><option value="true" ${value === true || value === 'true' ? 'selected' : ''}>On</option><option value="false" ${value === false || value === 'false' ? 'selected' : ''}>Off</option></select>`;
    if (field.type === 'select') return `<select data-ev-value>${field.options.map((o) => { const v = typeof o === 'object' ? o.value : o; const l = typeof o === 'object' ? o.label : o; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
    return `<input data-ev-value type="${field.type === 'number' ? 'number' : 'text'}" value="${esc(value ?? field.value ?? '')}" />`;
  };
  const changeRow = (key, value) => `<div class="ev-change">
      <select data-ev-key>${fieldOptions(key)}</select>
      <span class="ev-value">${valueInput(fields.find((f) => f.key === key) || fields[0], value)}</span>
      <button type="button" class="btn btn-sm btn-ghost" data-ev-remove title="Remove">${icon('kill', 12)}</button>
    </div>`;
  const initial = Object.entries(event?.changes || {});
  const modal = openModal({
    title: event ? `Edit ${esc(event.name)}` : 'New event',
    width: 620,
    body: `
      <label><span>Name</span><input id="ev-name" value="${esc(event?.name || '')}" placeholder="Double XP weekend" maxlength="60" /></label>
      <div class="form-grid">
        <label><span>Starts</span><select id="ev-day"><option value="*" ${m[3] === '*' ? 'selected' : ''}>Every day</option>${WEEKDAYS.map((d, i) => `<option value="${i}" ${m[3] === String(i) ? 'selected' : ''}>Every ${d}</option>`).join('')}</select></label>
        <label><span>At</span><input id="ev-time" type="time" value="${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}" /></label>
        <label><span>Lasts (hours)</span><input id="ev-hours" type="number" min="0.25" step="0.25" max="336" value="${event?.hours ?? 48}" /></label>
      </div>
      <div class="field-label">While it runs</div>
      <div id="ev-changes">${(initial.length ? initial : [[fields[0]?.key, undefined]]).map(([k, v]) => changeRow(k, v)).join('')}</div>
      <button type="button" class="btn btn-sm mt-8" id="ev-more">${icon('plus', 12)} Another setting</button>
      <div class="checkbox-row mt-16"><input type="checkbox" id="ev-announce" ${event?.announce === false ? '' : 'checked'} /><label for="ev-announce">Tell the players in chat when it starts and ends</label></div>
      <div class="checkbox-row"><input type="checkbox" id="ev-restart" ${event?.restart === false ? '' : 'checked'} /><label for="ev-restart">Restart the server so the change takes effect</label></div>
      <div class="hint">When it ends, every setting goes back to what it was when the event started. Times use the clock of the machine running the panel.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async (btn) => {
          const [hh, mm] = ($('#ev-time').value || '18:00').split(':').map(Number);
          const changes = {};
          $$('.ev-change').forEach((row) => {
            const key = row.querySelector('[data-ev-key]').value;
            const field = fields.find((f) => f.key === key);
            const raw = row.querySelector('[data-ev-value]').value;
            if (key) changes[key] = field?.type === 'bool' ? raw === 'true' : raw;
          });
          const body = { name: $('#ev-name').value, cron: `${mm} ${hh} * * ${$('#ev-day').value}`, hours: Number($('#ev-hours').value), changes, announce: $('#ev-announce').checked, restart: $('#ev-restart').checked };
          btn.disabled = true;
          try {
            await api(`/api/servers/${server.id}/events${event ? `/${event.id}` : ''}`, { method: event ? 'PATCH' : 'POST', body });
            toast('Event saved');
            modal.close();
            onSaved();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
  const wire = (row) => {
    row.querySelector('[data-ev-key]').addEventListener('change', (e) => {
      row.querySelector('.ev-value').innerHTML = valueInput(fields.find((f) => f.key === e.target.value));
    });
    row.querySelector('[data-ev-remove]').addEventListener('click', () => $$('.ev-change').length > 1 && row.remove());
  };
  $$('.ev-change').forEach(wire);
  $('#ev-more').addEventListener('click', () => {
    $('#ev-changes').insertAdjacentHTML('beforeend', changeRow(fields[0]?.key));
    wire($('#ev-changes').lastElementChild);
  });
}
