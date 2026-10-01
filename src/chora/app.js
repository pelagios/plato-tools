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
import { fingerprint, loadDrafts, saveDrafts, draftsWritten } from './drafts.js';
import { take as takeHandoff, keepForReload, takeResume } from './handoff.js';
import { canary, inPolicy } from './csp.js';
import * as consents from './consent.js';
import * as ov from './overlays.js';
import { createGuard, GuardError } from './fetchguard.js';
import * as georef from '../engine/georef/index.js';
import * as tracing from '../engine/chora/trace.js';
import { DataError } from '../engine/input.js';

const $ = (id) => document.getElementById(id);
const state = (window.__chora = { phase: 'loading', placeId: null, pendingCount: 0, basemap: null, mapReadyCount: 0, blocked: 0, lastSave: null, canary: 'pending', reloads: 0, overlays: [] });
const PAGE = 50;
let showing = false;   // true while the drawings shown are being replaced
let worker, files = [], fp = null, dataset = null, drafts = [], view = null, offset = 0, total = 0, query = '';
let offered = null;    // the button that saves the file last written, while the drawings are those it holds
let drawError = null;  // why the last drawing was not kept, shown in the card

// ---- The engine ----------------------------------------------------------------------------------
// One request at a time: each waits for the reply of its type (or an error), and progress on the way
// is shown in words.
let queue = Promise.resolve();
function request(msg, replyType) {
  const p = queue.then(() => new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { $('phase').textContent = progressText(data); state.progress = data; }
      else if (data.type === 'error') reject(Object.assign(new Error(data.message), { kind: data.kind }));
      else if (data.type === replyType) resolve(data);
    };
    worker.postMessage(msg);
  }));
  queue = p.catch(() => {});
  return p;
}
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
  await search(0);
  showSaving();
  Object.assign(state, { phase: 'loaded', places: dataset.places, pendingCount: drafts.length });
  if (drafts.length) $('dataset').insertAdjacentHTML('beforeend', `<p class="note">${n(drafts.length)} unsaved drawing${drafts.length === 1 ? ' was' : 's were'} kept from last time, and ${drafts.length === 1 ? 'is' : 'are'} shown with ${drafts.length === 1 ? 'its place' : 'their places'}.</p>`);
}

// ---- The place list ------------------------------------------------------------------------------
async function search(at) {
  const r = await request({ cmd: 'chora-search', q: query, offset: at, limit: PAGE }, 'chora-results');
  offset = at; total = r.total;
  $('found').textContent = total ? `${query ? `${n(total)} found` : `${n(total)} places`}${total > PAGE ? `, showing ${n(at + 1)}–${n(Math.min(at + PAGE, total))}` : ''}.` : 'No place has that in its name.';
  const pending = new Set(drafts.map((d) => d.placeId));
  $('list').innerHTML = r.items.map((p) => `<li><button type="button" class="place${p.id === state.placeId ? ' current' : ''}" data-id="${esc(p.id)}">${esc(p.label || p.id)}`
    + `${p.ccodes?.length ? ` <span class="muted">${esc(p.ccodes.join(', '))}</span>` : ''}${p.hasGeometry ? '' : ' <span class="tag">no location</span>'}${pending.has(p.id) ? ' <span class="tag pending">drawn</span>' : ''}</button></li>`).join('');
  $('prev').disabled = at === 0; $('next').disabled = at + PAGE >= total;
  $('prev').parentElement.hidden = total <= PAGE;
}
let typing;
$('q').oninput = () => { clearTimeout(typing); typing = setTimeout(() => { query = $('q').value.trim(); search(0); }, 200); };
$('prev').onclick = () => search(Math.max(0, offset - PAGE));
$('next').onclick = () => search(offset + PAGE);
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
const badge = (s) => (STATUS_WORDS[s] ? ` <span class="status status-${s}" title="${esc(STATUS_TITLES[s])}">${s}</span>` : '');
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
    <h3>Locations</h3>${list(v.geometries, (g) => `${esc(g.geojson.type)}${g.role ? `, ${esc(ROLE_WORDS[tailOf(g.role)] || tailOf(g.role))}` : ''}${g.precision ? `, ${esc(g.precision.replace('_', ' '))}` : ''}${g.precisionKm != null ? ` (±${g.precisionKm} km)` : ''}${g.timespan?.label || g.timespan?.start ? ` <span class="muted">${esc(g.timespan.label || `${g.timespan.start ?? ''}–${g.timespan.end ?? ''}`)}</span>` : ''}${badge(g.status)}`)}
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
  // A drawing traced from a historical map may mark where the map writes the name (a label anchor).
  const roles = ['Extent', 'FeaturePoint', 'RepresentativePoint', ...(d.trace ? ['LabelAnchor'] : [])].filter((r) => ROLES.includes(r));
  const from = d.traceOptions?.length || d.trace
    ? `<label>Traced from <select data-field="tracedFrom">${[...(d.traceOptions || []).filter((o) => o.key !== d.trace?.key), ...(d.trace ? [{ key: d.trace.key, title: d.trace.title }] : [])]
      .map((o) => `<option value="${esc(o.key)}"${o.key === d.trace?.key ? ' selected' : ''}>${esc(o.title || 'a historical map')}</option>`).join('')}<option value=""${d.trace ? '' : ' selected'}>the basemap</option></select></label>` : '';
  return `<li data-draft="${esc(d.id)}"><span class="kind">${esc(KIND[d.geojson.type] || d.geojson.type)}</span>
    ${from}
    <label>What it marks <select data-field="role"><option value="">Not said</option>${opt(roles, d.role, (r) => (r === 'LabelAnchor' ? 'where the map writes its name' : ROLE_WORDS[r] || r))}</select></label>
    <label>How well known <select data-field="precision"><option value="">Not said</option>${opt(PRECISIONS, d.precision, (p) => p.replace('_', ' '))}</select></label>
    ${d.traceNote ? `<p class="note" data-trace-note>${esc(d.traceNote)}</p>` : ''}
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
    return `<g><title>${esc(`${t.text || t.facet} (${t.label || when})${STATUS_WORDS[t.status] ? `, ${t.status}` : ''}`)}</title>
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
  if (!d) return;
  if (sel.dataset.field === 'tracedFrom') {
    // Chosen by the user: another map it lies on, or the basemap (no citation of any map).
    if (sel.value) traceDraft(d, { only: sel.value });
    else { dropTrace(d, null); keepDrafts(); renderCard(); }
    return;
  }
  d[sel.dataset.field] = sel.value; keepDrafts();
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
  const b = basemaps.current();
  const d = { id: String(id), placeId: state.placeId, placeLabel: view?.label || '', geojson, role: '', precision: '',
    basemap: b.local ? 'Natural Earth' : b.name, zoom: mapApi.zoom(), drawnAt: new Date().toISOString() };
  drafts.push(d);
  keepDrafts();
  renderCard();
  if (layers?.entries.length) traceDraft(d);
}

