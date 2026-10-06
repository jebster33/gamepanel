import { api } from '../core/api.js';
import { loadServers } from '../core/boot.js';
import { state } from '../core/state.js';
import { $, can, esc, toast } from '../core/util.js';
import { openModal } from '../ui/modal.js';

/* --------------------------------------------------------- create server */

/**
 * Fill every `data-source` select from the panel's live option providers.
 * A field may depend on another (a modpack's versions need the modpack), in
 * which case it reloads whenever its parent changes.
 */
async function hydrateOptionFields(root = document, only = null) {
  const all = [...root.querySelectorAll('select[data-source]')];
  const fields = only ? all.filter((f) => only.includes(f)) : all;
  if (!fields.length) return;

  // Group by source *and* query, so dependent fields fetch their own list.
  const jobs = new Map();
  for (const field of fields) {
    const parent = field.dataset.dependsOn
      ? root.querySelector(`[data-var="${CSS.escape(field.dataset.dependsOn)}"]`)
      : null;
    const query = parent ? parent.value : '';
    const key = `${field.dataset.source}\0${query}`;
    if (!jobs.has(key)) jobs.set(key, { source: field.dataset.source, query, fields: [] });
    jobs.get(key).fields.push(field);
  }

  await Promise.all(
    [...jobs.values()].map(async ({ source, query, fields: group }) => {
      for (const field of group) {
        if (!field.options.length || field.options[0].value === '') {
          field.innerHTML = '<option>Loading choices…</option>';
        }
      }
      let data;
      try {
        data = await api(`/api/options/${encodeURIComponent(source)}?q=${encodeURIComponent(query)}`);
      } catch (err) {
        data = { options: [], error: err.message };
      }
      for (const field of group) {
        const hint = root.querySelector(`[data-hint-for="${CSS.escape(field.dataset.var)}"]`);

        // Unreachable provider: degrade to a plain text box rather than a
        // dropdown with nothing in it.
        if (!data.options?.length) {
          const input = document.createElement('input');
          input.id = field.id;
          input.dataset.var = field.dataset.var;
          input.value = field.dataset.default || '';
          field.replaceWith(input);
          if (hint) hint.textContent = data.error || 'Could not load the list — type a value instead.';
          continue;
        }

        field.innerHTML = data.options
          .map(
            (o) =>
              `<option value="${esc(o.value)}">${esc(o.label)}${o.recommended ? ' — recommended' : ''}</option>`
          )
          .join('');

        // Honour an explicit template default when it still exists, otherwise
        // take the newest/recommended entry.
        const wanted = field.dataset.default;
        const usable = wanted && wanted !== 'latest' && data.options.some((o) => o.value === wanted);
        field.value = usable ? wanted : data.recommended ?? data.options[0].value;

        const describe = () => {
          if (!hint) return;
          const chosen = data.options.find((o) => o.value === field.value);
          const note = chosen?.note || (chosen?.recommended ? 'Newest stable release.' : '');
          hint.textContent = [note, data.stale ? '(cached list)' : ''].filter(Boolean).join(' ');
        };
        field.addEventListener('change', describe);
        describe();

        // Anything depending on this field reloads when it changes.
        if (!field.dataset.wiredDependants) {
          field.dataset.wiredDependants = '1';
          const dependants = [...root.querySelectorAll(`select[data-depends-on="${CSS.escape(field.dataset.var)}"]`)];
          if (dependants.length) {
            field.addEventListener('change', () => hydrateOptionFields(root, dependants));
          }
        }
      }
    })
  );
}

/** Warn before submitting if a chosen port is already taken by another server. */
function checkPortConflicts(root = document) {
  const used = new Map();
  for (const server of state.servers) {
    for (const [name, port] of Object.entries(server.ports || {})) used.set(Number(port), server.name);
  }
  root.querySelectorAll('[data-port]').forEach((input) => {
    const update = () => {
      const owner = used.get(Number(input.value));
      let hint = input.parentElement.querySelector('.port-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'hint port-hint';
        input.parentElement.appendChild(hint);
      }
      hint.textContent = owner ? `In use by “${owner}” — pick another or it will be reassigned.` : '';
      hint.style.color = owner ? 'var(--warning)' : '';
    };
    input.addEventListener('input', update);
    update();
  });
}

