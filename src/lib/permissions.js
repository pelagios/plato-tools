// The toolbox's permissions: one module through which every request to another site goes, and one
// panel (src/lib/permissions-panel.js) where they are all seen and changed. The pure core
// (permissions-core.js: CATEGORIES, REGISTRY, parse, originsFor, check, …) is re-exported here, and is
// what the command line uses; nothing below touches a page or storage until it is called.
//
// Kept in this browser (localStorage, which every page of pelagios.org can read: the panel says so):
// - 'plato-tools.permissions': {version: 1, grants: {'cat:subj': {state, at, added?}}}, every
//   permission decided, remembered until forgotten; a site typed by the user is marked `added`;
// - 'plato-tools.permissions.tab' (sessionStorage): the keys allowed for this tab only;
// - 'plato-tools.keep-working-data': 'no' when the user does not want working data kept;
// - 'plato-tools.whg-token' (sessionStorage, and localStorage only when the user chose to remember
//   it), with 'plato-tools.whg-token.remember'.
// Tabs are kept in step through the storage event.
//
// The page's Content Security Policy is written from the same grants at load (csp-head.js), so a
// permission allowed now takes effect from the next load; one withdrawn is refused at once, here.
import * as core from './permissions-core.js';
import { canary as runCanary, inPolicy } from './csp.js';
import { nameOf, REFUSED, NEEDS, REMEMBERED } from './permission-words.js';
import { openPanel, refreshPanel } from './permissions-panel.js';

export { CATEGORIES, REGISTRY, STATES, ORIGIN, isOrigin, originOf, keyOf, parse, originsFor, normalise, check, allowedOrigins, policyFor, migrateBasemapConsent, fromFlags } from './permissions-core.js';
export { inPolicy, policy, blobWorkerUrl } from './csp.js';
export { nameOf };

const KEY = 'plato-tools.permissions', TAB = 'plato-tools.permissions.tab', LEGACY = 'chora-basemap-consent';
const KEEP = 'plato-tools.keep-working-data';
const TOKEN = 'plato-tools.whg-token', TOKEN_REMEMBER = 'plato-tools.whg-token.remember';

const local = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const session = () => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };
function readJson(store, key) { try { return JSON.parse(store?.getItem(key) ?? 'null'); } catch { return null; } }
function put(store, key, value) { try { store?.setItem(key, value); return true; } catch { return false; } }
function drop(store, key) { try { store?.removeItem(key); } catch { /* nothing kept there */ } }

// ---- What is decided -----------------------------------------------------------------------------
// What is kept is read again only when its text has changed: transformRequest asks at every tile.
const cache = { grantsRaw: undefined, grants: {}, tabRaw: undefined, tab: [] };
const rawOf = (store, key) => { try { return store?.getItem(key) ?? null; } catch { return null; } };
let migrated = false;
/**
 * Carry Chora's old basemap consents over ('chora-basemap-consent', a list of sites), and let the old
 * key go. Done once per load (the head script has done it already, before the page asked anything),
 * never on the way to a request; exported for tests.
 */
export function migrate() {
  migrated = true;
  const st = local();
  if (rawOf(st, LEGACY) === null) return;
  const g = core.normalise(core.migrateBasemapConsent(core.normalise(readJson(st, KEY)?.grants), readJson(st, LEGACY)));
  if (put(st, KEY, JSON.stringify({ version: 1, grants: g }))) drop(st, LEGACY);
}
/** Every permission decided and remembered, cleaned (core.normalise). A copy: the cache is not the caller's. */
function grants() {
  if (!migrated) migrate();
  const raw = rawOf(local(), KEY);
  if (raw !== cache.grantsRaw) {
    let parsed = null;
    try { parsed = JSON.parse(raw ?? 'null'); } catch { parsed = null; }
    cache.grants = core.normalise(parsed?.grants); cache.grantsRaw = raw;
  }
  return { ...cache.grants };
}
const writeGrants = (g) => put(local(), KEY, JSON.stringify({ version: 1, grants: g }));
function tab() {
  const raw = rawOf(session(), TAB);
  if (raw !== cache.tabRaw) {
    let t = null;
    try { t = JSON.parse(raw ?? 'null'); } catch { t = null; }
    cache.tab = Array.isArray(t) ? t.filter((k) => typeof k === 'string' && core.parse(k)) : []; cache.tabRaw = raw;
  }
  return [...cache.tab];
}
const writeTab = (t) => put(session(), TAB, JSON.stringify([...new Set(t)]));

