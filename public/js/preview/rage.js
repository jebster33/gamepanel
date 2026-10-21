// GTA V (RAGE, legacy "gen8" PC resources): RSC7 container, texture dictionaries (.ytd) and drawables (.ydr/.ydd/.yft).
// Only unencrypted resources can be read (as exported by OpenIV/CodeWalker). Encrypted (AES) game archives need the
// game's keys, which are never shipped here. The structure offsets follow the community documentation of the format;
// they have been checked against hand-built fixtures, not against a live game install.
// No DOM access at module load, so this runs under node for tests.

import { inflateRaw } from './inflate.js';
import { bcSize, decodeBC, expandPixels } from './images.js';
import { makeMesh, newModel, transformMesh, Z_UP_TO_Y_UP } from './model-text.js';

export class RageError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export const RAGE_RESOURCE_EXTS = ['ytd', 'ydr', 'ydd', 'yft', 'ybn', 'ymap', 'ytyp', 'ycd', 'ypt', 'yld', 'ymt', 'ynd', 'ynv', 'yed', 'yvr', 'ywr', 'yfd', 'awc', 'ysc'];

export function joaat(str) {
  let h = 0;
  for (const ch of String(str).toLowerCase()) {
    h = (h + ch.charCodeAt(0)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h >>> 0;
}

export function sizeFromFlags(flags) {
  const s0 = ((flags >>> 27) & 1) << 0;
  const s1 = ((flags >>> 26) & 1) << 1;
  const s2 = ((flags >>> 25) & 1) << 2;
  const s3 = ((flags >>> 24) & 1) << 3;
  const s4 = ((flags >>> 17) & 0x7f) << 4;
  const s5 = ((flags >>> 11) & 0x3f) << 5;
  const s6 = ((flags >>> 7) & 0xf) << 6;
  const s7 = ((flags >>> 5) & 3) << 7;
  const s8 = ((flags >>> 4) & 1) << 8;
  const base = 0x200 << (flags & 15);
  return base * (s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8);
}

/** Header facts without decompressing. Returns null if the file is not an RSC container. */
export function rscHeader(bytes) {
  if (bytes.length < 16) return null;
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== 'RSC7' && magic !== 'RSC8') return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sysFlags = dv.getUint32(8, true);
  const gfxFlags = dv.getUint32(12, true);
  return { magic, version: dv.getUint32(4, true), sysFlags, gfxFlags, sysSize: sizeFromFlags(sysFlags), gfxSize: sizeFromFlags(gfxFlags) };
}

/** Decompress an RSC7 resource into one buffer (system pages, then graphics pages). */
export function readRSC(bytes) {
  const head = rscHeader(bytes);
  if (!head) throw new RageError('This is not a RAGE resource (no RSC7 header)', 'format');
  if (head.magic === 'RSC8') throw new RageError('This is a GTA V Enhanced (RSC8) resource, which is not supported', 'gen9');
  let data;
  try {
    data = inflateRaw(bytes.subarray(16), head.sysSize + head.gfxSize, 512 * 1024 * 1024);
  } catch {
    throw new RageError('This resource could not be decompressed. Files taken straight from the game archives are AES encrypted and need the game keys. Export it unencrypted with OpenIV or CodeWalker first.', 'encrypted');
  }
  const sysSize = Math.min(head.sysSize, data.length);
  return { ...head, data, sysSize };
}

/** Pointer-aware reader over the decompressed resource. */
class Reader {
  constructor(rsc) {
    this.d = rsc.data;
    this.dv = new DataView(rsc.data.buffer, rsc.data.byteOffset, rsc.data.byteLength);
    this.sysSize = rsc.sysSize;
  }

  u8(o) {
    if (!(o >= 0 && o < this.d.length)) throw new RangeError('read out of range');
    return this.d[o];
  }

  u16(o) {
    if (!(o >= 0 && o + 2 <= this.d.length)) throw new RangeError('read out of range');
    return this.dv.getUint16(o, true);
  }

  u32(o) {
    if (!(o >= 0 && o + 4 <= this.d.length)) throw new RangeError('read out of range');
    return this.dv.getUint32(o, true);
  }

  f32(o) {
    if (!(o >= 0 && o + 4 <= this.d.length)) throw new RangeError('read out of range');
    return this.dv.getFloat32(o, true);
  }

  /** A 64-bit virtual pointer at o -> offset into data, or null for a null/foreign pointer. */
  ptr(o) {
    const lo = this.u32(o);
    const hi = this.u32(o + 4);
    return this.addr(lo, hi);
  }

  addr(lo, hi = 0) {
    if (hi !== 0) return null;
    const seg = lo >>> 28;
    const off = lo & 0x0fffffff;
    if (seg === 5) return off < this.sysSize ? off : null;
    if (seg === 6) return this.sysSize + off < this.d.length ? this.sysSize + off : null;
    return null;
  }

  cstr(o, max = 256) {
    let s = '';
    for (let i = 0; i < max && o + i < this.d.length && this.d[o + i]; i++) s += String.fromCharCode(this.d[o + i]);
    return s;
  }
}

/* -------------------------------------------------------------- textures */

const TEX_FORMATS = {
  0x31545844: { name: 'DXT1', kind: 'bc1a' },
  0x33545844: { name: 'DXT3', kind: 'bc2' },
  0x35545844: { name: 'DXT5', kind: 'bc3' },
  0x31495441: { name: 'ATI1 (BC4)', kind: 'bc4' },
  0x32495441: { name: 'ATI2 (BC5)', kind: 'bc5' },
  0x20374342: { name: 'BC7', kind: null, unsupported: true },
  21: { name: 'A8R8G8B8', px: 'bgra', bpp: 4 },
  22: { name: 'X8R8G8B8', px: 'bgrx', bpp: 4 },
  32: { name: 'A8B8G8R8', px: 'rgba', bpp: 4 },
  25: { name: 'A1R5G5B5', px: 'argb1555', bpp: 2 },
  28: { name: 'A8', px: 'a8', bpp: 1 },
  50: { name: 'L8', px: 'l8', bpp: 1 },
};

function parseTexture(R, o) {
  const nameOff = R.ptr(o + 0x28);
  const name = nameOff !== null ? R.cstr(nameOff) : '';
  const width = R.u16(o + 0x50);
  const height = R.u16(o + 0x52);
  const rawFormat = R.u32(o + 0x58);
  const levels = Math.max(1, R.u8(o + 0x5d));
  const dataOff = R.ptr(o + 0x70);
  const fmt = TEX_FORMATS[rawFormat];
  const tex = { name: name || 'texture', width, height, format: fmt ? fmt.name : '0x' + rawFormat.toString(16), levels, mips: [], error: null };
  if (!fmt || fmt.unsupported) {
    tex.error = fmt ? `${fmt.name} textures are not supported by this previewer` : `Unknown texture format 0x${rawFormat.toString(16)}`;
    return tex;
  }
  if (!width || !height || width > 16384 || height > 16384 || dataOff === null) {
    tex.error = 'Texture header looks invalid';
    return tex;
  }
  let p = dataOff;
  let w = width;
  let h = height;
  for (let i = 0; i < levels; i++) {
    const size = fmt.kind ? bcSize(fmt.kind === 'bc1a' ? 'bc1' : fmt.kind, w, h) : w * h * fmt.bpp;
    if (p + size > R.d.length) break;
    const at = p;
    const mw = w;
    const mh = h;
    let cache = null;
    tex.mips.push({
      width: mw,
      height: mh,
      get rgba() {
        if (!cache) cache = fmt.kind ? decodeBC(fmt.kind, R.d.subarray(at, at + size), mw, mh) : expandPixels(fmt.px, R.d.subarray(at, at + size), mw, mh);
        return cache;
      },
    });
    p += size;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  if (!tex.mips.length) tex.error = 'Texture pixel data is missing or truncated';
  return tex;
}

function parseDictAt(R, o) {
  const arrOff = R.ptr(o + 0x30);
  const count = R.u16(o + 0x38);
  const textures = [];
  if (arrOff === null || count > 4096) return textures;
  for (let i = 0; i < count; i++) {
    const to = R.ptr(arrOff + i * 8);
    if (to === null) continue;
    try {
      textures.push(parseTexture(R, to));
    } catch {
      textures.push({ name: 'texture ' + i, width: 0, height: 0, format: '?', levels: 0, mips: [], error: 'Texture could not be read' });
    }
  }
  return textures;
}

/** Texture dictionary (.ytd). Returns { textures: [{ name, width, height, format, levels, mips, error }] }. */
export function parseYTD(bytes) {
  const rsc = readRSC(bytes);
  const R = new Reader(rsc);
  let textures;
  try {
    textures = parseDictAt(R, 0);
  } catch {
    throw new RageError('The texture dictionary structure was not recognised', 'format');
  }
  return { version: rsc.version, textures };
}

/* ------------------------------------------------------------- drawables */

const TYPE_SIZE = { 1: 4, 2: 4, 3: 8, 4: 4, 5: 8, 6: 12, 7: 16, 8: 4, 9: 4, 10: 4 };

function half(v) {
  const s = v & 0x8000 ? -1 : 1;
  const e = (v >> 10) & 31;
  const f = v & 1023;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return 0;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

function readGeometry(R, g, shaderTex, shaderMapping, geomIndex, name) {
  const vb = R.ptr(g + 0x18);
  const ib = R.ptr(g + 0x38);
  if (vb === null || ib === null) return null;
  const stride = R.u16(vb + 8);
  const vdata = R.ptr(vb + 0x10);
  const vcount = R.u32(vb + 0x18);
  const decl = R.ptr(vb + 0x30);
  const icount = R.u32(ib + 8);
  const idata = R.ptr(ib + 0x10);
  if (vdata === null || idata === null || decl === null || !vcount || vcount > 400000 || !icount || icount > 3_000_000 || stride < 12 || stride > 256) return null;
  if (vdata + vcount * stride > R.d.length || idata + icount * 2 > R.d.length) return null;
  const flags = R.u32(decl);
  const typesLo = R.u32(decl + 8);
  const typesHi = R.u32(decl + 12);
  const elems = {};
  let off = 0;
  for (let s = 0; s < 16; s++) {
    if (!(flags & (1 << s))) continue;
    const type = ((s < 8 ? typesLo : typesHi) >>> ((s & 7) * 4)) & 15;
    elems[s] = { off, type };
    off += TYPE_SIZE[type] || 0;
  }
  const readVec = (e, n, i) => {
    const base = vdata + i * stride + e.off;
    const out = [];
    if (e.type === 1 || e.type === 3) for (let k = 0; k < n; k++) out.push(half(R.u16(base + k * 2)));
    else for (let k = 0; k < n; k++) out.push(R.f32(base + k * 4));
    return out;
  };
  // Position is semantic 0, normal 3, first texture coordinate 6. Fall back to the common layout when the declaration disagrees with the stride.
  const layoutOk = off === stride && elems[0] && (elems[0].type === 6 || elems[0].type === 7);
  const pe = layoutOk ? elems[0] : { off: 0, type: 6 };
  const ne = layoutOk ? elems[3] : null;
  const te = layoutOk ? elems[6] : null;
  const pos = new Float32Array(vcount * 3);
  const nrm = ne && (ne.type === 6 || ne.type === 7 || ne.type === 3) ? new Float32Array(vcount * 3) : null;
  const uv = te && (te.type === 1 || te.type === 5) ? new Float32Array(vcount * 2) : null;
  for (let i = 0; i < vcount; i++) {
    pos.set(readVec(pe, 3, i), i * 3);
    if (nrm) nrm.set(readVec(ne, 3, i), i * 3);
    if (uv) uv.set(readVec(te, 2, i), i * 2);
  }
  const idx = new Uint32Array(icount - (icount % 3));
  for (let i = 0; i < idx.length; i++) {
    const v = R.u16(idata + i * 2);
    if (v >= vcount) return null;
    idx[i] = v;
  }
  const shaderIndex = shaderMapping ? shaderMapping[geomIndex] : geomIndex;
  const map = shaderTex[shaderIndex] || null;
  const mesh = makeMesh(name, pos, nrm, uv, idx, { name: map || 'shader ' + shaderIndex, map });
  mesh.uvTopDown = true;
  return transformMesh(mesh, Z_UP_TO_Y_UP);
}

const DIFFUSE_HASHES = ['texturesampler', 'diffusesampler', 'diffusetexture', 'basecolorsampler'].map(joaat);

function readShaders(R, o) {
  const sg = R.ptr(o + 0x10);
  const result = { textures: [], embedded: [] };
  if (sg === null) return result;
  try {
    const dictOff = R.ptr(sg + 8);
    if (dictOff !== null) result.embedded = parseDictAt(R, dictOff);
  } catch {
    /* no embedded dictionary */
  }
  const arr = R.ptr(sg + 0x10);
  const count = R.u16(sg + 0x18);
  if (arr === null || count > 512) return result;
  for (let i = 0; i < count; i++) {
    let chosen = null;
    try {
      const sh = R.ptr(arr + i * 8);
      const params = sh !== null ? R.ptr(sh) : null;
      const n = sh !== null ? R.u8(sh + 0x10) : 0;
      if (params !== null && n > 0 && n < 64) {
        let first = null;
        for (let k = 0; k < n; k++) {
          if (R.u8(params + k * 16) !== 0) continue;
          const tp = R.ptr(params + k * 16 + 8);
          const nameOff = tp !== null ? R.ptr(tp + 0x28) : null;
          const tname = nameOff !== null ? R.cstr(nameOff) : '';
          if (!tname) continue;
          const hash = R.u32(params + n * 16 + k * 4);
          if (DIFFUSE_HASHES.includes(hash) && !chosen) chosen = tname;
          if (!first) first = tname;
        }
        chosen = chosen || first;
      }
    } catch {
      /* leave untextured */
    }
    result.textures.push(chosen);
  }
  return result;
}

/** A Drawable at offset o. Returns { meshes, embedded, wants }. */
function readDrawable(R, o, label) {
  const shaders = readShaders(R, o);
  const meshes = [];
  for (const lodAt of [0x50, 0x58, 0x60, 0x68]) {
    const list = R.ptr(o + lodAt);
    if (list === null) continue;
    const entries = R.ptr(list);
    const n = R.u16(list + 8);
    if (entries === null || !n || n > 256) continue;
    for (let m = 0; m < n; m++) {
      const mo = R.ptr(entries + m * 8);
      if (mo === null) continue;
      const geoms = R.ptr(mo + 8);
      const gcount = R.u16(mo + 0x10);
      const mapOff = R.ptr(mo + 0x20);
      if (geoms === null || !gcount || gcount > 256) continue;
      const mapping = mapOff === null ? null : Array.from({ length: gcount }, (_, i) => R.u16(mapOff + i * 2));
      for (let gi = 0; gi < gcount; gi++) {
        const go = R.ptr(geoms + gi * 8);
        if (go === null) continue;
        try {
          const mesh = readGeometry(R, go, shaders.textures, mapping, gi, `${label} m${m}g${gi}`);
          if (mesh) meshes.push(mesh);
        } catch {
          /* skip an unreadable geometry */
        }
      }
    }
    if (meshes.length) break; // highest level of detail only
  }
  return { meshes, embedded: shaders.embedded };
}

function looksLikeDrawable(R, o) {
  try {
    if (R.ptr(o + 0x10) === null) return false;
    const list = R.ptr(o + 0x50);
    if (list === null) return false;
    const entries = R.ptr(list);
    const n = R.u16(list + 8);
    if (entries === null || n < 1 || n > 64) return false;
    const mo = R.ptr(entries);
    if (mo === null) return false;
    const geoms = R.ptr(mo + 8);
    const gc = R.u16(mo + 0x10);
    if (geoms === null || gc < 1 || gc > 64) return false;
    const go = R.ptr(geoms);
    if (go === null) return false;
    const vb = R.ptr(go + 0x18);
    if (vb === null) return false;
    const stride = R.u16(vb + 8);
    return stride >= 12 && stride <= 128 && R.ptr(vb + 0x10) !== null;
  } catch {
    return false;
  }
}

/**
 * Parse .ydr (drawable), .ydd (drawable dictionary) or .yft (fragment).
 * Returns a model plus `embedded` textures stored in the file itself.
 */
export function parseRageModel(bytes, ext) {
  const rsc = readRSC(bytes);
  const R = new Reader(rsc);
  const model = newModel(ext.toUpperCase());
  const embedded = [];
  const add = (res) => {
    model.meshes.push(...res.meshes);
    embedded.push(...res.embedded);
  };
  if (ext === 'ydr') {
    if (!looksLikeDrawable(R, 0)) throw new RageError('The drawable structure was not recognised', 'format');
    add(readDrawable(R, 0, 'drawable'));
  } else if (ext === 'ydd') {
    const arr = R.ptr(0x30);
    const count = R.u16(0x38);
    if (arr === null || !count || count > 1024) throw new RageError('The drawable dictionary structure was not recognised', 'format');
    for (let i = 0; i < count; i++) {
      const d = R.ptr(arr + i * 8);
      if (d !== null && looksLikeDrawable(R, d)) add(readDrawable(R, d, 'drawable ' + i));
    }
  } else {
    // A fragment embeds its drawables; find them by shape rather than by trusting one fixed offset.
    const found = [];
    for (let o = 0; o + 0x70 <= rsc.sysSize && found.length < 12; o += 16) if (looksLikeDrawable(R, o)) found.push(o);
    if (!found.length) throw new RageError('No drawable was found inside this fragment', 'format');
    for (const [i, o] of found.entries()) add(readDrawable(R, o, 'drawable ' + i));
    model.notes.push('Fragment: drawables were located heuristically; damage models and physics are not shown');
  }
  if (!model.meshes.length) throw new RageError('No renderable geometry could be read (the layout may differ from what this previewer expects)', 'format');
  for (const m of model.meshes) if (m.material.map && !model.wants.includes(m.material.map)) model.wants.push(m.material.map);
  model.notes.push('Z-up game coordinates converted for display. Read from the community-documented layout; not verified against a live game install.');
  return { model, embedded };
}
