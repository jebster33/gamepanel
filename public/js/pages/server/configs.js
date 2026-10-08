import { api } from '../../core/api.js';
import { can, esc, fmtBytes, toast } from '../../core/util.js';
import { skeleton } from '../../ui/skeleton.js';

/* ------------------------------------------------------------ configs tab */

/*
 * Plugin and mod config files (plugins/Essentials/config.yml,
 * config/create-common.toml…) as forms. The server rewrites only the values
 * that changed, so comments and layout in the file stay as they were.
 */

let lastPath = {}; // per server: the file open last, so coming back lands there

export async function renderConfigsTab(root, server) {
  root.innerHTML = skeleton('list', 'Looking for config files…');
  let files;
  try {
    ({ files } = await api(`/api/servers/${server.id}/configs`));
  } catch (err) {
    root.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  if (!root.isConnected) return;
  if (!files.length) {
    root.innerHTML = `<div class="card faint">No plugin or mod config files yet. Plugins and mods write theirs the first time the server starts with them; they show up here after that.</div>`;
    return;
  }

  const groups = new Map();
  for (const f of files) groups.set(f.group, [...(groups.get(f.group) || []), f]);
  root.innerHTML = `
    <div class="cfg-layout">
      <div class="card cfg-files">
        <input class="search-input" id="cfg-find" placeholder="Find a file…" style="max-width:none;margin:0 0 10px" />
        <div id="cfg-list">
          ${[...groups]
            .map(
              ([group, list]) => `
            <div class="cfg-group" data-group="${esc(group.toLowerCase())}">
              <div class="cfg-group-name">${esc(group)}</div>
              ${list
                .map(
                  (f) => `<button class="cfg-file" data-path="${esc(f.path)}" data-find="${esc(`${group} ${f.path}`.toLowerCase())}" title="${esc(f.path)}">
                    <span class="grow">${esc(f.name)}</span><span class="faint">${fmtBytes(f.size)}</span></button>`
                )
                .join('')}
            </div>`
            )
            .join('')}
        </div>
      </div>
      <div id="cfg-form"></div>
    </div>`;

  const open = (rel) => {
    lastPath[server.id] = rel;
    root.querySelectorAll('.cfg-file').forEach((b) => b.classList.toggle('active', b.dataset.path === rel));
    renderForm(root.querySelector('#cfg-form'), server, rel);
  };
  root.querySelectorAll('.cfg-file').forEach((b) => b.addEventListener('click', () => open(b.dataset.path)));
  root.querySelector('#cfg-find').addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase();
    root.querySelectorAll('.cfg-group').forEach((g) => {
      let any = false;
      g.querySelectorAll('.cfg-file').forEach((b) => {
        const hit = !term || b.dataset.find.includes(term);
        b.classList.toggle('hidden', !hit);
        any ||= hit;
      });
      g.classList.toggle('hidden', !any);
    });
  });
  const first = files.find((f) => f.path === lastPath[server.id]) || files.find((f) => f.group !== 'Server') || files[0];
  open(first.path);
}