function need(cat, subj) {
  const p = core.parse(cat, subj);
  if (!p) throw new TypeError(`${JSON.stringify(cat)}, ${JSON.stringify(subj)} is not a permission: a category (${Object.keys(core.CATEGORIES).join(', ')}) and a known service or a site such as https://example.org`);
  return p;
}

/** A permission's state: 'allowed', 'never' or 'undecided'. Never beats "allow for this tab". */
export function state(cat, subj) { return core.check(grants(), cat, subj, tab()); }
/** Whether the tools may ask it now: allowed, and every site of it in this load's policy. */
export function allowed(cat, subj) { return state(cat, subj) === 'allowed' && core.originsFor(cat, subj).every(inPolicy); }
/** Allowed, but since this page loaded: it can be used once the page is reloaded. */
export function waitsForReload(cat, subj) { return state(cat, subj) === 'allowed' && !core.originsFor(cat, subj).every(inPolicy); }

/**
 * Decide a permission: 'allowed' or 'never', remembered in this browser, or 'undecided' (forgotten).
 * `added`: the user typed this site (a pasted basemap's), so the panel says so, with the date.
 */
export function set(cat, subj, to, { added } = {}) {
  const p = need(cat, subj), k = core.keyOf(p.cat, p.subj);
  if (![...core.STATES, 'undecided'].includes(to)) throw new TypeError(`${to} is not a state (allowed, never or undecided)`);
  const g = grants(), before = g[k];
  if (to === 'undecided') delete g[k];
  else g[k] = { state: to, at: new Date().toISOString(), ...((added || before?.added || needed.get(k)?.added) ? { added: true } : {}) };
  writeGrants(g);
  if (to !== 'allowed') writeTab(tab().filter((x) => x !== k));
  notify();
}
/** Allow for this tab only (it ends when the tab is closed). A permission set to Never stays refused. */
export function allowOnce(cat, subj) {
  const p = need(cat, subj);
  writeTab([...tab(), core.keyOf(p.cat, p.subj)]);
  notify();
}
/** Forget one permission (remembered and for this tab): it is undecided again. */
export function forget(cat, subj) {
  const p = need(cat, subj), k = core.keyOf(p.cat, p.subj), g = grants();
  delete g[k]; writeGrants(g);
  writeTab(tab().filter((x) => x !== k));
  notify();
}
/** Forget every permission. */
export function forgetAll() {
  drop(local(), KEY); drop(local(), LEGACY); drop(session(), TAB);
  notify();
}

// Permissions a page is waiting on (needs()), listed in the panel even while undecided.
const needed = new Map();

/**
 * Every permission there is something to say about: every known service, everything decided (a
 * forged entry too, if it is a permission at all: what is kept is shown), and what a page is waiting
 * on. Each: {key, cat, subj, name, origins, state, scope ('remembered' | 'tab' | null), added, at,
 * reload (allowed, but not yet in this load's policy)}. Never the token.
 */
export function list() {
  const g = grants(), t = tab(), keys = new Set();
  for (const cat of Object.keys(core.REGISTRY)) for (const id of Object.keys(core.REGISTRY[cat])) keys.add(core.keyOf(cat, id));
  for (const k of [...Object.keys(g), ...t, ...needed.keys()]) if (core.parse(k)) keys.add(k);
  const cats = Object.keys(core.CATEGORIES);
  return [...keys].map((k) => {
    const { cat, subj } = core.parse(k), st = core.check(g, cat, subj, t), origins = core.originsFor(cat, subj);
    return { key: k, cat, subj, name: needed.get(k)?.name || nameOf(cat, subj), origins, state: st,
      scope: g[k] ? 'remembered' : (st === 'allowed' ? 'tab' : null), added: !!g[k]?.added, at: g[k]?.at || null,
      reload: st === 'allowed' && !origins.every(inPolicy) };
  }).sort((a, b) => cats.indexOf(a.cat) - cats.indexOf(b.cat) || a.name.localeCompare(b.name, 'en-GB'));
}

