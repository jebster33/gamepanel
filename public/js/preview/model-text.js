// Mesh parsers for text-ish and simple binary model formats: OBJ(+MTL), STL, PLY, SMD, Collada (DAE), MagicaVoxel.
// Every parser returns a "model":
//   { format, meshes: [{ name, positions, normals|null, uvs|null, colors|null, indices, material: { name, color, map } }],
//     images: { key: { bytes, name } }, wants: [file names to look for beside the model], notes: [] }
// No DOM access, so these run under node for tests.

export const MAX_TRIANGLES = 3_000_000;

export function newModel(format) {
  return { format, meshes: [], images: {}, wants: [], notes: [] };
}

/** Builds a mesh from flat arrays; computes smooth normals when missing. */
export function makeMesh(name, positions, normals, uvs, indices, material = {}, colors = null) {
  const pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const idx = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  if (idx.length / 3 > MAX_TRIANGLES) throw new Error('Model has too many triangles to preview');
  let nrm = normals && normals.length === pos.length ? (normals instanceof Float32Array ? normals : Float32Array.from(normals)) : null;
  if (!nrm) nrm = computeNormals(pos, idx);
  const uv = uvs && uvs.length === (pos.length / 3) * 2 ? (uvs instanceof Float32Array ? uvs : Float32Array.from(uvs)) : null;
  return {
    name: name || 'mesh',
    positions: pos,
    normals: nrm,
    uvs: uv,
    colors: colors ? Float32Array.from(colors) : null,
    indices: idx,
    material: { name: material.name || '', color: material.color || [0.78, 0.8, 0.82, 1], map: material.map || null },
  };
}

