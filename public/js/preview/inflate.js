// Small synchronous DEFLATE decoder (RFC 1951) with zlib and gzip wrappers.
// Used for RAGE resources, FBX arrays, EXR/TIFF, 3MF zips and compressed .blend files.

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildTree(lengths) {
  const count = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { count, symbols };
}

let fixedLit;
let fixedDist;
function fixedTrees() {
  if (!fixedLit) {
    const l = new Uint8Array(288);
    for (let i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    fixedLit = buildTree(l);
    fixedDist = buildTree(new Uint8Array(30).fill(5));
  }
  return [fixedLit, fixedDist];
}

/** Raw DEFLATE. `sizeHint` pre-sizes the output; the buffer grows if needed. maxOut guards against bombs. */
export function inflateRaw(src, sizeHint = 0, maxOut = 512 * 1024 * 1024) {
  let out = new Uint8Array(Math.min(maxOut, Math.max(sizeHint, src.length * 3, 1024)));
  let op = 0;
  let ip = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  const need = (n) => {
    if (op + n <= out.length) return;
    if (op + n > maxOut) throw new Error('Decompressed data is too large');
    const bigger = new Uint8Array(Math.min(maxOut, Math.max(out.length * 2, op + n)));
    bigger.set(out.subarray(0, op));
    out = bigger;
  };
  const bits = (n) => {
    while (bitCnt < n) {
      if (ip >= src.length) throw new Error('Unexpected end of compressed data');
      bitBuf |= src[ip++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (t) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = t.count[len];
      if (code - c < first) return t.symbols[index + (code - first)];
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('Invalid compressed data');
  };
  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (ip + 4 > src.length) throw new Error('Unexpected end of compressed data');
      const len = src[ip] | (src[ip + 1] << 8);
      ip += 4;
      if (ip + len > src.length) throw new Error('Unexpected end of compressed data');
      need(len);
      out.set(src.subarray(ip, ip + len), op);
      op += len;
      ip += len;
    } else if (type === 1 || type === 2) {
      let lit;
      let dist;
      if (type === 1) [lit, dist] = fixedTrees();
      else {
        const nlen = bits(5) + 257;
        const ndist = bits(5) + 1;
        const ncode = bits(4) + 4;
        const lens = new Uint8Array(19);
        for (let i = 0; i < ncode; i++) lens[CLORDER[i]] = bits(3);
        const ct = buildTree(lens);
        const all = new Uint8Array(nlen + ndist);
        let i = 0;
        while (i < nlen + ndist) {
          const sym = decode(ct);
          if (sym < 16) all[i++] = sym;
          else {
            let prev = 0;
            let rep;
            if (sym === 16) {
              if (!i) throw new Error('Invalid compressed data');
              prev = all[i - 1];
              rep = 3 + bits(2);
            } else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > all.length) throw new Error('Invalid compressed data');
            while (rep--) all[i++] = prev;
          }
        }
        lit = buildTree(all.subarray(0, nlen));
        dist = buildTree(all.subarray(nlen));
      }
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          need(1);
          out[op++] = sym;
        } else if (sym === 256) break;
        else {
          const s = sym - 257;
          if (s >= 29) throw new Error('Invalid compressed data');
          const len = LBASE[s] + bits(LEXT[s]);
          const ds = decode(dist);
          if (ds >= 30) throw new Error('Invalid compressed data');
          const d = DBASE[ds] + bits(DEXT[ds]);
          if (d > op) throw new Error('Invalid compressed data');
          need(len);
          for (let k = 0; k < len; k++, op++) out[op] = out[op - d];
        }
      }
    } else throw new Error('Invalid compressed data');
  }
  return out.subarray(0, op);
}

/** zlib stream (2 byte header, adler ignored). */
export function inflateZlib(src, sizeHint = 0, maxOut) {
  if (src.length < 2 || (src[0] & 0x0f) !== 8) throw new Error('Not a zlib stream');
  return inflateRaw(src.subarray(2), sizeHint, maxOut);
}

/** gzip member. */
export function inflateGzip(src, maxOut) {
  if (src[0] !== 0x1f || src[1] !== 0x8b) throw new Error('Not a gzip stream');
  const flg = src[3];
  let p = 10;
  if (flg & 4) p += 2 + (src[p] | (src[p + 1] << 8));
  if (flg & 8) while (src[p++]);
  if (flg & 16) while (src[p++]);
  if (flg & 2) p += 2;
  return inflateRaw(src.subarray(p), 0, maxOut);
}