// ---- Telling the page ----------------------------------------------------------------------------
const listeners = new Set();
let listening = false;
function notify() {
  for (const fn of listeners) { try { fn(); } catch (e) { console.warn('Permissions: a listener failed', e); } }
  renderLines();
  refreshPanel(api);
}
// Another tab's change arrives as a storage event (never for the tab that made it).
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('storage', (e) => {
    if (e.key !== null && ![KEY, LEGACY, KEEP, TOKEN, TOKEN_REMEMBER, ...Object.keys(REMEMBERED)].includes(e.key)) return;
    if (e.key === TOKEN || e.key === TOKEN_REMEMBER || e.key === null) tokenNotify();
    notify();
  });
}
/** Call fn() whenever anything here changes, in this tab or another. Returns a function that stops it. */
export function onChange(fn) {
  listeners.add(fn);
  listen();
  return () => listeners.delete(fn);
}

// ---- Asking another site -------------------------------------------------------------------------
/** Why a request was not made. kind: address | undecided | never | reload | unprotected | moved | network. */
export class PermissionError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'PermissionError'; this.kind = kind; Object.assign(this, extra); }
}

// The canary's verdict (csp.js): null until it has answered.
let canaryResult = null, canaryPromise = null;
let doFetch = (...a) => globalThis.fetch(...a);
let enforcedFn = null;
/** Whether the policy was shown to be enforced (the canary), awaited once. */
export function enforced() {
  if (enforcedFn) return Promise.resolve(enforcedFn()).then((ok) => { canaryResult = { enforced: !!ok }; return !!ok; });
  canaryPromise ??= runCanary().then((r) => { canaryResult = r; return r; });
  return canaryPromise.then((r) => r.enforced);
}
/** The canary's answer so far: null while it runs, else {enforced, why?, directive?}. */
export const canaryState = () => canaryResult;
/** For tests and for hosts without a page: the fetch to use, and what says the policy is enforced. */
export function configure({ fetch: f, enforced: e } = {}) {
  if (f) doFetch = f;
  if (e) enforcedFn = e;
}

/**
 * fetch(), for a request to another site under the permission (cat, subj): only to that permission's
 * sites, only once it is allowed and in this load's policy, only where the policy was shown to be
 * enforced, never with credentials (cookies), and never following a redirect: a server that answers
 * with one is refused ('moved'), whichever site it points to, since the page cannot see where to.
 * Throws PermissionError, whose message names the site and never the address. (Tiles are fetched by
 * MapLibre, through transformRequest, and the policy checks each hop of their redirects.)
 */
export async function fetch(url, { cat, subj, ...init } = {}) {
  const p = core.parse(cat, subj), origin = core.originOf(url);
  const sites = p ? core.originsFor(p.cat, p.subj) : [];
  const name = p ? nameOf(p.cat, p.subj) : String(subj);
  if (!origin || !sites.includes(origin)) throw new PermissionError('address', REFUSED.address(origin), { cat, subj, origin });
  const st = state(p.cat, p.subj);
  if (st === 'never') throw new PermissionError('never', REFUSED.never(name), { cat, subj, origin });
  if (st !== 'allowed') throw new PermissionError('undecided', REFUSED.undecided(name), { cat, subj, origin });
  if (!inPolicy(origin)) throw new PermissionError('reload', REFUSED.reload(name), { cat, subj, origin });
  if (!(await enforced())) throw new PermissionError('unprotected', REFUSED.unprotected(), { cat, subj, origin });
  let r;
  try { r = await doFetch(url, { ...init, credentials: 'omit', redirect: 'manual' }); } catch {
    throw new PermissionError('network', REFUSED.network(origin), { cat, subj, origin });
  }
  if (r?.type === 'opaqueredirect' || (r?.status >= 300 && r?.status < 400)) throw new PermissionError('moved', REFUSED.redirect(origin), { cat, subj, origin });
  const landed = core.originOf(r?.url || url);
  if (landed && !sites.includes(landed)) throw new PermissionError('moved', REFUSED.moved(origin, landed), { cat, subj, origin, landed });
  return r;
}

/**
 * MapLibre's transformRequest: `subjects()` gives the permissions the map is using now ([cat, subj]
 * pairs). Lets through this site, data: and blob:, and the sites of those that are allowed, in this
 * load's policy, and once the policy has been shown to be enforced; refuses anything else, calling
 * onBlocked(origin) and throwing. Checked at every request, so a permission withdrawn stops at once.
 */
