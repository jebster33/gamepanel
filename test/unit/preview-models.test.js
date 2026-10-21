'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

const load = (f) => import(pathToFileURL(path.join(__dirname, '../../public/js/preview', f)).href);
const u8 = (b) => new Uint8Array(b);

test('OBJ with UVs, a quad, and an MTL texture reference', async () => {
  const { parseOBJ, parseMTL, applyMTL } = await load('model-text.js');
  const obj = `mtllib m.mtl
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
usemtl wood
f 1/1/1 2/2/1 3/3/1 4/4/1
`;
  const model = parseOBJ(obj);
  assert.strictEqual(model.meshes.length, 1);
  const m = model.meshes[0];
  assert.strictEqual(m.indices.length, 6, 'quad is two triangles');
  assert.ok(m.uvs, 'has UVs');
  assert.deepStrictEqual([...m.uvs.slice(0, 4)], [0, 0, 1, 0]);
  assert.deepStrictEqual(model.wants, ['m.mtl']);
  applyMTL(model, parseMTL('newmtl wood\nKd 0.5 0.25 0.1\nmap_Kd -s 1 1 1 tex/wood.png\n'));
  assert.strictEqual(m.material.map, 'tex/wood.png');
  assert.deepStrictEqual(m.material.color.slice(0, 3), [0.5, 0.25, 0.1]);
  assert.throws(() => parseOBJ('v 1 2 3\n'));
});

test('STL binary and ASCII', async () => {
  const { parseSTL } = await load('model-text.js');
  const bin = Buffer.alloc(84 + 50);
  bin.writeUInt32LE(1, 80);
  bin.writeFloatLE(1, 84 + 8);
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((v, i) => v.forEach((x, k) => bin.writeFloatLE(x, 84 + 12 + i * 12 + k * 4)));
  const a = parseSTL(u8(bin));
  assert.strictEqual(a.meshes[0].indices.length, 3);
  assert.strictEqual(a.meshes[0].positions[3], 1);
  const ascii = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid';
  assert.strictEqual(parseSTL(u8(Buffer.from(ascii))).meshes[0].positions.length, 9);
});

test('PLY ascii and binary', async () => {
  const { parsePLY } = await load('model-text.js');
  const head = (fmt) => `ply\nformat ${fmt} 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float s\nproperty float t\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n`;
  const asc = parsePLY(u8(Buffer.from(head('ascii') + '0 0 0 0 0\n1 0 0 1 0\n0 1 0 0 1\n3 0 1 2\n')));
  assert.strictEqual(asc.meshes[0].indices.length, 3);
  assert.ok(asc.meshes[0].uvs);
  const body = Buffer.alloc(3 * 20 + 13);
  [[0, 0, 0, 0, 0], [1, 0, 0, 1, 0], [0, 1, 0, 0, 1]].forEach((v, i) => v.forEach((x, k) => body.writeFloatLE(x, i * 20 + k * 4)));
  body[60] = 3;
  [0, 1, 2].forEach((x, i) => body.writeInt32LE(x, 61 + i * 4));
  const bin = parsePLY(u8(Buffer.concat([Buffer.from(head('binary_little_endian')), body])));
  assert.strictEqual(bin.meshes[0].positions[3], 1);
});

function makeGlb() {
  const bin = Buffer.alloc(36 + 24 + 8);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((x, i) => bin.writeFloatLE(x, i * 4));
  [0, 0, 1, 0, 0, 1].forEach((x, i) => bin.writeFloatLE(x, 36 + i * 4));
  [0, 1, 2].forEach((x, i) => bin.writeUInt16LE(x, 60 + i * 2));
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation: [10, 0, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
        { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: 6 }],
      buffers: [{ byteLength: 68 }],
    })
  );
  const pad = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20);
  const j = Buffer.concat([json, pad]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const ch = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return u8(Buffer.concat([head, ch(0x4e4f534a, j), ch(0x004e4942, bin)]));
}

test('minimal GLB: positions, UVs, indices and node transform', async () => {
  const { parseGLTF } = await load('model-binary.js');
  const model = await parseGLTF(makeGlb());
  const m = model.meshes[0];
  assert.strictEqual(m.indices.length, 3);
  assert.strictEqual(m.positions[3], 11, 'node translation applied');
  assert.ok(m.uvs);
  assert.strictEqual(m.uvTopDown, true);
  await assert.rejects(parseGLTF(u8(Buffer.from('{"nope":1}'))));
});

