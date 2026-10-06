import { api } from '../../core/api.js';
import { $, esc, fmtTime, icon, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';

/* ------------------------------------------------------------ schedules */

/**
 * Timed tasks for one server: nightly restarts, regular backups, a console
 * command on the hour. The panel stores cron expressions; people pick from
 * plain-language presets and only see cron when they want "Custom".
 */

const ACTIONS = [
  ['restart', 'Restart the server'],
  ['backup', 'Make a backup'],
  ['command', 'Run a console command'],
  ['start', 'Start the server'],
  ['stop', 'Stop the server'],
  ['update', 'Update the game (while stopped)'],
];

const PRESETS = [
  ['0 5 * * *', 'Every day at 05:00'],
  ['0 */6 * * *', 'Every 6 hours'],
  ['0 * * * *', 'Every hour'],
  ['*/30 * * * *', 'Every 30 minutes'],
  ['0 4 * * 1', 'Every Monday at 04:00'],
  ['custom', 'Custom (cron)'],
];

const actionLabel = (id) => ACTIONS.find(([a]) => a === id)?.[1] || id;
const whenLabel = (cron) => PRESETS.find(([c]) => c === cron)?.[1] || `cron ${cron}`;

export async function renderSchedulesTab(host, server) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading schedules…</div>';
  let schedules;
  try {
    ({ schedules } = await api(`/api/servers/${server.id}/schedules`));
  } catch (err) {
    host.innerHTML = `<div class="card">${esc(err.message)}</div>`;
    return;
  }

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h4>Scheduled tasks</h4>
        <div class="spacer"></div>
        <button class="btn btn-sm btn-primary" id="sch-add">${icon('plus', 12)} Add task</button>
      </div>
      ${
        schedules.length
          ? `<div class="list">${schedules.map(scheduleRow).join('')}</div>`
          : `<p class="faint" style="margin:0">Nothing scheduled. A nightly restart and a backup every 6 hours keep most servers healthy.</p>
             <div class="row mt-16">
               <button class="btn btn-sm" data-quick="restart">${icon('restart', 12)} Restart daily at 05:00</button>
               <button class="btn btn-sm" data-quick="backup">${icon('archive', 12)} Back up every 6 hours</button>
             </div>`
      }
      <div class="hint">Times use the clock of the machine running the panel.</div>
    </div>
    ${
      server.playerCommands?.length || (server.templateId || '').startsWith('minecraft')
        ? `<div class="card mt-16">
      <div class="card-head">
        <h4>Chat announcements</h4>
        <div class="spacer"></div>
        <label class="switch"><input type="checkbox" id="an-on" ${server.announcements?.enabled ? 'checked' : ''} /><i></i></label>
      </div>
      <p class="faint" style="margin:0 0 10px">Posts these in game chat, one at a time in turn, while anyone is online. One message per line.</p>
      <textarea id="an-messages" rows="4" maxlength="4200" placeholder="Join our Discord: discord.gg/…&#10;Vote for us daily for rewards!&#10;Be nice. Griefing gets you banned.">${esc((server.announcements?.messages || []).join('\n'))}</textarea>
      <div class="row mt-16" style="gap:8px;align-items:center">
        <span class="faint">Every</span>
        <select id="an-every" style="width:auto">${[5, 10, 15, 30, 60]
          .map((n) => `<option value="${n}" ${(server.announcements?.every || 15) === n ? 'selected' : ''}>${n} minutes</option>`)
          .join('')}</select>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="an-save">Save</button>
      </div>
    </div>`
        : ''
    }`;

  const saveAnnouncements = async () => {
    try {
      const { announcements } = await api(`/api/servers/${server.id}/announcements`, {
        method: 'PUT',
        body: { enabled: $('#an-on').checked, every: Number($('#an-every').value), messages: $('#an-messages').value.split('\n') },
      });
      server.announcements = announcements;
      $('#an-on').checked = announcements.enabled;
      toast(announcements.enabled ? `Announcing every ${announcements.every} minutes` : 'Announcements off');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('#an-save')?.addEventListener('click', saveAnnouncements);
  $('#an-on')?.addEventListener('change', saveAnnouncements);

  const refresh = () => renderSchedulesTab(host, server);
  $('#sch-add').addEventListener('click', () => openScheduleModal(server, null, refresh));

  host.querySelectorAll('[data-quick]').forEach((el) =>
    el.addEventListener('click', async () => {
      const body =
        el.dataset.quick === 'restart'
          ? { name: 'Nightly restart', action: 'restart', cron: '0 5 * * *' }
          : { name: 'Regular backup', action: 'backup', cron: '0 */6 * * *' };
      try {
        await api(`/api/servers/${server.id}/schedules`, { method: 'POST', body });
        toast(`${body.name} scheduled`);
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  host.querySelectorAll('[data-sch]').forEach((row) => {
    const schedule = schedules.find((s) => s.id === row.dataset.sch);
    row.querySelector('[data-enable]').addEventListener('change', async (event) => {
      try {
        await api(`/api/servers/${server.id}/schedules/${schedule.id}`, { method: 'PATCH', body: { enabled: event.target.checked } });
        refresh();
      } catch (err) {
        toast(err.message, 'error');
        event.target.checked = !event.target.checked;
      }
    });
    row.querySelector('[data-run]').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        const { result } = await api(`/api/servers/${server.id}/schedules/${schedule.id}/run`, { method: 'POST', body: {} });
        toast(`${schedule.name}: ${result}`, String(result).startsWith('failed') ? 'error' : 'info');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
    row.querySelector('[data-edit]').addEventListener('click', () => openScheduleModal(server, schedule, refresh));
    row.querySelector('[data-delete]').addEventListener('click', async () => {
      if (!(await confirmModal('Delete task', `Delete "${schedule.name}"?`, 'Delete'))) return;
      await api(`/api/servers/${server.id}/schedules/${schedule.id}`, { method: 'DELETE' });
      refresh();
    });
  });
}

function scheduleRow(s) {
  const failed = String(s.lastResult || '').startsWith('failed');
  return `
    <div class="list-row ${s.enabled ? '' : 'is-off'}" data-sch="${esc(s.id)}">
      <label class="switch" title="${s.enabled ? 'On' : 'Off'}"><input type="checkbox" data-enable ${s.enabled ? 'checked' : ''} /><i></i></label>
      <div class="grow">
        <div class="title">${esc(s.name)}</div>
        <div class="sub">${esc(whenLabel(s.cron))} · ${esc(actionLabel(s.action))}${s.command ? ` <span class="mono">${esc(s.command)}</span>` : ''}${s.warnMinutes ? ` · ${s.warnMinutes} min warning` : ''}${s.onlyWhenEmpty ? ' · only when empty' : ''}</div>
      </div>
      <div class="hide-sm" style="text-align:right;font-size:12px">
        <div class="muted">${s.nextRun ? `Next ${fmtTime(s.nextRun)}` : 'Paused'}</div>
        <div class="${failed ? 'warning' : 'faint'}">${s.lastRun ? `Last ${fmtTime(s.lastRun)}: ${esc(s.lastResult || 'ok')}` : 'Not run yet'}</div>
      </div>
      <button class="btn btn-sm btn-ghost" data-run title="Run now">${icon('play', 11)}</button>
      <button class="btn btn-sm btn-ghost" data-edit title="Edit">${icon('edit', 13)}</button>
      <button class="btn btn-sm btn-ghost btn-danger" data-delete title="Delete">${icon('trash', 13)}</button>
    </div>`;
}

function openScheduleModal(server, schedule, onSaved) {
  const preset = schedule ? (PRESETS.some(([c]) => c === schedule.cron) ? schedule.cron : 'custom') : PRESETS[0][0];
  const modal = openModal({
    title: schedule ? 'Edit task' : 'New scheduled task',
    width: 500,
    body: `
      <label class="field"><span>What should happen</span>
        <select id="sch-action">${ACTIONS.map(
          ([id, label]) => `<option value="${id}" ${schedule?.action === id ? 'selected' : ''}>${label}</option>`
        ).join('')}</select>
      </label>
      <label class="field" id="sch-command-wrap"><span>Console command</span>
        <input id="sch-command" class="mono" value="${esc(schedule?.command || '')}" placeholder="say Restarting in 5 minutes" />
      </label>
      <label class="field" id="sch-warn-wrap"><span>Warn players first</span>
        <select id="sch-warn">${[0, 1, 5, 10, 15]
          .map((n) => `<option value="${n}" ${Number(schedule?.warnMinutes || 0) === n ? 'selected' : ''}>${n ? `${n} minute countdown in chat` : 'No warning'}</option>`)
          .join('')}</select>
        <div class="hint">Posts "Server restarting in 5 minutes", then 1 minute, 30 and 10 seconds. The restart happens when the countdown ends.</div>
      </label>
      <label class="field"><span>When</span>
        <select id="sch-preset">${PRESETS.map(([c, label]) => `<option value="${c}" ${preset === c ? 'selected' : ''}>${label}</option>`).join('')}</select>
      </label>
      <label class="field" id="sch-cron-wrap"><span>Cron expression</span>
        <input id="sch-cron" class="mono" value="${esc(schedule?.cron || '0 5 * * *')}" placeholder="minute hour day month weekday" />
        <div class="hint">Five fields: minute, hour, day of month, month, weekday. <span class="mono">30 3 * * 6</span> is every Saturday at 03:30.</div>
      </label>
      <label class="field"><span>Name</span>
        <input id="sch-name" value="${esc(schedule?.name || '')}" placeholder="Shown in the list and in alerts" />
      </label>
      <div class="checkbox-row"><input type="checkbox" id="sch-only-running" ${schedule?.onlyIfRunning === false ? '' : 'checked'} />
        <label for="sch-only-running">Skip it when the server is not running</label></div>
      <div class="checkbox-row" id="sch-empty-wrap"><input type="checkbox" id="sch-only-empty" ${schedule?.onlyWhenEmpty ? 'checked' : ''} />
        <label for="sch-only-empty">Skip it while players are online</label></div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: schedule ? 'Save' : 'Add task',
        primary: true,
        onClick: async (btn) => {
          const cron = $('#sch-preset').value === 'custom' ? $('#sch-cron').value.trim() : $('#sch-preset').value;
          const action = $('#sch-action').value;
          const body = {
            action,
            cron,
            command: $('#sch-command').value,
            name: $('#sch-name').value.trim() || ACTIONS.find(([a]) => a === action)[1],
            onlyIfRunning: $('#sch-only-running').checked,
            onlyWhenEmpty: $('#sch-only-empty').checked,
            warnMinutes: Number($('#sch-warn').value),
          };
          btn.disabled = true;
          try {
            if (schedule) await api(`/api/servers/${server.id}/schedules/${schedule.id}`, { method: 'PATCH', body });
            else await api(`/api/servers/${server.id}/schedules`, { method: 'POST', body });
            modal.close();
            toast(schedule ? 'Task saved' : 'Task added');
            onSaved();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });

  const sync = () => {
    $('#sch-command-wrap').classList.toggle('hidden', $('#sch-action').value !== 'command');
    $('#sch-warn-wrap').classList.toggle('hidden', !['restart', 'stop'].includes($('#sch-action').value));
    $('#sch-empty-wrap').classList.toggle('hidden', $('#sch-action').value === 'start');
    $('#sch-cron-wrap').classList.toggle('hidden', $('#sch-preset').value !== 'custom');
  };
  $('#sch-action').addEventListener('change', sync);
  $('#sch-preset').addEventListener('change', sync);
  sync();
}
