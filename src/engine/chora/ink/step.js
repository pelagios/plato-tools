// The pixel work of one trace, as the worker (src/chora/ink.worker.js) does it, apart from the planning
// (job.js, on the page): a window composed from its tiles, made ready (kept while the same window is asked
// for again), and the shape proposed; or the ink's sparse pixels for snapping.
import { prepare, prepareTiles, traceArea, traceLine } from './index.js';
import { compose } from './window.js';
import { snapPixels } from './snap.js';

/**
 * Windows' pixels made ready, the last `size` kept (one: a slider moved proposes again from the window the
 * last proposal ended in), for the same window and kind asked for again. The one let go is let go before
 * the next is made.
 */
export function createPrepCache(size = 1) {
  let kept = [];   // [{ key, prep }], the most recently used first
  return {
    get(key, make) {
      let hit = kept.find((k) => k.key === key);
      if (hit) kept = [hit, ...kept.filter((k) => k !== hit)];
      else { kept = kept.slice(0, size - 1); hit = { key, prep: make() }; kept.unshift(hit); }
      return hit.prep;
    },
    clear() { kept = []; },
  };
}

/** One trace in one window: `tiles` decoded ([{ region, width, height, data }]). The engine's proposal. */
export function traceStep({ frame, tiles, seed, mode, params }, cache = createPrepCache()) {
  const colour = mode === 'area' || !!params.colour;
  const key = `${frame.x0},${frame.y0},${frame.s},${frame.w},${frame.h},${colour}`;
  const prep = cache.get(key, () => prepareTiles(frame, tiles, { colour }));
  return mode === 'area' ? traceArea(prep, seed, frame, params) : traceLine(prep, seed, frame, params);
}

/** The ink's sparse pixels for snapping over one window. */
export function snapStep({ frame, tiles }) {
  return snapPixels(prepareTiles(frame, tiles, { colour: false }), frame);
}

/** A step done here, its tiles from getTiles(list) -> decoded tiles: as job.js wants it (tests; Node). */
export const localSteps = (getTiles, cache = createPrepCache()) => ({
  trace: async ({ tiles, ...rest }) => traceStep({ ...rest, tiles: await getTiles(tiles) }, cache),
  snap: async ({ tiles, ...rest }) => snapStep({ ...rest, tiles: await getTiles(tiles) }),
});
