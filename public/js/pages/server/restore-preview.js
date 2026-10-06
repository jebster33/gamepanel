import { api } from '../../core/api.js';
import { esc, fmtBytes, fmtDuration, fmtTime, toast } from '../../core/util.js';
import { openModal } from '../../ui/modal.js';

/* --------------------------------------------- what a full restore would do */

const kpi = (label, value, sub) => `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div>${sub ? `<div class="faint" style="font-size:11.5px">${esc(sub)}</div>` : ''}</div>`;

function fileList(title, files, total, note = (f) => fmtBytes(f.size)) {
  if (!files.length) return '';
  return `<details class="rp-files"><summary>${esc(title)} <span class="faint">${total}</span></summary>
    <div class="rp-list">${files.map((f) => `<div><span class="mono">${esc(f.path)}</span><span class="faint">${esc(note(f))}</span></div>`).join('')}${total > files.length ? `<div class="faint">and ${total - files.length} more</div>` : ''}</div>
  </details>`;
}

export function openRestorePreview(server, name, done) {
  const modal = openModal({
    title: 'Restore backup',
    width: 680,
    body: '<div id="rp-body"><span class="spinner"></span> Comparing the backup with the server as it is now…</div>',
    actions: [
      { label: 'Cancel', close: true },
      { label: 'Restore', danger: true, onClick: (btn) => go(btn) },
    ],
  });
  const root = document.querySelector('.modal-backdrop:last-child');
  const body = root.querySelector('#rp-body');
  const restoreBtn = [...root.querySelectorAll('.modal-foot button')].find((b) => b.textContent.trim() === 'Restore');
  if (restoreBtn) restoreBtn.disabled = true;
  let p = null;

  api(`/api/servers/${server.id}/backups/${encodeURIComponent(name)}/preview`)
    .then((data) => {
      p = data;
      if (!body.isConnected) return;
      const c = p.counts;
      const jars = Object.entries(p.jars);
      body.innerHTML = `
        <p style="margin-top:0">The backup is from <b>${esc(fmtTime(p.backup.createdAt))}</b> (${esc(fmtDuration(Date.now() - p.backup.createdAt))} ago). Anything done on the server since then is lost in the files it puts back.</p>
        ${p.running ? '<div class="warning mb-8">The server is running. Stop it before restoring.</div>' : ''}
        <div class="kpi-grid kpi-small mb-16">
          ${kpi('Come back', c.comeBack, c.comeBack ? fmtBytes(p.bytes.comeBack) : 'deleted since')}
          ${kpi('Go back', c.changed, 'changed since')}
          ${kpi('Added since', c.addedSince, 'stay, unless below')}
          ${kpi('Unchanged', c.same, 'files')}
        </div>
        ${
          p.areas.length
            ? `<div class="table-wrap mb-16"><table class="table rp-areas"><thead><tr><th>Folder</th><th>Come back</th><th>Go back</th><th>Added since</th></tr></thead><tbody>
            ${p.areas.map((a) => `<tr><td class="mono">${esc(a.area)}</td><td>${a.comeBack || '<span class="faint">0</span>'}</td><td>${a.changed || '<span class="faint">0</span>'}</td><td>${a.addedSince || '<span class="faint">0</span>'}</td></tr>`).join('')}
          </tbody></table></div>`
            : '<p class="faint">The server already matches this backup.</p>'
        }
        ${jars
          .map(
            ([dir, j]) => `<div class="mb-8"><b>${esc(dir === 'plugins' ? 'Plugins' : 'Mods')}</b>
              ${j.comeBack.length ? `<div class="rp-jars"><span class="badge accent">Come back</span> ${j.comeBack.map((x) => `<span class="mono">${esc(x)}</span>`).join(', ')}</div>` : ''}
              ${j.addedSince.length ? `<div class="rp-jars"><span class="badge warn">Added since</span> ${j.addedSince.map((x) => `<span class="mono">${esc(x)}</span>`).join(', ')}</div>` : ''}
            </div>`
          )
          .join('')}
        ${
          p.properties.length
            ? `<details class="rp-files" ${p.properties.length <= 8 ? 'open' : ''}><summary>server.properties <span class="faint">${p.properties.length} setting${p.properties.length === 1 ? '' : 's'} differ</span></summary><div class="table-wrap"><table class="table"><thead><tr><th>Setting</th><th>Now</th><th>Back to</th></tr></thead><tbody>
            ${p.properties.map((x) => `<tr><td class="mono">${esc(x.key)}</td><td class="mono">${x.now === null ? '<span class="faint">not set</span>' : esc(x.now)}</td><td class="mono">${x.then === null ? '<span class="faint">not set</span>' : esc(x.then)}</td></tr>`).join('')}
          </tbody></table></div></details>`
            : ''
        }
        ${fileList('Files that go back', p.changed, c.changed, (f) => `changed ${fmtTime(f.modified)}`)}
        ${fileList('Files that come back', p.comeBack, c.comeBack)}
        ${fileList('Files added since', p.addedSince, c.addedSince, (f) => `added ${fmtTime(f.modified)}`)}
        ${p.truncated ? '<div class="hint">Very large server: only part of the files were compared.</div>' : ''}
        <div class="checkbox-row mt-8"><input type="checkbox" id="rp-safety" checked /><label for="rp-safety">Back up the server as it is now first, so this can be undone</label></div>
        ${c.addedSince ? `<div class="checkbox-row"><input type="checkbox" id="rp-exact" /><label for="rp-exact">Make it exactly like the backup: also delete the ${c.addedSince} file${c.addedSince === 1 ? '' : 's'} added since</label></div>` : ''}`;
      if (restoreBtn) restoreBtn.disabled = p.running;
    })
    .catch((err) => {
      body.innerHTML = `<div class="warning">${esc(err.message)}</div><p class="faint">You can still restore without the preview.</p>`;
      if (restoreBtn) restoreBtn.disabled = false;
    });

  async function go(btn) {
    const backupFirst = root.querySelector('#rp-safety')?.checked ?? true;
    const exact = Boolean(root.querySelector('#rp-exact')?.checked);
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${backupFirst ? 'Backing up, then restoring' : 'Restoring'}`;
    try {
      const r = await api(`/api/servers/${server.id}/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', body: { backupFirst, exact } });
      modal.close();
      toast(`Backup restored${r.removed ? `, ${r.removed} newer files removed` : ''}${r.safety ? '. The state before it is in a new backup.' : ''}`, 'success', 6000);
      done?.();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Restore';
    }
  }
}
