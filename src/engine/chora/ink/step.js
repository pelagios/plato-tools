// The pixel work of one trace, as the worker (src/chora/ink.worker.js) does it, apart from the planning
// (job.js, on the page): a window composed from its tiles, made ready (kept while the same window is asked
// for again), and the shape proposed; or the ink's sparse pixels for snapping.
import { prepare, traceArea, traceLine } from './index.js';
import { compose } from './window.js';
import { snapPixels } from './snap.js';

/**
 * A window's pixels made ready, kept while the same window and kind are asked for again (a slider moved,
 * a second click on the same part of the map).
 */
export function createPrepCache() {
  let last = null;
  return {
    get(key, make) { if (last?.key !== key) { last = null; last = { key, prep: make() }; } return last.prep; },
    clear() { last = null; },
  };
}

/** One trace in one window: `tiles` decoded ([{ region, width, height, data }]). The engine's proposal. */
export function traceStep({ frame, tiles, seed, mode, params }, cache = createPrepCache()) {
  const colour = mode === 'area' || !!params.colour;
  const key = `${frame.x0},${frame.y0},${frame.s},${frame.w},${frame.h},${colour}`;
  const prep = cache.get(key, () => prepare({ w: frame.w, h: frame.h, rgba: compose(frame, tiles).rgba }, { colour }));
  return mode === 'area' ? traceArea(prep, seed, frame, params) : traceLine(prep, seed, frame, params);
}

/** The ink's sparse pixels for snapping over one window. */
export function snapStep({ frame, tiles }) {
  return snapPixels(prepare({ w: frame.w, h: frame.h, rgba: compose(frame, tiles).rgba }, { colour: false }), frame);
}

/** A step done here, its tiles from getTiles(list) -> decoded tiles: as job.js wants it (tests; Node). */
export const localSteps = (getTiles, cache = createPrepCache()) => ({
  trace: async ({ tiles, ...rest }) => traceStep({ ...rest, tiles: await getTiles(tiles) }, cache),
  snap: async ({ tiles, ...rest }) => snapStep({ ...rest, tiles: await getTiles(tiles) }),
});
