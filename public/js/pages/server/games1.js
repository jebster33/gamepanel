import { api } from '../../core/api.js';
import { esc, toast, can } from '../../core/util.js';
import { openModal } from '../../ui/modal.js';

/*
 * Per-game extras: Nexus Mods links, tShock plugin installs, Steam beta
 * branch, Project Zomboid sandbox options and the 7 Days to Die map preview.
 */

/* ------------------------------------------------------------- nexus -- */

export async function renderNexusCard(host, server) {
  let info;
  try {
    info = await api(`/api/servers/${server.id}/nexus`);
  } catch {
    return;
  }
  if (!info.game) return;
  const g = info.game;
  host.innerHTML = `
    <div class="card gx-card mb-16">
      <div class="kpi-label">Nexus Mods</div>
      <p class="faint" style="font-size:13px;margin:6px 0 12px">The panel cannot install ${esc(g.name)} mods by itself. Nexus Mods has them: download there, then upload the files on the
        <a href="#/servers/${esc(server.id)}/files">Files tab</a>.</p>
      <div class="input-row">
        <input id="gx-nexus-q" placeholder="Search ${esc(g.name)} mods on Nexus" />
        <a class="btn btn-primary" id="gx-nexus-go" href="${esc(g.searchUrl)}" target="_blank" rel="noopener noreferrer">Search on Nexus</a>
      </div>
      <div class="faint" style="font-size:12px;margin-top:8px"><a href="${esc(g.mods)}" target="_blank" rel="noopener noreferrer">Browse all ${esc(g.name)} mods</a> (nexusmods.com/${esc(g.domain)})</div>
    </div>`;
  const input = host.querySelector('#gx-nexus-q');
  const go = host.querySelector('#gx-nexus-go');
  const update = () => {
    const url = new URL(g.searchUrl);
    url.searchParams.set('gsearch', input.value.slice(0, 100));
    go.href = url.toString();
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') window.open(go.href, '_blank', 'noopener');
  });
}

/* ------------------------------------------------------------ tshock -- */