/** Wire the memory preset dropdown to its hidden numeric input. */
function wireMemoryField(root = document) {
  const preset = root.querySelector('#new-memory-preset');
  const input = root.querySelector('#new-memory');
  if (!preset || !input) return;
  preset.addEventListener('change', () => {
    if (preset.value === 'custom') {
      input.classList.remove('hidden');
      input.focus();
      input.select();
    } else {
      input.classList.add('hidden');
      input.value = preset.value;
    }
  });
}

/** Reroll button on generated secrets. */
function wireGenerateButtons(root = document) {
  root.querySelectorAll('[data-generate]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const field = root.querySelector(`[data-var="${CSS.escape(btn.dataset.generate)}"]`);
      if (!field) return;
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      field.value = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 16);
      field.focus();
    })
  );
}

/**
 * Dropdowns that allow a custom value keep a hidden text input beside them;
 * the select drives it, and the input is what actually gets submitted.
 */
function wireCustomOptions(root = document) {
  root.querySelectorAll('[data-custom-for]').forEach((select) => {
    const name = select.dataset.customFor;
    const input = root.querySelector(`[data-custom-input="${CSS.escape(name)}"]`);
    if (!input) return;
    const sync = () => {
      const custom = select.value === '__custom__';
      input.classList.toggle('hidden', !custom);
      if (custom) {
        input.focus();
        input.select();
      } else {
        input.value = select.value;
      }
    };
    select.addEventListener('change', sync);
    if (select.value !== '__custom__') input.value = select.value;
  });
}

/** Everything a freshly opened deploy form needs. */
function wireDeployForm(root = document) {
  wireMemoryField(root);
  wireGenerateButtons(root);
  wireCustomOptions(root);
  checkPortConflicts(root);
  hydrateOptionFields(root);
}

/**
 * Memory picker: common sizes as a dropdown, with an escape hatch to type an
 * exact number. The hidden #new-memory input stays the single source of truth.
 */
/** Which machine to put the server on, when this panel has other nodes. */
function nodeField() {
  const nodes = (state.nodes?.nodes || []).filter((n) => n.online);
  if (!nodes.length) return '';
  return `<label><span>Node</span><select id="new-node">
      <option value="">${esc(state.nodes.local.name)} (this machine)</option>
      ${nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.name)}</option>`).join('')}
    </select></label>`;
}

function createPath() {
  const node = $('#new-node')?.value;
  return node ? `/api/nodes/${encodeURIComponent(node)}/proxy/api/servers` : '/api/servers';
}

function memoryField(defaultMb) {
  const presets = [1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768];
  if (!presets.includes(defaultMb)) presets.push(defaultMb);
  presets.sort((a, b) => a - b);
  const label = (mb) => (mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`);
  return `
    <label><span>Memory limit</span>
      <select id="new-memory-preset">
        ${presets
          .map(
            (mb) =>
              `<option value="${mb}" ${mb === defaultMb ? 'selected' : ''}>${label(mb)}${
                mb === defaultMb ? ' — recommended' : ''
              }</option>`
          )
          .join('')}
        <option value="custom">Custom…</option>
      </select>
      <input id="new-memory" type="number" min="256" step="256" value="${defaultMb}" class="hidden" />
      <div class="hint">The container is capped at this; a server that exceeds it is restarted rather than taking the host down.</div>
    </label>`;
}

