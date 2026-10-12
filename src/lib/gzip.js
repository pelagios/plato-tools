// An output that gzips what is written to it, as it is written, so that nothing is held whole: for a
// conversion's output (options.gzip, --gzip, the page's "Gzip the converted file"), Agora's copy with
// ids (agora/mint.js) and the site's downloads (agora/site/downloads.js). Level 6, and no time in the
// header (mtime 0), so that the same text is the same bytes. One member, whose trailer gives the size
// of the text (modulo 4 GB), which is what the storage estimates read of a gzip (src/engine/chora/
// storage.js, uncompressedSize). Text is gathered into pieces of 64 KB before it is compressed, rather
// than handed over a line at a time: what fflate makes depends on where the pieces end, and on whether
// the last of them comes with the end, so neither is changed here from what each caller made before
// (test/gzip.test.js holds each to its old bytes).
import { Gzip } from 'fflate';

const PIECE = 1 << 16;

/**
 * `out` is an output as a host gives one ({ writeBytes, close }). The result is one too, taking
 * text (write) or bytes (writeBytes); `size` is the bytes written to `out` so far, compressed.
 * `piece` 0 compresses each write as it comes (the site's downloads, whose writes are a megabyte
 * already, gathered by run()'s writers). A run stopped part-way closes `out` itself, never this:
 * the gzip is then cut short, with no trailer, and the host removes it.
 */
export function gzipped(out, { piece = PIECE } = {}) {
  const enc = new TextEncoder();
  let held = '', size = 0;
  const gz = new Gzip({ level: 6, mtime: 0 }, (chunk) => { size += chunk.length; out.writeBytes(chunk); });
  const flush = () => { if (held) { gz.push(enc.encode(held)); held = ''; } };
  return {
    write(s) { held += s; if (held.length >= piece) flush(); },
    writeBytes(b) { flush(); gz.push(b); },
    get size() { return size; },
    async close() { gz.push(enc.encode(held), true); held = ''; return out.close(); },
  };
}
