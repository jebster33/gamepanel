import { api } from '../../core/api.js';
import { $, esc, fmtBytes, fmtTime, icon, toast } from '../../core/util.js';
import { confirmModal, openModal } from '../../ui/modal.js';
import { openRestorePreview } from './restore-preview.js';
import { skeleton } from '../../ui/skeleton.js';

/* --------------------------------------------------------------- backups */

/** A tick and "2 h ago", or a cross and "Failed", for the Checked column. */
function checkLabel(check) {
  if (!check) return '<span class="faint">—</span>';
  if (!check.ok) return `<span style="color:var(--danger)" title="${esc(check.error || '')}">${icon('close', 12)} Failed</span>`;
  const how = check.mode === 'read' ? 'Read end to end (not enough room to unpack it)' : `Unpacked ${check.files} files into a scratch folder`;
  return `<span style="color:var(--success)" title="${esc(how)} ${esc(fmtTime(check.at))}">${icon('check', 12)} ${esc(fmtTime(check.at))}</span>`;
}

export async function renderBackupsTab(host, server) {
  host.innerHTML = skeleton('list', 'Loading backups…');
  const data = await api(`/api/servers/${server.id}/backups`).catch((err) => ({ backups: [], error: err.message }));
  if (!host.isConnected) return; // the user moved to another tab meanwhile

  host.innerHTML = `
    <div class="row mb-16 backup-head">
      <button class="btn btn-primary" id="backup-create">Create backup</button>
      <span class="faint" style="flex:1;min-width:200px">${
        data.mode === 'incremental'
          ? `Incremental${data.encrypt ? ', encrypted' : ''}: each backup stores only what changed.${data.vault ? ` All of them take ${fmtBytes(data.vault.bytes)}.` : ''}`
          : 'Backups are plain .tar.gz archives of the whole server directory.'
      }</span>
      <button class="btn btn-sm btn-ghost" id="backup-mode">Backup type…</button>
    </div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th class="nowrap" title="Test-restored into a scratch folder">Checked</th><th class="cloud-col hidden">Cloud</th><th class="node-col hidden" id="node-col-head">Node</th><th></th></tr></thead>
        <tbody>
          ${
            data.backups.length
              ? data.backups
                  .map(
                    (b) => `<tr>
                      <td class="mono">${esc(b.name)}${b.kind === 'incremental' ? ` <span class="chip chip-sm" title="Only what changed since the backup before">${b.encrypted ? icon('lock', 11) : ''}incremental</span>` : ''}</td>
                      <td class="faint nowrap" ${b.total ? `title="Stored ${esc(fmtBytes(b.size))} new; restores ${esc(fmtBytes(b.total))}"` : ''}>${b.kind === 'incremental' ? `+${fmtBytes(b.size)}` : fmtBytes(b.size)}</td>
                      <td class="faint nowrap">${fmtTime(b.createdAt)}</td>
                      <td class="nowrap" data-check-cell="${esc(b.name)}">${checkLabel(b.check)}</td>
                      <td class="cloud-col hidden nowrap" data-copy-cloud="${esc(b.name)}"></td>
                      <td class="node-col hidden nowrap" data-copy-node="${esc(b.name)}"></td>
                      <td class="nowrap" style="text-align:right">
                        <a class="btn btn-sm" href="/api/servers/${esc(server.id)}/backups/${encodeURIComponent(b.name)}/download">${icon('download',12)}</a>
                        <button class="btn btn-sm" data-check="${esc(b.name)}" title="Test-restore it into a scratch folder to make sure it works">Check</button>
                        <button class="btn btn-sm" data-browse="${esc(b.name)}" title="Look inside and restore single files">Browse</button>
                        <button class="btn btn-sm" data-restore="${esc(b.name)}">Restore</button>
                        <button class="btn btn-sm btn-danger" data-del-backup="${esc(b.name)}">${icon('trash',12)}</button>
                      </td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="7" class="faint">No backups yet</td></tr>'
          }
        </tbody>
      </table></div>
    </div>
    <div id="cloud-only"></div>
    <div id="node-only"></div>`;

  renderCopies(host, server, data.backups, 'cloud');
  renderCopies(host, server, data.backups, 'node');
  $('#backup-mode').addEventListener('click', () => openBackupMode(server, data, () => renderBackupsTab(host, server)));

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
    el.addEventListener('click', () => openRestorePreview(server, el.dataset.restore, () => renderBackupsTab(host, server)))
  );

  host.querySelectorAll('[data-check]').forEach((el) =>
    el.addEventListener('click', async () => {
      const cell = host.querySelector(`[data-check-cell="${CSS.escape(el.dataset.check)}"]`);
      el.disabled = true;
      cell.innerHTML = '<span class="spinner"></span> Checking…';
      try {
        const result = await api(`/api/servers/${server.id}/backups/${encodeURIComponent(el.dataset.check)}/verify`, { method: 'POST', body: {} });
        cell.innerHTML = checkLabel(result);
        toast(result.ok ? `Backup is good: ${result.files} files came back intact` : `Backup failed its check: ${result.error}`, result.ok ? 'info' : 'error', result.ok ? 4200 : 9000);
      } catch (err) {
        cell.innerHTML = '';
        toast(err.message, 'error');
      } finally {
        el.disabled = false;
      }
    })
  );

  host.querySelectorAll('[data-browse]').forEach((el) => el.addEventListener('click', () => browseBackup(server, el.dataset.browse)));

  host.querySelectorAll('[data-del-backup]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete backup', `Delete ${el.dataset.delBackup}?`))) return;
      try {
        await api(`/api/servers/${server.id}/backups/${encodeURIComponent(el.dataset.delBackup)}`, { method: 'DELETE' });
      } catch (err) {
        toast(err.message, 'error');
      }
      renderBackupsTab(host, server);
    })
  );
}

/* ------------------------------------------- copies in the cloud or on a node */

const COPIES = {
  cloud: { list: 'backups/cloud', status: 'uploads', send: (n) => `backups/${n}/upload`, item: (n) => `backups/cloud/${n}`, where: () => 'the cloud', bucket: 'the bucket' },
  node: { list: 'backups/node', status: 'sends', send: (n) => `backups/node/${n}/send`, item: (n) => `backups/node/${n}`, where: (c) => c.node || 'the node', bucket: null },
};

/** Mark which backups already have a copy (in the bucket or on the node), and list the ones only there. */
async function renderCopies(host, server, local, kind) {
  const k = COPIES[kind];
  const copies = await api(`/api/servers/${server.id}/${k.list}`).catch(() => null);
  if (!copies?.enabled || !host.isConnected) return;
  const where = k.where(copies);
  const remote = new Map(copies.backups.map((b) => [b.name, b]));
  const status = copies[k.status] || {};
  host.querySelectorAll(`.${kind}-col`).forEach((el) => el.classList.remove('hidden'));
  if (kind === 'node') host.querySelector('#node-col-head').textContent = where;
  host.querySelectorAll(`[data-copy-${kind}]`).forEach((cell) => {
    const name = cell.dataset[`copy${kind[0].toUpperCase()}${kind.slice(1)}`];
    const st = status[name];
    if (name.endsWith('.snap')) cell.innerHTML = `<span class="faint" title="Copies are made of archive backups">—</span>`;
    else if (remote.has(name)) cell.innerHTML = `<span class="badge" style="color:var(--lime-text)">${icon('check', 11)} copied</span>`;
    else if (['queued', 'uploading', 'sending'].includes(st)) cell.innerHTML = `<span class="faint"><span class="spinner"></span> ${esc(st)}</span>`;
    else cell.innerHTML = `${st ? `<span class="badge bad" title="${esc(st)}">failed</span> ` : ''}<button class="btn btn-sm" data-send-${kind}="${esc(name)}">Copy</button>`;
  });
  host.querySelectorAll(`[data-send-${kind}]`).forEach((el) =>
    el.addEventListener('click', async () => {
      try {
        await api(`/api/servers/${server.id}/${k.send(encodeURIComponent(el.getAttribute(`data-send-${kind}`)))}`, { method: 'POST', body: {} });
        toast(`Copying to ${where}`);
        setTimeout(() => host.isConnected && renderBackupsTab(host, server), 1500);
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  const localNames = new Set(local.map((b) => b.name));
  const only = copies.backups.filter((b) => !localNames.has(b.name));
  const box = host.querySelector(`#${kind}-only`);
  if (copies.error) {
    box.innerHTML = `<div class="card mt-16 faint">${esc(copies.error)}</div>`;
    return;
  }
  if (!only.length) return;
  box.innerHTML = `
    <h4 class="section-title mt-16">Only in ${esc(where)}</h4>
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
                <button class="btn btn-sm btn-danger" data-del-copy="${esc(b.name)}">${icon('trash', 12)}</button>
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
        await api(`/api/servers/${server.id}/${k.item(encodeURIComponent(el.dataset.fetch))}/fetch`, { method: 'POST', body: {} });
        toast('Backup is back on the panel. Restore it from the list.');
        renderBackupsTab(host, server);
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
        el.textContent = 'Bring back';
      }
    })
  );
  box.querySelectorAll('[data-del-copy]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete copy', `Delete ${esc(el.dataset.delCopy)} from ${esc(k.bucket || where)}?`))) return;
      try {
        await api(`/api/servers/${server.id}/${k.item(encodeURIComponent(el.dataset.delCopy))}`, { method: 'DELETE' });
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
      <div id="bb-list" class="bb-list">${skeleton('lines', 'Reading the backup…')}</div>`,
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
      ${e.dir ? `<a href="#" data-open="${esc(e.path)}" class="inline-icon">${icon('folder', 13)} ${esc(label)}</a>` : `<span>${esc(label)}</span>`}
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

