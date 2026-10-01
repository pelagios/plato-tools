// The jobs of tracing with assistance, sent to its worker (src/chora/ink.worker.js) and answered: one
// generation per channel ('trace', 'snap'), the latest alone current (a new one cancels the older, here and
// in the worker); a worker's need for tiles fetched by the page (`onNeed`) and handed over; a worker that
// fails terminated and its jobs refused in plain words, the next job starting a fresh one. Kept apart from
// ink.js, with the worker made by `makeWorker`, so that it can be tested without a browser.

/** What a job is refused with when its worker fails (its own words are not the user's). */
export const WORKER_FAILED = 'The tracing stopped: its worker failed. Try again.';

/**
 * `makeWorker()` -> a Worker; `onNeed(m, entry, isCurrent)` -> (a promise of) the tiles [{ url, bitmap }] the
 * worker asked for (m.urls), for the map `entry` of the job, or throws (an error with a `kind`);
 * `onStep(timing, kind)` is told of each window's work done or failed.
 */
export function createJobs({ makeWorker, onNeed, onStep = () => {} }) {
  let worker = null;
  const gens = { trace: 0, snap: 0 };
  const pending = new Map();   // `${channel}:${gen}` -> { resolve, reject, entry }
  const counts = new Map();    // id -> { resolve, reject }: the worker asked how many tiles it holds
  let countId = 0;

  function refuseAll(message) {
    for (const j of pending.values()) j.reject(Object.assign(new Error(message), { kind: 'worker' }));
    pending.clear();
    for (const c of counts.values()) c.reject(new Error(message));
    counts.clear();
  }
  function start() {
    if (worker) return worker;
    const w = (worker = makeWorker());
    w.onmessage = async ({ data: m }) => {
      if (w !== worker) return;   // a worker since replaced
      if (m.type === 'count') { counts.get(m.id)?.resolve(m.tiles); counts.delete(m.id); return; }
      const key = `${m.channel}:${m.gen}`, job = pending.get(key);
      if (m.type === 'need') {
        if (!job) return;
        let message, transfer = [];
        try {
          const tiles = await onNeed(m, job.entry, () => gens[m.channel] === m.gen);
          message = { type: 'tiles', channel: m.channel, gen: m.gen, tiles }; transfer = tiles.map((t) => t.bitmap);
        } catch (e) {
          message = { type: 'tile-error', channel: m.channel, gen: m.gen, message: e.message, kind: e.kind || 'other' };
        }
        if (w === worker) w.postMessage(message, transfer);
        else for (const b of transfer) try { b.close?.(); } catch {}
        return;
      }
      if (!job) return;
      pending.delete(key);
      if (m.type === 'result') onStep(m.result.timing, 'ok');
      else if (m.timing) onStep(m.timing, m.kind);
      if (m.type === 'result') job.resolve(m.result); else job.reject(Object.assign(new Error(m.message), { kind: m.kind, reason: m.reason }));
    };
    // A worker that fails is not used again: it is terminated and let go, so that the next job starts a fresh
    // one, and what it had to do is refused in plain words (its own, a script error's, are not the user's).
    w.onerror = (e) => {
      e?.preventDefault?.();
      if (w !== worker) return;
      worker = null;
      try { w.terminate(); } catch {}
      refuseAll(WORKER_FAILED);
    };
    return w;
  }

  return {
    /** A new job on a channel: every older one is let go (a new click, Esc, a permission withdrawn). Its generation. */
    newGen(channel) {
      const gen = ++gens[channel];
      worker?.postMessage({ type: 'cancel', channel, gen });
      for (const [k, j] of pending) if (k.startsWith(`${channel}:`)) { pending.delete(k); j.reject(Object.assign(new Error('Cancelled.'), { kind: 'cancelled' })); }
      return gen;
    },
    /** Whether `gen` is still the latest of its channel. */
    current: (channel, gen) => gens[channel] === gen,
    /** One window's pixel work, in the worker (step.js), for job.js's plan. */
    step: (channel, gen, entry) => (args) => {
      if (gens[channel] !== gen) return Promise.reject(Object.assign(new Error('Cancelled.'), { kind: 'cancelled' }));
      const w = start();
      return new Promise((resolve, reject) => { pending.set(`${channel}:${gen}`, { resolve, reject, entry }); w.postMessage({ type: channel, channel, gen, ...args }); });
    },
    /** A site's permission withdrawn: the worker lets go of its tiles (and any window made ready). */
    forget(origin) { worker?.postMessage({ type: 'forget', origin }); },
    /** How many tiles the worker holds now (0 with no worker: none is started to ask). */
    workerTiles() {
      if (!worker) return Promise.resolve(0);
      const id = ++countId;
      return new Promise((resolve, reject) => { counts.set(id, { resolve, reject }); worker.postMessage({ type: 'count', id }); });
    },
  };
}
