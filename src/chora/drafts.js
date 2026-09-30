// Drawings not yet saved, kept on the origin private file system (OPFS) in chora-drafts/, one file
// per dataset, named by a fingerprint of the files it was drawn on (name, size and last change of
// each). Choosing the same files again brings them back; a different file never sees them.
// Each draft: {id, placeId, placeLabel, geojson, role, precision, basemap, zoom, drawnAt}.
const DIR = 'chora-drafts';

/** The fingerprint of a set of input files: name|size|lastModified of each, in order. */
export const fingerprint = (files) => [...files].map((f) => `${f.name}|${f.size}|${f.lastModified}`).join('\n');

// A file name for a fingerprint: short, safe on every file system, the same for the same files.
async function fileName(fp) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fp)));
  return [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('') + '.json';
}
async function dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); }

export async function loadDrafts(fp) {
  try {
    const f = await (await (await dir()).getFileHandle(await fileName(fp))).getFile();
    const d = JSON.parse(await f.text());
    return d.fingerprint === fp && Array.isArray(d.drafts) ? d.drafts : [];
  } catch { return []; }
}
/** Keep `drafts` for these files; an empty list removes the file. Writes are queued, so the last one wins. */
let queue = Promise.resolve();
export function saveDrafts(fp, drafts) {
  queue = queue.then(async () => {
    const d = await dir(), name = await fileName(fp);
    if (!drafts.length) { try { await d.removeEntry(name); } catch {} return; }
    const w = await (await d.getFileHandle(name, { create: true })).createWritable();
    await w.write(JSON.stringify({ fingerprint: fp, drafts }));
    await w.close();
  }).catch((e) => console.warn('Chora: the drawings could not be kept', e));
  return queue;
}
