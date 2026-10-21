import { api } from '../../core/api.js';
import { esc, toast, fmtBytes } from '../../core/util.js';
import { openModal } from '../../ui/modal.js';

/* -------------------------------------- singleplayer world / .mcworld import */

/*
 * Upload a zip of a singleplayer world (or a Bedrock .mcworld). The panel
 * finds the world inside it, unpacks it safely, moves the Nether and End
 * where the server type expects them, backs up an existing world of the same
 * name first and sets level-name so the server loads it.
 */

export function openWorldImport(server, done) {
  const running = ['running', 'starting'].includes(server.status);
  const modal = openModal({
    title: 'Import a singleplayer world',
    width: 520,
    body: `
      <div class="mcw">
        ${running ? '<div class="card warn-card mb-8" style="font-size:13px">Stop the server first. A world cannot be swapped while it is running.</div>' : ''}
        <p style="margin-top:0" class="faint">Zip the world's folder from <span class="mono">.minecraft/saves</span> (or pick a Bedrock <span class="mono">.mcworld</span> file). Nested folders are fine.</p>
        <label class="field"><span>World file</span><input type="file" id="mcw-file" accept=".zip,.mcworld" /></label>
        <div id="mcw-info" class="faint" style="font-size:13px"></div>
        <div id="mcw-form" hidden>
          <label class="field"><span>World name</span><input id="mcw-name" maxlength="64" /></label>
          <label class="field" id="mcw-layout-row"><span>Nether and End</span>
            <select id="mcw-layout"><option value="split">Separate folders (Paper and Purpur: world_nether, world_the_end)</option><option value="single">Inside the world folder (Vanilla, Fabric, Forge, NeoForge)</option></select></label>
          <div class="checkbox-row"><input type="checkbox" id="mcw-use" checked /><label for="mcw-use">Load this world on the next start</label></div>
          <div class="checkbox-row"><input type="checkbox" id="mcw-replace" /><label for="mcw-replace">Replace a world with this name (the whole server is backed up first, and the old one is kept in .gamepanel/world-previous)</label></div>
        </div>
      </div>`,
    actions: [
      { label: 'Cancel', close: true },
      {
        label: 'Import',
        primary: true,
        onClick: async (btn) => {
          if (!state.path) return toast('Pick a world file first', 'error');
          const q = (s) => document.querySelector(`.modal-backdrop:last-child ${s}`);
          btn.disabled = true;
          btn.textContent = 'Importing…';
          try {
            const r = await api(`/api/servers/${server.id}/worlds/convert`, {
              method: 'POST',
              body: { path: state.path, name: q('#mcw-name').value.trim(), layout: q('#mcw-layout').value, use: q('#mcw-use').checked, replace: q('#mcw-replace').checked },
            });
            state.path = null;
            toast(`Imported ${r.world}${r.levelName ? ' and set it to load' : ''}. ${r.backup ? 'The old world is in the backup.' : ''}`, 'info', 7000);
            modal.close();
            done?.();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Import';
          }
        },
      },
    ],
  });
  const state = { path: null };
  const root = () => document.querySelector('.modal-backdrop:last-child');
  root()?.querySelector('#mcw-file')?.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    const r = root();
    if (!file || !r) return;
    const info = r.querySelector('#mcw-info');
    const upload = `.gp-upload-${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    info.textContent = `Uploading ${file.name}…`;
    try {
      const res = await fetch(`/api/servers/${server.id}/files/upload?path=${encodeURIComponent(upload)}`, { method: 'POST', body: file, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
      state.path = upload;
      const i = await api(`/api/servers/${server.id}/worlds/inspect`, { method: 'POST', body: { path: upload } });
      info.innerHTML = `Found a ${i.bedrock ? 'Bedrock' : 'Java'} world in <span class="mono">${esc(i.folder)}</span>: ${i.files} files, ${fmtBytes(i.size)}${i.dimensions.nether ? ', Nether' : ''}${i.dimensions.end ? ', End' : ''}.${i.matches ? '' : ` <span class="red">This server is ${i.serverIsBedrock ? 'Bedrock' : 'Java'}, so it cannot use it.</span>`}`;
      r.querySelector('#mcw-form').hidden = false;
      r.querySelector('#mcw-name').value = i.suggestedName;
      r.querySelector('#mcw-layout').value = i.layout === 'split' ? 'split' : 'single';
      r.querySelector('#mcw-layout-row').hidden = i.bedrock;
    } catch (err) {
      state.path = null;
      info.innerHTML = `<span class="red">${esc(err.message)}</span>`;
    }
  });
}
