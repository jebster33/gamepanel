// In-browser previews for the file manager: textures, 3D models, GTA V resources and "info only" formats.
// The bytes come through the normal authenticated file download route (same permission checks as downloading),
// and everything is decoded here in the browser. Nothing is executed or uploaded.

import { api } from '../core/api.js';
import { $, esc, fmtBytes, toast } from '../core/util.js';
import { openModal } from '../ui/modal.js';
import { DECODED_IMAGE_EXTS, decodeImage, extOf, NATIVE_IMAGE_EXTS } from './images.js';
import { describeFile, INFO_ONLY_EXTS } from './info.js';
import { createViewer, glSupported } from './gl-viewer.js';
import { parse3MF, parseFBX, parseGLTF } from './model-binary.js';
import { applyMTL, parseMTL, parseOBJ, parseSimpleModel } from './model-text.js';
import { parseRageModel, parseYTD, RAGE_RESOURCE_EXTS } from './rage.js';
import { renderGallery, renderTexture } from './view.js';

export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

const MODEL_EXTS = ['obj', 'stl', 'ply', 'glb', 'gltf', 'fbx', 'dae', '3mf', 'smd', 'vox'];
const RAGE_MODEL_EXTS = ['ydr', 'ydd', 'yft'];
const IMAGE_EXTS = [...NATIVE_IMAGE_EXTS, ...DECODED_IMAGE_EXTS];
// Mostly text formats: a click opens the text editor and the Preview button shows the picture.
const TEXT_FIRST = ['obj', 'gltf', 'dae', 'smd', 'svg'];
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', apng: 'image/png' };
const TEXTURE_TRY = ['png', 'jpg', 'jpeg', 'tga', 'dds', 'bmp', 'webp', 'vtf', 'tif', 'tiff', 'psd', 'gif'];

export function previewKind(name) {
  const ext = extOf(name);
  if (IMAGE_EXTS.includes(ext)) return 'texture';
  if (ext === 'ytd') return 'ytd';
  if (RAGE_MODEL_EXTS.includes(ext)) return 'rage';
  if (MODEL_EXTS.includes(ext)) return 'model';
  if (RAGE_RESOURCE_EXTS.includes(ext) || INFO_ONLY_EXTS.includes(ext)) return 'info';
  return null;
}
export const canPreview = (name) => previewKind(name) !== null;
/** Whether a click on the file name should open the preview rather than the text editor. */
export const opensPreview = (name) => canPreview(name) && !TEXT_FIRST.includes(extOf(name));

/* ----------------------------------------------------------------- bytes */

