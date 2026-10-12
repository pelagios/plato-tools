// Scope on the main page (Issue #33, points 2 and 8; Stephen's decisions of 12 October 2026). What every
// WHG lookup is confined to: Where (countries, a WHG place used as a container, or an area drawn on a
// map), What (AAT place types), When (years) and Sources (WHG's namespaces). The pure parts are
// src/engine/krisis/scope.js; its words are words.js SCOPE_WORDS.
//
// Whose Scope. In a workflow, the workflow's: kept in its record (src/methodos/page.js, setScope), saved
// with it, taken up with it after a reload, downloaded with it, and gone when it is left. Outside a
// workflow, the lookup panel uses this tab's own Scope, kept in sessionStorage for the tab alone: the
// simplest honest design, since a Scope outlasting the tab with no workflow to belong to would confine
// lookups the user no longer remembers asking for. Every Scope read, from either, goes through
// normaliseScope, as storage may hold what another page of the origin wrote.
//
// Where it is shown. Its summary, as chips (Where, What, When, Sources, with a mark when places with no
// dates are left out) and Edit, is in the workflow rail (section#scope) while a workflow is followed, and
// in the lookup panel (#lookup-scope) always. Editing opens in the centre column (section#scope-editor),
// since the area drawn needs the width; the rest of the centre is hidden meanwhile (body.scope-editing),
// and Done puts the focus back where it was, at the step the user was on.
//
// Nothing is asked of another site but through the permissions module, under the gazetteer's permission
// ('gazetteer', 'whg'), and only once it is allowed: WHG's tree of AAT place types (/types/tree/, its
// search, and /types/expand/ for a type's narrower ones) and its sources (/api/sources/), all read
// anonymously and cached in this browser; the WHG place used as a container is found through the shared
// WHG lookup (the token's one keeper's token, as every lookup). Without the permission, the shortlist of
// types (with its bundled expansions) and the bundled list of sources still work.
//
// The drawn area's map is Chora's (src/chora/map.js createMap, with its drawing), on its Natural Earth
// basemap, served from this site: it is imported only when that mode is first opened, so the main page
// loads no MapLibre until then. The page's policy needs nothing more for it (its worker is a blob:, its
// style, glyphs and tiles 'self').
import * as permissions from './lib/permissions.js';
import { SCOPE_WORDS as SW } from './engine/words.js';
import { normaliseScope, emptyScope, isEmptyScope, excludesUndated, yearsProblem, scopeType, containerId, areaPolygon, UNDATED_TAKEN, WHERE_MODES, YEAR_RANGE } from './engine/krisis/scope.js';
import { TYPE_SHORTLIST, BUNDLED_SOURCES, COUNTRY_CODES } from './engine/krisis/scope-data.js';

const WHG = 'https://whgazetteer.org';
const TAB_KEY = 'plato-tools.scope';
const CACHE_KEY = 'plato-tools.whg-cache.';
const CACHE_DAYS = 7;
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

/**
 * One of WHG's anonymous answers, through the permissions module, cached in this browser for a week
 * (localStorage, read back only when it has the shape asked for: `ok(value)`). Null when it cannot be had.
 */
async function whgGet(path, ok) {
  const key = CACHE_KEY + path;
  try {
    const kept = JSON.parse(localStorage.getItem(key));
    if (kept && Date.now() - kept.at < CACHE_DAYS * 864e5 && ok(kept.v)) return kept.v;
  } catch { /* not kept, or not readable */ }
  if (!allowed()) return null;
  try {
    const r = await permissions.fetch(WHG + path, { cat: 'gazetteer', subj: 'whg' });
    if (!r.ok) return null;
    const v = await r.json();
    if (!ok(v)) return null;
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), v })); } catch { /* not kept: asked again next time */ }
    return v;
  } catch { return null; }
}
const isNodes = (v) => Array.isArray(v) && v.every((n) => n && typeof n.text === 'string' && (typeof n.aat_id === 'number' || /^aat:\d+$/.test(n.id)));
const isFound = (v) => Array.isArray(v) && v.every((n) => n && typeof n.text === 'string' && typeof n.aat_id === 'number');
const isExpanded = (v) => !!v && Array.isArray(v.ids) && v.ids.every((x) => typeof x === 'string' && /^aat:\d+$/.test(x));
const isSources = (v) => !!v && Array.isArray(v.sources) && v.sources.every((s) => s && typeof s.namespace === 'string');
const aatOf = (n) => (typeof n.aat_id === 'number' ? `aat:${n.aat_id}` : n.id);

