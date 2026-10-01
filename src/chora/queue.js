// The page's commands to the worker, one at a time and in order, since the worker takes them so.
// A command marked `latestOf: <kind>` is sent only if no later one of that kind has been asked for
// meanwhile: of the searches typed while the worker is busy (loading, drawing a place), only the
// latest is run, and a place chosen after them is not kept waiting behind searches nobody will see.
// A command so passed over is never sent, and resolves to null.
// A command may be given as a function that returns it: it is then made when it is sent, after the
// reply to the one before has been dealt with by whoever awaited it (so Next, clicked twice, asks for
// the page after the one the first click showed), and never made at all if it is passed over.
export function serialQueue(send) {
  let queue = Promise.resolve();
  const latest = new Map();
  return function request(msg, { latestOf } = {}) {
    const mine = latestOf === undefined ? 0 : (latest.get(latestOf) || 0) + 1;
    if (latestOf !== undefined) latest.set(latestOf, mine);
    const p = queue.then(() => (latestOf !== undefined && latest.get(latestOf) !== mine ? null : send(typeof msg === 'function' ? msg() : msg)));
    queue = p.catch(() => {});
    return p;
  };
}
