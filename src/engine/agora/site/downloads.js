// The site's downloads: the whole dataset in three formats, made by the converters the tools use
// for any conversion (run() in pipeline.js), each writing into the site's tree instead of an output
// file of its own. The text formats are gzipped as they are written, so nothing is held whole.
import { gzipped } from '../../../lib/gzip.js';
import { run } from '../../pipeline.js';
import { PARTS, SITE } from '../address.js';

const enc = new TextEncoder();
export const DOWNLOADS = [
  { target: 'plato-jsonl', suffix: SITE.downloads.jsonl, format: 'PLATO JSON Lines, gzipped', mime: 'application/gzip', gzip: true },
  { target: 'ntriples', suffix: SITE.downloads.ntriples, format: 'RDF N-Triples, gzipped', mime: 'application/gzip', gzip: true },
  { target: 'tables', suffix: SITE.downloads.tables, format: 'PLATO spreadsheet tables (CSV files in a zip)', mime: 'application/zip', gzip: false },
];

/**
 * Convert `input` to one download and write it into `tree` as download/<stem><suffix>. Returns
 * { file, path, size, format, ok }: ok is false when the conversion could not read the dataset to
 * the end, which a check that passed makes unlikely but not impossible (a file changed meanwhile).
 */
export async function writeDownload(tree, d, { input, env, options, stem }) {
  const file = stem + d.suffix;
  const path = `${PARTS.download}/${file}`;
  let size = 0, opened = null;
  const output = async () => {
    const f = await tree.file(path);
    opened = f;
    if (!d.gzip) return { write: (s) => { const b = enc.encode(s); size += b.length; f.writeBytes(b); }, writeBytes: (b) => { size += b.length; f.writeBytes(b); }, close: async () => { await f.close(); return { name: path, size }; } };
    // Each write compressed as it comes (piece 0): run()'s writers hand over a megabyte at a time already.
    const gz = gzipped(f, { piece: 0 });
    return {
      write: (s) => gz.write(s),
      writeBytes: (b) => gz.writeBytes(b),
      close: async () => { await gz.close(); size = gz.size; return { name: path, size }; },
    };
  };
  // The typing N-Triples has by default on the page and the command line (node types, typed dates).
  const r = await run({ input, action: 'convert', target: d.target, options: { base: options.base, name: options.name, typing: true, signal: options.signal } }, { ...env, progress: env.progress ? (p) => env.progress({ ...p, phase: `download ${file}: ${p.phase}` }) : undefined, output });
  // A conversion that stops part-way opens its output and never closes it; the tree allows one
  // file open at a time, so close it here, and say the download is incomplete.
  if (r.incomplete && opened) { try { await opened.close(); } catch { /* already closed */ } }
  return { file, path, size, format: d.format, mime: d.mime, ok: !r.incomplete, losses: r.report?.losses || 0 };
}