export function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      n[o] += nx;
      n[o + 1] += ny;
      n[o + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

/* --------------------------------------------------- 4x4 (row-major) */

export const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mmul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
}
export function trs(t, q, s) {
  const [x, y, z, w] = q;
  const [sx, sy, sz] = s;
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz, t[0],
    2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz, t[1],
    2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz, t[2],
    0, 0, 0, 1,
  ];
}
/** Applies m to positions (and rotates normals by the same matrix without translation; fine for uniform scales). */
export function transformMesh(mesh, m) {
  if (m === IDENT) return mesh;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    p[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    p[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    p[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
  const n = mesh.normals;
  if (n) {
    for (let i = 0; i < n.length; i += 3) {
      const x = n[i];
      const y = n[i + 1];
      const z = n[i + 2];
      const nx = m[0] * x + m[1] * y + m[2] * z;
      const ny = m[4] * x + m[5] * y + m[6] * z;
      const nz = m[8] * x + m[9] * y + m[10] * z;
      const l = Math.hypot(nx, ny, nz) || 1;
      n[i] = nx / l;
      n[i + 1] = ny / l;
      n[i + 2] = nz / l;
    }
  }
  return mesh;
}
/** Z-up (Blender, Source, GTA) to the viewer's Y-up. */
export const Z_UP_TO_Y_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/* ------------------------------------------------------------------ OBJ */

const dec = (b) => new TextDecoder('utf-8').decode(b);

export function parseOBJ(input) {
  const text = typeof input === 'string' ? input : dec(input);
  const model = newModel('OBJ');
  const V = [];
  const VT = [];
  const VN = [];
  const groups = new Map();
  let curMat = '';
  let curName = 'object';
  const group = () => {
    const key = curMat + '\u0000' + curName;
    let g = groups.get(key);
    if (!g) {
      g = { name: curName, mat: curMat, map: new Map(), pos: [], nrm: [], uv: [], idx: [], hasN: false, hasT: false };
      groups.set(key, g);
    }
    return g;
  };
  const resolve = (i, arr, size) => {
    const n = parseInt(i, 10);
    return n < 0 ? arr.length / size + n : n - 1;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.split(/\s+/);
    const cmd = sp[0];
    if (cmd === 'v') V.push(+sp[1] || 0, +sp[2] || 0, +sp[3] || 0);
    else if (cmd === 'vt') VT.push(+sp[1] || 0, +sp[2] || 0);
    else if (cmd === 'vn') VN.push(+sp[1] || 0, +sp[2] || 0, +sp[3] || 0);
    else if (cmd === 'usemtl') curMat = sp.slice(1).join(' ');
    else if (cmd === 'o' || cmd === 'g') curName = sp.slice(1).join(' ') || 'object';
    else if (cmd === 'mtllib') model.wants.push(sp.slice(1).join(' '));
    else if (cmd === 'f' && sp.length >= 4) {
      const g = group();
      const ids = [];
      for (let k = 1; k < sp.length; k++) {
        const key = sp[k];
        let id = g.map.get(key);
        if (id === undefined) {
          const [a, b, c] = key.split('/');
          const vi = resolve(a, V, 3);
          if (!(vi >= 0 && vi * 3 + 2 < V.length)) continue;
          id = g.pos.length / 3;
          g.pos.push(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]);
          const ti = b ? resolve(b, VT, 2) : -1;
          const ni = c ? resolve(c, VN, 3) : -1;
          if (ti >= 0 && ti * 2 + 1 < VT.length) {
            g.uv.push(VT[ti * 2], VT[ti * 2 + 1]);
            g.hasT = true;
          } else g.uv.push(0, 0);
          if (ni >= 0 && ni * 3 + 2 < VN.length) {
            g.nrm.push(VN[ni * 3], VN[ni * 3 + 1], VN[ni * 3 + 2]);
            g.hasN = true;
          } else g.nrm.push(0, 0, 0);
          g.map.set(key, id);
        }
        ids.push(id);
      }
      for (let k = 1; k + 1 < ids.length; k++) g.idx.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  for (const g of groups.values()) {
    if (!g.idx.length) continue;
    const mesh = makeMesh(g.name, g.pos, g.hasN ? g.nrm : null, g.hasT ? g.uv : null, g.idx, { name: g.mat });
    model.meshes.push(mesh);
  }
  if (!model.meshes.length) throw new Error('No faces found in this OBJ');
  return model;
}

/** MTL text -> { name: { color, map } } */
export function parseMTL(input) {
  const text = typeof input === 'string' ? input : dec(input);
  const mats = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.split(/\s+/);
    const cmd = sp[0].toLowerCase();
    if (cmd === 'newmtl') {
      cur = { color: [0.78, 0.8, 0.82, 1], map: null };
      mats[sp.slice(1).join(' ')] = cur;
    } else if (!cur) continue;
    else if (cmd === 'kd' && sp.length >= 4) cur.color = [+sp[1], +sp[2], +sp[3], cur.color[3]];
    else if (cmd === 'd') cur.color[3] = +sp[1];
    else if (cmd === 'map_kd' || (cmd === 'map_ka' && !cur.map)) {
      // Options (-s, -o, -bm ...) come before the file name; the name can hold spaces.
      let i = 1;
      while (i < sp.length && sp[i].startsWith('-')) i += sp[i] === '-s' || sp[i] === '-o' || sp[i] === '-t' ? 4 : 2;
      cur.map = sp.slice(i).join(' ') || null;
    }
  }
  return mats;
}

/** Fill the materials of an OBJ model from parsed MTL data; pushes wanted texture names. */
export function applyMTL(model, mats) {
  for (const mesh of model.meshes) {
    const m = mats[mesh.material.name];
    if (!m) continue;
    mesh.material.color = m.color;
    if (m.map) {
      mesh.material.map = m.map;
      if (!model.wants.includes(m.map)) model.wants.push(m.map);
    }
  }
}

/* ------------------------------------------------------------------ STL */

export function parseSTL(bytes) {
  const model = newModel('STL');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isBinary = bytes.length >= 84 && 84 + dv.getUint32(80, true) * 50 === bytes.length;
  const pos = [];
  const nrm = [];
  if (isBinary) {
    const n = dv.getUint32(80, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50;
      const nx = dv.getFloat32(o, true);
      const ny = dv.getFloat32(o + 4, true);
      const nz = dv.getFloat32(o + 8, true);
      for (let k = 0; k < 3; k++) {
        pos.push(dv.getFloat32(o + 12 + k * 12, true), dv.getFloat32(o + 16 + k * 12, true), dv.getFloat32(o + 20 + k * 12, true));
        nrm.push(nx, ny, nz);
      }
    }
  } else {
    const text = dec(bytes);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let m;
    while ((m = re.exec(text))) pos.push(+m[1], +m[2], +m[3]);
  }
  if (!pos.length) throw new Error('No triangles found in this STL');
  const idx = Array.from({ length: pos.length / 3 }, (_, i) => i);
  const flat = isBinary && nrm.some((x) => x !== 0) ? nrm : null;
  model.meshes.push(makeMesh('stl', pos, flat, null, idx));
  model.notes.push(isBinary ? 'Binary STL' : 'ASCII STL');
  return model;
}

/* ------------------------------------------------------------------ PLY */

const PLY_TYPES = { char: [1, 'Int8'], int8: [1, 'Int8'], uchar: [1, 'Uint8'], uint8: [1, 'Uint8'], short: [2, 'Int16'], int16: [2, 'Int16'], ushort: [2, 'Uint16'], uint16: [2, 'Uint16'], int: [4, 'Int32'], int32: [4, 'Int32'], uint: [4, 'Uint32'], uint32: [4, 'Uint32'], float: [4, 'Float32'], float32: [4, 'Float32'], double: [8, 'Float64'], float64: [8, 'Float64'] };

export function parsePLY(bytes) {
  let end = 0;
  const marker = 'end_header';
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 65536)));
  const hi = head.indexOf(marker);
  if (!head.startsWith('ply') || hi < 0) throw new Error('Not a PLY file');
  end = hi + marker.length;
  while (bytes[end] === 13) end++;
  end++;
  const lines = head.slice(0, hi).split(/\r?\n/);
  let format = 'ascii';
  const elements = [];
  for (const l of lines) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: +t[2], props: [] });
    else if (t[0] === 'property' && elements.length) {
      if (t[1] === 'list') elements[elements.length - 1].props.push({ list: true, countType: t[2], type: t[3], name: t[4] });
      else elements[elements.length - 1].props.push({ type: t[1], name: t[2] });
    }
  }
  const little = format !== 'binary_big_endian';
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = end;
  let tokens = null;
  let tp = 0;
  if (format === 'ascii') tokens = dec(bytes.subarray(end)).split(/\s+/).filter(Boolean);
  const read = (type) => {
    if (tokens) return +tokens[tp++];
    const [size, name] = PLY_TYPES[type] || [4, 'Float32'];
    if (p + size > bytes.length) throw new Error('PLY data is truncated');
    const v = dv[`get${name}`](p, little);
    p += size;
    return v;
  };
  const pos = [];
  const nrm = [];
  const uv = [];
  const col = [];
  const idx = [];
  for (const el of elements) {
    for (let i = 0; i < el.count; i++) {
      const row = {};
      for (const pr of el.props) {
        if (pr.list) {
          const n = read(pr.countType);
          const arr = [];
          for (let k = 0; k < n; k++) arr.push(read(pr.type));
          row[pr.name] = arr;
        } else row[pr.name] = read(pr.type);
      }
      if (el.name === 'vertex') {
        pos.push(row.x, row.y, row.z);
        if (row.nx !== undefined) nrm.push(row.nx, row.ny, row.nz);
        const u = row.u ?? row.s ?? row.texture_u;
        const v = row.v ?? row.t ?? row.texture_v;
        if (u !== undefined && v !== undefined) uv.push(u, v);
        if (row.red !== undefined) {
          const sc = PLY_TYPES[el.props.find((q) => q.name === 'red').type][0] === 1 ? 255 : 1;
          col.push(row.red / sc, row.green / sc, row.blue / sc);
        }
      } else if (el.name === 'face') {
        const f = row.vertex_indices || row.vertex_index;
        if (f) for (let k = 1; k + 1 < f.length; k++) idx.push(f[0], f[k], f[k + 1]);
      }
    }
  }
  const model = newModel('PLY');
  if (!idx.length) {
    // A point cloud: nothing to draw as triangles.
    throw new Error(`This PLY has ${pos.length / 3} points and no faces`);
  }
  model.meshes.push(makeMesh('ply', pos, nrm.length === pos.length ? nrm : null, uv.length === (pos.length / 3) * 2 ? uv : null, idx, {}, col.length === pos.length ? col : null));
  return model;
}

