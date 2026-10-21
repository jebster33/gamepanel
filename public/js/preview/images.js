// Hand-written decoders for texture formats browsers cannot show: TGA, DDS, PSD, TIFF, HDR, EXR, KTX/KTX2, VTF.
// Everything returns { format, width, height, mips: [{ width, height, rgba }], note? } with RGBA8 data.
// No DOM access at module load, so the decoders also run under node for tests.

import { inflateRaw, inflateZlib } from './inflate.js';

export const NATIVE_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'jfif', 'apng'];
export const DECODED_IMAGE_EXTS = ['tga', 'dds', 'psd', 'psb', 'tif', 'tiff', 'hdr', 'exr', 'ktx', 'ktx2', 'vtf'];

const MAX_PIXELS = 64 * 1024 * 1024;

const dv = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (bytes, from, len) => String.fromCharCode(...bytes.subarray(from, from + len));

function checkSize(w, h) {
  if (!(w > 0 && h > 0) || w * h > MAX_PIXELS) throw new Error(`Image size ${w}x${h} is not supported`);
}

/* ------------------------------------------------------------- BC / DXT */

function rgb565(c, out, o) {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
}

function bc1Block(d, p, px, hasAlphaMode) {
  const c0 = d[p] | (d[p + 1] << 8);
  const c1 = d[p + 2] | (d[p + 3] << 8);
  const pal = new Uint8Array(16);
  rgb565(c0, pal, 0);
  rgb565(c1, pal, 4);
  pal[3] = 255;
  pal[7] = 255;
  if (c0 > c1 || !hasAlphaMode) {
    for (let i = 0; i < 3; i++) {
      pal[8 + i] = ((2 * pal[i] + pal[4 + i]) / 3) | 0;
      pal[12 + i] = ((pal[i] + 2 * pal[4 + i]) / 3) | 0;
    }
    pal[11] = 255;
    pal[15] = 255;
  } else {
    for (let i = 0; i < 3; i++) {
      pal[8 + i] = (pal[i] + pal[4 + i]) >> 1;
      pal[12 + i] = 0;
    }
    pal[11] = 255;
    pal[15] = 0;
  }
  let bits = (d[p + 4] | (d[p + 5] << 8) | (d[p + 6] << 16) | (d[p + 7] << 24)) >>> 0;
  for (let i = 0; i < 16; i++, bits >>>= 2) {
    const s = (bits & 3) * 4;
    px[i * 4] = pal[s];
    px[i * 4 + 1] = pal[s + 1];
    px[i * 4 + 2] = pal[s + 2];
    px[i * 4 + 3] = pal[s + 3];
  }
}

function alphaBlock(d, p, out, channel, signed = false) {
  let a0 = d[p];
  let a1 = d[p + 1];
  if (signed) {
    a0 = (a0 << 24) >> 24;
    a1 = (a1 << 24) >> 24;
  }
  const t = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) t.push(((7 - i) * a0 + i * a1) / 7);
  else {
    for (let i = 1; i < 5; i++) t.push(((5 - i) * a0 + i * a1) / 5);
    t.push(signed ? -128 : 0, signed ? 127 : 255);
  }
  // 48 bits of 3-bit indices, little-endian.
  let lo = (d[p + 2] | (d[p + 3] << 8) | (d[p + 4] << 16)) >>> 0;
  let hi = (d[p + 5] | (d[p + 6] << 8) | (d[p + 7] << 16)) >>> 0;
  for (let i = 0; i < 16; i++) {
    let idx;
    if (i < 8) {
      idx = lo & 7;
      lo >>>= 3;
    } else {
      idx = hi & 7;
      hi >>>= 3;
    }
    const v = signed ? t[idx] + 128 : t[idx];
    out[i * 4 + channel] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
}

/** kind: 'bc1' | 'bc1a' | 'bc2' | 'bc3' | 'bc4' | 'bc5'. Returns RGBA8 for a w x h surface. */
export function decodeBC(kind, d, w, h) {
  const out = new Uint8Array(w * h * 4);
  const block = new Uint8Array(64);
  const bw = Math.max(1, (w + 3) >> 2);
  const bh = Math.max(1, (h + 3) >> 2);
  const size = kind === 'bc1' || kind === 'bc1a' || kind === 'bc4' ? 8 : 16;
  if (d.length < bw * bh * size) throw new Error('Texture data is truncated');
  let p = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, p += size) {
      block.fill(255);
      if (kind === 'bc1' || kind === 'bc1a') bc1Block(d, p, block, kind === 'bc1a');
      else if (kind === 'bc2') {
        bc1Block(d, p + 8, block, false);
        for (let i = 0; i < 16; i++) {
          const n = (d[p + (i >> 1)] >> ((i & 1) * 4)) & 15;
          block[i * 4 + 3] = (n << 4) | n;
        }
      } else if (kind === 'bc3') {
        bc1Block(d, p + 8, block, false);
        alphaBlock(d, p, block, 3);
      } else if (kind === 'bc4') {
        alphaBlock(d, p, block, 0);
        for (let i = 0; i < 16; i++) block[i * 4 + 1] = block[i * 4 + 2] = block[i * 4];
      } else if (kind === 'bc5') {
        alphaBlock(d, p, block, 0);
        alphaBlock(d, p + 8, block, 1);
        for (let i = 0; i < 16; i++) {
          // Rebuild the normal map's blue channel.
          const x = block[i * 4] / 127.5 - 1;
          const y = block[i * 4 + 1] / 127.5 - 1;
          block[i * 4 + 2] = Math.max(0, Math.min(255, (Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255)) | 0;
        }
      } else throw new Error('Unsupported block format');
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= h) break;
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          if (px >= w) break;
          const o = (py * w + px) * 4;
          const s = (y * 4 + x) * 4;
          out[o] = block[s];
          out[o + 1] = block[s + 1];
          out[o + 2] = block[s + 2];
          out[o + 3] = block[s + 3];
        }
      }
    }
  }
  return out;
}

