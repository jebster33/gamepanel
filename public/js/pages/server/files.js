import { api } from '../../core/api.js';
import { state } from '../../core/state.js';
import { $, esc, fmtBytes, fmtTime, icon, toast } from '../../core/util.js';
import { confirmModal, openModal, promptModal } from '../../ui/modal.js';
import { openConfigHistory, openConfigHistoryList } from './config-history.js';

/* ----------------------------------------------------------------- files */

export async function renderFilesTab(host, server, dirPath) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading files…</div>';
  let data;
  try {
    data = await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(dirPath)}`);
  } catch (err) {
    host.innerHTML = `<div class="card">Could not list files: ${esc(err.message)}</div>`;
    return;
  }
  if (!host.isConnected) return; // the user moved to another tab meanwhile

  const parts = String(data.path || '').split('/').filter(Boolean);
  const crumbs = [`<a data-dir="">${esc(server.name)}</a>`];
  parts.forEach((part, i) => {
    crumbs.push(`<span class="faint">/</span><a data-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</a>`);
  });

  const isArchive = (name) => /\.(zip|tar|tar\.gz|tgz|tar\.xz|tar\.bz2)$/i.test(name);

  host.innerHTML = `
    <div class="row mb-16">
      <div class="file-path">${crumbs.join(' ')}</div>
      <div style="flex:1"></div>
      <span class="faint" id="file-selection" style="font-size:12.5px"></span>
      <button class="btn btn-sm hidden" id="file-compress">${icon('archive',12)} Compress</button>
      <button class="btn btn-sm btn-danger hidden" id="file-delete-selected">${icon('trash',12)} Delete</button>
      <button class="btn btn-sm" id="file-search" title="Find a file, or a setting inside config files">Search</button>
      <button class="btn btn-sm" id="file-history" title="Earlier versions of files saved in the panel">History</button>
      <button class="btn btn-sm hidden" id="file-sftp" title="Connect with FileZilla, WinSCP or another SFTP app">SFTP</button>
      <button class="btn btn-sm" id="file-new-folder">New folder</button>
      <button class="btn btn-sm" id="file-new-file">New file</button>
      <button class="btn btn-sm btn-primary" id="file-upload">${icon('upload',12)} Upload</button>
      <input type="file" id="file-input" class="hidden" multiple />
    </div>

    <div class="card card-flush dropzone" id="file-dropzone">
      <div class="dropzone-hint" id="dropzone-hint">Drop files here to upload into <span class="mono">${esc(
        data.path || '/'
      )}</span></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th style="width:34px"><input type="checkbox" id="file-select-all" /></th>
          <th>Name</th><th class="nowrap">Size</th><th class="nowrap">Modified</th><th></th>
        </tr></thead>
        <tbody>
          ${
            parts.length
              ? `<tr><td></td><td colspan="4"><a data-dir="${esc(parts.slice(0, -1).join('/'))}">${icon('folder',13)} ..</a></td></tr>`
              : ''
          }
          ${data.items
            .map(
              (item) => `
            <tr>
              <td><input type="checkbox" class="file-check" data-path="${esc(item.path)}" /></td>
              <td><span class="file-name" data-${item.directory ? 'dir' : 'file'}="${esc(item.path)}">
                ${item.directory ? icon('folder', 14) : isArchive(item.name) ? icon('archive', 14) : icon('file', 14)} ${esc(item.name)}</span></td>
              <td class="faint nowrap">${item.directory ? '—' : fmtBytes(item.size)}</td>
              <td class="faint nowrap">${fmtTime(item.modified)}</td>
              <td class="nowrap" style="text-align:right">
                ${
                  isArchive(item.name)
                    ? `<button class="btn btn-sm" data-extract="${esc(item.path)}" title="Unpack here">Unpack</button>`
                    : ''
                }
                <button class="btn btn-sm" data-rename="${esc(item.path)}" title="Rename or move">${icon('edit',12)}</button>
                ${
                  item.directory
                    ? ''
                    : `<a class="btn btn-sm" href="/api/servers/${esc(server.id)}/files/download?path=${encodeURIComponent(
                        item.path
                      )}" title="Download">${icon('download',12)}</a>`
                }
                <button class="btn btn-sm btn-danger" data-delete="${esc(item.path)}">${icon('trash',12)}</button>
              </td>
            </tr>`
            )
            .join('')}
          ${data.items.length ? '' : '<tr><td colspan="5" class="faint">This folder is empty — drop files here or use Upload</td></tr>'}
        </tbody>
      </table></div>
    </div>`;

  const refresh = () => renderFilesTab(host, server, dirPath);

  host.querySelectorAll('[data-dir]').forEach((el) =>
    el.addEventListener('click', () => renderFilesTab(host, server, el.dataset.dir))
  );
  host.querySelectorAll('[data-file]').forEach((el) =>
    el.addEventListener('click', () => openFileEditor(server, el.dataset.file, refresh))
  );
  $('#file-search').addEventListener('click', () => openFileSearch(server, host));
  // Shown when SFTP is on: how to reach these files from an SFTP app.
  api('/api/sftp')
    .then((sftp) => {
      const btn = $('#file-sftp');
      if (!sftp.enabled || !btn) return;
      btn.classList.remove('hidden');
      btn.addEventListener('click', () => {
        const host = location.hostname;
        const user = `${state.user.username}.${server.id}`;
        openModal({
          title: 'Connect with SFTP',
          width: 520,
          body: `<p class="faint" style="margin-top:0">Use FileZilla, WinSCP, Cyberduck or <span class="mono">sftp</span> with your panel password${state.user.twoFactor ? ' (you will be asked for your authenticator code too)' : ''}.</p>
            <div class="form-grid">
              <label><span>Host</span><input class="mono" readonly value="${esc(host)}" /></label>
              <label><span>Port</span><input class="mono" readonly value="${esc(sftp.port)}" /></label>
            </div>
            <label class="field mt-16"><span>Username (this server only)</span><input class="mono" readonly value="${esc(user)}" /></label>
            <div class="hint">Or sign in as <span class="mono">${esc(state.user.username)}</span> to see every server you can browse, one folder each.${sftp.fingerprint ? ` The server's key is <span class="mono">${esc(sftp.fingerprint)}</span>.` : ''}</div>
            <label class="field mt-16"><span>Command line</span><input class="mono" readonly value="${esc(`sftp -P ${sftp.port} ${user}@${host}`)}" /></label>`,
          actions: [{ label: 'Close', close: true }],
        });
      });
    })
    .catch(() => {});

  $('#file-history').addEventListener('click', () => openConfigHistoryList(server));

  /* selection ------------------------------------------------------------ */

  const checks = [...host.querySelectorAll('.file-check')];
  const selected = () => checks.filter((c) => c.checked).map((c) => c.dataset.path);
  const updateSelection = () => {
    const count = selected().length;
    $('#file-selection').textContent = count ? `${count} selected` : '';
    $('#file-compress').classList.toggle('hidden', count === 0);
    $('#file-delete-selected').classList.toggle('hidden', count === 0);
  };
  checks.forEach((c) => c.addEventListener('change', updateSelection));
  $('#file-select-all').addEventListener('change', (event) => {
    checks.forEach((c) => (c.checked = event.target.checked));
    updateSelection();
  });

  $('#file-compress').addEventListener('click', async () => {
    const paths = selected();
    const name = await promptModal('Compress', 'Archive name', `archive-${Date.now()}.tar.gz`);
    if (!name) return;
    try {
      const res = await api(`/api/servers/${server.id}/files/compress`, { method: 'POST', body: { paths, name } });
      toast(`Created ${res.name} (${fmtBytes(res.size)})`);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#file-delete-selected').addEventListener('click', async () => {
    const paths = selected();
    if (!(await confirmModal('Delete files', `Delete ${paths.length} item(s)? This cannot be undone.`, 'Delete'))) return;
    for (const path of paths) {
      await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).catch((err) =>
        toast(err.message, 'error')
      );
    }
    toast('Deleted');
    refresh();
  });

  /* per-row actions ------------------------------------------------------ */

  host.querySelectorAll('[data-extract]').forEach((el) =>
    el.addEventListener('click', async () => {
      el.disabled = true;
      el.innerHTML = '<span class="spinner"></span>';
      try {
        await api(`/api/servers/${server.id}/files/extract`, { method: 'POST', body: { path: el.dataset.extract } });
        toast('Archive unpacked');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
        el.textContent = 'Unpack';
      }
    })
  );

  host.querySelectorAll('[data-rename]').forEach((el) =>
    el.addEventListener('click', async () => {
      const from = el.dataset.rename;
      const to = await promptModal('Rename or move', 'New path (relative to the server root)', from);
      if (!to || to === from) return;
      try {
        await api(`/api/servers/${server.id}/files/rename`, { method: 'POST', body: { from, to } });
        toast('Moved');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  host.querySelectorAll('[data-delete]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete', `Delete “${el.dataset.delete}”? This cannot be undone.`, 'Delete'))) return;
      try {
        await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(el.dataset.delete)}`, { method: 'DELETE' });
        toast('Deleted');
        refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  /* creating and uploading ----------------------------------------------- */

  $('#file-new-folder').addEventListener('click', async () => {
    const name = await promptModal('New folder', 'Folder name');
    if (!name) return;
    await api(`/api/servers/${server.id}/files/mkdir`, { method: 'POST', body: { path: joinPath(dirPath, name) } });
    refresh();
  });

  $('#file-new-file').addEventListener('click', async () => {
    const name = await promptModal('New file', 'File name');
    if (!name) return;
    await api(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(joinPath(dirPath, name))}`, {
      method: 'PUT',
      body: { content: '' },
    });
    refresh();
  });

  async function uploadFiles(fileList) {
    let done = 0;
    for (const file of fileList) {
      try {
        const res = await fetch(
          `/api/servers/${server.id}/files/upload?path=${encodeURIComponent(joinPath(dirPath, file.name))}`,
          { method: 'POST', body: file, credentials: 'same-origin' }
        );
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
        done++;
        toast(`Uploaded ${file.name}`);
      } catch (err) {
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    if (done) refresh();
  }

  $('#file-upload').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (event) => uploadFiles([...event.target.files]));

  // Drag and drop straight onto the listing — the quickest way to add mods.
  const dropzone = $('#file-dropzone');
  ['dragenter', 'dragover'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragging');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      if (type === 'dragleave' && dropzone.contains(event.relatedTarget)) return;
      dropzone.classList.remove('dragging');
    })
  );
  dropzone.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) uploadFiles(files);
  });
}

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

async function openFileEditor(server, filePath, onClose) {
  let data;
  try {
    data = await api(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(filePath)}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const modal = openModal({
    title: esc(filePath),
    width: 900,
    body: `<textarea class="editor" id="file-editor" spellcheck="false">${esc(data.content)}</textarea>`,
    actions: [
      {
        label: 'History',
        onClick: () => {
          modal.close();
          openConfigHistory(server, filePath, onClose);
        },
      },
      { label: 'Cancel', close: true },
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          const problem = lintConfig(filePath, $('#file-editor').value);
          if (problem && !(await confirmModal('This file has a mistake', `${problem} The server may refuse to load it, or reset it to defaults. Save anyway?`))) return;
          try {
            await api(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(filePath)}`, {
              method: 'PUT',
              body: { content: $('#file-editor').value },
            });
            toast('Saved');
            modal.close();
            onClose?.();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
    ],
  });
}

/**
 * Catch the config mistakes that most often stop a server: broken JSON, and
 * tabs in YAML (plugin configs), which YAML does not allow for indenting.
 */
export function lintConfig(filePath, text) {
  const ext = filePath.toLowerCase().split('.').pop();
  if (ext === 'json' || ext === 'mcmeta') {
    try {
      if (text.trim()) JSON.parse(text);
    } catch (err) {
      const pos = Number(/position (\d+)/.exec(err.message)?.[1]);
      const line = Number.isFinite(pos) ? text.slice(0, pos).split('\n').length : null;
      return `The JSON is not valid${line ? ` around line ${line}` : ''} (${err.message}).`;
    }
  }
  if (ext === 'yml' || ext === 'yaml') {
    const lines = text.split('\n');
    const tab = lines.findIndex((l) => /^ *\t/.test(l));
    if (tab >= 0) return `Line ${tab + 1} is indented with a tab. YAML only allows spaces.`;
  }
  return null;
}

/** Find files by name, or text inside config files. */
function openFileSearch(server, host) {
  const modal = openModal({
    title: 'Search files',
    width: 760,
    body: `<div class="input-row"><input id="fs-q" class="search-input" style="flex:1;max-width:none;width:auto" placeholder="A file name or a setting, e.g. max-players or spawn-protection" /><button class="btn btn-primary" id="fs-go">Search</button></div>
      <p class="faint" id="fs-note" style="margin:8px 0">Searches names and text in config files. Worlds, logs and libraries are skipped.</p>
      <div id="fs-out" class="fs-results"></div>`,
  });
  const out = document.getElementById('fs-out');
  const note = document.getElementById('fs-note');
  const run = async () => {
    const q = document.getElementById('fs-q').value.trim();
    if (q.length < 2) return;
    note.textContent = 'Searching…';
    try {
      const { results, truncated } = await api(`/api/servers/${server.id}/files/search?q=${encodeURIComponent(q)}`);
      note.textContent = results.length ? `${results.length}${truncated ? '+' : ''} match${results.length === 1 ? '' : 'es'}` : 'Nothing found.';
      out.innerHTML = results
        .map((r) => `<a href="#" class="fs-hit" data-open="${esc(r.path)}"><span class="mono">${esc(r.path)}${r.line ? `<span class="faint">:${r.line}</span>` : ''}</span>${r.text ? `<span class="faint mono">${esc(r.text)}</span>` : ''}</a>`)
        .join('');
    } catch (err) {
      note.textContent = err.message;
    }
  };
  document.getElementById('fs-go').addEventListener('click', run);
  document.getElementById('fs-q').addEventListener('keydown', (e) => e.key === 'Enter' && run());
  out.addEventListener('click', (event) => {
    const hit = event.target.closest('[data-open]');
    if (!hit) return;
    event.preventDefault();
    modal.close();
    const file = hit.dataset.open;
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    renderFilesTab(host, server, dir).then(() => openFileEditor(server, file, () => renderFilesTab(host, server, dir)));
  });
}