async function renderForm(host, server, rel) {
  host.innerHTML = skeleton('card');
  let form;
  try {
    form = await api(`/api/servers/${server.id}/configs/form?path=${encodeURIComponent(rel)}`);
  } catch (err) {
    host.innerHTML = `<div class="card faint">${esc(err.message)}</div>`;
    return;
  }
  if (!host.isConnected) return;
  const filesLink = `#/servers/${server.id}/files`;
  if (form.error || !form.fields.length) {
    host.innerHTML = `<div class="card faint">${esc(form.error || 'Nothing in this file can be shown as a form.')} <a href="${filesLink}">Edit it as text on the Files tab</a>.</div>`;
    return;
  }

  const fields = new Map(form.fields.map((f) => [f.id, f]));
  const changes = new Map();
  const sections = new Map();
  for (const f of form.fields) sections.set(f.section, [...(sections.get(f.section) || []), f]);
  const editable = can('files.write');

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h4 class="mono" style="letter-spacing:0;text-transform:none">${esc(rel)}</h4>
        <div class="spacer"></div>
        <input class="search-input" id="cf-search" placeholder="Find a setting…" style="max-width:200px" />
      </div>
      <p class="faint" style="margin:0 0 6px">${form.fields.length} settings. Only what you change is rewritten; comments stay. Most plugins read this when the server starts or on their reload command. <a href="${filesLink}">Open as text</a></p>
      ${[...sections]
        .map(
          ([section, list]) => `
        <div class="cf-section">
          ${section ? `<div class="cfg-group-name">${esc(section)}</div>` : ''}
          <div class="gs-list">${list.map((f) => fieldRow(f, editable)).join('')}</div>
        </div>`
        )
        .join('')}
    </div>
    <div class="save-bar hidden" id="cf-bar">
      <span id="cf-count"></span>
      <div class="spacer"></div>
      <button class="btn btn-ghost" id="cf-discard">Discard</button>
      <button class="btn btn-primary" id="cf-save">Save</button>
    </div>`;

  const bar = host.querySelector('#cf-bar');
  const refresh = () => {
    bar.classList.toggle('hidden', changes.size === 0);
    host.querySelector('#cf-count').textContent = `${changes.size} unsaved change${changes.size === 1 ? '' : 's'}`;
  };
  const listOf = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);

  host.querySelectorAll('[data-cf]').forEach((input) => {
    const field = fields.get(input.dataset.cf);
    const read = () => (field.type === 'bool' ? input.checked : field.type === 'list' ? listOf(input.value) : input.value);
    input.addEventListener(field.type === 'bool' || field.type === 'select' ? 'change' : 'input', () => {
      const value = read();
      const same = field.type === 'list' ? JSON.stringify(value) === JSON.stringify(field.value) : String(value) === String(field.value);
      if (same) changes.delete(field.id);
      else changes.set(field.id, field.type === 'number' ? Number(value) : value);
      input.closest('.gs-field')?.classList.toggle('changed', changes.has(field.id));
      refresh();
    });
  });

  host.querySelector('#cf-search').addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase();
    host.querySelectorAll('.cf-section').forEach((sec) => {
      let any = false;
      sec.querySelectorAll('.gs-field').forEach((row) => {
        const hit = !term || row.dataset.find.includes(term);
        row.classList.toggle('hidden', !hit);
        any ||= hit;
      });
      sec.classList.toggle('hidden', !any);
    });
  });

  host.querySelector('#cf-discard').addEventListener('click', () => renderForm(host, server, rel));
  host.querySelector('#cf-save').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      await api(`/api/servers/${server.id}/configs/form?path=${encodeURIComponent(rel)}`, { method: 'PUT', body: { version: form.version, changes: Object.fromEntries(changes) } });
      toast(server.status === 'running' ? 'Saved. Reload the plugin or restart the server to apply it.' : 'Saved', 'info', 6000);
      renderForm(host, server, rel);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

function fieldRow(f, editable) {
  const find = esc(`${f.label} ${f.path.join('.')} ${f.help || ''}`.toLowerCase());
  const off = editable ? '' : 'disabled';
  const id = esc(f.id);
  let control;
  if (f.type === 'bool') {
    control = `<label class="switch"><input type="checkbox" data-cf="${id}" ${f.value ? 'checked' : ''} ${off} /><i></i></label>`;
  } else if (f.type === 'select') {
    const opts = f.options.includes(String(f.value)) ? f.options : [String(f.value), ...f.options];
    control = `<select data-cf="${id}" ${off}>${opts.map((o) => `<option ${o === String(f.value) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (f.type === 'list') {
    control = `<textarea data-cf="${id}" rows="${Math.min(8, Math.max(2, f.value.length + 1))}" spellcheck="false" placeholder="One per line" ${off}>${esc(f.value.join('\n'))}</textarea>`;
  } else if (f.type === 'number') {
    control = `<input type="number" step="any" data-cf="${id}" value="${esc(f.value)}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${off} />`;
  } else {
    const secret = /pass(word)?|secret|token|api[-_]?key/i.test(f.path[f.path.length - 1]);
    control = `<input type="${secret ? 'password' : 'text'}" data-cf="${id}" value="${esc(f.value)}" spellcheck="false" autocomplete="off" ${off} />`;
  }
  const range = f.min !== undefined || f.max !== undefined ? ` (${f.min ?? '…'} to ${f.max ?? '…'})` : '';
  return `
    <div class="gs-field ${f.type === 'bool' ? 'is-bool' : ''} ${f.type === 'list' ? 'is-list' : ''}" data-find="${find}">
      <div class="gs-text">
        <div class="gs-label">${esc(f.label)} <span class="gs-key mono">${esc(f.path[f.path.length - 1])}</span></div>
        ${f.help || range ? `<div class="hint" style="margin:2px 0 0">${esc((f.help || '') + range)}</div>` : ''}
      </div>
      <div class="gs-control">${control}</div>
    </div>`;
}
