// Chora's page: open a dataset, find a place, see on the map and in its card everything the
// attestations say of it over time; draw a point, line or area as a new attestation; save the whole
// dataset with the drawings added, checked by the version check (Mneme) against what was opened.
// The engine is the same worker as the main page's (src/engine/worker.js, its chora-* commands). The
// page publishes its state on window.__chora for automated tests; nothing else reads it.
import { fmtBytes, formatName, progressText, summary, draftNote, choraDrawingNote, choraSaveText, CHORA_TEXT } from '../engine/words.js';
import { newGeometryAttestation, checkGeoJSON, wrapLongitudes, DrawError, ROLES, PRECISIONS } from '../engine/chora/draw.js';
import { createMap, placeFeatures, contextFeatures, STATUS_COLOURS } from './map.js';
import * as basemaps from './basemaps.js';
import * as contributors from './contributor.js';
import { fingerprint, loadDrafts, saveDrafts, draftsWritten, forgetAllDrafts } from './drafts.js';
import { take as takeHandoff, clear as clearHandoff, keepForReload, takeResume } from './handoff.js';
import { serialQueue, pageRequest, answers } from './queue.js';
import * as permissions from '../lib/permissions.js';

const $ = (id) => document.getElementById(id);
const state = (window.__chora = { phase: 'loading', placeId: null, pendingCount: 0, basemap: null, mapReadyCount: 0, blocked: 0, lastSave: null });
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
    if (data.type === 'progress') { $('phase').textContent = progressText(data); state.progress = data; }
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
  $('handoff').hidden = true; $('save-result').innerHTML = ''; offered = null;
  $('dataset').hidden = false;
  $('dataset').innerHTML = `<ul>${files.map((f) => `<li><span class="name">${esc(f.name)}</span> <span class="count">${fmtBytes(f.size)}</span></li>`).join('')}</ul>`;
  $('phase').textContent = 'Reading…';
  try {
    dataset = await request({ cmd: 'chora-load', files }, 'chora-loaded');
  } catch (e) { return fail(e.message); }
  if (dataset.failure) { $('phase').innerHTML = `<span class="warn">${esc(dataset.failure)}</span>`; Object.assign(state, { phase: 'unrecognised', reason: dataset.failure }); dataset = null; return; }
  const h = dataset.header || {};
  const problems = dataset.report?.errors ? ` <span class="warn">${esc(summary(dataset.report, 'check').problems)} Check it on the <a href="./">main page</a> to see them.</span>` : '';
  $('phase').textContent = '';
  $('dataset').innerHTML = `<p class="dataset-title">${esc(h.title || dataset.input?.name || files[0].name)}</p>`
    + `<p>${n(dataset.places)} place${dataset.places === 1 ? '' : 's'}, ${n(dataset.withGeometry)} with a location on record.${problems}</p>`;
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
  const mine = drafts.filter((d) => d.placeId === id).map((d) => d.geojson);
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
    <h3>Sources</h3>${list(v.sources, (s) => (s.id && /^https?:/.test(s.id) ? `<a href="${esc(s.id)}" rel="noopener">${esc(s.title || s.id)}</a>` : esc(s.title || s.id)))}
    ${v.withdrawn ? `<p class="muted">${n(v.withdrawn)} withdrawn attestation${v.withdrawn === 1 ? '' : 's'} not shown.</p>` : ''}
    <h3>Your drawings</h3>
    <p class="muted">Draw with the tools on the map. Each drawing is added as a new attestation of this place; nothing already there is changed.</p>
    ${drawError ? `<p class="warn" id="draw-error">${esc(drawError)}</p>` : ''}
    <ul class="pending">${mine.map(pendingItem).join('') || '<li class="muted">None yet.</li>'}</ul>`;
}
function pendingItem(d) {
  const opt = (vals, cur, words) => vals.map((x) => `<option value="${x}"${x === cur ? ' selected' : ''}>${esc(words(x))}</option>`).join('');
  return `<li data-draft="${esc(d.id)}"><span class="kind">${esc(KIND[d.geojson.type] || d.geojson.type)}</span>
    <label>What it marks <select data-field="role"><option value="">Not said</option>${opt(['Extent', 'FeaturePoint', 'RepresentativePoint'].filter((r) => ROLES.includes(r)), d.role, (r) => ROLE_WORDS[r] || r)}</select></label>
    <label>How well known <select data-field="precision"><option value="">Not said</option>${opt(PRECISIONS, d.precision, (p) => p.replace('_', ' '))}</select></label>
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
    const c = STATUS_COLOURS[t.status] || STATUS_COLOURS.asserted;
    const when = a === b ? `${a}` : `${a}–${b}`;
    // Its whole text, shown on hover by src/lib/tooltip.js (the row's own text may be cut short).
    return `<g data-tip="${esc(`${t.text || t.facet} (${t.label || when})${STATUS_WORDS[t.status] ? `, ${t.status}` : ''}`)}">
      <text x="${L}" y="${y + 10}" class="tl-text">${esc(trim(`${t.text || t.facet}`, 44))} · ${esc(when)}${STATUS_WORDS[t.status] ? ` · ${t.status}` : ''}</text>
      <rect x="${x(a)}" y="${y + 14}" width="${Math.max(3, x(b) - x(a))}" height="6" rx="2" fill="${c}"${t.status !== 'asserted' ? ` fill-opacity=".45" stroke="${c}" stroke-dasharray="2 1"` : ''}/></g>`;
  }).join('');
  const h = rows.length * H + 16;
  return `<svg class="timeline" viewBox="0 0 ${W} ${h}" role="img" aria-label="When each attestation applies, from ${lo} to ${hi}">${bars}
    <text x="${L}" y="${h - 2}" class="tl-axis">${lo}</text><text x="${W - R}" y="${h - 2}" class="tl-axis" text-anchor="end">${hi}</text></svg>`
    + (undated ? `<p class="muted">Also dated only in words: ${words()}.</p>` : '');
}
const trim = (s, k) => (s.length > k ? s.slice(0, k - 1) + '…' : s);

