import { setCrumbs } from '../core/router.js';
import { state } from '../core/state.js';
import { api } from '../core/api.js';
import { esc, icon, toast } from '../core/util.js';
import { loadTemplates } from '../core/boot.js';
import { confirmModal, openModal } from '../ui/modal.js';

/* ------------------------------------------------------- template builder */

/*
 * Add a game the panel does not ship, without writing JSON: what to
 * download or install, how to start and stop it, its ports and the settings
 * people fill in when they create a server. The result is an ordinary
 * template file in <data>/templates. Anything the form does not cover can be
 * edited as JSON in the same place.
 */

const STEPS = {
  steamcmd: { label: 'Install from Steam (SteamCMD)', fields: [['appid', 'Steam app id', 'e.g. 896660, from steamdb.info'], ['branch', 'Branch (optional)', 'public']] },
  download: { label: 'Download a file', fields: [['url', 'Address', 'https://…'], ['dest', 'Save as', 'server.zip']] },
  extract: { label: 'Unpack a zip or tar', fields: [['file', 'File', 'server.zip'], ['dest', 'Into folder', '.']], flags: [['deleteArchive', 'Delete the archive afterwards']] },
  run: { label: 'Run a command', fields: [['command', 'Command', './install.sh']] },
  writefile: { label: 'Write a file', fields: [['path', 'File', 'config.ini']], text: ['content', 'Contents (can use {{SETTINGS}})'] },
  chmod: { label: 'Make a file executable', fields: [['path', 'File', './server']] },
  mkdir: { label: 'Make a folder', fields: [['path', 'Folder', 'saves']] },
  java: { label: 'Install Java', fields: [['version', 'Java version', '21']] },
  apt: { label: 'Install Linux packages', fields: [['packages', 'Packages (space separated)', 'unzip libsdl2-2.0-0']] },
  copy: { label: 'Copy a file or folder', fields: [['from', 'From', 'defaults/config.ini'], ['to', 'To', 'config.ini']] },
  remove: { label: 'Delete a file or folder', fields: [['path', 'Path', 'server.zip']] },
  script: { label: 'Shell script', text: ['run', 'Script (bash)'] },
};