/* ------------------------------------------------------------------ SMD */

export function parseSMD(input) {
  const text = typeof input === 'string' ? input : dec(input);
  const model = newModel('SMD');
  const lines = text.split(/\r?\n/);
  const groups = new Map();
  let i = lines.findIndex((l) => l.trim() === 'triangles');
  if (i < 0) throw new Error('This SMD has no triangles (it may be an animation)');
  for (i++; i < lines.length; i++) {
    const mat = lines[i].trim();
    if (mat === 'end') break;
    if (!mat) continue;
    let g = groups.get(mat);
    if (!g) groups.set(mat, (g = { pos: [], nrm: [], uv: [] }));
    for (let k = 1; k <= 3; k++) {
      const t = (lines[i + k] || '').trim().split(/\s+/).map(Number);
      g.pos.push(t[1], t[2], t[3]);
      g.nrm.push(t[4], t[5], t[6]);
      g.uv.push(t[7], t[8]);
    }
    i += 3;
  }
  for (const [mat, g] of groups) {
    const idx = Array.from({ length: g.pos.length / 3 }, (_, k) => k);
    const mesh = makeMesh(mat, g.pos, g.nrm, g.uv, idx, { name: mat, map: mat });
    transformMesh(mesh, Z_UP_TO_Y_UP);
    model.meshes.push(mesh);
    model.wants.push(mat);
  }
  if (!model.meshes.length) throw new Error('No triangles found in this SMD');
  return model;
}

