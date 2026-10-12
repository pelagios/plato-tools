// SHA-256 of a string, computed at once: the version check (src/engine/compare.js) takes the digest
// of each attestation as the records stream past, where the Web Crypto digest, which answers later,
// cannot be waited for. Agora's addresses, a candidate's id, a region's id, a recipe's digest and
// Hermes's chunks use it too. Checked against Node's own in test/sha256.test.js.
//
// It is called once per attestation, so it allocates nothing per call that it can keep: the text is
// encoded into one buffer that grows to the longest text seen (up to KEEP bytes; a longer one gets a
// buffer of its own), the message schedule is reused, and the state is in locals. The padding after
// the text must be zeroed on every call, since the buffer holds the bytes of an earlier, longer text.
const K = new Int32Array(64), H0 = new Int32Array(8);
// The constants are the fractional parts of the cube roots (and, for the starting state, the square
// roots) of the first primes, as the standard defines them.
for (let n = 2, found = 0; found < 64; n++) {
  let prime = true;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
  if (!prime) continue;
  if (found < 8) H0[found] = ((Math.sqrt(n) % 1) * 2 ** 32) >>> 0;
  K[found++] = ((Math.cbrt(n) % 1) * 2 ** 32) >>> 0;
}
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const hex32 = (x) => HEX[x >>> 24] + HEX[(x >>> 16) & 255] + HEX[(x >>> 8) & 255] + HEX[x & 255];
const encoder = new TextEncoder();
const KEEP = 1 << 20;
const w = new Int32Array(64);
let kept = new Uint8Array(4096);

/**
 * The SHA-256 digest of `text` (as UTF-8), in hexadecimal. `text` must be a string: anything else
 * throws, where the slower version before it hashed what the browser's encoder made of it — so
 * undefined never quietly gets the digest of '' (or of 'undefined'), which for Agora would be an
 * attestation address minted from nothing. The test is here, not left to the encoder: Node's
 * `encodeInto` refuses a number, but the browser's turns it into a string.
 */
export function sha256(text) {
  if (typeof text !== 'string') throw new TypeError(`The digest is of a string, not ${text === null ? 'null' : typeof text}.`);
  // A UTF-16 code unit is at most three bytes of UTF-8; then the 0x80, the length, and a block over.
  const room = text.length * 3 + 72;
  let buf = kept;
  if (room > buf.length) {
    buf = new Uint8Array(room <= KEEP ? Math.min(KEEP, Math.max(room, buf.length * 2)) : room);
    if (buf.length <= KEEP) kept = buf;
  }
  const n = encoder.encodeInto(text, buf).written;
  const total = ((n + 9 + 63) >> 6) << 6;
  buf[n] = 0x80;
  buf.fill(0, n + 1, total - 8);
  const hi = Math.floor(n / 2 ** 29), lo = (n << 3) >>> 0;
  buf[total - 8] = hi >>> 24; buf[total - 7] = hi >>> 16; buf[total - 6] = hi >>> 8; buf[total - 5] = hi;
  buf[total - 4] = lo >>> 24; buf[total - 3] = lo >>> 16; buf[total - 2] = lo >>> 8; buf[total - 1] = lo;

  let h0 = H0[0], h1 = H0[1], h2 = H0[2], h3 = H0[3], h4 = H0[4], h5 = H0[5], h6 = H0[6], h7 = H0[7];
  for (let at = 0; at < total; at += 64) {
    for (let i = 0, j = at; i < 16; i++, j += 4) w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, k = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + k) | 0;
  }
  return hex32(h0) + hex32(h1) + hex32(h2) + hex32(h3) + hex32(h4) + hex32(h5) + hex32(h6) + hex32(h7);
}
