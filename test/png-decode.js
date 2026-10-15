// A PNG's pixels, for the tests that look at a picture (8 bits a channel, grey, grey and alpha, RGB or RGBA, not
// interlaced: what rsvg-convert and a browser's canvas write). Not used by the tools themselves.
import { unzlibSync } from 'fflate';
import { chunksOf } from '../src/engine/chora/export/png-meta.js';

/** { width, height, rgba: Uint8Array of width × height × 4 }. */
export function decodePng(bytes) {
  const chunks = chunksOf(bytes);
  const h = chunks[0].data;
  const u32 = (i) => ((h[i] << 24) | (h[i + 1] << 16) | (h[i + 2] << 8) | h[i + 3]) >>> 0;
  const width = u32(0), height = u32(4), depth = h[8], type = h[9], interlace = h[12];
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(type)) throw new Error(`A PNG this decoder does not read (depth ${depth}, colour type ${type}, interlace ${interlace}).`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  const idat = chunks.filter((c) => c.type === 'IDAT');
  const all = new Uint8Array(idat.reduce((n, c) => n + c.data.length, 0));
  let at = 0;
  for (const c of idat) { all.set(c.data, at); at += c.data.length; }
  const raw = unzlibSync(all), stride = width * channels, px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, i * channels + channels);
    const [r, g, b, al] = channels === 1 ? [s[0], s[0], s[0], 255] : channels === 2 ? [s[0], s[0], s[0], s[1]] : channels === 3 ? [s[0], s[1], s[2], 255] : s;
    rgba.set([r, g, b, al], i * 4);
  }
  return { width, height, rgba };
}