function variableField(v) {
  const id = `var-${v.name}`;

  // Choices fetched live from the panel (game versions, modpacks, channels…).
  if (v.source) {
    return `<label><span>${esc(v.label || v.name)}</span>
      <select id="${id}" data-var="${esc(v.name)}" data-source="${esc(v.source)}" data-default="${esc(
      v.default ?? ''
    )}" ${v.dependsOn ? `data-depends-on="${esc(v.dependsOn)}"` : ''}>
        <option>Loading choices…</option>
      </select>
      <div class="hint" data-hint-for="${esc(v.name)}">${esc(v.description || '')}</div></label>`;
  }

  // Secrets: prefilled with something strong, with a button to reroll.
  if (v.generate === 'password') {
    return `<label><span>${esc(v.label || v.name)}</span>
      <span class="input-row">
        <input id="${id}" data-var="${esc(v.name)}" type="text" value="${esc(v.default ?? '')}"
               placeholder="generated automatically" spellcheck="false" />
        <button type="button" class="btn btn-sm" data-generate="${esc(v.name)}">Generate</button>
      </span>
      <div class="hint">${esc(v.description || 'Leave blank and one will be generated for you.')}</div></label>`;
  }

  // Fixed choices. Entries may be plain values or {value,label} pairs, and
  // `allowCustom` adds an escape hatch for things like Workshop map names.
  if (v.options?.length) {
    const known = v.options.map((o) => String(typeof o === 'object' ? o.value : o));
    const isCustom = v.default !== undefined && v.default !== '' && !known.includes(String(v.default));
    return `<label><span>${esc(v.label || v.name)}</span>
      <select id="${id}" ${v.allowCustom ? `data-custom-for="${esc(v.name)}"` : `data-var="${esc(v.name)}"`}>
        ${v.options
          .map((o) => {
            const value = typeof o === 'object' ? o.value : o;
            const text = typeof o === 'object' ? o.label || o.value : o;
            return `<option value="${esc(value)}" ${
              String(v.default) === String(value) ? 'selected' : ''
            }>${esc(text)}</option>`;
          })
          .join('')}
        ${v.allowCustom ? `<option value="__custom__" ${isCustom ? 'selected' : ''}>Custom…</option>` : ''}
      </select>
      ${
        v.allowCustom
          ? `<input class="mt-8 ${isCustom ? '' : 'hidden'}" data-var="${esc(v.name)}" data-custom-input="${esc(
              v.name
            )}" value="${esc(v.default ?? '')}" placeholder="Type an exact value" />`
          : ''
      }
      ${v.description ? `<div class="hint">${esc(v.description)}</div>` : ''}</label>`;
  }
  const isLong = String(v.default || '').length > 60;
  const field = isLong
    ? `<textarea id="${id}" data-var="${esc(v.name)}" rows="3">${esc(v.default ?? '')}</textarea>`
    : `<input id="${id}" data-var="${esc(v.name)}" type="${v.type === 'number' ? 'number' : v.secret ? 'password' : 'text'}" ${v.secret ? 'autocomplete="new-password"' : ''} value="${esc(
        v.default ?? ''
      )}" ${v.generate === 'password' ? 'placeholder="generated automatically"' : ''} />`;
  return `<label><span>${esc(v.label || v.name)}</span>${field}${
    v.description ? `<div class="hint">${esc(v.description)}</div>` : ''
  }</label>`;
}

export function openCreateServerModal(templateId) {
  const template = state.templates.find((t) => t.id === templateId) || state.templates[0];
  if (!template) return toast('No templates available', 'error');
  if (template.wizard?.length) return openWizardModal(template);

  const variableFields = (template.variables || []).map(variableField).join('');

  const portFields = (template.ports || [])
    .map(
      (p) =>
        `<label><span>Port · ${esc(p.name)} (${esc(p.protocol || 'tcp')})</span>
           <input data-port="${esc(p.name)}" type="number" value="${p.default}" /></label>`
    )
    .join('');

  const modal = openModal({
    title: `${esc(template.icon || '🎮')} Deploy ${esc(template.name)}`,
    width: 660,
    body: `
      <p class="faint" style="margin-top:0">${esc(template.description || '')}</p>
      <div class="form-grid">
        <label><span>Server name</span><input id="new-name" value="${esc(template.name)}" /></label>
        ${memoryField(template.defaultMemory || 2048)}
        ${nodeField()}
      </div>
      ${portFields ? `<h4 class="section-title mt-16">Ports</h4><div class="form-grid">${portFields}</div>` : ''}
      ${variableFields ? `<h4 class="section-title mt-16">Game settings</h4><div class="form-grid">${variableFields}</div>` : ''}
      <div class="checkbox-row mt-16"><input type="checkbox" id="new-autostart" checked /><label for="new-autostart">Start with the panel</label></div>
      <div class="checkbox-row"><input type="checkbox" id="new-autorestart" checked /><label for="new-autorestart">Restart after crashes</label></div>
      <div class="hint">Installation starts immediately and streams to the server console. Large games can take a while.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Create & install',
        primary: true,
        onClick: async (btn) => {
          const vars = {};
          document.querySelectorAll('[data-var]').forEach((el) => (vars[el.dataset.var] = el.value));
          const ports = {};
          document.querySelectorAll('[data-port]').forEach((el) => {
            const value = Number(el.value);
            if (value) ports[el.dataset.port] = value;
          });
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Creating…';
          try {
            const data = await api(createPath(), {
              method: 'POST',
              body: {
                templateId: template.id,
                name: $('#new-name').value.trim(),
                memory: Number($('#new-memory').value),
                autoStart: $('#new-autostart').checked,
                autoRestart: $('#new-autorestart').checked,
                vars,
                ports,
              },
            });
            await loadServers();
            modal.close();
            toast('Server created — installation started');
            location.hash = `#/servers/${data.server.id}/console`;
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Create & install';
          }
        },
      },
    ],
  });

  wireDeployForm(document);
  return modal;
}

