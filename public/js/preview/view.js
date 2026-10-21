// Texture viewer UI: canvas with zoom/pan, channel toggles, mip picker, checkerboard; plus a gallery for texture dictionaries.
// Browser only. All file-derived text goes through esc().

import { esc } from '../core/util.js';

const MODES = [
  ['R', 'Red channel'],
  ['G', 'Green channel'],
  ['B', 'Blue channel'],
  ['A', 'Alpha channel'],
];

/** Draw rgba (Uint8Array) to a canvas, honouring the channel toggles. */
export function paintRGBA(canvas, mip, ch) {
  canvas.width = mip.width;
  canvas.height = mip.height;
  const ctx = canvas.getContext('2d');
  const src = mip.rgba;
  const out = new Uint8ClampedArray(src.length);
  const alphaOnly = !ch.R && !ch.G && !ch.B && ch.A;
  for (let i = 0; i < src.length; i += 4) {
    if (alphaOnly) {
      out[i] = out[i + 1] = out[i + 2] = src[i + 3];
      out[i + 3] = 255;
    } else {
      out[i] = ch.R ? src[i] : 0;
      out[i + 1] = ch.G ? src[i + 1] : 0;
      out[i + 2] = ch.B ? src[i + 2] : 0;
      out[i + 3] = ch.A ? src[i + 3] : 255;
    }
  }
  ctx.putImageData(new ImageData(out, mip.width, mip.height), 0, 0);
}

/** A small canvas scaled down from the mip closest to `size` pixels wide. */
export function thumbnail(entry, size = 128) {
  const mip = [...entry.mips].reverse().find((m) => m.width >= size) || entry.mips[0];
  const c = document.createElement('canvas');
  paintRGBA(c, mip, { R: true, G: true, B: true, A: true });
  return c;
}

/**
 * Show one texture. entry: { name, width, height, format, note, mips: [{ width, height, rgba }] }
 * or { imgUrl, ... } for formats shown through <img> (SVG, GIF). Returns a cleanup function.
 */
