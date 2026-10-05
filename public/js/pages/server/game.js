import { api } from '../../core/api.js';
import { esc, toast } from '../../core/util.js';
import { renderVersionCard } from './version.js';
import { renderAppearance } from './appearance.js';
import { renderWorldsCard } from './worlds.js';
import { renderCrossplayCard } from './crossplay.js';

/* ---------------------------------------------------- game settings tab */

/*
 * The game's own config file (server.properties, servertest.ini…) as a form.
 * Only changed keys are sent, so values the form does not understand are
 * never rewritten.
 */

export async function renderGameTab(root, server) {
  root.innerHTML = '<div id="gv-card"></div><div id="gc-card"></div><div id="gw-card"></div><div id="gs-body"></div>';
  renderVersionCard(root.querySelector('#gv-card'), server);
  renderCrossplayCard(root.querySelector('#gc-card'), server);
  renderWorldsCard(root.querySelector('#gw-card'), server);
  const host = root.querySelector('#gs-body');
  host.innerHTML = '<div class="card"><span class="spinner"></span> Reading the game\'s settings…</div>';
  let data;
  try {
    data = await api(`/api/servers/${server.id}/game-settings`);
  } catch (err) {
    host.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  if (!data.supported) {
    host.innerHTML = '<div class="card faint">This game keeps its settings in a format the panel cannot show as a form yet. Edit them on the Files tab.</div>';
    return;
  }
  if (data.missing || data.error) {
    host.innerHTML = `<div class="card faint">${
      data.error ? esc(data.error) : `<span class="mono">${esc(data.file)}</span> does not exist yet. Install or start the server once and it will appear here.`
    }</div>`;
    return;
  }

  const fields = new Map(data.groups.flatMap((g) => g.fields).map((f) => [f.key, f]));
  const changes = new Map();

  host.innerHTML = `
    <div class="row mb-16" style="justify-content:space-between">
      <span class="faint">From <span class="mono">${esc(data.file)}</span>. Changes apply the next time the server starts.</span>
      <input class="search-input" id="gs-search" placeholder="Find a setting…" style="max-width:240px" />
    </div>
    <div id="gs-warning"></div>
    <div id="gs-appearance"></div>
    ${data.groups.map(groupCard).join('')}
    <div class="save-bar hidden" id="gs-bar">
      <span id="gs-count"></span>
      <div class="spacer"></div>
      <button class="btn btn-ghost" id="gs-discard">Discard</button>
      <button class="btn btn-primary" id="gs-save">Save</button>
    </div>`;

  const java = String(server.templateId || '').startsWith('minecraft') && server.templateId !== 'minecraft-bedrock';
  if (java && fields.has('motd')) {
    renderAppearance(host.querySelector('#gs-appearance'), server, fields);
    // Edited in the preview card above instead.
    host.querySelector('[data-gs="motd"]')?.closest('.gs-field')?.remove();
  }

  const bar = host.querySelector('#gs-bar');
  const refresh = () => {
    bar.classList.toggle('hidden', changes.size === 0);
    host.querySelector('#gs-count').textContent = `${changes.size} unsaved change${changes.size === 1 ? '' : 's'}`;
    renderWarnings();
  };

  // Field-specific warnings (offline mode) follow the value on screen, not the saved one.
  function renderWarnings() {
    const notes = [...fields.values()]
      .filter((f) => f.warning && (changes.has(f.key) ? changes.get(f.key) : f.value) === f.warnWhen)
      .map((f) => `<div class="card warn-card mb-16"><b>${esc(f.label)} is off.</b> ${esc(f.warning)}</div>`);
    host.querySelector('#gs-warning').innerHTML = notes.join('');
  }
  renderWarnings();

  host.querySelectorAll('[data-gs]').forEach((input) => {
    const field = fields.get(input.dataset.gs);
    const read = () => (field.type === 'bool' ? input.checked : input.value);
    input.addEventListener(field.type === 'bool' || field.type === 'select' ? 'change' : 'input', () => {
      const value = read();
      if (String(value) === String(field.value)) changes.delete(field.key);
      else changes.set(field.key, value);
      input.closest('.gs-field')?.classList.toggle('changed', changes.has(field.key));
      refresh();
    });
  });

  host.querySelectorAll('[data-reveal]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
    })
  );

  host.querySelector('#gs-search').addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase();
    host.querySelectorAll('.gs-group').forEach((card) => {
      let any = false;
      card.querySelectorAll('.gs-field').forEach((row) => {
        const hit = !term || row.dataset.find.includes(term);
        row.classList.toggle('hidden', !hit);
        any = any || hit;
      });
      card.classList.toggle('hidden', !any);
    });
  });

  host.querySelector('#gs-discard').addEventListener('click', () => renderGameTab(root, server));
  host.querySelector('#gs-save').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      const result = await api(`/api/servers/${server.id}/game-settings`, { method: 'PUT', body: { values: Object.fromEntries(changes) } });
      if (result.restartNeeded) {
        toast('Saved. Restart the server to apply.', 'info', 7000);
        await renderGameTab(root, server);
        host.querySelector('.row')?.insertAdjacentHTML(
          'afterend',
          `<div class="card mb-16 row" style="justify-content:space-between"><span>Saved. The server is running the old settings until it restarts.</span><button class="btn btn-primary btn-sm" data-power="restart" data-id="${esc(server.id)}">Restart now</button></div>`
        );
      } else {
        toast('Game settings saved');
        renderGameTab(root, server);
      }
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

