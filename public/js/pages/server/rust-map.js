import { api } from '../../core/api.js';
import { $, esc, icon, toast } from '../../core/util.js';

/**
 * Which map a Rust server loads: generated from the size and seed, one of the
 * game's own maps, a hosted .map link, or a .map file uploaded here.
 */
export async function renderMapCard(host, server) {
  let info;
  try {
    info = await api(`/api/servers/${server.id}/map`);
  } catch (err) {
    host.innerHTML = '';
    return;
  }
  const map = info.map;
  const modes = [
    ['procedural', 'Generated (world size and seed from Settings)'],
    ['official', 'A map that comes with the game'],
    ['url', 'A hosted .map file (link)'],
    ['file', 'A .map file I upload'],
  ];
  host.innerHTML = `
    <div class="card mt-16">
      <div class="card-head"><h4>Map</h4></div>
      <p class="faint" style="margin:0 0 12px">Pick what the server loads on its next start. A different map needs a wipe, since the save belongs to the old one.</p>
      <div class="form-row"><label for="map-mode">Map</label>
        <select id="map-mode">${modes.map(([v, l]) => `<option value="${v}" ${map.mode === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="form-row map-opt" data-for="official"><label for="map-level">Official map</label>
        <select id="map-level">${info.official.map((m) => `<option value="${esc(m.id)}" ${map.level === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div>
      <div class="form-row map-opt" data-for="url"><label for="map-url">Link to the .map</label>
        <input id="map-url" type="url" placeholder="https://example.com/mymap.map" value="${esc(map.url || '')}" />
        <div class="hint">Custom maps (from RustMaps, Codefling and similar sites) are downloaded by the game when it starts.</div></div>
      <div class="form-row map-opt" data-for="file"><label for="map-file">Uploaded map</label>
        <select id="map-file">${info.files.length ? info.files.map((f) => `<option value="${esc(f.name)}" ${map.file === f.name ? 'selected' : ''}>${esc(f.name)} (${(f.size / 1048576).toFixed(1)} MB)</option>`).join('') : '<option value="">No map uploaded yet</option>'}</select>
        <div class="row mt-8"><button class="btn btn-sm" id="map-upload">${icon('upload', 12)} Upload a .map…</button><input type="file" id="map-input" accept=".map" class="hidden" /></div>
        <div class="hint">The panel serves it to the game itself, so no hosting is needed. Files live in <span class="mono">${esc(info.dir)}/</span>.</div></div>
      <div class="row mt-16"><button class="btn btn-sm btn-primary" id="map-save">Save map</button></div>
      <div id="rm-box" class="mt-16"></div>
    </div>`;
  renderRustMaps($('#rm-box'), server, () => renderMapCard(host, server));
  const sync = () => host.querySelectorAll('.map-opt').forEach((el) => el.classList.toggle('hidden', el.dataset.for !== $('#map-mode').value));
  $('#map-mode').addEventListener('change', sync);
  sync();
  $('#map-upload').addEventListener('click', () => $('#map-input').click());
  $('#map-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const name = file.name.replace(/[^A-Za-z0-9._ -]/g, '_');
    if (!/\.map$/i.test(name)) return toast('Pick a .map file', 'error');
    toast(`Uploading ${name}…`);
    try {
      const res = await fetch(`/api/servers/${server.id}/files/upload?path=${encodeURIComponent(`${info.dir}/${name}`)}`, { method: 'POST', body: file, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
      await api(`/api/servers/${server.id}/map`, { method: 'PUT', body: { mode: 'file', file: name } });
      toast('Uploaded and selected. Wipe, or restart, to load it.');
      renderMapCard(host, server);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#map-save').addEventListener('click', async () => {
    try {
      await api(`/api/servers/${server.id}/map`, {
        method: 'PUT',
        body: { mode: $('#map-mode').value, level: $('#map-level').value, url: $('#map-url').value, file: $('#map-file').value },
      });
      toast('Map saved. It loads on the next start; wipe first so the save matches.');
      renderMapCard(host, server);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/** RustMaps: preview link for the seed, a random seed, and a custom map with monuments left out. */
async function renderRustMaps(box, server, reload) {
  let info;
  try {
    info = await api(`/api/servers/${server.id}/rustmaps`);
  } catch {
    return;
  }
  const job = info.job;
  box.innerHTML = `
    <h4 style="margin:0 0 8px">RustMaps</h4>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${info.preview ? `<a class="btn btn-sm" href="${esc(info.preview.url)}" target="_blank" rel="noopener noreferrer">Preview size ${info.preview.size}, seed ${info.preview.seed}</a>` : ''}
      <button class="btn btn-sm" id="rm-seed">Random seed</button>
    </div>
    <div class="hint">The preview shows the generated map for the size and seed in Settings. Pick a seed you like, then wipe.</div>
    ${
      info.keySet
        ? `<div class="mt-16"><button class="btn btn-sm" id="rm-load">Choose monuments to leave out…</button></div>
           <div id="rm-picker" class="mt-8"></div>`
        : '<div class="hint mt-8">Add a RustMaps API key under Settings, Integrations to leave monuments out (needs a RustMaps subscription with custom maps).</div>'
    }
    ${job ? `<div class="hint mt-8" id="rm-job">${esc(job.state === 'failed' ? `Failed: ${job.error}` : job.message)}</div>` : ''}`;
  $('#rm-seed').addEventListener('click', async () => {
    try {
      await api(`/api/servers/${server.id}/rustmaps/seed`, { method: 'POST', body: {} });
      toast('New seed set. Wipe to use it.');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  if (job?.state === 'running') setTimeout(() => $('#rm-box') === box && renderRustMaps(box, server, reload), 5000);
  $('#rm-load')?.addEventListener('click', async () => {
    const picker = $('#rm-picker');
    picker.textContent = 'Loading monuments…';
    try {
      const data = await api(`/api/servers/${server.id}/rustmaps/monuments`);
      picker.innerHTML = `
        ${data.savedConfigs.length ? `<div class="form-row"><label for="rm-saved">Or use a saved config from your RustMaps dashboard</label>
          <select id="rm-saved"><option value="">None, use the ticks below</option>${data.savedConfigs.map((n) => `<option>${esc(n)}</option>`).join('')}</select>
          <div class="hint">A saved config can do things ticks cannot, such as a combined Outpost and Bandit Town.</div></div>` : ''}
        <div class="hint">Tick what to leave out of the map.</div>
        ${data.groups
          .map(
            (g) => `<details class="mt-8"><summary>${esc(g.label)}</summary><div class="row" style="flex-wrap:wrap;gap:4px 16px">${g.types
              .map((t) => `<label class="checkbox-row"><input type="checkbox" class="rm-block" value="${esc(t.type)}" ${t.blocked ? 'checked' : ''} /> ${esc(t.type)}</label>`)
              .join('')}</div></details>`
          )
          .join('')}
        <div class="row mt-16"><button class="btn btn-sm btn-primary" id="rm-go">Generate with RustMaps</button></div>
        <div class="hint">Uses one custom map from your RustMaps allowance. The map is downloaded here and selected; wipe to load it.</div>`;
      $('#rm-go').addEventListener('click', async () => {
        try {
          await api(`/api/servers/${server.id}/rustmaps/generate`, {
            method: 'POST',
            body: { savedConfig: $('#rm-saved')?.value || '', blocked: [...picker.querySelectorAll('.rm-block:checked')].map((c) => c.value) },
          });
          toast('Generating. This can take a few minutes.');
          renderRustMaps(box, server, reload);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    } catch (err) {
      picker.textContent = '';
      toast(err.message, 'error');
    }
  });
}