export function bcSize(kind, w, h) {
  const bw = Math.max(1, (w + 3) >> 2);
  const bh = Math.max(1, (h + 3) >> 2);
  return bw * bh * (kind === 'bc1' || kind === 'bc1a' || kind === 'bc4' ? 8 : 16);
}

/* ------------------------------------------------------ small helpers */

/** Expand packed/planar pixel data to RGBA. fmt: 'rgba' 'bgra' 'argb' 'abgr' 'rgb' 'bgr' 'l8' 'a8' 'la' 'rgb565' 'bgr565' 'argb1555' 'bgra4444' 'bgra5551' */
export function expandPixels(fmt, d, w, h) {
  const out = new Uint8Array(w * h * 4);
  const n = w * h;
  const need = { rgba: 4, bgra: 4, argb: 4, abgr: 4, bgrx: 4, rgb: 3, bgr: 3, l8: 1, a8: 1, la: 2, rgb565: 2, bgr565: 2, argb1555: 2, bgra4444: 2, bgra5551: 2 }[fmt];
  if (!need) throw new Error('Unsupported pixel format');
  if (d.length < n * need) throw new Error('Texture data is truncated');
  const e5 = (v) => (v << 3) | (v >> 2);
  const e4 = (v) => (v << 4) | v;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const s = i * need;
    switch (fmt) {
      case 'rgba': out[o] = d[s]; out[o + 1] = d[s + 1]; out[o + 2] = d[s + 2]; out[o + 3] = d[s + 3]; break;
      case 'bgra': out[o] = d[s + 2]; out[o + 1] = d[s + 1]; out[o + 2] = d[s]; out[o + 3] = d[s + 3]; break;
      case 'bgrx': out[o] = d[s + 2]; out[o + 1] = d[s + 1]; out[o + 2] = d[s]; out[o + 3] = 255; break;
      case 'argb': out[o] = d[s + 1]; out[o + 1] = d[s + 2]; out[o + 2] = d[s + 3]; out[o + 3] = d[s]; break;
      case 'abgr': out[o] = d[s + 3]; out[o + 1] = d[s + 2]; out[o + 2] = d[s + 1]; out[o + 3] = d[s]; break;
      case 'rgb': out[o] = d[s]; out[o + 1] = d[s + 1]; out[o + 2] = d[s + 2]; out[o + 3] = 255; break;
      case 'bgr': out[o] = d[s + 2]; out[o + 1] = d[s + 1]; out[o + 2] = d[s]; out[o + 3] = 255; break;
      case 'l8': out[o] = out[o + 1] = out[o + 2] = d[s]; out[o + 3] = 255; break;
      case 'a8': out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = d[s]; break;
      case 'la': out[o] = out[o + 1] = out[o + 2] = d[s]; out[o + 3] = d[s + 1]; break;
      case 'rgb565': { const v = d[s] | (d[s + 1] << 8); out[o] = e5((v >> 11) & 31); out[o + 1] = ((v >> 5) & 63) * 255 / 63; out[o + 2] = e5(v & 31); out[o + 3] = 255; break; }
      case 'bgr565': { const v = d[s] | (d[s + 1] << 8); out[o + 2] = e5((v >> 11) & 31); out[o + 1] = ((v >> 5) & 63) * 255 / 63; out[o] = e5(v & 31); out[o + 3] = 255; break; }
      case 'argb1555': { const v = d[s] | (d[s + 1] << 8); out[o] = e5((v >> 10) & 31); out[o + 1] = e5((v >> 5) & 31); out[o + 2] = e5(v & 31); out[o + 3] = v & 0x8000 ? 255 : 0; break; }
      case 'bgra5551': { const v = d[s] | (d[s + 1] << 8); out[o + 2] = e5((v >> 11) & 31); out[o + 1] = e5((v >> 6) & 31); out[o] = e5((v >> 1) & 31); out[o + 3] = v & 1 ? 255 : 0; break; }
      case 'bgra4444': { const v = d[s] | (d[s + 1] << 8); out[o + 3] = e4((v >> 12) & 15); out[o + 2] = e4((v >> 8) & 15); out[o + 1] = e4((v >> 4) & 15); out[o] = e4(v & 15); break; }
      default: break;
    }
  }
  return out;
}

const result = (format, width, height, mips, note) => ({ format, width, height, mips, ...(note ? { note } : {}) });
const single = (format, w, h, rgba, note) => result(format, w, h, [{ width: w, height: h, rgba }], note);

/* ------------------------------------------------------------------ TGA */

