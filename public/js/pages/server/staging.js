import { api } from '../../core/api.js';
import { state } from '../../core/state.js';
import { esc, toast } from '../../core/util.js';
import { openModal } from '../../ui/modal.js';
import { loadServers } from '../../core/boot.js';

/* ------------------------------------------------------- staging copies */

/** The line under a staging copy's header: whose copy it is, and the push button. */
export function stagingBanner(server) {
  if (!server.stagingOf) return '';
  const live = state.servers.find((s) => s.id === server.stagingOf);
  return `<div class="staging-banner">
    <span><b>Staging copy</b> of ${live ? `<a href="#/servers/${esc(live.id)}">${esc(live.name)}</a>` : '<i>a server that no longer exists</i>'}. Try updates and settings here, then push them to live.</span>
    ${live && state.user.role === 'admin' ? '<button class="btn btn-sm btn-primary" id="staging-push">Push to live…</button>' : ''}
  </div>`;
}

/** The Settings-tab card on a live server: its staging copy, or a button to make one. */
export function stagingCard(server) {
  if (server.stagingOf || server.node || state.user.role !== 'admin') return '';
  const copy = state.servers.find((s) => s.stagingOf === server.id);
  return `<div class="card mb-16">
    <h4 style="margin:0 0 6px">Staging copy</h4>
    <p class="faint" style="margin:0 0 14px">A copy on its own ports to try plugin and mod updates or new settings without risking this server. When it works, push the changes here in one go.</p>
    ${copy ? `<div class="row" style="gap:10px;flex-wrap:wrap"><span>Staging copy: <a href="#/servers/${esc(copy.id)}">${esc(copy.name)}</a></span></div>` : '<button class="btn" id="staging-make">Make a staging copy</button>'}
  </div>`;
}

export function wireStagingCard(root, server) {
  root.querySelector('#staging-make')?.addEventListener('click', () => {
    openModal({
      title: 'Make a staging copy',
      width: 480,
      body: `
        <label class="field"><span>Name</span><input id="st-name" value="${esc(`${server.name} (staging)`)}" maxlength="60" /></label>
        <div class="checkbox-row"><input type="checkbox" id="st-world" checked /><label for="st-world">Copy the world too</label></div>
        <div class="hint">Without the world, the copy generates a fresh one: lighter, and enough for testing most plugin and config changes. ${['running', 'starting'].includes(server.status) ? 'The server keeps running: saving pauses for a moment while the world is copied.' : ''}</div>`,
      actions: [
        { label: 'Cancel', close: true },
        {
          label: 'Make copy',
          primary: true,
          onClick: async (btn, m) => {
            const box = document.querySelector('.modal-backdrop:last-child');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Copying';
            try {
              const r = await api(`/api/servers/${server.id}/staging`, { method: 'POST', body: { name: box.querySelector('#st-name').value.trim(), withWorld: box.querySelector('#st-world').checked } });
              m.close();
              await loadServers();
              toast(`${r.server.name} is ready. Start it to try your changes.`);
              location.hash = `#/servers/${r.server.id}/console`;
            } catch (err) {
              toast(err.message, 'error');
              btn.disabled = false;
              btn.textContent = 'Make copy';
            }
          },
        },
      ],
    });
  });
}

const STATUS = { added: '+', changed: '~', removed: '−' };
const KIND = { mods: 'Plugins and mods', settings: 'Settings', world: 'World', other: 'Other' };

