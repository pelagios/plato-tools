// The site's downloads: the whole dataset in three formats, made by the converters the tools use
// for any conversion (run() in pipeline.js), each writing into the site's tree instead of an output
// file of its own. The text formats are gzipped as they are written, so nothing is held whole.
import { Gzip } from 'fflate';
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
    const gz = new Gzip({ level: 6, mtime: 0 }, (chunk) => { size += chunk.length; f.writeBytes(chunk); });
    return {
      write: (s) => gz.push(enc.encode(s)),
      writeBytes: (b) => gz.push(b),
      close: async () => { gz.push(new Uint8Array(0), true); await f.close(); return { name: path, size }; },
    };
  };
  // The typing N-Triples has by default on the page and the command line (node types, typed dates).
  const r = await run({ input, action: 'convert', target: d.target, options: { base: options.base, name: options.name, typing: true } }, { ...env, progress: env.progress ? (p) => env.progress({ ...p, phase: `download ${file}: ${p.phase}` }) : undefined, output });
  // A conversion that stops part-way opens its output and never closes it; the tree allows one
  // file open at a time, so close it here, and say the download is incomplete.
  if (r.incomplete && opened) { try { await opened.close(); } catch { /* already closed */ } }
  return { file, path, size, format: d.format, mime: d.mime, ok: !r.incomplete, losses: r.report?.losses || 0 };
}