function groupCard(group) {
  return `
    <div class="card mb-16 gs-group">
      <h4 style="margin:0 0 6px">${esc(group.title)}</h4>
      ${group.managedGroup ? '<p class="faint" style="margin:0 0 8px">The panel writes these before every start. Change ports on the Settings tab.</p>' : ''}
      <div class="gs-list">${group.fields.map(fieldRow).join('')}</div>
    </div>`;
}

function fieldRow(f) {
  const find = esc(`${f.label} ${f.key}`.toLowerCase());
  const disabled = f.managed ? 'disabled' : '';
  let control;
  if (f.type === 'bool') {
    control = `<label class="switch"><input type="checkbox" data-gs="${esc(f.key)}" ${f.value ? 'checked' : ''} ${disabled} /><i></i></label>`;
  } else if (f.type === 'select') {
    const opts = f.options.map((o) => (typeof o === 'object' ? o : { value: o, label: o[0].toUpperCase() + o.slice(1) }));
    // Keep a value the list does not know (older versions, modded servers) selectable.
    if (!opts.some((o) => String(o.value) === f.value)) opts.unshift({ value: f.value, label: f.value || '(not set)' });
    control = `<select data-gs="${esc(f.key)}" ${disabled}>${opts
      .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === f.value ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select>`;
  } else if (f.secret && !f.managed) {
    control = `<div class="input-row"><input type="password" data-gs="${esc(f.key)}" value="${esc(f.value)}" autocomplete="off" /><button class="btn" type="button" data-reveal>Show</button></div>`;
  } else {
    const attrs = f.type === 'number' ? `type="number" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}` : 'type="text"';
    control = `<input ${attrs} data-gs="${esc(f.key)}" value="${esc(f.value)}" ${disabled} spellcheck="false" />`;
  }
  return `
    <div class="gs-field ${f.type === 'bool' ? 'is-bool' : ''}" data-find="${find}">
      <div class="gs-text">
        <div class="gs-label">${esc(f.label)} <span class="gs-key mono">${esc(f.key)}</span></div>
        ${f.description ? `<div class="hint" style="margin:2px 0 0">${esc(f.description)}</div>` : ''}
      </div>
      <div class="gs-control">${control}</div>
    </div>`;
}