test('ASCII FBX triangle with UVs and a binary FBX', async () => {
  const { parseFBX } = await load('model-binary.js');
  const ascii = `; FBX 7.4.0 project file
Objects:  {
  Geometry: 100, "Geometry::tri", "Mesh" {
    Vertices: *9 {
      a: 0,0,0,1,0,0,0,1,0
    }
    PolygonVertexIndex: *3 {
      a: 0,1,-3
    }
    LayerElementUV: 0 {
      MappingInformationType: "ByPolygonVertex"
      ReferenceInformationType: "IndexToDirect"
      UV: *6 {
        a: 0,0,1,0,0,1
      }
      UVIndex: *3 {
        a: 0,1,2
      }
    }
  }
  Model: 200, "Model::tri", "Mesh" {
    Properties70:  {
      P: "Lcl Translation", "Lcl Translation", "", "A",5,0,0
    }
  }
}
Connections:  {
  C: "OO",100,200
  C: "OO",200,0
}
`;
  const model = parseFBX(u8(Buffer.from(ascii)));
  const m = model.meshes[0];
  assert.strictEqual(m.positions[3], 6, 'model translation applied');
  assert.deepStrictEqual([...m.uvs], [0, 0, 1, 0, 0, 1]);

  // Binary writer for one node tree (version 7400), enough to prove the reader and zlib arrays.
  const prop = (v) => {
    if (typeof v === 'string') {
      const b = Buffer.alloc(5 + v.length);
      b.write('S', 0);
      b.writeUInt32LE(v.length, 1);
      b.write(v, 5);
      return b;
    }
    if (typeof v === 'number') {
      const b = Buffer.alloc(9);
      b.write('L', 0);
      b.writeBigInt64LE(BigInt(v), 1);
      return b;
    }
    const raw = Buffer.alloc(v.data.length * (v.type === 'd' ? 8 : 4));
    v.data.forEach((x, i) => (v.type === 'd' ? raw.writeDoubleLE(x, i * 8) : raw.writeInt32LE(x, i * 4)));
    const comp = zlib.deflateSync(raw);
    const b = Buffer.alloc(13);
    b.write(v.type, 0);
    b.writeUInt32LE(v.data.length, 1);
    b.writeUInt32LE(1, 5);
    b.writeUInt32LE(comp.length, 9);
    return Buffer.concat([b, comp]);
  };
  const node = (name, props, children, base) => {
    const pb = Buffer.concat(props.map(prop));
    const nameB = Buffer.from(name);
    let kids = Buffer.alloc(0);
    let at = base + 13 + nameB.length + pb.length;
    for (const c of children) {
      const cb = node(c[0], c[1], c[2] || [], at);
      kids = Buffer.concat([kids, cb]);
      at += cb.length;
    }
    const tail = children.length ? Buffer.alloc(13) : Buffer.alloc(0);
    const end = base + 13 + nameB.length + pb.length + kids.length + tail.length;
    const h = Buffer.alloc(13);
    h.writeUInt32LE(end, 0);
    h.writeUInt32LE(props.length, 4);
    h.writeUInt32LE(pb.length, 8);
    h[12] = nameB.length;
    return Buffer.concat([h, nameB, pb, kids, tail]);
  };
  const head = Buffer.alloc(27);
  head.write('Kaydara FBX Binary  \0\x1a\0', 0, 'latin1');
  head.writeUInt32LE(7400, 23);
  let at = 27;
  const parts = [];
  const add = (n) => {
    parts.push(n);
    at += n.length;
  };
  add(node('Objects', [], [['Geometry', [100, 'Geometry::tri', 'Mesh'], [['Vertices', [{ type: 'd', data: [0, 0, 0, 1, 0, 0, 0, 1, 0] }]], ['PolygonVertexIndex', [{ type: 'i', data: [0, 1, -3] }]]]]], at));
  add(Buffer.alloc(13));
  const bin = parseFBX(u8(Buffer.concat([head, ...parts])));
  assert.strictEqual(bin.meshes[0].indices.length, 3);
  assert.strictEqual(bin.meshes[0].positions[3], 1);
});

