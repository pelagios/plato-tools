// Scope on the main page (Issue #33, points 2 and 8; Stephen's decisions of 12 October 2026). What every
// WHG lookup is confined to: Where (countries, a WHG place used as a container, or an area drawn on a
// map), What (AAT place types), When (years) and Sources (WHG's namespaces). The pure parts are
// src/engine/krisis/scope.js; its words are words.js SCOPE_WORDS.
//
// Whose Scope. In a workflow, the workflow's: kept in its record (src/methodos/page.js, setScope), saved
// with it, taken up with it after a reload, downloaded with it, and gone when it is left. Outside a
// workflow, the lookup panel uses this tab's own Scope, kept in sessionStorage for the tab alone: the
// simplest honest design, since a Scope outlasting the tab with no workflow to belong to would confine
// lookups the user no longer remembers asking for. A workflow begun while the tab has one offers to take it
// in (never silently). Every Scope read, from either, goes through normaliseScope, as storage may hold what
// another page of the origin wrote.
//
// Where it is shown. In the tracker, while a workflow is followed, as one line after its buttons
// (div#scope: "Scope: GB, IE · Villages · 1500 to 1600 · gn ⚠", with Edit), which opens to the chips; and
// in the lookup panel (#lookup-scope) always, as chips. Editing opens in the centre column
// (section#scope-editor), since the area drawn needs the width; the rest of the centre is hidden meanwhile
// (body.scope-editing), and Done puts the focus back on the control that opened it.
//
// Each change redraws the editor from the Scope just made, and gives the focus back to the control that
// had it (every control has a stable id), with the scroll where it was: arrows through the Where, Space on
// a box, Tab out of a year all keep their place. What the editor says as it works (asking WHG, a drawing
// refused) goes to one live region, #scope-live.
//
// Nothing is asked of another site but through the permissions module, under the gazetteer's permission
// ('gazetteer', 'whg'), and only once it is allowed: WHG's tree of AAT place types (/types/tree/, its
// search, and /types/expand/ for a type's narrower ones) and its sources (/api/sources/), all read
// anonymously and cached in this browser for a week; the WHG place used as a container is found through
// the shared WHG lookup (the token's one keeper's token, as every lookup). Without the permission, the
// shortlist of types (with its bundled expansions) and the bundled list of sources still work.
//
// The drawn area's map is Chora's (src/chora/map.js createMap, with its drawing and Terra Draw's check that
// a polygon does not cross itself), on its Natural Earth basemap, served from this site: it is imported only
// when that mode is first opened, so the main page loads no MapLibre until then. The page's policy needs
// nothing more for it (its worker is a blob:, its style, glyphs and tiles 'self').
import * as permissions from './lib/permissions.js';
import { SCOPE_WORDS as SW } from './engine/words.js';
import { normaliseScope, emptyScope, isEmptyScope, excludesUndated, yearsProblem, scopeType, containerId, areaCheck, UNDATED_TAKEN, WHERE_MODES, YEAR_RANGE } from './engine/krisis/scope.js';
import { TYPE_SHORTLIST, BUNDLED_SOURCES, COUNTRY_CODES } from './engine/krisis/scope-data.js';
import { tokenFieldHtml, giveToken, rememberToken, forgetToken, noteInput } from './lib/token-field.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const WHG = 'https://whgazetteer.org';
const TAB_KEY = 'plato-tools.scope';
const CACHE_KEY = 'plato-tools.whg-cache.';
const CACHE_DAYS = 7, CACHE_MAX = 60;
const allowed = () => permissions.allowed('gazetteer', 'whg');

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k in e && k !== 'list') e[k] = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}

let regionName = (c) => c;
try { const d = new Intl.DisplayNames(['en-GB'], { type: 'region' }); regionName = (c) => { try { return d.of(c) || c; } catch { return c; } }; } catch { /* the codes alone */ }
/** A country's name, with its code: "United Kingdom (GB)". */
const countryLabel = (c) => { const n = regionName(c); return n && n !== c ? `${n} (${c})` : c; };
const COUNTRIES = COUNTRY_CODES.map((c) => ({ code: c, name: regionName(c) })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
const today = () => new Date().toISOString().slice(0, 10);

// ---- WHG's anonymous answers, cached ---------------------------------------------------------------------
/** A kept answer that may be used: read, of the shape asked for, not from the future, and younger than a week. */
function keptAnswer(key, ok) {
  try {
    const kept = JSON.parse(localStorage.getItem(key));
    const now = Date.now();
    if (kept && typeof kept.at === 'number' && kept.at <= now && now - kept.at < CACHE_DAYS * 864e5 && ok(kept.v)) return kept;
  } catch { /* not kept, or not readable */ }
  return null;
}
/**
 * Let go of what is kept and may not be used (unreadable, stale, or dated in the future, which would never
 * expire), and of all but the newest CACHE_MAX answers (each search string is an answer of its own).
 */
function pruneCache() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(CACHE_KEY)) keys.push(k); }
    const live = [];
    for (const k of keys) { const kept = keptAnswer(k, () => true); if (kept) live.push([k, kept.at]); else localStorage.removeItem(k); }
    live.sort((a, b) => b[1] - a[1]).slice(CACHE_MAX).forEach(([k]) => localStorage.removeItem(k));
  } catch { /* storage refused: nothing kept */ }
}
/**
 * One of WHG's anonymous answers, through the permissions module: { v, cached, at } (at: the day it was had),
 * or null when it cannot be had. Kept in this browser for a week; read back only when it has the shape
 * asked for (`ok`). `keep` makes what is kept (and given) from the answer: the part needed, where the whole
 * would be larger than it is worth keeping; what is kept must still pass `ok`.
 */
