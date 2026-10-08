import { api } from '../../core/api.js';
import { esc, icon } from '../../core/util.js';

/* ------------------------------------------------------------- world map */

// Rust (RustMaps), Valheim (valheim-map.world) and Terraria (TerraMap) maps on
// the web. Minecraft's live map is the BlueMap card next to this one.

export async function renderWorldMapCard(host, server) {
  const data = await api(`/api/servers/${encodeURIComponent(server.id)}/world-map`).catch(() => null);
  const map = data?.map;
  if (!map || !host.isConnected) return;
  const action =
    map.kind === 'link'
      ? `<a class="btn btn-primary" href="${esc(map.url)}" target="_blank" rel="noopener">${esc(map.label)}</a>`
      : map.kind === 'file'
        ? `<a class="btn" href="/api/servers/${encodeURIComponent(server.id)}/files/download?path=${encodeURIComponent(map.path)}">${esc(map.label)}</a>
           <a class="btn btn-primary" href="${esc(map.viewer)}" target="_blank" rel="noopener">Open TerraMap</a>`
        : '';
  host.innerHTML = `
    <div class="card mb-16 row" style="align-items:center;gap:16px;flex-wrap:wrap">
      <div class="feature-icon">${icon('map', 20)}</div>
      <div style="flex:1;min-width:220px">
        <h4 style="margin:0 0 4px">World map</h4>
        <div class="faint" style="font-size:13px">${esc(map.note || '')}</div>
      </div>
      ${action}
    </div>`;
}