$('card').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-place]');
  if (a) { e.preventDefault(); selectPlace(a.dataset.place); return; }
  const rm = e.target.closest('button[data-remove]');
  if (rm) removeDraft(rm.closest('[data-draft]').dataset.draft);
});
$('card').addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-field]');
  if (!sel) return;
  const d = drafts.find((x) => x.id === sel.closest('[data-draft]').dataset.draft);
  if (d) { d[sel.dataset.field] = sel.value; keepDrafts(); }
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
  if (existing) { existing.geojson = geojson; keepDrafts(); return; }   // moved or reshaped
  // The basemap drawn on goes into the published notes: a built-in one by name, a pasted one not (its site may be private).
  drafts.push({ id: String(id), placeId: state.placeId, placeLabel: view?.label || '', geojson, role: '', precision: '',
    basemap: basemaps.drawnOn(basemaps.current()), zoom: mapApi.zoom(), drawnAt: new Date().toISOString() });
  keepDrafts();
  renderCard();
}
function showDrafts(list) { showing = true; try { mapApi.showDrafts(list); } finally { showing = false; } }
function removeDraft(id) {
  drafts = drafts.filter((d) => d.id !== id);
  try { mapApi.draw?.removeFeatures([id]); } catch {}
  keepDrafts();
  renderCard();
}
function keepDrafts() {
  // The file last written holds the drawings as they were: once they change, it is not offered.
  if (offered) {
    offered.remove(); offered = null;
    $('save-result').insertAdjacentHTML('beforeend', '<p class="warn">The drawings have changed since that file was written, so it is no longer offered: save again to have them all.</p>');
  }
  state.pendingCount = drafts.length;
  if (fp) saveDrafts(fp, drafts);
  showSaving();
}
$('draw-tools').onclick = (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  mapApi.setMode(b.dataset.mode);
  for (const x of $('draw-tools').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b && b.dataset.mode !== 'static'));
};

