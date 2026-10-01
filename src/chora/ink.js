// Assisted ink tracing on Chora's page: "Trace area" and "Trace line" on a historical map shown, and "Snap
// to ink" for drawing by hand. Loaded only when first wanted (a chunk of its own), with its worker.
//
// A click on a map shown (the topmost whose mask holds the click) is placed on the map's image through
// its georeference (georef's toPixels), and the worker (src/chora/ink.worker.js) proposes a shape there
// from the map's own pixels; the tiles it needs are fetched here, through remote.js and the permissions
// module, under the map's `iiif:<site>` permission, from the map's image server alone (src/chora/inkfetch.js).
// A permission withdrawn lets go at once of every tile and window read from that site, here and in the
// worker, and of a proposal or snapping made from them. The proposal, carried back into the world through the same
// georeference (toWorld; no densifying), is drawn dashed in orange with its parameters beside it: a slider
// moved proposes again (from the worker's window, already read), Shift-click carries a line on from a
// second click, Enter accepts it (an ordinary drawing, which then takes the drawing's own path: cited from
// that map, its round trip checked) and Esc lets it go. Nothing is a drawing until it is accepted.
import inkWorkerUrl from './ink.worker.js?worker&url';
import * as permissions from '../lib/permissions.js';
import { createTileFetcher, TileError } from './inkfetch.js';
import { binPoints, nearestInk, SNAP_RADIUS } from '../engine/chora/ink/snap.js';
import { DEFAULTS } from '../engine/chora/ink/params.js';
import { runTrace, runSnap } from '../engine/chora/ink/job.js';
import { createJobs } from './inkjobs.js';
import { keyAction } from './inkkeys.js';
import { inkProposedText } from '../engine/words.js';
import * as georef from '../engine/georef/index.js';

const ORANGE = '#e8590c';
const SOURCE = 'chora-ink';
const EMPTY = { type: 'FeatureCollection', features: [] };
const round9 = (v) => Math.round(v * 1e9) / 1e9;
const roundCoords = (c) => (typeof c[0] === 'number' ? c.map(round9) : c.map(roundCoords));

/**
 * The tools. `mapApi` (map.js's), `state` (window.__chora: its `ink` is kept up to date for tests),
 * `overlayAt(lngLat)` -> (a promise of) the map shown there (an entry of the layer manager: { key, g,
 * info, title, subject }) or null, `onAccept({ geometry, key, assisted, note })` makes the drawing (or returns why not, in words: the proposal is then kept), and
 * `panel` the element the parameters are shown in.
 */
