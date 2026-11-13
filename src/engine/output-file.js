// A file a run writes, in the browser's private file storage (OPFS), through a synchronous access handle
// (src/engine/worker.js gives every run its outputs through this).
//
// The write is checked. When the browser's allowance for the page is used up, a write throws
// (QuotaExceededError) or writes fewer bytes than it was given; trusted, as it was until November 2026, the
// output was cut short, the run said "No problems found", and the cut file was what Save gave and what the
// next step took (30,000 rows under a 6 MB allowance: 4.6 MB of 14 MB written). Now the first write not
// made whole ends the run: the part written is removed, and the error (kind 'no-room') is the page's to
// say in plain words (NO_ROOM in words.js) in place of a result, so that a workflow's step is not ticked.
import { NO_ROOM } from './words.js';

/** The error of an output that could not be written whole: `kind` 'no-room', for the page; `cause` the browser's own, if it gave one. */
export function noRoomError(name, cause) {
  return Object.assign(new Error(NO_ROOM), { name: 'NoRoomError', kind: 'no-room', file: name, ...(cause ? { cause } : {}) });
}

/**
 * The output `name` in the folder `dir` (a FileSystemDirectoryHandle), emptied first.
 * Returns { write(string), writeBytes(Uint8Array), close() -> { name, size } }.
 */
export async function output(dir, name) {
  const h = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  h.truncate(0);
  const enc = new TextEncoder();
  let at = 0, failed = null, closed = false;
  // The part written is not kept: closed, then removed (a file with an access handle open cannot be).
  const giveUp = (cause) => {
    failed = noRoomError(name, cause);
    try { h.close(); } catch { /* closed as far as it can be */ }
    closed = true;
    Promise.resolve().then(() => dir.removeEntry(name)).catch(() => { /* none to remove */ });
    return failed;
  };
  const put = (bytes) => {
    if (failed) throw failed;
    let n;
    try { n = h.write(bytes, { at }); } catch (e) { throw giveUp(e); }
    if (n !== bytes.byteLength) throw giveUp();
    at += n;
  };
  return {
    write(s) { put(enc.encode(s)); },
    writeBytes(b) { put(b); },
    async close() {
      if (failed) throw failed;
      if (!closed) {
        closed = true;
        let size;
        try { h.flush(); size = h.getSize(); } catch (e) { throw giveUp(e); }
        // What is on disk is what was written, to the byte: else it is not offered.
        if (size !== at) throw giveUp();
        h.close();
      }
      return { name, size: at };
    },
  };
}