/* ------------------------------------------------------------- MagicaVoxel */

export function parseVOX(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'VOX ') throw new Error('Not a MagicaVoxel file');
  let p = 20;
  const voxels = [];
  let palette = null;
  let size = [0, 0, 0];
  while (p + 12 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(p, p + 4));
    const n = dv.getUint32(p + 4, true);
    const child = dv.getUint32(p + 8, true);
    const d = p + 12;
    if (id === 'SIZE' && !voxels.length) size = [dv.getUint32(d, true), dv.getUint32(d + 4, true), dv.getUint32(d + 8, true)];
    else if (id === 'XYZI' && !voxels.length) {
      const c = dv.getUint32(d, true);
      for (let i = 0; i < c && d + 4 + i * 4 + 3 < bytes.length; i++) voxels.push([bytes[d + 4 + i * 4], bytes[d + 5 + i * 4], bytes[d + 6 + i * 4], bytes[d + 7 + i * 4]]);
    } else if (id === 'RGBA') palette = bytes.subarray(d, d + 1024);
    p = d + (id === 'MAIN' ? 0 : n + child);
    if (id === 'MAIN') continue;
  }
  if (!voxels.length) throw new Error('No voxels found');
  const key = (x, y, z) => x + y * 256 + z * 65536;
  const set = new Set(voxels.map((v) => key(v[0], v[1], v[2])));
  const pos = [];
  const col = [];
  const nrm = [];
  const idx = [];
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const [x, y, z, ci] of voxels) {
    const c = palette ? [palette[(ci - 1) * 4] / 255, palette[(ci - 1) * 4 + 1] / 255, palette[(ci - 1) * 4 + 2] / 255] : [0.5 + ((ci * 37) % 100) / 200, 0.5 + ((ci * 53) % 100) / 200, 0.5 + ((ci * 71) % 100) / 200];
    for (const [dx, dy, dz] of dirs) {
      if (set.has(key(x + dx, y + dy, z + dz))) continue;
      // Quad corners on the face plane.
      const ax = dx ? [0, 1, 0] : [1, 0, 0];
      const bx = dz ? [0, 1, 0] : [0, 0, 1];
      const base = [x + (dx > 0 ? 1 : 0) * Math.abs(dx), y + (dy > 0 ? 1 : 0) * Math.abs(dy), z + (dz > 0 ? 1 : 0) * Math.abs(dz)];
      const at = pos.length / 3;
      for (const [s, t] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        pos.push(base[0] + ax[0] * s + bx[0] * t, base[1] + ax[1] * s + bx[1] * t, base[2] + ax[2] * s + bx[2] * t);
        col.push(...c);
        nrm.push(dx, dy, dz);
      }
      idx.push(at, at + 1, at + 2, at, at + 2, at + 3);
    }
  }
  const model = newModel('VOX');
  const mesh = makeMesh('voxels', pos, nrm, null, idx, {}, col);
  // Winding is not consistent; the viewer draws both sides and lights by the stored normals.
  transformMesh(mesh, Z_UP_TO_Y_UP);
  mesh.doubleSided = true;
  model.meshes.push(mesh);
  model.notes.push(`${voxels.length} voxels, ${size.join(' x ')}`);
  return model;
}

/* ------------------------------------------------------------ tiny XML */

/** Minimal XML reader: enough for Collada and 3MF. No DTD or entity expansion beyond the basics. */
export function parseXML(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  const unesc = (s) => s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e]);
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += unesc(m[6]);
    else if (m[3]) {
      if (m[2]) {
        if (stack.length > 1) stack.pop();
      } else {
        const attrs = {};
        for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unesc(a[2] ?? a[3]);
        const node = { name: m[3].replace(/^[\w.-]+:/, ''), attrs, children: [], text: '' };
        top.children.push(node);
        if (!m[5]) stack.push(node);
      }
    }
  }
  return root;
}
export const xmlFind = (node, name) => node.children.find((c) => c.name === name);
export const xmlAll = (node, name) => node.children.filter((c) => c.name === name);
export function xmlDeep(node, name, out = []) {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    xmlDeep(c, name, out);
  }
  return out;
}
const nums = (s) => (s.trim() ? s.trim().split(/\s+/).map(Number) : []);