export async function renderTshockExtras(host, server) {
  if (server.templateId !== 'terraria') return;
  let info;
  try {
    info = await api(`/api/servers/${server.id}/tshock`);
  } catch {
    return;
  }
  const writable = can('files.write');
  host.innerHTML = `
    <div class="card gx-card">
      <div class="kpi-label">tShock plugins</div>
      ${
        info.tshock
          ? ''
          : '<div class="hint warning" style="margin:8px 0">tShock does not look installed. Plugins only work on a tShock server: download it from github.com/Pryaxis/TShock/releases and upload it on the Files tab.</div>'
      }
      ${
        writable
          ? `<div class="faint" style="font-size:13px;margin:6px 0">Install a plugin from a web address (a .dll or a .zip) or upload one. Files go to <span class="mono">${esc(info.pluginDir)}</span>.</div>
             <div class="input-row mb-16"><input id="gx-ts-url" placeholder="https://… plugin .dll or .zip" /><button class="btn" id="gx-ts-install">Install</button></div>
             <input type="file" id="gx-ts-file" accept=".dll,.zip" />`
          : '<div class="faint" style="font-size:13px">Your account cannot upload files.</div>'
      }
      ${info.config ? `<div class="faint" style="font-size:12px;margin-top:10px">tShock's settings are on the <a href="#/servers/${esc(server.id)}/configs">Configs tab</a>.</div>` : ''}
    </div>`;
  const done = (r) => {
    toast(`Installed ${r.installed.join(', ')}${r.restartNeeded ? '. Restart the server to load it.' : ''}`);
    document.dispatchEvent(new CustomEvent('gp:mods-changed'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  host.querySelector('#gx-ts-install')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const url = host.querySelector('#gx-ts-url').value.trim();
    if (!url) return;
    btn.disabled = true;
    try {
      done(await api(`/api/servers/${server.id}/tshock/install-url`, { method: 'POST', body: { url } }));
    } catch (err) {
      toast(err.message, 'error');
    }
    btn.disabled = false;
  });
  host.querySelector('#gx-ts-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(server.id)}/tshock/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      done(data);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------------------------------- steam branch -- */

export async function renderSteamBranchCard(host, server) {
  if (!can('settings')) return;
  let info;
  try {
    info = await api(`/api/servers/${server.id}/steam-branch`);
  } catch {
    return;
  }
  if (!info.supported) return;
  host.innerHTML = `
    <div class="card mb-16 gx-card row" style="align-items:center;gap:16px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <div class="kpi-label">Steam branch</div>
        <div class="version-now">${esc(info.branch)}${info.custom ? ' <span class="badge accent">Custom</span>' : ''}${info.hasPassword ? ' <span class="badge">Password set</span>' : ''}</div>
        <div class="faint" style="font-size:12px">Which Steam build of app ${esc(info.appid)} installs and updates. "public" is the normal release. A change applies on the next update or reinstall.</div>
      </div>
      <button class="btn" id="gx-sb-open">Change branch</button>
    </div>`;
  host.querySelector('#gx-sb-open').addEventListener('click', () => openBranchModal(server, info, () => renderSteamBranchCard(host, server)));
}

async function openBranchModal(server, info, done) {
  const modal = openModal({
    title: 'Steam branch',
    width: 520,
    body: `
      <div class="field-label">Known branches</div>
      <select id="gx-sb-select"><option value="">Loading…</option></select>
      <div class="field-label" style="margin-top:12px">Or type a branch name</div>
      <input id="gx-sb-custom" placeholder="public" value="${esc(info.custom ? info.branch : '')}" />
      <div class="field-label" style="margin-top:12px">Branch password (only for locked branches)</div>
      <input id="gx-sb-pass" type="password" autocomplete="new-password" placeholder="${info.hasPassword ? 'Saved. Leave blank to keep it' : 'Leave blank if none'}" />
      ${info.hasPassword ? '<div class="checkbox-row"><input type="checkbox" id="gx-sb-clear" /><label for="gx-sb-clear">Remove the saved password</label></div>' : ''}
      <div class="hint">After saving, use Update on the server page (or Reinstall) to download that branch. Switching back to public may need a reinstall.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async (btn, m) => {
          const root = m.root;
          const branch = root.querySelector('#gx-sb-custom').value.trim() || root.querySelector('#gx-sb-select').value || 'public';
          btn.disabled = true;
          try {
            await api(`/api/servers/${server.id}/steam-branch`, {
              method: 'PUT',
              body: { branch, password: root.querySelector('#gx-sb-pass').value, clearPassword: Boolean(root.querySelector('#gx-sb-clear')?.checked) },
            });
            toast('Branch saved. Update the server to download it.');
            m.close?.();
            done();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
  const select = modal.root.querySelector('#gx-sb-select');
  try {
    const { branches } = await api(`/api/servers/${server.id}/steam-branch/branches`);
    select.innerHTML = `<option value="">(choose)</option>${branches
      .map((b) => `<option value="${esc(b.name)}" ${b.name === info.branch ? 'selected' : ''}>${esc(b.name)}${b.locked ? ' (password)' : ''}${b.description ? ` - ${esc(b.description)}` : ''}</option>`)
      .join('')}`;
    select.addEventListener('change', () => {
      if (select.value) modal.root.querySelector('#gx-sb-custom').value = select.value === 'public' ? '' : select.value;
    });
  } catch (err) {
    select.innerHTML = `<option value="">Could not list branches: ${esc(err.message)}</option>`;
  }
}

/* ---------------------------------------------------- zomboid sandbox -- */

export async function renderSandboxCard(host, server) {
  if (server.templateId !== 'project-zomboid' || !can('settings')) return;
  host.innerHTML = `
    <div class="card mb-16 gx-card row" style="align-items:center;gap:16px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <div class="kpi-label">Sandbox options</div>
        <div class="faint" style="font-size:13px">Zombies, loot, day length and the rest of the world rules, with presets. Stored in <span class="mono">&lt;name&gt;_SandboxVars.lua</span>.</div>
      </div>
      <button class="btn" id="gx-sv-open">Edit sandbox options</button>
    </div>`;
  host.querySelector('#gx-sv-open').addEventListener('click', () => openSandbox(server));
}

function fieldHtml(f) {
  const id = `gx-f-${f.path.replace(/\W/g, '_')}`;
  let control;
  if (f.type === 'bool') control = `<input type="checkbox" id="${id}" data-path="${esc(f.path)}" data-type="bool" ${f.value ? 'checked' : ''} />`;
  else if (f.options) {
    const known = f.options.some((o) => o.value === f.value);
    control = `<select id="${id}" data-path="${esc(f.path)}" data-type="number">${known ? '' : `<option value="${esc(f.value)}" selected>${esc(f.value)}</option>`}${f.options
      .map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select>`;
  } else if (f.type === 'string') control = `<input id="${id}" data-path="${esc(f.path)}" data-type="string" value="${esc(f.value)}" />`;
  else control = `<input id="${id}" type="number" step="${f.type === 'float' ? 'any' : '1'}" data-path="${esc(f.path)}" data-type="number" value="${esc(f.value)}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} />`;
  return `<div class="gx-field" data-search="${esc(`${f.label} ${f.path}`.toLowerCase())}"><label for="${id}">${esc(f.label)}</label>${control}${f.help ? `<div class="faint" style="font-size:12px">${esc(f.help)}</div>` : ''}</div>`;
}

async function openSandbox(server) {
  let data;
  try {
    data = await api(`/api/servers/${server.id}/sandbox`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (data.missing) {
    toast('The sandbox file does not exist yet. Start the server once so the game creates it.', 'error');
    return;
  }
  if (data.error) {
    toast(data.error, 'error');
    return;
  }
  const groups = [];
  for (const f of data.fields) {
    let g = groups.find((x) => x.name === f.group);
    if (!g) groups.push((g = { name: f.group, fields: [] }));
    g.fields.push(f);
  }
  groups.sort((a, b) => (a.name === 'Other options') - (b.name === 'Other options'));
  const original = new Map(data.fields.map((f) => [f.path, f.value]));

  const modal = openModal({
    title: 'Sandbox options',
    width: 720,
    body: `
      ${data.running ? '<div class="card warn-card mb-16" style="font-size:13px">The server is running. Stop it before saving: the game rewrites this file when it shuts down.</div>' : ''}
      <div class="row mb-16" style="gap:8px;flex-wrap:wrap">
        <select id="gx-sv-preset"><option value="">Start from a preset…</option>${data.presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} - ${esc(p.description)}</option>`).join('')}</select>
        <input id="gx-sv-find" placeholder="Find an option…" style="max-width:220px" />
      </div>
      <div style="max-height:55vh;overflow:auto" id="gx-sv-body">
        ${groups.map((g) => `<div class="gx-group"><div class="kpi-label" style="margin:12px 0 6px">${esc(g.name)}</div>${g.fields.map(fieldHtml).join('')}</div>`).join('')}
      </div>
      <div class="hint">Presets are approximations of the game's difficulty names. Nothing is written until you press Save.</div>`,
    actions: [
      { label: 'Close', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async (btn, m) => {
          const changes = {};
          m.root.querySelectorAll('[data-path]').forEach((el) => {
            const value = el.dataset.type === 'bool' ? el.checked : el.dataset.type === 'number' ? (el.value === '' ? el.value : Number(el.value)) : el.value;
            if (value !== original.get(el.dataset.path)) changes[el.dataset.path] = value;
          });
          if (!Object.keys(changes).length) return toast('Nothing changed');
          btn.disabled = true;
          try {
            await api(`/api/servers/${server.id}/sandbox`, { method: 'PUT', body: { file: data.path, version: data.version, changes } });
            toast('Sandbox options saved. They apply when the server starts.');
            m.close?.();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
          return undefined;
        },
      },
    ],
  });
  const root = modal.root;
  root.querySelector('#gx-sv-preset').addEventListener('change', (e) => {
    const preset = data.presets.find((p) => p.id === e.target.value);
    if (!preset) return;
    for (const [path, value] of Object.entries(preset.values)) {
      const el = [...root.querySelectorAll('[data-path]')].find((x) => x.dataset.path.toLowerCase() === path.toLowerCase());
      if (el) el.value = value;
    }
    toast(`${preset.name} values filled in. Review them, then Save.`);
  });
  root.querySelector('#gx-sv-find').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    root.querySelectorAll('.gx-field').forEach((el) => (el.style.display = !q || el.dataset.search.includes(q) ? '' : 'none'));
  });
}

/* -------------------------------------------------------- 7dtd map -- */

export async function renderSevenDaysMapCard(host, server) {
  if (server.templateId !== 'seven-days-to-die' || !can('console')) return;
  host.innerHTML = '<div class="card mb-16 gx-card"><div class="kpi-label">World map</div><div class="faint">Looking for the generated world…</div></div>';
  const load = async (world) => {
    let info;
    try {
      info = await api(`/api/servers/${server.id}/sevendays-map${world ? `?world=${encodeURIComponent(world)}` : ''}`);
    } catch (err) {
      host.innerHTML = `<div class="card mb-16 gx-card"><div class="kpi-label">World map</div><div class="faint">${esc(err.message)}</div></div>`;
      return;
    }
    if (!info.available) {
      host.innerHTML = `<div class="card mb-16 gx-card"><div class="kpi-label">World map</div><p class="faint" style="font-size:13px;margin:6px 0 0">${esc(info.message)}</p></div>`;
      return;
    }
    host.innerHTML = `
      <div class="card mb-16 gx-card">
        <div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="kpi-label">World map</div>
          ${info.worlds.length > 1 ? `<select id="gx-map-world">${info.worlds.map((w) => `<option ${w === info.world ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select>` : `<span class="mono faint">${esc(info.world)}</span>`}
        </div>
        ${info.note ? `<div class="faint" style="font-size:12px">${esc(info.note)}</div>` : ''}
        <div style="position:relative;max-width:640px;margin:10px 0">
          <canvas id="gx-map" width="640" height="640" style="width:100%;height:auto;background:#111;border:1px solid var(--border,#333)"></canvas>
          <div id="gx-map-tip" class="mono" style="position:absolute;pointer-events:none;display:none;background:#000c;padding:2px 6px;font-size:11px"></div>
        </div>
        <div class="faint" style="font-size:12px">${info.pois.length} buildings${info.size ? `, ${info.size} m square` : ''}. ${info.summary.map((s) => `${esc(s.name)} ${s.count}`).join(' · ')}</div>
      </div>`;
    host.querySelector('#gx-map-world')?.addEventListener('change', (e) => load(e.target.value));
    drawMap(host.querySelector('#gx-map'), host.querySelector('#gx-map-tip'), server, info);
  };
  load('');
}

function drawMap(canvas, tip, server, info) {
  const ctx = canvas.getContext('2d');
  const size = info.size || 8192;
  const px = (x) => ((x + size / 2) / size) * canvas.width;
  const py = (z) => ((size / 2 - z) / size) * canvas.height;
  const markers = () => {
    ctx.fillStyle = '#c6ff3a';
    for (const p of info.pois) {
      ctx.beginPath();
      ctx.arc(px(p.x), py(p.z), 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (info.hasImage) {
    const img = new Image();
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      markers();
    };
    img.onerror = markers;
    img.src = `/api/servers/${encodeURIComponent(server.id)}/sevendays-map/image?world=${encodeURIComponent(info.world)}&file=biomes.png`;
  } else markers();
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * canvas.width;
    const my = ((e.clientY - r.top) / r.height) * canvas.height;
    let best = null;
    let bestD = 64;
    for (const p of info.pois) {
      const d = (px(p.x) - mx) ** 2 + (py(p.z) - my) ** 2;
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    tip.style.display = best ? 'block' : 'none';
    if (best) {
      tip.textContent = `${best.name} (${best.x}, ${best.z})`;
      tip.style.left = `${e.clientX - r.left + 10}px`;
      tip.style.top = `${e.clientY - r.top + 10}px`;
    }
  });
  canvas.addEventListener('mouseleave', () => (tip.style.display = 'none'));
}

/** Cards for the Game settings tab. */
export function renderGameExtras(host, server) {
  host.innerHTML = '<div id="gx-sb"></div><div id="gx-sv"></div><div id="gx-map-card"></div>';
  renderSteamBranchCard(host.querySelector('#gx-sb'), server);
  renderSandboxCard(host.querySelector('#gx-sv'), server);
  renderSevenDaysMapCard(host.querySelector('#gx-map-card'), server);
}
