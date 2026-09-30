// SHA-256 of a string, computed at once: the version check (src/engine/compare.js) takes the digest
// of each attestation as the records stream past, where the Web Crypto digest, which answers later,
// cannot be waited for. Checked against Node's own in test/compare.test.js.
const K = [], H0 = [];
// The constants are the fractional parts of the cube roots (and, for the starting state, the square
// roots) of the first primes, as the standard defines them.
for (let n = 2; K.length < 64; n++) {
  let prime = true;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
  if (!prime) continue;
  if (H0.length < 8) H0.push(((Math.sqrt(n) % 1) * 2 ** 32) >>> 0);
  K.push(((Math.cbrt(n) % 1) * 2 ** 32) >>> 0);
}
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
const encoder = new TextEncoder();

/** The SHA-256 digest of `text` (as UTF-8), in hexadecimal. */
export function sha256(text) {
  const bytes = encoder.encode(text), n = bytes.length;
  const padded = new Uint8Array(((n + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[n] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(n / 2 ** 29)); view.setUint32(padded.length - 4, (n << 3) >>> 0);
  const h = Uint32Array.from(H0), w = new Uint32Array(64);
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = w[i - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
  let hex = '';
  for (const x of h) hex += x.toString(16).padStart(8, '0');
  return hex;
}
