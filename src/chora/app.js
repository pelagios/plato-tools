// Chora's page: open a dataset, find a place, see on the map and in its card everything the
// attestations say of it over time; draw a point, line or area as a new attestation; save the whole
// dataset with the drawings added, checked by the version check (Mneme) against what was opened.
// The engine is the same worker as the main page's (src/engine/worker.js, its chora-* commands). The
// page publishes its state on window.__chora for automated tests; nothing else reads it.
import { fmtBytes, formatName, progressText, summary, draftNote, choraDrawingNote, choraSaveText, choraSavedFormat, choraSaveProgress, choraStorageWarning, choraProblemText, CHORA_TEXT } from '../engine/words.js';
import { sizeRead, loadNeed, saveNeed, storageShort } from '../engine/chora/storage.js';
import { detect } from '../engine/input.js';
import { newGeometryAttestation, checkGeoJSON, wrapLongitudes, DrawError, ROLES, PRECISIONS } from '../engine/chora/draw.js';
import { createMap, placeFeatures, contextFeatures, STATUS_COLOURS } from './map.js';
import * as basemaps from './basemaps.js';
import * as contributors from './contributor.js';
import { fingerprint, loadDrafts, saveDrafts, draftsWritten, forgetAllDrafts } from './drafts.js';
import { take as takeHandoff, clear as clearHandoff, keepForReload, takeResume } from './handoff.js';
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
import { CHORA_ADOPT_PAGE } from '../engine/words.js';
// The tools' own version, for the notes of a shape traced with assistance.
import { version as toolsVersion } from '../../package.json';

const $ = (id) => document.getElementById(id);
const state = (window.__chora = { phase: 'loading', placeId: null, pendingCount: 0, basemap: null, mapReadyCount: 0, blocked: 0, lastSave: null, overlays: [] });
const PAGE = 50;
let showing = false;   // true while the drawings shown are being replaced
let worker, files = [], fp = null, dataset = null, drafts = [], view = null, total = 0, query = '';
let starts = [0], nextAfter = null;   // where each page of the list shown so far begins (after which place), and where the next would
let offered = null;    // the button that saves the file last written, while the drawings are those it holds
let drawError = null;  // why the last drawing was not kept, shown in the card

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
  // A SQLite pool of Chora's own, so that this page and the main page can be open at once.
  return request({ cmd: 'init', base: new URL('./', location.href).href, pool: 'chora' }, 'ready').then(({ version: v }) => {
    $('plato-version').innerHTML = `${v.versionInfo} at <a href="${v.repository}/tree/${v.commit}">${v.commit.slice(0, 7)}</a>`
      + (v.draft ? ` <strong class="draft">${draftNote(v)}</strong>` : '');
    Object.assign(state, { phase: 'ready', platoCommit: v.commit });
  });
}

// ---- Opening a dataset ---------------------------------------------------------------------------
async function open(list) {
  if (state.phase === 'in-another-tab') return;
  files = [...list];
  if (!files.length) return;
  Object.assign(state, { phase: 'opening', placeId: null, lastSave: null });
  for (const id of ['places', 'card', 'saving']) $(id).hidden = true;
  adopt.close();
  $('handoff').hidden = true; $('save-result').innerHTML = ''; offered = null;
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
  const problems = dataset.report?.errors ? ` <span class="warn">${esc(summary(dataset.report, 'check').problems)} Check it on the <a href="./">main page</a> to see them.</span>` : '';
  $('phase').textContent = '';
  $('dataset').innerHTML = `<p class="dataset-title">${esc(h.title || dataset.input?.name || files[0].name)}</p>`
    + `<p>${n(dataset.places)} place${dataset.places === 1 ? '' : 's'}, ${n(dataset.withGeometry)} with a location on record.${problems}</p>`;
  $('save').textContent = `Save as ${choraSavedFormat(dataset.input).words}`;
  fp = fingerprint(files);
  drafts = await loadDrafts(fp);
  const ov = await request({ cmd: 'chora-overview' }, 'chora-overview');
  mapApi.setOverview(ov.geojson);
  mapApi.setPlace(null); mapApi.setContext(null); showDrafts([]);
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
$('q').oninput = () => { clearTimeout(typing); typing = setTimeout(() => { query = $('q').value.trim(); search('first'); }, 200); };
$('prev').onclick = () => search('prev');
$('next').onclick = () => search('next');
$('list').onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) selectPlace(b.dataset.id); };

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
  $('card').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  mapApi.setPlace(placeFeatures(view));
  mapApi.setContext(contextFeatures(view, await countries(view), (view.ccodes || []).map((c) => [c, ccodeBoxes?.[c]]).filter(([, b]) => b)));
  showDrafts(drafts.filter((d) => d.placeId === id));
  adopt.placeShown(view);
  const mine = drafts.filter((d) => d.placeId === id && d.geojson).map((d) => d.geojson);
  mapApi.fit(view.fallback?.bbox || (mine.length ? boxOf(mine) : null), view.fallback?.kind === 'ccodes' ? 6 : 9);
  $('draw-tools').hidden = false;
  state.phase = 'place';
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