export function decodeTGA(b) {
  if (b.length < 18) throw new Error('Not a TGA file');
  const idLen = b[0];
  const cmType = b[1];
  const type = b[2];
  const cmFirst = b[3] | (b[4] << 8);
  const cmLen = b[5] | (b[6] << 8);
  const cmBits = b[7];
  const w = b[12] | (b[13] << 8);
  const h = b[14] | (b[15] << 8);
  const bpp = b[16];
  const desc = b[17];
  checkSize(w, h);
  if (![1, 2, 3, 9, 10, 11].includes(type)) throw new Error('Unsupported TGA type ' + type);
  let p = 18 + idLen;
  let palette = null;
  if (cmType === 1) {
    const eb = (cmBits + 7) >> 3;
    palette = new Uint8Array((cmFirst + cmLen) * 4);
    for (let i = 0; i < cmLen; i++, p += eb) {
      const o = (cmFirst + i) * 4;
      pixelTo(b, p, cmBits, palette, o, null);
    }
  }
  const bytesPP = (bpp + 7) >> 3;
  const raw = new Uint8Array(w * h * bytesPP);
  const rle = type >= 9;
  if (!rle) raw.set(b.subarray(p, p + raw.length));
  else {
    let o = 0;
    while (o < raw.length && p < b.length) {
      const hdr = b[p++];
      const n = (hdr & 127) + 1;
      if (hdr & 128) {
        for (let i = 0; i < n && o < raw.length; i++) for (let k = 0; k < bytesPP; k++) raw[o++] = b[p + k];
        p += bytesPP;
      } else {
        const len = Math.min(n * bytesPP, raw.length - o);
        raw.set(b.subarray(p, p + len), o);
        o += len;
        p += n * bytesPP;
      }
    }
  }
  const out = new Uint8Array(w * h * 4);
  const grey = type === 3 || type === 11;
  const hasAlphaBits = (desc & 15) > 0 || bpp === 32;
  for (let i = 0; i < w * h; i++) {
    const y = desc & 0x20 ? Math.floor(i / w) : h - 1 - Math.floor(i / w);
    const x = desc & 0x10 ? w - 1 - (i % w) : i % w;
    const o = (y * w + x) * 4;
    if (palette) {
      const idx = raw[i * bytesPP] | (bytesPP > 1 ? raw[i * bytesPP + 1] << 8 : 0);
      out.set(palette.subarray(idx * 4, idx * 4 + 4), o);
    } else if (grey) {
      out[o] = out[o + 1] = out[o + 2] = raw[i * bytesPP];
      out[o + 3] = bytesPP > 1 ? raw[i * bytesPP + 1] : 255;
    } else pixelTo(raw, i * bytesPP, bpp, out, o, hasAlphaBits);
  }
  return single('TGA ' + bpp + '-bit', w, h, out);
}

function pixelTo(src, p, bits, out, o, alpha) {
  if (bits === 15 || bits === 16) {
    const v = src[p] | (src[p + 1] << 8);
    out[o] = ((v >> 10) & 31) * 255 / 31;
    out[o + 1] = ((v >> 5) & 31) * 255 / 31;
    out[o + 2] = (v & 31) * 255 / 31;
    out[o + 3] = 255;
  } else {
    out[o] = src[p + 2];
    out[o + 1] = src[p + 1];
    out[o + 2] = src[p];
    out[o + 3] = bits === 32 ? src[p + 3] : 255;
  }
}

/* ------------------------------------------------------------------ DDS */

const DXGI = { 71: 'bc1', 72: 'bc1', 74: 'bc2', 75: 'bc2', 77: 'bc3', 78: 'bc3', 80: 'bc4', 81: 'bc4', 83: 'bc5', 84: 'bc5' };