export function createInk({ mapApi, state, overlayAt, onAccept, panel }) {
  const map = mapApi.map;
  const ink = (state.ink = { phase: 'idle', mode: null, proposals: 0, accepted: 0, lastMs: null, lastError: null, snapPoints: 0, snapBuilds: 0, timings: [], steps: [] });
  // A site's tiles are kept only while its permission is allowed (inkfetch.js).
  const fetcher = createTileFetcher({ allowed: (o) => permissions.allowed('iiif', o) });
  // The worker's jobs (inkjobs.js): a tile it needs is fetched here, under the map's site's permission.
  const jobs = createJobs({
    makeWorker: () => new Worker(permissions.blobWorkerUrl(inkWorkerUrl), { type: 'module' }),   // from a blob: that imports it, so that it is under the page's policy (as MapLibre's worker is)
    onNeed: async (m, entry, isCurrent) => {
      const site = siteOf(entry);
      sitesRead.add(site);
      try { return await fetcher.fetch(m.urls, { origin: site, isCurrent }); } catch (e) { throw e instanceof TileError ? e : new TileError(e.message, 'other'); }
    },
    onStep: (timing, kind) => ink.steps.push({ ...timing, kind }),
  });
  const newGen = jobs.newGen;
  // The site of a map's image server: its `iiif` permission's subject (admission's), else its image's id.
  const siteOf = (entry) => entry.subject?.[1] ?? permissions.originOf(entry.info?.id ?? entry.info?.['@id'] ?? entry.g.imageServiceId);
  const sitesRead = new Set();   // the sites tiles were read from in this load
  /** A site whose permission is no longer allowed: everything read from it is let go, here and in the worker. */
  function letGoOf(site) {
    sitesRead.delete(site);
    fetcher.forget(site);
    jobs.forget(site);
    if (lastWindow && lastWindow.site === site) lastWindow = null;
    if (proposal && siteOf(proposal.entry) === site) discard();
    // The snapping is let go whichever map it is from, and a build under way with it (its map may be the
    // site's, and is not known to be until the build ends): it is built again on the next move of the map.
    ink.snapLetGo = snapBuilding ? siteOf(snapBuilding) : snapEntry ? siteOf(snapEntry) : null;
    newGen('snap'); snapWorld = null; snapIndex = null; snapEntry = null; snapBuilding = null; ink.snapPoints = 0;
    ink.letGo = (ink.letGo || 0) + 1;
  }
  permissions.onChange(() => { for (const site of [...sitesRead]) if (!permissions.allowed('iiif', site)) letGoOf(site); });
  /** One window's pixel work, in the worker (step.js), for job.js's plan. */
  const stepper = jobs.step;

  // ---- Where a click is on the map's image -------------------------------------------------------
  const pointOf = (lngLat) => ({ type: 'Point', coordinates: [lngLat.lng, lngLat.lat] });
  async function imagePx(g, lngLat) { return (await georef.toPixels(g, pointOf(lngLat), { space: 'image' })).geometry.coordinates; }
  /** Image pixels per screen pixel about a point of the screen (across and down, the larger). */
  async function pxPerScreen(g, xy) {
    const at = (dx, dy) => imagePx(g, map.unproject([xy[0] + dx, xy[1] + dy]));
    const [a, b, c] = await Promise.all([at(0, 0), at(8, 0), at(0, 8)]);
    return Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1])) / 8;
  }

  // ---- The proposal ----------------------------------------------------------------------------
  let mode = null;            // 'area' | 'line' | null
  let proposal = null;        // { entry, mode, seeds: [{ seedImg, pxPerScreen }], image: result(s), world, gaps }
  let lastWindow = null;      // { key, colour, frame }: the window the worker last made ready
  const params = { area: { ...DEFAULTS.area }, line: { ...DEFAULTS.line } };
  function draw() {
    const src = map.getSource(SOURCE);
    if (!src) return;
    const features = [];
    if (proposal?.world) {
      const g = proposal.world;
      const lines = g.type === 'Polygon' ? g.coordinates.map((r) => ({ type: 'LineString', coordinates: r })) : [g];
      for (const l of lines) features.push({ type: 'Feature', geometry: l, properties: { part: 'proposal' } });
      for (const gap of proposal.worldGaps || []) features.push({ type: 'Feature', geometry: gap, properties: { part: 'gap' } });
    }
    for (const s of proposal?.seedsWorld || []) features.push({ type: 'Feature', geometry: s, properties: { part: 'seed' } });
    src.setData({ type: 'FeatureCollection', features });
  }
  mapApi.onStyleLoad((m) => {
    if (!m.getSource(SOURCE)) m.addSource(SOURCE, { type: 'geojson', data: EMPTY });
    if (!m.getLayer('chora-ink-proposal')) m.addLayer({ id: 'chora-ink-proposal', type: 'line', source: SOURCE, filter: ['==', ['get', 'part'], 'proposal'], paint: { 'line-color': ORANGE, 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
    if (!m.getLayer('chora-ink-gaps')) m.addLayer({ id: 'chora-ink-gaps', type: 'line', source: SOURCE, filter: ['==', ['get', 'part'], 'gap'], paint: { 'line-color': ORANGE, 'line-width': 1.5, 'line-dasharray': [1, 2] } });
    if (!m.getLayer('chora-ink-seed')) m.addLayer({ id: 'chora-ink-seed', type: 'circle', source: SOURCE, filter: ['==', ['get', 'part'], 'seed'], paint: { 'circle-radius': 3, 'circle-color': ORANGE } });
    draw();
  });

  async function toWorld(g, geometry) { return (await georef.toWorld(g, geometry, { space: 'image', precision: 12 })).geojson; }
  /** A line's points joined to those before (Shift-click): the new part's points near the old line let go. */
  function joinLines(old, add, width) {
    const near = (p) => { for (let k = 0; k < old.length - 1; k++) { const a = old[k], b = old[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0; if (Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) <= width) return true; } return false; };
    let rest = add.filter((p) => !near(p));
    if (!rest.length) return old;
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const options = [
      [d(old.at(-1), rest[0]), () => [...old, ...rest]], [d(old.at(-1), rest.at(-1)), () => [...old, ...[...rest].reverse()]],
      [d(old[0], rest.at(-1)), () => [...rest, ...old]], [d(old[0], rest[0]), () => [...[...rest].reverse(), ...old]],
    ].sort((a, b) => a[0] - b[0]);
    return options[0][1]();
  }

  async function propose({ extend = false, again = false } = {}) {
    const p = proposal;
    if (!p) return;
    const t0 = performance.now();
    ink.phase = 'tracing'; ink.lastError = null; ink.steps = []; say('Reading the map…');
    try {
      const results = [], gen = newGen('trace'), step = stepper('trace', gen, p.entry);
      let traced = 0;   // the clicks traced this time (for tests: carried on, the earlier ones are not)
      for (const [k, s] of p.seeds.entries()) {
        // Carried on (Shift-click): the parts already proposed are kept as they are; only the new click is traced.
        if (extend && p.results?.[k]) { results.push(p.results[k]); continue; }
        // Again from the same clicks (a slider moved): each from the window its last proposal ended in.
        const start = again ? p.results?.[k]?.frame || null : null;
        // A new click well inside the window last read (same map, same kind) begins from it: it is made ready.
        const near = !again && lastWindow?.key === p.entry.key && lastWindow.colour === (p.mode === 'area' || !!params[p.mode].colour) ? lastWindow.frame : null;
        const r = await runTrace({ info: p.entry.info, seedImg: s.seedImg, pxPerScreen: s.pxPerScreen, mode: p.mode, params: { ...params[p.mode] }, step, isCurrent: () => jobs.current('trace', gen), start, near });
        lastWindow = { key: p.entry.key, site: siteOf(p.entry), colour: p.mode === 'area' || !!params[p.mode].colour, frame: r.frame };
        results.push(r); traced++;
      }
      if (proposal !== p) return;
      const last = results.at(-1);
      let geometry, gaps = [];
      if (p.mode === 'area') geometry = { type: 'Polygon', coordinates: last.rings };
      else {
        let pts = results[0].points;
        for (const r of results.slice(1)) pts = joinLines(pts, r.points, 1.5 * r.width * r.scale);
        geometry = { type: 'LineString', coordinates: pts };
        gaps = results.flatMap((r) => r.gaps);
      }
      p.image = geometry; p.results = results;
      const tw = performance.now();
      p.world = await toWorld(p.entry.g, geometry);
      p.worldGaps = await Promise.all(gaps.map((gp) => toWorld(p.entry.g, { type: 'LineString', coordinates: gp })));
      p.seedsWorld = await Promise.all(p.seeds.map((s) => toWorld(p.entry.g, { type: 'Point', coordinates: s.seedImg })));
      if (proposal !== p) return;
      const ms = performance.now() - t0, worldMs = performance.now() - tw;
      Object.assign(ink, { phase: 'proposed', proposals: ink.proposals + 1, lastMs: ms, last: { mode: p.mode, scale: last.scale, grown: last.grown, coarser: last.coarser, frame: last.frame, epsilon: last.epsilon, vertices: p.mode === 'area' ? last.rings[0].length - 1 : geometry.coordinates.length, holes: p.mode === 'area' ? last.rings.length - 1 : 0, gaps: gaps.length, ends: last.ends || null, extended: extend, seedsTraced: traced, scales: results.map((r) => r.scale), image: geometry, worldMs } });
      ink.timings.push({ ms, mode: p.mode, seeds: p.seeds.length, requests: fetcher.stats.requests, fromCache: fetcher.stats.fromCache });
      draw();
      const holes = p.mode === 'area' ? last.rings.length - 1 : 0;
      say(inkProposedText({ mode: p.mode, scale: last.scale, gaps: gaps.length, holes, ends: last.ends || null }));
    } catch (e) {
      if (e.kind === 'cancelled' || proposal !== p) return;
      Object.assign(ink, { phase: 'error', lastError: e.message, lastErrorKind: e.kind || null });
      p.world = null; draw();
      say(e.message, true);
    }
  }

  async function click(lngLat, point, shift) {
    if (!mode) return;
    // The map clicked has the keyboard (Enter then accepts: on the Trace button left focused, it would press it).
    if (!map.getContainer().contains(document.activeElement)) try { map.getCanvas().focus({ preventScroll: true }); } catch {}
    const entry = await overlayAt(lngLat);
    if (!entry) { say('Click on a historical map shown on the map: the shape is proposed from its ink.', true); return; }
    let seedImg, per;
    try { [seedImg, per] = await Promise.all([imagePx(entry.g, lngLat), pxPerScreen(entry.g, point)]); } catch (e) { say(`That point cannot be placed on the map's image (${e.message}).`, true); return; }
    const seed = { seedImg, pxPerScreen: per };
    if (shift && mode === 'line' && proposal?.mode === 'line' && proposal.entry.key === entry.key && proposal.world) {
      proposal.seeds.push(seed);
      return propose({ extend: true });
    }
    proposal = { entry, mode, seeds: [seed] };
    return propose();
  }

  function discard() {
    newGen('trace');
    const had = !!proposal;
    proposal = null; draw();
    Object.assign(ink, { phase: 'idle' });
    if (had) say(mode ? 'Let go. Click on the map to trace again.' : '');
  }
  function accept() {
    const p = proposal;
    if (!p?.world) return false;
    let geometry = { type: p.world.type, coordinates: roundCoords(p.world.coordinates) };
    let note = null, dropped = 0;
    if (geometry.type === 'Polygon' && geometry.coordinates.length > 1) {
      // A drawing is edited as an outline alone (Terra Draw takes no holes): the holes are left out, and said
      // so here and in the attestation's notes (assisted.holes).
      dropped = geometry.coordinates.length - 1;
      note = `The ${dropped} hole${dropped === 1 ? ' was' : 's were'} left out: drawings are outlines without holes.`;
      geometry = { type: 'Polygon', coordinates: [geometry.coordinates[0]] };
    }
    const last = p.results.at(-1);
    const assisted = {
      mode: p.mode, scale: last.scale, scales: p.results.map((r) => r.scale), epsilon: Math.max(...p.results.map((r) => r.epsilon)), gaps: p.results.reduce((n, r) => n + (r.gaps?.length || 0), 0),
      params: Object.fromEntries(Object.entries(params[p.mode]).filter(([k]) => ['tolerance', 'colour', 'bridge', 'band', 'jumps', 'detail', 'dropSmallHoles'].includes(k))),
      seeds: p.seeds.map((s) => s.seedImg), window: [last.frame.w, last.frame.h], proposed: geometry, from: p.entry.title || null, fromKey: p.entry.key ?? null,
      ...(p.mode === 'area' ? { holes: { dropped } } : {}),
    };
    // Not a drawing unless the page took it (a place must be chosen first): the proposal is kept, and why said.
    const refused = onAccept({ geometry, key: p.entry.key, assisted, note });
    if (refused) { say(refused, true); return false; }
    proposal = null; draw();
    ink.accepted++; ink.phase = 'accepted';
    say(note ? `Accepted. ${note}` : 'Accepted: it is a drawing now, to edit or remove like any other.');
    return true;
  }

  // ---- The panel -------------------------------------------------------------------------------
  function say(text, warn = false) {
    const el = panel.querySelector('[data-ink-status]');
    if (el) { el.textContent = text; el.className = warn ? 'warn' : ''; }
  }
  const range = (k, label, min, max, step, v, hint) => `<label class="ink-range">${label} <input type="range" data-p="${k}" min="${min}" max="${max}" step="${step}" value="${v}"> <output data-o="${k}">${v}</output>${hint ? ` <small class="muted">${hint}</small>` : ''}</label>`;
  const box = (k, label, v) => `<label><input type="checkbox" data-p="${k}"${v ? ' checked' : ''}> ${label}</label>`;
  function renderPanel() {
    if (!mode) { panel.hidden = true; return; }
    const q = params[mode];
    panel.hidden = false;
    panel.innerHTML = `<p class="ink-title">${mode === 'area' ? 'Trace an area' : 'Trace a line'}: click on a historical map</p>
      <p data-ink-status aria-live="polite"></p>
      <div class="ink-params">${mode === 'area'
        ? range('tolerance', 'Colour tolerance', 2, 40, 1, q.tolerance, 'ΔE')
          + box('bridgeOn', 'Bridge gaps in the outline', q.bridge > 0) + range('bridge', 'up to', 2, 20, 1, q.bridge || 6, 'px')
          + box('dropSmallHoles', 'Leave out small holes (lettering)', q.dropSmallHoles)
        : box('colour', 'Match the colour clicked (else: the darkest ink)', q.colour) + range('tolerance', 'Colour tolerance', 2, 40, 1, q.tolerance, 'ΔE')
          + range('bandLo', 'Thickness from', 0.2, 1, 0.05, q.band[0], '× the width clicked') + range('bandHi', 'to', 1, 4, 0.1, q.band[1], '×')
          + box('jumps', 'Jump gaps in the line (up to 3× its width)', q.jumps)}
        ${range('detail', 'Simplify within', 0.1, 3, 0.05, q.detail, 'px of the image read')}</div>
      <p class="ink-buttons"><button type="button" class="primary" data-ink="accept">Accept (Enter)</button> <button type="button" data-ink="discard">Let go (Esc)</button></p>`;
    say(proposal ? '' : 'Click on a historical map shown on the map.');
  }
  let rerun = null;
  panel.addEventListener('input', (e) => {
    const k = e.target.dataset.p; if (!k || !mode) return;
    const q = params[mode], v = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
    const out = panel.querySelector(`[data-o="${k}"]`); if (out) out.textContent = String(v);
    if (k === 'bridgeOn') q.bridge = v ? Number(panel.querySelector('[data-p="bridge"]').value) : 0;
    else if (k === 'bridge') { if (panel.querySelector('[data-p="bridgeOn"]').checked) q.bridge = v; }
    else if (k === 'bandLo') q.band = [v, q.band[1]];
    else if (k === 'bandHi') q.band = [q.band[0], v];
    else q[k] = v;
    // A slider re-proposes from the window already read (the worker keeps it), once the hand stops.
    clearTimeout(rerun);
    if (proposal) rerun = setTimeout(() => propose({ again: true }), 120);
  });
  panel.addEventListener('click', (e) => {
    if (e.target.dataset.ink === 'accept') accept();
    if (e.target.dataset.ink === 'discard') discard();
  });
  // Enter accepts and Esc lets go only where the key is not another control's (inkkeys.js): Enter on Save
  // saves, and Esc in the permissions dialog closes it.
  const modalOpen = () => { try { return !!document.querySelector('dialog[open]:modal'); } catch { return !!document.querySelector('dialog[open]'); } };
  document.addEventListener('keydown', (e) => {
    if (!mode && !proposal) return;
    const { action, prevent } = keyAction(e, { panel, mapContainer: map.getContainer(), mode, proposal: !!proposal, proposed: !!proposal?.world, dialogOpen: modalOpen() });
    if (prevent) e.preventDefault();
    if (action === 'accept') accept(); else if (action === 'discard') discard();
  });

  // ---- Snapping to the ink, for drawing by hand --------------------------------------------------
  // Two sets of points: the ridges (a line's centre) and the edges (an area's edge). A ridge within reach
  // wins over a nearer edge (snap.js nearestInk): a vertex drawn near a line goes onto its middle, not onto its side.
  let snapOn = false, snapWorld = null, snapIndex = null, snapEntry = null, snapTimer = null;
  let snapBuilding = null;   // the map a snapping is being built from, until it is (or is let go)
  // Snapping is used while drawing a line or an area by hand (Terra Draw's modes that ask for it), and not
  // while tracing: otherwise it is not built again as the map moves.
  const snapWanted = () => snapOn && !mode && ['linestring', 'polygon'].includes(mapApi.draw?.getMode?.());
  function reproject() {
    if (!snapWorld) { snapIndex = null; return; }
    const t0 = performance.now();
    const index = (world) => {
      const n = world.length / 2, screen = new Float64Array(world.length);
      for (let k = 0; k < n; k++) { const p = map.project([world[2 * k], world[2 * k + 1]]); screen[2 * k] = p.x; screen[2 * k + 1] = p.y; }
      return binPoints(screen, world);
    };
    snapIndex = { ridges: index(snapWorld.ridges), edges: index(snapWorld.edges) };
    // The main thread's part of each view's snapping: the points onto the screen and binned (for the budget).
    ink.snapReprojectMs = performance.now() - t0;
  }
  // Alt held, no snapping: watched here as well as in Terra Draw's own record of the keys held.
  let alt = false;
  addEventListener('keydown', (e) => { if (e.key === 'Alt') alt = true; }, true);
  addEventListener('keyup', (e) => { if (e.key === 'Alt') alt = false; }, true);
  addEventListener('blur', () => { alt = false; });
  async function buildSnap() {
    if (!snapOn) return;
    // Its generation from the start: a newer build, or a permission withdrawn meanwhile (letGoOf), lets this one go.
    const gen = newGen('snap');
    const current = () => jobs.current('snap', gen);
    const c = map.getCanvas(), w = c.clientWidth, h = c.clientHeight;
    const entry = (await overlayAt(map.getCenter())) || (await overlayAt(map.unproject([w / 4, h / 4]))) || (await overlayAt(map.unproject([(3 * w) / 4, (3 * h) / 4])));
    if (!current()) return;
    if (!entry) { snapWorld = null; snapIndex = null; snapEntry = null; ink.snapPoints = 0; return; }
    snapBuilding = entry;
    try {
      const corners = await Promise.all([[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => imagePx(entry.g, map.unproject([x, y])).catch(() => null)));
      const ok = corners.filter(Boolean);
      if (!ok.length || !current()) return;
      const box = [Math.min(...ok.map((p) => p[0])), Math.min(...ok.map((p) => p[1])), Math.max(...ok.map((p) => p[0])), Math.max(...ok.map((p) => p[1]))];
      const per = await pxPerScreen(entry.g, [w / 2, h / 2]);
      if (!current()) return;
      const r = await runSnap({ info: entry.info, box, pxPerScreen: per, step: stepper('snap', gen, entry), isCurrent: current });
      // Into the world exactly, through the georeference, each set as one MultiPoint.
      const world = async (pts) => {
        const coords = []; for (let k = 0; k < pts.length; k += 2) coords.push([pts[k], pts[k + 1]]);
        return Float64Array.from(coords.length ? (await toWorld(entry.g, { type: 'MultiPoint', coordinates: coords })).coordinates.flat() : []);
      };
      const tw = performance.now();
      const [ridges, edges] = await Promise.all([world(r.ridges), world(r.edges)]);
      const worldMs = performance.now() - tw;
      // Let go meanwhile (a permission withdrawn, a newer build): what was read is not kept.
      if (!current()) return;
      snapEntry = entry;
      snapWorld = { ridges, edges };
      ink.snapPoints = (ridges.length + edges.length) / 2; ink.snapRidges = ridges.length / 2; ink.snapBuilds++;
      reproject();
      // The main thread's work for a build: into the world through the georeference, then onto the screen.
      ink.snapBuild = { points: ink.snapPoints, worldMs, reprojectMs: ink.snapReprojectMs, mainMs: worldMs + ink.snapReprojectMs, scale: r.frame?.s ?? null, window: r.frame ? [r.frame.w, r.frame.h] : null };
    } catch (e) { if (e.kind !== 'cancelled' && current()) { ink.snapError = e.message; } }
    finally { if (current() && snapBuilding === entry) snapBuilding = null; }
  }
  map.on('moveend', () => {
    if (!snapWanted()) return;
    reproject();
    clearTimeout(snapTimer); snapTimer = setTimeout(() => { if (snapWanted()) buildSnap(); }, 250);
  });
  const snapHook = (event) => {
    if (!snapOn || !snapIndex || alt || event.heldKeys?.includes('Alt')) return undefined;
    const hit = nearestInk(snapIndex, event.containerX, event.containerY, SNAP_RADIUS);
    return hit ? [round9(hit.lngLat[0]), round9(hit.lngLat[1])] : undefined;
  };
  mapApi.setSnap(snapHook);

  const api = {
    get mode() { return mode; },
    setMode(m) {
      if (m !== mode) discard();
      mode = m; ink.mode = m;
      renderPanel();
    },
    click, accept, discard,
    get proposal() { return proposal; },
    setSnap(on) {
      snapOn = !!on; ink.snap = snapOn;
      if (snapOn) { reproject(); buildSnap(); } else { clearTimeout(snapTimer); newGen('snap'); snapWorld = null; snapIndex = null; snapEntry = null; snapBuilding = null; }
    },
    get snapEntry() { return snapEntry; },
    /** How many fetched tiles the page keeps now (for tests: none from a site once its permission is withdrawn). */
    get cachedTiles() { return fetcher.size; },
    /** How many tiles the worker holds now (a promise; for tests: none from a site once its permission is withdrawn). */
    workerTiles: () => jobs.workerTiles(),
    snapNow: buildSnap,
    /** Where a vertex at these container pixels would snap (for tests and the budget's timing). */
    snapAt: (x, y) => snapHook({ containerX: x, containerY: y, heldKeys: [] }),
  };
  // For automated tests; nothing else reads it.
  window.__chora_ink = api;
  return api;
}