export function openPushModal(server) {
  const modal = openModal({
    title: 'Push to live',
    width: 700,
    body: '<div id="sp-body"><span class="spinner"></span> Comparing with the live server…</div>',
    actions: [
      { label: 'Cancel', close: true },
      { label: 'Push', primary: true, onClick: (btn) => go(btn) },
    ],
  });
  const root = document.querySelector('.modal-backdrop:last-child');
  const body = root.querySelector('#sp-body');
  const pushBtn = [...root.querySelectorAll('.modal-foot button')].find((b) => b.textContent.trim() === 'Push');
  pushBtn.disabled = true;
  let d = null;

  api(`/api/servers/${server.id}/staging/diff`)
    .then((data) => {
      d = data;
      const nothing = !d.entries.length && !d.properties.length && !d.version.settings.length && !d.version.files.length;
      body.innerHTML = nothing
        ? `<p style="margin:0">${esc(d.live.name)} already matches this copy. Change something here first.</p>`
        : `
        <p style="margin-top:0">Ticked items on <b>${esc(d.live.name)}</b> become exactly as they are here. ${esc(d.live.name)} keeps its own ports, player lists, logs${d.entries.some((e) => e.kind === 'world') ? ' and world (unless you tick it)' : ''}.</p>
        <div class="sp-list">
          ${d.entries
            .map(
              (e) => `<div class="sp-item">
              <div class="checkbox-row" style="margin:0"><input type="checkbox" data-entry="${esc(e.name)}" id="sp-${esc(e.name)}" ${e.push ? 'checked' : ''} />
                <label for="sp-${esc(e.name)}"><span class="mono">${esc(e.name)}</span> <span class="badge">${KIND[e.kind]}</span>
                <span class="faint">${[e.added && `${e.added} new`, e.changed && `${e.changed} changed`, e.removed && `${e.removed} removed`].filter(Boolean).join(', ')}</span></label></div>
              ${e.kind === 'world' ? '<div class="hint warn-text">Pushing the world replaces everything players built on live since the copy was made.</div>' : ''}
              ${e.folder ? `<details><summary class="faint">Files</summary><div class="sp-files">${e.files.map((f) => `<div><span class="sp-${f.status}">${STATUS[f.status]}</span> <span class="mono">${esc(f.path)}</span></div>`).join('')}${e.added + e.changed + e.removed > e.files.length ? '<div class="faint">…and more</div>' : ''}</div></details>` : ''}
            </div>`
            )
            .join('')}
          ${
            d.properties.length
              ? `<div class="sp-item"><div class="checkbox-row" style="margin:0"><input type="checkbox" id="sp-props" checked /><label for="sp-props"><span class="mono">server.properties</span> <span class="badge">Settings</span> <span class="faint">${d.properties.length} setting${d.properties.length === 1 ? '' : 's'}</span></label></div>
              <div class="sp-files">${d.properties.map((p) => `<div><span class="mono">${esc(p.key)}</span>: <span class="faint">${esc(p.live ?? 'not set')}</span> → ${esc(p.staging)}</div>`).join('')}</div></div>`
              : ''
          }
          ${
            d.version.settings.length || d.version.files.length
              ? `<div class="sp-item"><div class="checkbox-row" style="margin:0"><input type="checkbox" id="sp-version" /><label for="sp-version"><b>Game version</b> <span class="faint">the server jar, its libraries and the version settings</span></label></div>
              <div class="sp-files">${d.version.settings.map((v) => `<div><span class="mono">${esc(v.key)}</span>: <span class="faint">${esc(v.live ?? 'not set')}</span> → ${esc(v.staging ?? 'not set')}</div>`).join('')}${d.version.files.length ? `<div class="faint">Files: ${d.version.files.map(esc).join(', ')}</div>` : ''}</div></div>`
              : ''
          }
        </div>
        <div class="hint mt-8">A backup of ${esc(d.live.name)} is made first, so this can be undone from its Backups tab.${d.live.running ? ` ${esc(d.live.name)} is running: it stops for the push and starts again after.` : ''}</div>`;
      pushBtn.disabled = nothing;
    })
    .catch((err) => {
      body.innerHTML = `<div class="warning">${esc(err.message)}</div>`;
    });

  async function go(btn) {
    const entries = [...root.querySelectorAll('[data-entry]:checked')].map((el) => el.dataset.entry);
    const properties = Boolean(root.querySelector('#sp-props')?.checked);
    const version = Boolean(root.querySelector('#sp-version')?.checked);
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Pushing';
    try {
      const r = await api(`/api/servers/${server.id}/staging/push`, { method: 'POST', body: { entries, properties, version } });
      modal.close();
      toast(`Pushed ${r.pushed.join(', ')} to ${d.live.name}${r.restarted ? ', which is starting again' : ''}. Backup from before: ${r.backup}`, 'success', 8000);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Push';
    }
  }
}