export function decodeDDS(b) {
  if (b.length < 128 || ascii(b, 0, 4) !== 'DDS ') throw new Error('Not a DDS file');
  const v = dv(b);
  const h = v.getUint32(12, true);
  const w = v.getUint32(16, true);
  let levels = Math.max(1, v.getUint32(28, true));
  const pfFlags = v.getUint32(80, true);
  const fourcc = ascii(b, 84, 4);
  const bitCount = v.getUint32(88, true);
  const masks = [v.getUint32(92, true), v.getUint32(96, true), v.getUint32(100, true), v.getUint32(104, true)];
  checkSize(w, h);
  let p = 128;
  let kind = null;
  let label = fourcc;
  let linear = null;
  if (pfFlags & 4) {
    if (fourcc === 'DX10') {
      const dxgi = v.getUint32(128, true);
      p = 148;
      label = 'DXGI ' + dxgi;
      if (DXGI[dxgi]) kind = DXGI[dxgi];
      else if (dxgi === 28 || dxgi === 29) linear = 'rgba';
      else if (dxgi === 87 || dxgi === 91) linear = 'bgra';
      else if (dxgi === 88) linear = 'bgrx';
      else if (dxgi === 61) linear = 'l8';
      else if (dxgi === 98 || dxgi === 99) throw new Error('BC7 DDS textures are not supported by this previewer');
      else throw new Error('Unsupported DXGI format ' + dxgi);
    } else if (fourcc === 'DXT1') kind = 'bc1a';
    else if (fourcc === 'DXT2' || fourcc === 'DXT3') kind = 'bc2';
    else if (fourcc === 'DXT4' || fourcc === 'DXT5') kind = 'bc3';
    else if (fourcc === 'ATI1' || fourcc === 'BC4U') kind = 'bc4';
    else if (fourcc === 'ATI2' || fourcc === 'BC5U') kind = 'bc5';
    else throw new Error('Unsupported DDS FourCC ' + JSON.stringify(fourcc));
  } else {
    label = 'RGB' + bitCount;
    const isLum = !!(pfFlags & 0x20000);
    const isAlphaOnly = !!(pfFlags & 2) && !(pfFlags & 0x40);
    if (bitCount === 32 && masks[0] === 0xff && masks[1] === 0xff00) linear = 'rgba';
    else if (bitCount === 32 && masks[0] === 0xff0000) linear = pfFlags & 1 ? 'bgra' : 'bgrx';
    else if (bitCount === 24) linear = masks[0] === 0xff0000 ? 'bgr' : 'rgb';
    else if (bitCount === 16 && masks[0] === 0xf800) linear = 'rgb565';
    else if (bitCount === 16 && masks[3] === 0x8000) linear = 'argb1555';
    else if (bitCount === 16 && masks[3] === 0xf000) linear = 'bgra4444';
    else if (bitCount === 8 && isAlphaOnly) linear = 'a8';
    else if (bitCount === 8 || isLum) linear = bitCount === 16 ? 'la' : 'l8';
    else throw new Error('Unsupported DDS pixel format');
  }
  if (!(v.getUint32(8, true) & 0x20000)) levels = 1;
  const mips = [];
  let mw = w;
  let mh = h;
  const bpp = { rgba: 4, bgra: 4, bgrx: 4, bgr: 3, rgb: 3, rgb565: 2, argb1555: 2, bgra4444: 2, a8: 1, l8: 1, la: 2 };
  for (let i = 0; i < levels; i++) {
    const size = kind ? bcSize(kind.replace('bc1a', 'bc1'), mw, mh) : mw * mh * bpp[linear];
    if (p + size > b.length) {
      if (i === 0) throw new Error('DDS data is truncated');
      break;
    }
    const data = b.subarray(p, p + size);
    mips.push({ width: mw, height: mh, rgba: kind ? decodeBC(kind, data, mw, mh) : expandPixels(linear, data, mw, mh) });
    p += size;
    mw = Math.max(1, mw >> 1);
    mh = Math.max(1, mh >> 1);
  }
  const cube = v.getUint32(112, true) & 0x200;
  return result('DDS ' + label, w, h, mips, cube ? 'Cube map: showing the first face' : undefined);
}

/* ------------------------------------------------------------------ PSD */

export function decodePSD(b) {
  if (ascii(b, 0, 4) !== '8BPS') throw new Error('Not a PSD file');
  const v = dv(b);
  const big = v.getUint16(4, false) === 2;
  const channels = v.getUint16(12, false);
  const h = v.getUint32(14, false);
  const w = v.getUint32(18, false);
  const depth = v.getUint16(22, false);
  const mode = v.getUint16(24, false);
  checkSize(w, h);
  let p = 26;
  const cmLen = v.getUint32(p, false);
  const palette = b.subarray(p + 4, p + 4 + cmLen);
  p += 4 + cmLen;
  p += 4 + v.getUint32(p, false); // image resources
  p += big ? 8 + Number(v.getBigUint64(p, false)) : 4 + v.getUint32(p, false); // layer and mask info
  const comp = v.getUint16(p, false);
  p += 2;
  const bytesPer = depth === 16 ? 2 : depth === 32 ? 4 : 1;
  if (depth === 1) throw new Error('1-bit PSD files are not supported');
  const rowBytes = w * bytesPer;
  const planes = [];
  if (comp === 0) {
    for (let c = 0; c < channels; c++) {
      planes.push(b.subarray(p + c * h * rowBytes, p + (c + 1) * h * rowBytes));
    }
  } else if (comp === 1) {
    const lenSize = big ? 4 : 2;
    let dp = p + channels * h * lenSize;
    let lp = p;
    for (let c = 0; c < channels; c++) {
      const plane = new Uint8Array(h * rowBytes);
      for (let y = 0; y < h; y++) {
        const n = lenSize === 4 ? v.getUint32(lp, false) : v.getUint16(lp, false);
        lp += lenSize;
        let o = y * rowBytes;
        const end = dp + n;
        const rowEnd = o + rowBytes;
        while (dp < end && o < rowEnd) {
          const c0 = (b[dp++] << 24) >> 24;
          if (c0 >= 0) {
            const len = Math.min(c0 + 1, rowEnd - o);
            plane.set(b.subarray(dp, dp + len), o);
            o += len;
            dp += c0 + 1;
          } else if (c0 !== -128) {
            const len = Math.min(1 - c0, rowEnd - o);
            plane.fill(b[dp++], o, o + len);
            o += len;
          }
        }
        dp = end;
      }
      planes.push(plane);
    }
  } else if (comp === 2) {
    const all = inflateZlib(b.subarray(p));
    for (let c = 0; c < channels; c++) planes.push(all.subarray(c * h * rowBytes, (c + 1) * h * rowBytes));
  } else throw new Error('Unsupported PSD compression');
  if (planes.some((pl) => pl.length < h * rowBytes)) throw new Error('PSD data is truncated');
  const sample = (c, i) => {
    const pl = planes[c];
    if (bytesPer === 1) return pl[i];
    if (bytesPer === 2) return pl[i * 2];
    const f = new DataView(pl.buffer, pl.byteOffset + i * 4, 4).getFloat32(0, false);
    return Math.max(0, Math.min(255, Math.pow(Math.max(0, f), 1 / 2.2) * 255));
  };
  const out = new Uint8Array(w * h * 4);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (mode === 1 || mode === 8) {
      out[o] = out[o + 1] = out[o + 2] = sample(0, i);
      out[o + 3] = channels > 1 ? sample(1, i) : 255;
    } else if (mode === 2) {
      const idx = sample(0, i);
      out[o] = palette[idx];
      out[o + 1] = palette[256 + idx];
      out[o + 2] = palette[512 + idx];
      out[o + 3] = 255;
    } else if (mode === 3) {
      out[o] = sample(0, i);
      out[o + 1] = sample(1, i);
      out[o + 2] = sample(2, i);
      out[o + 3] = channels > 3 ? sample(3, i) : 255;
    } else if (mode === 4) {
      const k = sample(3, i);
      out[o] = (sample(0, i) * k) / 255;
      out[o + 1] = (sample(1, i) * k) / 255;
      out[o + 2] = (sample(2, i) * k) / 255;
      out[o + 3] = 255;
    } else throw new Error('Unsupported PSD colour mode ' + mode);
  }
  return single(`PSD ${['', 'grayscale', 'indexed', 'RGB', 'CMYK'][mode] || 'mode ' + mode} ${depth}-bit`, w, h, out, 'Showing the flattened preview stored in the file (Photoshop saves it when "Maximize compatibility" is on).');
}

