// "Info only" previews: what a file is, without rendering it. Pure functions, no DOM.

import { inflateGzip } from './inflate.js';
import { rscHeader } from './rage.js';

const KIND = {
  ybn: 'GTA V static collision (bounds)',
  ymap: 'GTA V map placement',
  ytyp: 'GTA V archetype definitions',
  ycd: 'GTA V clip dictionary (animations)',
  ypt: 'GTA V particle effects',
  yld: 'GTA V cloth dictionary',
  ymt: 'GTA V metadata',
  ynd: 'GTA V path nodes',
  ynv: 'GTA V navmesh',
  yed: 'GTA V expression dictionary',
  yvr: 'GTA V vehicle record',
  ywr: 'GTA V waypoint record',
  yfd: 'GTA V frame filter dictionary',
  awc: 'GTA V audio wave container',
  ysc: 'GTA V script',
  blend: 'Blender scene',
  fbx: 'Autodesk FBX',
  uasset: 'Unreal Engine asset',
  umap: 'Unreal Engine map',
  upk: 'Unreal package',
  pak: 'Archive (Quake PAK or Unreal pak)',
  vpk: 'Valve package',
  bsp: 'Source/Quake map',
  mdl: 'Source model',
  vvd: 'Source vertex data',
  vtx: 'Source mesh strips',
  nif: 'Gamebryo model',
  hkx: 'Havok data',
  gr2: 'Granny 3D model',
  max: '3ds Max scene',
  skp: 'SketchUp model',
  ma: 'Maya ASCII scene',
  mb: 'Maya binary scene',
  c4d: 'Cinema 4D scene',
  lwo: 'LightWave object',
  lws: 'LightWave scene',
  ase: '3ds Max ASCII export',
  psk: 'Unreal skeletal mesh',
  psa: 'Unreal animation',
  '3ds': '3D Studio mesh',
  usd: 'OpenUSD scene',
  usda: 'OpenUSD scene (text)',
  usdc: 'OpenUSD scene (binary)',
  usdz: 'OpenUSD package',
  abc: 'Alembic cache',
  x3d: 'X3D scene',
  wrl: 'VRML scene',
  gft: 'Fragment template',
  dmx: 'Source DMX model',
  qc: 'Source model script',
  mesh: 'Mesh data',
  sbsar: 'Substance material',
  sbs: 'Substance graph',
  spp: 'Substance Painter project',
  zpr: 'ZBrush project',
  ztl: 'ZBrush tool',
  xcf: 'GIMP image',
  psb: 'Photoshop large document',
  basis: 'Basis Universal texture',
  pvr: 'PowerVR texture',
  astc: 'ASTC texture',
  crn: 'Crunch texture',
  vmt: 'Source material script',
  vtex: 'Source texture',
  tex: 'Texture data',
  mat: 'Material data',
  material: 'Material data',
  shader: 'Shader source',
  unity: 'Unity scene',
  prefab: 'Unity prefab',
  asset: 'Unity asset',
  qb: 'Qubicle voxels',
  qbt: 'Qubicle voxels',
  vxl: 'Voxel model',
};

export const INFO_ONLY_EXTS = Object.keys(KIND).filter((e) => !['fbx', 'vmt', 'shader', 'mat', 'material', 'ma', 'ase', 'usda', 'wrl', 'x3d', 'qc'].includes(e));

const ascii = (b, from, len) => String.fromCharCode(...b.subarray(from, from + len)).replace(/\0.*$/s, '');
const printable = (s) => /^[\x20-\x7e]+$/.test(s);

/** .blend header and a list of datablock names. */
export function inspectBlend(bytes) {
  let data = bytes;
  let compressed = null;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      data = inflateGzip(bytes, 256 * 1024 * 1024);
      compressed = 'gzip';
    } catch {
      return { error: 'Compressed .blend could not be unpacked' };
    }
  } else if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    return { error: 'This .blend uses Zstandard compression (Blender 3.0+), which the previewer cannot unpack' };
  }
  if (ascii(data, 0, 7) !== 'BLENDER') return { error: 'Not a Blender file' };
  const big = data[7] === 0x2d; // '-' is 64-bit pointers, '_' 32-bit
  const le = data[8] === 0x76; // 'v' little endian
  const version = ascii(data, 9, 3);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ptr = big ? 8 : 4;
  const out = { version: `${version[0]}.${version.slice(1)}`, pointer: big ? '64-bit' : '32-bit', compressed, counts: {}, names: { OB: [], ME: [], MA: [], IM: [] } };
  let p = 12;
  let blocks = 0;
  while (p + 16 + ptr <= data.length && blocks < 2_000_000) {
    const code = ascii(data, p, 4);
    const size = dv.getUint32(p + 4, le);
    const dataStart = big ? p + 24 : p + 20;
    if (code === 'ENDB') break;
    const key = code.replace(/\0+$/, '');
    out.counts[key] = (out.counts[key] || 0) + 1;
    if (out.names[key] && out.names[key].length < 200) {
      // The datablock starts with an ID whose name (prefixed by the 2-letter code) follows 4 or 5 pointers.
      for (const n of [4, 5, 3]) {
        const s = ascii(data, dataStart + n * ptr, 66);
        if (s.startsWith(key) && s.length > 2 && printable(s)) {
          out.names[key].push(s.slice(2));
          break;
        }
      }
    }
    p = dataStart + size;
    blocks++;
  }
  return out;
}