/**
 * Mount Scope. `methodos` is Methodos's page (scope(), setScope(s), scoped(), following()); `lookup()` the
 * shared WHG lookup; `token` the token's keeper; `onChange()` is told when the Scope changes (the lookup's
 * preview is drawn again); `state` is window.__plato, on which `scope` is published for the browser checks.
 */
export function mountScope({ methodos, lookup, token, onChange, state }) {
  const $ = (id) => document.getElementById(id);
  const rail = $('scope'), editor = $('scope-editor'), panel = $('lookup-scope');
  let returnTo = null, mapApi = null, mapState = { phase: 'none' }, treeOpen = false, typeSay = '', placeFound = null, placeSay = '', sources = null, sourcesFrom = 'bundled';

  const inWorkflow = () => !!methodos.scoped?.();
  function tabScope() { try { return normaliseScope(JSON.parse(sessionStorage.getItem(TAB_KEY))); } catch { return emptyScope(); } }
  /** The Scope in force: the workflow's, or this tab's. */
  const current = () => (inWorkflow() ? normaliseScope(methodos.scope()) : tabScope());
  function save(s) {
    const n = normaliseScope(s);
    if (inWorkflow()) methodos.setScope(isEmptyScope(n) ? null : n);
    else { try { if (isEmptyScope(n)) sessionStorage.removeItem(TAB_KEY); else sessionStorage.setItem(TAB_KEY, JSON.stringify(n)); } catch { /* the tab refuses storage: not kept */ } }
    // setScope saves on Methodos's queue; what is shown is drawn from the Scope just made.
    show(n);
    onChange?.();
  }
  const change = (fn) => { const s = current(); fn(s); save(s); if (editing()) drawEditor(); };
  const editing = () => !editor.hidden;

  // ---- the summary: chips, in the rail and in the lookup panel ----------------------------------------
  function chipsList(s) {
    const ul = h('ul', { className: 'scope-chips' });
    for (const c of SW.chips(s, countryLabel)) ul.append(h('li', { className: 'scope-chip', dataset: { part: c.key } }, h('span', { className: 'scope-chip-key' }, SW.parts[c.key]), ' ', h('span', { className: 'scope-chip-text' }, c.text)));
    return ul;
  }
  function summary(box, s, { heading }) {
    box.replaceChildren();
    if (heading) box.append(h('h2', { id: 'scope-h', className: 'scope-h' }, SW.heading));
    else box.append(h('p', { className: 'scope-line' }, h('strong', {}, `${SW.heading}: `), inWorkflow() ? 'this workflow\'s.' : 'this tab\'s.'));
    box.append(chipsList(s));
    if (excludesUndated(s)) box.append(h('p', { className: 'scope-undated warn', dataset: { mark: 'undated' } }, h('span', { 'aria-hidden': 'true' }, '⚠ '), SW.undatedMark));
    box.append(h('p', { className: 'scope-edit-line' }, h('button', { type: 'button', className: 'link scope-edit', onclick: open }, heading ? SW.edit : SW.editScope)));
  }
  function show(s = current()) {
    rail.hidden = !methodos.following?.();
    if (!rail.hidden) summary(rail, s, { heading: true });
    if (panel) summary(panel, s, { heading: false });
    publish(s);
  }
  function publish(s = current()) {
    if (state) state.scope = { scope: s, whose: inWorkflow() ? 'workflow' : 'tab', editing: editing(), map: mapState.phase, sources: sourcesFrom,
      chips: SW.chips(s, countryLabel).map((c) => `${SW.parts[c.key]}: ${c.text}`), undated: excludesUndated(s) };
  }

  // ---- opening and closing the editor (centre column) ------------------------------------------------
  function open() {
    if (!editing()) { returnTo = document.activeElement !== document.body ? document.activeElement : null; modeShown = current().where.mode; }
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
    // Back to the step the user was on: what had the focus, if it is still there; else the step's title.
    const back = returnTo?.isConnected && returnTo.getClientRects().length ? returnTo : (!$('workflow-head').hidden ? $('workflow-title') : $('files-h'));
    back?.scrollIntoView({ block: 'center', behavior: 'auto' }); back?.focus({ preventScroll: true });
    returnTo = null;
  }

  // ---- the editor --------------------------------------------------------------------------------------
  function drawEditor() {
    const s = current();
    const body = h('div', { className: 'scope-body' },
      h('h2', { id: 'scope-editor-h', tabIndex: -1 }, SW.editorHeading),
      h('p', { className: 'scope-whose' }, SW.whose(inWorkflow())),
      h('p', { className: 'note' }, SW.lede),
      whereSet(s), whatSet(s), whenSet(s), sourcesSet(s),
      h('p', { className: 'scope-buttons' },
        h('button', { type: 'button', className: 'primary', id: 'scope-done', onclick: close }, SW.close), ' ',
        h('button', { type: 'button', id: 'scope-clear', onclick: () => { save(emptyScope()); drawEditor(); } }, SW.clear)));
    // The map, once made, is kept across redraws: its element is moved, not made again (areaPart).
    editor.replaceChildren(body);
    if (modeShown === 'area') { ensureMap(s); mapApi?.map.resize(); }
    publish(s);
  }

  // Where.
  function whereSet(s) {
    const fs = h('fieldset', { className: 'scope-where', id: 'scope-where' }, h('legend', {}, SW.where.legend));
    const modes = h('div', { className: 'scope-modes', role: 'radiogroup' });
    // The mode shown is the Where in force, or one chosen whose value is not given yet (no country ticked, no
    // place chosen, no area drawn). Choosing another mode lets the Where in force go: one Where at a time.
    if (s.where.mode !== 'anywhere') modeShown = s.where.mode;
    for (const m of WHERE_MODES) modes.append(h('label', {}, h('input', { type: 'radio', name: 'scope-where', value: m, checked: m === modeShown,
      onchange: () => { modeShown = m; change((x) => { x.where = { mode: 'anywhere' }; }); } }), ' ', SW.where.modes[m]));
    fs.append(modes);
    const mode = modeShown;
    if (mode === 'countries') fs.append(countriesPart(s));
    if (mode === 'place') fs.append(placePart(s));
    if (mode === 'area') fs.append(areaPart(s));
    fs.append(h('p', { className: 'note scope-precedence' }, SW.where.precedence));
    return fs;
  }
  let modeShown = 'anywhere', placeName = '';
  let countryFilter = '';
  function countriesPart(s) {
    const chosen = new Set(s.where.mode === 'countries' ? s.where.countries : []);
    const box = h('div', { className: 'scope-part', id: 'scope-countries' });
    const list = h('ul', { className: 'scope-checklist', id: 'scope-country-list' });
    const fill = () => {
      const q = countryFilter.trim().toLowerCase();
      list.replaceChildren(...COUNTRIES.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q).map((c) => h('li', {},
        h('label', {}, h('input', { type: 'checkbox', value: c.code, checked: chosen.has(c.code), onchange: (e) => change((x) => {
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
    const q = h('input', { type: 'text', id: 'scope-place-q', autocomplete: 'off', spellcheck: false, value: placeName });
    const need = h('p', { id: 'scope-place-permission', hidden: true });
    const form = h('form', { className: 'scope-place-form', onsubmit: (e) => { e.preventDefault(); placeName = q.value.trim(); findPlace(placeName); } },
      h('label', { htmlFor: 'scope-place-q' }, SW.where.placeLabel), q, ' ', h('button', { type: 'submit', id: 'scope-place-find' }, SW.where.placeFind));
    box.append(form, need, h('p', { className: 'note' }, SW.where.placeNote));
    // WHG answers only a query that carries the token: given here, it goes to its one keeper, as from the lookup
    // panel, and the field is emptied (the page keeps no copy).
    if (!token.get()) {
      const t = h('input', { type: 'password', id: 'scope-token', autocomplete: 'off', spellcheck: false });
      box.append(h('form', { className: 'scope-place-form', onsubmit: (e) => { e.preventDefault(); if (t.value.trim()) { token.set(t.value); t.value = ''; placeSay = ''; drawEditor(); } } },
        h('label', { htmlFor: 'scope-token' }, SW.where.placeToken), t, ' ', h('button', { type: 'submit' }, SW.where.placeTokenUse)));
    }
    if (!allowed()) permissions.needs(need, 'gazetteer', 'whg');
    if (placeSay) box.append(h('p', { className: 'scope-say', role: 'status' }, placeSay));
    if (placeFound?.length) box.append(h('ol', { className: 'scope-found', id: 'scope-place-found' }, ...placeFound.map((c) => h('li', { dataset: { id: c.id } },
      h('strong', {}, c.name), c.description ? ` ${c.description}` : '', ` (${c.id}) `,
      h('button', { type: 'button', onclick: () => { change((x) => { x.where = { mode: 'place', place: { id: c.id, label: c.name, description: c.description || undefined } }; }); placeFound = null; placeSay = ''; drawEditor(); } }, SW.where.placeUse)))));
    return box;
  }
  async function findPlace(name) {
    if (!name) return;
    if (!allowed()) { drawEditor(); return; }
    if (!token.get()) { placeSay = SW.where.placeNeedsToken; drawEditor(); return; }
    placeSay = SW.where.placeSearching; placeFound = null; drawEditor();
    try {
      // The region review's search: areas only, as a container must be an outline (whg.js A12).
      const [list] = await lookup().reconcile([{ query: name, type: 'Place', limit: 10, params: { area_only: true } }]);
      placeFound = [...list].map((c) => ({ id: containerId(c.id), name: c.name || c.id, description: c.description || '' })).filter((c) => c.id);
      placeSay = placeFound.length ? '' : SW.where.placeNone;
    } catch (e) { placeFound = null; placeSay = e?.message || String(e); }
    drawEditor();
    editor.querySelector('#scope-place-found button, #scope-place-q')?.focus();
  }
  function areaPart(s) {
    const box = h('div', { className: 'scope-part', id: 'scope-area' });
    const a = s.where.mode === 'area' ? s.where.area : null;
    box.append(h('p', { className: 'scope-chosen' }, a ? SW.where.areaChosen(a.coordinates[0].length - 1, bboxOf(a)) : SW.where.areaNone),
      h('p', { className: 'note' }, SW.where.areaHow),
      h('p', {}, h('button', { type: 'button', id: 'scope-area-draw', onclick: () => { mapApi?.setPlace(null); mapApi?.setMode('polygon'); } }, a ? SW.where.areaRedraw : SW.where.areaDraw)),
      mapState.phase === 'failed' ? h('p', { className: 'warn' }, SW.where.areaFailed(mapState.why)) : mapState.phase === 'loading' ? h('p', { role: 'status' }, SW.where.areaLoading) : '',
      mapApi ? mapApi.box : h('div', { id: 'scope-map', className: 'scope-map' }));
    return box;
  }
  const bboxOf = (a) => { const r = a.coordinates[0]; const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const areaFeature = (a) => ({ type: 'FeatureCollection', features: a ? [{ type: 'Feature', geometry: a, properties: { status: 'asserted' } }] : [] });
  let mapLoading = null;
  /** Chora's map, imported now (never before this mode is opened), on Natural Earth, with its drawing. */
  function ensureMap(s) {
    if (mapApi) { mapApi.setPlace(areaFeature(s.where.area)); return; }
    if (mapLoading) return;
    mapState = { phase: 'loading' }; publish();
    mapLoading = (async () => {
      try {
        const [{ createMap }, basemaps] = await Promise.all([import('./chora/map.js'), import('./chora/basemaps.js')]);
        // Made in the element already in the editor, which has its size; moved, never made again, on a redraw.
        const box = editor.querySelector('#scope-map') || h('div', { id: 'scope-map', className: 'scope-map' });
        const api = createMap(box, { state: mapState, onPlaceClick: () => {} });
        api.box = box;
        api.setStyle(await basemaps.styleFor(basemaps.builtIn().find((b) => b.local)));
        api.onDraw({ finish: (id) => {
          const f = api.draw?.getSnapshot().find((x) => x.id === id);
          const area = areaPolygon(f?.geometry);
          if (!area) return;
          change((x) => { x.where = { mode: 'area', area }; });
          // The drawing becomes the area shown: Terra Draw's copy is let go.
          setTimeout(() => { try { api.draw?.clear(); api.setMode('static'); } catch { /* the style changed meanwhile */ } }, 0);
        } });
        // A style's hooks run before the map starts its drawing tool again: the mode is set once it has.
        api.onStyleLoad(() => { const a = current().where; api.setPlace(areaFeature(a.mode === 'area' ? a.area : null)); if (a.mode === 'area') api.fit(bboxOf(a.area), 8); else setTimeout(() => api.setMode('polygon'), 0); });
        mapApi = api; mapState.phase = 'ready'; window.__scope_map = api.map;
      } catch (e) { mapState = { phase: 'failed', why: e?.message || String(e) }; }
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
      list.append(h('li', {}, h('label', {}, h('input', { type: 'checkbox', value: t.id, checked: !!on, onchange: (e) => toggleType({ id: t.id, label: t.label }, e.target.checked) }),
        ' ', SW.typeLabel(on || { label: t.label, narrower: t.narrower }))));
    }
    fs.append(list);
    const others = s.types.filter((t) => !TYPE_SHORTLIST.some((x) => x.id === t.id));
    if (others.length) fs.append(h('p', { className: 'scope-chosen' }, SW.what.chosen, ' '), h('ul', { className: 'scope-checklist', id: 'scope-types-chosen' },
      ...others.map((t) => h('li', {}, SW.typeLabel(t), ' ', h('button', { type: 'button', className: 'link', 'aria-label': SW.what.remove(t.label), onclick: () => toggleType(t, false) }, '×')))));
    if (!s.types.length) fs.append(h('p', { className: 'scope-chosen' }, SW.what.none));
    if (typeSay) fs.append(h('p', { className: 'scope-say', role: 'status' }, typeSay));
    fs.append(h('p', {}, h('button', { type: 'button', id: 'scope-more-types', 'aria-expanded': String(treeOpen), onclick: () => { treeOpen = !treeOpen; drawEditor(); } }, treeOpen ? SW.what.fewer : SW.what.more)));
    if (treeOpen) fs.append(treePart(chosen));
    return fs;
  }
  /** A type chosen or let go: chosen, it is sent with its narrower ones, from WHG's /types/expand/, else the bundled expansion. */
  async function toggleType(t, on) {
    if (!on) { change((x) => { x.types = x.types.filter((y) => y.id !== t.id); }); return; }
    const bundled = TYPE_SHORTLIST.find((x) => x.id === t.id);
    typeSay = SW.what.expanding(t.label); drawEditor();
    const got = await whgGet(`/types/expand/?ids=${encodeURIComponent(t.id)}`, isExpanded);
    typeSay = '';
    const kept = got ? scopeType(t, got.ids, 'whg') : bundled ? scopeType(t, bundled.narrower, 'bundled') : scopeType(t, [], 'bundled');
    if (!got && !bundled) typeSay = SW.what.expandFailed(t.label);
    change((x) => { x.types = [...x.types.filter((y) => y.id !== t.id), kept]; });
  }
  // The tree (WHG's /types/tree/, a node's children at /types/tree/<number>/), and its search.
  const nodes = new Map();          // path -> nodes, or 'loading' | 'failed'
  const opened = new Set();         // aat ids opened
  let treeSearch = '', found = null;
  function loadNodes(path) {
    if (nodes.has(path)) return nodes.get(path);
    nodes.set(path, 'loading');
    whgGet(path, isNodes).then((v) => { nodes.set(path, v || 'failed'); if (editing()) drawEditor(); });
    return 'loading';
  }
  function treePart(chosen) {
    const box = h('div', { className: 'scope-tree', id: 'scope-tree' });
    const need = h('p', { id: 'scope-tree-permission', hidden: true });
    if (!allowed()) { box.append(h('p', { className: 'note' }, SW.what.notAllowed), need); permissions.needs(need, 'gazetteer', 'whg'); return box; }
    const search = h('input', { type: 'search', id: 'scope-type-search', value: treeSearch, autocomplete: 'off' });
    box.append(h('form', { onsubmit: (e) => { e.preventDefault(); searchTypes(search.value.trim()); } }, h('label', { htmlFor: 'scope-type-search' }, SW.what.search), search, ' ', h('button', { type: 'submit' }, 'Search')),
      h('p', { className: 'note' }, SW.what.treeNote));
    if (found) {
      box.append(found === 'loading' ? h('p', { role: 'status' }, SW.what.loading) : found === 'failed' ? h('p', { className: 'warn' }, SW.what.failed)
        : !found.length ? h('p', {}, SW.what.noMatch)
        : h('ul', { className: 'scope-checklist', id: 'scope-type-found' }, ...found.map((n) => typeItem({ id: aatOf(n), text: n.text, guide: false }, chosen))));
    }
    const roots = loadNodes('/types/tree/');
    box.append(roots === 'loading' ? h('p', { role: 'status' }, SW.what.loading) : roots === 'failed' ? h('p', { className: 'warn' }, SW.what.failed) : branch(roots, chosen, 0));
    return box;
  }
  function typeItem(n, chosen) {
    const id = aatOf(n);
    return h('li', { dataset: { aat: id } }, n.guide ? h('em', {}, n.text) : h('label', {}, h('input', { type: 'checkbox', value: id, checked: chosen.has(id), onchange: (e) => toggleType({ id, label: n.text }, e.target.checked) }), ' ', chosen.has(id) ? SW.typeLabel(chosen.get(id)) : n.text));
  }
  function branch(list, chosen, depth) {
    const ul = h('ul', { className: 'scope-branch', role: depth ? 'group' : 'tree' });
    for (const n of list) {
      const id = aatOf(n), kids = n.children === true || (Array.isArray(n.children) && n.children.length);
      const li = typeItem(n, chosen);
      if (kids) {
        const isOpen = opened.has(id);
        li.prepend(h('button', { type: 'button', className: 'scope-twist', 'aria-expanded': String(isOpen), 'aria-label': `${isOpen ? 'Close' : 'Open'} ${n.text}`, onclick: () => { if (isOpen) opened.delete(id); else opened.add(id); drawEditor(); } }, isOpen ? '▾' : '▸'), ' ');
        if (isOpen && depth < 12) {
          const sub = loadNodes(`/types/tree/${id.slice(4)}/`);
          li.append(sub === 'loading' ? h('p', { role: 'status' }, SW.what.loading) : sub === 'failed' ? h('p', { className: 'warn' }, SW.what.failed) : branch(sub, chosen, depth + 1));
        }
      }
      ul.append(li);
    }
    return ul;
  }
  async function searchTypes(q) {
    treeSearch = q;
    if (!q) { found = null; drawEditor(); return; }
    found = 'loading'; drawEditor();
    const v = await whgGet(`/types/tree/search/?q=${encodeURIComponent(q)}`, isFound);
    found = v || 'failed'; drawEditor();
    editor.querySelector('#scope-type-search')?.focus();
  }

  // When.
  function whenSet(s) {
    const fs = h('fieldset', { className: 'scope-when', id: 'scope-when' }, h('legend', {}, SW.when.legend));
    const num = (id, label, v, key) => h('span', { className: 'scope-year' }, h('label', { htmlFor: id }, label), ' ',
      h('input', { type: 'number', id, min: YEAR_RANGE[0], max: YEAR_RANGE[1], step: 1, value: v ?? '', onchange: (e) => change((x) => { const n = e.target.value.trim() === '' ? null : Number(e.target.value); x.when[key] = Number.isInteger(n) ? n : null; }) }));
    fs.append(h('p', {}, num('scope-start', SW.when.start, s.when.start, 'start'), ' ', num('scope-end', SW.when.end, s.when.end, 'end')),
      h('p', { className: 'note' }, SW.when.note));
    if (yearsProblem(s)) fs.append(h('p', { className: 'warn', role: 'alert' }, SW.when.startAfterEnd));
    // Disabled until WHG takes undated: true (scope.js UNDATED_TAKEN), with WHG's present behaviour said beside it.
    fs.append(h('label', { className: 'scope-undated-choice' }, h('input', { type: 'checkbox', id: 'scope-undated', disabled: !UNDATED_TAKEN, checked: UNDATED_TAKEN && s.when.undated,
      onchange: (e) => change((x) => { x.when.undated = e.target.checked; }) }), ' ', SW.when.undated),
      h('p', { className: 'warn', id: 'scope-undated-warn' }, h('span', { 'aria-hidden': 'true' }, '⚠ '), SW.when.undatedWarn));
    return fs;
  }

  // Sources.
  async function loadSources() {
    const v = await whgGet('/api/sources/', isSources);
    sources = v ? v.sources.map((x) => ({ namespace: x.namespace, name: String(x.name || x.namespace), core: !!x.core, records: Number(x.record_count) || 0 })) : BUNDLED_SOURCES;
    sourcesFrom = v ? 'whg' : 'bundled';
    if (editing()) drawEditor(); else publish();
  }
  function sourcesSet(s) {
    const fs = h('fieldset', { className: 'scope-sources', id: 'scope-sources' }, h('legend', {}, SW.sources.legend), h('p', { className: 'note' }, SW.sources.note));
    const list = (sources || BUNDLED_SOURCES).filter((x) => /^[a-z][a-z0-9_]*$/.test(x.namespace));
    // WHG's own contributed datasets (whg) are always offered, under that name.
    const all = [...list.filter((x) => x.namespace !== 'whg'), { namespace: 'whg', name: SW.sources.whg, records: 0 }];
    const on = new Set(s.sources);
    fs.append(h('ul', { className: 'scope-checklist scope-source-list', id: 'scope-source-list' }, ...all.map((x) => h('li', {}, h('label', {},
      h('input', { type: 'checkbox', value: x.namespace, checked: on.has(x.namespace), onchange: (e) => change((y) => { const set = new Set(y.sources); if (e.target.checked) set.add(x.namespace); else set.delete(x.namespace); y.sources = [...set]; }) }),
      ' ', `${x.namespace === 'whg' ? SW.sources.whg : x.name} (${x.namespace})`, x.records ? h('small', {}, ` ${SW.sources.records(x.records)}`) : '')))));
    if (sourcesFrom === 'bundled') fs.append(h('p', { className: 'note', id: 'scope-sources-bundled' }, SW.sources.bundled));
    return fs;
  }

  permissions.onChange(() => { if (editing()) { if (sourcesFrom === 'bundled') loadSources(); drawEditor(); } });
  show();
  return { current, show, open, close };
}
