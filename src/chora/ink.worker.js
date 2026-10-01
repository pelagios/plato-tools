// Chora's ink-tracing worker: does the pixel work of a trace (src/engine/chora/ink/step.js: a window
// composed from its tiles, made ready, the shape proposed; or the ink's pixels for snapping) away from the
// page, so that the map keeps moving while it works. The page plans (job.js: the scale, the window, its
// tiles, its growth) and sends one window at a time. Started from a blob: that imports it (the permissions
// module's blobWorkerUrl), so that it is under the page's Content Security Policy, as MapLibre's and the
// historical maps' are; it fetches nothing itself: the page fetches every tile through the permissions
// (src/chora/inkfetch.js) and hands over the decoded bitmap, which this worker reads (OffscreenCanvas)
// and keeps for a while, until the page says to let go of a site's ({ type: 'forget', origin }: its
// permission withdrawn).
//
// Messages in: { type: 'trace' | 'snap', channel, gen, frame, tiles, seed, mode, params } a window's work; { type: 'cancel', channel, gen } let go
// of every job of that channel older than gen (a new click, Esc); { type: 'tiles', channel, gen, tiles:
// [{ url, bitmap }] } and { type: 'tile-error', channel, gen, message, kind } the page's answer to a need.
// Messages out: { type: 'need', channel, gen, urls }, { type: 'result', channel, gen, result }, { type:
// 'error', channel, gen, message, kind }. Each channel ('trace', 'snap') runs its latest job alone.
import { traceStep, snapStep, createPrepCache } from '../engine/chora/ink/step.js';

// Tiles kept beyond those a window needs now (at 2048², 16 MB, kept whatever this says).
const TILE_BYTES = 16 * 1024 * 1024;
const tiles = new Map();          // url -> { width, height, data } (RGBA), the most recently used last
let tileBytes = 0;
const latest = { trace: 0, snap: 0 };
const waiting = new Map();        // `${channel}:${gen}` -> { resolve, reject }
const cache = createPrepCache();

function keep(url, t) {
  if (tiles.has(url)) { tileBytes -= tiles.get(url).data.length; tiles.delete(url); }
  tiles.set(url, t); tileBytes += t.data.length;
}
/** Tiles beyond the allowance let go, oldest first, but not those a job is reading now. */
function trim(inUse) {
  for (const [url, t] of tiles) {
    if (tileBytes <= TILE_BYTES) break;
    if (inUse.has(url)) continue;
    tiles.delete(url); tileBytes -= t.data.length;
  }
}
function read(bitmap) {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const out = { width: bitmap.width, height: bitmap.height, data };
  bitmap.close();
  return out;
}

async function job(m) {
  const { channel, gen } = m;
  latest[channel] = Math.max(latest[channel], gen);
  const isCurrent = () => latest[channel] === gen;
  const getTiles = async (list) => {
    const missing = [...new Set(list.map((t) => t.url).filter((u) => !tiles.has(u)))];
    if (missing.length) {
      const got = new Promise((resolve, reject) => waiting.set(`${channel}:${gen}`, { resolve, reject }));
      postMessage({ type: 'need', channel, gen, urls: missing });
      await got;
    }
    const out = list.map((t) => { const d = tiles.get(t.url); if (!d) throw Object.assign(new Error('A tile went missing.'), { kind: 'other' }); return { url: t.url, region: t.region, ...d }; });
    trim(new Set(list.map((t) => t.url)));
    return out;
  };
  let tilesMs = 0;
  try {
    const t0 = Date.now();
    const got = await getTiles(m.tiles);
    tilesMs = Date.now() - t0;
    if (!isCurrent()) return;
    const result = m.type === 'trace' ? traceStep({ frame: m.frame, tiles: got, seed: m.seed, mode: m.mode, params: m.params }, cache) : snapStep({ frame: m.frame, tiles: got });
    if (!isCurrent()) return;
    if (result.timing) result.timing.tilesMs = tilesMs;
    const transfer = m.type === 'snap' ? [result.ridges.buffer, result.edges.buffer] : [];
    postMessage({ type: 'result', channel, gen, result }, transfer);
  } catch (e) {
    if (!isCurrent() && e?.kind === 'cancelled') return;
    postMessage({ type: 'error', channel, gen, message: e?.message || String(e), kind: e?.kind || 'other', reason: e?.reason || null, timing: e?.timing ? { ...e.timing, tilesMs } : null });
  } finally { waiting.delete(`${channel}:${gen}`); }
}

self.onmessage = ({ data: m }) => {
  if (m.type === 'trace' || m.type === 'snap') { job(m); return; }
  if (m.type === 'cancel') {
    latest[m.channel] = Math.max(latest[m.channel], m.gen);
    for (const [k, w] of waiting) if (k.startsWith(`${m.channel}:`) && Number(k.split(':')[1]) < m.gen) w.reject(Object.assign(new Error('Cancelled.'), { kind: 'cancelled' }));
    return;
  }
  if (m.type === 'tiles') {
    const w = waiting.get(`${m.channel}:${m.gen}`);
    for (const t of m.tiles) { if (w) keep(t.url, read(t.bitmap)); else try { t.bitmap.close(); } catch {} }
    w?.resolve();
    return;
  }
  if (m.type === 'forget') {
    // A site's permission withdrawn: its tiles, and any window made ready (it may hold them), are let go.
    for (const [url, t] of tiles) { let o = null; try { o = new URL(url).origin; } catch {} if (o === m.origin) { tiles.delete(url); tileBytes -= t.data.length; } }
    cache.clear();
    return;
  }
  if (m.type === 'tile-error') waiting.get(`${m.channel}:${m.gen}`)?.reject(Object.assign(new Error(m.message), { kind: m.kind }));
};
