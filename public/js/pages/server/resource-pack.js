import { api } from '../../core/api.js';
import { esc, fmtBytes, icon, toast, can } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';

/* ------------------------------------------------- Minecraft resource pack */

/*
 * The "Resource pack" card on the Game settings tab: upload a pack, the panel
 * serves it publicly and writes the address and hash into server.properties.
 */

export async function renderResourcePackCard(host, server) {
  if (!host || !can('mods') || !/^minecraft-(?!bedrock$|velocity$)/.test(server.templateId || '')) return;
  let data;
  try {
    data = await api(`/api/servers/${server.id}/resource-pack`);
  } catch {
    return;
  }
  if (!host.isConnected) return;
  const redraw = () => renderResourcePackCard(host, server);
  const pack = data.pack;
  const privateHost = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(pack?.url || data.baseUrl || data.detectedBase);

  host.innerHTML = `
    <div class="card mb-16">
      <div class="card-head" style="flex-wrap:wrap">
        <h4>Resource pack</h4>
        <div class="spacer"></div>
        <label class="btn btn-sm ${pack ? 'btn-ghost' : 'btn-primary'}" style="display:inline-flex">${pack ? 'Replace zip' : 'Upload zip'}<input type="file" id="rp-file" accept=".zip" hidden /></label>
        ${pack ? `<button class="btn btn-sm btn-ghost btn-danger" id="rp-remove" title="Stop hosting this pack">${icon('trash', 13)}</button>` : ''}
      </div>
      ${
        pack
          ? `<div class="faint mb-8" style="font-size:12.5px">${esc(pack.name)} · ${fmtBytes(pack.size)} · uploaded ${new Date(pack.uploadedAt).toLocaleString()}</div>
      <div class="input-row mb-8"><input id="rp-url" readonly value="${esc(pack.url)}" /><button class="btn" id="rp-copy">Copy</button><button class="btn btn-ghost" id="rp-new" title="Make a new link; the old one stops working">${icon('refresh', 12)}</button></div>
      <div class="faint mb-8" style="font-size:12.5px">SHA-1 <span class="mono">${esc(pack.sha1)}</span> · ${
        pack.applied ? `written to <span class="mono">server.properties</span>${data.running ? '; players get it after the next restart' : ''}` : 'not in server.properties yet; press Save'
      }</div>
      <label class="switch-row mb-8"><input type="checkbox" id="rp-require" ${pack.require ? 'checked' : ''} /> <span>Players must accept the pack to join</span></label>
      <label class="field"><span>Message shown to players <span class="faint">(optional)</span></span>
        <input id="rp-prompt" maxlength="200" value="${esc(pack.prompt)}" placeholder="e.g. Custom textures for this server" />
      </label>
      <label class="field"><span>Panel address players reach <span class="faint">(leave empty to use the one you are on now)</span></span>
        <input id="rp-base" value="${esc(data.baseUrl)}" placeholder="${esc(data.detectedBase)}" />
      </label>
      ${privateHost ? `<div class="filter-note mb-8">${icon('alert', 12)} This address only works on your own network. Players elsewhere need the panel's public address above.</div>` : ''}
      <button class="btn btn-sm" id="rp-save">Save</button>`
          : `<p class="faint" style="margin:0">Upload a resource pack (.zip, up to ${fmtBytes(data.maxSize)}). The panel hosts it and sets <span class="mono">resource-pack</span> and its hash in server.properties for you.</p>`
      }
    </div>`;

  host.querySelector('#rp-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    toast(`Uploading ${file.name}…`);
    try {
      const res = await fetch(`/api/servers/${server.id}/resource-pack?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, credentials: 'same-origin' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Upload failed');
      toast('Resource pack ready');
      redraw();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  if (!pack) return;

  const patch = async (body, message) => {
    try {
      await api(`/api/servers/${server.id}/resource-pack`, { method: 'PATCH', body });
      if (message) toast(message);
      redraw();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  host.querySelector('#rp-save').addEventListener('click', () =>
    patch({ require: host.querySelector('#rp-require').checked, prompt: host.querySelector('#rp-prompt').value, baseUrl: host.querySelector('#rp-base').value }, 'Saved')
  );
  host.querySelector('#rp-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(pack.url).catch(() => {});
    toast('Link copied');
  });
  host.querySelector('#rp-new').addEventListener('click', async () => {
    if (await confirmModal('New link', 'The old link stops working and server.properties gets the new one. Continue?', 'Make a new link')) patch({ newLink: true }, 'New link made');
  });
  host.querySelector('#rp-remove').addEventListener('click', async () => {
    if (!(await confirmModal('Remove resource pack', 'Stop hosting this pack and clear it from server.properties?', 'Remove'))) return;
    try {
      await api(`/api/servers/${server.id}/resource-pack`, { method: 'DELETE' });
      redraw();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
