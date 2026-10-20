import { api } from '../../core/api.js';
import { esc, toast, fmtBytes, can, icon } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';

/* --------------------------------------------- ARK wild dinos, MC trimming */

/** ARK: one button to despawn every wild dino (tamed ones stay). Schedulable from the Schedules tab. */
export function renderDinoWipeCard(host, server) {
  if (!String(server.templateId || '').startsWith('ark-survival')) return;
  const running = ['running', 'starting'].includes(server.status);
  host.innerHTML = `
    <div class="card mb-16">
      <div class="row" style="align-items:center;gap:16px;flex-wrap:wrap">
        <div class="feature-icon">${icon('trash', 20)}</div>
        <div style="flex:1;min-width:220px">
          <h4 style="margin:0 0 4px">Wild dinos</h4>
          <div class="faint" style="font-size:13px">Despawns every wild creature so the map spawns fresh ones. Tamed dinos are not touched. To do it on a timer, add a "Wipe wild dinos" task on the Schedules tab.</div>
        </div>
        ${can('command') ? `<button class="btn btn-danger" id="dw-go" ${running ? '' : 'disabled title="Start the server first"'}>Wipe wild dinos…</button>` : ''}
      </div>
    </div>`;
  host.querySelector('#dw-go')?.addEventListener('click', async () => {
    if (!(await confirmModal('Wipe wild dinos', 'Every wild dino on the map despawns right now. Players can lose a dino they are chasing. Tamed dinos stay.', 'Wipe'))) return;
    try {
      await api(`/api/servers/${server.id}/dino-wipe`, { method: 'POST', body: {} });
      toast('Wild dinos wiped. New ones spawn in over the next minutes.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

const LIMITS = [
  [10, 'under 10 seconds (never really visited)'],
  [60, 'under 1 minute'],
  [300, 'under 5 minutes'],
  [1800, 'under 30 minutes'],
];

/** Minecraft Java: cut chunks nobody spent time in out of a world. */
export async function renderTrimCard(host, server) {
  let info;
  try {
    info = await api(`/api/servers/${server.id}/trim`);
  } catch {
    return;
  }
  if (!info.supported || !can('files.write')) return;
  const running = ['running', 'starting'].includes(server.status);
  const job = info.job;
  const busy = job?.state === 'running';
  const result = job?.state === 'done'
    ? `${job.dryRun ? 'Preview' : 'Trimmed'} ${esc(job.world)}: ${(job.removed || 0).toLocaleString()} of ${(job.chunks || 0).toLocaleString()} chunks ${job.dryRun ? 'would go' : 'removed'}, ${fmtBytes(Math.max(0, (job.bytesBefore || 0) - (job.bytesAfter || 0)))} ${job.dryRun ? 'would be saved' : 'saved'}.${job.backup ? ' Backup: ' + esc(job.backup) + '.' : ''}`
    : job?.state === 'error'
      ? `The last trim failed: ${esc(job.error)}`
      : busy
        ? `${esc(job.phase)}… ${job.regionsDone || 0} of ${job.regions || '?'} region files.`
        : '';
  host.innerHTML = `
    <div class="card mb-16">
      <h4 style="margin:0 0 4px">Trim the world</h4>
      <div class="faint" style="font-size:13px;margin-bottom:12px">Deletes chunks players barely visited (flown over, pre-generated) to shrink the world and its backups. They regenerate from the seed if someone goes there later, but anything built there that was not "inhabited" long enough is lost, so preview first. The server must be stopped.</div>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        <span class="faint">Remove chunks visited for</span>
        <select id="tr-limit" style="width:auto">${LIMITS.map(([s, l]) => `<option value="${s}" ${s === 60 ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <span class="faint">Keep</span>
        <input id="tr-radius" type="number" min="0" max="30000" value="500" style="width:90px" />
        <span class="faint">blocks around spawn</span>
      </div>
      <div class="row mt-16" style="gap:14px;flex-wrap:wrap;align-items:center">
        <label class="checkbox-row" style="margin:0"><input type="checkbox" class="tr-dim" value="overworld" checked /> Overworld</label>
        <label class="checkbox-row" style="margin:0"><input type="checkbox" class="tr-dim" value="nether" /> Nether</label>
        <label class="checkbox-row" style="margin:0"><input type="checkbox" class="tr-dim" value="end" /> The End</label>
        <label class="checkbox-row" style="margin:0"><input type="checkbox" id="tr-backup" checked /> Back up first</label>
        <div class="spacer"></div>
        <button class="btn" id="tr-preview" ${running || busy ? 'disabled' : ''} ${running ? 'title="Stop the server first"' : ''}>Preview</button>
        <button class="btn btn-danger" id="tr-go" ${running || busy ? 'disabled' : ''} ${running ? 'title="Stop the server first"' : ''}>Trim…</button>
      </div>
      ${result ? `<div class="hint" style="margin-top:12px">${result}</div>` : ''}
    </div>`;
  const options = (dryRun) => ({
    minSeconds: Number(host.querySelector('#tr-limit').value),
    protectRadius: Number(host.querySelector('#tr-radius').value),
    dimensions: [...host.querySelectorAll('.tr-dim:checked')].map((el) => el.value),
    backup: host.querySelector('#tr-backup').checked,
    dryRun,
  });
  const start = async (dryRun) => {
    try {
      await api(`/api/servers/${server.id}/trim`, { method: 'POST', body: options(dryRun) });
      renderTrimCard(host, server);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  host.querySelector('#tr-preview').addEventListener('click', () => start(true));
  host.querySelector('#tr-go').addEventListener('click', async () => {
    const o = options(false);
    if (!(await confirmModal('Trim the world', `Chunks visited for less than ${LIMITS.find(([s]) => s === o.minSeconds)?.[1].replace('under ', '') || 'the limit'} are deleted${o.backup ? ' after a backup of the whole server' : ' with no backup'}. Run a preview first if you have not.`, 'Trim'))) return;
    start(false);
  });
  clearTimeout(host._trTimer);
  if (busy) host._trTimer = setTimeout(() => host.isConnected && renderTrimCard(host, server), 2000);
}