/** Archive or incremental backups, and encryption. */
function openBackupMode(server, data, done) {
  const modal = openModal({
    title: 'Backup type',
    width: 540,
    body: `
      <div class="choice-list">
        <label class="choice"><input type="radio" name="bm" value="archive" ${data.mode !== 'incremental' ? 'checked' : ''} />
          <div><b>Archive</b> <span class="faint">(the default)</span><div class="faint">Each backup is a complete .tar.gz you can open anywhere with tar, and copy to the cloud.</div></div></label>
        <label class="choice"><input type="radio" name="bm" value="incremental" ${data.mode === 'incremental' ? 'checked' : ''} />
          <div><b>Incremental</b><div class="faint">Files are stored in pieces, each piece once: the second backup of a big world only adds what changed, and runs faster. Restore, browse, check and download (as .tar.gz) work the same. Cloud copies stay archive-only.</div></div></label>
      </div>
      <div class="checkbox-row mt-16" id="bm-enc-row"><input type="checkbox" id="bm-enc" ${data.encrypt ? 'checked' : ''} ${data.passphraseSet ? '' : 'disabled'} />
        <label for="bm-enc">Encrypt them (AES-256)${data.passphraseSet ? '' : ' · an administrator sets the passphrase under Settings → Backups first'}</label></div>
      <div class="hint">Switching keeps the backups you have; they stay restorable from the list.</div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async (btn) => {
          btn.disabled = true;
          const mode = document.querySelector('input[name="bm"]:checked').value;
          try {
            await api(`/api/servers/${server.id}/backup-mode`, { method: 'PUT', body: { mode, encrypt: $('#bm-enc').checked } });
            modal.close();
            toast(mode === 'incremental' ? 'New backups are incremental' : 'New backups are archives');
            done();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
          }
        },
      },
    ],
  });
  const sync = () => $('#bm-enc-row').classList.toggle('hidden', document.querySelector('input[name="bm"]:checked').value !== 'incremental');
  document.querySelectorAll('input[name="bm"]').forEach((r) => r.addEventListener('change', sync));
  sync();
}