export async function fetchBytes(server, path, max = MAX_PREVIEW_BYTES) {
  let res;
  try {
    res = await fetch(`/api/servers/${encodeURIComponent(server.id)}/files/download?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
  } catch {
    throw new Error('Cannot reach the panel');
  }
  if (!res.ok) {
    let msg = `Could not read the file (${res.status})`;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* keep the generic message */
    }
    throw new Error(msg);
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new Error(`This file is ${fmtBytes(len)}. Previews are limited to ${fmtBytes(max)}; download it instead.`);
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      reader.cancel();
      throw new Error(`This file is larger than ${fmtBytes(max)}; download it instead.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const dirOf = (p) => p.split('/').slice(0, -1).join('/');
const baseOf = (p) => p.split('/').pop();
const stemOf = (n) => n.replace(/\.[^./]+$/, '');
const normName = (n) => stemOf(String(n || '').replace(/\\/g, '/').split('/').pop()).toLowerCase();

function resolveRel(dir, rel) {
  const out = dir ? dir.split('/') : [];
  for (const part of String(rel).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/* -------------------------------------------------------------- textures */

async function loadImgEl(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function nativeToRGBA(bytes, ext) {
  const blob = new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' });
  let src;
  try {
    src = ext === 'svg' ? await loadImgEl(blob) : await createImageBitmap(blob);
  } catch {
    src = await loadImgEl(blob);
  }
  const w = src.naturalWidth || src.width;
  const h = src.naturalHeight || src.height || 1;
  const c = document.createElement('canvas');
  c.width = w || 256;
  c.height = h || 256;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return { width: c.width, height: c.height, rgba: new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer) };
}

/** Pick a mip no bigger than 4096 for the GPU and return { width, height, rgba }. */
function bestMip(entry) {
  const mips = entry.mips || [];
  const m = mips.find((x) => x.width <= 4096 && x.height <= 4096) || mips[mips.length - 1];
  return m ? { width: m.width, height: m.height, rgba: m.rgba } : null;
}

async function textureFromBytes(bytes, name) {
  const ext = extOf(name);
  if (DECODED_IMAGE_EXTS.includes(ext)) return bestMip(decodeImage(bytes, name));
  return nativeToRGBA(bytes, ext || 'png');
}

/* --------------------------------------------------------------- panels */

const errorBox = (msg) => `<div class="pv-error">${esc(msg)}</div>`;

function infoHtml(bytes, name, size) {
  const d = describeFile(bytes, name, size);
  return `<div class="pv-info">
    <table class="pv-table">${d.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    ${d.notes.map((n) => `<p class="faint">${esc(n)}</p>`).join('')}
    <details><summary class="faint">First bytes</summary><pre class="pv-hex">${esc(d.hex)}</pre></details>
  </div>`;
}

async function showTexture(host, ctx, bytes) {
  const { path } = ctx;
  const ext = extOf(path);
  const name = baseOf(path);
  if (ext === 'svg' || ext === 'gif') {
    const url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] }));
    const probe = new Image();
    probe.src = url;
    await probe.decode().catch(() => {});
    ctx.cleanups.push(() => URL.revokeObjectURL(url));
    ctx.cleanups.push(renderTexture(host, { name, imgUrl: url, width: probe.naturalWidth || 0, height: probe.naturalHeight || 0, format: ext.toUpperCase(), note: ext === 'svg' ? 'Shown as an image: scripts inside an SVG never run here.' : undefined }));
    return;
  }
  let entry;
  if (DECODED_IMAGE_EXTS.includes(ext)) entry = { name, ...decodeImage(bytes, name) };
  else {
    const img = await nativeToRGBA(bytes, ext);
    entry = { name, width: img.width, height: img.height, format: ext.toUpperCase(), mips: [img] };
  }
  ctx.cleanups.push(renderTexture(host, entry));
}

async function showYtd(host, ctx, bytes) {
  const { textures } = parseYTD(bytes);
  if (!textures.length) {
    host.innerHTML = errorBox('This texture dictionary has no textures') + infoHtml(bytes, baseOf(ctx.path), bytes.length);
    return;
  }
  ctx.cleanups.push(renderGallery(host, textures, { title: baseOf(ctx.path) }));
}

/* ---------------------------------------------------------------- models */

function makeFiles(server, dirPath) {
  const cache = new Map();
  const list = async (dir) => {
    if (!cache.has(dir)) {
      cache.set(
        dir,
        api(`/api/servers/${encodeURIComponent(server.id)}/files?path=${encodeURIComponent(dir)}`)
          .then((d) => d.items || [])
          .catch(() => [])
      );
    }
    return cache.get(dir);
  };
  return {
    list,
    /** A file beside the model by name (case-insensitive); if exts is given, any file with that stem and one of those extensions. */
    async find(rel, exts) {
      // Exporters often store absolute Windows paths; also try just the file name beside the model.
      const candidates = [resolveRel(dirPath, rel), resolveRel(dirPath, baseOf(String(rel).replace(/\\/g, '/')))];
      for (const full of candidates) {
        if (!full) continue;
        const items = (await list(dirOf(full))).filter((i) => !i.directory);
        const base = baseOf(full).toLowerCase();
        const exact = items.find((i) => i.name.toLowerCase() === base);
        if (exact) return exact;
        if (!exts) continue;
        const stem = stemOf(base);
        for (const e of exts) {
          const hit = items.find((i) => i.name.toLowerCase() === `${stem}.${e}`);
          if (hit) return hit;
        }
      }
      return null;
    },
    async read(item) {
      return fetchBytes(server, item.path);
    },
  };
}

function drawUV(canvas, model, selected, img) {
  const S = canvas.width;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#16170f';
  ctx.fillRect(0, 0, S, S);
  if (img) {
    const t = document.createElement('canvas');
    t.width = img.width;
    t.height = img.height;
    t.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.rgba.byteLength), img.width, img.height), 0, 0);
    ctx.globalAlpha = 0.55;
    ctx.drawImage(t, 0, 0, S, S);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.strokeRect(0.5, 0.5, S - 1, S - 1);
  ctx.strokeStyle = 'rgba(198,244,50,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  let budget = 250000;
  model.meshes.forEach((mesh, mi) => {
    if ((selected !== null && selected !== mi) || !mesh.uvs) return;
    const uv = mesh.uvs;
    const idx = mesh.indices;
    const pt = (i) => [uv[i * 2] * S, (mesh.uvTopDown ? uv[i * 2 + 1] : 1 - uv[i * 2 + 1]) * S];
    for (let i = 0; i + 2 < idx.length && budget-- > 0; i += 3) {
      const a = pt(idx[i]);
      const b = pt(idx[i + 1]);
      const c = pt(idx[i + 2]);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]);
      ctx.closePath();
    }
  });
  ctx.stroke();
}

