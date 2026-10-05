import { api } from '../../core/api.js';
import { $, esc, fmtBytes, fmtTime, icon, toast } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';

/* --------------------------------------------------------------- backups */

export async function renderBackupsTab(host, server) {
  host.innerHTML = '<div class="card"><span class="spinner"></span> Loading backups…</div>';
  const data = await api(`/api/servers/${server.id}/backups`).catch((err) => ({ backups: [], error: err.message }));

  host.innerHTML = `
    <div class="row mb-16">
      <button class="btn btn-primary" id="backup-create">Create backup</button>
      <span class="faint">Backups are plain .tar.gz archives of the whole server directory.</span>
    </div>
    <div class="card card-flush">
      <div class="table-wrap"><table>
        <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${
            data.backups.length
              ? data.backups
                  .map(
                    (b) => `<tr>
                      <td class="mono">${esc(b.name)}</td>
                      <td class="faint nowrap">${fmtBytes(b.size)}</td>
                      <td class="faint nowrap">${fmtTime(b.createdAt)}</td>
                      <td class="nowrap" style="text-align:right">
                        <a class="btn btn-sm" href="/api/servers/${esc(server.id)}/backups/${encodeURIComponent(b.name)}/download">${icon('download',12)}</a>
                        <button class="btn btn-sm" data-restore="${esc(b.name)}">Restore</button>
                        <button class="btn btn-sm btn-danger" data-del-backup="${esc(b.name)}">${icon('trash',12)}</button>
                      </td></tr>`
                  )
                  .join('')
              : '<tr><td colspan="4" class="faint">No backups yet</td></tr>'
          }
        </tbody>
      </table></div>
    </div>`;

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

  host.querySelectorAll('[data-del-backup]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (!(await confirmModal('Delete backup', `Delete ${el.dataset.delBackup}?`))) return;
      await api(`/api/servers/${server.id}/backups/${encodeURIComponent(el.dataset.delBackup)}`, { method: 'DELETE' });
      renderBackupsTab(host, server);
    })
  );
}