// ---- Saving --------------------------------------------------------------------------------------
function showSaving() {
  if (!dataset) return;
  $('saving').hidden = false;
  const places = new Set(drafts.map((d) => d.placeId)).size;
  $('pending-total').textContent = drafts.length
    ? `${n(drafts.length)} drawing${drafts.length === 1 ? '' : 's'} of ${n(places)} place${places === 1 ? '' : 's'}, not yet saved. They are kept in this browser until you save.`
    : 'Nothing drawn yet. Choose a place, and draw on the map.';
  $('save').disabled = !drafts.length;
  const c = contributors.load();
  const line = $('contributor-line');
  line.hidden = !c;
  if (c) line.innerHTML = `Saving as <strong>${esc(c.name)}</strong>${c.orcid ? ` (<a href="${esc(c.orcid)}">${esc(c.orcid.replace('https://orcid.org/', ''))}</a>)` : ''} — <a href="#" id="c-change">change</a> / <a href="#" id="c-forget">forget me</a>`;
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
    additions = drafts.map((d) => ({ placeId: d.placeId, attestation: newGeometryAttestation({
      geojson: d.geojson, role: d.role || undefined, precision: d.precision || undefined, contributor,
      created: d.drawnAt, notes: choraDrawingNote({ basemap: d.basemap, zoom: d.zoom }) }) }));
  } catch (e) { $('save-result').innerHTML = `<p class="warn">${esc(e.message)}</p>`; return; }
  const savedIds = new Set(drafts.map((d) => d.id));
  $('save').disabled = true;
  $('save-result').innerHTML = ''; offered = null;
  state.phase = 'saving';
  let r;
  try { r = await request({ cmd: 'chora-save', files, additions, contributor }, 'done'); } catch (e) { $('save').disabled = false; return fail(e.message); }
  $('save').disabled = false;
  $('phase').textContent = '';
  const added = r.report?.counts?.['attestations added'] ?? r.mneme?.report?.counts?.added ?? null;
  const passed = !!r.mneme?.passed;
  const out = (r.outputs || [])[0];
  const problems = (r.report?.items || []).filter((i) => i.severity === 'error');
  // The verdict in the words the command line uses too (src/engine/words.js), and on failure, why.
  const reasons = [...(r.mneme?.reasons || []), ...problems.map((i) => `${CHORA_TEXT[i.kind] || i.message}${i.examples?.length ? `: ${i.examples.slice(0, 3).join('; ')}` : ''}`)];
  // What the file is, and on a save that passes, what the writing of it reported: for a dataset that
  // was not place-centric PLATO JSON, what its conversion could not carry over, which Mneme, reading
  // the same input the same way, cannot see.
  const converted = dataset.input?.format !== 'plato-json' || dataset.input?.profile !== 'place-centric';
  const notes = (r.report?.items || []).filter((i) => i.severity !== 'error');
  const item = (i) => `<li>${esc(CHORA_TEXT[i.kind] || i.message)}${i.count > 1 ? ` (${n(i.count)})` : ''}${i.examples?.length ? ` <span class="muted">${esc(i.examples.slice(0, 3).join('; '))}</span>` : ''}</li>`;
  $('save-result').innerHTML = `<p class="${passed ? 'good' : 'warn'}">${esc(choraSaveText(r))}</p>`
    + (passed ? `<p>${converted ? `The dataset is ${esc(formatName(dataset.input))}: the saved file is a conversion of it to PLATO JSON (place-centric), with the drawings added.` : 'The saved file is PLATO JSON, as the dataset is, with the drawings added.'}</p>`
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
let basemapError = null;   // why the basemap chosen could not be used
function unprotected(b) {
  basemapError = state.basemapError = `${b.name} cannot be used here: this browser did not show that it enforces the page’s protection, so the map stays on Natural Earth, from this site.`;
}
function renderBasemaps() {
  const cur = basemaps.current(), want = basemaps.wanted();
  const waiting = want && !want.disabled && !want.local && !basemaps.permitted(want) && !basemaps.refused(want) && state.canary !== 'not-enforced' ? want : null;
  $('basemap-name').textContent = cur.name;
  const groups = new Map();
  // A basemap set to Never in Permissions is not offered (and nothing says why: that is Never).
  for (const b of basemaps.all()) { if (basemaps.refused(b)) continue; if (!groups.has(b.group)) groups.set(b.group, []); groups.get(b.group).push(b); }
  $('basemap-options').innerHTML = (basemapError ? `<p class="warn" role="status">${esc(basemapError)}</p>` : '') + [...groups].map(([g, bs]) => `<fieldset><legend>${esc(g)}</legend>${bs.map((b) => `<label class="${b.disabled ? 'disabled' : ''}">
      <input type="radio" name="basemap" value="${esc(b.id)}"${b.id === (waiting || cur).id ? ' checked' : ''}${b.disabled ? ' disabled' : ''}> ${esc(b.name)}${b.disabled ? ` <small>(${esc(b.disabled)})</small>` : ''}
      ${b.group === 'Pasted' ? ` <button type="button" class="link" data-unpaste="${esc(b.id)}">remove</button>` : ''}</label>`).join('')}</fieldset>`).join('')
    + '<div id="basemap-needs"></div>'
    + `<form id="paste-form"><label for="paste">Paste a style address or a tile template</label>
      <input id="paste" type="url" placeholder="https://…/style.json or https://…/{z}/{x}/{y}.png" autocomplete="off">
      <small>Kept in this browser, key and all, and sent to nowhere but that provider.</small>
      <button type="submit">Add</button> <span id="paste-error" class="warn"></span></form>`
    + (state.blocked ? `<p class="muted">Refused ${n(state.blocked)} request${state.blocked === 1 ? '' : 's'} to ${esc(state.blockedOrigins.join(', '))}, not the basemap's site.</p>` : '');
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
  if (basemaps.permitted(b)) useBasemap(b);
  else { $('basemaps').open = true; renderBasemaps(); }
}
$('basemap-options').addEventListener('change', (e) => {
  if (e.target.name !== 'basemap') return;
  const b = basemaps.byId(e.target.value);
  if (b && !b.disabled) want(b);
});
$('basemap-options').addEventListener('click', (e) => {
  if (e.target.dataset.unpaste) {
    const id = e.target.dataset.unpaste;
    basemaps.removePasted(id);
    if (basemaps.current().id === id || state.basemap === id || basemaps.wanted() === null) want(basemaps.byId('natural-earth')); else renderBasemaps();
  }
});
$('basemap-options').addEventListener('submit', (e) => {
  e.preventDefault();
  const b = basemaps.fromPaste($('paste').value);
  if (!b) { $('paste-error').textContent = 'That is not an https address.'; return; }
  basemaps.addPasted(b);
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
    if (origins.join() !== basemaps.originsOf(b).join()) { b = { ...b, origins }; basemaps.addPasted(b); }
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
// Natural Earth at once; one wanted that now may be used (allowed again within this load's policy) is used.
permissions.onChange(() => {
  const shown = basemaps.byId(state.basemap);
  if (shown && !shown.local && !basemaps.permitted(shown)) { useBasemap(basemaps.byId('natural-earth')); return; }
  const w = basemaps.wanted();
  if (w && !w.disabled && w.id !== state.basemap && basemaps.permitted(w)) { useBasemap(w); return; }
  renderBasemaps();
});

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
  await keepForReload({ files, placeId: state.placeId, camera: { center: m.getCenter().toArray(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() } });
});
useBasemap(basemaps.current());
startWorker().then(async () => {
  // Back from a reload for a permission: the dataset, the place and the view as they were.
  const resumed = await takeResume();
  if (resumed) {
    if (resumed.files?.length) {
      await open(resumed.files);
      if (resumed.placeId && dataset) await selectPlace(resumed.placeId);
    }
    if (resumed.camera) mapApi.map.jumpTo(resumed.camera);
    state.resumed = { files: (resumed.files || []).map((f) => f.name), placeId: resumed.placeId || null };
    return;
  }
  // The user keeps no working data between visits: the drawings not saved and the file last written
  // go now. (The dataset's working copy, in Chora's SQLite pool, is cleared at every start anyway.)
  if (!permissions.keepWorkingData()) {
    await forgetAllDrafts();
    try { await (await navigator.storage.getDirectory()).removeEntry('chora-outputs', { recursive: true }); } catch { /* none kept */ }
    state.workingCleared = true;
  }
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
