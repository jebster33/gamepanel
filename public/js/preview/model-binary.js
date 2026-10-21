// glTF/GLB, FBX (binary and ASCII), and 3MF mesh parsers. Meshes only: no skinning, animation or lights.
// No DOM access at module load, so these run under node for tests.

import { inflateRaw, inflateZlib } from './inflate.js';
import { IDENT, makeMesh, mmul, newModel, parseXML, transformMesh, trs, xmlAll, xmlDeep, xmlFind, Z_UP_TO_Y_UP } from './model-text.js';

const dec = (b) => new TextDecoder('utf-8').decode(b);
const baseName = (s) => String(s || '').replace(/\\/g, '/').split('/').pop();

/* ------------------------------------------------------------------ zip */

/** Reads a zip's central directory. Returns Map(name -> () => Uint8Array). Stored and deflated entries only. */
export function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a zip archive');
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const files = new Map();
  for (let i = 0; i < count && p + 46 <= bytes.length && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec(bytes.subarray(p + 46, p + 46 + nlen));
    files.set(name, () => {
      const ds = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = bytes.subarray(ds, ds + csize);
      if (method === 0) return raw;
      if (method === 8) return inflateRaw(raw, usize, 256 * 1024 * 1024);
      throw new Error('Unsupported zip compression');
    });
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

/* ----------------------------------------------------------------- glTF */

const COMP = { 5120: [1, 'Int8'], 5121: [1, 'Uint8'], 5122: [2, 'Int16'], 5123: [2, 'Uint16'], 5125: [4, 'Uint32'], 5126: [4, 'Float32'] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function b64(uri) {
  const bin = atob(uri.slice(uri.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** resolve(uri) -> Promise<Uint8Array|null> fetches files referenced by a .gltf. */
export async function parseGLTF(bytes, resolve = async () => null) {
  let json;
  let bin = null;
  if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 12;
    while (p + 8 <= bytes.length) {
      const len = dv.getUint32(p, true);
      const type = dv.getUint32(p + 4, true);
      if (type === 0x4e4f534a) json = JSON.parse(dec(bytes.subarray(p + 8, p + 8 + len)));
      else if (type === 0x004e4942 && !bin) bin = bytes.subarray(p + 8, p + 8 + len);
      p += 8 + len;
    }
  } else json = JSON.parse(dec(bytes));
  if (!json?.asset) throw new Error('Not a glTF file');
  const model = newModel('glTF');
  const buffers = [];
  for (let i = 0; i < (json.buffers || []).length; i++) {
    const b = json.buffers[i];
    if (!b.uri) buffers.push(bin);
    else if (b.uri.startsWith('data:')) buffers.push(b64(b.uri));
    else {
      const got = await resolve(decodeURIComponent(b.uri));
      if (!got) model.wants.push(baseName(b.uri));
      buffers.push(got);
    }
  }
  const viewBytes = (vi) => {
    const v = json.bufferViews[vi];
    const buf = buffers[v.buffer];
    if (!buf) throw new Error('A buffer file is missing: put it beside the model');
    return { buf, offset: v.byteOffset || 0, length: v.byteLength, stride: v.byteStride || 0 };
  };
  const readAccessor = (ai) => {
    const a = json.accessors[ai];
    const [csize, cname] = COMP[a.componentType];
    const n = NCOMP[a.type];
    const out = a.componentType === 5126 ? new Float32Array(a.count * n) : a.componentType === 5125 ? new Uint32Array(a.count * n) : new Float32Array(a.count * n);
    if (a.bufferView !== undefined) {
      const v = viewBytes(a.bufferView);
      const dv = new DataView(v.buf.buffer, v.buf.byteOffset + v.offset + (a.byteOffset || 0), v.length - (a.byteOffset || 0));
      const stride = v.stride || csize * n;
      const norm = a.normalized && a.componentType !== 5126 && a.componentType !== 5125;
      const maxv = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType];
      for (let i = 0; i < a.count; i++) {
        for (let k = 0; k < n; k++) {
          const val = dv[`get${cname}`](i * stride + k * csize, true);
          out[i * n + k] = norm ? Math.max(val / maxv, -1) : val;
        }
      }
    }
    return out;
  };

  // textures
  const imageKey = async (imgIdx) => {
    const key = 'gltf-image-' + imgIdx;
    if (model.images[key]) return key;
    const im = json.images?.[imgIdx];
    if (!im) return null;
    let data = null;
    let name = im.name || key;
    if (im.bufferView !== undefined) {
      const v = viewBytes(im.bufferView);
      data = v.buf.subarray(v.offset, v.offset + v.length);
      name = key + (/jpeg/.test(im.mimeType || '') ? '.jpg' : /webp/.test(im.mimeType) ? '.webp' : '.png');
    } else if (im.uri?.startsWith('data:')) {
      data = b64(im.uri);
      name = key + (/jpeg/.test(im.uri.slice(0, 30)) ? '.jpg' : /webp/.test(im.uri.slice(0, 30)) ? '.webp' : '.png');
    } else if (im.uri) {
      data = await resolve(decodeURIComponent(im.uri));
      name = baseName(decodeURIComponent(im.uri));
      if (!data) {
        model.wants.push(name);
        return name;
      }
    }
    if (!data) return null;
    model.images[key] = { bytes: data, name };
    return key;
  };
  const materialOf = async (mi) => {
    const m = json.materials?.[mi];
    if (!m) return {};
    const pbr = m.pbrMetallicRoughness || {};
    let map = null;
    const tex = pbr.baseColorTexture ?? m.extensions?.KHR_materials_pbrSpecularGlossiness?.diffuseTexture;
    if (tex) {
      const src = json.textures?.[tex.index]?.source;
      if (src !== undefined) map = await imageKey(src);
    }
    return { name: m.name || 'material ' + mi, color: pbr.baseColorFactor || [0.8, 0.8, 0.8, 1], map };
  };

  const out = [];
  const visit = async (ni, parent, depth = 0) => {
    const node = json.nodes?.[ni];
    if (!node || depth > 64) return;
    let local = IDENT;
    if (node.matrix) {
      const m = node.matrix;
      local = [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
    } else if (node.translation || node.rotation || node.scale) local = trs(node.translation || [0, 0, 0], node.rotation || [0, 0, 0, 1], node.scale || [1, 1, 1]);
    const world = mmul(parent, local);
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      for (const prim of mesh?.primitives || []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        const pos = readAccessor(prim.attributes.POSITION);
        const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL) : null;
        const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(prim.attributes.TEXCOORD_0) : null;
        const idx = prim.indices !== undefined ? readAccessor(prim.indices) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        let col = null;
        if (prim.attributes.COLOR_0 !== undefined) {
          const c = readAccessor(prim.attributes.COLOR_0);
          const comps = c.length / (pos.length / 3);
          col = new Float32Array(pos.length);
          for (let i = 0; i < pos.length / 3; i++) for (let k = 0; k < 3; k++) col[i * 3 + k] = c[i * comps + k];
        }
        const mat = await materialOf(prim.material);
        const me = makeMesh(mesh.name || node.name || 'mesh', pos, nrm, uv, idx, mat, col);
        me.uvTopDown = true;
        transformMesh(me, world);
        out.push(me);
      }
    }
    for (const c of node.children || []) await visit(c, world, depth + 1);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes || (json.nodes || []).map((_, i) => i);
  for (const r of roots) await visit(r, IDENT);
  model.meshes.push(...out);
  if (!out.length) throw new Error('No triangle meshes found in this glTF');
  return model;
}

/* ------------------------------------------------------------------ FBX */

const FBX_MAGIC = 'Kaydara FBX Binary  ';

function fbxBinary(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(23, true);
  const wide = version >= 7500;
  const hdr = wide ? 25 : 13;
  let nodes = 0;
  const readProp = (p) => {
    const t = String.fromCharCode(bytes[p]);
    p++;
    switch (t) {
      case 'Y': return [dv.getInt16(p, true), p + 2];
      case 'C': return [bytes[p] !== 0, p + 1];
      case 'I': return [dv.getInt32(p, true), p + 4];
      case 'F': return [dv.getFloat32(p, true), p + 4];
      case 'D': return [dv.getFloat64(p, true), p + 8];
      case 'L': return [Number(dv.getBigInt64(p, true)), p + 8];
      case 'S': case 'R': {
        const n = dv.getUint32(p, true);
        const raw = bytes.subarray(p + 4, p + 4 + n);
        return [t === 'S' ? dec(raw).split('\u0000')[0] : raw, p + 4 + n];
      }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const n = dv.getUint32(p, true);
        const enc = dv.getUint32(p + 4, true);
        const clen = dv.getUint32(p + 8, true);
        const size = { f: 4, d: 8, l: 8, i: 4, b: 1 }[t];
        let data = bytes.subarray(p + 12, p + 12 + clen);
        if (enc === 1) data = inflateZlib(data, n * size, 512 * 1024 * 1024);
        const copy = new Uint8Array(data.length);
        copy.set(data);
        const arr = t === 'f' ? new Float32Array(copy.buffer, 0, n) : t === 'd' ? new Float64Array(copy.buffer, 0, n) : t === 'i' ? new Int32Array(copy.buffer, 0, n) : t === 'b' ? copy.subarray(0, n) : Array.from(new BigInt64Array(copy.buffer, 0, n), Number);
        return [arr, p + 12 + clen];
      }
      default: throw new Error('Unknown FBX property type');
    }
  };
  const readNode = (p) => {
    if (++nodes > 5_000_000) throw new Error('FBX file is too complex');
    const end = wide ? Number(dv.getBigUint64(p, true)) : dv.getUint32(p, true);
    const nprops = wide ? Number(dv.getBigUint64(p + 8, true)) : dv.getUint32(p + 4, true);
    const nameLen = bytes[p + hdr - 1];
    if (end === 0) return [null, p + hdr];
    const name = String.fromCharCode(...bytes.subarray(p + hdr, p + hdr + nameLen));
    let q = p + hdr + nameLen;
    const props = [];
    for (let i = 0; i < nprops; i++) {
      const [v, nq] = readProp(q);
      props.push(v);
      q = nq;
    }
    const children = [];
    while (q < end) {
      const [c, nq] = readNode(q);
      q = nq;
      if (c) children.push(c);
    }
    return [{ name, props, children }, end];
  };
  const root = { name: '', props: [], children: [] };
  let p = 27;
  while (p + hdr <= bytes.length) {
    const [n, np] = readNode(p);
    if (!n) break;
    root.children.push(n);
    p = np;
  }
  return root;
}

function fbxAscii(text) {
  let p = 0;
  const n = text.length;
  const skipWs = () => {
    for (;;) {
      while (p < n && /\s/.test(text[p])) p++;
      if (text[p] === ';') while (p < n && text[p] !== '\n') p++;
      else break;
    }
  };
  const parseNodes = (isRoot) => {
    const out = [];
    for (;;) {
      skipWs();
      if (p >= n) break;
      if (text[p] === '}') {
        p++;
        if (!isRoot) break;
        continue;
      }
      const m = /^([A-Za-z_][\w ]*?)\s*:/.exec(text.slice(p, p + 128));
      if (!m) {
        p++;
        continue;
      }
      p += m[0].length;
      const name = m[1];
      const props = [];
      const children = [];
      for (;;) {
        while (p < n && (text[p] === ' ' || text[p] === '\t' || text[p] === '\r')) p++;
        const c = text[p];
        if (c === '{') {
          p++;
          children.push(...parseNodes(false));
          break;
        }
        if (c === '\n' && name !== 'a') break;
        if (p >= n) break;
        if (name === 'a' && c === '}') break;
        if (c === ',' || c === '\n') p++;
        else if (c === '"') {
          const e = text.indexOf('"', p + 1);
          props.push(text.slice(p + 1, e < 0 ? n : e));
          p = e < 0 ? n : e + 1;
        } else if (c === '*') {
          p++;
          while (/\d/.test(text[p])) p++;
        } else {
          const t = /^[^\s,{}]+/.exec(text.slice(p, p + 64));
          if (!t) {
            p++;
            continue;
          }
          const num = Number(t[0]);
          props.push(Number.isNaN(num) ? t[0] : num);
          p += t[0].length;
        }
      }
      const node = { name, props, children };
      const arr = children.find((x) => x.name === 'a');
      if (arr) node.props = [Float64Array.from(arr.props.map(Number))];
      out.push(node);
    }
    return out;
  };
  return { name: '', props: [], children: parseNodes(true) };
}

const fchild = (node, name) => node?.children.find((c) => c.name === name);
const props70 = (node) => {
  const out = {};
  for (const p of fchild(node, 'Properties70')?.children || []) if (p.name === 'P') out[p.props[0]] = p.props.slice(4);
  return out;
};
const rotMatrix = (rx, ry, rz) => {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const mx = [1, 0, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, 0, Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
  const my = [Math.cos(b), 0, Math.sin(b), 0, 0, 1, 0, 0, -Math.sin(b), 0, Math.cos(b), 0, 0, 0, 0, 1];
  const mz = [Math.cos(c), -Math.sin(c), 0, 0, Math.sin(c), Math.cos(c), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return mmul(mz, mmul(my, mx)); // XYZ order: X is applied first
};

export function parseFBX(bytes) {
  const binary = String.fromCharCode(...bytes.subarray(0, 20)) === FBX_MAGIC;
  const root = binary ? fbxBinary(bytes) : fbxAscii(dec(bytes));
  const objects = fchild(root, 'Objects');
  if (!objects) throw new Error('No objects found in this FBX');
  const model = newModel('FBX');
  const byId = new Map();
  for (const o of objects.children) byId.set(String(o.props[0]), o);
  const kids = new Map(); // parent id -> [{ child, prop }]
  const parents = new Map();
  for (const c of fchild(root, 'Connections')?.children || []) {
    if (c.name !== 'C') continue;
    const [, child, parent, prop] = c.props;
    const list = kids.get(String(parent)) || [];
    list.push({ child: String(child), prop });
    kids.set(String(parent), list);
    parents.set(String(child), String(parent));
  }
  const world = new Map();
  const worldOf = (id, depth = 0) => {
    if (world.has(id)) return world.get(id);
    const o = byId.get(id);
    let m = IDENT;
    if (o && o.name === 'Model' && depth < 64) {
      const p = props70(o);
      const t = p['Lcl Translation'] || [0, 0, 0];
      const r = p['Lcl Rotation'] || [0, 0, 0];
      const s = p['Lcl Scaling'] || [1, 1, 1];
      const R = rotMatrix(r[0], r[1], r[2]);
      const T = [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1];
      const S = [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
      const local = mmul(T, mmul(R, S));
      const par = parents.get(id);
      m = par && byId.get(par)?.name === 'Model' ? mmul(worldOf(par, depth + 1), local) : local;
    }
    world.set(id, m);
    return m;
  };
  const textureName = (tex) => {
    const f = fchild(tex, 'RelativeFilename')?.props[0] || fchild(tex, 'FileName')?.props[0];
    return f ? baseName(f) : null;
  };
  const materialInfo = (mat) => {
    const id = String(mat.props[0]);
    const p = props70(mat);
    const c = p.DiffuseColor || p.Diffuse;
    let map = null;
    for (const k of kids.get(id) || []) {
      void k;
    }
    // Textures are children of the material: child -> parent connections.
    for (const [child, parent] of parents) {
      if (parent !== id) continue;
      const t = byId.get(child);
      if (t?.name === 'Texture') {
        const link = (kids.get(id) || []).find((x) => x.child === child);
        if (!map || /diffuse|base/i.test(link?.prop || '')) map = textureName(t);
        for (const v of kids.get(child) || []) {
          const vid = byId.get(v.child);
          const content = fchild(vid, 'Content')?.props[0];
          if (vid?.name === 'Video' && content?.length > 16 && map) model.images[map] = { bytes: content, name: map };
        }
      }
    }
    return { name: String(mat.props[1] || '').split('\u0000')[0], color: c ? [c[0], c[1], c[2], 1] : undefined, map };
  };

  for (const geo of objects.children) {
    if (geo.name !== 'Geometry' || geo.props[2] !== 'Mesh') continue;
    const verts = fchild(geo, 'Vertices')?.props[0];
    const pvi = fchild(geo, 'PolygonVertexIndex')?.props[0];
    if (!verts || !pvi) continue;
    const gid = String(geo.props[0]);
    const modelId = parents.get(gid);
    const W = modelId ? worldOf(modelId) : IDENT;
    const mats = (kids.get(modelId) || []).map((k) => byId.get(k.child)).filter((o) => o?.name === 'Material');
    const layer = (name) => {
      const l = fchild(geo, name);
      if (!l) return null;
      const key = name.replace('LayerElement', '');
      const data = fchild(l, key === 'UV' ? 'UV' : key === 'Normal' ? 'Normals' : 'Materials')?.props[0];
      const index = fchild(l, key === 'UV' ? 'UVIndex' : key === 'Normal' ? 'NormalsIndex' : 'Materials')?.props[0];
      return { data, index: key === 'Material' ? null : index, map: fchild(l, 'MappingInformationType')?.props[0], ref: fchild(l, 'ReferenceInformationType')?.props[0] };
    };
    const uvL = layer('LayerElementUV');
    const nL = layer('LayerElementNormal');
    const mL = layer('LayerElementMaterial');
    const groups = new Map();
    const getG = (mi) => {
      let g = groups.get(mi);
      if (!g) groups.set(mi, (g = { pos: [], nrm: [], uv: [], idx: [] }));
      return g;
    };
    let poly = [];
    let polyIndex = 0;
    let pv = 0;
    const pick = (L, vertex, corner, polyI, size) => {
      if (!L?.data) return null;
      let i = L.map === 'ByPolygonVertex' ? corner : L.map === 'ByPolygon' ? polyI : L.map === 'AllSame' ? 0 : vertex;
      if (L.index && L.ref !== 'Direct') i = L.index[i];
      if (i === undefined || i < 0) return null;
      const out = [];
      for (let k = 0; k < size; k++) out.push(L.data[i * size + k]);
      return out.some((x) => x === undefined) ? null : out;
    };
    for (let i = 0; i < pvi.length; i++) {
      const raw = pvi[i];
      const end = raw < 0;
      poly.push({ v: end ? ~raw : raw, c: pv++ });
      if (!end) continue;
      const mi = mL?.data ? (mL.map === 'AllSame' ? mL.data[0] : mL.data[polyIndex]) || 0 : 0;
      const g = getG(mi);
      const base = g.pos.length / 3;
      for (const { v, c } of poly) {
        g.pos.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]);
        const nn = pick(nL, v, c, polyIndex, 3);
        g.nrm.push(...(nn || [0, 0, 0]));
        const uu = pick(uvL, v, c, polyIndex, 2);
        g.uv.push(...(uu || [0, 0]));
      }
      for (let k = 1; k + 1 < poly.length; k++) g.idx.push(base, base + k, base + k + 1);
      poly = [];
      polyIndex++;
    }
    for (const [mi, g] of groups) {
      if (!g.idx.length) continue;
      const mat = mats[mi] ? materialInfo(mats[mi]) : {};
      const hasN = g.nrm.some((x) => x !== 0);
      const mesh = makeMesh(String(geo.props[1] || 'mesh').split('\u0000')[0], g.pos, hasN ? g.nrm : null, uvL?.data ? g.uv : null, g.idx, mat);
      transformMesh(mesh, W);
      model.meshes.push(mesh);
      if (mat.map && !model.wants.includes(mat.map)) model.wants.push(mat.map);
    }
  }
  if (!model.meshes.length) throw new Error('No polygon meshes found in this FBX');
  model.notes.push((binary ? 'Binary' : 'ASCII') + ' FBX: node transforms applied, pivots and animation ignored');
  return model;
}

/* ------------------------------------------------------------------ 3MF */

export function parse3MF(bytes) {
  const zip = readZip(bytes);
  const name = [...zip.keys()].find((k) => /\.model$/i.test(k) && /3d\//i.test(k)) || [...zip.keys()].find((k) => /\.model$/i.test(k));
  if (!name) throw new Error('No 3D model found in this 3MF');
  const doc = xmlFind(parseXML(dec(zip.get(name)())), 'model');
  if (!doc) throw new Error('Unreadable 3MF model');
  const res = xmlFind(doc, 'resources');
  const objs = new Map();
  for (const o of xmlAll(res || { children: [] }, 'object')) objs.set(o.attrs.id, o);
  const mat = (t) => {
    if (!t) return IDENT;
    const v = t.trim().split(/\s+/).map(Number);
    if (v.length !== 12) return IDENT;
    return [v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1];
  };
  const model = newModel('3MF');
  const emit = (id, m, depth) => {
    const o = objs.get(id);
    if (!o || depth > 16) return;
    const mesh = xmlFind(o, 'mesh');
    if (mesh) {
      const vs = xmlDeep(xmlFind(mesh, 'vertices') || { children: [] }, 'vertex');
      const ts = xmlDeep(xmlFind(mesh, 'triangles') || { children: [] }, 'triangle');
      const pos = [];
      for (const v of vs) pos.push(+v.attrs.x, +v.attrs.y, +v.attrs.z);
      const idx = [];
      for (const t of ts) idx.push(+t.attrs.v1, +t.attrs.v2, +t.attrs.v3);
      const me = makeMesh(o.attrs.name || 'object ' + id, pos, null, null, idx);
      transformMesh(me, mmul(Z_UP_TO_Y_UP, m));
      model.meshes.push(me);
    }
    for (const c of xmlDeep(xmlFind(o, 'components') || { children: [] }, 'component')) emit(c.attrs.objectid, mmul(m, mat(c.attrs.transform)), depth + 1);
  };
  const items = xmlDeep(xmlFind(doc, 'build') || { children: [] }, 'item');
  if (items.length) for (const it of items) emit(it.attrs.objectid, mat(it.attrs.transform), 0);
  else for (const id of objs.keys()) emit(id, IDENT, 0);
  if (!model.meshes.length) throw new Error('No meshes found in this 3MF');
  model.notes.push('3MF colours and textures are not shown');
  return model;
}