const STATUS_WORDS = { denied: 'denied', doubted: 'doubted', reported: 'reported', tentative: 'tentative' };
const badge = (s) => (STATUS_WORDS[s] ? ` <span class="status status-${s}" data-tip="${esc(STATUS_TITLES[s])}">${s}</span>` : '');
const STATUS_TITLES = {
  denied: 'The source says this is NOT so.', doubted: 'The source reports this, and doubts it.',
  reported: 'The source reports this as said by others.', tentative: 'The source gives this tentatively.',
};
const ROLE_WORDS = { Extent: 'the whole place', FeaturePoint: 'a feature of it', RepresentativePoint: 'a point standing for it', LabelAnchor: 'where its label goes', Itinerary: 'a route' };
const tailOf = (iri) => (iri ? String(iri).split(/[#/]/).pop() : '');

function renderCard() {
  const v = view, card = $('card');
  card.hidden = false;
  const fb = v.fallback || {};
  const where = v.geometries.length ? ''
    : fb.kind === 'related' ? '<p class="note">No location recorded; showing the places it is related to.</p>'
    : fb.kind === 'ccodes' ? `<p class="note">No location recorded; showing its countr${v.ccodes.length === 1 ? 'y' : 'ies'} (${esc(v.ccodes.join(', '))}).</p>`
    : '<p class="note">No location recorded, and nothing to place it by.</p>';
  const list = (items, fn) => (items.length ? `<ul>${items.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>` : '<p class="muted">None recorded.</p>');
  const mine = drafts.filter((d) => d.placeId === v.id);
  card.innerHTML = `<h2 id="card-h">${esc(v.label)}</h2>
    <p class="muted place-id">${esc(v.id)}${v.ccodes.length ? ` · ${esc(v.ccodes.join(', '))}` : ''}</p>${where}
    <h3>Names</h3>${list(v.names, (x) => `${esc(x.toponym)}${x.language ? ` <span class="muted">(${esc(x.language)})</span>` : ''}${x.romanized ? ` <span class="muted">${esc(x.romanized)}</span>` : ''}${badge(x.status)}`)}
    <h3>Types</h3>${list(v.types, (x) => `${esc(x.label || '')}${badge(x.status)}`)}
    <h3>Locations</h3>${list(v.geometries, (g) => `${esc(g.geojson.type)}${g.role ? `, ${esc(ROLE_WORDS[tailOf(g.role)] || tailOf(g.role))}` : ''}${g.precision ? `, ${esc(g.precision.replace('_', ' '))}` : ''}${g.precisionKm != null ? ` (±${esc(g.precisionKm)} km)` : ''}${g.timespan?.label || g.timespan?.start ? ` <span class="muted">${esc(g.timespan.label || `${g.timespan.start ?? ''}–${g.timespan.end ?? ''}`)}</span>` : ''}${badge(g.status)}`)}
    <h3>Related places</h3>${list(v.relations, (r) => `${esc(r.typeLabel || tailOf(r.type))}: ${r.related ? `<a href="#" data-place="${esc(r.related.id)}">${esc(r.label)}</a>` : esc(r.label)}${badge(r.status)}`)}
    <h3>Over time</h3>${timeline(v.timeline)}
    <h3>Sources</h3>${list(v.sources, (s) => (s.id && /^https?:/.test(s.id) ? `<a href="${esc(s.id)}" rel="noopener noreferrer">${esc(s.title || s.id)}</a>` : esc(s.title || s.id)))}
    ${v.withdrawn ? `<p class="muted">${n(v.withdrawn)} withdrawn attestation${v.withdrawn === 1 ? '' : 's'} not shown.</p>` : ''}
    <h3>Gazetteer</h3>
    <p><button type="button" id="adopt-find"${isPlaceIri(v.id) ? '' : ' disabled aria-describedby="adopt-why"'}>${esc(CHORA_ADOPT_PAGE.find)}</button>${isPlaceIri(v.id) ? '' : ` <span class="muted" id="adopt-why">${esc(CHORA_ADOPT_PAGE.noAddress)}</span>`}</p>
    <h3>Your drawings</h3>
    <p class="muted">Draw with the tools on the map. Each drawing is added as a new attestation of this place; nothing already there is changed.</p>
    ${drawError ? `<p class="warn" id="draw-error">${esc(drawError)}</p>` : ''}
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

// The timeline: one row per dated attestation, a bar from its start to its end, in its status's
// colour. Years only; a date that is not a year is read for its year.
function timeline(items) {
  const year = (x) => { const m = x == null ? null : String(x).match(/^(-?\d{1,6})/); return m ? Number(m[1]) : null; };
  const rows = items.map((t) => ({ ...t, a: year(t.start), b: year(t.end) })).filter((t) => t.a !== null || t.b !== null);
  const undated = items.length - rows.length;
  // Dates given only in words ("undated", "in the reign of Henry II"), each once, with how many.
  const words = () => {
    const c = new Map();
    for (const t of items) if ((year(t.start) ?? year(t.end)) === null && t.label) c.set(t.label, (c.get(t.label) || 0) + 1);
    return [...c].map(([w, k]) => `“${esc(w)}”${k > 1 ? ` (${k})` : ''}`).join(', ');
  };
  if (!rows.length) return `<p class="muted">${items.length ? `Dated only in words: ${words()}.` : 'No dates recorded.'}</p>`;
  let lo = Math.min(...rows.map((t) => t.a ?? t.b)), hi = Math.max(...rows.map((t) => t.b ?? t.a));
  if (hi === lo) { lo -= 10; hi += 10; }
  const W = 320, L = 4, R = 4, H = 26, x = (y) => L + ((y - lo) / (hi - lo)) * (W - L - R);
  const bars = rows.map((t, i) => {
    const a = t.a ?? t.b, b = t.b ?? t.a, y = i * H;
    // In its status's colour, from the stylesheet (svg.timeline .tl-…), so that it follows the colour theme.
    const s = STATUS_COLOURS[t.status] ? t.status : 'asserted';
    const when = a === b ? `${a}` : `${a}–${b}`;
    // Its whole text, shown on hover by src/lib/tooltip.js (the row's own text may be cut short).
    return `<g data-tip="${esc(`${t.text || t.facet} (${t.label || when})${STATUS_WORDS[t.status] ? `, ${t.status}` : ''}`)}">
      <text x="${L}" y="${y + 10}" class="tl-text">${esc(trim(`${t.text || t.facet}`, 44))} · ${esc(when)}${STATUS_WORDS[t.status] ? ` · ${t.status}` : ''}</text>
      <rect x="${x(a)}" y="${y + 14}" width="${Math.max(3, x(b) - x(a))}" height="6" rx="2" class="tl-bar tl-${s}"${s !== 'asserted' ? ' fill-opacity=".45" stroke-dasharray="2 1"' : ''}/></g>`;
  }).join('');
  const h = rows.length * H + 16;
  return `<svg class="timeline" viewBox="0 0 ${W} ${h}" role="img" aria-label="When each attestation applies, from ${lo} to ${hi}">${bars}
    <text x="${L}" y="${h - 2}" class="tl-axis">${lo}</text><text x="${W - R}" y="${h - 2}" class="tl-axis" text-anchor="end">${hi}</text></svg>`
    + (undated ? `<p class="muted">Also dated only in words: ${words()}.</p>` : '');
}
const trim = (s, k) => (s.length > k ? s.slice(0, k - 1) + '…' : s);

$('card').addEventListener('click', (e) => {
  if (e.target.closest('#adopt-find')) { if (view) adopt.openFor(view); return; }
  const a = e.target.closest('a[data-place]');
  if (a) { e.preventDefault(); selectPlace(a.dataset.place); return; }
  const rm = e.target.closest('button[data-remove]');
  if (rm) removeDraft(rm.closest('[data-draft]').dataset.draft);
});
$('card').addEventListener('change', (e) => {
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
});

// ---- Drawing -------------------------------------------------------------------------------------
function onFinish(id, ctx) {
  const f = mapApi.draw?.getSnapshotFeature(id);
  if (!f) return;
  const existing = drafts.find((d) => d.id === String(id));
  if (!existing && ctx?.action && ctx.action !== 'draw') return;
  if (!existing && !state.placeId) { mapApi.draw.removeFeatures([id]); return; }
  // Drawn on a copy of the world, east or west of it, its longitudes run past 180: it is brought back
  // onto the world, whole, and checked as the save will check it. One across the antimeridian cannot
  // be a PLATO geometry as drawn; it is not kept (or, moved there, goes back), and the card says why.
  const geojson = wrapLongitudes(f.geometry);
  try { checkGeoJSON(geojson); } catch (e) {
    if (!(e instanceof DrawError)) throw e;
    drawError = state.drawError = `${KIND[f.geometry.type] || 'A drawing'} ${existing ? 'moved' : 'drawn'} for ${existing?.placeLabel || view?.label || 'this place'} was not kept. ${e.message}`;
    setTimeout(() => { try { if (existing) mapApi.draw?.updateFeatureGeometry(id, existing.geojson); else mapApi.draw?.removeFeatures([id]); } catch {} });
    if (view) renderCard();
    return;
  }
  if (geojson !== f.geometry) setTimeout(() => { try { mapApi.draw?.updateFeatureGeometry(id, geojson); } catch {} });
  drawError = state.drawError = null;
  if (existing) {   // moved or reshaped: a traced drawing is traced again from its map, or no longer cites it
    existing.geojson = geojson; keepDrafts();
    if (existing.trace) traceDraft(existing, { only: existing.trace.key, reshaped: true });
    return;
  }
  const d = newDraft(id, geojson);
  if (layers?.entries.length) traceDraft(d);
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
  if (d.defaulted) { d.role = ''; d.precision = ''; d.defaulted = false; }
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
}
// Adoptions are not drawings: they are not given to the drawing tool (adopt-ui.js shows them).
function showDrafts(list) { showing = true; try { mapApi.showDrafts(list.filter((d) => d.kind !== 'adoption')); } finally { showing = false; } }
let consultArmed = null;   // { placeId, record, name, … }: the next drawing of that place cites the record as consulted
/** An adoption, kept with the drawings until saved (one draft: its attestations go, and are removed, together). */
function addAdoption(d) { drafts.push(d); keepDrafts(); renderCard(); }
function removeDraft(id) {
  const wasAdoption = drafts.some((d) => d.id === id && d.kind === 'adoption');
  drafts = drafts.filter((d) => d.id !== id);
  if (!wasAdoption) try { mapApi.draw?.removeFeatures([id]); } catch {}
  keepDrafts();
  renderCard();
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
  if (fp) { state.draftWrites = (state.draftWrites || 0) + 1; saveDrafts(fp, drafts).finally(() => { state.draftWrites--; }); }
  showSaving();
}
$('draw-tools').onclick = (e) => {
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
};

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
$('snap-ink').onchange = async (e) => { try { (await loadInk()).setSnap(e.target.checked); } catch {} };
/**
 * A proposal accepted: an ordinary drawing, cited from the map it was traced from, its round trip checked.
 * Returns null when it is a drawing now, else why not in words (the proposal is then kept).
 */
function acceptTraced({ geometry, key, assisted, note }) {
  if (!state.placeId) return 'Choose a place first (a drawing is added to the place chosen), then press Enter again: the proposal is kept until then.';
  const [res] = mapApi.draw.addFeatures([{ type: 'Feature', geometry, properties: { mode: geometry.type === 'Polygon' ? 'polygon' : 'linestring' } }]);
  if (!res?.valid) { drawError = state.drawError = `The shape could not be made a drawing (${res?.reason || 'refused'}).`; if (view) renderCard(); return drawError; }
  // What accepting did to it (its holes left out) is kept apart from what tracing says, so neither replaces the other.
  const d = newDraft(res.id, geometry, { assistedPending: assisted, ...(note ? { acceptNote: note, traceNote: note } : {}) });
  traceDraft(d, { only: key });
  return null;
}

// ---- Saving --------------------------------------------------------------------------------------
function showSaving() {
  if (!dataset) return;
  $('saving').hidden = false;
  const places = new Set(drafts.map((d) => d.placeId)).size;
  const adoptions = drafts.filter((d) => d.kind === 'adoption').length, drawings = drafts.length - adoptions;
  const what = [drawings ? `${n(drawings)} drawing${drawings === 1 ? '' : 's'}` : '', adoptions ? `${n(adoptions)} location${adoptions === 1 ? '' : 's'} adopted from a gazetteer` : ''].filter(Boolean).join(' and ');
  $('pending-total').textContent = drafts.length
    ? `${what} of ${n(places)} place${places === 1 ? '' : 's'}, not yet saved. ${permissions.keepWorkingData() ? 'They are kept in this browser until you save.' : 'Save them before you leave: you chose not to keep working data between visits.'}`
    : 'Nothing drawn yet. Choose a place, and draw on the map.';
  $('save').disabled = !drafts.length;
  const c = contributors.load();
  const line = $('contributor-line');
  line.hidden = !c;
  if (c) line.innerHTML = `Saving as <strong>${esc(c.name)}</strong>${c.orcid ? ` (<a href="${esc(c.orcid)}" rel="noopener noreferrer">${esc(c.orcid.replace('https://orcid.org/', ''))}</a>)` : ''} — <a href="#" id="c-change">change</a> / <a href="#" id="c-forget">forget me</a>`;
}
$('saving').addEventListener('click', (e) => {
  if (e.target.id === 'c-change') { e.preventDefault(); askContributor(); }
  if (e.target.id === 'c-forget') { e.preventDefault(); contributors.forget(); showSaving(); }
});
function askContributor() {
  const c = contributors.load() || {};
  $('c-name').value = c.name || ''; $('c-orcid').value = c.orcid ? c.orcid.replace('https://orcid.org/', '') : '';
  $('c-error').hidden = true;
  $('contributor-form').hidden = false; $('contributor-line').hidden = true;
  $('c-name').focus();
}
let saveAfterAsking = false;
$('contributor-form').onsubmit = (e) => {
  e.preventDefault();
  const c = contributors.fromForm($('c-name').value, $('c-orcid').value);
  if (c.error) { $('c-error').textContent = c.error; $('c-error').hidden = false; return; }
  contributors.remember(c);
  $('contributor-form').hidden = true;
  showSaving();
  if (saveAfterAsking) { saveAfterAsking = false; saveDataset(); }
};
$('c-cancel').onclick = () => { saveAfterAsking = false; $('contributor-form').hidden = true; showSaving(); };
$('save').onclick = () => {
  if (!contributors.load()) { saveAfterAsking = true; askContributor(); return; }
  saveDataset();
};

async function saveDataset() {
  const contributor = contributors.load();
  let additions;
  try {
    // A traced drawing cites the map and its georeference, and says so in its notes (trace.js).
    // An adoption gives its two attestations (one when the place was already linked), made now that the contributor is known.
    additions = drafts.flatMap((d) => {
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
  try { r = await request({ cmd: 'chora-save', files, additions, contributor }, 'done'); } catch (e) { $('save').disabled = false; $('save-progress').hidden = true; return fail(e.message); }
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
    const letGo = (said) => {
      offered = null; box.remove();
      // The file is on the user's disk: one who keeps no working data has no copy of it left here.
      if (!permissions.keepWorkingData()) navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('chora-outputs')).then((d) => d.removeEntry(out.name)).catch(() => {});
      drafts = drafts.filter((d) => !savedIds.has(d.id)); keepDrafts(); showDrafts(drafts.filter((d) => d.placeId === state.placeId)); if (view) renderCard();
      $('save-result').insertAdjacentHTML('beforeend', `<p>${said} To add more, open ${esc(out.name)}.</p>`);
    };
    b.onclick = async () => {
      let done;
      try { done = await save(out.name); } catch (e) {
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
  state.phase = 'saved';
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
async function save(name) {
  const root = await navigator.storage.getDirectory();
  const file = await (await (await root.getDirectoryHandle('chora-outputs')).getFileHandle(name)).getFile();
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
window.__chora_save = save;

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
    + (remembered ? `<p class="needs-permission" id="basemap-remembered">${esc(REMEMBERED_BASEMAP.line(remembered.name))} <button type="button" class="link" id="use-remembered">${esc(REMEMBERED_BASEMAP.use)}</button></p>` : '')
    + '<div id="basemap-needs"></div>' + [...groups].map(([g, bs]) => `<fieldset><legend>${esc(g)}</legend>${bs.map((b) => `<label class="${b.disabled ? 'disabled' : ''}">
      <input type="radio" name="basemap" value="${esc(b.id)}"${b.id === (waiting || cur).id ? ' checked' : ''}${b.disabled ? ' disabled' : ''}> ${esc(b.name)}${b.disabled ? ` <small>(${esc(b.disabled)})</small>` : ''}
      ${b.group === 'Pasted' ? ` <button type="button" class="link" data-unpaste="${esc(b.id)}">remove</button>` : ''}</label>`).join('')}</fieldset>`).join('')
    + `<form id="paste-form"><label for="paste">Paste a style address or a tile template</label>
      <input id="paste" type="url" placeholder="https://…/style.json or https://…/{z}/{x}/{y}.png" autocomplete="off">
      <button type="submit">Add</button> <span id="paste-error" class="warn"></span></form>`
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
$('basemap-options').addEventListener('change', (e) => {
  if (e.target.name !== 'basemap') return;
  const b = listed.get(e.target.value);
  if (b && !b.disabled) want(b);
});
$('basemap-options').addEventListener('click', (e) => {
  if (e.target.id === 'use-remembered') { const w = listed.get(state.basemapRemembered); if (w) want(w); return; }
  if (e.target.dataset.unpaste) {
    const id = e.target.dataset.unpaste;
    basemaps.removePasted(id);
    if (chosenHere?.id === id) chosenHere = null;
    if (currentNow().id === id || state.basemap === id || basemaps.wanted() === null) want(basemaps.byId('natural-earth')); else renderBasemaps();
  }
});
$('basemap-options').addEventListener('submit', (e) => {
  e.preventDefault();
  const b = basemaps.fromPaste($('paste').value);
  if (!b) { $('paste-error').textContent = 'That is not an https address.'; return; }
  basemaps.addPasted(b);
  $('paste').value = '';   // added: nothing waits in the box now
  want(b);
});
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
permissions.onChange(() => {
  const shown = basemaps.byId(state.basemap);
  if (shown && !shown.local && !basemaps.permitted(shown)) { useBasemap(basemaps.byId('natural-earth')); return; }
  const w = basemaps.wanted();
  if (w && !w.disabled && w.id !== state.basemap && basemaps.permitted(w) && (basemaps.automatic(w) || basemaps.sameBasemap(w, chosenHere))) { useBasemap(basemaps.automatic(w) ? w : chosenHere); return; }
  renderBasemaps();
});

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
    let r, keptEntry = null;
    if (pending.kept) {
      keptEntry = (await ov.kept()).find((k) => k.key === pending.kept);
      if (!keptEntry) return null;
      r = await ov.resolve({ kind: 'annotation', annotation: keptEntry.item, manifest: keptEntry.manifest, fetchedAt: keptEntry.fetchedAt }, deps);
      r.manifestUrl = keptEntry.manifestUrl || r.manifestUrl;
    } else if (pending.parsed) {
      r = await ov.resolve(pending.parsed, deps);
      r.manifestUrl ||= pending.manifestUrl || null;
    } else {
      r = await ov.resolve(ov.parseInput(pending.text), deps);
      if (r.services) {
        mapOffer = { ...r, text: pending.text, notFound: false };
        if (!pending.lookup) { setStatus(''); renderMaps(); return null; }
        const found = await ov.lookup(r.services, deps);
        if (!found) { mapOffer.notFound = true; setStatus(''); renderMaps(); return null; }
        const manifestUrl = mapOffer.manifestUrl;
        r = await ov.resolve({ kind: 'annotation', annotation: found.annotation, fetchedAt: found.fetchedAt, manifest: r.manifest, url: found.url }, deps);
        r.manifestUrl ||= manifestUrl || null;
      }
    }
    mapOffer = null;
    const a = await ov.admit(r, { ...deps, enforced: true });
    await showMap(a, keptEntry);
  } catch (e) {
    if (e instanceof ov.NeedPermission) { if (collect) return e; needFor(e, pending); return null; }
    // A map kept that cannot be shown now (its server down, say) is left for the next load; what is said
    // of the map last pasted stays (this runs on every change of permission).
    if (collect) { console.warn('Chora: a map kept could not be shown', e); state.keptError = e.message; return null; }
    if (e instanceof ov.NeedChoice) {
      // Several georeferences of the map: the user chooses, the most recently changed offered first.
      mapChoice = { choices: e.choices, chosen: e.defaultIndex, manifestUrl: mapOffer?.manifestUrl || null,
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
// dispatched). So the page listens there, for the tiles of its own maps only, and says so in plain words.
{
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
  let html = '';
  if (mapChoice) {
    const one = (c) => `Georeference ${c.index + 1}${c.label ? `: ${esc(c.label)}` : ''} <span class="muted">(${c.modified ? `changed ${esc(c.modified.slice(0, 10))}` : 'no date given'}, ${c.gcps === null ? 'control points not given' : `${c.gcps} control point${c.gcps === 1 ? '' : 's'}`}${c.id ? `; ${esc(c.id)}` : ''})</span>`;
    html += `<div class="choice" id="map-choice" role="group" aria-labelledby="map-choice-text"><p id="map-choice-text">This holds ${mapChoice.choices.length} georeferences of the map, made separately. Choose the one to show (the most recently changed is chosen):</p>
      <ul class="choices">${mapChoice.choices.map((c) => `<li><label><input type="radio" name="georef-choice" value="${c.index}"${c.index === mapChoice.chosen ? ' checked' : ''}> ${one(c)}</label></li>`).join('')}</ul>
      <p><button type="button" class="primary" id="map-choose">Show this one</button> <button type="button" id="map-choose-no">Not now</button></p></div>`;
  }
  if (mapOffer) {
    const name = mapOffer.title ? `“${esc(mapOffer.title)}”` : 'This map';
    // The Editor is linked unless Allmaps is set to Never, saying what following it sends (overlays.js).
    const editor = editorShown() ? `<a href="${esc(ov.editorUrl(mapOffer.manifestUrl, mapOffer.services[0]))}" target="_blank" rel="noopener noreferrer" id="map-editor">${esc(ov.EDITOR_LINK_TEXT)}</a>` : '';
    html += `<div class="offer"><p>${name} came with no georeference${mapOffer.notFound ? ', and Allmaps has none for it' : ''}.</p>
      ${mapOffer.notFound ? '' : '<p><button type="button" class="primary" id="map-lookup">Look for a georeference</button></p>'}
      ${editor ? `<p>${mapOffer.notFound ? 'You can' : 'Or'} georeference it in the Allmaps Editor, and paste here the georeference it makes: ${editor}</p>` : `<p>${mapOffer.notFound ? 'You can georeference it elsewhere, and' : 'Or'} paste a georeference of it here.</p>`}</div>`;
  }
  if (mapStatus) {
    const warn = mapStatus.startsWith('warn:');
    html += `<p class="${warn ? 'warn' : 'muted'}">${esc(mapStatus.replace(/^warn:/, ''))}${mapLink ? ` <a href="${esc(mapLink)}" target="_blank" rel="noopener noreferrer" id="map-forwards">${esc(mapLink)}</a>` : ''}</p>`;
  }
  $('map-status').innerHTML = html;
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
      ${editorShown() ? `<p><a href="${esc(ov.editorUrl(e.manifestUrl, e.g.imageServiceId))}" target="_blank" rel="noopener noreferrer" data-editor>${esc(ov.EDITOR_LINK_TEXT)}</a></p>` : ''}</li>`;
  }).join('');
}
$('map-form').onsubmit = (e) => { e.preventDefault(); mapOffer = null; mapChoice = null; addMap({ text: $('map-input').value }); };
$('map-status').addEventListener('click', (e) => {
  if (e.target.id === 'map-choose' && mapChoice) {
    const picked = $('map-status').querySelector('input[name="georef-choice"]:checked');
    const { parsed, manifestUrl, chosen } = mapChoice; mapChoice = null;
    addMap({ parsed: { ...parsed, index: picked ? Number(picked.value) : chosen }, manifestUrl });
  } else if (e.target.id === 'map-choose-no') { mapChoice = null; setStatus(''); renderMaps(); }
  else if (e.target.id === 'map-lookup' && mapOffer) addMap({ text: mapOffer.text, lookup: true });
});
$('overlay-list').addEventListener('input', (e) => {
  const li = e.target.closest('[data-overlay]'); if (!li) return;
  const o = state.overlays.find((x) => x.key === li.dataset.overlay);
  if (e.target.matches('[data-opacity]')) { o.opacity = Number(e.target.value) / 100; layers.set(o.key, { opacity: o.opacity }); keepOverlay(o); }
});
$('overlay-list').addEventListener('change', (e) => {
  const li = e.target.closest('[data-overlay]'); if (!li) return;
  const o = state.overlays.find((x) => x.key === li.dataset.overlay);
  if (e.target.matches('[data-show]')) { o.visible = e.target.checked; layers.set(o.key, { visible: o.visible }); keepOverlay(o); updateTraceButtons(); }
});
$('overlay-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-overlay]'); if (!li) return;
  const key = li.dataset.overlay;
  if (e.target.matches('[data-permissions]')) permissions.open({ focus: e.target.dataset.permissions });
  if (e.target.matches('[data-fit]')) fitMap(key);
  if (e.target.matches('[data-remove-map]')) {
    layers.remove(key);
    ov.letGo(key).then(() => { state.overlays = state.overlays.filter((x) => x.key !== key); renderMaps(); updateTraceButtons(); });
  }
});
async function keepOverlay(o) {
  const k = (await ov.kept()).find((x) => x.key === o.key);
  if (k) ov.keep({ ...k, opacity: o.opacity, visible: o.visible }).catch(() => {});
}
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
// Chora's working database is in a pool that one tab alone can hold (src/engine/worker.js), so a
// second Chora tab cannot start: it says so, and offers nothing to open.
function inAnotherTab() {
  $('phase').innerHTML = `<span class="warn">${esc(CHORA_TEXT['chora-in-another-tab'])}</span>`;
  $('picker').disabled = true;
  Object.assign(state, { phase: 'in-another-tab' });
}
function fail(message) {
  $('phase').innerHTML = `<span class="warn">Something went wrong: ${esc(message)}</span>`;
  Object.assign(state, { phase: 'error', error: message });
}
const n = (x) => (x || 0).toLocaleString('en-GB');
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function boxOf(geoms) {
  let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
  const walk = (c) => { if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); nn = Math.max(nn, c[1]); } else c.forEach(walk); };
  for (const g of geoms) walk(g.coordinates);
  return w === Infinity ? null : [w, s, e, nn];
}