/* ----------------------------------------------------------------- TIFF */

function lzwDecode(src, expected) {
  const out = new Uint8Array(expected);
  let op = 0;
  let table = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < 256; i++) table.push([i]);
    table.push(null, null);
  };
  reset();
  let bitPos = 0;
  let width = 9;
  let prev = null;
  const total = src.length * 8;
  while (bitPos + width <= total && op < expected) {
    let code = 0;
    for (let i = 0; i < width; i++, bitPos++) code = (code << 1) | ((src[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
    if (code === 257) break;
    if (code === 256) {
      reset();
      width = 9;
      prev = null;
      continue;
    }
    let entry;
    if (code < table.length && table[code]) entry = table[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (let i = 0; i < entry.length && op < expected; i++) out[op++] = entry[i];
    if (prev) table.push([...prev, entry[0]]);
    prev = entry;
    // TIFF uses "early change": the width grows one code sooner than GIF.
    width = table.length >= 2047 ? 12 : table.length >= 1023 ? 11 : table.length >= 511 ? 10 : 9;
  }
  return out;
}

function packBits(src, expected) {
  const out = new Uint8Array(expected);
  let o = 0;
  let p = 0;
  while (p < src.length && o < expected) {
    const n = (src[p++] << 24) >> 24;
    if (n >= 0) {
      for (let i = 0; i <= n && o < expected; i++) out[o++] = src[p++];
    } else if (n !== -128) {
      const v = src[p++];
      for (let i = 0; i < 1 - n && o < expected; i++) out[o++] = v;
    }
  }
  return out;
}

export function decodeTIFF(b) {
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!(le || (b[0] === 0x4d && b[1] === 0x4d))) throw new Error('Not a TIFF file');
  const v = dv(b);
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  if (u16(2) !== 42) throw new Error('BigTIFF is not supported');
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = {};
  const typeSize = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    const type = u16(e + 2);
    const count = u32(e + 4);
    const total = (typeSize[type] || 1) * count;
    const base = total <= 4 ? e + 8 : u32(e + 8);
    const vals = [];
    for (let k = 0; k < Math.min(count, 1 << 20); k++) {
      if (type === 3) vals.push(u16(base + k * 2));
      else if (type === 4) vals.push(u32(base + k * 4));
      else if (type === 1 || type === 7) vals.push(b[base + k]);
    }
    tags[tag] = vals;
  }
  const w = tags[256]?.[0];
  const h = tags[257]?.[0];
  checkSize(w, h);
  const bits = tags[258]?.[0] || 1;
  const comp = tags[259]?.[0] || 1;
  const photo = tags[262]?.[0] ?? 1;
  const spp = tags[277]?.[0] || 1;
  const rps = tags[278]?.[0] || h;
  const predictor = tags[317]?.[0] || 1;
  if (tags[322]) throw new Error('Tiled TIFF files are not supported');
  if (tags[284]?.[0] === 2) throw new Error('Planar TIFF files are not supported');
  if (tags[339]?.[0] === 3) throw new Error('Floating point TIFF files are not supported');
  if (bits !== 8 && bits !== 16) throw new Error('Only 8 and 16 bit TIFF files are supported');
  const bps = bits / 8;
  const stride = w * spp * bps;
  const offsets = tags[273] || [];
  const counts = tags[279] || [];
  const raw = new Uint8Array(stride * h);
  for (let s = 0; s < offsets.length; s++) {
    const rows = Math.min(rps, h - s * rps);
    if (rows <= 0) break;
    const chunk = b.subarray(offsets[s], offsets[s] + (counts[s] ?? b.length - offsets[s]));
    let data;
    if (comp === 1) data = chunk;
    else if (comp === 5) data = lzwDecode(chunk, stride * rows);
    else if (comp === 32773) data = packBits(chunk, stride * rows);
    else if (comp === 8 || comp === 32946) data = inflateZlib(chunk, stride * rows);
    else throw new Error('Unsupported TIFF compression ' + comp);
    if (predictor === 2 && bps === 1) {
      for (let y = 0; y < rows; y++) for (let x = spp; x < w * spp; x++) data[y * stride + x] = (data[y * stride + x] + data[y * stride + x - spp]) & 255;
    }
    raw.set(data.subarray(0, stride * rows), s * rps * stride);
  }
  const px = (i) => raw[i * bps + (le && bps === 2 ? 1 : 0)];
  const out = new Uint8Array(w * h * 4);
  const cmap = tags[320];
  const extra = tags[338]?.length || 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const s = i * spp;
    if (photo === 2 || photo === 5 || photo === 6) {
      out[o] = px(s);
      out[o + 1] = px(s + 1);
      out[o + 2] = px(s + 2);
      out[o + 3] = spp > 3 && extra ? px(s + 3) : 255;
      if (photo === 5) {
        const k = 255 - px(s + 3);
        out[o] = ((255 - px(s)) * k) / 255;
        out[o + 1] = ((255 - px(s + 1)) * k) / 255;
        out[o + 2] = ((255 - px(s + 2)) * k) / 255;
        out[o + 3] = 255;
      }
    } else if (photo === 3 && cmap) {
      const idx = bits === 8 ? raw[s] : (raw[s * 2] << 8) | raw[s * 2 + 1];
      out[o] = cmap[idx] >> 8;
      out[o + 1] = cmap[256 + idx] >> 8;
      out[o + 2] = cmap[512 + idx] >> 8;
      out[o + 3] = 255;
    } else {
      const g = photo === 0 ? 255 - px(s) : px(s);
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = spp > 1 && extra ? px(s + 1) : 255;
    }
  }
  return single(`TIFF ${bits}-bit, ${spp} channel${spp > 1 ? 's' : ''}`, w, h, out);
}

