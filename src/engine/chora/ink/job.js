// One trace from a click, planned: the scale to read at, the window around the click, the tiles it needs
// (as the renderer asks for them); the window grown when what was traced runs to its edge (a line followed
// to the edge, a fill reaching it), to MAX_WINDOW, then once more at one scale coarser, and then, in words,
// too large. The pixel work of each window is `step`'s (step.js: in the worker on the page, here in Node),
// so that the page plans with the image parser it has already (the renderer's), and the worker carries only
// the engine.
import { Image } from '@allmaps/iiif-parser';
import { DEFAULTS, InkError } from './params.js';
import { chooseScale, frameAround, grow, tilesFor, scaleFactors, WINDOW, MAX_WINDOW } from './window.js';

export const TOO_LARGE = 'Too large to trace at once: zoom out, or trace it in parts.';
/** How far inside the last window a new click must be for the trace to begin from that window. */
export const NEAR_EDGE = 32;

/** The image's information read as the renderer reads it, or an InkError in words. */
export function imageOf(info) {
  try { return Image.parse(info); } catch (e) {
    throw new InkError(`The map's image server gives the image only whole, not in pieces, so it cannot be traced (${e.message}).`, 'image');
  }
}

const cancelled = () => new InkError('Cancelled.', 'cancelled');

/**
 * Trace from image pixel `seedImg` of the image `info` (its info.json): `mode` 'area' | 'line', `params`
 * the engine's, `pxPerScreen` image pixels per screen pixel at the view (for the scale and the seed's
 * reach). `step({ frame, tiles, seed, mode, params })` -> the proposal for one window (tiles as tilesFor
 * gives them), or throws (a fill's leak to the window's edge: kind 'leak', reason 'edge'); `isCurrent()`
 * false once the trace is let go; `start`, a window to begin from (the last proposal's, for a slider moved);
 * `near`, the last window read, begun from when the click is well inside it at the same scale.
 * Returns the proposal with { frame, scale, grown, coarser, params }.
 */
export async function runTrace({ info, seedImg, mode, params = {}, pxPerScreen = 1, step, isCurrent = () => true, size = WINDOW, max = MAX_WINDOW, start = null, near = null }) {
  const image = imageOf(info);
  const sfs = scaleFactors(image);
  let s = chooseScale(image, pxPerScreen), coarser = false, grown = 0;
  let frame = frameAround(image, seedImg, s, size);
  // Proposed again from the same click (a slider moved): from the window the last proposal ended in, which
  // the worker has made ready already, rather than growing to it again. A new click inside that window,
  // read at the same scale, begins there too (`near`), at least NEAR_EDGE working pixels from its edge.
  const inside = (f) => f && f.s === s && seedImg[0] >= f.x0 + NEAR_EDGE * s && seedImg[1] >= f.y0 + NEAR_EDGE * s && seedImg[0] < f.x0 + (f.w - NEAR_EDGE) * s && seedImg[1] < f.y0 + (f.h - NEAR_EDGE) * s;
  if (start) { frame = start; coarser = start.s !== s; s = start.s; }
  else if (inside(near) && near.w * near.h > frame.w * frame.h) frame = near;
  const p = { ...(mode === 'area' ? DEFAULTS.area : DEFAULTS.line), ...params };
  // The seed's reach (a line): six screen pixels, in working pixels.
  const reach = () => { if (mode === 'line') p.seedRadius = Math.max(1, (6 * pxPerScreen) / s); };
  reach();
  for (;;) {
    if (!isCurrent()) throw cancelled();
    const seed = [(seedImg[0] - frame.x0) / s, (seedImg[1] - frame.y0) / s];
    let out = null, edge = false, leaked = null;
    try {
      out = await step({ frame, tiles: tilesFor(image, frame), seed, mode, params: p });
      edge = mode === 'line' && out.reachedEdge;
    } catch (e) {
      if (!(e?.kind === 'leak' && e.reason === 'edge')) throw e;
      edge = true; leaked = e;
    }
    if (!isCurrent()) throw cancelled();
    if (edge) {
      // At the edge of the window: a larger window; at the largest, once more at one scale coarser; then
      // too large. When the window holds the whole image, its edge is the image's, and that is an answer.
      const bigger = grow(image, frame, max);
      if (bigger) { frame = bigger; grown++; continue; }
      const whole = frame.x0 === 0 && frame.y0 === 0 && frame.w * s >= image.width && frame.h * s >= image.height;
      if (!whole) {
        const next = coarser ? null : sfs.find((f) => f > s);
        if (next) { coarser = true; s = next; reach(); frame = frameAround(image, seedImg, s, max); continue; }
        throw new InkError(TOO_LARGE, 'too-large');
      }
      if (leaked) throw leaked;
    }
    return { ...out, frame, scale: s, grown, coarser, params: p };
  }
}

/**
 * The ink's sparse pixels for snapping, over the image pixels `box` [x0, y0, x1, y1] (the view's part of
 * the map), read at the view's scale (coarser if the box would be wider than MAX_WINDOW): `step({ frame,
 * tiles })` -> { ridges, edges }.
 */
export async function runSnap({ info, box, pxPerScreen = 1, step, isCurrent = () => true, max = MAX_WINDOW }) {
  const image = imageOf(info);
  const sfs = scaleFactors(image);
  const [x0, y0, x1, y1] = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(image.width, box[2]), Math.min(image.height, box[3])];
  if (!(x1 > x0 && y1 > y0)) return { ridges: new Float64Array(0), edges: new Float64Array(0), frame: null };
  let s = chooseScale(image, pxPerScreen);
  while ((x1 - x0) / s > max || (y1 - y0) / s > max) { const next = sfs.find((f) => f > s); if (!next) break; s = next; }
  const frame = frameAround(image, [(x0 + x1) / 2, (y0 + y1) / 2], s, [Math.min(max, Math.ceil((x1 - x0) / s) + 2), Math.min(max, Math.ceil((y1 - y0) / s) + 2)]);
  const out = await step({ frame, tiles: tilesFor(image, frame) });
  if (!isCurrent()) throw cancelled();
  return { ...out, frame };
}