/**
 * Step-by-step create flow for templates that declare a `wizard`
 * (FiveM walks you through license key, framework and database this way).
 */
function openWizardModal(template) {
  const byName = Object.fromEntries((template.variables || []).map((v) => [v.name, v]));
  const used = new Set();
  const steps = template.wizard.map((step) => ({
    title: step.title,
    description: step.description,
    fields: (step.fields || []).filter((name) => byName[name]).map((name) => {
      used.add(name);
      return byName[name];
    }),
  }));

  // Anything the wizard did not mention goes on a final "advanced" step.
  const leftovers = (template.variables || []).filter((v) => !used.has(v.name));
  const allSteps = [
    {
      title: 'Server name and resources',
      description: `Deploying ${template.name}.`,
      html: `<div class="form-grid">
          <label><span>Server name</span><input id="new-name" value="${esc(template.name)}" /></label>
          ${memoryField(template.defaultMemory || 2048)}
        ${nodeField()}
          ${(template.ports || [])
            .map(
              (p) =>
                `<label><span>Port · ${esc(p.name)} (${esc(p.protocol || 'tcp')})</span><input data-port="${esc(
                  p.name
                )}" type="number" value="${p.default}" /></label>`
            )
            .join('')}
        </div>`,
    },
    ...steps.map((step) => ({
      title: step.title,
      description: step.description,
      html: `<div class="form-grid">${step.fields.map(variableField).join('')}</div>`,
    })),
    ...(leftovers.length
      ? [
          {
            title: 'Advanced',
            description: 'Fine — leave these alone unless you know you need them.',
            html: `<div class="form-grid">${leftovers.map(variableField).join('')}</div>`,
          },
        ]
      : []),
  ];

  let current = 0;
  const body = allSteps
    .map(
      (step, i) => `
      <div class="wizard-step ${i === 0 ? '' : 'hidden'}" data-step="${i}">
        <div class="wizard-head">
          <span class="wizard-count">Step ${i + 1} of ${allSteps.length}</span>
          <h3>${esc(step.title)}</h3>
          ${step.description ? `<p class="hint">${esc(step.description)}</p>` : ''}
        </div>
        ${step.html}
      </div>`
    )
    .join('');

  const modal = openModal({
    title: `${esc(template.icon || '🎮')} ${esc(template.name)} setup`,
    width: 660,
    body: `<div class="wizard-progress">${allSteps
      .map((_, i) => `<i data-dot="${i}" class="${i === 0 ? 'active' : ''}"></i>`)
      .join('')}</div>${body}`,
    actions: [
      { label: 'Back', onClick: () => show(current - 1) },
      { label: 'Next', primary: true, onClick: (btn) => (current === allSteps.length - 1 ? submit(btn) : show(current + 1)) },
    ],
  });

  wireDeployForm(document);

  const [backBtn, nextBtn] = [...document.querySelectorAll('.modal-foot .btn')];

  function show(index) {
    current = Math.max(0, Math.min(allSteps.length - 1, index));
    document.querySelectorAll('.wizard-step').forEach((el) => {
      el.classList.toggle('hidden', Number(el.dataset.step) !== current);
    });
    document.querySelectorAll('[data-dot]').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.dot) <= current);
    });
    backBtn.disabled = current === 0;
    nextBtn.textContent = current === allSteps.length - 1 ? 'Create & install' : 'Next →';
    document.querySelector('.modal-body').scrollTop = 0;
  }
  show(0);

  async function submit(btn) {
    const vars = {};
    document.querySelectorAll('[data-var]').forEach((el) => (vars[el.dataset.var] = el.value));
    const ports = {};
    document.querySelectorAll('[data-port]').forEach((el) => {
      const value = Number(el.value);
      if (value) ports[el.dataset.port] = value;
    });
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating…';
    try {
      const data = await api(createPath(), {
        method: 'POST',
        body: {
          templateId: template.id,
          name: $('#new-name').value.trim(),
          memory: Number($('#new-memory').value),
          autoStart: true,
          autoRestart: true,
          vars,
          ports,
        },
      });
      await loadServers();
      modal.close();
      toast('Server created — installation started');
      location.hash = `#/servers/${data.server.id}/console`;
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Create & install';
    }
  }
}

