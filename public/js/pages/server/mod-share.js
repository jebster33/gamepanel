import { api } from '../../core/api.js';
import { $, esc, icon, toast } from '../../core/util.js';
import { confirmModal } from '../../ui/modal.js';

/* ------------------------------------------------- mods players need -- */

// A public page listing the mods players install on their own computer
// (a download link, a Modrinth modpack, Steam collections to subscribe to).

const linesOf = (extras) => extras.map((e) => [e.name, e.url, e.note].filter((v, i) => i < 2 || v).join(' | ')).join('\n');

function parseExtras(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, url, ...note] = l.split('|').map((p) => p.trim());
      return { name, url, note: note.join(' | ') };
    });
}

export async function renderModShare(host, server) {
  const { share } = await api(`/api/servers/${server.id}/mods/share`).catch(() => ({}));
  if (!share || !host.isConnected) return;
  const link = share.slug ? `${location.origin}/mods/${share.slug}` : '';
  host.innerHTML = `
    <div class="card">
      <div class="row" style="gap:8px;align-items:center">
        <span class="field-label" style="margin:0;flex:1">Mods for players</span>
        <label class="switch-row" style="margin:0"><input type="checkbox" id="ms-on" ${share.enabled ? 'checked' : ''} /> <span>Share</span></label>
      </div>
      <div class="hint">A public page with the mods players need on their own computer: links, a modpack download for Minecraft, and Steam Workshop collections to subscribe to. It shows only mod names and links.</div>
      ${
        share.enabled && link
          ? `<div class="input-row" style="margin-top:8px"><input id="ms-link" readonly value="${esc(link)}" /><button class="btn" id="ms-copy">Copy</button><button class="btn btn-ghost" id="ms-new" title="Make a new link; the old one stops working">${icon('refresh', 12)}</button></div>`
          : ''
      }
      ${
        share.collections.length
          ? `<div class="label-caps" style="margin:10px 0 4px">Workshop collections players can subscribe to</div>${share.collections
              .map((c) => `<div class="row" style="gap:8px"><span class="grow min-w-0">${esc(c.title)}</span><button class="btn btn-sm btn-ghost btn-danger" data-rm-collection="${esc(c.id)}" title="Stop offering this collection">${icon('trash', 12)}</button></div>`)
              .join('')}`
          : ''
      }
      <label class="field" style="margin-top:10px"><span>Note for players</span>
        <textarea id="ms-notes" rows="2" maxlength="600" placeholder="e.g. Put the mods in your mods folder, then join with the address in Discord">${esc(share.notes)}</textarea>
      </label>
      <label class="field"><span>Extra links <span class="faint">(one per line: name | https://link | note)</span></span>
        <textarea id="ms-extras" rows="3" placeholder="Resource pack | https://example.com/pack.zip | optional">${esc(linesOf(share.extras))}</textarea>
      </label>
      <button class="btn btn-sm" id="ms-save">Save</button>
    </div>`;

  const save = async (patch, message) => {
    try {
      await api(`/api/servers/${server.id}/mods/share`, { method: 'PATCH', body: patch });
      if (message) toast(message);
      renderModShare(host, server);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('#ms-on', host).addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('#ms-save', host).addEventListener('click', () => save({ notes: $('#ms-notes', host).value, extras: parseExtras($('#ms-extras', host).value) }, 'Saved'));
  $('#ms-copy', host)?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(link).catch(() => {});
    toast('Link copied');
  });
  $('#ms-new', host)?.addEventListener('click', async () => {
    if (await confirmModal('New link', 'The old link will stop working. Continue?', 'Make a new link')) save({ newLink: true }, 'New link made');
  });
  host.querySelectorAll('[data-rm-collection]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/api/servers/${server.id}/mods/share/collections/${encodeURIComponent(btn.dataset.rmCollection)}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      renderModShare(host, server);
    })
  );
}