export function renderTexture(host, entry, { onBack } = {}) {
  const isImg = !!entry.imgUrl;
  const ch = { R: true, G: true, B: true, A: true };
  let mipIndex = 0;
  let bg = 'checker';
  const view = { scale: 1, x: 0, y: 0 };
  host.innerHTML = `
    <div class="pv-bar">
      ${onBack ? '<button class="btn btn-sm" data-back>Back to all</button>' : ''}
      <span class="pv-group" ${isImg ? 'hidden' : ''}>${MODES.map(([k, t]) => `<button class="btn btn-sm pv-toggle active" data-ch="${k}" title="${t}">${k}</button>`).join('')}</span>
      <select class="pv-select" data-mip title="Mip level" ${isImg || entry.mips?.length < 2 ? 'hidden' : ''}>${(entry.mips || []).map((m, i) => `<option value="${i}">Mip ${i} (${m.width}x${m.height})</option>`).join('')}</select>
      <span class="pv-group">
        <button class="btn btn-sm" data-zoom="out" title="Zoom out">-</button>
        <button class="btn btn-sm" data-zoom="in" title="Zoom in">+</button>
        <button class="btn btn-sm" data-zoom="fit" title="Fit to window">Fit</button>
        <button class="btn btn-sm" data-zoom="1" title="Actual size">1:1</button>
      </span>
      <button class="btn btn-sm" data-bg title="Change background">Background</button>
      <span class="faint pv-zoom" data-zoomlabel></span>
    </div>
    <div class="pv-stage pv-checker" data-stage tabindex="0"></div>
    <div class="pv-meta">
      <span class="mono">${esc(entry.name || '')}</span>
      <span>${esc(`${entry.width} x ${entry.height}`)}</span>
      <span>${esc(entry.format || '')}</span>
      ${entry.mips?.length > 1 ? `<span>${entry.mips.length} mip levels</span>` : ''}
      ${entry.note ? `<span class="faint">${esc(entry.note)}</span>` : ''}
    </div>`;
  const stage = host.querySelector('[data-stage]');
  let el;
  if (isImg) {
    el = document.createElement('img');
    el.alt = '';
    el.src = entry.imgUrl; // shown through <img> only, so scripts inside an SVG never run
    el.draggable = false;
  } else el = document.createElement('canvas');
  el.className = 'pv-img';
  stage.appendChild(el);
  const label = host.querySelector('[data-zoomlabel]');

  const natural = () => (isImg ? { w: el.naturalWidth || entry.width || 1, h: el.naturalHeight || entry.height || 1 } : { w: entry.mips[mipIndex].width, h: entry.mips[mipIndex].height });
  const apply = () => {
    const { w, h } = natural();
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    el.style.imageRendering = view.scale >= 2 ? 'pixelated' : 'auto';
    label.textContent = `${Math.round(view.scale * 100)}%`;
  };
  const fit = () => {
    const { w, h } = natural();
    const r = stage.getBoundingClientRect();
    view.scale = Math.min(r.width / w, r.height / h, 1) || 1;
    view.x = (r.width - w * view.scale) / 2;
    view.y = (r.height - h * view.scale) / 2;
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const next = Math.max(0.05, Math.min(32, view.scale * factor));
    const k = next / view.scale;
    view.x = cx - (cx - view.x) * k;
    view.y = cy - (cy - view.y) * k;
    view.scale = next;
    apply();
  };
  const paint = () => {
    if (!isImg) paintRGBA(el, entry.mips[mipIndex], ch);
    apply();
  };
  const redraw = () => {
    paint();
    if (!view.fitted) {
      view.fitted = true;
      fit();
    }
  };

  host.querySelectorAll('[data-ch]').forEach((b) =>
    b.addEventListener('click', () => {
      ch[b.dataset.ch] = !ch[b.dataset.ch];
      b.classList.toggle('active', ch[b.dataset.ch]);
      paint();
    })
  );
  host.querySelector('[data-mip]')?.addEventListener('change', (e) => {
    mipIndex = Number(e.target.value);
    view.fitted = false;
    redraw();
  });
  host.querySelector('[data-back]')?.addEventListener('click', () => onBack());
  host.querySelectorAll('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => {
      const r = stage.getBoundingClientRect();
      const z = b.dataset.zoom;
      if (z === 'fit') fit();
      else if (z === '1') {
        view.scale = 1;
        const { w, h } = natural();
        view.x = (r.width - w) / 2;
        view.y = (r.height - h) / 2;
        apply();
      } else zoomAt(z === 'in' ? 1.5 : 1 / 1.5, r.width / 2, r.height / 2);
    })
  );
  const bgs = ['pv-checker', 'pv-dark', 'pv-light'];
  host.querySelector('[data-bg]').addEventListener('click', () => {
    const order = ['checker', 'dark', 'light'];
    bg = order[(order.indexOf(bg) + 1) % 3];
    stage.classList.remove(...bgs);
    stage.classList.add(bgs[order.indexOf(bg)]);
  });
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false }
  );
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.x += e.clientX - drag.x;
    view.y += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    apply();
  });
  const stop = () => {
    drag = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);

  if (isImg) el.addEventListener('load', redraw);
  else requestAnimationFrame(redraw);
  return () => {
    el.src = '';
  };
}

/** Gallery of textures (a .ytd); click one to open it. */
export function renderGallery(host, entries, { title = '' } = {}) {
  let cleanup = null;
  const show = () => {
    cleanup?.();
    cleanup = null;
    host.innerHTML = `
      ${title ? `<div class="pv-meta"><span>${esc(title)}</span><span class="faint">${entries.length} textures. Click one to inspect it.</span></div>` : ''}
      <div class="pv-gallery">${entries
        .map(
          (e, i) => `<button class="pv-card" data-i="${i}" title="${esc(e.name)}">
            <span class="pv-thumb pv-checker" data-thumb="${i}">${e.error ? `<span class="pv-thumb-err">${esc(e.error)}</span>` : ''}</span>
            <span class="pv-card-name mono">${esc(e.name)}</span>
            <span class="pv-card-meta faint">${esc(`${e.width}x${e.height} ${e.format}`)}</span>
          </button>`
        )
        .join('')}</div>`;
    entries.forEach((e, i) => {
      if (e.error || !e.mips?.length) return;
      try {
        const c = thumbnail(e);
        c.className = 'pv-thumb-canvas';
        host.querySelector(`[data-thumb="${i}"]`).appendChild(c);
      } catch {
        /* a texture that fails to decode just shows an empty tile */
      }
    });
    host.querySelectorAll('[data-i]').forEach((b) =>
      b.addEventListener('click', () => {
        const e = entries[Number(b.dataset.i)];
        if (e.error || !e.mips?.length) return;
        cleanup = renderTexture(host, e, { onBack: show });
      })
    );
  };
  show();
  return () => cleanup?.();
}
