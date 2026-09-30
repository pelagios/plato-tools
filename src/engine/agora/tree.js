// A set of files with paths (a site, a w3id folder), written the way the host can: on the command
// line as a folder of real files (env.folder), in the browser as one zip streamed into a single
// output, since a page cannot write a folder to the user's disk without asking for each file.
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

const enc = new TextEncoder();
// Already compressed, or too small to gain: stored as they are.
const STORE = /\.(zip|gz|png|jpe?g|webp|ico)$/i;

/**
 * Open a tree called `name` (a folder name, or the zip's name without .zip). Returns
 * { file(path) -> { write(s), writeBytes(b), close() }, close() -> { name, size, files } }.
 * Only one file is open at a time: close each before opening the next.
 */
export async function openTree(env, name) {
  if (env.folder) {
    const folder = await env.folder(name);
    let files = 0, size = 0;
    return {
      async file(path) {
        const o = await folder.file(path);
        return { write: (s) => o.write(s), writeBytes: (b) => o.writeBytes(b), close: async () => { const r = await o.close(); files++; size += r.size; return r; } };
      },
      async close() { return { name: name + '/', size, files, path: folder.path }; },
    };
  }
  const out = await env.output(name + '.zip', true);
  let failure = null, files = 0;
  const zip = new Zip((err, chunk) => { if (err) failure = err; else out.writeBytes(chunk); });
  return {
    async file(path) {
      const f = STORE.test(path) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
      zip.add(f);
      return {
        write: (s) => f.push(enc.encode(s)),
        writeBytes: (b) => f.push(b),
        close: async () => { f.push(new Uint8Array(0), true); files++; if (failure) throw failure; return { name: path }; },
      };
    },
    async close() {
      zip.end();
      if (failure) throw failure;
      const r = await out.close();
      return { ...r, files };
    },
  };
}

/** Write a whole small file into a tree in one go. */
export async function put(tree, path, text) {
  const f = await tree.file(path);
  if (typeof text === 'string') f.write(text); else f.writeBytes(text);
  return f.close();
}
