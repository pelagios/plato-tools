// The page's commands to the worker, one at a time and in order, since the worker takes them so.
// A command marked `latestOf: <kind>` is sent only if no later one of that kind has been asked for
// meanwhile: of the searches typed while the worker is busy (loading, drawing a place), only the
// latest is run, and a place chosen after them is not kept waiting behind searches nobody will see.
// A command so passed over is never sent, and resolves to null.
// A command may be given as a function that returns it: it is then made when it is sent, after the
// reply to the one before has been dealt with by whoever awaited it (so Next, clicked twice, asks for
// the page after the one the first click showed), and never made at all if it is passed over. One that
// makes nothing (null), because what it was for has gone by the time it would be sent, is not sent,
// and resolves to null.
import { fold } from '../engine/chora/fold.js';

export function serialQueue(send) {
  let queue = Promise.resolve();
  const latest = new Map();
  return function request(msg, { latestOf } = {}) {
    const mine = latestOf === undefined ? 0 : (latest.get(latestOf) || 0) + 1;
    if (latestOf !== undefined) latest.set(latestOf, mine);
    const p = queue.then(() => {
      if (latestOf !== undefined && latest.get(latestOf) !== mine) return null;
      const m = typeof msg === 'function' ? msg() : msg;
      return m === null ? null : send(m);
    });
    queue = p.catch(() => {});
    return p;
  };
}

// The place list's paging (app.js, search()). `starts` holds where each page so far began (after
// which place), `nextAfter` where the next would. A new query ('first') asks for its first page.
// Next and Previous ask for the page after or before the one shown, for `asked`, the query captured
// when they were clicked; if the box holds another query by the time they would be sent (folded, as
// the search compares), they ask for nothing: that query's own search is on its way, and a page of it
// worked out from the pages of the query before would be another query's page.
export function pageRequest(to, { asked, box, starts, nextAfter }) {
  if (to !== 'first' && fold(String(box).trim()) !== fold(String(asked).trim())) return null;
  const pages = to === 'first' ? [0] : to === 'next' ? (nextAfter === null ? starts : [...starts, nextAfter])
    : to === 'prev' ? (starts.length > 1 ? starts.slice(0, -1) : starts) : starts;
  return { q: asked, pages };
}
/** Whether a reply is the one to show: for the query its request was made for, and that query still in the box. */
export const answers = (reply, sent, box) => fold(String(reply.q ?? '')) === fold(String(sent).trim()) && fold(String(reply.q ?? '')) === fold(String(box).trim());
