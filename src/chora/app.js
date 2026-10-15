// Chora, the map: open a dataset, find a place, see on the map and in its card everything the
// attestations say of it over time; draw a point, line or area as a new attestation; save the whole
// dataset with the drawings added, checked by the version check (Mneme) against what was opened.
// A module mounted into a page (mountChora, at the end): its DOM is in the root it is given, and every
// id it makes starts with `chora-` (the adoption panel's with `adopt-`), so that none clashes with the
// page's. The engine is the same worker as the main page's (src/engine/worker.js, its chora-* commands),
// a worker of its own. It publishes its state on window.__chora for automated tests; nothing else reads it.
import { fmtBytes, formatName, progressText, summary, choraDrawingNote, choraSaveText, choraSavedFormat, choraSaveProgress, choraStorageWarning, choraProblemText, CHORA_TEXT } from '../engine/words.js';
import { sizeRead, loadNeed, saveNeed, storageShort } from '../engine/chora/storage.js';
import { detect } from '../engine/input.js';
import { newGeometryAttestation, checkGeoJSON, wrapLongitudes, DrawError, ROLES, PRECISIONS } from '../engine/chora/draw.js';
import { createMap, placeFeatures, contextFeatures } from './map.js';
import { esc, badge, nameItem, relationItem, timeline, locations, ROLE_WORDS, STATUS_COLOURS } from './card.js';
import { vagueFeatures, keyRows, drawMark, drawLineSample, MARK_SIZE } from './vague.js';
import { bboxOf, unionBbox } from '../engine/chora/geo.js';
import * as basemaps from './basemaps.js';
import * as contributors from './contributor.js';
import { fingerprint, loadDrafts, saveDrafts, draftsWritten, forgetAllDrafts } from './drafts.js';
// What Chora keeps across the page's reload for a permission (the files, the place, the view).
import { keepForReload, takeResume } from './resume.js';
// The workflow's Scope, as the page gives it (Methodos's), checked as it is read.
import { normaliseScope } from '../engine/krisis/scope.js';
import { serialQueue, pageRequest, answers } from './queue.js';
import * as permissions from '../lib/permissions.js';
import { RELOAD_LOSES, REFUSED as PERMISSION_REFUSED, NEEDS, REMEMBERED_BASEMAP } from '../lib/permission-words.js';
import * as ov from './overlays.js';
import * as remote from './remote.js';
import * as georef from '../engine/georef/index.js';
import * as tracing from '../engine/chora/trace.js';
import { DataError } from '../engine/input.js';
// Adopting a location from a gazetteer match (src/chora/adopt-ui.js; the engine is src/engine/chora/adopt.js).
import { createAdopt } from './adopt-ui.js';
import { draftAttestations, consultedParts, isPlaceIri } from '../engine/chora/adopt.js';
import { CHORA_ADOPT_PAGE, CHORA_HANDOVER, CHORA_TRACE } from '../engine/words.js';
// Tracing a historical map into a new dataset: the settings kept for each map, its seed, the forms, the new places a save adds.
import * as traced from './traced.js';
import { scriptOf, kindType } from '../engine/chora/seed.js';
// The tools' own version, for the notes of a shape traced with assistance.
import { version as toolsVersion } from '../../package.json';

// What Chora puts into its root: the panel (the dataset, the historical maps, the places, the card, the
// adoption and the save), beside the map with its tools. The dataset is the page's, chosen in its step 1.
const html = () => `<div class="chora-panel" id="chora-panel">
    <section id="chora-data" class="chora-data" aria-label="The dataset on the map">
      <p id="chora-phase" aria-live="polite"></p>
      <p id="chora-storage-warning" class="warn" hidden></p>
      <div id="chora-dataset" hidden></div>
    </section>

    <section id="chora-maps" aria-labelledby="chora-maps-h">
      <h2 id="chora-maps-h">Historical maps</h2>
      <p class="muted">Lay a georeferenced historical map over the basemap, and trace places from it: what you trace cites the map, and the georeference that places it.</p>
      ${ov.pickerForm('chora')}
      <div id="chora-map-needs"></div>
      <div id="chora-map-status" role="status" aria-live="polite"></div>
      <ul id="chora-overlay-list" class="overlays"></ul>
      <section id="chora-trace" class="chora-trace" aria-labelledby="chora-trace-h">
        <h3 id="chora-trace-h">Trace into a new dataset</h3>
        <div id="chora-trace-body"></div>
      </section>
    </section>

    <section id="chora-traced" aria-labelledby="chora-traced-h" hidden>
      <h2 id="chora-traced-h">Traced from the map</h2>
      <p id="chora-traced-count" class="muted"></p>
      <ul id="chora-traced-list" class="pending traced"></ul>
      <p class="pager"><button id="chora-traced-prev" type="button">Previous</button> <button id="chora-traced-next" type="button">Next</button></p>
    </section>

    <section id="chora-places" aria-labelledby="chora-places-h" hidden>
      <h2 id="chora-places-h"><span class="step">2</span> Places</h2>
      <label for="chora-q" class="visually-hidden">Find a place by name</label>
      <input id="chora-q" type="search" placeholder="Find a place by name" autocomplete="off">
      <p id="chora-found" class="muted"></p>
      <ul id="chora-list" class="place-list"></ul>
      <p class="pager"><button id="chora-prev" type="button">Previous</button> <button id="chora-next" type="button">Next</button></p>
    </section>

    <section id="chora-card" aria-labelledby="chora-card-h" hidden></section>

    <section id="chora-adopt" class="adopt" aria-labelledby="adopt-h" hidden></section>

    <section id="chora-saving" aria-labelledby="chora-saving-h" hidden>
      <h2 id="chora-saving-h"><span class="step">3</span> Save</h2>
      <p id="chora-pending-total"></p>
      <form id="chora-contributor-form" hidden>
        <p>Your drawings will be saved as attestations made by you. Who are you?</p>
        <label for="chora-c-name">Your name</label>
        <input id="chora-c-name" required autocomplete="name">
        <label for="chora-c-orcid">ORCID iD <small>(optional)</small></label>
        <input id="chora-c-orcid" placeholder="0000-0002-1825-0097" autocomplete="off">
        <p id="chora-c-error" class="warn" hidden></p>
        <p><button class="primary" type="submit">Continue</button> <button type="button" id="chora-c-cancel">Cancel</button></p>
      </form>
      <p id="chora-contributor-line" hidden></p>
      <p><button id="chora-save" class="primary" type="button">Save as PLATO JSON</button></p>
      <p id="chora-save-progress" aria-live="polite" hidden></p>
      <p id="chora-save-storage-warning" class="warn" hidden></p>
      <div id="chora-save-result"></div>
    </section>
  </div>

  <div class="chora-mapwrap">
    <div id="chora-map" class="chora-map" aria-label="Map"></div>
    <div class="map-tools" id="chora-draw-tools" role="toolbar" aria-label="Draw" hidden>
      <button type="button" data-mode="point" data-tip="Draw a point">Point</button>
      <button type="button" data-mode="linestring" data-tip="Draw a line: click each vertex, and click the last one again to finish">Line</button>
      <button type="button" data-mode="polygon" data-tip="Draw an area: click each corner, and click the first one again to finish">Area</button>
      <button type="button" data-mode="select" data-tip="Select a drawing to move or reshape it">Edit</button>
      <button type="button" data-mode="static" data-tip="Stop drawing">Stop</button>
      <button type="button" data-trace="area" aria-disabled="true" data-tip="Show a historical map to trace from it">Trace area</button>
      <button type="button" data-trace="line" aria-disabled="true" data-tip="Show a historical map to trace from it">Trace line</button>
      <label class="snap-ink" id="chora-snap-ink-label" hidden><input type="checkbox" id="chora-snap-ink" data-tip="A vertex placed within 10 screen pixels of the map's ink goes onto it (hold Alt not to)"> Snap to ink</label>
    </div>
    <div class="ink-panel" id="chora-ink-panel" role="group" aria-label="Tracing from the map's ink" hidden></div>
    <!-- Naming a place traced into a new dataset (src/chora/traced.js): draw, name, Enter. -->
    <div class="ink-panel name-panel" id="chora-name-panel" role="group" aria-labelledby="chora-name-what" hidden></div>
    <!-- How well each location of the place chosen is known (src/chora/vague.js): shown with a place. -->
    <details class="map-key" id="chora-map-key" hidden>
      <summary>Key: how well a location is known</summary>
      <ul id="chora-map-key-list"></ul>
    </details>
    <details class="basemaps" id="chora-basemaps">
      <summary>Basemap: <span id="chora-basemap-name">Natural Earth (this site)</span></summary>
      <div id="chora-basemap-options"></div>
    </details>
  </div>`;

let root = null;                // the element Chora is mounted in (mountChora)
let host = {};                  // what the page gives it (mountChora)
let shown = true;               // whether the page shows it (show(), hide())
let state = null;               // window.__chora
let mapApi = null, adopt = null;
const $ = (id) => root.querySelector(`#chora-${id}`);
const PAGE = 50;
let showing = false;   // true while the drawings shown are being replaced
let worker, files = [], fp = null, dataset = null, drafts = [], view = null, total = 0, query = '';
let starts = [0], nextAfter = null;   // where each page of the list shown so far begins (after which place), and where the next would
let offered = null;    // the button that saves the file last written, while the drawings are those it holds
let handed = null;     // the file the last save wrote, as handed to the page (host.saved): chosen there, and not to be removed while it is
let drawError = null;  // why the last drawing was not kept, shown in the card
// Tracing a map into a new dataset (traced.js): what is kept of the tracings; the map the dataset open is traced
// from (its key), or null; the map whose settings form is open; the name form ({ draftId, editing }); the page of
// the list of what is traced; the place last named (a drawing may be added to it instead).
let tracings = null, traceKey = null, traceEditing = null, naming = null, tracedAt = 0, lastNamed = null;
const TRACED_PAGE = 50;

