// Chora: adopting a place's location from a gazetteer match (the engine is src/engine/chora/adopt.js).
// From the place card, "Find in a gazetteer…" opens this panel: one query to the World Historical
// Gazetteer, the candidates numbered on the map and in a list ranked honestly, a record previewed as
// WHG gives it (entity(), Linked Places Format), and "Adopt: this place is that record, located there",
// which keeps ONE adoption draft (two attestations, removed together) to be saved with the drawings.
//
// Nothing is asked of WHG but through the shared gazetteer lookup (src/engine/gazetteer/: one queue per
// page, the token only in the Authorization header) and the permissions module (src/lib/permissions.js),
// under the permission Krisis's lookup uses ('gazetteer', 'whg'; lookup.js gazetteerPermission) and
// with the token from its one keeper (permissions.token), as on the main page. No consent or privacy
// notice of its own: until WHG is allowed, the module's one line, which opens the Permissions panel.
//
// Where it looks (#32): within the nearest regions the dataset identifies with WHG records, and in the
// place's countries (adopt.js adoptScope), the query made by Krisis's own placeQuery (never area_only).
// The line under the name says what is sent; nothing wider is searched unless "Search everywhere" is pressed.
//
// The page's state is published on window.__chora.adopt for automated tests; nothing else reads it.
import { createLookup, WHG_ENDPOINT } from '../engine/gazetteer/index.js';
import { permittedFetch, gazetteerPermission, placeQuery, failedClosed } from '../engine/krisis/lookup.js';
import * as A from '../engine/chora/adopt.js';
import { ROLES } from '../engine/chora/draw.js';
import { CHORA_ADOPT_PAGE as W, CHORA_ADOPT_TEXT, lookupPage as LW } from '../engine/words.js';
import * as permissions from '../lib/permissions.js';