function hexdump(bytes, n = 96) {
  const lines = [];
  for (let i = 0; i < Math.min(n, bytes.length); i += 16) {
    const row = bytes.subarray(i, i + 16);
    lines.push(`${i.toString(16).padStart(4, '0')}  ${[...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${[...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`);
  }
  return lines.join('\n');
}

/**
 * Describe any file: returns { title, rows: [[label, value]], notes: [], hex }.
 * Values are plain strings; the caller must escape them.
 */
export function describeFile(bytes, name, size = bytes.length) {
  const ext = (/\.([^./\\]+)$/.exec(name) || [])[1]?.toLowerCase() || '';
  const rows = [['File', name], ['Size', `${size.toLocaleString('en-US')} bytes`]];
  const notes = [];
  let title = KIND[ext] || 'Binary file';
  const dv = bytes.length >= 8 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;

  const rsc = rscHeader(bytes);
  if (rsc) {
    rows.push(['Container', rsc.magic === 'RSC7' ? 'GTA V resource (RSC7)' : 'GTA V Enhanced resource (RSC8)'], ['Resource version', String(rsc.version)], ['System data', `${rsc.sysSize.toLocaleString('en-US')} bytes`], ['Graphics data', `${rsc.gfxSize.toLocaleString('en-US')} bytes`]);
    notes.push('Only the header is read for this type. Open it in CodeWalker or OpenIV for the full contents.');
  } else if (ext === 'blend') {
    const b = inspectBlend(bytes);
    if (b.error) notes.push(b.error);
    else {
      rows.push(['Blender version', b.version], ['Pointer size', b.pointer]);
      if (b.compressed) rows.push(['Compression', b.compressed]);
      rows.push(['Objects', String(b.counts.OB || 0)], ['Meshes', String(b.counts.ME || 0)], ['Materials', String(b.counts.MA || 0)], ['Images', String(b.counts.IM || 0)]);
      if (b.names.OB.length) rows.push(['Object names', b.names.OB.slice(0, 40).join(', ')]);
      if (b.names.ME.length) rows.push(['Mesh names', b.names.ME.slice(0, 40).join(', ')]);
      notes.push('A .blend scene cannot be drawn in the browser. Open it in Blender, or export to glTF/OBJ to preview it here.');
    }
  } else if (bytes.length >= 8 && ascii(bytes, 0, 4) === 'IDST') {
    rows.push(['Source model version', String(dv.getInt32(4, true))], ['Internal name', ascii(bytes, 12, 64)]);
    notes.push('Source .mdl files need their .vvd and .vtx companions and the game to render.');
  } else if (bytes.length >= 8 && ascii(bytes, 0, 4) === 'VBSP') {
    rows.push(['BSP version', String(dv.getInt32(4, true))]);
    notes.push('A compiled Source map cannot be drawn in the browser.');
  } else if (dv && dv.getUint32(0, true) === 0x55aa1234) {
    rows.push(['VPK version', String(dv.getUint32(4, true))]);
    notes.push('Open with a VPK tool to list or extract its files.');
  } else if (dv && dv.getUint32(0, true) === 0x9e2a83c1) {
    rows.push(['Unreal package', 'magic 0x9E2A83C1']);
    notes.push('Unreal assets need the engine or a tool such as FModel/UEViewer.');
  } else if (ascii(bytes, 0, 4) === 'PACK') {
    rows.push(['Quake PAK entries', String(dv.getInt32(8, true) / 64)]);
  } else if (ascii(bytes, 0, 20).startsWith('Gamebryo File Format')) {
    rows.push(['Header', ascii(bytes, 0, 60).split('\n')[0]]);
  } else if (ext === 'fbx' || ext === 'skp' || ext === 'max' || ext === 'c4d') {
    notes.push(`${title} files need the original application for a full view.`);
  } else if (!KIND[ext]) {
    notes.push('The panel has no viewer for this file type.');
  } else {
    notes.push('The panel shows details only for this file type.');
  }
  if (!rows.some((r) => r[0] === 'Type')) rows.splice(1, 0, ['Type', title]);
  return { title, rows, notes, hex: hexdump(bytes) };
}