$('picker').onchange = (e) => open(e.target.files);
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); open(e.dataTransfer.files); };

// A basemap whose style cannot be loaded leaves no map to draw on: Natural Earth, from this site, instead.
function styleFailed(why, b = basemaps.byId(state.basemap)) {
  if (!b || b.local) return;
  basemapError = state.basemapError = `${b.name} could not be loaded from ${basemaps.originOf(b)} (${why}), so the map is back on Natural Earth, from this site.`;
  $('basemaps').open = true;
  basemaps.choose(basemaps.byId('natural-earth'));
  useBasemap(basemaps.byId('natural-earth'));
}
const mapApi = createMap($('map'), { state, onPlaceClick: (id) => selectPlace(id), onStyleError: styleFailed });
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
const adopt = createAdopt({ root: $('adopt'), mapApi, state, addAdoption, armConsult: (c) => { consultArmed = c; state.consultArmed = c ? c.record : null; },
  adopted: (placeId) => drafts.filter((d) => d.kind === 'adoption' && d.placeId === placeId) });
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
// A permission changed: maps whose permission is withdrawn go at once; maps waiting on one go on.
permissions.onChange(permissionsChanged);
// The map and the drawing tool, for automated tests; nothing else reads them.
window.__chora_map = mapApi.map;
Object.defineProperty(window, '__chora_draw', { get: () => mapApi.draw });
// The Permissions panel, from the header's button, and the proof that the page's policy is enforced
// (state.canary): until it has come, no other site is asked; unless it holds, none ever is.
permissions.mount({ state }).then((r) => {
  // Not enforced: a basemap chosen from another site is not used (current() never offers it, as it is
  // in no policy), and the page says why rather than offering a reload that would change nothing.
  const w = basemaps.wanted();
  if (!r?.enforced && w && !w.local) { unprotected(w); $('basemaps').open = true; renderBasemaps(); }
});
// The page's policy is written at load, so a permission allowed is in it from the next one: before
// the page reloads for it, what is open is kept (the files, the place, the view), and taken back after.
permissions.onBeforeReload(async () => {
  state.phase = 'reloading';
  await draftsWritten();
  const m = mapApi.map;
  // And the historical map pasted waiting on the permissions (it is added after the reload), whether maps
  // kept wait too (they are looked at again after every load), and what is typed in its box.
  await keepForReload({ files, placeId: state.placeId, camera: { center: m.getCenter().toArray(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() },
    maps: { ...ov.reloadHandOver(mapNeed), typed: $('map-input').value || '' } });
});
// What the reload keeps not: a line or area still being drawn (finished drawings are kept), an
// address in the paste box not yet added, a save running. Each is said in the panel first, with Cancel.
permissions.onBeforeReload(() => {}, { loses: () => {
  try { return mapApi.draw?.getSnapshot().some((f) => f.properties?.currentlyDrawing) ? RELOAD_LOSES.drawing : null; } catch { return null; }
} });
permissions.onBeforeReload(() => {}, { loses: () => ($('paste')?.value.trim() ? RELOAD_LOSES.pasted : null) });
permissions.onBeforeReload(() => {}, { loses: () => (state.phase === 'saving' ? RELOAD_LOSES.saving : null) });
// A shape proposed from a map's ink and not yet accepted (RELOAD_LOSES.tracing, R2).
permissions.onBeforeReload(() => {}, { loses: () => (inkTools?.proposal ? RELOAD_LOSES.tracing : null) });
// The gazetteer's answers on screen, not yet adopted (an adoption made is kept with the drawings).
permissions.onBeforeReload(() => {}, { loses: () => adopt.loses() });
// Who was remembered, checked again (contributor.load): what is kept is written back as checked, so that an ORCID
// that is not one, however it got into this browser's storage, is neither shown, saved nor listed in the panel.
try { const c = contributors.load(); if (c) contributors.remember(c); else if (localStorage.getItem('chora-contributor') !== null) contributors.forget(); } catch { /* storage refused: nothing kept */ }
useBasemap(currentNow());
startWorker().then(async () => {
  // Back from a reload for a permission: the dataset, the place and the view as they were.
  const resumed = await takeResume();
  if (resumed) {
    if (resumed.files?.length) {
      await open(resumed.files);
      if (resumed.placeId && dataset) await selectPlace(resumed.placeId);
    }
    if (resumed.camera) mapApi.map.jumpTo(resumed.camera);
    state.resumed = { files: (resumed.files || []).map((f) => f.name), placeId: resumed.placeId || null, maps: resumed.maps || null };
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
    for (const dir of ['chora-outputs', 'chora-overlays']) { try { await (await navigator.storage.getDirectory()).removeEntry(dir, { recursive: true }); } catch { /* none kept */ } }
    state.workingCleared = true;
  }
  inTurn(() => readmitKept());
  // Files chosen on the main page, offered here.
  const handed = await takeHandoff();
  if (handed && !files.length) {
    const p = $('handoff');
    p.innerHTML = `<button type="button" class="primary" id="open-handoff">Open ${esc(handed.map((f) => f.name).join(', '))}</button>, chosen on the main page.`;
    p.hidden = false;
    $('open-handoff').onclick = () => open(handed);
    state.handoff = handed.map((f) => f.name);
  }
// A second tab offers nothing, so files handed to it are let go there too, not left in the browser.
}).catch((e) => (e.kind === 'pool-busy' ? clearHandoff().then(inAnotherTab) : fail(e.message)));