// ---- Tracing from a historical map ---------------------------------------------------------------
// A drawing made over a historical map is traced from it (src/engine/chora/trace.js): the topmost map
// shown that holds it whole, else the topmost holding part of it (with a warning); the card lets the
// user choose another map it lies on, or the basemap. Its citations are made when it is saved.
const tracing_ = new Map();   // draft id -> the latest tracing asked for it (an older answer is let go)
function dropTrace(d, note) {
  d.trace = null; d.traceNote = note;
  if (d.role === 'LabelAnchor') d.role = '';
}
async function traceDraft(d, { only = null, reshaped = false } = {}) {
  const ticket = {}; tracing_.set(d.id, ticket);
  const shown = layers ? layers.ordered() : [];
  const maps = shown.map((e) => ({ key: e.key, g: e.g, visible: e.visible, title: e.title }));
  const was = d.trace;
  let note = null;
  try {
    const pick = await tracing.pickOverlay(only ? maps.filter((m) => m.key === only) : maps, d.geojson);
    if (tracing_.get(d.id) !== ticket || !drafts.includes(d)) return;
    if (!only) d.traceOptions = pick.candidates.map((k) => ({ key: k, title: maps.find((m) => m.key === k)?.title || null }));
    const skipped = pick.skipped.map((x) => `${maps.find((m) => m.key === x.key)?.title || 'a map'}: ${x.reason}`).join(' ');
    if (!pick.chosen) {
      if (was) note = `${reshaped ? 'Moved' : 'It lies'} off “${was.title || 'the map'}”, the map it was traced from, so it no longer cites that map${skipped ? ` (${skipped})` : ''}; it is saved as drawn on the basemap.`;
      else if (skipped) note = `Not cited as traced from a historical map: ${skipped}`;
      dropTrace(d, note);
    } else {
      const e = shown.find((x) => x.key === pick.chosen.key);
      try {
        const t = await tracing.traceFor(e.g, d.geojson, { key: e.key, title: e.title, partial: pick.chosen.partial, fetchedAt: e.fetchedAt, licence: e.attribution?.licence || null });
        if (tracing_.get(d.id) !== ticket || !drafts.includes(d)) return;
        d.trace = t;
        d.traceNote = pick.chosen.partial ? `Part of it lies outside “${e.title}”, the map it is cited as traced from.` : null;
        if (!d.traceOptions?.some((o) => o.key === e.key)) d.traceOptions = [...(d.traceOptions || []), { key: e.key, title: e.title }];
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
  state.lastTrace = { draftId: d.id, key: d.trace?.key || null, partial: !!d.trace?.partial, note: d.traceNote || null, options: (d.traceOptions || []).map((o) => o.key) };
  keepDrafts();
  if (view) renderCard();
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
    // A traced drawing cites the map and its georeference, and says so in its notes (trace.js).
    additions = drafts.map((d) => ({ placeId: d.placeId, attestation: newGeometryAttestation({
      geojson: d.geojson, role: d.role || undefined, precision: d.precision || undefined, contributor, created: d.drawnAt,
      ...(d.trace ? tracing.tracedParts(d.trace, { zoom: d.zoom, role: d.role }) : { notes: choraDrawingNote({ basemap: d.basemap, zoom: d.zoom }) }) }) }));
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
  $('save-result').innerHTML = `<p class="${passed ? 'good' : 'warn'}">${esc(choraSaveText(r))}</p>`
    + (passed ? `<p>${converted ? `The dataset is ${esc(formatName(dataset.input))}: the saved file is a conversion of it to PLATO JSON (place-centric), with the drawings added.` : 'The saved file is PLATO JSON, as the dataset is, with the drawings added.'}</p>`
      + (notes.length ? `<p>${converted ? 'The conversion' : 'Writing it'} reported:</p><ul class="notes">${notes.map((i) => `<li>${esc(i.message)}${i.count > 1 ? ` (${n(i.count)})` : ''}${i.examples?.length ? ` <span class="muted">${esc(i.examples.slice(0, 3).join('; '))}</span>` : ''}</li>`).join('')}</ul>` : '')
      : reasons.map((x) => `<p class="warn">${esc(x)}</p>`).join(''));
  if (passed && out) {
    const b = document.createElement('button'); b.className = 'primary';
    b.textContent = `Save ${out.name} (${fmtBytes(out.size)})`;
    b.onclick = async () => {
      let done;
      try { done = await save(out.name); } catch (e) {
        offered = null; b.remove();
        $('save-result').insertAdjacentHTML('beforeend', `<p class="warn">${esc(out.name)} is no longer there to save (${esc(e.message)}): save again.</p>`);
        return;
      }
      if (done) {
        // Saved to the user's disk: the drawings in that file need not be kept here; any others still are.
        offered = null; b.remove();
        drafts = drafts.filter((d) => !savedIds.has(d.id)); keepDrafts(); showDrafts(drafts.filter((d) => d.placeId === state.placeId)); if (view) renderCard();
        $('save-result').insertAdjacentHTML('beforeend', `<p>Saved. To add more, open ${esc(out.name)}.</p>`);
      }
    };
    $('save-result').appendChild(b);
    offered = b;
  }
  state.lastSave = { passed, added, outputs: r.outputs || [], mneme: r.mneme || null, report: r.report || null, converted };
  state.phase = 'saved';
}
// The same as the main page's save() (src/app.js), kept here rather than shared so that the main page
// is not changed for Chora: the output is on the origin private file system (in chora-outputs/, the
// worker's directory for Chora, apart from the main page's outputs/), and goes to disk
// through the save dialogue where there is one, else as a download. True once saved.
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
  return true;
}
window.__chora_save = save;

// ---- Basemaps ------------------------------------------------------------------------------------
// A basemap from another site is used only once the user has agreed to every site it needs (the one
// its address is on, then any other its style names), and only once those sites are in the page's
// Content Security Policy, which is written at load (src/chora/csp-head.js): so agreeing to a site
// the policy does not have reloads the page, once, with the dataset, the place and the view kept.
let asking = null;   // {b, origins}: a basemap waiting for the user to agree to these sites
let basemapError = null;   // why the basemap chosen could not be used
function renderBasemaps() {
  const cur = basemaps.byId(state.basemap) || basemaps.current();
  $('basemap-name').textContent = cur.name;
  const groups = new Map();
  for (const b of basemaps.all()) { if (!groups.has(b.group)) groups.set(b.group, []); groups.get(b.group).push(b); }
  $('basemap-options').innerHTML = (basemapError ? `<p class="warn" role="status">${esc(basemapError)}</p>` : '') + [...groups].map(([g, bs]) => `<fieldset><legend>${esc(g)}</legend>${bs.map((b) => `<label class="${b.disabled ? 'disabled' : ''}">
      <input type="radio" name="basemap" value="${esc(b.id)}"${b.id === (asking?.b || cur).id ? ' checked' : ''}${b.disabled ? ' disabled' : ''}> ${esc(b.name)}${b.disabled ? ` <small>(${esc(b.disabled)})</small>` : ''}
      ${b.group === 'Pasted' ? ` <button type="button" class="link" data-unpaste="${esc(b.id)}">remove</button>` : ''}</label>`).join('')}</fieldset>`).join('')
    + (asking ? `<div class="consent" role="alertdialog" aria-labelledby="consent-text"><p id="consent-text">${esc(basemaps.notice(asking.b, asking.origins))}</p>
      ${asking.origins.some((o) => !inPolicy(o)) ? '<p class="muted">The page will reload once to let the map reach them; your drawings and the dataset open are kept.</p>' : ''}
      <p><button type="button" class="primary" id="consent-yes">Use ${esc(asking.b.name)}</button> <button type="button" id="consent-no">Keep the current map</button></p></div>` : '')
    + `<form id="paste-form"><label for="paste">Paste a style address or a tile template</label>
      <input id="paste" type="url" placeholder="https://…/style.json or https://…/{z}/{x}/{y}.png" autocomplete="off">
      <small>Kept in this browser only, key and all, and sent to nowhere but that provider.</small>
      <button type="submit">Add</button> <span id="paste-error" class="warn"></span></form>`
    + (state.blocked ? `<p class="muted">Refused ${n(state.blocked)} request${state.blocked === 1 ? '' : 's'} to ${esc(state.blockedOrigins.join(', '))}, not the basemap's site.</p>` : '');
}
/** Use `b` if every site it needs has been agreed to; else ask, naming the sites not yet agreed to. */
function chooseBasemap(b) {
  if (b.local) return useBasemap(b);
  const primary = basemaps.originOf(b);
  if (!basemaps.consented(primary)) { asking = { b, origins: [primary] }; renderBasemaps(); return; }
  useBasemap(b);
}
$('basemap-options').addEventListener('change', (e) => {
  if (e.target.name !== 'basemap') return;
  const b = basemaps.byId(e.target.value);
  if (b && !b.disabled) chooseBasemap(b);
});
$('basemap-options').addEventListener('click', (e) => {
  if (e.target.id === 'consent-yes') {
    const { b, origins } = asking; asking = null;
    for (const o of origins) basemaps.consent(o);
    renderSites();
    useBasemap(b);
  } else if (e.target.id === 'consent-no') { asking = null; renderBasemaps(); }
  else if (e.target.dataset.unpaste) {
    const id = e.target.dataset.unpaste;
    basemaps.removePasted(id);
    if (basemaps.current().id === id || state.basemap === id) useBasemap(basemaps.byId('natural-earth')); else renderBasemaps();
  }
});
$('basemap-options').addEventListener('submit', (e) => {
  e.preventDefault();
  const b = basemaps.fromPaste($('paste').value);
  if (!b) { $('paste-error').textContent = 'That is not an https address.'; return; }
  basemaps.addPasted(b);
  chooseBasemap(b);
});
// A TileJSON document, fetched only from a site the page may already reach (any other is asked about first).
const tileJson = async (u) => (inPolicy(new URL(u).origin) ? (await fetch(u, { credentials: 'omit' })).json() : null);
async function useBasemap(b) {
  if (!b.local) basemapError = state.basemapError = null;
  const primary = b.local ? null : basemaps.originOf(b);
  // The style itself is on the basemap's own site: reachable once agreed to, from the next load.
  if (primary && !inPolicy(primary)) { basemaps.choose(b); return reloadFor([primary]); }
  let style;
  try { style = await basemaps.styleFor(b); } catch (e) {
    if (b.local) { console.warn(e); return; }
    return styleFailed(e.message, b);
  }
  const origins = b.local ? [] : [...new Set([primary, ...await basemaps.styleOrigins(style, { tileJson })])];
  const missing = origins.filter((o) => !basemaps.consented(o));
  if (missing.length) {
    // The style names sites not yet agreed to: asked about, with Natural Earth shown meanwhile.
    asking = { b, origins: missing };
    $('basemaps').open = true;
    if (!state.basemap) await useBasemap(basemaps.byId('natural-earth')); else renderBasemaps();
    return;
  }
  basemaps.choose(b);
  if (origins.some((o) => !inPolicy(o))) return reloadFor(origins.filter((o) => !inPolicy(o)));
  mapApi.allow(origins);
  state.basemap = b.id; state.basemapOrigins = origins;
  mapApi.setStyle(style);
  renderBasemaps();
}

// The page's policy cannot be widened while it runs: a site agreed to is reachable from the next
// load. What the user was doing is kept for it (the files open, the place, the view, and what was
// being added), and the page reloads once.
async function reloadFor(origins, pending = null) {
  if (state.phase === 'reloading') return;
  // Never a loop: sites the last reload was for, still not in the policy after it (one that is not a
  // plain web address, say), are reported, not reloaded for again.
  const key = [...new Set(origins)].sort().join(' ');
  let last = null;
  try { last = JSON.parse(sessionStorage.getItem('chora-reloaded-for')); } catch {}
  if (last && last.key === key && Date.now() - last.at < 60000) {
    state.reloadRefused = key;
    // Said where it was asked for: the maps panel for a historical map, else the basemaps'.
    if (pending?.overlay) {
      mapStatus = `warn:The page could not be given leave to reach ${key.split(' ').join(', ')}, so the map was not shown. This browser may not be keeping what you agree to.`;
      state.mapError = mapStatus.slice(5); renderMaps();
    } else {
      basemapError = state.basemapError = `The page could not be given leave to reach ${key}, so it was not used.`;
      renderBasemaps();
    }
    return;
  }
  try { sessionStorage.setItem('chora-reloaded-for', JSON.stringify({ key, at: Date.now() })); } catch {}
  return reloadNow(pending);
}
async function reloadNow(pending = null) {
  state.phase = 'reloading';
  // A drawing just made may still be being written: a reload now would lose it.
  await draftsWritten();
  const m = mapApi.map;
  await keepForReload({ files, placeId: state.placeId, camera: { center: m.getCenter().toArray(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() }, pending });
  location.reload();
}


// ---- Historical maps -----------------------------------------------------------------------------
// A georeferenced map over the basemap (src/chora/overlays.js has how it gets there, and why each
// step is guarded). Each site a map needs is asked about, by name, before it is asked for anything;
// agreeing to a site the page's policy lacks reloads the page once, and the map is then added.
const guard = createGuard({ state, consented: (o, k) => consents.consented(o, k), inPolicy });
const deps = { guard, consented: (o, k) => consents.consented(o, k) && inPolicy(o) };
let mapAsk = null;     // {origins, kind, name, pending}: sites to agree to before a map can go on
let mapOffer = null;   // {services, manifestUrl, title, text, notFound}: a map with no georeference given
let mapChoice = null;  // {choices, chosen, parsed, manifestUrl}: a georeference of several maps, one to choose
let mapStatus = '';    // what the page says of the last map added, in words (a warn: prefix is a problem)
let layers = null;     // the maps' layer on the map (overlays.js createLayerManager), once the map exists
function initMaps() {
  layers = ov.createLayerManager(mapApi.map, { onEvent: overlayEvent });
  mapApi.onStyleLoad(() => { layers.attach().then(syncOverlays, (e) => console.warn('Historical maps:', e)); });
  // For automated tests; nothing else reads it.
  window.__chora_overlays = { manager: layers, georef, get layer() { return layers.layer; } };
  renderMaps(); renderSites();
}

// The sites agreed to, as this browser keeps them. Any page of this site (not Chora alone) can read and
// change what is kept here, so the list is shown as it is stored, to be checked.
const KIND_WORDS = { basemap: 'a basemap', iiif: 'historical maps (their images and descriptions)', allmaps: 'Allmaps (georeferences)' };
function renderSites() {
  const list = consents.list();
  $('agreed-sites').innerHTML = list.length
    ? `<p class="muted">Agreed to in this browser (other pages of ${esc(location.host)} could change this list, so check that it is what you agreed to):</p>
      <ul class="sites">${list.map((c) => `<li data-site="${esc(c.origin)}" data-kind="${esc(c.kind)}"><code>${esc(c.origin)}</code> <span class="muted">for ${esc(KIND_WORDS[c.kind] || c.kind)}</span></li>`).join('')}</ul>`
    : '<p class="muted">No other site has been agreed to in this browser.</p>';
}

/** The needs of a step, where "agreed to" also means in the page's policy (else a reload is due). */
function needFrom(e, pending) {
  // A site no policy can name (an underscore in its host, say) cannot be agreed to: said plainly.
  const bad = e.origins.filter((o) => !consents.isOrigin(o));
  if (bad.length) return notASite(bad);
  // Agreed to already, but not in this load's policy: the reload is all that is needed.
  if (e.origins.every((o) => consents.consented(o, e.kind))) return reloadFor(e.origins, { overlay: pending });
  mapAsk = { origins: e.origins, kind: e.kind, name: e.mapName, fetch: e.fetch, maps: e.maps, pending };
  mapStatus = '';
  renderMaps();
}
function notASite(bad) {
  mapAsk = null;
  mapStatus = `warn:${bad.join(', ')} ${bad.length === 1 ? 'is not a site' : 'are not sites'} this page can be given leave to reach (only a plain web address, such as https://example.org, can be), so the map was not shown.`;
  state.mapError = mapStatus.slice(5);
  renderMaps();
}
/**
 * Add a map from what was pasted (pending: {text, lookup}), kept (pending: {kept}), or chosen from a
 * georeference of several (pending: {parsed, manifestUrl}); pending {readmit} is the maps kept, all.
 * With `collect`, a site to agree to is returned (NeedConsent) rather than asked about.
 */
async function addMap(pending, { collect = false } = {}) {
  if (pending.readmit) { mapStatus = ''; return readmitKept(); }
  mapAsk = null; mapChoice = null; mapStatus = 'Reading…'; renderMaps();
  await canaryDone;
  if (state.canary !== 'enforced') { mapStatus = `warn:${ov.REFUSED}`; state.mapError = ov.REFUSED; renderMaps(); return; }
  try {
    let r, keptEntry = null;
    if (pending.kept) {
      keptEntry = (await ov.kept()).find((k) => k.key === pending.kept);
      if (!keptEntry) { mapStatus = ''; renderMaps(); return; }
      r = await ov.resolve({ kind: 'annotation', annotation: keptEntry.item, manifest: keptEntry.manifest, fetchedAt: keptEntry.fetchedAt }, deps);
      r.manifestUrl = keptEntry.manifestUrl || r.manifestUrl;
    } else if (pending.parsed) {
      r = await ov.resolve(pending.parsed, deps);
      r.manifestUrl ||= pending.manifestUrl || null;
    } else {
      r = await ov.resolve(ov.parseInput(pending.text), deps);
      if (r.services) {
        if (!pending.lookup) { mapOffer = { ...r, text: pending.text }; mapStatus = ''; renderMaps(); return; }
        const found = await ov.lookup(r.services, deps);
        if (!found) { mapOffer = { ...r, text: pending.text, notFound: true }; mapStatus = ''; renderMaps(); return; }
        r = await ov.resolve({ kind: 'annotation', annotation: found.annotation, fetchedAt: found.fetchedAt, manifest: r.manifest }, deps);
        r.manifestUrl ||= mapOffer?.manifestUrl || null;
      }
    }
    mapOffer = null;
    const a = await ov.admit(r, { ...deps, canary: true });
    await showMap(a, keptEntry);
  } catch (e) {
    if (collect && (e instanceof ov.NeedConsent || (e instanceof GuardError && e.kind === 'reload'))) {
      mapStatus = ''; renderMaps();
      return e instanceof ov.NeedConsent ? e : new ov.NeedConsent([e.origin], 'iiif');
    }
    if (e instanceof ov.NeedConsent) return needFrom(e, pending);
    if (e instanceof ov.NeedChoice) {
      // Several georeferences of the map: the user chooses, the most recently changed offered first.
      mapChoice = { choices: e.choices, chosen: e.defaultIndex, manifestUrl: mapOffer?.manifestUrl || null,
        parsed: { kind: 'annotation', annotation: e.annotation, fetchedAt: e.fetchedAt, url: e.url, manifest: e.manifest } };
      mapOffer = null; mapStatus = ''; renderMaps();
      return;
    }
    if (e instanceof GuardError && e.kind === 'reload') return reloadFor([e.origin], { overlay: pending });
    mapStatus = `warn:${e.message}`; state.mapError = e.message;
    renderMaps();
  }
}
async function showMap(a, keptEntry = null) {
  const key = await ov.keyOf(a.g);
  if (layers.entries.some((e) => e.key === key)) { mapStatus = `${a.title} is shown already.`; renderMaps(); return; }
  const e = { ...a, key, opacity: keptEntry?.opacity ?? 1, visible: keptEntry?.visible ?? true, added: keptEntry?.added || new Date().toISOString() };
  await layers.add(e);
  if (e.error) { layers.remove(key); throw new Error(e.error); }
  state.overlays.push({ key, mapId: e.mapId, origin: consents.originOf(a.g.imageServiceId), service: a.g.imageServiceId.replace(/\/+$/, ''), annotationId: a.g.annotationId, title: a.title,
    transformation: ov.allmapsTransformationName(a.g), opacity: e.opacity, visible: e.visible, tilesLoaded: 0, tileErrors: 0, firstTile: false });
  ov.keep({ key, item: a.item, manifest: a.manifest, manifestUrl: a.manifestUrl, fetchedAt: a.fetchedAt, opacity: e.opacity, visible: e.visible, added: e.added }).catch((err) => console.warn('Chora: the map could not be kept', err));
  mapStatus = keptEntry ? '' : `${a.title} is on the map.`;
  state.mapError = null;
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
    if (type === 'maptileloaded') o.tilesLoaded++;
    else if (type === 'firstmaptileloaded') o.firstTile = true;
    else if (type === 'allrequestedtilesloaded') o.allLoaded = (o.allLoaded || 0) + 1;
    else if (type === 'tilefetcherror' || type === 'imageinfofetcherror') { o.tileErrors++; renderMapsSoon(); }
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
        if (o) { o.tileErrors++; renderMapsSoon(); }
      }
    } catch {}
    toConsole(...args);
  };
}
let rendering = null;
const renderMapsSoon = () => { rendering ??= setTimeout(() => { rendering = null; renderMaps(); }, 250); };