const STARTERS = {
  blank: () => ({ id: '', name: '', category: 'Other', icon: '🎮', description: '', defaultMemory: 2048, platforms: ['linux'], ports: [{ name: 'game', default: 27015, protocol: 'udp' }], variables: [], install: [], startCommand: '', stopSignal: 'SIGINT', stopTimeout: 30, logPatterns: {} }),
  steam: () => ({
    ...STARTERS.blank(),
    install: [{ type: 'steamcmd', appid: '', branch: '' }],
    startCommand: './server_binary -port {{PORT}}',
    query: { type: 'a2s', port: 'query' },
    ports: [
      { name: 'game', default: 27015, protocol: 'udp' },
      { name: 'query', default: 27016, protocol: 'udp' },
    ],
  }),
  zip: () => ({
    ...STARTERS.blank(),
    install: [
      { type: 'download', url: '', dest: 'server.zip' },
      { type: 'extract', file: 'server.zip', dest: '.', deleteArchive: true },
      { type: 'chmod', path: './server' },
    ],
    startCommand: './server --port {{PORT}}',
    ports: [{ name: 'game', default: 7777, protocol: 'tcp' }],
    query: { type: 'tcp', port: 'game' },
  }),
};

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export async function renderTemplateBuilder(view) {
  const { mode, id } = state.route.params;
  setCrumbs('Games', mode === 'edit' ? 'Edit game' : 'Build a game');
  if (state.user.role !== 'admin') {
    view.innerHTML = '<div class="card">Only administrators can add games.</div>';
    return;
  }
  let t;
  let replace = null;
  let idTouched = false;
  if (mode === 'edit' && id) {
    try {
      const r = await api(`/api/templates/${encodeURIComponent(id)}/source`);
      t = r.template;
      if (r.custom) replace = t.id;
      else {
        // A built-in game as the start of a new one.
        t = { ...t, id: `${t.id}-custom`, name: `${t.name} (custom)` };
        idTouched = true;
      }
    } catch (err) {
      view.innerHTML = `<div class="card">${esc(err.message)}</div>`;
      return;
    }
  } else t = STARTERS.blank();
  t.ports ||= [];
  t.variables ||= [];
  t.install ||= [];
  t.logPatterns ||= {};
  t.platforms ||= ['linux'];
  if (replace) idTouched = true;

  const categories = [...new Set(state.templates.map((x) => x.category || 'Other'))].sort();

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${replace ? `Edit ${esc(t.name)}` : 'Build a game'}</h1><div class="lede">Tell the panel how to install and run a game it does not know yet. It shows up under Games for everyone who may create servers.</div></div>
      <div class="spacer"></div>
      <a class="btn btn-ghost" href="#/templates">Cancel</a>
    </div>
    ${
      replace
        ? ''
        : `<div class="card mb-16"><div class="row" style="gap:10px;flex-wrap:wrap"><b>Start from</b>
        <select id="tb-start" style="width:auto;flex:1;min-width:200px">
          <option value="blank">Nothing</option>
          <option value="steam">A game on Steam (SteamCMD)</option>
          <option value="zip">A server you download as a zip</option>
          <optgroup label="A copy of">${state.templates.map((x) => `<option value="copy:${esc(x.id)}" ${x.id === id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>
        </select></div></div>`
    }
    <div id="tb-form"></div>
    <div class="card mb-16" id="tb-result" hidden></div>
    <div class="row tb-actions" style="gap:8px;flex-wrap:wrap">
      ${replace ? '<button class="btn btn-ghost btn-danger" id="tb-delete">Delete this game</button>' : ''}
      <div class="spacer"></div>
      <button class="btn" id="tb-json">Edit as JSON</button>
      <button class="btn" id="tb-check">Check</button>
      <button class="btn btn-primary" id="tb-save">${replace ? 'Save changes' : 'Add game'}</button>
    </div>`;

  const form = view.querySelector('#tb-form');
  const draw = () => {
    form.innerHTML = formHtml(t, categories);
    wire();
  };

  // Keeps t in step with every input; data-k is a path like "ports.0.default".
  const setPath = (path, value) => {
    const keys = path.split('.');
    let obj = t;
    for (const k of keys.slice(0, -1)) obj = obj[k] ??= {};
    obj[keys.at(-1)] = value;
  };

  function wire() {
    form.querySelectorAll('[data-k]').forEach((el) =>
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
        let value = el.type === 'checkbox' ? el.checked : el.value;
        if (el.dataset.num !== undefined) value = value === '' ? '' : Number(value);
        if (el.dataset.list !== undefined) value = String(value).split(/[\s,]+/).filter(Boolean);
        setPath(el.dataset.k, value);
        if (el.dataset.k === 'name' && !idTouched) {
          t.id = slug(t.name);
          form.querySelector('[data-k="id"]').value = t.id;
        }
        if (el.dataset.k === 'id') idTouched = true;
        if (el.dataset.redraw !== undefined) draw();
      })
    );
    form.querySelectorAll('[data-platform]').forEach((el) =>
      el.addEventListener('change', () => {
        const set = new Set(t.platforms);
        el.checked ? set.add(el.dataset.platform) : set.delete(el.dataset.platform);
        t.platforms = ['linux', 'windows'].filter((p) => set.has(p));
        if (set.has('windows')) t.windows ||= {};
        draw();
      })
    );
    form.querySelectorAll('[data-add]').forEach((el) =>
      el.addEventListener('click', () => {
        const what = el.dataset.add;
        if (what === 'port') t.ports.push({ name: t.ports.length ? `port${t.ports.length + 1}` : 'game', default: (t.ports.at(-1)?.default || 27014) + 1, protocol: 'udp' });
        if (what === 'var') t.variables.push({ name: '', label: '', default: '' });
        if (what === 'step') t.install.push({ type: form.querySelector('#tb-step-type').value });
        draw();
      })
    );
    form.querySelectorAll('[data-del]').forEach((el) =>
      el.addEventListener('click', () => {
        const [list, i] = el.dataset.del.split('.');
        t[list].splice(Number(i), 1);
        draw();
      })
    );
    form.querySelectorAll('[data-move]').forEach((el) =>
      el.addEventListener('click', () => {
        const [i, dir] = el.dataset.move.split(':').map(Number);
        const j = i + dir;
        if (j < 0 || j >= t.install.length) return;
        [t.install[i], t.install[j]] = [t.install[j], t.install[i]];
        draw();
      })
    );
    form.querySelector('#tb-stop-kind')?.addEventListener('change', (e) => {
      if (e.target.value === 'command') {
        t.stopCommand = t.stopCommand || 'stop';
        delete t.stopSignal;
      } else {
        delete t.stopCommand;
        t.stopSignal = 'SIGINT';
      }
      draw();
    });
    form.querySelector('#tb-query-type')?.addEventListener('change', (e) => {
      if (e.target.value === 'none') delete t.query;
      else t.query = { type: e.target.value, port: t.query?.port || t.ports[0]?.name || 'game' };
      draw();
    });
  }

  view.querySelector('#tb-start')?.addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v.startsWith('copy:')) {
      const r = await api(`/api/templates/${encodeURIComponent(v.slice(5))}/source`).catch((err) => toast(err.message, 'error'));
      if (!r) return;
      t = { ...r.template, id: `${r.template.id}-custom`, name: `${r.template.name} (custom)` };
    } else t = STARTERS[v]();
    t.ports ||= [];
    t.variables ||= [];
    t.install ||= [];
    t.logPatterns ||= {};
    t.platforms ||= ['linux'];
    idTouched = v.startsWith('copy:');
    draw();
  });

  const result = view.querySelector('#tb-result');
  async function check() {
    const r = await api('/api/templates/check', { method: 'POST', body: { template: t } });
    result.hidden = false;
    result.innerHTML = `
      ${r.errors.length ? `<div class="mb-8"><b style="color:var(--danger)">Fix these first</b><ul class="tb-msgs">${r.errors.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : `<div class="filter-note mb-8">${icon('check', 12)} Ready to add.</div>`}
      ${r.warnings.length ? `<div class="mb-8"><b>Worth a look</b><ul class="tb-msgs">${r.warnings.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
      ${r.script ? `<details><summary style="cursor:pointer">What the install runs (with example values)</summary><pre class="code-block mt-8">${esc(r.script)}</pre></details>` : ''}`;
    return r;
  }

  view.querySelector('#tb-check').addEventListener('click', () => check().catch((err) => toast(err.message, 'error')));
  view.querySelector('#tb-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await check();
      if (r.errors.length) {
        result.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      await api('/api/templates', { method: 'POST', body: { template: t, replace } });
      await loadTemplates();
      toast(`${t.name} ${replace ? 'saved' : 'added. Find it under Games.'}`);
      location.hash = '#/templates';
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  view.querySelector('#tb-delete')?.addEventListener('click', async () => {
    if (!(await confirmModal('Delete game', `Delete ${esc(t.name)}? Servers already made with it keep running, but cannot be reinstalled until it is back.`, 'Delete'))) return;
    try {
      await api(`/api/templates/${encodeURIComponent(replace)}`, { method: 'DELETE' });
      await loadTemplates();
      toast('Deleted');
      location.hash = '#/templates';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  view.querySelector('#tb-json').addEventListener('click', () => {
    const modal = openModal({
      title: 'Edit as JSON',
      width: 760,
      body: `<p class="faint" style="margin-top:0">The whole template. Paste one from elsewhere, or add fields the form does not show.</p><textarea id="tb-json-text" class="mono" rows="22" spellcheck="false">${esc(JSON.stringify(t, null, 2))}</textarea>`,
      actions: [
        { label: 'Cancel', close: true },
        {
          label: 'Use this',
          primary: true,
          onClick: () => {
            try {
              const next = JSON.parse(document.querySelector('#tb-json-text').value);
              if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('A template is a JSON object');
              t = next;
              t.ports ||= [];
              t.variables ||= [];
              t.install ||= [];
              t.logPatterns ||= {};
              t.platforms ||= ['linux'];
              idTouched = true;
              modal.close();
              draw();
            } catch (err) {
              toast(`That is not valid JSON: ${err.message}`, 'error');
            }
          },
        },
      ],
    });
  });

  draw();
}

/* ------------------------------------------------------------- the form -- */

const field = (label, key, value, { placeholder = '', num = false, hint = '', type = 'text', attrs = '' } = {}) => `
  <label class="field"><span>${esc(label)}</span>
    <input type="${type}" data-k="${esc(key)}" ${num ? 'data-num' : ''} value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" ${attrs} />
    ${hint ? `<div class="hint">${hint}</div>` : ''}
  </label>`;

function formHtml(t, categories) {
  const portNames = t.ports.map((p) => p.name).filter(Boolean);
  const stopKind = t.stopCommand !== undefined && t.stopCommand !== null ? 'command' : 'signal';
  const placeholders = ['{{PORT}}', ...portNames.filter((n) => n !== 'game').map((n) => `{{PORT_${n.toUpperCase()}}}`), '{{MEMORY}}', '{{SERVER_NAME}}', '{{MAX_PLAYERS}}', ...t.variables.filter((v) => v.name).map((v) => `{{${v.name}}}`)];
  return `
    <div class="card mb-16">
      <h4 class="mb-8">The game</h4>
      <div class="form-grid">
        ${field('Name', 'name', t.name, { placeholder: 'My Game' })}
        ${field('Id', 'id', t.id, { placeholder: 'my-game', hint: 'Lowercase, used in file and folder names. Cannot change after servers use it.' })}
        <label class="field"><span>Category</span><input data-k="category" list="tb-cats" value="${esc(t.category || '')}" /><datalist id="tb-cats">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
        ${field('Icon (an emoji)', 'icon', t.icon, { placeholder: '🎮', attrs: 'maxlength="8"' })}
        ${field('Memory it needs (MB)', 'defaultMemory', t.defaultMemory, { num: true, type: 'number', attrs: 'min="128" step="256"' })}
      </div>
      <label class="field"><span>Description</span><textarea data-k="description" rows="2" placeholder="One or two lines shown on the Games page">${esc(t.description || '')}</textarea></label>
      <div class="field-label">Runs on</div>
      <div class="row" style="gap:16px">
        <label class="checkbox-row" style="margin:0"><input type="checkbox" data-platform="linux" ${t.platforms.includes('linux') ? 'checked' : ''} /> Linux</label>
        <label class="checkbox-row" style="margin:0"><input type="checkbox" data-platform="windows" ${t.platforms.includes('windows') ? 'checked' : ''} /> Windows</label>
      </div>
    </div>

    <div class="card mb-16">
      <div class="card-head"><h4>Ports</h4><div class="spacer"></div><button class="btn btn-sm" data-add="port">Add a port</button></div>
      <div class="hint mb-8">The panel gives every server its own free ports, starting from these. "game" is the one players connect to.</div>
      ${t.ports
        .map(
          (p, i) => `<div class="tb-row">
            <input data-k="ports.${i}.name" value="${esc(p.name)}" placeholder="game" aria-label="Port name" data-redraw />
            <input data-k="ports.${i}.default" data-num type="number" min="1" max="65535" value="${esc(p.default)}" aria-label="Default port" />
            <select data-k="ports.${i}.protocol" aria-label="Protocol">${['udp', 'tcp', 'both'].map((x) => `<option ${p.protocol === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
            <button class="btn btn-sm btn-ghost btn-danger" data-del="ports.${i}" title="Remove">${icon('trash', 13)}</button>
          </div>`
        )
        .join('')}
    </div>

    <div class="card mb-16">
      <div class="card-head"><h4>Settings</h4><div class="spacer"></div><button class="btn btn-sm" data-add="var">Add a setting</button></div>
      <div class="hint mb-8">Asked when someone creates a server (a world name, a password…). Use them anywhere below as {{NAME}}.</div>
      ${
        t.variables.length
          ? t.variables
              .map(
                (v, i) => `<div class="tb-row tb-var">
            <input data-k="variables.${i}.name" value="${esc(v.name)}" placeholder="WORLD_NAME" aria-label="Name" class="mono" data-redraw />
            <input data-k="variables.${i}.label" value="${esc(v.label || '')}" placeholder="World name" aria-label="Label" />
            <input data-k="variables.${i}.default" value="${esc(v.default ?? '')}" placeholder="Default" aria-label="Default" />
            <button class="btn btn-sm btn-ghost btn-danger" data-del="variables.${i}" title="Remove">${icon('trash', 13)}</button>
          </div>`
              )
              .join('')
          : '<p class="faint" style="margin:0">None yet.</p>'
      }
    </div>

    <div class="card mb-16">
      <div class="card-head" style="flex-wrap:wrap"><h4>Install</h4><div class="spacer"></div>
        <select id="tb-step-type" style="width:auto">${Object.entries(STEPS).map(([k, s]) => `<option value="${k}">${esc(s.label)}</option>`).join('')}</select>
        <button class="btn btn-sm" data-add="step">Add step</button>
      </div>
      <div class="hint mb-8">Run in order inside the server's folder, on install and on reinstall.${t.platforms.includes('windows') ? ' Windows uses the same steps unless the JSON has its own.' : ''}</div>
      ${t.install.length ? t.install.map((s, i) => stepHtml(s, i, t.install.length)).join('') : '<p class="faint" style="margin:0">No steps: the server folder starts empty.</p>'}
    </div>

    <div class="card mb-16">
      <h4 class="mb-8">Starting and stopping</h4>
      <label class="field"><span>Start command</span><input class="mono" data-k="startCommand" value="${esc(t.startCommand || '')}" placeholder="./server -port {{PORT}}" /></label>
      ${t.platforms.includes('windows') ? `<label class="field"><span>Start command on Windows</span><input class="mono" data-k="windows.startCommand" value="${esc(t.windows?.startCommand || '')}" placeholder="server.exe -port {{PORT}}" /></label>` : ''}
      <div class="hint mb-16">You can use ${placeholders.map((p) => `<span class="mono">${esc(p)}</span>`).join(' ')}</div>
      <div class="form-grid">
        <label class="field"><span>How it stops</span><select id="tb-stop-kind"><option value="signal" ${stopKind === 'signal' ? 'selected' : ''}>Send a signal (Ctrl+C)</option><option value="command" ${stopKind === 'command' ? 'selected' : ''}>Type a console command</option></select></label>
        ${
          stopKind === 'command'
            ? field('Console command', 'stopCommand', t.stopCommand, { placeholder: 'stop' })
            : `<label class="field"><span>Signal</span><select data-k="stopSignal">${['SIGINT', 'SIGTERM', 'SIGQUIT'].map((x) => `<option ${t.stopSignal === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`
        }
        ${field('Seconds to wait before forcing it', 'stopTimeout', t.stopTimeout ?? 30, { num: true, type: 'number', attrs: 'min="5" max="600"' })}
      </div>
      <div class="form-grid">
        ${field('Line it prints when it is ready', 'logPatterns.ready', t.logPatterns.ready, { placeholder: 'Server started', hint: 'Part of the console line, or a regular expression.' })}
        <label class="field"><span>Status check</span><select id="tb-query-type">${[
          ['none', 'None'],
          ['a2s', 'Steam (A2S)'],
          ['minecraft', 'Minecraft'],
          ['tcp', 'Port answers (TCP)'],
          ['udp', 'Port answers (UDP)'],
        ]
          .map(([v, l]) => `<option value="${v}" ${(t.query?.type || 'none') === v ? 'selected' : ''}>${l}</option>`)
          .join('')}</select></label>
        ${t.query ? `<label class="field"><span>On port</span><select data-k="query.port">${portNames.map((n) => `<option ${t.query.port === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>` : ''}
      </div>
      <details><summary style="cursor:pointer" class="faint">Player joins and leaves (optional)</summary>
        <div class="form-grid mt-8">
          ${field('Join line (regex, name in brackets)', 'logPatterns.join', t.logPatterns.join, { placeholder: '([^ ]+) joined the game' })}
          ${field('Leave line', 'logPatterns.leave', t.logPatterns.leave, { placeholder: '([^ ]+) left the game' })}
        </div>
      </details>
    </div>`;
}

function stepHtml(s, i, count) {
  const spec = STEPS[String(s.type).toLowerCase()];
  const head = `<div class="row" style="gap:6px"><b class="grow">${i + 1}. ${esc(spec?.label || s.type)}</b>
    <button class="btn btn-sm btn-ghost" data-move="${i}:-1" ${i === 0 ? 'disabled' : ''} title="Up">↑</button>
    <button class="btn btn-sm btn-ghost" data-move="${i}:1" ${i === count - 1 ? 'disabled' : ''} title="Down">↓</button>
    <button class="btn btn-sm btn-ghost btn-danger" data-del="install.${i}" title="Remove">${icon('trash', 13)}</button></div>`;
  if (!spec) return `<div class="tb-step">${head}<div class="faint" style="font-size:12.5px">Edit this step in the JSON.</div></div>`;
  return `<div class="tb-step">${head}
    <div class="form-grid mt-8">
      ${(spec.fields || [])
        .map(([k, label, ph]) =>
          k === 'packages'
            ? `<label class="field"><span>${esc(label)}</span><input class="mono" data-k="install.${i}.${k}" data-list value="${esc((s[k] || []).join(' '))}" placeholder="${esc(ph)}" /></label>`
            : field(label, `install.${i}.${k}`, s[k], { placeholder: ph })
        )
        .join('')}
    </div>
    ${spec.text ? `<label class="field"><span>${esc(spec.text[1])}</span><textarea class="mono" rows="4" data-k="install.${i}.${spec.text[0]}">${esc(s[spec.text[0]] || '')}</textarea></label>` : ''}
    ${(spec.flags || []).map(([k, label]) => `<label class="checkbox-row"><input type="checkbox" data-k="install.${i}.${k}" ${s[k] ? 'checked' : ''} /> ${esc(label)}</label>`).join('')}
  </div>`;
}
