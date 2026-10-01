// One trace from a click, start to finish, as the worker (src/chora/ink.worker.js) runs it: the scale to
// read at, the window around the click, the tiles it needs (asked of `getTiles`, which the page answers),
// the window composed and made ready, the shape proposed; and the window grown when what was traced runs
// to its edge (a line followed to the edge, a fill reaching it), to MAX_WINDOW, then once more at one scale
// coarser, and then, in words, too large. Pure apart from what getTiles does, so it is tested in Node.
import { Image } from '@allmaps/iiif-parser';
import { prepare, traceArea, traceLine, InkError, DEFAULTS } from './index.js';
import { chooseScale, frameAround, grow, tilesFor, compose, scaleFactors, WINDOW, MAX_WINDOW } from './window.js';
import { snapPixels } from './snap.js';

export const TOO_LARGE = 'Too large to trace at once: zoom out, or trace it in parts.';

/** The image's information read as the renderer reads it, or an InkError in words. */
export function imageOf(info) {
  try { return Image.parse(info); } catch (e) {
    throw new InkError(`The map's image server gives the image only whole, not in pieces, so it cannot be traced (${e.message}).`, 'image');
  }
}

/**
 * A window's pixels made ready, kept while the same window and kind are asked for again (a slider moved,
 * a second click on the same part of the map): { key, prep }.
 */
export function createPrepCache() {
  let last = null;
  return {
    get(key, make) { if (last?.key !== key) { last = null; last = { key, prep: make() }; } return last.prep; },
    clear() { last = null; },
  };
}

/**
 * Trace from image pixel `seedImg` of the image `info` (its info.json): `mode` 'area' | 'line', `params`
 * the engine's, `pxPerScreen` image pixels per screen pixel at the view (for the scale and the seed's
 * reach). `getTiles(tiles)` -> [{ region, width, height, data }] for tilesFor's list; `isCurrent()` false
 * once the trace is let go. Returns the proposal (index.js's) with { frame, scale, grown, params }.
 */
export async function runTrace({ info, seedImg, mode, params = {}, pxPerScreen = 1, getTiles, isCurrent = () => true, cache = createPrepCache(), size = WINDOW, max = MAX_WINDOW }) {
  const image = imageOf(info);
  const sfs = scaleFactors(image);
  let s = chooseScale(image, pxPerScreen), coarser = false, grown = 0;
  let frame = frameAround(image, seedImg, s, size);
  const p = { ...(mode === 'area' ? DEFAULTS.area : DEFAULTS.line), ...params };
  // The seed's reach (line mode): six screen pixels, in working pixels.
  if (mode === 'line') p.seedRadius = Math.max(1, (6 * pxPerScreen) / s);
  for (;;) {
    if (!isCurrent()) throw new InkError('Cancelled.', 'cancelled');
    const tiles = tilesFor(image, frame);
    const got = await getTiles(tiles);
    if (!isCurrent()) throw new InkError('Cancelled.', 'cancelled');
    const colour = mode === 'area' || !!p.colour;
    const key = `${frame.x0},${frame.y0},${frame.s},${frame.w},${frame.h},${colour}`;
    const prep = cache.get(key, () => prepare({ w: frame.w, h: frame.h, rgba: compose(frame, got).rgba }, { colour }));
    const seed = [(seedImg[0] - frame.x0) / s, (seedImg[1] - frame.y0) / s];
    let out = null, edge = false, leaked = null;
    try {
      out = mode === 'area' ? traceArea(prep, seed, frame, p) : traceLine(prep, seed, frame, p);
      edge = mode === 'line' && out.reachedEdge;
    } catch (e) {
      if (!(e instanceof InkError && e.kind === 'leak' && e.reason === 'edge')) throw e;
      edge = true; leaked = e;
    }
    if (edge) {
      // At the edge of the window: a larger window; at the largest, once more at one scale coarser; then
      // too large. When the window holds the whole image, its edge is the image's, and that is an answer.
      const bigger = grow(image, frame, max);
      if (bigger) { frame = bigger; grown++; continue; }
      const whole = frame.x0 === 0 && frame.y0 === 0 && frame.w * s >= image.width && frame.h * s >= image.height;
      if (!whole) {
        const next = coarser ? null : sfs.find((f) => f > s);
        if (next) { coarser = true; s = next; if (mode === 'line') p.seedRadius = Math.max(1, (6 * pxPerScreen) / s); frame = frameAround(image, seedImg, s, max); continue; }
        throw new InkError(TOO_LARGE, 'too-large');
      }
      if (leaked) throw leaked;
    }
    return { ...out, frame, scale: s, grown, coarser, params: p };
  }
}

/**
 * The ink's sparse pixels for snapping, over the image pixels `box` [x0, y0, x1, y1] (the view's part of
 * the map), read at the view's scale (coarser if the box would be wider than MAX_WINDOW).
 */
export async function runSnap({ info, box, pxPerScreen = 1, getTiles, isCurrent = () => true, max = MAX_WINDOW }) {
  const image = imageOf(info);
  const sfs = scaleFactors(image);
  const [x0, y0, x1, y1] = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(image.width, box[2]), Math.min(image.height, box[3])];
  if (!(x1 > x0 && y1 > y0)) return { ridges: new Float64Array(0), edges: new Float64Array(0), frame: null };
  let s = chooseScale(image, pxPerScreen);
  while ((x1 - x0) / s > max || (y1 - y0) / s > max) { const next = sfs.find((f) => f > s); if (!next) break; s = next; }
  const frame = frameAround(image, [(x0 + x1) / 2, (y0 + y1) / 2], s, [Math.min(max, Math.ceil((x1 - x0) / s) + 2), Math.min(max, Math.ceil((y1 - y0) / s) + 2)]);
  const got = await getTiles(tilesFor(image, frame));
  if (!isCurrent()) throw new InkError('Cancelled.', 'cancelled');
  const prep = prepare({ w: frame.w, h: frame.h, rgba: compose(frame, got).rgba }, { colour: false });
  return { ...snapPixels(prep, frame), frame };
}