/* ------------------------------------------------------------------ HDR */

function toneMap(r, g, b, out, o) {
  const f = (x) => {
    const m = x / (1 + x);
    return Math.max(0, Math.min(255, Math.pow(m * 1.6, 1 / 2.2) * 255));
  };
  out[o] = f(r);
  out[o + 1] = f(g);
  out[o + 2] = f(b);
  out[o + 3] = 255;
}

export function decodeHDR(b) {
  let p = 0;
  const line = () => {
    let s = '';
    while (p < b.length && b[p] !== 10) s += String.fromCharCode(b[p++]);
    p++;
    return s;
  };
  const first = line();
  if (!first.startsWith('#?')) throw new Error('Not a Radiance HDR file');
  let l;
  while ((l = line()) !== '' && p < b.length);
  const res = /^([-+])Y\s+(\d+)\s+([-+])X\s+(\d+)/.exec(line());
  if (!res) throw new Error('Unsupported HDR layout');
  const h = Number(res[2]);
  const w = Number(res[4]);
  checkSize(w, h);
  const rgbe = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (w >= 8 && w < 32768 && b[p] === 2 && b[p + 1] === 2 && !(b[p + 2] & 0x80) && ((b[p + 2] << 8) | b[p + 3]) === w) {
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < w && p < b.length) {
          let n = b[p++];
          if (n > 128) {
            n -= 128;
            const val = b[p++];
            while (n-- && x < w) rgbe[(y * w + x++) * 4 + c] = val;
          } else {
            while (n-- && x < w) rgbe[(y * w + x++) * 4 + c] = b[p++];
          }
        }
      }
    } else {
      for (let x = 0; x < w; x++, p += 4) rgbe.set(b.subarray(p, p + 4), (y * w + x) * 4);
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const e = rgbe[i * 4 + 3];
    const s = e ? Math.pow(2, e - 136) : 0;
    toneMap(rgbe[i * 4] * s, rgbe[i * 4 + 1] * s, rgbe[i * 4 + 2] * s, out, i * 4);
    if (res[1] === '+') {
      /* bottom-to-top: leave as is, rare */
    }
  }
  return single('Radiance HDR', w, h, out, 'High dynamic range, tone mapped for display.');
}

/* ------------------------------------------------------------------ EXR */