test('Collada triangles with a texture and Z-up', async () => {
  const { parseDAE } = await load('model-text.js');
  const dae = `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema">
 <asset><up_axis>Z_UP</up_axis></asset>
 <library_images><image id="img"><init_from>textures/wood.png</init_from></image></library_images>
 <library_effects><effect id="eff"><profile_COMMON><technique><phong><diffuse><texture texture="img" texcoord="UV"/></diffuse></phong></technique></profile_COMMON></effect></library_effects>
 <library_materials><material id="mat"><instance_effect url="#eff"/></material></library_materials>
 <library_geometries><geometry id="g"><mesh>
  <source id="pos"><float_array id="pa" count="9">0 0 0 1 0 0 0 0 1</float_array><technique_common><accessor source="#pa" count="3" stride="3"/></technique_common></source>
  <source id="uv"><float_array id="ua" count="6">0 0 1 0 0 1</float_array><technique_common><accessor source="#ua" count="3" stride="2"/></technique_common></source>
  <vertices id="v"><input semantic="POSITION" source="#pos"/></vertices>
  <triangles material="m" count="1"><input semantic="VERTEX" source="#v" offset="0"/><input semantic="TEXCOORD" source="#uv" offset="1" set="0"/><p>0 0 1 1 2 2</p></triangles>
 </mesh></geometry></library_geometries>
 <library_visual_scenes><visual_scene id="s"><node><instance_geometry url="#g"><bind_material><technique_common><instance_material symbol="m" target="#mat"/></technique_common></bind_material></instance_geometry></node></visual_scene></library_visual_scenes>
</COLLADA>`;
  const model = parseDAE(dae);
  const m = model.meshes[0];
  assert.strictEqual(m.material.map, 'wood.png');
  assert.deepStrictEqual(model.wants, ['wood.png']);
  assert.ok(m.uvs);
  assert.ok(m.positions[8] === 0, 'Z-up converted: z=1 became y=1, y=0 became z=0');
  assert.strictEqual(m.positions[7], 1);
});

test('SMD, 3MF (zip) and VOX', async () => {
  const { parseSMD, parseVOX } = await load('model-text.js');
  const { parse3MF } = await load('model-binary.js');
  const smd = 'version 1\nnodes\n0 "root" -1\nend\nskeleton\ntime 0\n0 0 0 0 0 0 0\nend\ntriangles\nwall.bmp\n0 0 0 0 0 0 1 0 0\n0 1 0 0 0 0 1 1 0\n0 0 0 1 0 0 1 0 1\nend\n';
  const s = parseSMD(smd);
  assert.deepStrictEqual(s.wants, ['wall.bmp']);
  assert.strictEqual(s.meshes[0].indices.length, 3);

  const xml = '<?xml version="1.0"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
  const data = Buffer.from(xml);
  const comp = zlib.deflateRawSync(data);
  const name = Buffer.from('3D/3dmodel.model');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOff = 30 + name.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(cdOff, 16);
  const zip = u8(Buffer.concat([local, name, comp, central, name, eocd]));
  const t = parse3MF(zip);
  assert.strictEqual(t.meshes[0].indices.length, 3);

  const chunk = (id, content, kids = Buffer.alloc(0)) => {
    const h = Buffer.alloc(12);
    h.write(id, 0);
    h.writeUInt32LE(content.length, 4);
    h.writeUInt32LE(kids.length, 8);
    return Buffer.concat([h, content, kids]);
  };
  const size = Buffer.alloc(12);
  size.writeUInt32LE(2, 0);
  size.writeUInt32LE(1, 4);
  size.writeUInt32LE(1, 8);
  const xyzi = Buffer.alloc(4 + 8);
  xyzi.writeUInt32LE(2, 0);
  xyzi.set([0, 0, 0, 1, 1, 0, 0, 1], 4);
  const head = Buffer.alloc(8);
  head.write('VOX ', 0);
  head.writeUInt32LE(150, 4);
  const vox = parseVOX(u8(Buffer.concat([head, chunk('MAIN', Buffer.alloc(0), Buffer.concat([chunk('SIZE', size), chunk('XYZI', xyzi)]))])));
  assert.strictEqual(vox.meshes[0].indices.length / 3, 20, 'two touching voxels share one hidden face pair: 10 quads');
});