/* ----------------------------------------------------------------- DAE */

export function parseDAE(input) {
  const text = typeof input === 'string' ? input : dec(input);
  const doc = xmlFind(parseXML(text), 'COLLADA');
  if (!doc) throw new Error('Not a Collada file');
  const model = newModel('Collada');
  const byId = new Map();
  for (const n of xmlDeep(doc, 'source')) byId.set(n.attrs.id, n);
  const sourceData = (id) => {
    const src = byId.get(id.replace(/^#/, ''));
    if (!src) return null;
    const fa = xmlFind(src, 'float_array');
    const acc = xmlFind(xmlFind(src, 'technique_common') || { children: [] }, 'accessor');
    return fa ? { data: nums(fa.text), stride: +(acc?.attrs.stride || 1) } : null;
  };
  const up = (xmlFind(xmlFind(doc, 'asset') || { children: [] }, 'up_axis')?.text || 'Y_UP').trim();
  const upM = up === 'Z_UP' ? Z_UP_TO_Y_UP : IDENT;
  const unit = +(xmlFind(xmlFind(doc, 'asset') || { children: [] }, 'unit')?.attrs.meter || 1);
  void unit;

  // images, effects, materials
  const images = {};
  for (const im of xmlDeep(doc, 'image')) images[im.attrs.id] = (xmlFind(im, 'init_from')?.text || '').trim();
  const effects = {};
  for (const ef of xmlDeep(doc, 'effect')) {
    const sid = {};
    for (const np of xmlDeep(ef, 'newparam')) sid[np.attrs.sid] = np;
    let color = null;
    let map = null;
    const diff = xmlDeep(ef, 'diffuse')[0];
    if (diff) {
      const c = xmlFind(diff, 'color');
      if (c) {
        const v = nums(c.text);
        color = [v[0], v[1], v[2], v[3] ?? 1];
      }
      const t = xmlFind(diff, 'texture');
      if (t) {
        let ref = t.attrs.texture;
        const sampler = sid[ref] && xmlFind(sid[ref], 'sampler2D');
        if (sampler) {
          ref = xmlFind(sampler, 'source')?.text.trim();
          const surf = sid[ref] && xmlFind(sid[ref], 'surface');
          if (surf) ref = xmlFind(surf, 'init_from')?.text.trim();
        }
        map = images[ref] ?? ref;
      }
    }
    effects[ef.attrs.id] = { color, map };
  }
  const materials = {};
  for (const mat of xmlDeep(doc, 'material')) {
    const eff = xmlFind(mat, 'instance_effect')?.attrs.url?.replace(/^#/, '');
    materials[mat.attrs.id] = effects[eff] || {};
  }
  const cleanMap = (m) => (m ? m.replace(/^file:\/+/, '').replace(/\\/g, '/').split('/').pop() : null);

  // geometries
  const geoms = {};
  for (const g of xmlDeep(doc, 'geometry')) {
    const mesh = xmlFind(g, 'mesh');
    if (!mesh) continue;
    const vertices = xmlFind(mesh, 'vertices');
    const vposId = xmlAll(vertices || { children: [] }, 'input').find((i) => i.attrs.semantic === 'POSITION')?.attrs.source;
    const prims = [];
    for (const prim of mesh.children.filter((c) => ['triangles', 'polylist', 'polygons'].includes(c.name))) {
      const inputs = xmlAll(prim, 'input').map((i) => ({ sem: i.attrs.semantic, src: i.attrs.source, off: +(i.attrs.offset || 0), set: +(i.attrs.set || 0) }));
      const stride = Math.max(...inputs.map((i) => i.off)) + 1;
      let counts = null;
      let p = [];
      if (prim.name === 'triangles') p = nums(xmlFind(prim, 'p')?.text || '');
      else if (prim.name === 'polylist') {
        counts = nums(xmlFind(prim, 'vcount')?.text || '');
        p = nums(xmlFind(prim, 'p')?.text || '');
      } else {
        counts = [];
        for (const pp of xmlAll(prim, 'p')) {
          const a = nums(pp.text);
          counts.push(a.length / stride);
          p.push(...a);
        }
      }
      const vin = inputs.find((i) => i.sem === 'VERTEX');
      const nin = inputs.find((i) => i.sem === 'NORMAL');
      const tin = inputs.filter((i) => i.sem === 'TEXCOORD').sort((a, b) => a.set - b.set)[0];
      const P = sourceData(vposId || vin?.src || '');
      if (!P) continue;
      const N = nin ? sourceData(nin.src) : null;
      const T = tin ? sourceData(tin.src) : null;
      const pos = [];
      const nrm = [];
      const uv = [];
      const idx = [];
      const dedupe = new Map();
      const vert = (corner) => {
        const base = corner * stride;
        const key = p.slice(base, base + stride).join(',');
        let id = dedupe.get(key);
        if (id === undefined) {
          id = pos.length / 3;
          dedupe.set(key, id);
          const vi = p[base + (vin?.off || 0)];
          pos.push(P.data[vi * P.stride], P.data[vi * P.stride + 1], P.data[vi * P.stride + 2]);
          if (N) {
            const ni = p[base + nin.off];
            nrm.push(N.data[ni * N.stride], N.data[ni * N.stride + 1], N.data[ni * N.stride + 2]);
          }
          if (T) {
            const ti = p[base + tin.off];
            uv.push(T.data[ti * T.stride], T.data[ti * T.stride + 1]);
          }
        }
        return id;
      };
      let corner = 0;
      const faceCounts = counts || Array.from({ length: p.length / stride / 3 }, () => 3);
      for (const c of faceCounts) {
        const ids = [];
        for (let k = 0; k < c; k++) ids.push(vert(corner++));
        for (let k = 1; k + 1 < ids.length; k++) idx.push(ids[0], ids[k], ids[k + 1]);
      }
      prims.push({ material: prim.attrs.material || '', pos, nrm: N ? nrm : null, uv: T ? uv : null, idx });
    }
    geoms[g.attrs.id] = { name: g.attrs.name || g.attrs.id, prims };
  }

  // visual scene: node transforms and material bindings
  const placed = [];
  const walk = (node, parent) => {
    let m = parent;
    for (const c of node.children) {
      if (c.name === 'matrix') m = mmul(m, nums(c.text));
      else if (c.name === 'translate') {
        const t = nums(c.text);
        m = mmul(m, [1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1]);
      } else if (c.name === 'scale') {
        const s = nums(c.text);
        m = mmul(m, [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1]);
      } else if (c.name === 'rotate') {
        const [x, y, z, deg] = nums(c.text);
        const l = Math.hypot(x, y, z) || 1;
        const s = Math.sin((deg * Math.PI) / 360);
        m = mmul(m, trs([0, 0, 0], [(x / l) * s, (y / l) * s, (z / l) * s, Math.cos((deg * Math.PI) / 360)], [1, 1, 1]));
      }
    }
    for (const c of node.children) {
      if (c.name === 'instance_geometry') {
        const binds = {};
        for (const im of xmlDeep(c, 'instance_material')) binds[im.attrs.symbol] = im.attrs.target?.replace(/^#/, '');
        placed.push({ id: c.attrs.url?.replace(/^#/, ''), m, binds });
      } else if (c.name === 'node') walk(c, m);
    }
  };
  const scene = xmlDeep(doc, 'visual_scene')[0];
  if (scene) for (const n of xmlAll(scene, 'node')) walk(n, upM);
  if (!placed.length) for (const id of Object.keys(geoms)) placed.push({ id, m: upM, binds: {} });
  for (const pl of placed) {
    const g = geoms[pl.id];
    if (!g) continue;
    for (const pr of g.prims) {
      const matId = pl.binds[pr.material] || pr.material;
      const mat = materials[matId] || {};
      const map = cleanMap(mat.map);
      const mesh = makeMesh(g.name, pr.pos, pr.nrm, pr.uv, pr.idx, { name: matId, color: mat.color || undefined, map });
      transformMesh(mesh, pl.m);
      model.meshes.push(mesh);
      if (map && !model.wants.includes(map)) model.wants.push(map);
    }
  }
  if (!model.meshes.length) throw new Error('No triangle meshes found in this Collada file');
  return model;
}

/** Parse any supported text/simple model by extension. */
export function parseSimpleModel(ext, bytes) {
  switch (ext) {
    case 'obj': return parseOBJ(bytes);
    case 'stl': return parseSTL(bytes);
    case 'ply': return parsePLY(bytes);
    case 'smd': return parseSMD(bytes);
    case 'dae': return parseDAE(bytes);
    case 'vox': return parseVOX(bytes);
    default: return null;
  }
}