async function showModel(host, ctx, bytes, kind) {
  const { server, path } = ctx;
  const ext = extOf(path);
  const dirPath = dirOf(path);
  const files = makeFiles(server, dirPath);
  const readSibling = async (rel) => {
    const item = await files.find(rel);
    return item ? files.read(item).catch(() => null) : null;
  };

  let model;
  let embedded = [];
  if (kind === 'rage') ({ model, embedded } = parseRageModel(bytes, ext));
  else if (ext === 'glb' || ext === 'gltf') model = await parseGLTF(bytes, readSibling);
  else if (ext === 'fbx') model = parseFBX(bytes);
  else if (ext === '3mf') model = parse3MF(bytes);
  else {
    model = parseSimpleModel(ext, bytes);
    if (ext === 'obj') {
      for (const lib of [...model.wants]) {
        const item = await files.find(lib);
        if (!item) continue;
        try {
          applyMTL(model, parseMTL(new TextDecoder().decode(await files.read(item))));
        } catch {
          /* a broken .mtl just leaves the mesh untextured */
        }
      }
    }
  }

  const tris = model.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const verts = model.meshes.reduce((n, m) => n + m.positions.length / 3, 0);
  const dirItems = (await files.list(dirPath)).filter((i) => !i.directory);
  const imageFiles = dirItems.filter((i) => IMAGE_EXTS.includes(extOf(i.name)));
  const ytdFiles = dirItems.filter((i) => extOf(i.name) === 'ytd');

  host.innerHTML = `
    <div class="pv-bar">
      <button class="btn btn-sm pv-toggle" data-opt="wireframe" title="Show triangle edges">Wireframe</button>
      <button class="btn btn-sm pv-toggle" data-opt="uvChecker" title="Replace textures with a UV test pattern">UV checker</button>
      <button class="btn btn-sm pv-toggle active" data-opt="textures" title="Apply textures">Textures</button>
      <button class="btn btn-sm pv-toggle" data-uvpanel title="Show the UV layout in 2D">UV layout</button>
      <button class="btn btn-sm" data-reset>Reset view</button>
      <select class="pv-select" data-texsel title="Texture for every mesh">
        <option value="auto">Texture: from material</option>
        <option value="none">Texture: none</option>
        ${imageFiles.map((i) => `<option value="${esc(i.path)}">${esc(i.name)}</option>`).join('')}
      </select>
      <label class="btn btn-sm" title="Pick a texture file from your computer">Texture file<input type="file" class="hidden" data-texfile /></label>
      ${
        kind === 'rage'
          ? `<select class="pv-select" data-ytdsel title="Texture dictionary to pair with this model"><option value="">Pair .ytd: auto</option>${ytdFiles.map((i) => `<option value="${esc(i.path)}">${esc(i.name)}</option>`).join('')}</select>
             <label class="btn btn-sm" title="Pick a .ytd from your computer">Open .ytd<input type="file" accept=".ytd" class="hidden" data-ytdfile /></label>`
          : ''
      }
    </div>
    <div class="pv-model">
      <div class="pv-viewport"><canvas class="pv-gl"></canvas><div class="pv-hint">Drag to orbit. Shift-drag to pan. Wheel to zoom.</div></div>
      <div class="pv-side">
        <div class="pv-uvwrap hidden"><canvas class="pv-uv" width="512" height="512"></canvas></div>
        <div class="pv-meta"><span>${esc(String(model.format))}</span><span>${model.meshes.length} meshes</span><span>${tris.toLocaleString('en-US')} triangles</span><span>${verts.toLocaleString('en-US')} vertices</span></div>
        <div class="pv-meshes" data-meshes></div>
        <div class="pv-notes faint" data-notes>${model.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>
        <p class="faint" data-status></p>
      </div>
    </div>`;

  if (!glSupported()) {
    host.querySelector('.pv-viewport').innerHTML = errorBox('This browser has no WebGL 2, so the 3D view is unavailable.');
    return;
  }
  const canvas = host.querySelector('.pv-gl');
  const viewer = createViewer(canvas);
  ctx.cleanups.push(() => viewer.destroy());
  viewer.setModel(model);

  const meshTex = model.meshes.map(() => null);
  let selected = null;
  let pairedYtd = []; // texture entries from a paired .ytd
  const status = host.querySelector('[data-status]');
  const texCache = new Map();

  const lookup = async (name) => {
    const key = normName(name);
    if (texCache.has(key)) return texCache.get(key);
    const p = (async () => {
      const raw = model.images[name];
      if (raw) return textureFromBytes(raw.bytes, raw.name);
      const hit = [...embedded, ...pairedYtd].find((t) => normName(t.name) === key && t.mips?.length);
      if (hit) return bestMip(hit);
      const item = await files.find(name, TEXTURE_TRY);
      if (item) return textureFromBytes(await files.read(item), item.name);
      return null;
    })().catch(() => null);
    texCache.set(key, p);
    return p;
  };

  const refreshMeshList = () => {
    host.querySelector('[data-meshes]').innerHTML = model.meshes
      .map((m, i) => {
        const t = meshTex[i];
        const label = m.material.map ? (t ? 'textured' : 'texture not found') : 'no texture';
        return `<button class="pv-mesh${selected === i ? ' active' : ''}" data-mesh="${i}"><span class="mono">${esc(m.name)}</span><span class="faint">${esc(m.material.map || m.material.name || '')}</span><span class="faint">${esc(`${m.indices.length / 3} tris, ${label}`)}</span></button>`;
      })
      .join('');
    host.querySelectorAll('[data-mesh]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.dataset.mesh);
        selected = selected === i ? null : i;
        refreshMeshList();
        refreshUV();
      })
    );
  };
  const uvPanel = host.querySelector('.pv-uvwrap');
  const refreshUV = () => {
    if (uvPanel.classList.contains('hidden')) return;
    const withUV = model.meshes.some((m) => m.uvs);
    if (!withUV) {
      uvPanel.innerHTML = '<p class="faint">This model has no UV coordinates.</p>';
      return;
    }
    const canvasUV = uvPanel.querySelector('canvas') || (uvPanel.innerHTML = '<canvas class="pv-uv" width="512" height="512"></canvas>', uvPanel.querySelector('canvas'));
    drawUV(canvasUV, model, selected, selected !== null ? meshTex[selected] : meshTex.find(Boolean) || null);
  };

  const applyAuto = async () => {
    status.textContent = 'Looking for textures...';
    let found = 0;
    for (let i = 0; i < model.meshes.length; i++) {
      const map = model.meshes[i].material.map;
      meshTex[i] = map ? await lookup(map) : null;
      viewer.setTexture(i, meshTex[i]);
      if (meshTex[i]) found++;
    }
    const wanted = new Set(model.meshes.map((m) => m.material.map).filter(Boolean)).size;
    status.textContent = wanted
      ? `${found ? 'Textures applied.' : 'No textures found.'} ${wanted} referenced${kind === 'rage' && !pairedYtd.length && !embedded.length ? '. Pick a .ytd above to supply them.' : '.'}`
      : 'This model does not reference any texture. Pick one above to try it.';
    refreshMeshList();
    refreshUV();
  };
  const applyAll = (img) => {
    model.meshes.forEach((_, i) => {
      meshTex[i] = img;
      viewer.setTexture(i, img);
    });
    refreshMeshList();
    refreshUV();
  };

  const loadYtd = async (bytes) => {
    pairedYtd = parseYTD(bytes).textures;
    texCache.clear();
    await applyAuto();
  };
  const autoPairYtd = async () => {
    const stem = stemOf(baseOf(path)).toLowerCase();
    const base = stem.replace(/(_hi|_lod|_high|\+hi)$/, '');
    const names = [stem, base, `${base}_hi`, `${base}+hi`].map((n) => `${n}.ytd`);
    let hit = null;
    for (const n of names) hit = hit || ytdFiles.find((i) => i.name.toLowerCase() === n);
    if (!hit && ytdFiles.length === 1) hit = ytdFiles[0];
    if (!hit) return;
    try {
      pairedYtd = parseYTD(await files.read(hit)).textures;
      host.querySelector('[data-ytdsel]').value = hit.path;
    } catch (e) {
      status.textContent = `Could not read ${hit.name}: ${e.message}`;
    }
  };

  host.querySelectorAll('[data-opt]').forEach((b) =>
    b.addEventListener('click', () => {
      b.classList.toggle('active');
      viewer.setOptions({ [b.dataset.opt]: b.classList.contains('active') });
    })
  );
  host.querySelector('[data-reset]').addEventListener('click', () => viewer.reset());
  host.querySelector('[data-uvpanel]').addEventListener('click', (e) => {
    e.currentTarget.classList.toggle('active');
    uvPanel.classList.toggle('hidden');
    refreshUV();
  });
  host.querySelector('[data-texsel]').addEventListener('change', async (e) => {
    const v = e.target.value;
    try {
      if (v === 'auto') await applyAuto();
      else if (v === 'none') applyAll(null);
      else {
        const item = imageFiles.find((i) => i.path === v);
        applyAll(await textureFromBytes(await files.read(item), item.name));
        status.textContent = `Applied ${item.name} to every mesh.`;
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  host.querySelector('[data-texfile]').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > MAX_PREVIEW_BYTES) return toast('That file is too large to preview', 'error');
    try {
      applyAll(await textureFromBytes(new Uint8Array(await f.arrayBuffer()), f.name));
      status.textContent = `Applied ${f.name} to every mesh.`;
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  host.querySelector('[data-ytdsel]')?.addEventListener('change', async (e) => {
    try {
      if (!e.target.value) {
        pairedYtd = [];
        texCache.clear();
        await autoPairYtd();
        await applyAuto();
      } else {
        const item = ytdFiles.find((i) => i.path === e.target.value);
        await loadYtd(await files.read(item));
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  host.querySelector('[data-ytdfile]')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > MAX_PREVIEW_BYTES) return toast('That file is too large to preview', 'error');
    try {
      await loadYtd(new Uint8Array(await f.arrayBuffer()));
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  refreshMeshList();
  if (kind === 'rage') await autoPairYtd();
  await applyAuto();
}

/* -------------------------------------------------------------- entry */

/**
 * Render a preview of `path` into `host`. Returns a cleanup function.
 * Used by the preview modal, and by editor tabs through preview-tab.js.
 */
export function renderPreview(host, { server, path }) {
  const ctx = { server, path, cleanups: [] };
  let dead = false;
  host.innerHTML = '<div class="pv-loading faint">Loading preview...</div>';
  (async () => {
    const kind = previewKind(path);
    if (!kind) {
      host.innerHTML = errorBox('There is no preview for this file type');
      return;
    }
    let bytes;
    try {
      bytes = await fetchBytes(server, path);
    } catch (err) {
      if (!dead) host.innerHTML = errorBox(err.message);
      return;
    }
    if (dead) return;
    try {
      if (kind === 'texture') await showTexture(host, ctx, bytes);
      else if (kind === 'ytd') await showYtd(host, ctx, bytes);
      else if (kind === 'model' || kind === 'rage') await showModel(host, ctx, bytes, kind);
      else host.innerHTML = infoHtml(bytes, baseOf(path), bytes.length);
    } catch (err) {
      // Show why, plus what we do know about the file, instead of an empty window.
      if (!dead) host.innerHTML = errorBox(err?.message || 'This file could not be previewed') + infoHtml(bytes, baseOf(path), bytes.length);
    }
  })();
  return () => {
    dead = true;
    for (const fn of ctx.cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* cleanup is best effort */
      }
    }
  };
}

/**
 * For the tabbed editor (branch wk-ux2): after merging, wire it with one line in files.js or main.js:
 *   import { registerTabViewer } from './editor.js'; registerTabViewer(previewTabViewer);
 * Previewable binary files then open as read-only editor tabs instead of a modal.
 */
export const previewTabViewer = {
  match: (path) => opensPreview(path),
  render: (host, { server, path }) => renderPreview(host, { server, path }),
};

/** Open the preview in a modal window. */
export function openPreview(server, path) {
  const id = `pv${Math.random().toString(36).slice(2, 8)}`;
  const modal = openModal({
    title: esc(path),
    width: 1100,
    body: `<div class="pv-host" data-pv="${id}"></div>`,
    actions: [{ label: 'Close', close: true }],
  });
  const host = $(`[data-pv="${id}"]`);
  const cleanup = renderPreview(host, { server, path });
  const root = $('#modal-root');
  const mo = new MutationObserver(() => {
    if (!host.isConnected) {
      cleanup();
      mo.disconnect();
    }
  });
  if (root) mo.observe(root, { childList: true, subtree: true });
  return modal;
}
