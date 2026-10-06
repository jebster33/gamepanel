import { api } from '../../core/api.js';
import { $, esc, fmtBytes, fmtTime, icon, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';

/* --------------------------------------------------------------- backups */

export async function renderBackupsTab(host, server) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading backups…</div>';
  const data = await api(`/api/servers/${server.id}/backups`).catch((err) => ({ backups: [], error: err.message }));
  if (!host.isConnected) return; // the user moved to another tab meanwhile

  host.innerHTML = `
    <div class="row mb-16">
      <button class="btn btn-primary" id="backup-create">Create backup</button>
      <span class="faint">Backups are plain .tar.gz archives of the whole server directory.</span>
    </div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th class="cloud-col hidden">Cloud</th><th></th></tr></thead>
        <tbody>
          ${
            data.backups.length
              ? data.backups
                  .map(
                    (b) => `<tr>
                      <td class="mono">${esc(b.name)}</td>
                      <td class="faint nowrap">${fmtBytes(b.size)}</td>
                      <td class="faint nowrap">${fmtTime(b.createdAt)}</td>
                      <td class="cloud-col hidden nowrap" data-cloud="${esc(b.name)}"></td>
                      <td class="nowrap" style="text-align:right">
                        <a class="btn btn-sm" href="/api/servers/${esc(server.id)}/backups/${encodeURIComponent(b.name)}/download">${icon('download',12)}</a>
                        <button class="btn btn-sm" data-browse="${esc(b.name)}" title="Look inside and restore single files">Browse</button>
                        <button class="btn btn-sm" data-restore="${esc(b.name)}">Restore</button>
                        <button class="btn btn-sm btn-danger" data-del-backup="${esc(b.name)}">${icon('trash',12)}</button>
                      </td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="5" class="faint">No backups yet</td></tr>'
          }
        </tbody>
      </table></div>
    </div>
    <div id="cloud-only"></div>`;

  renderCloudState(host, server, data.backups);

  $('#backup-create').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Creating…';
    try {
      await api(`/api/servers/${server.id}/backups`, { method: 'POST', body: {} });
      toast('Backup created');
      renderBackupsTab(host, server);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Create backup';
    }
  });

  host.querySelectorAll('[data-restore]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Restore backup', 'This overwrites current files with the archive contents. The server must be stopped. Continue?')))
        return;
      try {
        await api(`/api/servers/${server.id}/backups/${encodeURIComponent(el.dataset.restore)}/restore`, { method: 'POST', body: {} });
        toast('Backup restored');
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  host.querySelectorAll('[data-browse]').forEach((el) => el.addEventListener('click', () => browseBackup(server, el.dataset.browse)));

  host.querySelectorAll('[data-del-backup]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete backup', `Delete ${el.dataset.delBackup}?`))) return;
      await api(`/api/servers/${server.id}/backups/${encodeURIComponent(el.dataset.delBackup)}`, { method: 'DELETE' });
      renderBackupsTab(host, server);
    })
  );
}

/* ---------------------------------------------------------- cloud copies */

/** Mark which backups are already in the bucket, and list the ones only there. */
async function renderCloudState(host, server, local) {
  const cloud = await api(`/api/servers/${server.id}/backups/cloud`).catch(() => null);
  if (!cloud?.enabled || !host.isConnected) return;
  const remote = new Map(cloud.backups.map((b) => [b.name, b]));
  host.querySelectorAll('.cloud-col').forEach((el) => el.classList.remove('hidden'));
  host.querySelectorAll('[data-cloud]').forEach((cell) => {
    const name = cell.dataset.cloud;
    const upload = cloud.uploads[name];
    if (remote.has(name)) cell.innerHTML = '<span class="badge" style="color:var(--lime-text)">✓ copied</span>';
    else if (upload === 'queued' || upload === 'uploading') cell.innerHTML = `<span class="faint"><span class="spinner"></span> ${upload}</span>`;
    else
      cell.innerHTML = `${upload ? `<span class="badge bad" title="${esc(upload)}">failed</span> ` : ''}<button class="btn btn-sm" data-upload="${esc(name)}">Copy</button>`;
  });
  host.querySelectorAll('[data-upload]').forEach((el) =>
    el.addEventListener('click', async () => {
      try {
        await api(`/api/servers/${server.id}/backups/${encodeURIComponent(el.dataset.upload)}/upload`, { method: 'POST', body: {} });
        toast('Copying to the cloud');
        setTimeout(() => host.isConnected && renderBackupsTab(host, server), 1500);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  const localNames = new Set(local.map((b) => b.name));
  const only = cloud.backups.filter((b) => !localNames.has(b.name));
  const box = host.querySelector('#cloud-only');
  if (cloud.error) {
    box.innerHTML = `<div class="card mt-16 faint">${esc(cloud.error)}</div>`;
    return;
  }
  if (!only.length) return;
  box.innerHTML = `
    <h4 class="section-title mt-16">Only in the cloud</h4>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <tbody>${only
          .map(
            (b) => `<tr>
              <td class="mono">${esc(b.name)}</td>
              <td class="faint nowrap">${fmtBytes(b.size)}</td>
              <td class="faint nowrap">${fmtTime(b.createdAt)}</td>
              <td class="nowrap" style="text-align:right">
                <button class="btn btn-sm" data-fetch="${esc(b.name)}" title="Download it onto the panel, then restore it like any backup">Bring back</button>
                <button class="btn btn-sm btn-danger" data-del-cloud="${esc(b.name)}">${icon('trash', 12)}</button>
              </td></tr>`
          )
          .join('')}</tbody>
      </table></div>
    </div>`;
  box.querySelectorAll('[data-fetch]').forEach((el) =>
    el.addEventListener('click', async () => {
      el.disabled = true;
      el.innerHTML = '<span class="spinner"></span> Downloading…';
      try {
        await api(`/api/servers/${server.id}/backups/cloud/${encodeURIComponent(el.dataset.fetch)}/fetch`, { method: 'POST', body: {} });
        toast('Backup is back on the panel. Restore it from the list.');
        renderBackupsTab(host, server);
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
        el.textContent = 'Bring back';
      }
    })
  );
  box.querySelectorAll('[data-del-cloud]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete cloud copy', `Delete ${el.dataset.delCloud} from the bucket?`))) return;
      try {
        await api(`/api/servers/${server.id}/backups/cloud/${encodeURIComponent(el.dataset.delCloud)}`, { method: 'DELETE' });
        renderBackupsTab(host, server);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

/* ------------------------------------------------ single-file restore */

/** Walk a backup like a folder and put back just the files that broke. */
async function browseBackup(server, name) {
  const modal = openModal({
    title: 'Restore files',
    width: 680,
    body: `
      <div class="faint mono" style="font-size:12px;margin-bottom:10px">${esc(name)}</div>
      <input id="bb-q" type="search" placeholder="Search every file in this backup" autocomplete="off" spellcheck="false" />
      <div id="bb-crumbs" class="bb-crumbs"></div>
      <div id="bb-list" class="bb-list"><div class="faint"><span class="spinner"></span> Reading the backup…</div></div>`,
    actions: [
      { label: 'Cancel', close: true },
      { label: 'Restore selected', primary: true, onClick: (btn) => restoreSelected(btn) },
    ],
  });
  const root = document.querySelector('.modal-backdrop:last-child');
  const pick = new Set();
  let entries = [];
  let cwd = '';
  try {
    const data = await api(`/api/servers/${server.id}/backups/${encodeURIComponent(name)}/contents`);
    entries = data.entries;
    if (data.truncated) toast('This backup is very large; only the first 50,000 entries are shown', 'warn');
  } catch (err) {
    root.querySelector('#bb-list').innerHTML = `<div class="faint">${esc(err.message)}</div>`;
    return;
  }
  const footBtn = root.querySelector('.modal-foot .btn-primary');
  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
  const row = (e, label) => `
    <label class="bb-row">
      <input type="checkbox" data-pick="${esc(e.path)}" ${pick.has(e.path) ? 'checked' : ''} />
      ${e.dir ? `<a href="#" data-open="${esc(e.path)}">📁 ${esc(label)}</a>` : `<span>${esc(label)}</span>`}
      <span class="faint mono">${e.dir ? '' : fmtBytes(e.size)}</span>
    </label>`;

  function draw() {
    const q = root.querySelector('#bb-q').value.trim().toLowerCase();
    const crumbs = root.querySelector('#bb-crumbs');
    let shown;
    if (q) {
      crumbs.innerHTML = '';
      shown = entries.filter((e) => e.path.toLowerCase().includes(q)).slice(0, 300).map((e) => row(e, e.path));
    } else {
      const parts = cwd ? cwd.split('/') : [];
      crumbs.innerHTML = [`<a href="#" data-open="">${esc(server.name)}</a>`, ...parts.map((part, i) => `<a href="#" data-open="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</a>`)].join(' / ');
      shown = entries
        .filter((e) => parentOf(e.path) === cwd)
        .sort((a, b) => b.dir - a.dir || a.path.localeCompare(b.path))
        .map((e) => row(e, baseName(e.path)));
    }
    root.querySelector('#bb-list').innerHTML = shown.length ? shown.join('') : '<div class="faint">Nothing here.</div>';
    footBtn.textContent = pick.size ? `Restore ${pick.size} selected` : 'Restore selected';
    footBtn.disabled = !pick.size;
  }

  root.querySelector('#bb-q').addEventListener('input', draw);
  root.addEventListener('click', (event) => {
    const link = event.target.closest('[data-open]');
    if (!link) return;
    event.preventDefault();
    cwd = link.dataset.open;
    root.querySelector('#bb-q').value = '';
    draw();
  });
  root.addEventListener('change', (event) => {
    const box = event.target.closest('[data-pick]');
    if (!box) return;
    if (box.checked) pick.add(box.dataset.pick);
    else pick.delete(box.dataset.pick);
    draw();
  });
  draw();

  async function restoreSelected(btn) {
    const paths = [...pick];
    if (!(await confirmModal('Restore files', `Put back ${paths.length === 1 ? paths[0] : `${paths.length} files and folders`} from this backup? The current versions are overwritten; everything else is left alone.`))) return;
    btn.disabled = true;
    try {
      const result = await api(`/api/servers/${server.id}/backups/${encodeURIComponent(name)}/restore-files`, { method: 'POST', body: { paths } });
      modal.close();
      toast(result.running ? 'Restored. Restart the server so it picks the files up.' : 'Restored', 'info', 6000);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  }
}