function renderMaps() {
  const shown = new Map(layers.entries.map((e) => [e.key, e]));
  let html = '';
  if (mapAsk) {
    const yes = mapAsk.kind === 'allmaps' ? (mapAsk.fetch ? 'Fetch it from Allmaps' : 'Ask Allmaps') : mapAsk.maps > 1 ? 'Show the maps' : 'Show the map';
    html += `<div class="consent" role="alertdialog" aria-labelledby="map-consent-text"><p id="map-consent-text">${esc(consents.notice(mapAsk.kind, { origins: mapAsk.origins, name: mapAsk.name, fetch: mapAsk.fetch, maps: mapAsk.maps }))}</p>
      ${mapAsk.origins.some((o) => !inPolicy(o)) ? '<p class="muted">The page will reload once to let it reach them; your drawings and the dataset open are kept.</p>' : ''}
      <p><button type="button" class="primary" id="map-yes">${yes}</button> <button type="button" id="map-no">Not now</button></p></div>`;
  }
  if (mapChoice) {
    const one = (c) => `Georeference ${c.index + 1}${c.label ? `: ${esc(c.label)}` : ''} <span class="muted">(${c.modified ? `changed ${esc(c.modified.slice(0, 10))}` : 'no date given'}, ${c.gcps === null ? 'control points not given' : `${c.gcps} control point${c.gcps === 1 ? '' : 's'}`}${c.id ? `; ${esc(c.id)}` : ''})</span>`;
    html += `<div class="choice" id="map-choice" role="group" aria-labelledby="map-choice-text"><p id="map-choice-text">This holds ${mapChoice.choices.length} georeferences of the map, made separately. Choose the one to show (the most recently changed is chosen):</p>
      <ul class="choices">${mapChoice.choices.map((c) => `<li><label><input type="radio" name="georef-choice" value="${c.index}"${c.index === mapChoice.chosen ? ' checked' : ''}> ${one(c)}</label></li>`).join('')}</ul>
      <p><button type="button" class="primary" id="map-choose">Show this one</button> <button type="button" id="map-choose-no">Not now</button></p></div>`;
  }
  if (mapOffer) {
    const name = mapOffer.title ? `“${esc(mapOffer.title)}”` : 'This map';
    html += `<div class="offer"><p>${name} came with no georeference${mapOffer.notFound ? ', and Allmaps has none for it' : ''}.</p>
      ${mapOffer.notFound ? '' : '<p><button type="button" class="primary" id="map-lookup">Look for a georeference</button> <small class="muted">This asks Allmaps, which learns which map was looked for.</small></p>'}
      <p>${mapOffer.notFound ? 'You can' : 'Or'} georeference it in the <a href="${esc(ov.editorUrl(mapOffer.manifestUrl, mapOffer.services[0]))}" target="_blank" rel="noopener noreferrer">Allmaps Editor</a> (following the link sends the map's address to Allmaps), and paste here the georeference it makes.</p></div>`;
  }
  $('map-status').innerHTML = html + (mapStatus ? `<p class="${mapStatus.startsWith('warn:') ? 'warn' : 'muted'}">${esc(mapStatus.replace(/^warn:/, ''))}</p>` : '');
  $('overlay-list').innerHTML = state.overlays.map((o) => {
    const e = shown.get(o.key); if (!e) return '';
    const a = e.attribution || {};
    const licence = a.licence ? `<a href="${esc(a.licence)}" target="_blank" rel="noopener noreferrer">${esc(a.licenceLabel || a.licence)}</a>` : '';
    return `<li data-overlay="${esc(o.key)}"><p class="overlay-title">${esc(o.title)}</p>
      <p class="muted">Image from <code>${esc(o.origin)}</code></p>
      ${a.credit ? `<p class="muted">${esc(a.credit)}</p>` : ''}
      ${licence ? `<p class="muted">Licence: ${licence}</p>` : ''}
      ${a.nonCommercial ? `<p class="note">${esc(ov.nonCommercialLine(a))} ${licence}</p>` : ''}
      ${(e.notes || []).map((x) => `<p class="muted">${esc(x)}</p>`).join('')}
      ${o.tileErrors ? `<p class="warn">Some parts of the map's image could not be loaded from ${esc(o.origin)}.</p>` : ''}
      <p class="overlay-controls"><label>Opacity <input type="range" min="0" max="100" step="5" value="${Math.round(o.opacity * 100)}" data-opacity></label>
      <label><input type="checkbox" data-show${o.visible ? ' checked' : ''}> Show</label>
      <button type="button" data-fit>Fit</button> <button type="button" data-remove-map>Remove</button></p>
      <p><a href="${esc(ov.editorUrl(e.manifestUrl, e.g.imageServiceId))}" target="_blank" rel="noopener noreferrer">Open in the Allmaps Editor</a> <small class="muted">(sends the map's address to Allmaps)</small></p></li>`;
  }).join('');
}
$('map-form').onsubmit = (e) => { e.preventDefault(); mapOffer = null; mapChoice = null; addMap({ text: $('map-input').value }); };
$('map-status').addEventListener('click', (e) => {
  if (e.target.id === 'map-yes' && mapAsk) {
    const { origins, kind, pending } = mapAsk; mapAsk = null;
    try { consents.grant(origins, kind); } catch { return notASite(origins.filter((o) => !consents.isOrigin(o))); }
    renderSites();
    if (origins.some((o) => !inPolicy(o))) reloadFor(origins, { overlay: pending }); else addMap(pending);
  } else if (e.target.id === 'map-no') { mapAsk = null; mapStatus = ''; renderMaps(); }
  else if (e.target.id === 'map-choose' && mapChoice) {
    const picked = $('map-status').querySelector('input[name="georef-choice"]:checked');
    const { parsed, manifestUrl, chosen } = mapChoice; mapChoice = null;
    addMap({ parsed: { ...parsed, index: picked ? Number(picked.value) : chosen }, manifestUrl });
  } else if (e.target.id === 'map-choose-no') { mapChoice = null; mapStatus = ''; renderMaps(); }
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
  if (e.target.matches('[data-show]')) { o.visible = e.target.checked; layers.set(o.key, { visible: o.visible }); keepOverlay(o); }
});
$('overlay-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-overlay]'); if (!li) return;
  const key = li.dataset.overlay;
  if (e.target.matches('[data-fit]')) fitMap(key);
  if (e.target.matches('[data-remove-map]')) {
    layers.remove(key);
    ov.letGo(key).then(() => { state.overlays = state.overlays.filter((x) => x.key !== key); renderMaps(); });
  }
});
async function keepOverlay(o) {
  const k = (await ov.kept()).find((x) => x.key === o.key);
  if (k) ov.keep({ ...k, opacity: o.opacity, visible: o.visible }).catch(() => {});
}
$('forget-sites').onclick = async () => {
  // Every site forgotten: the policy of the next load has none of them, and each is asked about again.
  consents.forget();
  basemaps.choose(basemaps.byId('natural-earth'));
  await reloadNow();
};
/**
 * The maps kept from last time, admitted afresh (a site forgotten is asked about again): every site
 * they need is asked about in one notice, so that one reload brings them all back.
 */