export function transformRequest(subjects, { onBlocked } = {}) {
  return (url) => {
    if (/^(data|blob):/i.test(url)) return { url };
    let origin;
    try { origin = new URL(url, location.href).origin; } catch { origin = 'null'; }
    if (origin === location.origin) return { url };
    const ok = canaryResult?.enforced === true && (subjects() || []).some(([c, s]) => core.originsFor(c, s).includes(origin) && allowed(c, s));
    if (ok) return { url };
    onBlocked?.(origin);
    throw new Error(`Refused a request to ${origin}: it is not this site, and not allowed in Permissions.`);
  };
}

// ---- The page ------------------------------------------------------------------------------------
const lines = new Map();   // element -> {cat, subj, name}
/**
 * The one line a feature shows while it waits for a permission, in `el`: "Needs permission: <name>"
 * and a button that opens the panel at that permission; allowed since the page loaded, a line that
 * offers the reload; allowed (or Never: the feature does without, and says nothing), nothing. Kept up
 * to date. `added`: the user typed this site (a pasted basemap's), so that once decided the panel says
 * so, with the date. Returns the state.
 */
export function needs(el, cat, subj, { name, added } = {}) {
  const p = need(cat, subj), k = core.keyOf(p.cat, p.subj), nm = name || nameOf(p.cat, p.subj);
  needed.set(k, { name: nm, added: !!added });
  lines.set(el, { cat: p.cat, subj: p.subj, name: nm });
  renderLine(el);
  listen();
  return state(p.cat, p.subj);
}
/** Stop showing a line in `el` (and empty it). */
export function unneed(el) { lines.delete(el); if (el) el.replaceChildren(); }
function renderLine(el) {
  const l = lines.get(el);
  if (!l) return;
  const st = state(l.cat, l.subj), k = core.keyOf(l.cat, l.subj);
  el.replaceChildren();
  el.dataset.permission = k;
  if (st === 'allowed' && !waitsForReload(l.cat, l.subj)) { el.hidden = true; return; }
  if (st === 'never') { el.hidden = true; return; }
  el.hidden = false;
  el.classList.add('needs-permission');
  const doc = el.ownerDocument, b = doc.createElement('button');
  b.type = 'button';
  if (st === 'allowed') {
    el.append(NEEDS.reload(l.name), ' ');
    b.textContent = 'Reload the page'; b.onclick = () => reload();
  } else {
    el.append(NEEDS.line(l.name), ' — ');
    b.textContent = NEEDS.open; b.className = 'link'; b.onclick = () => open({ focus: k });
  }
  el.append(b);
}
function renderLines() { for (const el of [...lines.keys()]) { if (el.isConnected === false) lines.delete(el); else renderLine(el); } }

/** Open the panel: at its heading, or at one permission's entry (`focus`: its 'cat:subj' key). */
export function open({ focus } = {}) { return openPanel(api, { focus }); }

const reloadHooks = new Set();
/** Call fn() (it may be async) before the page reloads for a permission, to keep what the user has open. */
export function onBeforeReload(fn) { reloadHooks.add(fn); return () => reloadHooks.delete(fn); }
/** Reload the page, so that permissions allowed since it loaded are in its policy. */
export async function reload() {
  for (const fn of reloadHooks) { try { await fn(); } catch (e) { console.warn('Permissions: keeping the page before reloading failed', e); } }
  location.reload();
}

/**
 * Wire the page's header button (#permissions-button: opens the panel, shows how many are allowed)
 * and start the canary. `state` (window.__plato or window.__chora) is given `canary`: 'pending', then
 * 'enforced' or 'not-enforced' (with canaryWhy). Resolves with the canary's answer.
 */
export function mount({ state: pageState } = {}) {
  const button = document.getElementById('permissions-button');
  const count = () => {
    const n = list().filter((x) => x.state === 'allowed').length;
    const c = button?.querySelector('.count');
    if (c) c.textContent = n ? String(n) : '';
    button?.setAttribute('aria-label', `Permissions: ${n ? `${n} allowed` : 'none allowed'}`);
  };
  if (button) { button.onclick = () => open(); count(); onChange(count); }
  if (pageState) pageState.canary = 'pending';
  return enforced().then((ok) => {
    if (pageState) Object.assign(pageState, { canary: ok ? 'enforced' : 'not-enforced', canaryWhy: canaryResult?.why || null });
    refreshPanel(api);
    return canaryResult;
  });
}

