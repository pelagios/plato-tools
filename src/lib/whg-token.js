// The World Historical Gazetteer token, for the page: one place that holds it, shared by the tools
// that look places up in WHG (Krisis, Chora). No tool's words or controls are here.
//
// - It is kept in this tab only: sessionStorage, which the browser clears when the tab is closed,
//   with memory as the fallback where storage is refused (a private window, blocked site data).
// - There is no "remember in this browser": plato-tools is served on the shared pelagios.org
//   origin, where anything in localStorage can be read by every page of the site, and moving the
//   tools to an origin of their own is still to be decided. Were it decided, REMEMBER below is the
//   one line to change (to localStorage), and a choice on the page would set it.
// - forget() clears storage and memory both. A token is only truly revoked by regenerating it in
//   WHG: forgetting it here does not stop a copy made elsewhere from working.
// - The token is never logged, never put in an address, in window.__plato, a work file or the words
//   of an error; onChange tells a listener whether there is one, not what it is.
const KEY = 'plato-tools.whg-token';
/** Where the token is kept: this tab only. */
const REMEMBER = () => globalThis.sessionStorage;
// Every store a token may have been kept in, all cleared by forget().
const STORES = () => [globalThis.sessionStorage, globalThis.localStorage];

let memory = null;
const listeners = new Set();

/** The token, or null when there is none. */
export function get() {
  try { const t = REMEMBER()?.getItem(KEY); if (t) return t; } catch { /* storage refused: memory only */ }
  return memory;
}

/** Keep a token (surrounding spaces trimmed); an empty one is the same as forget(). */
export function set(token) {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t) return forget();
  memory = t;
  try { REMEMBER()?.setItem(KEY, t); } catch { /* storage refused: memory only */ }
  notify();
}

/** Forget the token: storage and memory. */
export function forget() {
  memory = null;
  for (const s of (() => { try { return STORES(); } catch { return []; } })()) {
    try { s?.removeItem(KEY); } catch { /* storage refused: nothing kept there */ }
  }
  notify();
}

/** Call fn(hasToken) whenever the token is set or forgotten. Returns a function that stops it. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  const has = get() !== null;
  for (const fn of listeners) { try { fn(has); } catch { /* one listener's fault is not another's */ } }
}