async function whgGet(path, ok, keep = (v) => v) {
  const key = CACHE_KEY + path;
  const kept = keptAnswer(key, ok);
  if (kept) return { v: kept.v, cached: true, at: new Date(kept.at).toISOString().slice(0, 10) };
  if (!allowed()) return null;
  try {
    const r = await permissions.fetch(WHG + path, { cat: 'gazetteer', subj: 'whg' });
    if (!r.ok) return null;
    const got = await r.json();
    const v = ok(got) ? keep(got) : null;
    if (v === null || !ok(v)) return null;
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), v })); } catch { /* not kept: asked again next time */ }
    return { v, cached: false, at: today() };
  } catch { return null; }
}
const isNodes = (v) => Array.isArray(v) && v.every((n) => n && typeof n.text === 'string' && (typeof n.aat_id === 'number' || /^aat:\d+$/.test(n.id)));
const isFound = (v) => Array.isArray(v) && v.every((n) => n && typeof n.text === 'string' && typeof n.aat_id === 'number');
const isExpanded = (v) => !!v && Array.isArray(v.ids) && v.ids.every((x) => typeof x === 'string' && /^aat:\d+$/.test(x));
const isSources = (v) => !!v && Array.isArray(v.sources) && v.sources.every((s) => s && typeof s.namespace === 'string');
const aatOf = (n) => (typeof n.aat_id === 'number' ? `aat:${n.aat_id}` : n.id);
const isVocab = (v) => !!v && !!v.byId && typeof v.byId === 'object' && Object.entries(v.byId).every(([k, x]) => /^aat:\d+$/.test(k) && x && typeof x.label === 'string');

/**
 * The labels of AAT place types, for the kind of place a review shows for each candidate (Issue #20): WHG's
 * flat map, GET /types/vocab/ ({ byId: { "aat:<id>": { label, desc } } }, 1,084 concepts on 12 October 2026),
 * asked for as Scope asks WHG anything (anonymously, through the permissions module, only once it is
 * allowed) and kept in this browser for a week, the labels alone (the descriptions are most of its 268 KB).
 * Until it comes, or without the permission, the labels Scope bundles for its shortlist. Resolves to
 * { labels: Map(id → label), from: 'whg' | 'cache' | 'bundled', at }; asked once a page.
 */
let vocabAsked = null;
export const BUNDLED_AAT_LABELS = new Map(TYPE_SHORTLIST.map((t) => [t.id, t.aat]));
export function aatLabels() {
  if (vocabAsked) return vocabAsked;
  const shrink = (v) => ({ byId: Object.fromEntries(Object.entries(v.byId).map(([k, x]) => [k, { label: x.label }])) });
  vocabAsked = whgGet('/types/vocab/', isVocab, shrink).then((got) => (got
    ? { labels: new Map(Object.entries(got.v.byId).map(([k, x]) => [k, x.label])), from: got.cached ? 'cache' : 'whg', at: got.at }
    : { labels: BUNDLED_AAT_LABELS, from: 'bundled', at: null }));
  // Not had (no permission yet, or WHG not answering): asked again next time, rather than for ever bundled.
  vocabAsked.then((r) => { if (r.from === 'bundled') vocabAsked = null; });
  return vocabAsked;
}

/**
 * Mount Scope. `methodos` is Methodos's page (scope(), setScope(s), scoped(), following(), id()); `lookup()`
 * the shared WHG lookup; `token` the token's keeper; `onChange()` is told when the Scope changes (the
 * lookup's preview is drawn again); `state` is window.__plato, on which `scope` is published for the browser checks.
 */
