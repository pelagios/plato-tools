// Krisis: the SHA-256 of a whole file, read as a stream, so that a work file can say which files a
// review was of, and a resumed review can see that they are still the same, at any size. The Web
// Crypto digest needs the whole file in memory at once; src/lib/sha256.js hashes one string. This
// is the same algorithm, fed a chunk at a time. Checked against Node's own in test/krisis.test.js.
const K = new Uint32Array(64), H0 = new Uint32Array(8);
{
  let k = 0, h = 0;
  for (let n = 2; k < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (!prime) continue;
    if (h < 8) H0[h++] = ((Math.sqrt(n) % 1) * 2 ** 32) >>> 0;
    K[k++] = ((Math.cbrt(n) % 1) * 2 ** 32) >>> 0;
  }
}
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export class Sha256 {
  constructor() { this.h = Uint32Array.from(H0); this.w = new Uint32Array(64); this.buf = new Uint8Array(64); this.fill = 0; this.bytes = 0; }
  block(b, at) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++) w[i] = (b[at + i * 4] << 24) | (b[at + i * 4 + 1] << 16) | (b[at + i * 4 + 2] << 8) | b[at + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = w[i - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
    }
    let a = h[0], c1 = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & c1) ^ (a & c) ^ (c1 & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = c1; c1 = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += c1; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
  update(bytes) {
    let i = 0;
    this.bytes += bytes.length;
    if (this.fill) {
      while (this.fill < 64 && i < bytes.length) this.buf[this.fill++] = bytes[i++];
      if (this.fill < 64) return this;
      this.block(this.buf, 0); this.fill = 0;
    }
    for (; i + 64 <= bytes.length; i += 64) this.block(bytes, i);
    while (i < bytes.length) this.buf[this.fill++] = bytes[i++];
    return this;
  }
  hex() {
    const n = this.bytes, tail = new Uint8Array(((this.fill + 9 + 63) >> 6) << 6);
    tail.set(this.buf.subarray(0, this.fill)); tail[this.fill] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(n / 2 ** 29)); view.setUint32(tail.length - 4, (n << 3) >>> 0);
    for (let at = 0; at < tail.length; at += 64) this.block(tail, at);
    let out = '';
    for (const x of this.h) out += x.toString(16).padStart(8, '0');
    return out;
  }
}

/** The SHA-256 of a File or Blob, in hexadecimal, read a chunk at a time. */
export async function fileSha256(file) {
  const h = new Sha256();
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
  }
  return h.hex();
}