async function readmitKept() {
  const needs = [];
  for (const k of await ov.kept()) { const need = await addMap({ kept: k.key }, { collect: true }); if (need) needs.push(need); }
  if (!needs.length) return;
  // Kept maps need only their own sites (iiif); were another kind needed too, it is asked after the reload.
  const these = needs.filter((x) => x.kind === needs[0].kind);
  needFrom({ origins: [...new Set(these.flatMap((x) => x.origins))], kind: these[0].kind, mapName: these.length === 1 ? these[0].mapName : undefined, maps: these.length }, { readmit: true });
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
// The map and the drawing tool, for automated tests; nothing else reads them.
window.__chora_map = mapApi.map;
Object.defineProperty(window, '__chora_draw', { get: () => mapApi.draw });
// The proof that the policy is enforced in workers made from a blob:, as a historical map's are
// (src/chora/csp.js): until it has come, and unless it holds, no historical map is admitted.
// A reload that did put its sites in the policy is done with: a later one for the same sites (agreed
// to again after being forgotten) is not a loop.
try {
  const last = JSON.parse(sessionStorage.getItem('chora-reloaded-for'));
  if (last && last.key.split(' ').every(inPolicy)) sessionStorage.removeItem('chora-reloaded-for');
} catch {}
const canaryDone = canary().then((r) => { Object.assign(state, { canary: r.enforced ? 'enforced' : 'not-enforced', canaryWhy: r.why || null, canaryDirective: r.directive || null }); return r; });
window.__chora_canary = canaryDone;
useBasemap(basemaps.current());
startWorker().then(async () => {
  // Back from a reload for a site agreed to: the dataset, the place and the view as they were.
  const resumed = await takeResume();
  if (resumed) {
    state.reloads++;
    if (resumed.files?.length) {
      await open(resumed.files);
      if (resumed.placeId && dataset) await selectPlace(resumed.placeId);
    }
    if (resumed.camera) mapApi.map.jumpTo(resumed.camera);
    state.resumed = { files: (resumed.files || []).map((f) => f.name), placeId: resumed.placeId || null, pending: resumed.pending || null };
    await readmitKept();
    // The maps kept were the pending action: just readmitted.
    if (resumed.pending?.overlay && !resumed.pending.overlay.readmit) await addMap(resumed.pending.overlay);
    return;
  }
  await readmitKept();
  // Files chosen on the main page, offered here.
  const handed = await takeHandoff();
  if (handed && !files.length) {
    const p = $('handoff');
    p.innerHTML = `<button type="button" class="primary" id="open-handoff">Open ${esc(handed.map((f) => f.name).join(', '))}</button>, chosen on the main page.`;
    p.hidden = false;
    $('open-handoff').onclick = () => open(handed);
    state.handoff = handed.map((f) => f.name);
  }
}).catch((e) => (e.kind === 'pool-busy' ? inAnotherTab() : fail(e.message)));
