// What a PNG made from a map (#37) carries of itself: its resolution (a pHYs chunk, in pixels per metre, from
// the dots per inch chosen) and its words (text chunks: Title, Author, Description, Copyright, Source,
// Software, Creation Time, and the map's settings, from which it can be made again). Each word is a tEXt
// chunk where it can be written in Latin-1, as the PNG standard has tEXt, else an iTXt chunk in UTF-8 (a Greek
// title). Written just after the image's header, where readers look first; an earlier pHYs or text of the same
// keyword is replaced. Read back by readPng. Pure: bytes in, bytes out.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
let TABLE = null;
/** The CRC-32 of bytes, as PNG's chunks carry it. */
export function crc32(bytes, crc = 0xffffffff) {
  TABLE ??= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  for (const b of bytes) crc = TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const readU32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** The chunks of a PNG: [{ type, data }]; an Error for bytes that are not a PNG, or a chunk whose CRC is wrong. */
export function chunksOf(png) {
  const b = png instanceof Uint8Array ? png : new Uint8Array(png);
  if (!SIGNATURE.every((x, i) => b[i] === x)) throw new Error('This is not a PNG: its first bytes are not the PNG signature.');
  const out = [];
  for (let i = 8; i < b.length;) {
    const len = readU32(b, i), type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const data = b.subarray(i + 8, i + 8 + len);
    if (crc32(b.subarray(i + 4, i + 8 + len)) !== readU32(b, i + 8 + len)) throw new Error(`The PNG's ${type} chunk is damaged (its CRC does not match).`);
    out.push({ type, data });
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}
/** A PNG from its chunks. */
export function pngOf(chunks) {
  const parts = [Uint8Array.from(SIGNATURE)];
  for (const { type, data } of chunks) {
    const body = new Uint8Array(4 + data.length);
    body.set(ascii(type), 0); body.set(data, 4);
    parts.push(Uint8Array.from(u32(data.length)), body, Uint8Array.from(u32(crc32(body))));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const latin1 = (s) => [...s].every((c) => c.codePointAt(0) <= 0xff && c !== '\0');
/** A tEXt chunk, or an iTXt one (UTF-8, not compressed) for words that Latin-1 cannot hold. */
function textChunk(keyword, text) {
  if (!/^[\x20-\x7e]{1,79}$/.test(keyword)) throw new TypeError(`"${keyword}" is not a keyword a PNG's text can have.`);
  const t = String(text);
  if (latin1(t)) return { type: 'tEXt', data: Uint8Array.from([...ascii(keyword), 0, ...[...t].map((c) => c.codePointAt(0))]) };
  const utf8 = new TextEncoder().encode(t);
  return { type: 'iTXt', data: Uint8Array.from([...ascii(keyword), 0, 0, 0, 0, 0, ...utf8]) };   // not compressed, no language, no translated keyword
}
const keywordOf = (c) => String.fromCharCode(...c.data.subarray(0, c.data.indexOf(0)));

/**
 * The PNG with its resolution (`dpi`, dots per inch) and its words (`text`: { keyword: words }) written in, just
 * after its header. A pHYs or a text chunk of one of those keywords already there is replaced.
 */
export function withMeta(png, { dpi = null, text = {} } = {}) {
  const chunks = chunksOf(png);
  const keys = new Set(Object.keys(text));
  const kept = chunks.filter((c) => !(dpi && c.type === 'pHYs') && !((c.type === 'tEXt' || c.type === 'iTXt') && keys.has(keywordOf(c))));
  const add = [];
  if (dpi) { const ppm = Math.round(dpi / 0.0254); add.push({ type: 'pHYs', data: Uint8Array.from([...u32(ppm), ...u32(ppm), 1]) }); }
  for (const [k, v] of Object.entries(text)) if (v !== null && v !== undefined && v !== '') add.push(textChunk(k, v));
  return pngOf([kept[0], ...add, ...kept.slice(1)]);
}

/** What a PNG says of itself: { width, height, dpi (null when it says nothing), text: { keyword: words } }. */
export function readPng(png) {
  const chunks = chunksOf(png);
  const h = chunks[0];
  if (h?.type !== 'IHDR') throw new Error('The PNG does not begin with its header (IHDR).');
  const out = { width: readU32(h.data, 0), height: readU32(h.data, 4), dpi: null, text: {} };
  for (const c of chunks) {
    if (c.type === 'pHYs' && c.data[8] === 1) out.dpi = Math.round(readU32(c.data, 0) * 0.0254);
    if (c.type === 'tEXt') { const z = c.data.indexOf(0); out.text[keywordOf(c)] = String.fromCharCode(...c.data.subarray(z + 1)); }
    if (c.type === 'iTXt') {
      const z = c.data.indexOf(0);
      let i = z + 3;                       // compression flag and method
      i = c.data.indexOf(0, i) + 1;        // language tag
      i = c.data.indexOf(0, i) + 1;        // translated keyword
      if (c.data[z + 1] === 0) out.text[keywordOf(c)] = new TextDecoder().decode(c.data.subarray(i));
    }
  }
  return out;
}