// ---- Working data --------------------------------------------------------------------------------
/** Whether the user wants working data kept between visits (the default). */
export const keepWorkingData = () => { try { return local()?.getItem(KEEP) !== 'no'; } catch { return true; } };
export function setKeepWorkingData(on) { if (on) drop(local(), KEEP); else put(local(), KEEP, 'no'); notify(); }

// ---- Remembered in this browser ------------------------------------------------------------------
/**
 * What else is remembered here (REMEMBERED's keys that hold something): [{key, label, value}], where
 * value is only what the panel shows: a person's {name, orcid}, or for pasted basemaps
 * {basemaps: [{host, key}]}, `key` saying that the address carries something that may be a key (a
 * query, or a user name). Never an address itself.
 */
export function remembered() {
  const out = [];
  for (const key of Object.keys(REMEMBERED)) {
    const v = readJson(local(), key);
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    let value = null;
    if (key === 'chora-basemaps' && Array.isArray(v)) {
      value = { basemaps: v.map((b) => {
        try { const u = new URL(String(b?.url || b?.tiles || '').replace(/[{}]/g, '_')); return { host: u.host, key: !!(u.search || u.username || u.password) }; } catch { return { host: '', key: false }; }
      }) };
    } else if (v && typeof v === 'object' && typeof v.name === 'string') value = { name: v.name, ...(typeof v.orcid === 'string' ? { orcid: v.orcid } : {}) };
    out.push({ key, label: REMEMBERED[key].label, value });
  }
  return out;
}
/** Forget one of them. */
export function forgetRemembered(key) { if (Object.hasOwn(REMEMBERED, key)) { drop(local(), key); notify(); } }

// ---- The World Historical Gazetteer token --------------------------------------------------------
// One keeper for the tools that look places up in WHG. Kept for this tab (sessionStorage, memory where
// storage is refused) unless the user chose "Remember my token in this browser", when it is kept in
// localStorage too, where any Pelagios site on this computer could read it (the panel says so). Never
// logged, put in an address, in list(), in window.__plato or in an error; onChange says whether there
// is one, not what it is. Forgetting it here does not revoke it: only regenerating it in WHG does.
let memory = null;
const tokenListeners = new Set();
function tokenNotify() { const has = token.get() !== null; for (const fn of tokenListeners) { try { fn(has); } catch { /* one listener's fault is not another's */ } } }
export const token = {
  /** The token, or null. */
  get() {
    try { const t = session()?.getItem(TOKEN); if (t) return t; } catch { /* storage refused */ }
    if (token.remembered()) { try { const t = local()?.getItem(TOKEN); if (t) return t; } catch { /* storage refused */ } }
    return memory;
  },
  /** Keep a token (trimmed); an empty one is forget(). */
  set(t) {
    const v = typeof t === 'string' ? t.trim() : '';
    if (!v) return token.forget();
    memory = v;
    put(session(), TOKEN, v);
    if (token.remembered()) put(local(), TOKEN, v);
    tokenNotify(); notify();
  },
  /** Forget it, everywhere it was kept. */
  forget() {
    memory = null;
    drop(session(), TOKEN); drop(local(), TOKEN);
    tokenNotify(); notify();
  },
  /** Call fn(hasToken) on every change, in this tab or another. Returns a function that stops it. */
  onChange(fn) { tokenListeners.add(fn); listen(); return () => tokenListeners.delete(fn); },
  /** Whether the user chose to remember it in this browser (default: no). */
  remembered() { try { return local()?.getItem(TOKEN_REMEMBER) === 'yes'; } catch { return false; } },
  /** Choose: remembered in this browser, or for this tab only (the copy kept in the browser is removed). */
  remember(on) {
    const t = token.get();
    if (on) { put(local(), TOKEN_REMEMBER, 'yes'); if (t) put(local(), TOKEN, t); } else { drop(local(), TOKEN_REMEMBER); drop(local(), TOKEN); }
    notify();
  },
};

// What the panel is given: the module's own functions, so that it has no import of its own here.
const api = { list, state, set, allowOnce, forget, forgetAll, token, keepWorkingData, setKeepWorkingData, remembered, forgetRemembered,
  reload, canaryState: () => canaryResult, waitsForReload };
