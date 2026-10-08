import { api } from '../../core/api.js';
import { esc, toast, icon } from '../../core/util.js';
import { openModal } from '../../ui/modal.js';

/* ------------------------------------------------------ version switching */

/*
 * The "Version" card on the Game settings tab, and the switcher it opens:
 * pick a version (and for Minecraft Java a server type), back up, reinstall.
 */

function versionLabel(info) {
  const type = info.types.find((t) => t.id === info.templateId);
  const v = info.resolved || info.gameVersion || Object.values(info.current)[0] || 'latest';
  return `${type ? `${type.name} ` : ''}${v}`;
}

const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export async function renderVersionCard(host, server) {
  let info;
  try {
    info = await api(`/api/servers/${server.id}/version`);
  } catch {
    return;
  }
  if (!info.supported) return;
  const last = info.history[0];
  host.innerHTML = `
    <div class="card mb-16 version-card">
      <span class="version-icon">${icon('gamepad', 20)}</span>
      <div style="flex:1;min-width:0">
        <div class="kpi-label">Version</div>
        <div class="version-now">${esc(versionLabel(info))}</div>
        ${last ? `<div class="faint" style="font-size:12px">Switched ${esc(ago(last.at))}${last.version ? ` from ${esc(last.version)}` : ''}${last.backup ? ' · backup kept on the Backups tab' : ''}</div>` : ''}
      </div>
      <button class="btn" id="gv-open">${info.types.length ? 'Change version or type' : 'Change version'}</button>
    </div>`;
  host.querySelector('#gv-open').addEventListener('click', () => openSwitcher(server, info, () => renderVersionCard(host, server)));
}

function openSwitcher(server, info, done) {
  let typeId = info.templateId;
  const fieldsFor = () => (info.types.find((t) => t.id === typeId)?.fields || info.fields);

  const modal = openModal({
    title: 'Switch version',
    width: 560,
    body: `
      ${
        info.types.length
          ? `<div class="field-label">Server type</div>
             <div class="type-grid">${info.types
               .map((t) => `<button type="button" class="type-tile ${t.id === typeId ? 'active' : ''}" data-type="${esc(t.id)}">${esc(t.name)}</button>`)
               .join('')}</div>`
          : ''
      }
      <div id="gv-fields"></div>
      <div id="gv-warn"></div>
      ${['running', 'starting'].includes(server.status) ? '<div class="card warn-card mb-16" style="font-size:13px">The server is running. It will be stopped first, so warn your players.</div>' : ''}
      <div class="checkbox-row"><input type="checkbox" id="gv-backup" checked /><label for="gv-backup">Back up the whole server first (recommended)</label></div>
      <div class="hint">Worlds, configs and ${info.types.length ? 'plugins/mods' : 'mods'} stay. The new build is downloaded and the server is left stopped, ready to start.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Switch and reinstall',
        primary: true,
        onClick: async (btn, m) => {
          const vars = {};
          m.root.querySelectorAll('[data-gv]').forEach((sel) => (vars[sel.dataset.gv] = sel.value));
          btn.disabled = true;
          btn.textContent = ['running', 'starting'].includes(server.status) ? 'Stopping…' : m.root.querySelector('#gv-backup').checked ? 'Backing up…' : 'Switching…';
          try {
            await api(`/api/servers/${server.id}/version`, {
              method: 'POST',
              body: { templateId: typeId, vars, backup: m.root.querySelector('#gv-backup').checked, stopFirst: true },
            });
            m.close();
            toast('Switching version. Follow along in the console.', 'info', 6000);
            location.hash = `#/servers/${server.id}/console`;
            done();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Switch and reinstall';
          }
        },
      },
    ],
  });
  const root = document.querySelector('.modal-backdrop:last-child');
  modal.root = root;

  const drawFields = async () => {
    const box = root.querySelector('#gv-fields');
    const fields = fieldsFor();
    box.innerHTML = fields
      .map((f) => `<label class="field"><span>${esc(f.label)}</span><select data-gv="${esc(f.name)}" disabled><option>Loading versions…</option></select>${f.description ? `<div class="hint">${esc(f.description)}</div>` : ''}</label>`)
      .join('');
    for (const f of fields) {
      const sel = box.querySelector(`[data-gv="${f.name}"]`);
      let opts = [];
      try {
        opts = (await api(`/api/options/${encodeURIComponent(f.source)}`)).options || [];
      } catch {
        /* fall back to just "latest" */
      }
      if (!sel.isConnected) return;
      const current = typeId === info.templateId ? info.current[f.name] : f.default;
      const list = [];
      if (['latest', 'recommended', 'stable'].includes(String(f.default)) && !opts.some((o) => o.value === f.default)) {
        list.push({ value: f.default, label: `${f.default[0].toUpperCase()}${f.default.slice(1)} (follow new releases)` });
      }
      list.push(...opts.map((o) => (typeof o === 'object' ? o : { value: o, label: o })));
      if (current && !list.some((o) => String(o.value) === String(current))) list.unshift({ value: current, label: String(current) });
      sel.innerHTML = list
        .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(current) ? 'selected' : ''}>${esc(o.label)}${o.recommended ? ' · newest' : ''}${String(o.value) === String(info.current[f.name]) && typeId === info.templateId ? ' · current' : ''}</option>`)
        .join('');
      sel.disabled = false;
      sel.addEventListener('change', warn);
    }
    warn();
  };

  const warn = () => {
    const notes = [];
    const from = info.types.find((t) => t.id === info.templateId);
    const to = info.types.find((t) => t.id === typeId);
    if (from && to && from.id !== to.id) {
      if (from.mods && to.mods !== from.mods) notes.push(`${esc(to.name)} does not load what is in <span class="mono">${esc(from.mods)}/</span>. Those files stay put, so switching back brings them back.`);
      else if (from.mods && to.mods === from.mods && from.id !== to.id) notes.push(`Mods built for ${esc(from.name)} may not load on ${esc(to.name)}.`);
    }
    const sel = root.querySelector('[data-gv="MC_VERSION"]');
    const now = info.gameVersion;
    if (sel && now && /^\d+(\.\d+)*$/.test(sel.value) && compare(sel.value, now) < 0) {
      notes.push(`${esc(sel.value)} is older than ${esc(now)}. Opening a world in an older version can break it, so keep the backup.`);
    }
    root.querySelector('#gv-warn').innerHTML = notes.map((n) => `<div class="card warn-card mb-16" style="font-size:13px">${n}</div>`).join('');
  };

  root.querySelectorAll('[data-type]').forEach((tile) =>
    tile.addEventListener('click', () => {
      typeId = tile.dataset.type;
      root.querySelectorAll('[data-type]').forEach((t) => t.classList.toggle('active', t === tile));
      drawFields();
    })
  );
  drawFields();
}

function compare(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