const SUBJ = gazetteerPermission(WHG_ENDPOINT);   // 'whg'
const ROLE_WORDS = { RepresentativePoint: 'a point standing for it', Extent: 'the whole place', FeaturePoint: 'a feature of it', LabelAnchor: 'where its label goes', Itinerary: 'a route' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const whenText = (w) => {
  if (!w || typeof w !== 'object') return '';
  const spans = [].concat(w.timespans || []).map((t) => [t?.start && (t.start.in ?? t.start.earliest ?? t.start.latest), t?.end && (t.end.in ?? t.end.latest ?? t.end.earliest)].map((x) => x ?? '…').join('–'));
  return [w.label, ...spans, ...[].concat(w.periods || []).map((p) => p?.name)].filter(Boolean).join('; ');
};

/**
 * The panel, in `root` (a section of the page). `mapApi` is Chora's map; `state` window.__chora;
 * `addAdoption(draft)` keeps an adoption draft with the drawings; `armConsult(consulted)` makes the next
 * drawing of the place cite a record consulted, not copied; `adopted(placeId)` the adoption drafts of a place.
 */
export function createAdopt({ root, mapApi, state, addAdoption, armConsult, adopted }) {
  let s = null;   // { view, query, phase, problem, answer: { list, attribution }, ranked, statuses, dismissed, preview, done, widened, sent, searched, failedClosed }
  let inFlight = null;
  const token = permissions.token;
  // The one fetch every request is made with (the shared lookup keeps its first), as Krisis's on main.
  const fetchVia = permittedFetch(permissions.fetch, (e) => inFlight?.abort(e));
  const whg = () => createLookup({ endpoint: WHG_ENDPOINT, fetch: fetchVia });
  const passToken = () => { const t = token.get(); if (t) whg().setToken(t); else whg().clearToken(); };
  passToken();
  token.onChange(() => { passToken(); if (s) render(); });
  permissions.onChange(() => { if (s) render(); });

  const publish = () => {
    state.adopt = !s ? { open: false } : {
      open: true, placeId: s.view.id, phase: s.phase, problem: s.problem?.kind ?? null, query: s.query, reference: s.reference?.kind ?? null,
      scope: s.view.scope ?? null, widened: s.widened, sent: s.sent, searchedWithin: !!s.searched, failedClosed: s.failedClosed,
      candidates: (s.ranked || []).filter((r) => !s.dismissed.has(r.candidate.id)).map((r) => {
        const st = s.statuses.get(r.candidate.id);
        return { n: r.n, id: r.candidate.id, distanceKm: r.distanceKm, inArea: r.inArea, noCoords: r.noCoords, linked: st.linked, denied: st.denied, mayCopy: st.mayCopy && !s.unavailable.has(r.candidate.id) };
      }),
      dismissed: [...(s.dismissed || [])],
      markers: mapApi.candidateMarkers().map((m) => m.id),
      preview: s.preview ? { id: s.preview.id, fetched: !!s.preview.feature, unavailable: s.unavailable.has(s.preview.id), geometries: s.preview.offered.map((o) => ({ type: o.geojson.type, refused: o.refused?.kind ?? null, role: o.role ?? null })) } : null,
      done: s.done || null,
    };
  };

  function close() {
    inFlight?.abort(); inFlight = null;
    armConsult(null);   // "Draw it yourself" is for this panel's record: closed, the next drawing cites nothing
    s = null; root.hidden = true; root.innerHTML = '';
    mapApi.setCandidates([]); showAdopted();
    publish();
  }
  /** The place shown changed: the panel is for one place, and goes; that place's adoptions are drawn. */
  function placeShown(view) {
    if (s && s.view.id !== view?.id) close();
    else if (!s) armConsult(null);
    showAdopted(view?.id);
  }
  /** The adopted locations of the place shown, in the preview style (they are not the place's until saved). */
  function showAdopted(placeId = state.placeId, extra = []) {
    const features = (placeId ? adopted(placeId) : []).map((d) => (d.feature ? { type: 'Feature', geometry: stripWhen(d.feature.geometry), properties: { kind: 'record' } }
      : Array.isArray(d.candidate.coords) ? { type: 'Feature', geometry: { type: 'Point', coordinates: d.candidate.coords }, properties: { kind: 'record' } } : null)).filter(Boolean);
    mapApi.setPreview({ type: 'FeatureCollection', features: [...features, ...extra] });
  }
  const stripWhen = (g) => { const { when, ...rest } = g || {}; return rest; };

  function openFor(view) {
    if (!view || !A.isPlaceIri(view.id)) return;
    inFlight?.abort(); inFlight = null;
    s = { view, query: view.label || '', phase: 'idle', problem: null, answer: null, ranked: null, statuses: new Map(), dismissed: new Set(), unavailable: new Set(), preview: null, done: null, reference: A.referenceOf(view),
      widened: false, sent: null, searched: null, failedClosed: false };
    root.hidden = false;
    render();
    root.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    root.querySelector(token.get() ? '#adopt-q' : '#adopt-token')?.focus();
  }

  const allowed = () => permissions.allowed('gazetteer', SUBJ);
  /** Where the next search looks: the place's scope, unless widened or it has none (then null: everywhere). */
  const searchScope = () => (s.widened || !A.scopes(s.view.scope) ? null : s.view.scope);
  /** The query for `query` as it will be sent (Krisis's placeQuery), or null for no name. */
  const planned = (query) => (query ? placeQuery(A.adoptSearchPlace(s.view, query, searchScope()), { countries: true, limit: 10 }) : null);
  /** Where a query looks, for the words: the regions it is within (by label), their records and the countries. */
  const whereOf = (sent, scope) => {
    const ids = Array.isArray(sent?.contained_in) ? sent.contained_in : [];
    return { ids, labels: ids.length ? (scope?.from || []).map((r) => r.label) : [], countries: Array.isArray(sent?.countries) ? sent.countries : [] };
  };
  const sendsLine = () => { const p = planned((root.querySelector('#adopt-q')?.value ?? s.query).trim() || s.view.label || ''); return p ? W.sends({ lang: p.sent.lang ?? null, ...whereOf(p.sent, searchScope()) }) : ''; };
  /** The permission's one line: the module's ("Needs permission: …"), or, while set to Never, "Not allowed" with a button to the panel (as Krisis on main). */
  function permissionLine(el) {
    if (permissions.needs(el, 'gazetteer', SUBJ) !== 'never') return;
    permissions.unneed(el);
    const key = permissions.keyOf('gazetteer', SUBJ), b = document.createElement('button');
    b.type = 'button'; b.className = 'link'; b.textContent = LW.openPermissions;
    b.onclick = () => permissions.open({ focus: key });
    el.dataset.permission = key; el.classList.add('needs-permission'); el.hidden = false;
    el.append(LW.never(permissions.nameOf('gazetteer', SUBJ)), ' — ', b);
  }

  function render() {
    if (!s) return;
    const typed = root.querySelector('#adopt-q')?.value;
    // What is half typed survives the panel being drawn again (a change of permission or token): the basis, and a token not yet given.
    const basisTyped = root.querySelector('#adopt-basis')?.value;
    if (basisTyped !== undefined && s.preview) s.preview.basis = basisTyped;
    const tokenTyped = root.querySelector('#adopt-token')?.value ?? '';
    const was = root.querySelector('#adopt-permission');
    if (was) permissions.unneed(was);   // the line is drawn afresh below; the module keeps no element gone from the page
    if (typed !== undefined) s.query = typed;
    const ok = allowed(), hasToken = token.get() !== null;
    root.innerHTML = `<h2 id="adopt-h">${esc(W.heading)}</h2>
      <p class="muted">${esc(s.view.label)} <span class="place-id">${esc(s.view.id)}</span></p>
      <p id="adopt-permission"></p>
      ${hasToken ? `<p class="adopt-token-state">${esc(W.tokenGiven)} <button type="button" class="link" id="adopt-forget">${esc(W.forget)}</button></p>`
        : `<form id="adopt-token-form" class="adopt-token"><label for="adopt-token">${esc(W.tokenLabel)}</label>
          <input id="adopt-token" type="password" autocomplete="off" spellcheck="false"> <button type="submit">${esc(W.tokenUse)}</button></form>`}
      <form id="adopt-form"><label for="adopt-q">${esc(W.queryLabel)}</label>
        <input id="adopt-q" type="search" autocomplete="off" value="${esc(s.query)}">
        <button type="submit" id="adopt-send" class="primary"${ok ? '' : ' hidden'}${s.phase === 'sending' ? ' disabled' : ''}>${esc(W.send)}</button></form>
      <p id="adopt-sends" class="muted">${esc(sendsLine())}</p>
      <p id="adopt-status" role="status" aria-live="polite" class="${s.problem ? 'warn' : ''}">${esc(s.phase === 'sending' ? W.sending : s.phase === 'fetching' ? W.fetching : s.problem?.text || '')}${s.problem?.offer === 'retry' ? ` <button type="button" class="link" id="adopt-retry">Try again</button>` : ''}</p>
      ${scopeHtml()}
      ${candidatesHtml()}
      ${previewHtml()}
      ${s.done ? `<p class="good" id="adopt-done" role="status">${esc(W.adopted(s.done.count))}</p>` : ''}
      <p><button type="button" id="adopt-close">${esc(W.close)}</button></p>`;
    const line = root.querySelector('#adopt-permission');
    if (ok) { permissions.unneed(line); line.hidden = true; } else permissionLine(line);
    const tf = root.querySelector('#adopt-token');
    if (tf && tokenTyped) tf.value = tokenTyped;
    publish();
  }

  /** After a search: the way to look everywhere (never taken for you), or back within the place's scope. */
  function scopeHtml() {
    if (!s.ranked || !A.scopes(s.view.scope)) return '';
    if (s.searched) return `<p><button type="button" id="adopt-widen">${esc(W.widen)}</button></p>`;
    return `<p><button type="button" id="adopt-narrow">${esc(W.narrow(W.where({ ...whereOf({ contained_in: s.view.scope.containedIn, countries: s.view.scope.countries }, s.view.scope) })))}</button></p>`;
  }
  function candidatesHtml() {
    if (!s.ranked) return '';
    const shown = s.ranked.filter((r) => !s.dismissed.has(r.candidate.id));
    const order = s.reference.kind === 'point' ? W.order.point : s.reference.kind === 'box' ? W.order.box(s.reference.from) : W.order.none;
    if (!s.ranked.length) {
      const where = s.searched ? W.where(whereOf(s.sent, s.searched)) : '';
      return `<p id="adopt-none">${esc(!where ? W.none : s.failedClosed ? W.notApplied(where) : W.noneWithin(where))}</p>`;
    }
    return `<p class="muted" id="adopt-order">${esc(order)} ${esc(W.caveat)}</p>
      <p class="muted">${esc(W.krisisUnsaved)}</p>
      ${A.clusterLinks(s.view.identities).length ? `<p class="note" id="adopt-cluster">${esc(W.cluster)}</p>` : ''}
      <ol class="adopt-candidates" id="adopt-candidates">${shown.map(candidateHtml).join('')}</ol>
      ${s.dismissed.size ? `<p class="muted">${esc(W.dismissed(s.dismissed.size))}</p>` : ''}`;
  }
  function candidateHtml(r) {
    const c = r.candidate, st = s.statuses.get(c.id), unavailable = !st.mayCopy || s.unavailable.has(c.id);
    const where = r.noCoords ? W.noCoords : r.distanceKm !== null ? W.distance(r.distanceKm) : r.inArea === true ? W.inside : r.inArea === false ? W.outside : '';
    const facts = [c.namespace, c.ccodes?.length ? c.ccodes.join(', ') : null, where, r.sameSpelling ? W.sameSpelling : null].filter(Boolean).join(' · ');
    const types = (c.types || []).map((t) => t.name).filter(Boolean).join(', ');
    const figures = LW.figures({ score: c.score, confidence: c.confidence }, 'WHG');
    const name = `${esc(c.name)}`;
    return `<li class="adopt-cand${st.denied ? ' denied' : ''}" data-cand="${esc(c.id)}"><span class="cand-n" aria-hidden="true">${r.n}</span>
      <span class="cand-name">${st.denied ? `<s>${name}</s>` : name}</span> <span class="muted">${esc(facts)}</span>
      ${types ? `<br><span class="muted">${esc(types)}</span>` : ''}${c.description ? `<br><span class="muted">${esc(LW.described('WHG', c.description))}</span>` : ''}
      <br><span class="licence${st.licenceWarns ? ' warn' : ''}">${esc(LW.licence(st.licence))}</span>
      ${figures ? `<br><span class="muted figures">${esc(figures)}</span>` : ''}
      ${st.linked === 'exact' ? `<p class="note">${esc(W.linked)}</p>` : st.linked === 'loose' ? `<p class="note">${esc(W.loose)}</p>` : ''}
      ${st.denied ? `<p class="note">${esc(W.denied)}</p>` : ''}
      ${unavailable ? `<p class="note">${esc(W.consulted)}</p>` : ''}
      <p class="cand-actions">${st.denied ? ''
        : `<button type="button" data-preview="${esc(c.id)}">${esc(st.linked === 'exact' ? W.useLocation : W.preview)}</button> `}<button type="button" data-dismiss="${esc(c.id)}">${esc(W.notThis)}</button>
        ${st.denied ? '' : ` <a href="./#tool=match" target="_blank" rel="noopener" data-different>${esc(W.different)}</a>`}</p></li>`;
  }
  function previewHtml() {
    const p = s.preview;
    if (!p) return '';
    const c = p.candidate, st = s.statuses.get(c.id);
    if (!st.mayCopy || s.unavailable.has(c.id)) {
      return `<div class="adopt-preview" id="adopt-preview"><h3>${esc(c.name)}</h3><p class="warn">${esc(CHORA_ADOPT_TEXT.unavailable)}</p>
        <p><button type="button" id="adopt-draw">${esc(W.drawInstead)}</button></p>${p.armed ? `<p class="note" id="adopt-armed">${esc(W.drawArmed(c.name))} <button type="button" class="link" id="adopt-unarm">${esc(W.cancelDraw)}</button></p>` : ''}</div>`;
    }
    const opts = p.offered.length ? p.offered.map((o) => `<li><label${o.refused ? ' class="disabled"' : ''}><input type="radio" name="adopt-geom" value="${o.index}"${o.refused ? ' disabled' : ''}${p.chosen === o.index ? ' checked' : ''}>
        ${esc(o.geojson.type)}${p.feature ? '' : ` (${esc(W.repOnly)})`}${o.when ? ` <span class="muted">${esc(W.when(whenText(o.when)))}</span>` : ''}</label>${o.refused ? ` <span class="warn">${esc(o.refused.reason)}</span>` : ''}</li>`).join('')
      : `<li class="muted">${esc(W.noRecordGeometry)}</li>`;
    const chosen = p.offered.find((o) => o.index === p.chosen);
    const role = p.role || chosen?.role || '';
    const roles = A.rolesFor(chosen?.geojson.type).filter((r) => ROLES.includes(r));
    const notes = (p.notes || []).map((n) => `<li>${esc(n.text)}${n.uri ? ` <a href="${esc(n.uri)}" rel="noopener noreferrer">${esc(n.uri.replace('https://spdx.org/licenses/', ''))}</a>` : ''}</li>`).join('');
    return `<div class="adopt-preview" id="adopt-preview"><h3>${esc(c.name)} <span class="muted">${esc(st.record)}</span></h3>
      ${p.fetchProblem ? `<p class="warn">${esc(p.fetchProblem)}${p.offered.length ? ` ${esc(CHORA_ADOPT_TEXT['representative-point-only'])}` : ''}</p>` : ''}
      <fieldset><legend>${esc(W.geometries)}</legend><ul class="adopt-geoms">${opts}</ul></fieldset>
      <label for="adopt-role">${esc(W.role)}</label> <select id="adopt-role">${roles.map((r) => `<option value="${r}"${r === role ? ' selected' : ''}>${esc(ROLE_WORDS[r])}</option>`).join('')}</select>
      ${st.linked === 'exact' ? '' : `<label for="adopt-basis">${esc(W.basis)}</label> <input id="adopt-basis" type="text" autocomplete="off" value="${esc(p.basis || '')}">`}
      ${notes ? `<ul class="notes" id="adopt-notes">${notes}</ul>` : ''}
      ${p.refused ? `<p class="warn" id="adopt-refused">${esc(p.refused)}</p>` : ''}
      <p><button type="button" class="primary" id="adopt-go"${chosen && !chosen.refused ? '' : ' disabled'}>${esc(st.linked === 'exact' ? W.adoptLinked : W.adopt)}</button></p></div>`;
  }

  /** The markers: the candidates shown, but none whose record may not be passed on (its point is WHG's, from that record). */
  function drawMarkers() {
    const list = (s?.ranked || []).filter((r) => !s.dismissed.has(r.candidate.id) && s.statuses.get(r.candidate.id).mayCopy && !s.unavailable.has(r.candidate.id))
      .map((r) => ({ n: r.n, id: r.candidate.id, coords: r.candidate.coords, label: `${r.n}: ${r.candidate.name}` }));
    mapApi.setCandidates(list, (id) => root.querySelector(`li[data-cand="${CSS.escape(id)}"] button`)?.focus());
    publish();
    return list;
  }
  const referenceFeature = () => (s?.reference.kind === 'box' ? [boxFeature(s.reference.bbox)] : []);
  const boxFeature = ([w, sth, e0, n]) => { const e = e0 < w ? e0 + 360 : e0; return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, sth], [e, sth], [e, n], [w, n], [w, sth]]] }, properties: { kind: 'reference' } }; };

  async function send() {
    if (!s || inFlight) return;
    s.query = root.querySelector('#adopt-q')?.value.trim() || '';
    if (!allowed()) { render(); root.querySelector('#adopt-permission button')?.focus(); return; }
    if (!token.get()) { s.problem = { kind: 'token', text: W.tokenNeeded }; render(); root.querySelector('#adopt-token')?.focus(); return; }
    if (!s.query) return;
    const plan = planned(s.query);
    if (!plan) return;
    Object.assign(s, { phase: 'sending', problem: null, answer: null, ranked: null, preview: null, done: null, sent: plan.sent, searched: searchScope(), failedClosed: false });
    s.statuses = new Map(); s.unavailable = new Set();
    mapApi.setCandidates([]); showAdopted(s.view.id, referenceFeature());
    render();
    const me = (inFlight = new AbortController());
    let lists = null, err = null;
    try { lists = await whg().reconcile([plan.query], { signal: me.signal }); } catch (e) { err = me.signal.reason?.name === 'PermissionError' ? me.signal.reason : e; }
    if (inFlight !== me || !s) return;   // closed, or another place chosen, meanwhile
    inFlight = null;
    const list = lists?.[0] ?? null;
    s.problem = A.lookupProblem(err, list);
    s.failedClosed = !err && !!list && failedClosed(list);
    if (err && !s.problem) s.problem = { kind: 'server', text: CHORA_ADOPT_TEXT.problem.server, offer: 'retry' };
    if (!s.problem) {
      const attribution = lists.attribution ?? null;
      s.answer = { list: [...list], attribution };
      s.ranked = A.rankCandidates(s.reference, s.answer.list);
      for (const c of s.answer.list) s.statuses.set(c.id, A.candidateStatus(c, { identities: s.view.identities, attribution }));
    }
    s.phase = s.problem ? 'problem' : 'answered';
    render();
    const shown = drawMarkers();
    const pts = shown.map((c) => c.coords);
    if (pts.length) mapApi.fit(boxOfPoints(pts), 9);
    if (s.problem?.offer === 'token') { root.querySelector('#adopt-forget')?.focus(); }
  }
  const boxOfPoints = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];

  async function preview(id) {
    const r = s?.ranked?.find((x) => x.candidate.id === id);
    if (!r || inFlight) return;
    const c = r.candidate, st = s.statuses.get(id);
    s.done = null;
    if (!st.mayCopy) { s.preview = { id, candidate: c, feature: null, offered: [] }; render(); drawMarkers(); return; }
    s.phase = 'fetching'; s.preview = null; render();
    const me = (inFlight = new AbortController());
    let feature = null, err = null;
    try { feature = await whg().entity(c.id, { signal: me.signal }); } catch (e) { err = me.signal.reason?.name === 'PermissionError' ? me.signal.reason : e; }
    if (inFlight !== me || !s) return;
    inFlight = null;
    const fetched = new Date().toISOString();
    if (err?.kind === 'unavailable' || err?.status === 451) {
      // Consulted, not copied: its point is hidden too, and a hand-drawing is offered.
      s.unavailable.add(id);
      s.preview = { id, candidate: c, feature: null, fetchError: err, offered: [] };
    } else if (err?.name === 'PermissionError' || err?.kind === 'auth' || err?.kind === 'quota') {
      s.problem = A.lookupProblem(err); s.phase = 'problem'; render(); return;
    } else {
      // WHG's representative point stands in only after a passing failure, and never for a WHG record whose licence is unknown (adopt.js).
      const fallback = !feature && Array.isArray(c.coords) && A.fallbackAllowed(err) && !(st.whgNative && st.licence === null);
      const offered = feature ? A.featureGeometries(feature)
        : fallback ? [{ index: 0, geojson: { type: 'Point', coordinates: c.coords }, role: 'RepresentativePoint' }] : [];
      const usable = offered.filter((o) => !o.refused);
      s.preview = { id, candidate: c, feature, fetchError: err ? { kind: err.kind ?? null, status: err.status ?? null } : null, fetchProblem: err ? (A.lookupProblem(err)?.text || '') : null,
        offered, chosen: usable.length === 1 ? usable[0].index : null, fetched, basis: '' };
    }
    s.phase = 'preview';
    render(); drawMarkers();
    const geoms = (s.preview.offered || []).map((o) => ({ type: 'Feature', geometry: stripWhen(o.geojson), properties: { kind: 'record' } }));
    showAdopted(s.view.id, [...referenceFeature(), ...geoms]);
    const pts = geoms.flatMap((g) => flat(g.geometry.coordinates));
    if (pts.length) mapApi.fit(boxOfPoints(pts), 12);
    root.querySelector('#adopt-preview')?.scrollIntoView({ block: 'nearest' });
  }
  const flat = (c) => (typeof c?.[0] === 'number' ? [c] : (c || []).flatMap(flat));

  function adopt() {
    const p = s?.preview;
    if (!p) return;
    p.basis = root.querySelector('#adopt-basis')?.value ?? p.basis;
    p.role = root.querySelector('#adopt-role')?.value || p.role;
    const now = new Date().toISOString();
    const place = { '@id': s.view.id, label: s.view.label };
    const args = { place, candidate: p.candidate, feature: p.feature, fetchError: p.fetchError, geometryIndex: p.chosen, role: p.role, basis: p.basis, attribution: s.answer.attribution, identities: s.view.identities, created: now, fetched: p.fetched };
    // Checked now, with a stand-in contributor (who saves is asked when saving, as for drawings).
    const check = A.safeAdoption({ ...args, contributor: { name: 'check' } });
    p.notes = check.notes;
    if (check.refused) { p.refused = check.refused.reason; render(); return; }
    let d;
    try { d = A.adoptionDraft({ id: `adopt-${now}-${Math.random().toString(16).slice(2, 8)}`, ...args }); }
    catch (e) { p.refused = CHORA_ADOPT_TEXT.error(e?.message || String(e)); render(); return; }
    d.count = check.attestations.length;
    addAdoption(d);
    s.done = { count: d.count, id: d.id, candidate: p.candidate.id };
    s.preview = null; s.phase = 'adopted';
    render(); showAdopted(s.view.id, referenceFeature());
    root.querySelector('#adopt-done')?.focus?.();
  }

  root.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'adopt-form') send();
    if (e.target.id === 'adopt-token-form') {
      const f = root.querySelector('#adopt-token');
      if (f.value.trim()) token.set(f.value);
      f.value = '';   // the token is kept by its keeper only, not in the field
      if (s?.problem?.kind === 'token' || s?.problem?.kind === 'auth') s.problem = null;
      render(); root.querySelector('#adopt-q')?.focus();
    }
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !s) return;
    if (b.id === 'adopt-close') close();
    else if (b.id === 'adopt-forget') { whg().clearToken(); token.forget(); s.problem = null; render(); root.querySelector('#adopt-token')?.focus(); }
    else if (b.id === 'adopt-retry') send();
    else if (b.id === 'adopt-widen') { s.widened = true; send(); }
    else if (b.id === 'adopt-narrow') { s.widened = false; send(); }
    else if (b.dataset.preview) preview(b.dataset.preview);
    else if (b.dataset.dismiss) { s.dismissed.add(b.dataset.dismiss); if (s.preview?.id === b.dataset.dismiss) s.preview = null; render(); drawMarkers(); }
    else if (b.id === 'adopt-go') adopt();
    else if (b.id === 'adopt-unarm') { s.preview.armed = false; armConsult(null); render(); }
    else if (b.id === 'adopt-draw') { s.preview.armed = true; armConsult({ placeId: s.view.id, ...A.consultation(s.preview.candidate, s.answer.attribution) }); render(); }
  });
  // The line under the name follows what is typed (a name of the place's own goes with its language).
  root.addEventListener('input', (e) => { if (s && e.target.id === 'adopt-q') { const l = root.querySelector('#adopt-sends'); if (l) l.textContent = sendsLine(); } });
  root.addEventListener('change', (e) => {
    if (!s?.preview) return;
    if (e.target.name === 'adopt-geom') { s.preview.chosen = Number(e.target.value); s.preview.role = ''; s.preview.basis = root.querySelector('#adopt-basis')?.value ?? s.preview.basis; render(); }
    if (e.target.id === 'adopt-role') s.preview.role = e.target.value;
    if (e.target.id === 'adopt-basis') s.preview.basis = e.target.value;
  });
  publish();
  return { openFor, close, placeShown, showAdopted, get busy() { return !!inFlight; }, get open() { return !!s; },
    /** What a reload would lose: the answers on screen (an adoption made is kept with the drawings). */
    loses: () => (s?.answer && !s.done ? W.reloadLoses : null) };
}
