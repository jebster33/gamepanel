import { api } from '../../core/api.js';
import { $, $$, can, esc, fmtBytes, fmtTime, toast } from '../../core/util.js';
import { diffStats, lineDiff, renderDiff } from '../../ui/diff.js';
import { confirmModal, openModal } from '../../ui/modal.js';
import { skeleton } from '../../ui/skeleton.js';

/* -------------------------------------------------------- config history */

// Every save through the panel is kept. Pick a version to see what changed
// between it and the file as it is now, and put it back with one click.

const qs = (server, rel, extra = '') => `/api/servers/${encodeURIComponent(server.id)}/config-history/${extra}?path=${encodeURIComponent(rel)}`;

/** Files with history; picking one opens its versions. */
export async function openConfigHistoryList(server) {
  const data = await api(`/api/servers/${encodeURIComponent(server.id)}/config-history`).catch((err) => ({ error: err.message, files: [] }));
  const modal = openModal({
    title: 'Config history',
    width: 640,
    body: data.files.length
      ? `<p class="faint" style="margin-top:0">Every save made in the panel is kept (the last 50 per file), with what the file held before the first one.</p>
         <div class="table-wrap"><table>
           <thead><tr><th>File</th><th class="nowrap">Versions</th><th class="nowrap">Last change</th></tr></thead>
           <tbody>${data.files
             .map(
               (f) => `<tr><td><a data-history-file="${esc(f.path)}" class="mono">${esc(f.path)}</a></td><td>${f.versions}</td><td class="faint nowrap">${fmtTime(f.lastAt)} · ${esc(f.lastBy)}</td></tr>`
             )
             .join('')}</tbody>
         </table></div>`
      : `<div class="faint">${esc(data.error || 'No history yet. Files saved in the editor or on the Game settings tab show up here.')}</div>`,
    actions: [{ label: 'Close', close: true }],
  });
  $$('[data-history-file]').forEach((a) =>
    a.addEventListener('click', () => {
      modal.close();
      openConfigHistory(server, a.dataset.historyFile);
    })
  );
}

/** One file's versions, each compared with the file as it is now. */
export async function openConfigHistory(server, rel, onReverted) {
  let list;
  let current;
  try {
    [list, current] = await Promise.all([
      api(qs(server, rel, 'versions')),
      api(`/api/servers/${encodeURIComponent(server.id)}/files/content?path=${encodeURIComponent(rel)}`).catch(() => ({ content: '' })),
    ]);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (!list.versions.length) {
    toast('This file has no saved versions yet', 'warn');
    return;
  }
  const canRevert = can('files.write', server.id);
  const modal = openModal({
    title: `History of ${esc(rel)}`,
    width: 1000,
    body: `
      <div class="history-grid">
        <div class="history-list">${list.versions
          .map(
            (v, i) => `<button class="history-item ${i === 0 ? 'active' : ''}" data-version="${esc(v.id)}">
              <b>${fmtTime(v.at)}</b>
              <span class="faint">${esc(v.by)} · ${esc(v.source)} · ${fmtBytes(v.size)}</span>
              ${v.note ? `<span class="faint">${esc(v.note)}</span>` : ''}
            </button>`
          )
          .join('')}</div>
        <div>
          <div class="row mb-8" style="gap:8px">
            <span class="faint" id="history-summary" style="flex:1"></span>
            ${canRevert ? '<button class="btn btn-sm btn-primary" id="history-revert">Put this version back</button>' : ''}
          </div>
          <div id="history-diff">${skeleton('lines', 'Loading the change…')}</div>
        </div>
      </div>`,
    actions: [{ label: 'Close', close: true }],
  });

  let selected = list.versions[0].id;
  const show = async (id) => {
    selected = id;
    $$('.history-item').forEach((b) => b.classList.toggle('active', b.dataset.version === id));
    $('#history-diff').innerHTML = skeleton('lines', 'Loading the change…');
    const version = await api(`${qs(server, rel, 'version')}&version=${encodeURIComponent(id)}`).catch((err) => ({ error: err.message }));
    if (!$('#history-diff') || selected !== id) return;
    if (version.error) {
      $('#history-diff').innerHTML = `<div class="faint">${esc(version.error)}</div>`;
      return;
    }
    // From that version to now: what putting it back would undo.
    const rows = lineDiff(version.content, current.content);
    const { added, removed } = diffStats(rows);
    $('#history-summary').textContent = added || removed ? `Since this version: ${added} line${added === 1 ? '' : 's'} added, ${removed} removed` : 'The file is the same as this version now';
    $('#history-diff').innerHTML = renderDiff(rows);
    const revert = $('#history-revert');
    if (revert) revert.disabled = !(added || removed);
  };
  $$('.history-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.version)));
  $('#history-revert')?.addEventListener('click', async () => {
    if (!(await confirmModal('Put this version back', `${rel} goes back to how it was. The current content stays in the history, so this can be undone too. Restart the server for it to take effect.`, 'Put it back'))) return;
    try {
      await api(`/api/servers/${encodeURIComponent(server.id)}/config-history/revert`, { method: 'POST', body: { path: rel, version: selected } });
      toast(`${rel} reverted`);
      modal.close();
      onReverted?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  show(selected);
}
