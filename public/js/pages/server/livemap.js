import { api } from '../../core/api.js';
import { $, can, esc, toast } from '../../core/util.js';

/* ------------------------------------------------------- Rust live map */

// Players, monuments, events and bases on the map, from a small Oxide plugin
// the panel installs (server/features/rust-livemap.js). Polled while open.

const POLL_MS = 4000;
const EVENT_STYLE = {
  cargo: ['Cargo ship', '#6cb6ff'],
  heli: ['Patrol helicopter', '#ff5f57'],
  chinook: ['Chinook', '#ffb340'],
  bradley: ['Bradley APC', '#ff5f57'],
  drop: ['Air drop', '#c6f432'],
  crate: ['Locked crate', '#ffb340'],
};
const LAYERS = [
  ['players', 'Players'],
  ['events', 'Events'],
  ['monuments', 'Monuments'],
  ['bases', 'Bases'],
];

let timer = null;

export function renderLiveMapTab(host, server) {
  clearInterval(timer);
  const view = { x: 0, y: 0, zoom: 1, data: null, img: null, imgAt: 0, layers: { players: true, events: true, monuments: true, bases: false }, hover: null, selected: null };
  host.innerHTML = `
    <div class="card card-flush">
      <div class="row" style="padding:10px 14px;gap:12px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--border)">
        <div class="row" id="lm-layers" style="gap:14px;flex-wrap:wrap">${LAYERS.map(([id, label]) => `<label class="checkbox-row"><input type="checkbox" data-layer="${id}" ${view.layers[id] ? 'checked' : ''} /> ${label}</label>`).join('')}</div>
        <div class="spacer" style="flex:1"></div>
        <span class="faint mono" id="lm-status" style="font-size:12px"></span>
      </div>
      <div id="lm-setup"></div>
      <div class="row" style="align-items:stretch;gap:0;flex-wrap:wrap">
        <div id="lm-stage" style="position:relative;flex:1 1 520px;min-width:280px;height:min(72vh,720px);background:var(--inset);overflow:hidden">
          <canvas id="lm-canvas" style="width:100%;height:100%;display:block;cursor:grab"></canvas>
          <div id="lm-tip" class="hidden" style="position:absolute;pointer-events:none;background:var(--raised);border:1px solid var(--border-strong);border-radius:6px;padding:4px 8px;font-size:12px;white-space:nowrap"></div>
        </div>
        <div style="flex:0 0 240px;border-left:1px solid var(--border);padding:10px;max-height:min(72vh,720px);overflow:auto">
          <input class="search-input" id="lm-find" placeholder="Find a player…" style="width:100%;margin-bottom:8px" />
          <div id="lm-list"></div>
        </div>
      </div>
    </div>`;
  const canvas = $('#lm-canvas');
  const ctx = canvas.getContext('2d');
  const tip = $('#lm-tip');
  let box = { w: 0, h: 0 };

  const fit = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    box = { w: r.width, h: r.height };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  // World metres to canvas pixels. The map is square; at zoom 1 it fits the stage.
  const scale = () => (Math.min(box.w, box.h) / (view.data?.size || 3500)) * view.zoom;
  const toScreen = (x, z) => [box.w / 2 + (x - view.x) * scale(), box.h / 2 - (z - view.y) * scale()];
  const toWorld = (px, py) => [view.x + (px - box.w / 2) / scale(), view.y - (py - box.h / 2) / scale()];

  function draw() {
    if (!canvas.isConnected) return;
    const size = view.data?.size || 3500;
    ctx.clearRect(0, 0, box.w, box.h);
    const [x0, y0] = toScreen(-size / 2, size / 2);
    const side = size * scale();
    if (view.img?.complete && view.img.naturalWidth) ctx.drawImage(view.img, x0, y0, side, side);
    else {
      ctx.fillStyle = '#10161a';
      ctx.fillRect(x0, y0, side, side);
    }
    // Grid every 1000 m.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let m = -Math.floor(size / 2000) * 1000; m <= size / 2; m += 1000) {
      const [gx, gy] = toScreen(m, m);
      ctx.moveTo(gx, y0);
      ctx.lineTo(gx, y0 + side);
      ctx.moveTo(x0, gy);
      ctx.lineTo(x0 + side, gy);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(x0, y0, side, side);
    const d = view.data;
    if (!d) return;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const label = (text, x, y, color) => {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    };
    if (view.layers.monuments) {
      // A RustMaps picture already names the monuments; draw ours only without one.
      const picture = view.img?.complete && view.img.naturalWidth && d.image?.source !== 'upload';
      for (const m of d.monuments || []) {
        const [x, y] = toScreen(m.x, m.z);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillRect(x - 2, y - 2, 4, 4);
        if (!picture && view.zoom >= 1.2) label(m.name, x + 6, y, 'rgba(255,255,255,0.8)');
      }
    }
    if (view.layers.bases) {
      for (const b of d.bases || []) {
        const [x, y] = toScreen(b.x, b.z);
        ctx.fillStyle = '#ffb340';
        ctx.fillRect(x - 3, y - 3, 6, 6);
        if (view.zoom >= 3 && b.name) label(b.name, x + 6, y, '#ffb340');
      }
    }
    if (view.layers.events) {
      for (const e of d.events || []) {
        const [x, y] = toScreen(e.x, e.z);
        const [name, color] = EVENT_STYLE[e.kind] || [e.kind, '#fff'];
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x + 6, y + 5);
        ctx.lineTo(x - 6, y + 5);
        ctx.closePath();
        ctx.fill();
        label(name, x + 9, y, color);
      }
    }
    if (view.layers.players) {
      for (const p of d.players || []) {
        const [x, y] = toScreen(p.x, p.z);
        const hot = view.selected === p.id;
        ctx.fillStyle = hot ? '#ffffff' : '#c6f432';
        ctx.beginPath();
        ctx.arc(x, y, hot ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (view.zoom >= 1.6 || hot) label(p.name, x + 8, y, '#ecebe6');
      }
    }
  }

  function nearest(px, py) {
    const d = view.data;
    if (!d) return null;
    let best = null;
    let bestDist = 100; // 10 px, squared
    const test = (item, kind, name) => {
      const [x, y] = toScreen(item.x, item.z);
      const dist = (x - px) ** 2 + (y - py) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = { name, x, y, kind };
      }
    };
    if (view.layers.players) for (const p of d.players || []) test(p, 'player', `${p.name} · ${Math.round(p.hp)} hp`);
    if (view.layers.events) for (const e of d.events || []) test(e, 'event', (EVENT_STYLE[e.kind] || [e.kind])[0]);
    if (view.layers.bases) for (const b of d.bases || []) test(b, 'base', `${b.name || 'Unknown'}'s base · ${b.members} authorized`);
    if (view.layers.monuments) for (const m of d.monuments || []) test(m, 'monument', m.name);
    return best;
  }

  // Pan with a drag, zoom around the cursor with the wheel.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointerup', () => {
    drag = null;
    canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (drag) {
      view.x = drag.vx - (e.clientX - drag.x) / scale();
      view.y = drag.vy + (e.clientY - drag.y) / scale();
      draw();
      return;
    }
    const hit = nearest(e.clientX - r.left, e.clientY - r.top);
    tip.classList.toggle('hidden', !hit);
    if (hit) {
      tip.textContent = hit.name;
      tip.style.left = `${Math.min(hit.x + 12, box.w - tip.offsetWidth - 4)}px`;
      tip.style.top = `${Math.max(hit.y - 12, 4)}px`;
    }
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const [wx, wz] = toWorld(px, py);
      view.zoom = Math.min(12, Math.max(0.6, view.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      // Keep the point under the cursor where it was.
      view.x = wx - (px - box.w / 2) / scale();
      view.y = wz + (py - box.h / 2) / scale();
      draw();
    },
    { passive: false }
  );
  host.querySelectorAll('[data-layer]').forEach((c) =>
    c.addEventListener('change', () => {
      view.layers[c.dataset.layer] = c.checked;
      draw();
    })
  );
  $('#lm-find').addEventListener('input', () => drawList());

  function drawList() {
    const q = $('#lm-find').value.trim().toLowerCase();
    const players = (view.data?.players || []).filter((p) => !q || p.name.toLowerCase().includes(q));
    $('#lm-list').innerHTML = players.length
      ? players
          .map((p) => `<button class="btn btn-sm btn-ghost" data-pid="${esc(p.id)}" style="display:block;width:100%;text-align:left;margin-bottom:2px">${esc(p.name)}<span class="faint" style="float:right">${Math.round(p.hp)} hp</span></button>`)
          .join('')
      : `<div class="faint" style="font-size:12px">${view.data?.live ? 'Nobody online.' : ''}</div>`;
  }
  $('#lm-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pid]');
    const p = view.data?.players.find((x) => x.id === btn?.dataset.pid);
    if (!p) return;
    view.selected = p.id;
    view.x = p.x;
    view.y = p.z;
    view.zoom = Math.max(view.zoom, 3);
    draw();
  });

  function setup(d) {
    const el = $('#lm-setup');
    const parts = [];
    if (d.plugin !== 'installed' && d.oxide !== false) {
      parts.push(`<div style="flex:1;min-width:240px">${d.plugin === 'outdated' ? 'The map plugin is out of date.' : 'The map needs a small plugin on the server.'} Oxide loads it right away, no restart.</div>
        ${can('files.write', server.id) ? `<button class="btn btn-sm btn-primary" id="lm-install">${d.plugin === 'outdated' ? 'Update' : 'Install'} map plugin</button>` : '<span class="faint">Ask an admin to install it.</span>'}`);
    } else if (d.plugin !== 'installed') {
      parts.push('<div>The live map needs uMod/Oxide. Turn on "Install uMod/Oxide" in this server\'s settings, then reinstall or update it.</div>');
    }
    if (!d.image || d.image.stale) {
      parts.push(`<div style="flex:1;min-width:240px" class="faint">${
        d.image?.stale ? 'The seed changed, so the picture is of the old map.' : 'No map picture yet.'
      } ${d.imageError ? esc(d.imageError) + '. ' : ''}Add a RustMaps key under Settings, Integrations to fetch it automatically, or upload a PNG or JPEG of the map.</div>
        ${can('settings', server.id) ? '<button class="btn btn-sm" id="lm-upload">Upload picture…</button><input type="file" id="lm-file" accept="image/png,image/jpeg" class="hidden" />' : ''}`);
    }
    if (d.error && d.plugin === 'installed' && d.running) parts.push(`<div class="faint" style="flex:1">${esc(d.error)}</div>`);
    el.innerHTML = parts.length ? `<div class="row" style="gap:12px;padding:10px 14px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--border);font-size:13px">${parts.join('')}</div>` : '';
    $('#lm-install')?.addEventListener('click', async () => {
      try {
        await api(`/api/servers/${server.id}/live-map/plugin`, { method: 'POST', body: {} });
        toast('Plugin installed. Players appear in a few seconds.');
        poll();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    $('#lm-upload')?.addEventListener('click', () => $('#lm-file').click());
    $('#lm-file')?.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const res = await fetch(`/api/servers/${server.id}/live-map/image`, { method: 'PUT', body: file, credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
        toast('Picture saved');
        poll();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  async function poll() {
    if (!host.isConnected) return clearInterval(timer);
    let d;
    try {
      d = await api(`/api/servers/${server.id}/live-map`);
    } catch (err) {
      $('#lm-status') && ($('#lm-status').textContent = err.message);
      return;
    }
    if (!host.isConnected) return;
    const first = !view.data;
    view.data = d;
    if (d.image && d.image.at !== view.imgAt) {
      view.imgAt = d.image.at;
      const img = new Image();
      img.onload = draw;
      img.src = `/api/servers/${encodeURIComponent(server.id)}/live-map/image?v=${d.image.at}`;
      view.img = img;
    } else if (!d.image) view.img = null;
    $('#lm-status').textContent = !d.running ? 'Server is stopped' : d.live ? `${d.players.length} online · ${d.sleepers} sleeping · size ${d.size}` : 'Waiting for the map plugin';
    setup(d);
    drawList();
    if (first) fit();
    else draw();
  }

  window.addEventListener('resize', fit);
  new ResizeObserver(fit).observe($('#lm-stage'));
  fit();
  poll();
  timer = setInterval(poll, POLL_MS);
}
