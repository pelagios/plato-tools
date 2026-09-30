// The page's commands to the worker, one at a time and in order, since the worker takes them so.
// A command marked `latestOf: <kind>` is sent only if no later one of that kind has been asked for
// meanwhile: of the searches typed while the worker is busy (loading, drawing a place), only the
// latest is run, and a place chosen after them is not kept waiting behind searches nobody will see.
// A command so passed over is never sent, and resolves to null.
export function serialQueue(send) {
  let queue = Promise.resolve();
  const latest = new Map();
  return function request(msg, { latestOf } = {}) {
    const mine = latestOf === undefined ? 0 : (latest.get(latestOf) || 0) + 1;
    if (latestOf !== undefined) latest.set(latestOf, mine);
    const p = queue.then(() => (latestOf !== undefined && latest.get(latestOf) !== mine ? null : send(msg)));
    queue = p.catch(() => {});
    return p;
  };
}