export function mountScope({ methodos, lookup, token, onChange, state }) {
  const $ = (id) => document.getElementById(id);
  const line = $('scope'), editor = $('scope-editor'), panel = $('lookup-scope');
  let returnTo = null, openedFrom = null, mapApi = null, mapState = { phase: 'none' }, treeOpen = false, typeSay = '', placeFound = null, placeSay = '', areaSay = '';
  let sources = null, sourcesFrom = 'bundled';
  const offered = new Set();   // the workflows offered the tab's Scope already (answered either way)
  // One live region for what the editor says as it works; it is kept across redraws.
  const live = h('p', { id: 'scope-live', className: 'visually-hidden', 'aria-live': 'polite' });
  const say = (text) => { live.textContent = text || ''; };
  pruneCache();

  const inWorkflow = () => !!methodos.scoped?.();
  function tabScope() { try { return normaliseScope(JSON.parse(sessionStorage.getItem(TAB_KEY))); } catch { return emptyScope(); } }
  /** The Scope in force: the workflow's, or this tab's. */
  const current = () => (inWorkflow() ? normaliseScope(methodos.scope()) : tabScope());
  function save(s) {
    const n = normaliseScope(s);
    if (inWorkflow()) methodos.setScope(isEmptyScope(n) ? null : n);
    else { try { if (isEmptyScope(n)) sessionStorage.removeItem(TAB_KEY); else sessionStorage.setItem(TAB_KEY, JSON.stringify(n)); } catch { /* the tab refuses storage: not kept */ } }
    show(n);
    onChange?.();
  }
  const change = (fn) => { const s = current(); fn(s); remember(s.where); save(s); if (editing()) drawEditor(); };
  const editing = () => !editor.hidden;

  // ---- the summary: the tracker's line, and the lookup panel's chips ------------------------------------
  const sourceName = (ns) => (ns === 'whg' ? SW.sources.whg : (sources || BUNDLED_SOURCES).find((x) => x.namespace === ns)?.name || ns);
  const names = { country: countryLabel, source: (ns) => `${sourceName(ns)} (${ns})` };
  function chipsList(s) {
    const ul = h('ul', { className: 'scope-chips' });
    for (const c of SW.chips(s, names)) ul.append(h('li', { className: 'scope-chip', dataset: { part: c.key } }, h('span', { className: 'scope-chip-key' }, SW.parts[c.key]), ' ', h('span', { className: 'scope-chip-text' }, c.text)));
    return ul;
  }
  const undatedMark = () => h('p', { className: 'scope-undated warn', dataset: { mark: 'undated' } }, h('span', { 'aria-hidden': 'true' }, '⚠ '), SW.undatedMark);
  const editButton = (where, words) => h('button', { type: 'button', className: 'link scope-edit', 'aria-label': SW.editScope, onclick: () => open(where) }, words);
  /** The tracker's line: the Scope in a few words, which opens to its chips; Edit beside it. */
  function trackerLine(s) {
    const ex = excludesUndated(s);
    const more = h('details', { className: 'scope-more' },
      h('summary', { 'data-tip': SW.lineTip(s, names) }, h('span', { className: 'scope-line-text' }, SW.line(s)), ex ? h('span', { className: 'warn', 'aria-label': SW.undatedMark }, ' ⚠') : ''),
      chipsList(s), ex ? undatedMark() : '');
    line.replaceChildren(h('div', { className: 'scope-line-row' }, more, ' ', editButton('#scope .scope-edit', SW.edit)));
    // A workflow begun while this tab had a Scope of its own: offered, once, never taken in silently.
    const tab = tabScope(), key = methodos.id?.() || 'pending';
    if (isEmptyScope(s) && !isEmptyScope(tab) && !offered.has(key)) {
      line.append(h('p', { className: 'scope-offer', id: 'scope-offer' }, SW.offer(SW.line(tab)), ' ',
        h('button', { type: 'button', id: 'scope-offer-yes', onclick: () => { offered.add(key); save(tab); } }, SW.offerYes), ' ',
        h('button', { type: 'button', id: 'scope-offer-no', onclick: () => { offered.add(key); show(); } }, SW.offerNo)));
    }
  }
  function show(s = current()) {
    line.hidden = !methodos.following?.();
    if (!line.hidden) trackerLine(s);
    if (panel) {
      panel.replaceChildren(h('p', { className: 'scope-line' }, h('strong', {}, `${SW.heading}: `), inWorkflow() ? SW.panelWorkflow : SW.panelTab),
        chipsList(s), excludesUndated(s) ? undatedMark() : '', h('p', { className: 'scope-edit-line' }, editButton('#lookup-scope .scope-edit', SW.editScope)));
    }
    publish(s);
  }
  function publish(s = current()) {
    if (state) state.scope = { scope: s, whose: inWorkflow() ? 'workflow' : 'tab', editing: editing(), map: mapState.phase, sources: sourcesFrom,
      chips: SW.chips(s, names).map((c) => `${SW.parts[c.key]}: ${c.text}`), line: SW.line(s), undated: excludesUndated(s) };
  }

  // ---- opening and closing the editor (centre column) ------------------------------------------------
  function open(from) {
    if (!editing()) {
      returnTo = document.activeElement !== document.body ? document.activeElement : null; openedFrom = from || null;
      const w = current().where; modeShown = w.mode; memory = w.mode === 'anywhere' ? {} : { [w.mode]: w };
    }
    editor.hidden = false; document.body.classList.add('scope-editing');
    drawEditor();
    if (!sources) loadSources();
    editor.scrollIntoView({ block: 'start', behavior: 'auto' });
    $('scope-editor-h')?.focus({ preventScroll: true });
    publish();
  }
  function close() {
    editor.hidden = true; document.body.classList.remove('scope-editing');
    publish();
    // Back to the control that opened it: the one that had the focus if it is still there, else the Edit control
    // found again (the line and the panel are drawn afresh on every change), else the step's title.
    const shown = (e) => !!e?.isConnected && !!e.getClientRects().length;
    const back = [returnTo, openedFrom && document.querySelector(openedFrom), document.querySelector('#scope .scope-edit'), document.querySelector('#lookup-scope .scope-edit'),
      !$('workflow-head').hidden ? $('workflow-title') : $('files-h')].find(shown);
    back?.scrollIntoView({ block: 'center', behavior: 'auto' }); back?.focus({ preventScroll: true });
    returnTo = null;
  }

  // ---- the editor --------------------------------------------------------------------------------------
  /** Drawn again from the Scope as it now is; the focus and the scroll are given back where they were. */
  function drawEditor() {
    const s = current();
    const had = editor.contains(document.activeElement) ? document.activeElement.id : null;
    const sx = window.scrollX, sy = window.scrollY;
    const lists = {};
    for (const el of editor.querySelectorAll('[data-keep-scroll]')) lists[el.id] = el.scrollTop;
    const body = h('div', { className: 'scope-body' },
      h('h2', { id: 'scope-editor-h', tabIndex: -1 }, SW.editorHeading),
      h('p', { className: 'scope-whose' }, SW.whose(inWorkflow())),
      h('p', { className: 'note' }, SW.lede),
      whereSet(s), whatSet(s), whenSet(s), sourcesSet(s),
      h('p', { className: 'scope-buttons' },
        h('button', { type: 'button', className: 'primary', id: 'scope-done', onclick: close }, SW.close), ' ',
        h('button', { type: 'button', id: 'scope-clear', onclick: () => { memory = {}; modeShown = 'anywhere'; save(emptyScope()); drawEditor(); } }, SW.clear)));
    // The map, once made, is kept across redraws: its element is moved, not made again (areaPart).
    editor.replaceChildren(body, live);
    for (const [id, top] of Object.entries(lists)) { const el = document.getElementById(id); if (el) el.scrollTop = top; }
    if (had) document.getElementById(had)?.focus({ preventScroll: true });
    window.scrollTo(sx, sy);
    if (modeShown === 'area') { ensureMap(s); mapApi?.map.resize(); }
    publish(s);
  }

  // Where. The mode shown is the Where in force, or one chosen whose value is not given yet (no country ticked,
  // no place chosen, no area drawn). One Where at a time is sent; each mode's last value is remembered while the
  // editor is open, so that choosing it again gives it back.
  let modeShown = 'anywhere', placeName = '', countryFilter = '', memory = {};
  function remember(w) { if (w && w.mode !== 'anywhere') memory[w.mode] = structuredClone(w); }
  function whereSet(s) {
    const fs = h('fieldset', { className: 'scope-where', id: 'scope-where' }, h('legend', {}, SW.where.legend));
    const modes = h('div', { className: 'scope-modes' });
    if (s.where.mode !== 'anywhere') modeShown = s.where.mode;
    for (const m of WHERE_MODES) modes.append(h('label', {}, h('input', { type: 'radio', id: `scope-where-${m}`, name: 'scope-where', value: m, checked: m === modeShown,
      onchange: () => { modeShown = m; change((x) => { x.where = memory[m] ? structuredClone(memory[m]) : { mode: 'anywhere' }; }); } }), ' ', SW.where.modes[m]));
    fs.append(modes);
    if (modeShown === 'countries') fs.append(countriesPart(s));
    if (modeShown === 'place') fs.append(placePart(s));
    if (modeShown === 'area') fs.append(areaPart(s));
    fs.append(h('p', { className: 'note scope-precedence' }, SW.where.precedence));
    return fs;
  }
  function countriesPart(s) {
    const chosen = new Set(s.where.mode === 'countries' ? s.where.countries : []);
    const box = h('div', { className: 'scope-part', id: 'scope-countries' });
    const list = h('ul', { className: 'scope-checklist', id: 'scope-country-list', 'data-keep-scroll': '' });
    const fill = () => {
      const q = countryFilter.trim().toLowerCase();
      list.replaceChildren(...COUNTRIES.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q).map((c) => h('li', {},
        h('label', {}, h('input', { type: 'checkbox', id: `scope-c-${c.code}`, value: c.code, checked: chosen.has(c.code), onchange: (e) => change((x) => {
          const cs = new Set(x.where.mode === 'countries' ? x.where.countries : []);
          if (e.target.checked) cs.add(c.code); else cs.delete(c.code);
          x.where = cs.size ? { mode: 'countries', countries: [...cs] } : { mode: 'anywhere' };
        }) }), ' ', `${c.name} (${c.code})`))));
    };
    const filter = h('input', { type: 'search', id: 'scope-country-filter', value: countryFilter, autocomplete: 'off', oninput: (e) => { countryFilter = e.target.value; fill(); } });
    fill();
    box.append(h('label', { htmlFor: 'scope-country-filter' }, SW.where.countriesFilter), filter,
      h('p', { className: 'scope-chosen' }, chosen.size ? [...chosen].map(countryLabel).join(', ') : SW.where.countriesNone),
      list, h('p', { className: 'note' }, SW.where.countriesNote));
    return box;
  }
  function placePart(s) {
    const box = h('div', { className: 'scope-part', id: 'scope-place' });
    if (s.where.mode === 'place') box.append(h('p', { className: 'scope-chosen' }, SW.where.placeChosen(s.where.place)));
    const q = h('input', { type: 'text', id: 'scope-place-q', autocomplete: 'off', spellcheck: false, value: placeName, oninput: (e) => { placeName = e.target.value; } });
    const need = h('p', { id: 'scope-place-permission', hidden: true });
    const form = h('form', { className: 'scope-place-form', onsubmit: (e) => { e.preventDefault(); placeName = q.value.trim(); findPlace(placeName); } },
      h('label', { htmlFor: 'scope-place-q' }, SW.where.placeLabel), q, ' ', h('button', { type: 'submit', id: 'scope-place-find' }, SW.where.placeFind));
    box.append(form, need, h('p', { className: 'note' }, SW.where.placeNote));
    // WHG answers only a query that carries the token: the shared token field (src/lib/token-field.js), as the
    // lookup panel and Chora show it, in no <form>; only what is typed or pasted is taken, by its one keeper.
    if (!token.get()) {
      const holder = h('div', { className: 'scope-token' });
      holder.innerHTML = tokenFieldHtml(token, 'scope-token', esc);
      box.append(holder);
    }
    if (!allowed()) permissions.needs(need, 'gazetteer', 'whg');
    if (placeSay) box.append(h('p', { className: 'scope-say' }, placeSay));
    if (placeFound?.length) box.append(h('ol', { className: 'scope-found', id: 'scope-place-found' }, ...placeFound.map((c) => h('li', { dataset: { id: c.id } },
      h('strong', {}, c.name), c.description ? ` ${c.description}` : '', ` (${c.id}) `,
      h('button', { type: 'button', id: `scope-use-${c.id}`, onclick: () => { change((x) => { x.where = { mode: 'place', place: { id: c.id, label: c.name, description: c.description || undefined } }; }); placeFound = null; placeSay = ''; drawEditor(); $('scope-place-q')?.focus(); } }, SW.where.placeUse)))));
    return box;
  }
  async function findPlace(name) {
    if (!name) return;
    if (!allowed()) { drawEditor(); return; }
    if (!token.get()) { placeSay = SW.where.placeNeedsToken; say(placeSay); drawEditor(); return; }
    placeSay = SW.where.placeSearching; say(placeSay); placeFound = null; drawEditor();
    try {
      // The region review's search: areas only, as a container must be an outline (whg.js A12).
      const [list] = await lookup().reconcile([{ query: name, type: 'Place', limit: 10, params: { area_only: true } }]);
      // Belt and braces: area_only is live on WHG (whg.js A12), and a candidate is still offered as a container
      // only when it says it has an outline (has_geom true), so that a point can never be chosen.
      placeFound = [...list].filter((c) => c.hasGeom === true).map((c) => ({ id: containerId(c.id), name: c.name || c.id, description: c.description || '' })).filter((c) => c.id);
      placeSay = placeFound.length ? '' : SW.where.placeNone;
      say(placeFound.length ? SW.where.placeFound(placeFound.length) : placeSay);
    } catch (e) { placeFound = null; placeSay = e?.message || String(e); say(placeSay); }
    drawEditor();
    editor.querySelector('#scope-place-found button, #scope-place-q')?.focus();
  }
  function areaPart(s) {
    const box = h('div', { className: 'scope-part', id: 'scope-area' });
    const a = s.where.mode === 'area' ? s.where.area : null;
    box.append(h('p', { className: 'scope-chosen' }, a ? SW.where.areaChosen(a.coordinates[0].length - 1, bboxOf(a)) : SW.where.areaNone),
      h('p', { className: 'note' }, SW.where.areaHow),
      h('p', { className: 'warn', id: 'scope-area-say', hidden: !areaSay }, areaSay),
      h('p', {}, h('button', { type: 'button', id: 'scope-area-draw', onclick: () => { areaSay = ''; mapApi?.setPlace(null); mapApi?.setMode('polygon'); drawEditor(); } }, a ? SW.where.areaRedraw : SW.where.areaDraw)),
      mapState.phase === 'failed' ? h('p', { className: 'warn' }, SW.where.areaFailed(mapState.why)) : mapState.phase === 'loading' ? h('p', {}, SW.where.areaLoading) : '',
      mapApi ? mapApi.box : h('div', { id: 'scope-map', className: 'scope-map' }));
    return box;
  }
  /** A drawing refused, in words: beside the map and in the live region (never silently). */
  function refuse(problem) {
    areaSay = SW.where.areaProblem[problem] || SW.where.areaProblem['not-polygon'];
    const el = $('scope-area-say'); if (el) { el.textContent = areaSay; el.hidden = false; }
    say(areaSay); publish();
  }
  const bboxOf = (a) => { const r = a.coordinates[0]; const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const areaFeature = (a) => ({ type: 'FeatureCollection', features: a ? [{ type: 'Feature', geometry: a, properties: { status: 'asserted' } }] : [] });
  let mapLoading = null;
  /** Chora's map, imported now (never before this mode is opened), on Natural Earth, with its drawing. */
  function ensureMap(s) {
    if (mapApi) { mapApi.setPlace(areaFeature(s.where.area)); return; }
    if (mapLoading) return;
    mapState = { phase: 'loading' }; say(SW.where.areaLoading); publish();
    mapLoading = (async () => {
      try {
        const [{ createMap }, basemaps, { ValidateNotSelfIntersecting }] = await Promise.all([import('./chora/map.js'), import('./chora/basemaps.js'), import('terra-draw')]);
        // Terra Draw's own check: a corner that would make the area cross itself is not taken, and that is said.
        const polygonValidation = (feature, ctx) => {
          const r = ValidateNotSelfIntersecting(feature);
          if (!r.valid && ctx?.updateType !== 'provisional') refuse('self-intersects');
          return r;
        };
        // Made in the element already in the editor, which has its size; moved, never made again, on a redraw.
        const box = editor.querySelector('#scope-map') || h('div', { id: 'scope-map', className: 'scope-map' });
        const api = createMap(box, { state: mapState, onPlaceClick: () => {}, polygonValidation });
        api.box = box;
        api.setStyle(await basemaps.styleFor(basemaps.builtIn().find((b) => b.local)));
        api.onDraw({ finish: (id) => {
          const f = api.draw?.getSnapshot().find((x) => x.id === id);
          // Longitudes brought into [-180, 180] and the ring made counter-clockwise (RFC 7946); anything else wrong is refused in words.
          const { area, problem } = areaCheck(f?.geometry);
          setTimeout(() => { try { api.draw?.clear(); api.setMode(area ? 'static' : 'polygon'); } catch { /* the style changed meanwhile */ } }, 0);
          if (!area) { refuse(problem); return; }
          areaSay = '';
          change((x) => { x.where = { mode: 'area', area }; });
          say(SW.where.areaTaken);
        } });
        // A style's hooks run before the map starts its drawing tool again: the mode is set once it has.
        api.onStyleLoad(() => { const a = current().where; api.setPlace(areaFeature(a.mode === 'area' ? a.area : null)); if (a.mode === 'area') api.fit(bboxOf(a.area), 8); else setTimeout(() => api.setMode('polygon'), 0); });
        mapApi = api; mapState.phase = 'ready'; window.__scope_map = api.map;
        say('');
      } catch (e) { mapState = { phase: 'failed', why: e?.message || String(e) }; say(SW.where.areaFailed(mapState.why)); }
      mapLoading = null;
      if (editing()) drawEditor();
    })();
  }

  // What.
  function whatSet(s) {
    const fs = h('fieldset', { className: 'scope-what', id: 'scope-what' }, h('legend', {}, SW.what.legend), h('p', { className: 'note' }, SW.what.note));
    const chosen = new Map(s.types.map((t) => [t.id, t]));
    const list = h('ul', { className: 'scope-checklist scope-shortlist', id: 'scope-shortlist' });
    for (const t of TYPE_SHORTLIST) {
      const on = chosen.get(t.id);
      list.append(h('li', {}, h('label', {}, h('input', { type: 'checkbox', id: `scope-t-${t.id}`, value: t.id, checked: !!on, onchange: (e) => toggleType({ id: t.id, label: t.label }, e.target.checked) }),
        ' ', SW.typeLabel(on || { label: t.label, narrower: t.narrower }))));
    }
    fs.append(list);
    const others = s.types.filter((t) => !TYPE_SHORTLIST.some((x) => x.id === t.id));
    if (others.length) fs.append(h('p', { className: 'scope-chosen' }, SW.what.chosen, ' '), h('ul', { className: 'scope-checklist', id: 'scope-types-chosen' },
      ...others.map((t) => h('li', {}, SW.typeLabel(t), ' ', h('button', { type: 'button', id: `scope-rm-${t.id}`, className: 'link', 'aria-label': SW.what.remove(t.label), onclick: () => toggleType(t, false) }, '×')))));
    if (!s.types.length) fs.append(h('p', { className: 'scope-chosen' }, SW.what.none));
    if (typeSay) fs.append(h('p', { className: 'scope-say' }, typeSay));
    fs.append(h('p', {}, h('button', { type: 'button', id: 'scope-more-types', 'aria-expanded': String(treeOpen), onclick: () => { treeOpen = !treeOpen; drawEditor(); } }, treeOpen ? SW.what.fewer : SW.what.more)));
    if (treeOpen) fs.append(treePart(chosen));
    return fs;
  }
  /**
   * A type chosen or let go: chosen, it is sent with its narrower ones, from WHG's /types/expand/ (asked now, or
   * kept from an earlier day, which its label says), else the bundled expansion; the count is always in the label.
   */
  async function toggleType(t, on) {
    if (!on) { change((x) => { x.types = x.types.filter((y) => y.id !== t.id); }); return; }
    const bundled = TYPE_SHORTLIST.find((x) => x.id === t.id);
    typeSay = SW.what.expanding(t.label); say(typeSay); drawEditor();
    const got = await whgGet(`/types/expand/?ids=${encodeURIComponent(t.id)}`, isExpanded);
    typeSay = '';
    const kept = got ? scopeType(t, got.v.ids, got.cached ? 'cache' : 'whg', got.at) : bundled ? scopeType(t, bundled.narrower, 'bundled') : scopeType(t, [], 'bundled');
    if (!got && !bundled) typeSay = SW.what.expandFailed(t.label);
    say(typeSay || SW.typeLabel(kept));
    change((x) => { x.types = [...x.types.filter((y) => y.id !== t.id), kept]; });
  }
  // The tree (WHG's /types/tree/, a node's children at /types/tree/<number>/), and its search.
  const nodes = new Map();          // path -> nodes, or 'loading' | 'failed'
  const opened = new Set();         // aat ids opened
  let treeSearch = '', found = null;
  function loadNodes(path) {
    if (nodes.has(path)) return nodes.get(path);
    nodes.set(path, 'loading');
    whgGet(path, isNodes).then((r) => { nodes.set(path, r?.v || 'failed'); if (editing()) drawEditor(); });
    return 'loading';
  }
  function treePart(chosen) {
    const box = h('div', { className: 'scope-tree', id: 'scope-tree' });
    const need = h('p', { id: 'scope-tree-permission', hidden: true });
    if (!allowed()) { box.append(h('p', { className: 'note' }, SW.what.notAllowed), need); permissions.needs(need, 'gazetteer', 'whg'); return box; }
    const search = h('input', { type: 'search', id: 'scope-type-search', value: treeSearch, autocomplete: 'off', oninput: (e) => { treeSearch = e.target.value; } });
    box.append(h('form', { onsubmit: (e) => { e.preventDefault(); searchTypes(search.value.trim()); } }, h('label', { htmlFor: 'scope-type-search' }, SW.what.search), search, ' ', h('button', { type: 'submit', id: 'scope-type-search-go' }, SW.what.searchGo)),
      h('p', { className: 'note' }, SW.what.treeNote));
    if (found) {
      box.append(found === 'loading' ? h('p', {}, SW.what.loading) : found === 'failed' ? h('p', { className: 'warn' }, SW.what.failed)
        : !found.length ? h('p', {}, SW.what.noMatch)
        : h('ul', { className: 'scope-checklist', id: 'scope-type-found' }, ...found.map((n) => typeItem({ id: aatOf(n), text: n.text, guide: false }, chosen, 'found'))));
    }
    const roots = loadNodes('/types/tree/');
    const top = roots === 'loading' ? h('p', {}, SW.what.loading) : roots === 'failed' ? h('p', { className: 'warn' }, SW.what.failed) : branch(roots, chosen, 0);
    if (top.tagName === 'UL') { top.id = 'scope-branch-top'; top.setAttribute('data-keep-scroll', ''); }
    box.append(top);
    return box;
  }
  function typeItem(n, chosen, where = 'tree') {
    const id = aatOf(n);
    return h('li', { dataset: { aat: id } }, n.guide ? h('em', {}, n.text) : h('label', {}, h('input', { type: 'checkbox', id: `scope-${where}-${id}`, value: id, checked: chosen.has(id), onchange: (e) => toggleType({ id, label: n.text }, e.target.checked) }), ' ', chosen.has(id) ? SW.typeLabel(chosen.get(id)) : n.text));
  }
  // Nested lists with buttons that open a type (aria-expanded): no tree role, whose keyboard model this does not give.
  function branch(list, chosen, depth) {
    const ul = h('ul', { className: 'scope-branch' });
    for (const n of list) {
      const id = aatOf(n), kids = n.children === true || (Array.isArray(n.children) && n.children.length);
      const li = typeItem(n, chosen);
      if (kids) {
        const isOpen = opened.has(id);
        li.prepend(h('button', { type: 'button', id: `scope-twist-${id}`, className: 'scope-twist', 'aria-expanded': String(isOpen), 'aria-label': `${isOpen ? 'Close' : 'Open'} ${n.text}`, onclick: () => { if (isOpen) opened.delete(id); else opened.add(id); drawEditor(); } }, isOpen ? '▾' : '▸'), ' ');
        if (isOpen && depth < 12) {
          const sub = loadNodes(`/types/tree/${id.slice(4)}/`);
          li.append(sub === 'loading' ? h('p', {}, SW.what.loading) : sub === 'failed' ? h('p', { className: 'warn' }, SW.what.failed) : branch(sub, chosen, depth + 1));
        }
      }
      ul.append(li);
    }
    return ul;
  }
  async function searchTypes(q) {
    treeSearch = q;
    if (!q) { found = null; drawEditor(); return; }
    found = 'loading'; say(SW.what.loading); drawEditor();
    const r = await whgGet(`/types/tree/search/?q=${encodeURIComponent(q)}`, isFound);
    found = r?.v || 'failed';
    say(found === 'failed' ? SW.what.failed : SW.what.foundCount(found.length));
    drawEditor();
    editor.querySelector('#scope-type-search')?.focus();
  }

  // When.
  function whenSet(s) {
    const fs = h('fieldset', { className: 'scope-when', id: 'scope-when' }, h('legend', {}, SW.when.legend));
    const num = (id, label, v, key) => h('span', { className: 'scope-year' }, h('label', { htmlFor: id }, label), ' ',
      // A year is taken when the field is left: drawn again once the focus has gone where Tab sent it, so that it stays there.
      h('input', { type: 'number', id, min: YEAR_RANGE[0], max: YEAR_RANGE[1], step: 1, value: v ?? '', onchange: (e) => {
        const n = e.target.value.trim() === '' ? null : Number(e.target.value);
        setTimeout(() => change((x) => { x.when[key] = Number.isInteger(n) ? n : null; }), 0);
      } }));
    fs.append(h('p', {}, num('scope-start', SW.when.start, s.when.start, 'start'), ' ', num('scope-end', SW.when.end, s.when.end, 'end')),
      h('p', { className: 'note' }, SW.when.note));
    if (yearsProblem(s)) fs.append(h('p', { className: 'warn' }, SW.when.startAfterEnd));
    // Sent as undated: true, beside the years only (scope.js); left unticked, WHG leaves out every place with no
    // dates, which the summary marks. Were WHG ever not to take it (UNDATED_TAKEN off), the box is disabled and
    // WHG's behaviour said beside it.
    fs.append(h('label', { className: 'scope-undated-choice' }, h('input', { type: 'checkbox', id: 'scope-undated', disabled: !UNDATED_TAKEN, checked: UNDATED_TAKEN && s.when.undated,
      'aria-describedby': UNDATED_TAKEN ? 'scope-undated-note' : 'scope-undated-warn', onchange: (e) => change((x) => { x.when.undated = e.target.checked; }) }), ' ', SW.when.undated),
      UNDATED_TAKEN ? h('p', { className: 'note', id: 'scope-undated-note' }, SW.when.undatedNote)
        : h('p', { className: 'warn', id: 'scope-undated-warn' }, h('span', { 'aria-hidden': 'true' }, '⚠ '), SW.when.undatedWarn));
    return fs;
  }

  // Sources.
  async function loadSources() {
    const r = await whgGet('/api/sources/', isSources);
    sources = r ? r.v.sources.filter((x) => /^[a-z][a-z0-9_]*$/.test(x.namespace)).map((x) => ({ namespace: x.namespace, name: String(x.name || x.namespace), core: !!x.core, records: Number(x.record_count) || 0 })) : BUNDLED_SOURCES;
    sourcesFrom = r ? 'whg' : 'bundled';
    show();
    if (editing()) drawEditor();
  }
  function sourcesSet(s) {
    const fs = h('fieldset', { className: 'scope-sources', id: 'scope-sources' }, h('legend', {}, SW.sources.legend), h('p', { className: 'note' }, SW.sources.note));
    const list = (sources || BUNDLED_SOURCES).filter((x) => /^[a-z][a-z0-9_]*$/.test(x.namespace));
    // WHG's own contributed datasets (whg) are always offered, under that name.
    const all = [...list.filter((x) => x.namespace !== 'whg'), { namespace: 'whg', name: SW.sources.whg, records: 0 }];
    const on = new Set(s.sources);
    fs.append(h('ul', { className: 'scope-checklist scope-source-list', id: 'scope-source-list' }, ...all.map((x) => h('li', {}, h('label', {},
      h('input', { type: 'checkbox', id: `scope-s-${x.namespace}`, value: x.namespace, checked: on.has(x.namespace), onchange: (e) => change((y) => { const set = new Set(y.sources); if (e.target.checked) set.add(x.namespace); else set.delete(x.namespace); y.sources = [...set]; }) }),
      ' ', `${x.namespace === 'whg' ? SW.sources.whg : x.name} (${x.namespace})`, x.records ? h('small', {}, ` ${SW.sources.records(x.records)}`) : '')))));
    if (sourcesFrom === 'bundled') fs.append(h('p', { className: 'note', id: 'scope-sources-bundled' }, SW.sources.bundled));
    return fs;
  }

  // The token field (drawn by placePart while there is no token): Enter gives it for the tab, Remember keeps it
  // in this browser, Forget lets it go; then the name is asked for.
  editor.addEventListener('input', (e) => { if (e.target.id === 'scope-token') noteInput(e); });
  editor.addEventListener('keydown', (e) => {
    if (e.target.id !== 'scope-token' || e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault(); giveToken(token, e.target); placeSay = ''; drawEditor(); $('scope-place-q')?.focus();
  });
  editor.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'scope-token-remember') { rememberToken(token, $('scope-token')); placeSay = ''; drawEditor(); $('scope-place-q')?.focus(); }
    if (b.id === 'scope-token-forget') { forgetToken(token, lookup(), $('scope-token')); drawEditor(); $('scope-token')?.focus(); }
  });
  permissions.onChange(() => { if (editing()) { if (sourcesFrom === 'bundled') loadSources(); drawEditor(); } });
  // The sources' names in the summary are the bundled list's until the editor has read WHG's (nothing is asked at load).
  show();
  return { current, show, open, close };
}