/* ------------------------------------------------------ import existing */

/** Put a server that is already on this machine under the panel. */
export function openImportModal() {
  const templates = [...state.templates].sort((a, b) => a.name.localeCompare(b.name));
  if (!templates.length) return toast('No templates available', 'error');
  const example = /windows/i.test(state.host?.platform || '') ? 'D:\\Servers\\Valheim' : '/home/me/minecraft';
  const modal = openModal({
    title: 'Import an existing server',
    width: 620,
    body: `
      <p class="faint" style="margin-top:0;line-height:1.6">
        Already running a server on this machine? Point the panel at its folder and pick the game. Nothing is downloaded or reinstalled.
      </p>
      <div class="form-grid">
        <label><span>Game</span><select id="imp-template">${templates
          .map((t) => `<option value="${esc(t.id)}">${esc(t.icon || '🎮')} ${esc(t.name)}</option>`)
          .join('')}</select></label>
        <label><span>Server name</span><input id="imp-name" placeholder="My server" /></label>
      </div>
      <label class="field mt-16"><span>Folder on this machine</span>
        <input id="imp-path" class="mono" placeholder="${esc(example)}" spellcheck="false" />
      </label>
      <div class="field-label mt-16">Files</div>
      <div class="checkbox-row"><input type="radio" name="imp-mode" id="imp-inplace" value="inplace" checked /><label for="imp-inplace">Use the folder where it is (deleting the server in the panel never deletes these files)</label></div>
      <div class="checkbox-row"><input type="radio" name="imp-mode" id="imp-copy" value="copy" /><label for="imp-copy">Copy it into the panel's own folder and leave the original alone</label></div>
      <label class="field mt-16"><span>Start command (optional)</span>
        <input id="imp-start" class="mono" placeholder="Leave empty to start it the way the game's template does" spellcheck="false" />
        <div class="hint">For a custom jar or launch script, e.g. <span class="mono">java -Xmx4G -jar server.jar nogui</span>. You can change it later in Settings.</div>
      </label>
      <div class="hint mt-16">Moving a server from another GamePanel? Unpack its export into a folder and point here: the game and settings come from the export.</div>
      <div class="hint mt-16">The panel's service account needs to be able to read and write the folder. Ports come from the server's own config when the panel can find them.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Import',
        primary: true,
        onClick: async (btn) => {
          const template = state.templates.find((t) => t.id === $('#imp-template').value);
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Importing…';
          try {
            const data = await api('/api/servers/import', {
              method: 'POST',
              body: {
                templateId: template.id,
                name: $('#imp-name').value.trim(),
                path: $('#imp-path').value.trim(),
                mode: $('#imp-copy').checked ? 'copy' : 'inplace',
                startCommand: $('#imp-start').value.trim(),
                autoStart: false,
              },
            });
            await loadServers();
            modal.close();
            toast('Server imported');
            location.hash = `#/servers/${data.server.id}/console`;
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Import';
          }
        },
      },
    ],
  });
  $('#imp-path').focus();
  return modal;
}