function half(v) {
  const s = v & 0x8000 ? -1 : 1;
  const e = (v >> 10) & 31;
  const f = v & 1023;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

export function decodeEXR(b) {
  const v = dv(b);
  if (v.getUint32(0, true) !== 20000630) throw new Error('Not an OpenEXR file');
  if (v.getUint32(4, true) & 0x1a00) throw new Error('Tiled, multipart and deep EXR files are not supported');
  let p = 8;
  const attrs = {};
  const str = () => {
    let s = '';
    while (b[p]) s += String.fromCharCode(b[p++]);
    p++;
    return s;
  };
  for (;;) {
    const name = str();
    if (!name) break;
    str();
    const size = v.getUint32(p, true);
    p += 4;
    attrs[name] = p;
    p += size;
  }
  if (attrs.compression === undefined || attrs.channels === undefined || attrs.dataWindow === undefined) throw new Error('Unsupported EXR header');
  const comp = b[attrs.compression];
  const x0 = v.getInt32(attrs.dataWindow, true);
  const y0 = v.getInt32(attrs.dataWindow + 4, true);
  const w = v.getInt32(attrs.dataWindow + 8, true) - x0 + 1;
  const h = v.getInt32(attrs.dataWindow + 12, true) - y0 + 1;
  checkSize(w, h);
  if (![0, 1, 2, 3].includes(comp)) throw new Error(['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB'][comp] + ' compressed EXR files are not supported');
  let q = attrs.channels;
  const chans = [];
  while (b[q]) {
    let name = '';
    while (b[q]) name += String.fromCharCode(b[q++]);
    q++;
    const type = v.getInt32(q, true);
    chans.push({ name, type });
    q += 16;
  }
  const bytesOf = (t) => (t === 1 ? 2 : 4);
  const lines = comp === 3 ? 16 : 1;
  const blocks = Math.ceil(h / lines);
  let tp = p;
  const planes = {};
  for (const c of chans) planes[c.name] = new Float32Array(w * h);
  for (let i = 0; i < blocks; i++) {
    const off = Number(v.getBigUint64(tp + i * 8, true));
    const y = v.getInt32(off, true) - y0;
    const size = v.getInt32(off + 4, true);
    const n = Math.min(lines, h - y);
    const rawSize = chans.reduce((s, c) => s + bytesOf(c.type) * w, 0) * n;
    let data = b.subarray(off + 8, off + 8 + size);
    if (comp !== 0 && size < rawSize) {
      data = comp === 1 ? data : inflateZlib(data, rawSize);
      const t = new Uint8Array(data.length);
      const half2 = (data.length + 1) >> 1;
      for (let k = 0; k < data.length; k++) t[k] = data[k & 1 ? half2 + (k >> 1) : k >> 1];
      for (let k = 1; k < t.length; k++) t[k] = (t[k - 1] + t[k] - 128) & 255;
      data = t;
    }
    const dd = dv(data);
    let o = 0;
    for (let row = 0; row < n; row++) {
      for (const c of chans) {
        const arr = planes[c.name];
        for (let x = 0; x < w; x++) {
          arr[(y + row) * w + x] = c.type === 1 ? half(dd.getUint16(o, true)) : c.type === 2 ? dd.getFloat32(o, true) : dd.getUint32(o, true);
          o += bytesOf(c.type);
        }
      }
    }
  }
  const out = new Uint8Array(w * h * 4);
  const R = planes.R || planes.Y;
  const G = planes.G || planes.Y;
  const B = planes.B || planes.Y;
  if (!R) throw new Error('EXR has no colour channels');
  for (let i = 0; i < w * h; i++) {
    toneMap(R[i], G[i], B[i], out, i * 4);
    if (planes.A) out[i * 4 + 3] = Math.max(0, Math.min(255, planes.A[i] * 255));
  }
  return single('OpenEXR', w, h, out, 'High dynamic range, tone mapped for display. Best effort: NONE/RLE/ZIP only.');
}

/* ------------------------------------------------------------------ KTX */

const GL_BC = { 0x83f0: 'bc1', 0x83f1: 'bc1a', 0x83f2: 'bc2', 0x83f3: 'bc3', 0x8dbb: 'bc4', 0x8dbd: 'bc5', 0x8c4c: 'bc1', 0x8c4d: 'bc1a', 0x8c4e: 'bc2', 0x8c4f: 'bc3' };
const VK_FMT = { 131: ['bc1'], 132: ['bc1'], 133: ['bc1a'], 134: ['bc1a'], 135: ['bc2'], 136: ['bc2'], 137: ['bc3'], 138: ['bc3'], 139: ['bc4'], 141: ['bc5'], 37: ['px', 'rgba'], 43: ['px', 'rgba'], 44: ['px', 'bgra'], 50: ['px', 'bgra'], 23: ['px', 'rgb'], 29: ['px', 'rgb'], 9: ['px', 'l8'], 15: ['px', 'la'] };

function levelsToMips(items, w, h) {
  return items.map((it, i) => ({ width: Math.max(1, w >> i), height: Math.max(1, h >> i), rgba: it(Math.max(1, w >> i), Math.max(1, h >> i)) }));
}

export function decodeKTX(b) {
  const v = dv(b);
  const ktx2 = b[5] === 0x32;
  if (b[0] !== 0xab || ascii(b, 1, 3) !== 'KTX') throw new Error('Not a KTX file');
  if (ktx2) {
    const vk = v.getUint32(12, true);
    const w = v.getUint32(20, true);
    const h = v.getUint32(24, true) || 1;
    const levels = Math.max(1, v.getUint32(40, true));
    const sc = v.getUint32(44, true);
    checkSize(w, h);
    if (sc !== 0) throw new Error('Supercompressed (Basis/Zstd) KTX2 files are not supported');
    const f = VK_FMT[vk];
    if (!f) throw new Error('Unsupported KTX2 format ' + vk);
    const items = [];
    for (let i = 0; i < levels; i++) {
      const off = Number(v.getBigUint64(80 + i * 24, true));
      const len = Number(v.getBigUint64(88 + i * 24, true));
      items.push((mw, mh) => (f[0] === 'px' ? expandPixels(f[1], b.subarray(off, off + len), mw, mh) : decodeBC(f[0], b.subarray(off, off + len), mw, mh)));
    }
    return result('KTX2 vk' + vk, w, h, levelsToMips(items, w, h));
  }
  const le = v.getUint32(12, true) === 0x04030201;
  const u32 = (o) => v.getUint32(o, le);
  const glFormat = u32(28);
  const glInternal = u32(32);
  const w = u32(36);
  const h = u32(40) || 1;
  const levels = Math.max(1, u32(56));
  const kv = u32(60);
  checkSize(w, h);
  let p = 64 + kv;
  const items = [];
  for (let i = 0; i < levels; i++) {
    if (p + 4 > b.length) break;
    const size = u32(p);
    p += 4;
    const data = b.subarray(p, p + size);
    p += (size + 3) & ~3;
    if (GL_BC[glInternal]) items.push((mw, mh) => decodeBC(GL_BC[glInternal], data, mw, mh));
    else if (glFormat === 0x1908) items.push((mw, mh) => expandPixels('rgba', data, mw, mh));
    else if (glFormat === 0x1907) items.push((mw, mh) => expandPixels('rgb', data, mw, mh));
    else if (glFormat === 0x1909) items.push((mw, mh) => expandPixels('l8', data, mw, mh));
    else throw new Error('Unsupported KTX format 0x' + glInternal.toString(16));
  }
  return result('KTX 0x' + glInternal.toString(16), w, h, levelsToMips(items, w, h));
}

/* ------------------------------------------------------------------ VTF */

const VTF_FORMATS = { 0: 'rgba', 1: 'abgr', 2: 'rgb', 3: 'bgr', 4: 'rgb565', 5: 'l8', 6: 'la', 8: 'a8', 11: 'argb', 12: 'bgra', 13: 'bc1', 14: 'bc2', 15: 'bc3', 16: 'bgrx', 17: 'bgr565', 19: 'bgra4444', 20: 'bc1a', 21: 'bgra5551' };
const VTF_BPP = { rgba: 4, abgr: 4, rgb: 3, bgr: 3, rgb565: 2, l8: 1, la: 2, a8: 1, argb: 4, bgra: 4, bgrx: 4, bgr565: 2, bgra4444: 2, bgra5551: 2 };

export function decodeVTF(b) {
  if (ascii(b, 0, 3) !== 'VTF') throw new Error('Not a VTF file');
  const v = dv(b);
  const minor = v.getUint32(8, true);
  const headerSize = v.getUint32(12, true);
  const w = v.getUint16(16, true);
  const h = v.getUint16(18, true);
  const flags = v.getUint32(20, true);
  const frames = Math.max(1, v.getUint16(24, true));
  const fmtId = v.getInt32(52, true);
  const mipCount = Math.max(1, b[56]);
  const lowId = v.getInt32(57, true);
  const lw = b[61];
  const lh = b[62];
  checkSize(w, h);
  const fmt = VTF_FORMATS[fmtId];
  if (!fmt) throw new Error('Unsupported VTF image format ' + fmtId);
  const size = (f, mw, mh) => (f.startsWith('bc') ? bcSize(f, mw, mh) : mw * mh * VTF_BPP[f]);
  const faces = flags & 0x4000 ? (minor >= 5 ? 6 : 7) : 1;
  let p = headerSize;
  const low = VTF_FORMATS[lowId];
  if (lw && lh && low) p += size(low, lw, lh);
  const sizes = [];
  for (let m = 0; m < mipCount; m++) sizes.push(size(fmt, Math.max(1, w >> m), Math.max(1, h >> m)));
  // Mips are stored smallest first; within a mip: frames, then faces.
  const offsets = new Array(mipCount);
  for (let m = mipCount - 1; m >= 0; m--) {
    offsets[m] = p;
    p += sizes[m] * frames * faces;
  }
  const mips = [];
  for (let m = 0; m < mipCount; m++) {
    const mw = Math.max(1, w >> m);
    const mh = Math.max(1, h >> m);
    const data = b.subarray(offsets[m], offsets[m] + sizes[m]);
    if (data.length < sizes[m]) {
      if (m === 0) throw new Error('VTF data is truncated');
      break;
    }
    mips.push({ width: mw, height: mh, rgba: fmt.startsWith('bc') ? decodeBC(fmt, data, mw, mh) : expandPixels(fmt, data, mw, mh) });
  }
  const notes = [];
  if (frames > 1) notes.push('Animated: showing frame 1');
  if (faces > 1) notes.push('Cube map: showing the first face');
  return result(`VTF v7.${minor} ${fmt.toUpperCase()}`, w, h, mips, notes.join('. ') || undefined);
}

/* ------------------------------------------------------------ dispatch */

export const extOf = (name) => (/\.([^./\\]+)$/.exec(String(name)) || [])[1]?.toLowerCase() || '';

/** Decode a non-native image by extension. Returns null when the browser should decode it itself. */
export function decodeImage(bytes, name) {
  switch (extOf(name)) {
    case 'tga': return decodeTGA(bytes);
    case 'dds': return decodeDDS(bytes);
    case 'psd': case 'psb': return decodePSD(bytes);
    case 'tif': case 'tiff': return decodeTIFF(bytes);
    case 'hdr': return decodeHDR(bytes);
    case 'exr': return decodeEXR(bytes);
    case 'ktx': case 'ktx2': return decodeKTX(bytes);
    case 'vtf': return decodeVTF(bytes);
    default: return null;
  }
}

export { inflateRaw };