// ---- The engine ----------------------------------------------------------------------------------
// One request at a time (queue.js): each waits for the reply of its type (or an error), and progress
// on the way is shown in words. A search passed over by a later one before it is sent resolves to null.
const enqueue = serialQueue(({ msg, replyType }) => new Promise((resolve, reject) => {
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { state.progress = data; if (data.save) saveProgress(data); else $('phase').textContent = progressText(data); }
    else if (data.type === 'error') reject(Object.assign(new Error(data.message), { kind: data.kind }));
    else if (data.type === replyType) resolve(data);
  };
  worker.postMessage(msg);
}));
// `msg` may be a function that makes the command when it is sent, or null to send nothing (queue.js).
const request = (msg, replyType, opts) => enqueue(() => {
  const m = typeof msg === 'function' ? msg() : msg;
  return m === null ? null : { msg: m, replyType };
}, opts);
function startWorker() {
  worker = new Worker(new URL('../engine/worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (e) => fail(`The engine stopped: ${e.message || 'unknown error'}`);
  // A SQLite pool of Chora's own, so that its working copy and the page's runs are apart.
  return request({ cmd: 'init', base: new URL('./', location.href).href, pool: 'chora' }, 'ready').then(({ version: v }) => {
    Object.assign(state, { phase: 'ready', platoCommit: v.commit });
  });
}

// ---- Opening a dataset ---------------------------------------------------------------------------
async function open(list, { traceKey: carried = null } = {}) {
  if (state.phase === 'in-another-tab') return;
  files = [...list];
  if (!files.length) return;
  Object.assign(state, { phase: 'opening', placeId: null, lastSave: null, vague: { marks: 0, circles: 0 } });
  for (const id of ['places', 'card', 'saving']) $(id).hidden = true;
  adopt.close();
  $('save-result').innerHTML = ''; offered = handed = null;
  $('dataset').hidden = false;
  $('dataset').innerHTML = `<ul>${files.map((f) => `<li><span class="name">${esc(f.name)}</span> <span class="count">${fmtBytes(f.size)}</span></li>`).join('')}</ul>`;
  $('phase').textContent = 'Reading…';
  // Whether the browser has room for it, before it is read.
  // Persistent storage (navigator.storage) is not asked for here: it is to be offered in the toolbox's Permissions window.
  await storageCheck('load', $('storage-warning'));
  try {
    dataset = await request({ cmd: 'chora-load', files }, 'chora-loaded');
  } catch (e) { return fail(e.message); }
  if (dataset.failure) { $('phase').innerHTML = `<span class="warn">${esc(dataset.failure)}</span>`; Object.assign(state, { phase: 'unrecognised', reason: dataset.failure }); dataset = null; return; }
  const h = dataset.header || {};
  const problems = dataset.report?.errors ? ` <span class="warn">${esc(summary(dataset.report, 'check').problems)} <a href="#tool=check">Check it with Elenchos</a> to see them.</span>` : '';
  $('phase').textContent = '';
  $('dataset').innerHTML = `<p class="dataset-title">${esc(h.title || dataset.input?.name || files[0].name)}</p>`
    + `<p>${n(dataset.places)} place${dataset.places === 1 ? '' : 's'}, ${n(dataset.withGeometry)} with a location on record.${problems}</p>`;
  $('save').textContent = `Save as ${choraSavedFormat(dataset.input).words}`;
  fp = fingerprint(files);
  drafts = await loadDrafts(fp);
  // Traced from a map (a dataset made from it, or one it was saved as): the map's key, kept by the files' fingerprint.
  if (carried) { tracings.open[fp] = carried; keepTracings(); }
  traceKey = tracings.open[fp] ?? null; tracedAt = 0;
  const ov = await request({ cmd: 'chora-overview' }, 'chora-overview');
  mapApi.setOverview(ov.geojson);
  mapApi.setPlace(null); mapApi.setContext(null); showDrafts(visibleDrafts()); $('map-key').hidden = true;
  if (traceKey) $('draw-tools').hidden = false;
  // The maps' list too: what each map's button offers (into this dataset, or a new one) is the dataset's.
  renderTrace(); renderTraced(); if (layers) renderMaps();
  if (ov.capped || ov.geojson?.capped) $('dataset').insertAdjacentHTML('beforeend', `<p class="muted">The map shows the first ${n(ov.geojson.features.length)} places; find others by name.</p>`);
  if (dataset.bbox) mapApi.fit(dataset.bbox, 8);
  $('places').hidden = false;
  query = ''; $('q').value = '';
  await search('first');
  showSaving();
  Object.assign(state, { phase: 'loaded', places: dataset.places, pendingCount: drafts.length });
  if (drafts.length) $('dataset').insertAdjacentHTML('beforeend', `<p class="note">${n(drafts.length)} unsaved drawing${drafts.length === 1 ? ' was' : 's were'} kept from last time, and ${drafts.length === 1 ? 'is' : 'are'} shown with ${drafts.length === 1 ? 'its place' : 'their places'}.</p>`);
}

// ---- The place list ------------------------------------------------------------------------------
// A page goes on from the place before it (keyset paging): `starts` holds where each page so far
// began, so Previous goes back one, and a new query starts again. Which page to ask for is worked out
// when the request is sent, from the page the reply before it showed, so that Next clicked twice
// goes on two pages (pageRequest in queue.js). A new query is sent only if no later one was typed
// before it could be; Next and Previous are each sent, for the query there when they were clicked,
// unless the box holds another by then. A reply is shown only if it is for the query its request was
// made for, and that is the query in the box (folded, as the search compares).
async function search(to = 'first') {
  const asked = query;
  let req = null;
  const r = await request(() => {
    req = pageRequest(to, { asked, box: $('q').value, starts, nextAfter });
    return req && { cmd: 'chora-search', q: req.q, after: req.pages[req.pages.length - 1], limit: PAGE };
  }, 'chora-results', to === 'first' ? { latestOf: 'search' } : undefined);
  if (!r) return;   // a later search was asked for before this one was sent, or the box changed first
  if (!answers(r, req.q, $('q').value)) return;   // not for this request, or the box holds another query now
  const pages = req.pages;
  starts = pages; nextAfter = r.next; total = r.total;
  state.lastSearch = { q: r.q, after: pages[pages.length - 1], next: r.next, total: r.total, shown: r.items.map((p) => p.id) };
  const at = (pages.length - 1) * PAGE;
  $('found').textContent = total ? `${req.q ? `${n(total)} found` : `${n(total)} places`}${total > PAGE ? `, showing ${n(at + 1)}–${n(at + r.items.length)}` : ''}.` : 'No place has that in its name.';
  const pending = new Set(drafts.map((d) => d.placeId));
  $('list').innerHTML = r.items.map((p) => `<li><button type="button" class="place${p.id === state.placeId ? ' current' : ''}" data-id="${esc(p.id)}">${esc(p.label || p.id)}`
    + `${p.matched ? ` <span class="also">— also ${esc(p.matched)}</span>` : ''}${p.ccodes?.length ? ` <span class="muted">${esc(p.ccodes.join(', '))}</span>` : ''}${p.hasGeometry ? '' : ' <span class="tag">no location</span>'}${pending.has(p.id) ? ' <span class="tag pending">drawn</span>' : ''}</button></li>`).join('');
  $('prev').disabled = pages.length === 1; $('next').disabled = r.next === null;
  $('prev').parentElement.hidden = total <= PAGE;
}
let typing;

// ---- One place -----------------------------------------------------------------------------------
async function selectPlace(id) {
  let r;
  try { r = await request({ cmd: 'chora-place', id }, 'chora-place'); } catch (e) { return fail(e.message); }
  if (!r.view) return fail(`This dataset has no place ${id}.`);
  view = r.view;
  state.placeId = id;
  drawError = state.drawError = null;
  for (const b of $('list').querySelectorAll('button[data-id]')) b.classList.toggle('current', b.dataset.id === id);
  renderCard();
  showCard();
  const vague = vagueFeatures(view);
  mapApi.setPlace(placeFeatures(view), vague);
  state.vague = { marks: vague.features.filter((f) => f.geometry.type === 'Point').length, circles: vague.features.filter((f) => f.geometry.type === 'Polygon').length };
  $('map-key').hidden = false;
  mapApi.setContext(contextFeatures(view, await countries(view), (view.ccodes || []).map((c) => [c, ccodeBoxes?.[c]]).filter(([, b]) => b)));
  showDrafts(visibleDrafts());
  adopt.placeShown(view);
  const mine = drafts.filter((d) => d.placeId === id && d.geojson).map((d) => d.geojson);
  // The place's own geometries and their circles of uncertainty together, so that a circle is seen
  // whole when the place is chosen: a point alone would be fitted at zoom 9, where 25 km is some 650
  // pixels from it.
  const circles = view.fallback?.kind === 'geometry' ? vague.features.filter((f) => f.geometry.type === 'Polygon').map((f) => bboxOf(f.geometry)) : [];
  const box = view.fallback?.bbox ? unionBbox([view.fallback.bbox, ...circles]) : null;
  mapApi.fit(box || (mine.length ? boxOf(mine) : null), view.fallback?.kind === 'ccodes' ? 6 : 9);
  $('draw-tools').hidden = false;
  state.phase = 'place';
}

/**
 * The card of the place chosen, brought into view: beside the map, where the panel scrolls on its own, by
 * scrolling the panel alone, so that the page and the map stay where they are; with the panel under the
 * map (a narrow column), by scrolling the page to it.
 */
function showCard() {
  const panel = $('panel'), card = $('card'), behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (getComputedStyle(panel).overflowY !== 'visible') panel.scrollBy({ top: card.getBoundingClientRect().top - panel.getBoundingClientRect().top, behavior });
  else card.scrollIntoView({ block: 'start', behavior });
}

// The outlines of a place's countries, from Natural Earth on this site, fetched once when first needed.
let countriesFc = null, ccodeBoxes = null;
async function countries(v) {
  if (v.geometries.length || v.fallback?.kind !== 'ccodes' || !v.ccodes?.length) return [];
  try {
    countriesFc ??= await (await fetch('./basemap/countries.geojson')).json();
    ccodeBoxes ??= await (await fetch('./basemap/ccodes.json')).json();
  } catch { return []; }
  return countriesFc.features.filter((f) => v.ccodes.includes(f.properties?.iso));
}

function renderCard() {
  const v = view, card = $('card');
  card.hidden = false;
  const fb = v.fallback || {};
  // A location given only relative to other places is recorded, and has nothing to draw.
  const none = v.relative?.length ? 'Located only relative to other places' : 'No location recorded';
  const where = v.geometries.length ? ''
    : fb.kind === 'related' ? `<p class="note">${none}; showing the places it is related to.</p>`
    : fb.kind === 'ccodes' ? `<p class="note">${none}; showing its countr${v.ccodes.length === 1 ? 'y' : 'ies'} (${esc(v.ccodes.join(', '))}).</p>`
    : `<p class="note">${none}, and nothing to place it by.</p>`;
  const list = (items, fn) => (items.length ? `<ul>${items.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>');
  const mine = drafts.filter((d) => d.placeId === v.id);
  card.innerHTML = `<h2 id="chora-card-h">${esc(v.label)}</h2>
    <p class="muted place-id">${esc(v.id)}${v.ccodes.length ? ` · ${esc(v.ccodes.join(', '))}` : ''}</p>${where}
    <h3>Names</h3>${list(v.names, nameItem)}
    <h3>Types</h3>${list(v.types, (x) => `${esc(x.label || '')}${badge(x.status)}`)}
    <h3>Locations</h3>${locations(v)}
    <h3>Related places</h3>${list(v.relations, relationItem)}
    <h3>Over time</h3>${timeline(v.timeline)}
    <h3>Sources</h3>${list(v.sources, (s) => (s.id && /^https?:/.test(s.id) ? `<a href="${esc(s.id)}" rel="noopener noreferrer">${esc(s.title || s.id)}</a>` : esc(s.title || s.id)))}
    ${v.withdrawn ? `<p class="muted">${n(v.withdrawn)} withdrawn attestation${v.withdrawn === 1 ? '' : 's'} not shown.</p>` : ''}
    <h3>Gazetteer</h3>
    <p><button type="button" id="adopt-find"${isPlaceIri(v.id) ? '' : ' disabled aria-describedby="adopt-why"'}>${esc(CHORA_ADOPT_PAGE.find)}</button>${isPlaceIri(v.id) ? '' : ` <span class="muted" id="adopt-why">${esc(CHORA_ADOPT_PAGE.noAddress)}</span>`}</p>
    <h3>Your drawings</h3>
    <p class="muted">Draw with the tools on the map. Each drawing is added as a new attestation of this place; nothing already there is changed.</p>
    ${drawError ? `<p class="warn" id="chora-draw-error">${esc(drawError)}</p>` : ''}
    <ul class="pending">${mine.map(pendingItem).join('') || '<li class="muted">None yet.</li>'}</ul>`;
}
function pendingItem(d) {
  // An adoption (two attestations, or one when the place was already linked): removed whole, never in part.
  if (d.kind === 'adoption') {
    return `<li data-draft="${esc(d.id)}" data-adoption><span class="kind">${esc(CHORA_ADOPT_PAGE.pendingItem(d.candidate.name || d.candidate.id))}</span>
    <span class="muted">${esc(d.candidate.iri || d.candidate.id)}${d.feature ? `, ${esc(d.feature.geometry.type)}` : ''} · ${d.count === 1 ? 'the location' : 'the identity and the location'}</span>
    <button type="button" data-remove>Remove</button></li>`;
  }
  const opt = (vals, cur, words) => vals.map((x) => `<option value="${x}"${x === cur ? ' selected' : ''}>${esc(words(x))}</option>`).join('');
  // A drawing traced from a historical map may mark where the map writes the name (a label anchor).
  const roles = ['Extent', 'FeaturePoint', 'RepresentativePoint', ...(d.trace ? ['LabelAnchor'] : [])].filter((r) => ROLES.includes(r));
  const from = d.traceOptions?.length || d.trace
    ? `<label>Traced from <select data-field="tracedFrom">${[...(d.traceOptions || []).filter((o) => o.key !== d.trace?.key), ...(d.trace ? [{ key: d.trace.key, title: d.trace.title }] : [])]
      .map((o) => `<option value="${esc(o.key)}"${o.key === d.trace?.key ? ' selected' : ''}>${esc(o.title || 'a historical map')}</option>`).join('')}<option value=""${d.trace ? '' : ' selected'}>the basemap</option></select></label>` : '';
  return `<li data-draft="${esc(d.id)}"><span class="kind">${esc(KIND[d.geojson.type] || d.geojson.type)}</span>
    ${from}
    <label>What it marks <select data-field="role"><option value="">Not said</option>${opt(roles, d.role, (r) => (r === 'LabelAnchor' ? 'where the map writes its name' : ROLE_WORDS[r] || r))}</select></label>
    <label>How well known <select data-field="precision"><option value="">Not said</option>${opt(PRECISIONS, d.precision, (p) => p.replace('_', ' '))}</select></label>
    ${d.trace?.assisted ? `<p class="muted" data-assisted>Traced with assistance from: ${esc(d.trace.title || 'a historical map')}${d.trace.assisted.fromKey != null && d.trace.assisted.fromKey !== d.trace.key ? ` (proposed from the ink of: ${esc(d.trace.assisted.from || 'another map')})` : ''}</p>` : d.assistedUncited ? `<p class="muted" data-assisted>Proposed from the ink of: ${esc(d.assistedUncited.from || 'a historical map')} (not cited)</p>` : ''}
    ${d.traceNote ? `<p class="note" data-trace-note>${esc(d.traceNote)}</p>` : ''}
    ${d.consulted ? `<p class="note" data-consulted>${esc(CHORA_ADOPT_PAGE.consultedItem(d.consulted.name || d.consulted.record))}</p>` : ''}
    <button type="button" data-remove>Remove</button></li>`;
}
const KIND = { Point: 'A point', LineString: 'A line', Polygon: 'An area' };
function cardClicked(e) {
  if (e.target.closest('#adopt-find')) { if (view) adopt.openFor(view); return; }
  const a = e.target.closest('a[data-place]');
  if (a) { e.preventDefault(); selectPlace(a.dataset.place); return; }
  const rm = e.target.closest('button[data-remove]');
  if (rm) removeDraft(rm.closest('[data-draft]').dataset.draft);
}
function cardChanged(e) {
  const sel = e.target.closest('select[data-field]');
  if (!sel) return;
  const d = drafts.find((x) => x.id === sel.closest('[data-draft]').dataset.draft);
  if (!d) return;
  if (sel.dataset.field === 'tracedFrom') {
    // Chosen by the user: another map it lies on, or the basemap (no citation of any map).
    if (sel.value) traceDraft(d, { only: sel.value });
    else { dropTrace(d, null); keepDrafts(); renderCard(); }
    return;
  }
  // Chosen by the user: no longer the default a traced point was given.
  d[sel.dataset.field] = sel.value; d.defaulted = false; keepDrafts();
}

// ---- Drawing -------------------------------------------------------------------------------------
function onFinish(id, ctx) {
  const f = mapApi.draw?.getSnapshotFeature(id);
  if (!f) return;
  const existing = drafts.find((d) => d.id === String(id));
  if (!existing && ctx?.action && ctx.action !== 'draw') return;
  // A drawing with no place chosen is let go, unless a map is being traced into a new dataset: it is a new place, named next.
  const feature = !existing && !state.placeId && !!traceKey;
  if (!existing && !state.placeId && !feature) { mapApi.draw.removeFeatures([id]); return; }
  // Drawn on a copy of the world, east or west of it, its longitudes run past 180: it is brought back
  // onto the world, whole, and checked as the save will check it. One across the antimeridian cannot
  // be a PLATO geometry as drawn; it is not kept (or, moved there, goes back), and the card says why.
  const geojson = wrapLongitudes(f.geometry);
  try { checkGeoJSON(geojson); } catch (e) {
    if (!(e instanceof DrawError)) throw e;
    drawError = state.drawError = `${KIND[f.geometry.type] || 'A drawing'} ${existing ? 'moved' : 'drawn'} for ${existing?.placeLabel || view?.label || (feature ? 'a new place' : 'this place')} was not kept. ${e.message}`;
    setTimeout(() => { try { if (existing) mapApi.draw?.updateFeatureGeometry(id, existing.geojson); else mapApi.draw?.removeFeatures([id]); } catch {} });
    if (view) renderCard();
    if (feature || existing?.kind === 'feature') renderTrace();
    return;
  }
  if (geojson !== f.geometry) setTimeout(() => { try { mapApi.draw?.updateFeatureGeometry(id, geojson); } catch {} });
  drawError = state.drawError = null;
  if (existing) {   // moved or reshaped: a traced drawing is traced again from its map, or no longer cites it
    existing.geojson = geojson; keepDrafts();
    if (existing.trace) traceDraft(existing, { only: existing.trace.key, reshaped: true });
    return;
  }
  const d = feature ? newFeatureDraft(id, geojson) : newDraft(id, geojson);
  if (layers?.entries.length) traceDraft(d);
  if (feature) attachOrOpen(d.id);
}
/** A drawing made now (by hand, or accepted from a trace), for the place chosen: kept, and listed. */
function newDraft(id, geojson, extra = {}) {
  // The basemap drawn on goes into the published notes: a built-in one by name, a pasted one not (its site may be private).
  const d = { id: String(id), placeId: state.placeId, placeLabel: view?.label || '', geojson, role: '', precision: '',
    basemap: basemaps.drawnOn(basemaps.byId(state.basemap)), zoom: mapApi.zoom(), drawnAt: new Date().toISOString(), ...extra };
  // A record consulted and not copied (adopt-ui.js "Draw it yourself"): the next drawing of its place cites it.
  if (consultArmed && consultArmed.placeId === d.placeId) { const { placeId, ...c } = consultArmed; d.consulted = c; consultArmed = null; state.consultArmed = null; }
  drafts.push(d);
  keepDrafts();
  renderCard();
  return d;
}

// ---- Tracing from a historical map ---------------------------------------------------------------
// A drawing made over a historical map is traced from it (src/engine/chora/trace.js): the topmost map
// shown that holds it whole, else the topmost holding part of it (with a warning); the card lets the
// user choose another map it lies on, or the basemap. Its citations are made when it is saved. A point
// traced is, until the user says otherwise, a representative point whose position is approximate.
const traceTickets = new Map();   // draft id -> the latest tracing asked for it (an older answer is let go)
/** The notes shown on a drawing's card: what accepting it did, then what tracing it says (either may be none). */
const joinNotes = (d, note) => [d.acceptNote, note].filter(Boolean).join(' ') || null;
function dropTrace(d, note) {
  // A shape proposed from a map's ink is still that, cited from the map or not: what was proposed is kept
  // (its notes say it, and that the map is not cited), and is cited again if it is traced from the map again.
  const assisted = d.trace?.assisted || d.assistedPending || d.assistedUncited || null;
  // `from` is the map it was proposed from (kept as it is); `cited` the map whose citation is dropped.
  if (assisted) d.assistedUncited = { ...assisted, from: assisted.from ?? d.trace?.title ?? null, cited: d.trace?.title ?? assisted.cited ?? null, citedKey: d.trace?.key ?? assisted.citedKey ?? null };
  delete d.assistedPending;
  d.trace = null; d.traceNote = joinNotes(d, note);
  if (d.role === 'LabelAnchor') d.role = '';
  // The defaults were for a point traced from a map: drawn on the basemap, it says nothing of itself.
  if (d.defaulted && d.kind !== 'feature') { d.role = ''; d.precision = ''; d.defaulted = false; }
}
async function traceDraft(d, { only = null, reshaped = false } = {}) {
  const ticket = {}; traceTickets.set(d.id, ticket);
  const shown = layers ? layers.ordered() : [];
  const maps = shown.map((e) => ({ key: e.key, g: e.g, visible: e.visible, title: e.title }));
  const was = d.trace;
  let note = null;
  try {
    if (reshaped && was) {
      // Moved or reshaped: the maps it lies on now are offered, and it stays with its map while that map
      // holds any of it; moved off that map onto another, it is traced from the other (trace.js afterReshape).
      const all = await tracing.pickOverlay(maps, d.geojson);
      if (traceTickets.get(d.id) !== ticket || !drafts.includes(d)) return;
      d.traceOptions = all.candidates.map((k) => ({ key: k, title: maps.find((m) => m.key === k)?.title || null }));
      only = tracing.afterReshape(all, was.key) || was.key;   // on none: asked of its own map, which says it moved off
    }
    const pick = await tracing.pickOverlay(only ? maps.filter((m) => m.key === only) : maps, d.geojson);
    if (traceTickets.get(d.id) !== ticket || !drafts.includes(d)) return;
    if (!only) d.traceOptions = pick.candidates.map((k) => ({ key: k, title: maps.find((m) => m.key === k)?.title || null }));
    const skipped = pick.skipped.map((x) => `${maps.find((m) => m.key === x.key)?.title || 'a map'}: ${x.reason}`).join(' ');
    if (!pick.chosen) {
      if (was) note = `${reshaped ? 'Moved' : 'It lies'} off “${was.title || 'the map'}”, the map it was traced from, so it no longer cites that map${skipped ? ` (${skipped})` : ''}; ${was.assisted ? 'its notes say it was proposed from that map\'s ink, and that the map is not cited.' : 'it is saved as drawn on the basemap.'}`;
      else if (skipped) note = `Not cited as traced from a historical map: ${skipped}`;
      dropTrace(d, note);
    } else {
      const e = shown.find((x) => x.key === pick.chosen.key);
      try {
        const t = await tracing.traceFor(e.g, d.geojson, { key: e.key, title: e.title, partial: pick.chosen.partial, fetchedAt: e.fetchedAt, licence: e.attribution?.licence || null });
        if (traceTickets.get(d.id) !== ticket || !drafts.includes(d)) return;
        // A shape traced with assistance keeps what was proposed, traced again or not (its notes count the edits).
        const back = d.assistedUncited ? (({ cited, citedKey, ...rest }) => rest)(d.assistedUncited) : null;
        const assisted = was?.assisted || d.assistedPending || back || null;
        d.trace = assisted ? { ...t, assisted } : t;
        delete d.assistedPending; delete d.assistedUncited;
        d.traceNote = joinNotes(d, pick.chosen.partial ? `Part of it lies outside “${e.title}”, the map it is cited as traced from.` : null);
        if (!d.traceOptions?.some((o) => o.key === e.key)) d.traceOptions = [...(d.traceOptions || []), { key: e.key, title: e.title }];
        if (d.geojson.type === 'Point' && !d.role && !d.precision) Object.assign(d, tracing.TRACED_POINT_DEFAULTS, { defaulted: true });
      } catch (err) {
        if (err instanceof tracing.TraceError && !reshaped && !was) {
          // A drawing that cannot be placed back where it was drawn through the map is not kept.
          drawError = state.drawError = err.message;
          removeDraft(d.id);
          return;
        }
        if (!(err instanceof tracing.TraceError || err instanceof DataError)) throw err;
        dropTrace(d, `Not cited as traced from “${e.title}”: ${err.message}`);
      }
    }
  } catch (err) {
    if (!(err instanceof DataError)) { console.warn('Chora: tracing', err); return; }
    dropTrace(d, `Not cited as traced from a historical map: ${err.message}`);
  }
  state.lastTrace = { draftId: d.id, key: d.trace?.key || null, partial: !!d.trace?.partial, note: d.traceNote || null, options: (d.traceOptions || []).map((o) => o.key), role: d.role || null, precision: d.precision || null };
  keepDrafts();
  if (view) renderCard();
  if (d.kind === 'feature') renderTraced();
}
// Adoptions are not drawings: they are not given to the drawing tool (adopt-ui.js shows them).
function showDrafts(list) {
  showing = true;
  const t0 = performance.now();
  try { mapApi.showDrafts(list.filter((d) => d.kind !== 'adoption')); } finally { showing = false; }
  // How long the drawings took to be given to the drawing tool, and how many: for the measurements of scale (DEVELOPERS.md, Limits).
  state.lastShow = { count: list.length, ms: Math.round(performance.now() - t0) };
}
/** The drawings shown: the place chosen's, and every feature traced into the dataset, all at once. */
const visibleDrafts = () => drafts.filter((d) => d.kind !== 'adoption' && (d.kind === 'feature' || (state.placeId && d.placeId === state.placeId)));
let consultArmed = null;   // { placeId, record, name, … }: the next drawing of that place cites the record as consulted
/** An adoption, kept with the drawings until saved (one draft: its attestations go, and are removed, together). */
function addAdoption(d) { drafts.push(d); keepDrafts(); renderCard(); }
function removeDraft(id) {
  const wasAdoption = drafts.some((d) => d.id === id && d.kind === 'adoption');
  const was = drafts.find((d) => d.id === id);
  drafts = drafts.filter((d) => d.id !== id);
  if (!wasAdoption) try { mapApi.draw?.removeFeatures([id]); } catch {}
  // A place traced goes with its first drawing: what was added to it goes too.
  if (was?.kind === 'feature' && was.placeId && !was.part) for (const p of drafts.filter((d) => d.kind === 'feature' && d.part && d.placeId === was.placeId)) { drafts = drafts.filter((d) => d !== p); try { mapApi.draw?.removeFeatures([p.id]); } catch {} }
  if (naming?.draftId === id) closeNaming();
  keepDrafts();
  if (view) renderCard();
  if (was?.kind === 'feature') { renderTraced(); renderTrace(); }
  if (wasAdoption) adopt.showAdopted();
}
function keepDrafts() {
  // The file last written holds the drawings as they were: once they change, it is not offered.
  if (offered) {
    offered.remove(); offered = null;
    $('save-result').insertAdjacentHTML('beforeend', '<p class="warn">The drawings have changed since that file was written, so it is no longer offered: save again to have them all.</p>');
  }
  state.pendingCount = drafts.length;
  // Written in turn, asynchronously (drafts.js): draftWrites counts those not yet on disk, for tests to wait on.
  if (fp) {
    state.draftWrites = (state.draftWrites || 0) + 1;
    const t0 = performance.now(), count = drafts.length;
    // How long the write of every drawing kept took, queue and all, and of how many (DEVELOPERS.md, Limits).
    saveDrafts(fp, drafts).finally(() => { state.draftWrites--; state.lastDraftWrite = { count, ms: Math.round(performance.now() - t0) }; });
  }
  showSaving();
}
function drawToolsClicked(e) {
  // A Trace button not yet usable says why in its tooltip (aria-disabled, not disabled, so that it can be focused and its tooltip read).
  const t = e.target.closest('button[data-trace]');
  if (t) { if (t.getAttribute('aria-disabled') !== 'true') setTraceMode(t.getAttribute('aria-pressed') === 'true' ? null : t.dataset.trace); return; }
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  if (traceWanted) setTraceMode(null);
  mapApi.setMode(b.dataset.mode);
  for (const x of $('draw-tools').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b && b.dataset.mode !== 'static'));
  // Snapping to the ink is offered while drawing a line or an area by hand over a historical map.
  $('snap-ink-label').hidden = !['linestring', 'polygon'].includes(b.dataset.mode) || !traceReady();
  // Snapping is not built again while it is not offered (ink.js): back to drawing with it on, it is built for this view.
  if (!$('snap-ink-label').hidden && $('snap-ink').checked && inkTools) inkTools.setSnap(true);
}

// ---- Tracing with assistance (src/chora/ink.js, loaded when first wanted) ------------------------------
// "Trace area" and "Trace line" propose a shape from a historical map's own pixels; they are offered once
// a map shown has drawn a tile (its image server lets this page read it), and say why not until then.
let inkTools = null, inkLoading = null;
function loadInk() {
  inkLoading ??= import('./ink.js').then((m) => (inkTools = m.createInk({ mapApi, state, overlayAt, onAccept: acceptTraced, panel: $('ink-panel') })))
    .catch((e) => { inkLoading = null; throw e; });
  return inkLoading;
}
const traceReady = () => state.overlays.some((o) => o.visible && o.firstTile);
/** The map shown at a place (the topmost whose mask holds it, of those drawn), or null. */
async function overlayAt(lngLat) {
  if (!layers) return null;
  const drawn = layers.ordered().filter((e) => e.visible && state.overlays.find((o) => o.key === e.key)?.firstTile);
  const pick = await tracing.pickOverlay(drawn.map((e) => ({ key: e.key, g: e.g, visible: true })), { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] });
  return pick.chosen ? drawn.find((e) => e.key === pick.chosen.key) || null : null;
}
function updateTraceButtons() {
  const ready = traceReady();
  const failed = state.overlays.find((o) => o.visible && !o.firstTile && o.tileErrors);
  const why = ready ? null : failed ? `The image of “${failed.title}” could not be read from ${failed.origin}, so it cannot be traced` : 'Show a historical map to trace from it';
  for (const b of $('draw-tools').querySelectorAll('button[data-trace]')) {
    b.setAttribute('aria-disabled', String(!ready));
    b.dataset.tip = why || (b.dataset.trace === 'area' ? 'Click inside an area of the map: its outline is proposed' : 'Click on a line of the map: it is followed both ways and proposed');
  }
  state.traceReady = ready; state.traceWhy = why;
  if (!ready && traceWanted) setTraceMode(null);
  if (!ready) $('snap-ink-label').hidden = true;
}
// The trace tool pressed ('area' | 'line' | null), from the press itself. ink.js, which does the tracing, is
// loaded by the first press, and until it has arrived (a fetch: tens of milliseconds, or more on a slow
// connection) the tool is wanted but not yet able: a click on the map meanwhile waits for it (below) rather
// than being lost, and the tool set once it has arrived is the one wanted then, not the one pressed first.
let traceWanted = null;
async function setTraceMode(m) {
  traceWanted = m;
  for (const x of $('draw-tools').querySelectorAll('button')) x.setAttribute('aria-pressed', String(!!m && x.dataset.trace === m));
  $('snap-ink-label').hidden = true;
  mapApi.setMode('static');
  mapApi.setTracing(!!m);
  if (!m && !inkTools) return;
  try { const tools = await loadInk(); tools.setMode(traceWanted); } catch (e) { drawError = state.drawError = `Tracing could not start (${e.message}).`; if (view) renderCard(); }
}
const snapChanged = async (e) => { try { (await loadInk()).setSnap(e.target.checked); } catch {} };
/**
 * A proposal accepted: an ordinary drawing, cited from the map it was traced from, its round trip checked.
 * Returns null when it is a drawing now, else why not in words (the proposal is then kept).
 */
function acceptTraced({ geometry, key, assisted, note }) {
  // With no place chosen, while a map is traced into a new dataset, the shape is a new place, named next (decision 2).
  const feature = !state.placeId && !!traceKey;
  if (!state.placeId && !feature) return 'Choose a place first (a drawing is added to the place chosen), then press Enter again: the proposal is kept until then.';
  const [res] = mapApi.draw.addFeatures([{ type: 'Feature', geometry, properties: { mode: geometry.type === 'Polygon' ? 'polygon' : 'linestring' } }]);
  if (!res?.valid) { drawError = state.drawError = `The shape could not be made a drawing (${res?.reason || 'refused'}).`; if (view) renderCard(); return drawError; }
  // What accepting did to it (its holes left out) is kept apart from what tracing says, so neither replaces the other.
  const extra = { assistedPending: assisted, ...(note ? { acceptNote: note, traceNote: note } : {}) };
  const d = feature ? newFeatureDraft(res.id, geometry, extra) : newDraft(res.id, geometry, extra);
  traceDraft(d, { only: key });
  if (feature) attachOrOpen(d.id);
  return null;
}

// ---- Tracing a historical map into a new dataset (src/chora/traced.js) --------------------------------------
// Stephen's decisions of 14 October 2026. A map shown is traced into a dataset of its own: its settings are
// asked once (the base address, needed; the dataset's title; the map's date, from its navDate; the language of
// its names; what a point, a line and an area mark, and how well), the dataset is made from the map (its seed)
// and opened, and from then on a drawing made with no place chosen is a new place: named in the form over the
// map (the name as written, the label, its kind, its language), Enter, and the next. Every feature traced is
// shown at once, and listed a page at a time. A save adds them as new places (save.js newPlaces), one
// attestation each. Outside a workflow the same; in one at its step "trace", its save does the step.
const keepTracings = () => traced.saveTracing(tracings);
/** A map's settings, by its key, or null. */
const settingsOf = (key) => (key ? tracings.maps[key] || null : null);
/** The map entry shown for a key (overlays' layer manager), or null. */
const mapEntry = (key) => layers?.entries.find((e) => e.key === key) || null;
/** Whether the dataset open is the one made from a map, not yet saved. */
const isSeedOpen = () => !!traceKey && !!tracings.seeds[traceKey];
/** Whether the map `key`, its settings given, is traced into the dataset open (not one made from it): as traceSubmitted decides. */
const intoOpen = (key) => !!dataset && !isSeedOpen() && !tracings.seeds[key] && traceKey !== key;
/** The base address of the dataset open (its uriSpace), or null: the only one a place traced into it is given its address under. */
const openBase = () => traced.datasetBase(dataset?.header);
/** The workflow's step at hand, when it is one done in Chora (host.step: Methodos's), else null. */
const workflowStep = () => { try { return host.step?.() || null; } catch { return null; } };
/** A feature traced now, with no place chosen: a new place, named next (decision 2), given the map's defaults (decision 6). */
function newFeatureDraft(id, geojson, extra = {}) {
  const d = { id: String(id), kind: 'feature', placeId: null, placeLabel: '', names: [], types: [], mapKey: traceKey, geojson, role: '', precision: '',
    ...traced.featureDefaults(settingsOf(traceKey), geojson),
    basemap: basemaps.drawnOn(basemaps.byId(state.basemap)), zoom: mapApi.zoom(), drawnAt: new Date().toISOString(), ...extra };
  drafts.push(d);
  keepDrafts();
  renderTraced(); renderTrace();
  return d;
}

/** The panel "Trace into a new dataset": what to do, the settings form, or the tracing under way. */
function renderTrace() {
  if (!root) return;
  const body = $('trace-body'), step = workflowStep();
  const shown = layers ? layers.entries : [];
  const lines = [];
  if (step?.op === 'trace') lines.push(`<p class="note" id="chora-trace-step">${esc(CHORA_TRACE.workflowStep)}</p>`);
  state.traceRefused = null;
  if (traceEditing) {
    // Fixed once the dataset traced into exists (the one made from the map, or one opened): its address space and
    // title are its file's, written when it was made; changed here they would not be the file's. Traced into the
    // dataset open, its base is its own uriSpace, never Options' (refused in words when it has none).
    const started = traceKey === traceEditing && !!dataset, into = intoOpen(traceEditing);
    state.traceRefused = into && !openBase() ? CHORA_TRACE.noOpenBase(dataset.header?.title || dataset.input?.name || '') : null;
    if (state.traceRefused) {
      body.innerHTML = lines.join('') + `<p class="warn" id="chora-trace-refused">${esc(state.traceRefused)}</p><p><button type="button" id="chora-tset-cancel">Cancel</button></p>`;
      publishTrace();
      return;
    }
    const was = settingsOf(traceEditing) || traced.defaultSettings(defaultsFor(traceEditing));
    const s = (started || into) && openBase() ? { ...was, base: openBase() } : was;
    body.innerHTML = lines.join('') + traced.settingsForm(s, { started, into, fileTitle: started || into ? dataset.header?.title || null : null,
      identify: step?.op === 'trace' && step.answers?.['will-identify'] === true });
    publishTrace();
    return;
  }
  if (traceKey) {
    const s = settingsOf(traceKey) || {};
    const features = drafts.filter((d) => d.kind === 'feature');
    const named = new Set(features.filter((d) => d.placeId).map((d) => d.placeId)).size, unnamed = features.filter((d) => !d.placeId).length;
    lines.push(`<p id="chora-trace-status">${esc(CHORA_TRACE.tracing(s.mapTitle || 'a historical map', dataset?.header?.title || s.datasetTitle || '', named, unnamed))}</p>`,
      `<p class="muted">${esc(CHORA_TRACE.howTo)}</p>`,
      ...(s.rightsWords ? [`<p class="${/^Free to reuse/.test(s.rightsWords) ? 'muted' : 'note'}" id="chora-trace-rights">${esc(s.rightsWords)}</p>`] : []),
      ...(state.traceScope ? [`<p class="note" id="chora-trace-scope">${esc(state.traceScope.words)}</p>`] : []),
      ...(mapEntry(traceKey) ? [] : [`<p class="warn">${esc(CHORA_TRACE.mapGone(s.mapTitle || ''))}</p>`]),
      `<p><button type="button" id="chora-trace-new" class="primary">${esc(CHORA_TRACE.newPlace)}</button> <button type="button" id="chora-trace-settings">${esc(CHORA_TRACE.changeSettings)}</button> <button type="button" id="chora-trace-stop">${esc(CHORA_TRACE.stopTracing)}</button></p>`);
  } else {
    lines.push(`<p class="muted">${esc(shown.length ? CHORA_TRACE.intro : CHORA_TRACE.noMap)}</p>`);
    // A dataset made from a map and not yet saved, with nothing open: offered again (in a workflow at its step, opened at once: resumeSeed).
    const key = tracings.current, seed = key && tracings.seeds[key];
    if (seed && !dataset) lines.push(`<p><button type="button" id="chora-trace-resume">${esc(CHORA_TRACE.resume(settingsOf(key)?.mapTitle || ''))}</button></p>`);
  }
  body.innerHTML = lines.join('');
  publishTrace();
}
/** What the tracing is, for automated tests (window.__chora.trace); nothing else reads it. */
function publishTrace() {
  const features = drafts.filter((d) => d.kind === 'feature');
  const s = settingsOf(traceKey);
  state.trace = { key: traceKey, editing: traceEditing, seed: isSeedOpen(), mapTitle: s?.mapTitle ?? null, base: s?.base ?? null, settings: s,
    features: features.length, named: new Set(features.filter((d) => d.placeId).map((d) => d.placeId)).size, unnamed: features.filter((d) => !d.placeId).length };
  state.naming = naming ? { ...naming } : null;
}
/** A map's settings before the user gives any: from the map shown (its title, manifest and rights), with Options' base address. */
function defaultsFor(key) {
  const e = mapEntry(key);
  return { key, title: e?.title || settingsOf(key)?.mapTitle || '', manifest: e?.manifest || null, rights: e?.rights || null, base: host.base?.() || '' };
}
/** "Trace into a new dataset" (or into the dataset open), for the map `key`: its settings form. */
function beginSettings(key) {
  traceEditing = key;
  renderTrace(); renderMaps();
  $('trace').scrollIntoView({ block: 'nearest' });
  $('tset-base')?.focus();
}
function traceClicked(e) {
  if (e.target.id === 'chora-trace-new') newPlace();
  else if (e.target.id === 'chora-trace-settings') beginSettings(traceKey);
  else if (e.target.id === 'chora-trace-stop') stopTracing();
  else if (e.target.id === 'chora-trace-resume') resumeSeed({ asked: true });
  else if (e.target.id === 'chora-tset-cancel') { traceEditing = null; renderTrace(); renderMaps(); }
}
function traceInput(e) {
  // The script is asked only where the language implies one that is not Latin (decision 3): asked again as it is typed.
  if (e.target.id === 'chora-tset-lang') $('tset-script-box').innerHTML = traced.scriptChoice('chora-tset-script', e.target.value.trim(), '');
}
/** Not traced into from now: drawings with no place chosen are let go again, as before; the drawings made stay. */
function stopTracing() {
  if (fp) { delete tracings.open[fp]; keepTracings(); }
  traceKey = null; closeNaming();
  renderTrace(); renderTraced(); renderMaps();
}
async function traceSubmitted(e) {
  e.preventDefault();
  const key = traceEditing, f = $('trace-form');
  if (!key || !f) return;
  const v = (id) => $(id)?.value ?? '';
  const values = { base: v('tset-base'), datasetTitle: v('tset-title'), date: v('tset-date'), dateEach: !!$('tset-date-each')?.checked, language: v('tset-lang'), script: v('tset-script'),
    pointRole: v('tset-point-role'), pointPrecision: v('tset-point-precision'), lineRole: v('tset-line-role'), linePrecision: v('tset-line-precision'),
    areaRole: v('tset-area-role'), areaPrecision: v('tset-area-precision'), precisionKm: v('tset-km'), outline: !!$('tset-outline')?.checked };
  const was = settingsOf(key) || traced.defaultSettings(defaultsFor(key));
  // Into the dataset open, or that one traced into already: its own base, whatever the field (or Options) says.
  const into = intoOpen(key);
  if (into && !openBase()) return;   // refused in words in the panel, with no form to submit
  const r = traced.settingsFrom(values, was, { fixedBase: (into || traceKey === key) && dataset ? openBase() : null });
  if (r.error) { Object.assign($('tset-error'), { hidden: false, textContent: r.error }); state.traceError = r.error; return; }
  state.traceError = null;
  tracings.maps[key] = r.settings; tracings.current = key; keepTracings();
  // The base address has one store: Options' (decision 8), written as if typed there.
  host.setBase?.(r.settings.base);
  traceEditing = null;
  if (traceKey === key) { renderTrace(); renderTraced(); renderMaps(); return; }   // the settings changed, the tracing goes on
  // Into the dataset open (one saved from a tracing before, opened again, or any other): traced into from now, under its own base.
  if (into) {
    traceKey = key; tracings.open[fp] = key; keepTracings();
    $('draw-tools').hidden = false; renderTrace(); renderTraced(); renderMaps(); await outlineScope(key);
    return;
  }
  // A dataset of its own, made from the map: the one made before (with what was traced on it) if it has not been saved, else a new one.
  const kept = tracings.seeds[key];
  let seed = kept;
  if (!kept || !(await loadDrafts(fingerprint([seedAsFile(kept)]))).length) seed = traced.seedFile(r.settings);
  tracings.seeds[key] = seed; keepTracings();
  const file = seedAsFile(seed);
  await open([file], { traceKey: key });
  // Chosen in "Choose your data", and kept there as the user's own choice is.
  host.choose?.([file]); host.keep?.([file]);
  renderMaps();
  await outlineScope(key);
}
const seedAsFile = (seed) => new File([seed.text], seed.name, { type: 'application/json', lastModified: seed.lastModified });
/**
 * In a workflow that looks the places up, the sheet's outline made the lookup's area Scope (decision 10): set
 * when the user leaves it ticked, said in the panel and shown in the tracker's Scope line, never silently.
 */
async function outlineScope(key) {
  const step = workflowStep(), s = settingsOf(key), e = mapEntry(key);
  if (step?.op !== 'trace' || step.answers?.['will-identify'] !== true || !s?.outline || !e || !host.setScopeArea) return;
  try {
    const o = await tracing.sheetOutline(e.g);
    const ok = host.setScopeArea(o.area);
    state.traceScope = ok ? { corners: o.corners, from: o.from, words: CHORA_TRACE.scopeSet(o.corners) } : null;
  } catch (err) { state.traceScope = { corners: 0, words: CHORA_TRACE.scopeNot(err.message) }; }
  renderTrace();
}
/**
 * The dataset made from the map last traced, and not yet saved, opened again (the very file: the drawings kept under
 * its fingerprint come back with it): at a workflow's step "trace" with nothing open, at once; elsewhere when asked.
 */
async function resumeSeed({ asked = false } = {}) {
  if (dataset || files.length || state.phase === 'in-another-tab') return;
  const key = tracings.current, seed = key && tracings.seeds[key];
  if ((!asked && workflowStep()?.op !== 'trace') || !seed) return;
  const file = seedAsFile(seed);
  await open([file], { traceKey: key });
  host.choose?.([file]);
}

// The name form, over the map (decision 2): a drawing with no place chosen opens it; Enter adds the place, Cancel lets
// the drawing go; a drawing may instead be added to the place last named. "New place" opens it with nothing drawn yet.
function openNaming(draftId, { editing = false } = {}) {
  const d = draftId ? drafts.find((x) => x.id === draftId) : null;
  const s = settingsOf(traceKey) || {};
  const last = lastNamed && drafts.find((x) => x.kind === 'feature' && x.placeId === lastNamed && !x.part);
  const name = d?.names?.[0];
  naming = { draftId: d ? d.id : null, editing };
  const what = editing ? CHORA_TRACE.whatEdit(d.placeLabel || name?.toponym || '') : !d ? CHORA_TRACE.whatNone
    : /Point$/.test(d.geojson.type) ? CHORA_TRACE.whatPoint : /LineString$/.test(d.geojson.type) ? CHORA_TRACE.whatLine : CHORA_TRACE.whatArea;
  const language = name?.language ?? s.language ?? '';
  $('name-panel').innerHTML = traced.nameForm({ what, toponym: name?.toponym || '', label: editing ? d.placeLabel : '', kind: editing ? d.types?.[0]?.label || '' : s.lastKind || '',
    language, script: name?.script || (scriptOf(language) ? s.script : ''), romanized: name?.romanized || '', addTo: d && !editing && last && last.id !== d.id ? last.placeLabel : null, editing });
  $('name-panel').hidden = false;
  publishTrace();
  $('name-toponym').focus();
}
/** A drawing made while the form waits for one ("New place"): it is the form's, and what was typed stays; else the form opens for it. */
function attachOrOpen(id) {
  if (naming && !naming.draftId && !naming.editing) {
    naming.draftId = id;
    const d = drafts.find((x) => x.id === id);
    $('name-what').textContent = /Point$/.test(d.geojson.type) ? CHORA_TRACE.whatPoint : /LineString$/.test(d.geojson.type) ? CHORA_TRACE.whatLine : CHORA_TRACE.whatArea;
    $('name-error').hidden = true;
    publishTrace();
    $('name-toponym').focus();
    return;
  }
  openNaming(id);
}
function closeNaming() {
  naming = null;
  if (root) { $('name-panel').hidden = true; $('name-panel').replaceChildren(); }
  if (state) publishTrace();
}
/** "New place": no place chosen, the form open, the drawing to come (decision 2). */
function newPlace() {
  if (state.placeId) {
    state.placeId = null; view = null;
    for (const b of $('list').querySelectorAll('button[data-id]')) b.classList.remove('current');
    $('card').hidden = true; adopt.close(); mapApi.setPlace(null); mapApi.setContext(null);
    showDrafts(visibleDrafts());
  }
  openNaming(null);
}
function namingInput(e) {
  if (e.target.id === 'chora-name-lang') {
    const lang = e.target.value.trim();
    $('name-script-box').innerHTML = traced.scriptChoice('chora-name-script', lang, '');
    $('name-roman-box').hidden = !scriptOf(lang);
  }
  if (e.target.id === 'chora-name-script') $('name-roman-box').hidden = e.target.value === 'Latn';
}
function namingError(words) { Object.assign($('name-error'), { hidden: false, textContent: words }); state.namingError = words; }
async function namingSubmitted(e) {
  e.preventDefault();
  if (!naming) return;
  const d = naming.draftId ? drafts.find((x) => x.id === naming.draftId) : null;
  const toponym = $('name-toponym').value.trim();
  if (!toponym) { namingError(CHORA_TRACE.needName); return; }
  if (!d) { namingError(CHORA_TRACE.needDrawing); return; }
  const language = $('name-lang').value.trim();
  if (language && !/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(language)) { namingError(CHORA_TRACE.badLanguage(language)); return; }
  const script = $('name-script')?.value || '';
  const romanized = $('name-roman-box').hidden ? '' : $('name-romanized').value;
  const label = $('name-label').value.trim() || toponym;
  const kind = $('name-kind').value.trim();
  const s = settingsOf(d.mapKey || traceKey);
  // Its address, minted under the base address once (decision 8), by the address scheme, distinct from every other:
  // the dataset traced into's own (its uriSpace; the seed's is the settings' base), never the settings' or Options'.
  if (!d.placeId) {
    const base = dataset ? openBase() : s?.base;
    if (!base) { namingError(CHORA_TRACE.noOpenBase(dataset?.header?.title || dataset?.input?.name || '')); return; }
    try {
      const taken = drafts.filter((x) => x.kind === 'feature' && x.placeId).map((x) => x.placeId);
      d.placeId = (await request({ cmd: 'chora-mint', base, label, romanized: romanized || undefined, taken }, 'chora-minted')).id;
    } catch (err) { namingError(err.message); return; }
  }
  d.names = [traced.nameOf({ toponym, language, script: scriptOf(language) ? script : '', romanized })];
  d.types = kind ? [kindType(kind)] : [];
  d.placeLabel = label; delete d.part;
  if (s && !naming.editing) { s.lastKind = kind; keepTracings(); }   // the last kind chosen is the next default (decision 7)
  lastNamed = d.placeId;
  state.lastNamed = { placeId: d.placeId, label };
  closeNaming();
  keepDrafts(); renderTraced(); renderTrace();
}
/** The drawing added to the place last named instead (a label's position, say): one more geometry of its one attestation. */
function namingAddTo() {
  const d = naming?.draftId && drafts.find((x) => x.id === naming.draftId);
  const to = lastNamed && drafts.find((x) => x.kind === 'feature' && x.placeId === lastNamed && !x.part);
  if (!d || !to) return;
  Object.assign(d, { placeId: to.placeId, placeLabel: to.placeLabel, part: true, names: [], types: [], ...traced.addedPart(d.geojson) });
  closeNaming();
  keepDrafts(); renderTraced(); renderTrace();
}
function namingCancelled() {
  const d = naming?.draftId && drafts.find((x) => x.id === naming.draftId);
  const editing = naming?.editing;
  closeNaming();
  // A drawing not yet named goes (decision 2); a name being changed stays as it was.
  if (d && !editing && !d.placeId) removeDraft(d.id);
}
function namingKey(e) { if (e.key === 'Escape') { e.preventDefault(); namingCancelled(); } }

/** The list of the features traced, a page at a time, the latest first (c, d). */
function renderTraced() {
  if (!root) return;
  const all = drafts.filter((d) => d.kind === 'feature').reverse();
  $('traced').hidden = !traceKey && !all.length;
  const pages = Math.max(1, Math.ceil(all.length / TRACED_PAGE));
  tracedAt = Math.min(tracedAt, pages - 1);
  const from = tracedAt * TRACED_PAGE, shown = all.slice(from, from + TRACED_PAGE);
  const labelOf = new Map(all.filter((d) => d.placeId && !d.part).map((d) => [d.placeId, d.placeLabel]));
  $('traced-count').textContent = CHORA_TRACE.listCount(all.length, from + 1, from + shown.length);
  $('traced-list').innerHTML = shown.map((d) => traced.tracedItem(d, { partOf: d.part ? labelOf.get(d.placeId) : null })).join('');
  $('traced-prev').disabled = tracedAt === 0; $('traced-next').disabled = tracedAt >= pages - 1;
  $('traced-prev').parentElement.hidden = all.length <= TRACED_PAGE;
  state.traced = { total: all.length, page: tracedAt, shown: shown.map((d) => d.id) };
  publishTrace();
}
function tracedClicked(e) {
  const li = e.target.closest('[data-draft]');
  if (!li) return;
  const d = drafts.find((x) => x.id === li.dataset.draft);
  if (!d) return;
  if (e.target.closest('[data-remove]')) removeDraft(d.id);
  else if (e.target.closest('[data-name]')) openNaming(d.id);
  else if (e.target.closest('[data-edit]')) openNaming(d.id, { editing: true });
  else if (e.target.closest('[data-show]')) mapApi.fit(boxOf([d.geojson]), 14);
}
function tracedChanged(e) {
  const sel = e.target.closest('select[data-field]');
  const d = sel && drafts.find((x) => x.id === sel.closest('[data-draft]').dataset.draft);
  if (!d) return;
  // Chosen by the user: no longer the map's default (decision 6).
  d[sel.dataset.field] = sel.value; d.defaulted = false;
  keepDrafts(); renderTraced();
}

// ---- Saving --------------------------------------------------------------------------------------
function showSaving() {
  if (!dataset) return;
  $('saving').hidden = false;
  const own = drafts.filter((d) => d.kind !== 'feature');
  const places = new Set(own.map((d) => d.placeId)).size;
  const adoptions = own.filter((d) => d.kind === 'adoption').length, drawings = own.length - adoptions;
  // The places traced from a map into a new dataset: one for each named, its parts counted with it.
  const tracedPlaces = new Set(drafts.filter((d) => d.kind === 'feature').map((d) => d.placeId || d.id)).size;
  const what = [drawings ? `${n(drawings)} drawing${drawings === 1 ? '' : 's'} of ${n(places)} place${places === 1 ? '' : 's'}` : '', adoptions ? `${n(adoptions)} location${adoptions === 1 ? '' : 's'} adopted from a gazetteer` : '',
    tracedPlaces ? CHORA_TRACE.placesTraced(tracedPlaces) : ''].filter(Boolean).join(' and ');
  $('pending-total').textContent = drafts.length
    ? `${what}, not yet saved. ${permissions.keepWorkingData() ? 'They are kept in this browser until you save.' : 'Save them before you leave: you chose not to keep working data between visits.'}`
    : traceKey ? 'Nothing traced yet. Draw on the map, and name what you draw.' : 'Nothing drawn yet. Choose a place, and draw on the map.';
  $('save').disabled = !drafts.length;
  const c = contributors.load();
  const line = $('contributor-line');
  line.hidden = !c;
  if (c) line.innerHTML = `Saving as <strong>${esc(c.name)}</strong>${c.orcid ? ` (<a href="${esc(c.orcid)}" rel="noopener noreferrer">${esc(c.orcid.replace('https://orcid.org/', ''))}</a>)` : ''} — <a href="#" id="chora-c-change">change</a> / <a href="#" id="chora-c-forget">forget me</a>`;
}
function savingClicked(e) {
  if (e.target.id === 'chora-c-change') { e.preventDefault(); askContributor(); }
  if (e.target.id === 'chora-c-forget') { e.preventDefault(); contributors.forget(); showSaving(); }
}
function askContributor() {
  const c = contributors.load() || {};
  $('c-name').value = c.name || ''; $('c-orcid').value = c.orcid ? c.orcid.replace('https://orcid.org/', '') : '';
  $('c-error').hidden = true;
  $('contributor-form').hidden = false; $('contributor-line').hidden = true;
  $('c-name').focus();
}
let saveAfterAsking = false;
function contributorGiven(e) {
  e.preventDefault();
  const c = contributors.fromForm($('c-name').value, $('c-orcid').value);
  if (c.error) { $('c-error').textContent = c.error; $('c-error').hidden = false; return; }
  contributors.remember(c);
  $('contributor-form').hidden = true;
  showSaving();
  if (saveAfterAsking) { saveAfterAsking = false; saveDataset(); }
}
const contributorCancelled = () => { saveAfterAsking = false; $('contributor-form').hidden = true; showSaving(); };
function saveClicked() {
  if (!contributors.load()) { saveAfterAsking = true; askContributor(); return; }
  saveDataset();
}

async function saveDataset() {
  const contributor = contributors.load();
  let additions, newPlaces = [];
  try {
    // The features traced from a map into a new dataset: a new place for each named (traced.js), none unnamed.
    if (drafts.some((d) => d.kind === 'feature')) {
      const np = traced.newPlacesOf(drafts, { settingsOf, contributor, version: toolsVersion });
      if (np.unnamed.length) throw new Error(CHORA_TRACE.unnamedRefused(np.unnamed.length));
      newPlaces = np.newPlaces;
    }
    // A traced drawing cites the map and its georeference, and says so in its notes (trace.js).
    // An adoption gives its two attestations (one when the place was already linked), made now that the contributor is known.
    additions = drafts.filter((d) => d.kind !== 'feature').flatMap((d) => {
      if (d.kind === 'adoption') {
        const r = draftAttestations(d, contributor);
        if (r.refused) throw new Error(`${CHORA_ADOPT_PAGE.pendingItem(d.candidate.name || d.candidate.id)}: ${r.refused.reason}`);
        return r.attestations.map((attestation) => ({ placeId: d.placeId, attestation }));
      }
      const drawn = { notes: choraDrawingNote({ basemap: d.basemap, zoom: d.zoom }) };
      return [{ placeId: d.placeId, attestation: newGeometryAttestation({
        geojson: d.geojson, role: d.role || undefined, precision: d.precision || undefined, contributor, created: d.drawnAt,
        ...(d.trace ? tracing.tracedParts(d.trace, { zoom: d.zoom, role: d.role, geometry: d.geojson, version: toolsVersion })
          : d.assistedUncited ? tracing.uncitedParts(d.assistedUncited, { zoom: d.zoom, geometry: d.geojson, version: toolsVersion })
          : d.consulted ? consultedParts(d.consulted, drawn.notes)
          : drawn) }) }];
    });
  } catch (e) { $('save-result').innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
  const savedIds = new Set(drafts.map((d) => d.id));
  $('save').disabled = true;
  $('save-result').innerHTML = ''; offered = null;
  state.phase = 'saving'; state.saveProgress = [];
  Object.assign($('save-progress'), { hidden: false, textContent: 'Saving…' });
  await storageCheck('save', $('save-storage-warning'));
  let r;
  try { r = await request({ cmd: 'chora-save', files, additions, ...(newPlaces.length ? { newPlaces } : {}), contributor }, 'done'); } catch (e) { $('save').disabled = false; $('save-progress').hidden = true; return fail(e.message); }
  $('save').disabled = false;
  $('save-progress').hidden = true;
  $('phase').textContent = '';
  const added = r.report?.counts?.['attestations added'] ?? r.mneme?.report?.counts?.added ?? null;
  const passed = !!r.mneme?.passed;
  const out = (r.outputs || [])[0];
  const problems = (r.report?.items || []).filter((i) => i.severity === 'error');
  // The verdict in the words the command line uses too (src/engine/words.js), and on failure, why.
  const reasons = [...(r.mneme?.reasons || []), ...problems.map(choraProblemText)];
  // What the file is, and on a save that passes, what the writing of it reported: for a dataset that
  // was not place-centric PLATO JSON, what its conversion could not carry over, which Mneme, reading
  // the same input the same way, cannot see.
  const saving = choraSavedFormat(dataset.input);
  const converted = dataset.input?.format !== saving.target || dataset.input?.profile !== 'place-centric';
  const notes = (r.report?.items || []).filter((i) => i.severity !== 'error');
  const item = (i) => `<li>${esc(CHORA_TEXT[i.kind] || i.message)}${i.count > 1 ? ` (${n(i.count)})` : ''}${i.examples?.length ? ` <span class="muted">${esc(i.examples.slice(0, 3).join('; '))}</span>` : ''}</li>`;
  $('save-result').innerHTML = `<p class="${passed ? 'good' : 'warn'}">${esc(choraSaveText(r))}</p>`
    + (passed ? `<p>${converted ? `The dataset is ${esc(formatName(dataset.input))}: the saved file is a conversion of it to ${saving.words} (place-centric), with the drawings added.` : `The saved file is ${saving.words}, as the dataset is, with the drawings added.`}</p>`
      // Problems the writing found (a place the schema refuses, say) are shown even when the version
      // check passes: Mneme compares the attestations, and says nothing of them.
      + (problems.length ? `<p class="warn">${converted ? 'The conversion' : 'Writing it'} found problems in the dataset, which the saved file has too:</p><ul class="notes problems">${problems.map(item).join('')}</ul>` : '')
      + (notes.length ? `<p>${converted ? 'The conversion' : 'Writing it'} reported:</p><ul class="notes">${notes.map(item).join('')}</ul>` : '')
      : reasons.map((x) => `<p class="warn">${esc(x)}</p>`).join(''));
  if (passed && out) {
    // The file offered, and, once it has gone as a download, the way to let its drawings go: together,
    // so that both are withdrawn when the drawings change.
    const box = document.createElement('p'), b = document.createElement('button'); b.className = 'primary';
    b.textContent = `Save ${out.name} (${fmtBytes(out.size)})`;
    // The drawings in that file need not be kept here once it is on the user's disk; any others still are.
    const letGo = async (said) => {
      offered = null; box.remove();
      const rest = drafts.filter((d) => !savedIds.has(d.id));
      // The file the page has chosen (handed to it, and still chosen there) is Chora's dataset from now: what
      // is drawn next is added to it, and saved from it, the drawings let go here being in it.
      const mine = out.file && out.file === handed && host.files?.().includes(handed);
      if (mine) {
        await rebase(handed, rest);
        $('save-result').insertAdjacentHTML('beforeend', `<p>${said} ${esc(handed.name)} is open here now: what is drawn next is added to it.</p>`);
        return;
      }
      // The file is on the user's disk: one who keeps no working data has no copy of it left here.
      if (!permissions.keepWorkingData()) {
        navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('chora-outputs')).then((d) => d.removeEntry(out.name)).catch(() => {});
        if (out.file) forgetSaved(out.file);
      }
      drafts = rest; keepDrafts(); showDrafts(visibleDrafts()); if (view) renderCard(); renderTraced(); renderTrace();
      $('save-result').insertAdjacentHTML('beforeend', `<p>${said} To add more, open ${esc(out.name)}.</p>`);
    };
    b.onclick = async () => {
      let done, file;
      try { file = out.file || await outputFile(out.name); done = await saveFile(file, out.name); } catch (e) {
        offered = null; box.remove();
        $('save-result').insertAdjacentHTML('beforeend', `<p class="warn">${esc(out.name)} is no longer there to save (${esc(e.message)}): save again.</p>`);
        return;
      }
      if (done === true) letGo('Saved.');
      else if (done === 'download' && !box.querySelector('[data-clear]')) {
        // A download cannot be seen to finish: the drawings are kept, and the file still offered,
        // until the user says the file is on their disk.
        const c = document.createElement('button'); c.type = 'button'; c.dataset.clear = '';
        c.textContent = 'The download is complete: let these drawings go';
        c.onclick = () => letGo('The drawings in that file are no longer kept here.');
        box.append(' ', c, Object.assign(document.createElement('span'), { className: 'muted', textContent: ' If the download did not complete, save again.' }));
      }
    };
    box.appendChild(b);
    $('save-result').appendChild(box);
    offered = box;
  }
  state.lastSave = { passed, added, outputs: r.outputs || [], mneme: r.mneme || null, report: r.report || null, converted };
  // The save tells the page whether it was a tracing's (places traced, from a map): only such a save does a workflow's step "trace".
  if (passed && out) await handOver(out, { traced: !!traceKey && newPlaces.length > 0 });
  state.phase = 'saved';
}
/**
 * The dataset a save wrote is the page's from now: handed to it (host.saved, which chooses it in step 1),
 * from the file on the origin private file system, and what the page did with it said under the save.
 * While it does (a large file is read through, to know it by its SHA-256), the page says so.
 */
async function handOver(out, how = {}) {
  if (!host.saved) return;
  let file;
  try { file = await keepSaved(out.name); } catch { return; }
  out.file = handed = file;
  const busy = Object.assign(document.createElement('p'), { className: 'muted', id: 'chora-handing', textContent: CHORA_HANDOVER.busy });
  busy.setAttribute('role', 'status');
  $('save-result').append(busy);
  state.handingOver = { said: busy.textContent };
  let said = null;
  try { said = await host.saved(file, files, how); } catch (e) { said = CHORA_HANDOVER.failed(e.message); } finally { busy.remove(); }
  forgetOtherSaved();
  if (said) $('save-result').append(Object.assign(document.createElement('p'), { className: 'note', id: 'chora-handed', textContent: said }));
  state.handedOver = { name: file.name, size: file.size, said };
}
// A save's steps, shown under its button, and kept for tests, one entry for each step and phase.
function saveProgress(p) {
  const text = choraSaveProgress(p);
  $('save-progress').textContent = text;
  const key = [p.save, p.version || '', p.again ? 'again' : '', p.phase || ''].join('|');
  const list = (state.saveProgress ||= []);
  if (list.at(-1)?.key === key) list[list.length - 1].text = text; else if (list.length < 100) list.push({ key, text });
}

// ---- Storage -------------------------------------------------------------------------------------
// A dataset is read into the browser's storage, and a save writes the whole of it again beside the
// version check's working copy: DEEP (1.4 million attestations) needs 1.4 GB to open and 2.4 GB more to
// save (src/engine/chora/storage.js). The browser is asked how much it allows before either starts, and
// the page says so plainly when that looks too little. The size read is the files' own, or, gzipped
// (known by their first bytes), what their trailers say when it can be believed (sizeRead). How the
// dataset is read (through a triple store or not) is from its format: detected here before it is
// opened, and the one it was opened as when it is saved.
async function readSize(list) {
  let bytes = 0;
  for (const f of list) bytes += await sizeRead(f);
  return bytes;
}
async function storageCheck(when, el) {
  const bytes = await readSize(files), name = files[0]?.name;
  let input = when === 'save' ? dataset?.input : null;
  if (!input) { try { input = await detect(files); } catch { /* from the name instead */ } }
  const need = when === 'load' ? loadNeed({ name, bytes, input }) : saveNeed({ name, bytes, input });
  let estimate = null;
  try { estimate = await navigator.storage.estimate(); } catch { /* not said: no warning */ }
  const short = storageShort(need, estimate);
  state.storage = { when, bytes, need, quota: estimate?.quota ?? null, usage: estimate?.usage ?? null, short: !!short };
  el.hidden = !short;
  if (short) el.textContent = choraStorageWarning(when, short);
  return bytes;
}

// The same as the main page's save() (src/app.js), kept here rather than shared so that the main page
// is not changed for Chora: the output is on the origin private file system (in chora-outputs/, the
// worker's directory for Chora, apart from the main page's outputs/), and goes to disk
// through the save dialogue where there is one, else as a download. True once saved through the
// dialogue, which returns when the file is written; 'download' for a download, which cannot be seen
// to finish; false if the user cancelled.
async function save(name) { return saveFile(await outputFile(name), name); }
/**
 * The files handed to the page live apart from the worker's folder (chora-outputs/, which every save
 * clears as it starts, and where a save refused is removed): each in a folder of its own under
 * chora-saved/, so that the page's step 1 still reads the file a save handed it after a later save, which
 * may write a file of the same name, has cleared chora-outputs/ or been refused. A file is moved there
 * (a copy where the browser cannot move one), and removed once neither the page nor Chora has it.
 */
const SAVED = 'chora-saved';
const savedDirs = new Map();   // File handed -> the name of its folder under chora-saved/
async function keepSaved(name) {
  const opfs = await navigator.storage.getDirectory();
  const from = await (await opfs.getDirectoryHandle('chora-outputs')).getFileHandle(name);
  const folder = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const to = await (await opfs.getDirectoryHandle(SAVED, { create: true })).getDirectoryHandle(folder, { create: true });
  let h;
  if (typeof from.move === 'function') { await from.move(to, name); h = from; }
  else {
    h = await to.getFileHandle(name, { create: true });
    await (await from.getFile()).stream().pipeTo(await h.createWritable());
    await (await opfs.getDirectoryHandle('chora-outputs')).removeEntry(name);
  }
  const file = await h.getFile();
  savedDirs.set(file, folder);
  return file;
}
async function forgetSaved(file) {
  const folder = savedDirs.get(file);
  if (!folder) return;
  savedDirs.delete(file);
  try { await (await (await navigator.storage.getDirectory()).getDirectoryHandle(SAVED)).removeEntry(folder, { recursive: true }); } catch { /* gone already */ }
}
/** The files handed before, that neither the page (step 1) nor Chora (its dataset) has now, go. */
function forgetOtherSaved() {
  const held = new Set([...(host.files?.() || []), ...files, handed]);
  for (const f of [...savedDirs.keys()]) if (!held.has(f)) forgetSaved(f);
}
/**
 * The file a save wrote, handed to the page and still chosen there, opened as Chora's dataset once the
 * drawings it holds are let go (its "Save" done): the next save builds on it, so that it holds what was
 * saved before too. The drawings made since the save are carried over; the place and the view stay.
 */
async function rebase(file, rest) {
  const m = mapApi.map, camera = { center: m.getCenter().toArray(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() };
  const place = state.placeId, last = state.lastSave, given = state.handedOver, key = traceKey;
  drafts = []; keepDrafts();   // the old dataset's: those saved are in the file, the rest go with it
  // Traced from a map: the file saved is traced from it from now, and the dataset made from the map is not needed again.
  if (key && tracings.seeds[key]) { delete tracings.seeds[key]; keepTracings(); }
  await open([file], { traceKey: key });
  handed = file;
  if (rest.length) { drafts = [...drafts, ...rest]; keepDrafts(); showDrafts(visibleDrafts()); renderTraced(); }
  Object.assign(state, { lastSave: last, handedOver: given, rebased: file.name });
  if (place && dataset) await selectPlace(place);
  m.jumpTo(camera);
}
/** The file the worker wrote for Chora, on the origin private file system: the bytes saved, and handed to the page. */
async function outputFile(name) {
  const root = await navigator.storage.getDirectory();
  return (await (await root.getDirectoryHandle('chora-outputs')).getFileHandle(name)).getFile();
}
async function saveFile(file, name) {
  if (window.showSaveFilePicker && !window.__plato_forceDownload) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      await file.stream().pipeTo(await h.createWritable());
      return true;
    } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return 'download';
}

// ---- Basemaps ------------------------------------------------------------------------------------
// A basemap from another site is used only once its permission is allowed (src/lib/permissions.js).
// Chosen before then, it is remembered as the one wanted, the map stays as it is, and one line says
// "Needs permission", opening the Permissions panel at it. Allowed, it can be used from the next load
// (the page's policy is written at load): the panel offers the reload, and what is open is kept.
// A pasted basemap is never used at load, nor when a permission changes, however it is remembered: only
// once the user has chosen it in this load, by a click (basemaps.automatic). Until then the map is on
// Natural Earth, and one line names it as the remembered choice, with a button to use it.
let basemapError = null;   // why the basemap chosen could not be used
let chosenHere = null;     // the pasted basemap the user chose in this load, as it was then: the only one that may be used
let listed = new Map();    // the basemaps as listed, by id: a click chooses what was shown, not what storage holds by then
const currentNow = () => basemaps.current({ chosen: chosenHere });
function unprotected(b) {
  basemapError = state.basemapError = `${b.name} cannot be used here: this browser did not show that it enforces the page’s protection, so the map stays on Natural Earth, from this site.`;
}
function renderBasemaps() {
  const cur = currentNow(), want = basemaps.wanted();
  const waiting = want && !want.disabled && !want.local && !basemaps.permitted(want) && !basemaps.refused(want) && state.canary !== 'not-enforced' ? want : null;
  // A pasted basemap remembered as the choice, permitted, but not yet chosen in this load: named, with the button.
  const remembered = want && !waiting && !basemaps.automatic(want) && !want.disabled && basemaps.permitted(want) && want.id !== cur.id ? want : null;
  state.basemapRemembered = remembered?.id || null;
  listed = new Map([...basemaps.all(), ...(remembered ? [remembered] : [])].map((b) => [b.id, b]));
  $('basemap-name').textContent = cur.name;
  const groups = new Map();
  // A basemap set to Never in Permissions is not offered (and nothing says why: that is Never).
  for (const b of basemaps.all()) { if (basemaps.refused(b)) continue; if (!groups.has(b.group)) groups.set(b.group, []); groups.get(b.group).push(b); }
  // What is typed in the paste box survives the list being drawn again (a permission changed, say).
  const typed = $('paste')?.value || '';
  // The line asking for permission goes first, where it is seen without scrolling the list.
  $('basemap-options').innerHTML = (basemapError ? `<p class="warn" role="status">${esc(basemapError)}</p>` : '')
    + (remembered ? `<p class="needs-permission" id="chora-basemap-remembered">${esc(REMEMBERED_BASEMAP.line(remembered.name))} <button type="button" class="link" id="chora-use-remembered">${esc(REMEMBERED_BASEMAP.use)}</button></p>` : '')
    + '<div id="chora-basemap-needs"></div>' + [...groups].map(([g, bs]) => `<fieldset><legend>${esc(g)}</legend>${bs.map((b) => `<label class="${b.disabled ? 'disabled' : ''}">
      <input type="radio" name="basemap" value="${esc(b.id)}"${b.id === (waiting || cur).id ? ' checked' : ''}${b.disabled ? ' disabled' : ''}> ${esc(b.name)}${b.disabled ? ` <small>(${esc(b.disabled)})</small>` : ''}${b.note ? ` <small class="basemap-note">${esc(b.note)}</small>` : ''}
      ${b.group === 'Pasted' ? ` <button type="button" class="link" data-unpaste="${esc(b.id)}">remove</button>` : ''}</label>`).join('')}</fieldset>`).join('')
    + `<form id="chora-paste-form"><label for="chora-paste">Paste a style address or a tile template</label>
      <input id="chora-paste" type="url" placeholder="https://…/style.json or https://…/{z}/{x}/{y}.png" autocomplete="off">
      <button type="submit">Add</button> <span id="chora-paste-error" class="warn"></span></form>`
    + (state.blocked ? `<p class="muted">Refused ${n(state.blocked)} request${state.blocked === 1 ? '' : 's'} to ${esc(state.blockedOrigins.join(', '))}, not the basemap's site.</p>` : '');
  if (typed) $('paste').value = typed;
  // One line for each permission the basemap wanted still needs (a pasted style may name several sites).
  state.basemapWaiting = waiting?.id || null;
  if (waiting) {
    for (const [c, subj] of basemaps.subjectsOf(waiting)) {
      if (permissions.allowed(c, subj)) continue;
      const p = document.createElement('p');
      $('basemap-needs').appendChild(p);
      permissions.needs(p, c, subj, { added: waiting.group === 'Pasted' });
    }
  }
}
function want(b) {
  basemaps.choose(b);
  // Chosen by a click in this load: this pasted basemap, at this address, may now be used; a built-in one chosen ends that.
  chosenHere = basemaps.automatic(b) ? null : b;
  if (basemaps.permitted(b)) useBasemap(b);
  else { $('basemaps').open = true; renderBasemaps(); }
}
function basemapChanged(e) {
  if (e.target.name !== 'basemap') return;
  const b = listed.get(e.target.value);
  if (b && !b.disabled) want(b);
}
function basemapClicked(e) {
  if (e.target.id === 'chora-use-remembered') { const w = listed.get(state.basemapRemembered); if (w) want(w); return; }
  if (e.target.dataset.unpaste) {
    const id = e.target.dataset.unpaste;
    basemaps.removePasted(id);
    if (chosenHere?.id === id) chosenHere = null;
    if (currentNow().id === id || state.basemap === id || basemaps.wanted() === null) want(basemaps.byId('natural-earth')); else renderBasemaps();
  }
}
function basemapPasted(e) {
  e.preventDefault();
  const b = basemaps.fromPaste($('paste').value);
  if (!b) { $('paste-error').textContent = 'That is not an https address.'; return; }
  basemaps.addPasted(b);
  $('paste').value = '';   // added: nothing waits in the box now
  want(b);
}
async function useBasemap(b) {
  if (!b.local) {
    basemapError = state.basemapError = null;
    // Where the page's policy was not shown to be enforced, no other site is asked (src/lib/csp.js).
    if (!(await permissions.enforced())) { unprotected(b); b = basemaps.byId('natural-earth'); }
  }
  mapApi.use(basemaps.subjectsOf(b));
  let style;
  try { style = await basemaps.styleFor(b); } catch (e) {
    if (b.local) { console.warn(e); return; }
    return styleFailed(e.message, b);
  }
  // A pasted style says which sites it asks only once it has been read: those not yet allowed are
  // each given a "Needs permission" line, and the map stays as it is until they are.
  if (b.group === 'Pasted' && b.kind === 'style') {
    const origins = [...new Set([basemaps.originOf(b), ...basemaps.styleOrigins(style, b.url)])];
    if (origins.join() !== basemaps.originsOf(b).join()) { b = { ...b, origins }; basemaps.addPasted(b); if (basemaps.sameBasemap(b, chosenHere)) chosenHere = b; }
    if (!basemaps.permitted(b)) {
      const shown = basemaps.byId(state.basemap);
      $('basemaps').open = true;
      if (shown) { mapApi.use(basemaps.subjectsOf(shown)); renderBasemaps(); } else useBasemap(basemaps.byId('natural-earth'));
      return;
    }
    mapApi.use(basemaps.subjectsOf(b));
  }
  if (!b.local || basemaps.wanted()?.local) basemaps.choose(b);
  state.basemap = b.id;
  mapApi.setStyle(style);
  renderBasemaps();
}
// A permission changed, here or in another tab: a basemap shown that is no longer allowed gives way to
// Natural Earth at once; one wanted that now may be used (allowed again within this load's policy) is
// used, if it is automatic or was chosen here (a change may come from another tab, or another page of
// the origin, which must not put a pasted basemap on the map).
function basemapPermissionChanged() {
  const shown = basemaps.byId(state.basemap);
  if (shown && !shown.local && !basemaps.permitted(shown)) { useBasemap(basemaps.byId('natural-earth')); return; }
  const w = basemaps.wanted();
  if (w && !w.disabled && w.id !== state.basemap && basemaps.permitted(w) && (basemaps.automatic(w) || basemaps.sameBasemap(w, chosenHere))) { useBasemap(basemaps.automatic(w) ? w : chosenHere); return; }
  renderBasemaps();
}

// ---- Historical maps -----------------------------------------------------------------------------
// A georeferenced map over the basemap (src/chora/overlays.js has how it gets there; src/chora/
// remote.js how each document is fetched). Each permission a map needs (iiif:<site> for its servers,
// allmaps:allmaps for Allmaps) is named in one "Needs permission" line each, all at once, before
// anything is asked; allowed in the panel, they are in the page's policy from the next load, and the
// map waiting is added after the reload (what was pasted is kept for it). Allmaps is asked only from
// the "Look for a georeference" button. A permission withdrawn takes its maps off the map at once
// (they stay kept, and come back once it is allowed again); one set to Never is done without, and
// nothing is said of it, but for a map just pasted, where the status line says why it is not shown.
const deps = { fetchJson: (u) => remote.fetchJson(u), allowed: (c, s) => permissions.allowed(c, s), state: (c, s) => permissions.state(c, s) };
let mapNeed = null;    // {subjects, pending, maps, pasted, kept}: the permissions the map pasted and the maps kept wait on (overlays.js withNeed)
let mapOffer = null;   // {services, manifestUrl, title, text, notFound}: a map with no georeference given
let mapChoice = null;  // {choices, chosen, parsed, manifestUrl}: a georeference of several maps, one to choose
let mapStatus = '';    // what the page says of the last map added, in words (a warn: prefix is a problem)
let mapLink = null;    // an address the user may open in a new tab (one that forwards elsewhere)
let layers = null;     // the maps' layer on the map (overlays.js createLayerManager), once the map exists
// One map at a time: what is pasted, the maps kept, and a change of permission are each done in turn.
let mapsChain = Promise.resolve();
const inTurn = (fn) => (mapsChain = mapsChain.then(fn, fn).catch((e) => console.warn('Historical maps:', e)));
const addMap = (pending) => inTurn(() => addMapNow(pending));
function initMaps() {
  layers = ov.createLayerManager(mapApi.map, { onEvent: overlayEvent });
  mapApi.onStyleLoad(() => { layers.attach().then(syncOverlays, (e) => console.warn('Historical maps:', e)); });
  // For automated tests; nothing else reads it.
  window.__chora_overlays = { manager: layers, georef, get layer() { return layers.layer; } };
  renderMaps();
}
const editorShown = () => ov.editorLinkShown(permissions.state('allmaps', 'allmaps'));
const setStatus = (text, link = null) => { mapStatus = text; mapLink = link; state.mapError = text.startsWith('warn:') ? text.slice(5) : null; };

/** A step needs permissions: a line for each not yet allowed, or, if one is set to Never, why the map is not shown. */
function needFor(e, pending, { quiet = false } = {}) {
  const never = e.subjects.filter(([c, s]) => permissions.state(c, s) === 'never');
  // The map pasted and the maps kept wait apart, together: each replaces its own part only.
  const part = pending.readmit ? 'kept' : 'pasted';
  if (never.length) {
    mapNeed = ov.withNeed(mapNeed, { [part]: null });
    // Never: the feature does without. Only a map just asked for is told why (a map kept says nothing).
    setStatus(quiet ? '' : `warn:${never.map(([c, s]) => PERMISSION_REFUSED.never(permissions.nameOf(c, s))).join(' ')}`);
  } else {
    mapNeed = ov.withNeed(mapNeed, { [part]: part === 'kept' ? { subjects: e.subjects, maps: e.maps || 1 } : { subjects: e.subjects, pending, maps: e.maps || 1 } });
    // The maps kept (quiet) leave what is said of the last map pasted as it is.
    if (!quiet) setStatus('');
  }
  renderMaps();
}
/**
 * Add a map from what was pasted (pending: {text, lookup}), kept (pending: {kept}), or chosen from a
 * georeference of several (pending: {parsed, manifestUrl}); pending {readmit} is the maps kept, all.
 * With `collect`, the permissions a kept map needs are returned (NeedPermission), not shown.
 */
async function addMapNow(pending, { collect = false } = {}) {
  if (pending.readmit) return readmitKept();
  if (!collect) { mapNeed = ov.withNeed(mapNeed, { pasted: null }); mapChoice = null; setStatus('Reading…'); renderMaps(); }
  // Where the page's policy was not shown to be enforced, no map is shown: its tiles could go anywhere.
  if (!(await permissions.enforced())) { setStatus(`warn:${ov.REFUSED}`); renderMaps(); return null; }
  try {
    // The picker's one step (overlays.js pickMap): the offer it makes is shown as soon as it is known.
    const got = await ov.pickMap(pending, deps, { onOffer: (o) => { mapOffer = o; } });
    if (got.kind === 'gone') return null;
    if (got.kind === 'offer') { mapOffer = got.offer; setStatus(''); renderMaps(); return null; }
    mapOffer = null;
    await showMap(got.admitted, got.keptEntry);
  } catch (e) {
    if (e instanceof ov.NeedPermission) { if (collect) return e; needFor(e, pending); return null; }
    // A map kept that cannot be shown now (its server down, say) is left for the next load; what is said
    // of the map last pasted stays (this runs on every change of permission).
    if (collect) { console.warn('Chora: a map kept could not be shown', e); state.keptError = e.message; return null; }
    if (e instanceof ov.NeedChoice) {
      // Several georeferences of the map: the user chooses, the most recently changed offered first.
      mapChoice = { choices: e.choices, chosen: e.defaultIndex, manifestUrl: e.manifestUrl ?? mapOffer?.manifestUrl ?? null,
        parsed: { kind: 'annotation', annotation: e.annotation, fetchedAt: e.fetchedAt, url: e.url, manifest: e.manifest } };
      mapOffer = null; setStatus(''); renderMaps();
      return null;
    }
    // An address that forwards elsewhere: c2's words, and the address to open in a new tab.
    if (e instanceof remote.RemoteError && e.kind === 'moved') setStatus(`warn:${e.message}`, e.url);
    else setStatus(`warn:${e.message}`);
    renderMaps();
  }
  return null;
}
async function showMap(a, keptEntry = null) {
  const key = await ov.keyOf(a.g);
  if (layers.entries.some((e) => e.key === key)) { if (!keptEntry) { setStatus(`${a.title} is shown already.`); renderMaps(); } return; }
  const e = { ...a, key, opacity: keptEntry?.opacity ?? 1, visible: keptEntry?.visible ?? true, added: keptEntry?.added || new Date().toISOString() };
  await layers.add(e);
  if (e.error) { layers.remove(key); throw new Error(e.error); }
  // service: the image as its tiles are asked for (over https, no trailing slash), to know its tiles' errors by.
  state.overlays.push({ key, mapId: e.mapId, origin: a.subject[1], permission: `${a.subject[0]}:${a.subject[1]}`, service: remote.infoUrl(a.g.imageServiceId).replace(/\/info\.json$/, ''),
    annotationId: a.g.annotationId, title: a.title, transformation: ov.allmapsTransformationName(a.g), opacity: e.opacity, visible: e.visible, tilesLoaded: 0, tileErrors: 0, firstTile: false });
  ov.keep({ key, item: a.item, manifest: a.manifest, manifestUrl: a.manifestUrl, fetchedAt: a.fetchedAt, opacity: e.opacity, visible: e.visible, added: e.added }).catch((err) => console.warn('Chora: the map could not be kept', err));
  setStatus(keptEntry ? '' : `${a.title} is on the map.`);
  if (!keptEntry) fitMap(key);
  renderMaps();
}
/** The renderer's ids change when the maps are put into a new layer (a new basemap): kept up to date. */
function syncOverlays() {
  for (const o of state.overlays) { const e = layers.entries.find((x) => x.key === o.key); if (e) o.mapId = e.mapId; }
}
function fitMap(key) {
  const b = layers.bounds(key);
  if (b) mapApi.map.fitBounds(b, { padding: 32, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 700 });
}
function overlayEvent(type, e) {
  (state.overlayEvents ||= {})[type] = (state.overlayEvents[type] || 0) + 1;
  const ids = e?.mapIds || (e?.mapId ? [e.mapId] : []);
  for (const o of state.overlays) {
    if (ids.length && !ids.includes(o.mapId)) continue;
    // A map has drawn once a tile of it has loaded. The renderer's firstmaptileloaded comes only when the
    // first tile it asked for loads (render 1.0.0-beta.84, TileCache.tileFetched): when that one is refused
    // and others load, it never comes; so any tile loaded counts.
    if (type === 'maptileloaded') { o.tilesLoaded++; if (!o.firstTile) { o.firstTile = true; updateTraceButtons(); } }
    else if (type === 'firstmaptileloaded') { o.firstTile = true; updateTraceButtons(); }
    else if (type === 'allrequestedtilesloaded') o.allLoaded = (o.allLoaded || 0) + 1;
    else if (type === 'tilefetcherror' || type === 'imageinfofetcherror') { o.tileErrors++; renderMapsSoon(); updateTraceButtons(); }
  }
}
// A tile the renderer's worker could not fetch (refused by the page's policy, say, when its server
// sent the request elsewhere) is reported by the renderer only to the console, as a ResourceFetchError
// naming the tile's address (@allmaps/render 1.0.0-beta.84, CacheableWorkerImageDataTile: no event is
// dispatched). So Chora listens there, from when it is mounted, for the tiles of its own maps only, and says so in plain words.
function listenForTileErrors() {
  const toConsole = console.error.bind(console);
  console.error = (...args) => {
    try {
      for (const a of args) {
        const m = a && a.name === 'ResourceFetchError' && /(https?:\/\/\S+)/.exec(String(a.message));
        const tile = m && m[1].replace(/[)(.,]+$/, '');
        const o = tile && state.overlays.find((x) => tile.startsWith(`${x.service}/`));
        if (o) { o.tileErrors++; renderMapsSoon(); updateTraceButtons(); }
      }
    } catch {}
    toConsole(...args);
  };
}
let rendering = null;
const renderMapsSoon = () => { rendering ??= setTimeout(() => { rendering = null; renderMaps(); }, 250); };

function renderMaps() {
  const shown = new Map(layers.entries.map((e) => [e.key, e]));
  if (!traceEditing) renderTrace();
  // The lines asking for permission, one for each not yet allowed (or allowed since the page loaded).
  const needBox = $('map-needs');
  needBox.replaceChildren();
  state.mapNeeds = mapNeed ? mapNeed.subjects.map(([c, s]) => `${c}:${s}`) : [];
  state.mapPasted = !!mapNeed?.pasted;
  for (const [c, s] of mapNeed?.subjects || []) {
    if (permissions.allowed(c, s)) continue;
    const p = document.createElement('p');
    needBox.appendChild(p);
    permissions.needs(p, c, s);
  }
  // What the picker says of the last map asked for (overlays.js pickerStatus): the choice, the offer, the status line.
  $('map-status').innerHTML = ov.pickerStatus({ choice: mapChoice, offer: mapOffer, status: mapStatus, link: mapLink, editor: editorShown(), prefix: 'chora' });
  $('overlay-list').innerHTML = state.overlays.map((o) => {
    const e = shown.get(o.key); if (!e) return '';
    const a = e.attribution || {};
    const licence = a.licence ? `<a href="${esc(a.licence)}" target="_blank" rel="noopener noreferrer">${esc(a.licenceLabel || a.licence)}</a>` : '';
    return `<li data-overlay="${esc(o.key)}"><p class="overlay-title">${esc(o.title)}</p>
      <p class="muted">Image from <code>${esc(o.origin)}</code> <button type="button" class="link" data-permissions="${esc(o.permission)}">${esc(NEEDS.open)}</button></p>
      ${a.credit ? `<p class="muted">${esc(a.credit)}</p>` : ''}
      ${licence ? `<p class="muted">Licence: ${licence}</p>` : ''}
      ${a.nonCommercial ? `<p class="note">${esc(ov.nonCommercialLine(a))} ${licence}</p>` : ''}
      ${(e.notes || []).map((x) => `<p class="muted">${esc(x)}</p>`).join('')}
      ${o.tileErrors ? `<p class="warn">Some parts of the map's image could not be loaded from ${esc(o.origin)}.</p>` : ''}
      <p class="overlay-controls"><label>Opacity <input type="range" min="0" max="100" step="5" value="${Math.round(o.opacity * 100)}" data-opacity></label>
      <label><input type="checkbox" data-show${o.visible ? ' checked' : ''}> Show</label>
      <button type="button" data-fit>Fit</button> <button type="button" data-remove-map>Remove</button></p>
      ${traceKey === o.key ? `<p class="note" data-tracing>${esc(CHORA_TRACE.tracingThis)}</p>` : `<p><button type="button" data-trace-new>${esc(intoOpen(o.key) ? CHORA_TRACE.intoOpen : CHORA_TRACE.button)}</button></p>`}
      ${editorShown() ? `<p><a href="${esc(ov.editorUrl(e.manifestUrl, e.g.imageServiceId))}" target="_blank" rel="noopener noreferrer" data-editor>${esc(ov.EDITOR_LINK_TEXT)}</a></p>` : ''}</li>`;
  }).join('');
}
const mapPasted = (e) => { e.preventDefault(); mapOffer = null; mapChoice = null; addMap({ text: $('map-input').value }); };
function mapStatusClicked(e) {
  if (e.target.id === 'chora-map-choose' && mapChoice) {
    const picked = $('map-status').querySelector('input[name="georef-choice"]:checked');
    const { parsed, manifestUrl, chosen } = mapChoice; mapChoice = null;
    addMap({ parsed: { ...parsed, index: picked ? Number(picked.value) : chosen }, manifestUrl });
  } else if (e.target.id === 'chora-map-choose-no') { mapChoice = null; setStatus(''); renderMaps(); }
  else if (e.target.id === 'chora-map-lookup' && mapOffer) addMap({ text: mapOffer.text, lookup: true });
}
function overlayInput(e) {
  const li = e.target.closest('[data-overlay]'); if (!li) return;
  const o = state.overlays.find((x) => x.key === li.dataset.overlay);
  if (e.target.matches('[data-opacity]')) { o.opacity = Number(e.target.value) / 100; layers.set(o.key, { opacity: o.opacity }); keepOverlay(o); }
}
function overlayChanged(e) {
  const li = e.target.closest('[data-overlay]'); if (!li) return;
  const o = state.overlays.find((x) => x.key === li.dataset.overlay);
  if (e.target.matches('[data-show]')) { o.visible = e.target.checked; layers.set(o.key, { visible: o.visible }); keepOverlay(o); updateTraceButtons(); }
}
function overlayClicked(e) {
  const li = e.target.closest('[data-overlay]'); if (!li) return;
  const key = li.dataset.overlay;
  if (e.target.matches('[data-permissions]')) permissions.open({ focus: e.target.dataset.permissions });
  if (e.target.matches('[data-fit]')) fitMap(key);
  if (e.target.matches('[data-trace-new]')) beginSettings(key);
  if (e.target.matches('[data-remove-map]')) {
    layers.remove(key);
    ov.letGo(key).then(() => { state.overlays = state.overlays.filter((x) => x.key !== key); renderMaps(); updateTraceButtons(); });
  }
}
// Noted at once and written in turn (overlays.js keepShown), so that a reload straight after the tick finds it.
function keepOverlay(o) { ov.keepShown(o.key, o).catch((err) => console.warn('Chora: the map could not be kept', err)); }
/**
 * The maps kept from last time (and any withdrawn and allowed again), admitted afresh: those whose
 * permissions may be asked now are shown; the permissions the others need are asked for together, so
 * one reload brings them all back. A map that needs a permission set to Never is done without, silently.
 */
async function readmitKept() {
  const shownKeys = new Set(layers.entries.map((e) => e.key));
  const subjects = []; let maps = 0;
  for (const k of await ov.kept()) {
    if (shownKeys.has(k.key)) continue;
    const need = await addMapNow({ kept: k.key }, { collect: true });
    if (!need) continue;
    if (need.subjects.some(([c, s]) => permissions.state(c, s) === 'never')) continue;
    maps++;
    for (const sj of need.subjects) if (!subjects.some((x) => x[0] === sj[0] && x[1] === sj[1])) subjects.push(sj);
  }
  if (subjects.length) needFor({ subjects, maps }, { readmit: true }, { quiet: true });
  else if (mapNeed?.kept) { mapNeed = ov.withNeed(mapNeed, { kept: null }); renderMaps(); }
}
/**
 * A permission changed, here or in another tab: a map whose permission is no longer allowed is taken
 * off the map at once (it stays kept, to come back once allowed again); a map waiting on permissions
 * that may all be asked now is added; and the maps kept are looked at again.
 */
function permissionsChanged() {
  if (!layers) return;
  const gone = state.overlays.filter((o) => { const [c, sj] = o.permission.split(/:(.*)/s); return !permissions.allowed(c, sj); });
  for (const o of gone) layers.remove(o.key);
  if (gone.length) { state.overlays = state.overlays.filter((o) => !gone.includes(o)); state.withdrawn = (state.withdrawn || 0) + gone.length; updateTraceButtons(); }
  // Withdrawn, not refused: its line is drawn now, before the panel is (the module tells the page first),
  // so that the permission stays in the panel's list, where it was just changed. The maps kept refine it.
  const undecided = gone.map((o) => o.permission.split(/:(.*)/s).slice(0, 2)).filter(([c, sj]) => permissions.state(c, sj) === 'undecided');
  if (undecided.length && !mapNeed?.kept) mapNeed = ov.withNeed(mapNeed, { kept: { subjects: undecided.filter((x, i) => undecided.findIndex((y) => y[1] === x[1]) === i), maps: gone.length } });
  const waiting = mapNeed?.pasted;
  // A map pasted, waiting on a permission now set to Never: its line goes, and the status says why.
  if (ov.waitRefused(waiting, (c, s) => permissions.state(c, s))) { needFor(waiting, waiting.pending); inTurn(() => readmitKept()); }
  else if (waiting && waiting.subjects.every(([c, s]) => permissions.allowed(c, s))) { mapNeed = ov.withNeed(mapNeed, { pasted: null }); addMap(waiting.pending); inTurn(() => readmitKept()); }
  // Otherwise the maps kept are looked at again: what they wait on is joined to the map pasted's, never put in its place.
  else inTurn(() => readmitKept());
  renderMaps();
}

// ---- The rest ------------------------------------------------------------------------------------
// Chora's working database is in a pool that one tab alone can hold (src/engine/worker.js), so Chora in a
// second tab cannot start: it says so, and opens nothing (the page's own tools work as ever).
function inAnotherTab() {
  $('phase').innerHTML = `<span class="warn">${esc(CHORA_TEXT['chora-in-another-tab'])}</span>`;
  Object.assign(state, { phase: 'in-another-tab' });
}
function fail(message) {
  $('phase').innerHTML = `<span class="warn">Something went wrong: ${esc(message)}</span>`;
  Object.assign(state, { phase: 'error', error: message });
}
const n = (x) => (x || 0).toLocaleString('en-GB');
function boxOf(geoms) {
  let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
  const walk = (c) => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); nn = Math.max(nn, c[1]); } else c.forEach(walk); };
  for (const g of geoms) walk(g.coordinates);
  return w === Infinity ? null : [w, s, e, nn];
}

// A basemap whose style cannot be loaded leaves no map to draw on: Natural Earth, from this site, instead.
function styleFailed(why, b = basemaps.byId(state.basemap)) {
  if (!b || b.local) return;
  basemapError = state.basemapError = `${b.name} could not be loaded from ${basemaps.originOf(b)} (${why}), so the map is back on Natural Earth, from this site.`;
  $('basemaps').open = true;
  basemaps.choose(basemaps.byId('natural-earth'));
  useBasemap(basemaps.byId('natural-earth'));
}

// ---- The map's key: how well a location is known (src/chora/vague.js) ------------------------------
// Each precision twice, drawn by the functions that draw it on the map: its mark around the disc of a
// point asserted, and a line as an asserted line or area outline is drawn with its casing. Then the
// circle as the map edges it, and no mark. Closed at first, one line to open, so that it covers none of
// the map until it is wanted.
const KEY_LINE = 56;
function renderKey() {
  const ink = STATUS_COLOURS.asserted, half = MARK_SIZE / 2;
  const circle = `<svg viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}"><circle cx="${half}" cy="${half}" r="17" fill="${ink}" fill-opacity=".1" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-dasharray="0.1 5"/><circle cx="${half}" cy="${half}" r="3" fill="${ink}"/></svg>`;
  const syms = (r) => (r.key === 'circle' ? `<span class="key-sym">${circle}</span><span class="key-sym key-line"></span>`
    : `<span class="key-sym"><canvas data-sym="point"></canvas></span><span class="key-sym key-line"><canvas data-sym="line"></canvas></span>`);
  $('map-key-list').innerHTML = `<li class="key-head" data-key="lines"><span class="key-sym-head" aria-hidden="true"><span>point</span><span>line, area</span></span>
    <span>Around a point, its mark; a line or an area outline drawn like this</span></li>`
    + keyRows().map((r) => `<li data-key="${esc(r.key)}"><span class="key-syms" aria-hidden="true">${syms(r)}</span>
    <span><strong>${esc(r.name)}</strong>: ${esc(r.gloss)}</span></li>`).join('');
  const ratio = Math.max(1, Math.ceil(globalThis.devicePixelRatio || 1));
  for (const c of $('map-key-list').querySelectorAll('canvas')) {
    const key = c.closest('li').dataset.key, line = c.dataset.sym === 'line', w = line ? KEY_LINE : MARK_SIZE;
    c.width = w * ratio; c.height = MARK_SIZE * ratio;
    const ctx = c.getContext('2d');
    ctx.scale(ratio, ratio);
    if (line) {
      // A precision's casing and the line on it; with no precision said, the line alone.
      if (!drawLineSample(ctx, key, w, MARK_SIZE, ink)) { ctx.beginPath(); ctx.moveTo(4, half); ctx.lineTo(w - 4, half); ctx.lineWidth = 2.5; ctx.strokeStyle = ink; ctx.stroke(); }
    } else {
      ctx.beginPath(); ctx.arc(half, half, 8.25, 0, 2 * Math.PI); ctx.fillStyle = ink; ctx.fill();
      drawMark(ctx, key, MARK_SIZE);
    }
  }
}

// ---- Mounting ------------------------------------------------------------------------------------
/** Whether `list` is the files Chora has open (the very File objects), or the one its last save handed to the page. */
const isOpen = (list) => (list.length === files.length && list.every((f, i) => f === files[i])) || (list.length === 1 && list[0] === handed);
let started = null;   // the engine's start (startWorker), which the files chosen meanwhile wait for
/**
 * The files chosen in the page's step 1 changed: Chora, shown, opens them (once its engine has started),
 * unless they are what it has open, or the file its save handed over; hidden, it opens them when it is
 * next shown (show()), so that a dataset is not read for a map no one is looking at.
 */
function chosen(list) {
  list = [...(list || [])];
  if (!shown || !list.length || isOpen(list)) return;
  started.then(() => { if (shown && state.phase !== 'in-another-tab' && !isOpen(list)) open(list); });
}
/**
 * Mount Chora in `rootEl`, once in a page's life: its panel and its map are put into it, the map made,
 * and its engine started. `context` is what the page gives it:
 *   files()       the files chosen in the page's step 1, which Chora opens (and chosen(), below, when they change);
 *   choose(files) choose these in step 1 (Chora's own, after a reload for a permission);
 *   saved(file, base) take the dataset a save wrote from `base` (the files Chora had open): chosen in step 1,
 *                 and in a workflow the result of its step, if `base` went to it (a third argument, { traced }: the save
 *                 added places traced from a map, which the step "trace" needs); a promise of what to say, in words;
 *   scope()       the workflow's Scope (Methodos's, as kept), for the adoption's search, or null;
 *   lookup()      the page's WHG lookup, and onRefused(fn) what to tell when a request of it is refused
 *                 for want of permission: the adoption asks WHG through the page's one lookup.
 *   settled()     a promise, settled once the page has chosen what it chooses as it starts (Methodos's takenUp).
 * Returns { state, chosen(files), holds(files), show(), hide() }: the page tells it the files chosen in step 1, and
 * shows and hides it (the map is fitted to its room again; a drawing under way is stopped).
 */
export function mountChora(rootEl, context = {}) {
  if (root) throw new Error('Chora is mounted once in a page.');
  root = rootEl; host = context;
  state = (window.__chora = { phase: 'loading', placeId: null, pendingCount: 0, basemap: null, mapReadyCount: 0, blocked: 0, lastSave: null, overlays: [] });
  // The writes of the historical maps kept not yet on disk (overlays.js), for tests to wait on, like draftWrites.
  Object.defineProperty(state, 'overlayWrites', { get: ov.writesPending, enumerable: true });
  root.innerHTML = html();
  window.__chora_save = save;

  // The panel's controls.
  $('q').oninput = () => { clearTimeout(typing); typing = setTimeout(() => { query = $('q').value.trim(); search('first'); }, 200); };
  $('prev').onclick = () => search('prev');
  $('next').onclick = () => search('next');
  $('list').onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) selectPlace(b.dataset.id); };
  $('card').addEventListener('click', cardClicked);
  $('card').addEventListener('change', cardChanged);
  $('draw-tools').onclick = drawToolsClicked;
  $('snap-ink').onchange = snapChanged;
  $('saving').addEventListener('click', savingClicked);
  $('contributor-form').onsubmit = contributorGiven;
  $('c-cancel').onclick = contributorCancelled;
  $('save').onclick = saveClicked;
  $('basemap-options').addEventListener('change', basemapChanged);
  $('basemap-options').addEventListener('click', basemapClicked);
  $('basemap-options').addEventListener('submit', basemapPasted);
  $('map-form').onsubmit = mapPasted;
  $('map-status').addEventListener('click', mapStatusClicked);
  $('overlay-list').addEventListener('input', overlayInput);
  $('overlay-list').addEventListener('change', overlayChanged);
  $('overlay-list').addEventListener('click', overlayClicked);
  // Tracing a map into a new dataset: its panel and settings, the name form over the map, the list of what is traced.
  tracings = traced.loadTracing();
  $('trace').addEventListener('click', traceClicked);
  $('trace').addEventListener('input', traceInput);
  $('trace').addEventListener('submit', traceSubmitted);
  $('name-panel').addEventListener('submit', namingSubmitted);
  $('name-panel').addEventListener('input', namingInput);
  $('name-panel').addEventListener('change', namingInput);
  $('name-panel').addEventListener('keydown', namingKey);
  $('name-panel').addEventListener('click', (e) => { if (e.target.id === 'chora-name-to') namingAddTo(); else if (e.target.id === 'chora-name-cancel') namingCancelled(); });
  $('traced-list').addEventListener('click', tracedClicked);
  $('traced-list').addEventListener('change', tracedChanged);
  $('traced-prev').onclick = () => { tracedAt = Math.max(0, tracedAt - 1); renderTraced(); };
  $('traced-next').onclick = () => { tracedAt++; renderTraced(); };

  // The map, its key, its drawing and its historical maps.
  listenForTileErrors();
  mapApi = createMap($('map'), { state, onPlaceClick: (id) => selectPlace(id), onStyleError: styleFailed });
  renderKey();
  mapApi.onDraw({
    finish: onFinish,
    // A drawing deleted with the Edit tool (its Delete key) is removed from the drafts too. Clearing
    // the tool to show another place's drawings also deletes, so only the user's own deletions count.
    change: (ids, type, ctx) => {
      if (type !== 'delete' || ctx?.origin === 'api' || showing) return;
      const gone = new Set(ids.map(String));
      if (drafts.some((d) => gone.has(d.id))) { drafts = drafts.filter((d) => !gone.has(d.id)); keepDrafts(); if (view) renderCard(); }
    },
  });
  initMaps();
  updateTraceButtons();
  adopt = createAdopt({ root: $('adopt'), mapApi, state, addAdoption, armConsult: (c) => { consultArmed = c; state.consultArmed = c ? c.record : null; },
    adopted: (placeId) => drafts.filter((d) => d.kind === 'adoption' && d.placeId === placeId),
    // The workflow's Scope (Issue #33), as Methodos keeps it; none outside a workflow.
    scope: () => { const s = host.scope?.(); return s ? normaliseScope(s) : null; },
    lookup: host.lookup, onRefused: host.onRefused });
  // A click on the map while tracing is the trace's (Shift-click carries a line on). Made in the moment after
  // the first press of a trace tool, before ink.js has arrived, it waits for it: the first click of a user
  // who presses "Trace line" and clicks the river is not lost on a slow connection.
  mapApi.map.on('click', async (e) => {
    if (!traceWanted) return;
    const lngLat = e.lngLat, point = [e.point.x, e.point.y], shift = !!e.originalEvent?.shiftKey;
    let tools = inkTools;
    if (!tools) try { tools = await loadInk(); } catch { return; }   // said by setTraceMode, which failed the same way
    if (traceWanted && tools.mode) tools.click(lngLat, point, shift);
  });
  // A permission changed, here or in another tab: the basemap shown, and the historical maps, answer it.
  permissions.onChange(basemapPermissionChanged);
  permissions.onChange(permissionsChanged);
  // The map and the drawing tool, for automated tests; nothing else reads them.
  window.__chora_map = mapApi.map;
  Object.defineProperty(window, '__chora_draw', { get: () => mapApi.draw, configurable: true });
  // The proof that the page's policy is enforced (state.canary; the page's Permissions panel runs it):
  // until it has come, no other site is asked; unless it holds, none ever is.
  state.canary = 'pending';
  permissions.enforced().then((ok) => {
    Object.assign(state, { canary: ok ? 'enforced' : 'not-enforced', canaryWhy: permissions.canaryState()?.why || null });
    // Not enforced: a basemap chosen from another site is not used (current() never offers it, as it is
    // in no policy), and Chora says why rather than offering a reload that would change nothing.
    const w = basemaps.wanted();
    if (!ok && w && !w.local) { unprotected(w); $('basemaps').open = true; renderBasemaps(); }
  });
  // The page's policy is written at load, so a permission allowed is in it from the next one: before
  // the page reloads for it, what Chora shows is kept (the page's files, the place, the view), and taken
  // back after, when the page comes back to #chora. Hidden, it keeps nothing, and says it would lose nothing.
  permissions.onBeforeReload(async () => {
    if (!shown) return;
    state.phase = 'reloading';
    await draftsWritten();
    await ov.keptWritten();
    const m = mapApi.map;
    // And the historical map pasted waiting on the permissions (it is added after the reload), whether maps
    // kept wait too (they are looked at again after every load), and what is typed in its box.
    await keepForReload({ files: host.files?.() || [], placeId: state.placeId, camera: { center: m.getCenter().toArray(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() },
      maps: { ...ov.reloadHandOver(mapNeed), typed: $('map-input').value || '' } });
  });
  // What the reload keeps not: a line or area still being drawn (finished drawings are kept), an
  // address in the paste box not yet added, a save running. Each is said in the panel first, with Cancel.
  const whileShown = (loses) => () => (shown ? loses() : null);
  permissions.onBeforeReload(() => {}, { loses: whileShown(() => {
    try { return mapApi.draw?.getSnapshot().some((f) => f.properties?.currentlyDrawing) ? RELOAD_LOSES.drawing : null; } catch { return null; }
  }) });
  permissions.onBeforeReload(() => {}, { loses: whileShown(() => ($('paste')?.value.trim() ? RELOAD_LOSES.pasted : null)) });
  permissions.onBeforeReload(() => {}, { loses: () => (state.phase === 'saving' ? RELOAD_LOSES.saving : null) });
  // A shape proposed from a map's ink and not yet accepted (RELOAD_LOSES.tracing, R2).
  permissions.onBeforeReload(() => {}, { loses: whileShown(() => (inkTools?.proposal ? RELOAD_LOSES.tracing : null)) });
  // The gazetteer's answers on screen, not yet adopted (an adoption made is kept with the drawings).
  permissions.onBeforeReload(() => {}, { loses: whileShown(() => adopt.loses()) });
  // Who was remembered, checked again (contributor.load): what is kept is written back as checked, so that an ORCID
  // that is not one, however it got into this browser's storage, is neither shown, saved nor listed in the panel.
  try { const c = contributors.load(); if (c) contributors.remember(c); else if (localStorage.getItem('chora-contributor') !== null) contributors.forget(); } catch { /* storage refused: nothing kept */ }
  useBasemap(currentNow());
  started = startWorker().then(async () => {
    // Back from a reload for a permission: the page's dataset, the place and the view as they were. What
    // the page chose as it started (a workflow taken up chooses its step's file) is shown; when it chose
    // none, the files kept are chosen in step 1 again.
    const resumed = await takeResume();
    if (resumed) {
      await host.settled?.();
      const given = host.files?.() || [];
      const list = given.length ? given : resumed.files || [];
      if (list.length) {
        await open(list);
        if (!given.length) host.choose?.(list);
        if (resumed.placeId && dataset) await selectPlace(resumed.placeId);
      }
      if (resumed.camera) mapApi.map.jumpTo(resumed.camera);
      state.resumed = { files: list.map((f) => f.name), placeId: resumed.placeId || null, maps: resumed.maps || null };
      if (resumed.maps?.typed) $('map-input').value = resumed.maps.typed;
      await inTurn(() => readmitKept());
      // The map pasted that was waiting on the permissions just allowed (the maps kept are back already).
      const pending = resumed.maps?.pending;
      if (pending) await addMap(pending);
      return;
    }
    // The user keeps no working data between visits: the drawings not saved and the file last written
    // go now. (The dataset's working copy, in Chora's SQLite pool, is cleared at every start anyway.)
    if (!permissions.keepWorkingData()) {
      await forgetAllDrafts();
      // The historical maps shown last time (chora-overlays/) are working data too, as the panel says.
      for (const d of ['chora-outputs', SAVED]) try { await (await navigator.storage.getDirectory()).removeEntry(d, { recursive: true }); } catch { /* none kept */ }
      await ov.forgetKept();
      // And the tracings' settings and the datasets made from maps (traced.js).
      traced.forgetTracing(); tracings = traced.loadTracing();
      state.workingCleared = true;
    }
    inTurn(() => readmitKept());
    // The dataset chosen in the page's step 1, if there is one, shown at once; at a workflow's step "trace" with
    // none, the dataset made from the map last traced.
    const given = host.files?.() || [];
    if (given.length && !files.length) await open(given);
    else await resumeSeed();
    renderTrace();
  }).catch((e) => (e.kind === 'pool-busy' ? inAnotherTab() : fail(e.message)));
  return {
    state,
    chosen,
    // Whether Chora, shown, has these files open: a reload for a permission brings them back (the page's own
    // reload hook says nothing of them then). Not while it is starting, or its engine is in another tab.
    holds: (list) => shown && !!dataset && state.phase !== 'in-another-tab' && isOpen([...(list || [])]),
    // Shown again: the map is fitted to its room, which it could not measure while hidden, and the files
    // chosen in step 1 meanwhile are opened.
    show() {
      shown = true; mapApi.map.resize(); layers?.pause(false); chosen(host.files?.() || []);
      // At a workflow's step "trace" with nothing chosen: the dataset made from the map last traced (resumeSeed).
      started?.then(() => { if (!(host.files?.() || []).length) resumeSeed(); renderTrace(); });
    },
    // Hidden: a drawing or a trace under way is stopped, so that nothing waits on a map not seen.
    hide() {
      shown = false;
      // The historical maps are not drawn into the map while it is hidden (overlays.js pause): drawn at no size, their renderer throws.
      layers?.pause(true);
      if (traceWanted) setTraceMode(null);
      closeNaming();
      mapApi.setMode('static');
      for (const x of $('draw-tools').querySelectorAll('button')) x.setAttribute('aria-pressed', 'false');
    },
  };
}
