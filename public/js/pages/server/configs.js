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
  const editable = can('files.write');
  const curated = Boolean(form.plugin);

  // Nest the settings by their crumbs (the plugin's groups, or the file's own sections).
  const tree = { children: new Map(), fields: [], count: 0 };
  for (const f of form.fields) {
    let node = tree;
    node.count++;
    for (const name of f.crumbs || String(f.section || '').split(' › ').filter(Boolean)) {
      if (!node.children.has(name)) node.children.set(name, { name, children: new Map(), fields: [], count: 0 });
      node = node.children.get(name);
      node.count++;
    }
    node.fields.push(f);
  }
  const groupInfo = new Map((form.groups || []).map((g) => [g.name, g]));
  const big = form.fields.length > 60;
  const section = (node, depth) => {
    const info = depth === 0 ? groupInfo.get(node.name) : null;
    const open = info?.collapsed ? false : depth === 0 ? !big || curated : !big && node.count <= 40;
    return `
      <details class="cf-sec depth-${Math.min(depth, 3)}" ${open ? 'open' : ''}>
        <summary><span class="cf-chev"></span><span class="cf-sec-name">${esc(node.name)}</span><span class="cf-count faint">${node.count}</span><span class="cf-dirty hidden"></span></summary>
        ${info?.help ? `<p class="hint cf-sec-help">${esc(info.help)}</p>` : ''}
        ${node.fields.length ? `<div class="gs-list">${node.fields.map((f) => fieldRow(f, editable)).join('')}</div>` : ''}
        ${[...node.children.values()].map((c) => section(c, depth + 1)).join('')}
      </details>`;
  };
  const order = (form.groups || []).map((g) => g.name);
  const top = [...tree.children.values()].sort((a, b) => (order.indexOf(a.name) + 1 || 999) - (order.indexOf(b.name) + 1 || 999));
  const body = [tree.fields.length ? `<div class="gs-list">${tree.fields.map((f) => fieldRow(f, editable)).join('')}</div>` : '', ...top.map((n) => section(n, 0))].join('');

  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div>
          <h4 style="letter-spacing:0;text-transform:none">${esc(form.plugin?.title || rel)}</h4>
          ${form.plugin ? `<div class="faint mono" style="font-size:11px">${esc(rel)}</div>` : ''}
        </div>
        <div class="spacer"></div>
        <input class="search-input" id="cf-search" placeholder="Find a setting…" style="max-width:220px" />
      </div>
      ${form.plugin?.description ? `<p style="margin:0 0 8px">${esc(form.plugin.description)}</p>` : ''}
      <div class="cf-toolbar">
        <span class="faint" id="cf-summary">${form.fields.length} settings.</span>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" id="cf-expand">Expand all</button>
        <button class="btn btn-ghost btn-sm" id="cf-collapse">Collapse all</button>
        <a class="btn btn-ghost btn-sm" href="${filesLink}" title="Edit the raw file">Open as text</a>
      </div>
      <p class="faint" style="margin:0 0 6px">Only what you change is rewritten; comments and layout stay. Most plugins read this when the server starts or on their reload command.</p>
      <div id="cf-body">${body}</div>
      <div class="faint hidden" id="cf-none" style="padding:12px 0">No setting matches.</div>
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
    host.querySelectorAll('.cf-sec').forEach((sec) => {
      const n = sec.querySelectorAll('.gs-field.changed').length;
      const badge = sec.querySelector(':scope > summary .cf-dirty');
      badge.textContent = n ? `${n} changed` : '';
      badge.classList.toggle('hidden', !n);
    });
  };
  const listOf = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);

  host.querySelectorAll('[data-cf]').forEach((input) => {
    const field = fields.get(input.dataset.cf);
    const swatch = input.closest('.gs-control')?.querySelector('[data-swatch]');
    const read = () => (field.type === 'bool' ? input.checked : field.type === 'list' ? listOf(input.value) : input.value);
    input.addEventListener(field.type === 'bool' || field.type === 'select' ? 'change' : 'input', () => {
      const value = read();
      const same = field.type === 'list' ? JSON.stringify(value) === JSON.stringify(field.value) : String(value) === String(field.value);
      if (same) changes.delete(field.id);
      else changes.set(field.id, field.type === 'number' ? Number(value) : value);
      if (swatch && /^#[0-9a-f]{6}/i.test(value)) swatch.value = value.slice(0, 7);
      input.closest('.gs-field')?.classList.toggle('changed', changes.has(field.id));
      refresh();
    });
    if (swatch) {
      swatch.addEventListener('input', () => {
        input.value = swatch.value + (String(field.value).length === 9 ? input.value.slice(7) : '');
        input.dispatchEvent(new Event('input'));
      });
    }
  });

  const sections = [...host.querySelectorAll('.cf-sec')];
  host.querySelector('#cf-expand').addEventListener('click', () => sections.forEach((s) => (s.open = true)));
  host.querySelector('#cf-collapse').addEventListener('click', () => sections.forEach((s) => (s.open = false)));

  const summary = host.querySelector('#cf-summary');
  host.querySelector('#cf-search').addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase();
    let hits = 0;
    host.querySelectorAll('.gs-field').forEach((row) => {
      const hit = !term || row.dataset.find.includes(term);
      row.classList.toggle('hidden', !hit);
      if (hit) hits++;
    });
    // Deepest sections first, so a parent knows whether any child survived.
    [...sections].reverse().forEach((sec) => {
      const any = sec.querySelector('.gs-field:not(.hidden)');
      sec.classList.toggle('hidden', !any);
      if (term && any) sec.open = true;
    });
    host.querySelector('#cf-none').classList.toggle('hidden', hits > 0);
    summary.textContent = term ? `${hits} of ${form.fields.length} settings match.` : `${form.fields.length} settings.`;
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
  const find = esc(`${f.label} ${f.path.join(' ')} ${f.help || ''}`.toLowerCase());
  const off = editable ? '' : 'disabled';
  const id = esc(f.id);
  const unit = f.unit ? `<span class="gs-unit faint">${esc(f.unit)}</span>` : '';
  let control;
  if (f.type === 'bool') {
    control = `<label class="switch"><input type="checkbox" data-cf="${id}" ${f.value ? 'checked' : ''} ${off} /><i></i></label>`;
  } else if (f.type === 'select') {
    const opts = f.options.includes(String(f.value)) ? f.options : [String(f.value), ...f.options];
    control = `<select data-cf="${id}" ${off}>${opts.map((o) => `<option ${o === String(f.value) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (f.type === 'list') {
    control = `<textarea data-cf="${id}" rows="${Math.min(8, Math.max(2, f.value.length + 1))}" spellcheck="false" placeholder="One per line" ${off}>${esc(f.value.join('\n'))}</textarea>`;
  } else if (f.type === 'number') {
    control = `<div class="gs-with-unit"><input type="number" step="any" data-cf="${id}" value="${esc(f.value)}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${off} />${unit}</div>`;
  } else if (f.color) {
    control = `<div class="gs-with-unit"><input type="color" data-swatch value="${esc(String(f.value).slice(0, 7))}" ${off} /><input type="text" data-cf="${id}" value="${esc(f.value)}" spellcheck="false" ${off} /></div>`;
  } else if (f.multiline) {
    control = `<textarea data-cf="${id}" rows="3" spellcheck="false" ${off}>${esc(f.value)}</textarea>`;
  } else {
    const secret = /pass(word)?|secret|token|api[-_ ]?key/i.test(f.path[f.path.length - 1]);
    control = `<div class="gs-with-unit"><input type="${secret ? 'password' : 'text'}" data-cf="${id}" value="${esc(f.value)}" spellcheck="false" autocomplete="off" ${off} />${unit}</div>`;
  }
  const range = f.min !== undefined || f.max !== undefined ? ` (${f.min ?? '…'} to ${f.max ?? '…'})` : '';
  const key = f.path[f.path.length - 1];
  return `
    <div class="gs-field ${f.type === 'bool' ? 'is-bool' : ''} ${f.type === 'list' || f.multiline ? 'is-list' : ''}" data-find="${find}">
      <div class="gs-text">
        <div class="gs-label">${esc(f.label)}${!key.toLowerCase().startsWith(f.label.toLowerCase()) ? ` <span class="gs-key mono">${esc(key)}</span>` : ''}</div>
        ${f.help || range ? `<div class="hint" style="margin:2px 0 0">${esc((f.help || '') + range)}</div>` : ''}
      </div>
      <div class="gs-control">${control}</div>
    </div>`;
}
