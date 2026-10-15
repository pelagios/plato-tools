// "Make a map" in Chora (#37, "Make an open map"; Stephen's decisions of 14 October 2026): a plain map of the
// view, its places labelled, made as an SVG and a PNG under a licence Wikimedia Commons accepts, with its Commons
// page ready to paste. The view is what the map shows; the panel says what the map is made of, and the map is
// shown in a preview over Chora's own, as it will be written: the same SVG, the labels dragged there.
//
// What it is made of, and what it may be used for, is worked out by the engine (src/engine/chora/export/): the
// background and its licence (basemaps.js `export`), the relief, a georeferenced map if one is chosen, the places
// in view (at most PLACE_CAP, all ticked, untick to leave one out), their labels, the furniture, the licence of
// the whole and the Commons page. The author is the Chora contributor (name and ORCID iD, contributor.js), never
// anyone's email. The map's settings are kept in the SVG's <metadata>, and a map made here can be made again from
// them (Remake from a map made here). In a workflow at its step "Make the map", a download does that step
// (host.exported, Methodos's mapped).
//
// Its state, for the browser checks, is window.__chora.export.
import { composeMap, neLayers } from '../engine/chora/export/compose.js';
import { nameChoices, labelText, languagesOf, CLASS_WORDS, LABEL_CLASSES } from '../engine/chora/export/labels.js';
import { composeLicence, MAP_LICENCES, OWN_DEFAULT, STATEMENTS, suggestedStatement } from '../engine/chora/export/licence.js';
import { filePage, uploadUrl, commonsName, UPLOAD_LINK_TEXT } from '../engine/chora/export/commons.js';
import { inView, recordSites, PLACE_CAP } from '../engine/chora/export/places.js';
import { PROJECTION_WORDS, exportView, mercator } from '../engine/chora/export/project.js';
import { settingsIn } from '../engine/chora/export/svg.js';
import { withMeta } from '../engine/chora/export/png-meta.js';
import { RELIEF } from '../engine/chora/relief.js';
import { TILE_BUDGET } from '../engine/chora/export/tiles.js';
import { allmapsTransformationName, manifestNavDate } from '../engine/georef/index.js';
import * as georef from '../engine/georef/index.js';
import * as basemaps from './basemaps.js';
import * as contributors from './contributor.js';
import { keyRows } from './vague.js';
import { loadFonts, measure, cssWithData } from './export-fonts.js';
import * as raster from './export-raster.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** The labels' sizes, in pixels at a map 1,200 pixels wide (larger maps scale them). */
const SIZES = { small: 11, medium: 13, large: 16 };
/** The kinds of georeference whose warp is affine, so that the map's image is embedded as it is with a matrix. */
const AFFINE = new Set(['polynomial1', 'helmert', 'straight']);
const SETTINGS_VERSION = 1;

/**
 * The panel, in `root` (Chora's section #chora-export), and its preview, in `preview` (over the map). `ctx`: { mapApi,
 * state (window.__chora), request(msg, replyType) (the worker), layers (the historical maps' manager), dataset()
 * (Chora's dataset as loaded: header, input), overview() (the overview's points), saveFile(blob, name), host (the
 * page's: exported(files) for a workflow), askContributor() (Chora's form: a promise of a contributor or null) }.
 */
export function createExport(root, preview, ctx) {
  const st = (ctx.state.export = { open: false, phase: 'closed', places: null, background: null, licence: null, labels: [], overlapping: 0, size: null, downloads: [], said: null });
  let settings = null, places = [], composed = null, pictures = {}, data = new Map(), seq = 0, busy = null;
  const $ = (id) => root.querySelector(`#chora-export-${id}`);

  root.innerHTML = `<h2 id="chora-export-h">Make a map</h2>
    <p class="muted">A map of this view as an image to share, its places labelled, under an open licence that Wikimedia Commons accepts: an SVG, which Inkscape edits, and a PNG. Frame the view on the map, then make it.</p>
    <p><button type="button" id="chora-export-open" class="primary">Make a map of this view</button>
      <label class="file-link">Remake from a map made here <input type="file" id="chora-export-remake" accept=".svg,image/svg+xml"></label></p>
    <p id="chora-export-said" class="muted" aria-live="polite"></p>
    <div id="chora-export-body" hidden></div>`;
  preview.innerHTML = `<div class="export-preview-bar"><span id="chora-export-preview-said">The map as it will be made: drag a label to move it.</span>
    <button type="button" id="chora-export-close">Close the preview</button></div><div id="chora-export-preview-map" class="export-preview-map"></div>`;
  preview.hidden = true;

  const say = (words, warn = false) => { $('said').textContent = words || ''; $('said').classList.toggle('warn', !!warn); st.said = words || null; };

  // ---- Settings ----------------------------------------------------------------------------------
  function viewNow() {
    const m = ctx.mapApi.map, c = m.getCenter(), cv = m.getCanvas();
    return { center: [c.lng, c.lat], zoom: m.getZoom(), width: cv.clientWidth, height: cv.clientHeight };
  }
  function defaults(view) {
    const ds = ctx.dataset(), title = ds?.header?.title || ds?.input?.name || 'the dataset';
    return {
      version: SETTINGS_VERSION, view, width: 1600, projection: 'mercator', dpi: 150,
      basemap: ctx.state.basemap, relief: !!ctx.mapApi.relief, ne: { modern: false, marine: false, physical: false },
      historical: null, places: {}, labels: {}, rule: null, lang: 'en',
      furniture: { north: false, inset: false, key: false, title: false },
      licence: OWN_DEFAULT, title: `Places of ${title}`, description: `Places of ${title}, made with PLATO tools.`, dataset: title,
    };
  }
  const bm = () => basemaps.byId(settings.basemap) || basemaps.byId('natural-earth');

  // ---- Opening -----------------------------------------------------------------------------------
  async function open(from = null) {
    if (!ctx.dataset()) { say('Open a dataset first: a map is made of its places.', true); return; }
    say('Gathering the places in view…');
    try { await loadFonts(); } catch (e) { say(`The map's font could not be loaded (${e.message}).`, true); return; }
    const view = from?.view || viewNow();
    if (from?.view) ctx.mapApi.map.jumpTo({ center: from.view.center, zoom: from.view.zoom });
    settings = { ...defaults(view), ...(from || {}), view };
    // The places in view, at most PLACE_CAP, all ticked unless the settings say otherwise.
    const b = boundsOf(view);
    const found = inView(ctx.overview(), b);
    const r = await ctx.request({ cmd: 'chora-export-places', ids: found.ids }, 'chora-export-places');
    places = r.places;
    st.places = { total: found.total, shown: places.length, capped: found.capped };
    st.open = true; st.phase = 'open';
    $('body').hidden = false;
    // A historical map shown is offered as the background; the first shown is chosen when the settings name none.
    const shown = (ctx.layers?.entries || []).filter((e) => e.visible && !e.error);
    if (!from && shown.length) settings.historical = historicalDefaults(shown[0]);
    render();
    await compose();
    preview.hidden = false;
    say(found.capped ? `There are ${found.total} places in view: the map is made with the first ${PLACE_CAP}. Zoom in to make it of fewer.` : '', found.capped);
  }
  function boundsOf(view) {
    const m = ctx.mapApi.map, b = m.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }
  function historicalDefaults(e) {
    // The year its manifest dates it, or none (NaN, not 0: an undated map pre-selects nothing).
    const date = String(manifestNavDate(e.manifest) || '');
    const year = /^-?\d{1,4}/.test(date) ? Number(date.match(/^-?\d{1,4}/)[0]) : NaN;
    const statement = e.rights?.free === true ? null : suggestedStatement(year);
    return { key: e.key, opacity: e.opacity ?? 1, statement, over: 'basemap' };
  }
  const entryOf = (key) => (ctx.layers?.entries || []).find((e) => e.key === key) || null;

  // ---- The form ----------------------------------------------------------------------------------
  function render() {
    const b = bm(), ex = b.export || {}, s = settings;
    const shown = (ctx.layers?.entries || []).filter((e) => !e.error);
    const langs = languagesOf(places);
    const h = s.historical ? entryOf(s.historical.key) : null;
    const contributor = contributors.load();
    $('body').innerHTML = `
      <fieldset><legend>Background</legend>
        <p id="chora-export-background">${esc(b.name)}: ${ex.refused ? `<span class="warn">${esc(ex.refused)}.</span>` : ex.licence ? esc(`${ex.licence.credit}`) : '<span class="warn">its licence is not known, so the map cannot go to Wikimedia Commons.</span>'}
          ${ex.vector ? ' Drawn as vectors.' : ' Embedded as a picture: the SVG is then mostly a picture, so the PNG may suit Commons better.'}</p>
        ${b.local ? `<p><label><input type="checkbox" id="chora-export-modern"${s.ne.modern ? ' checked' : ''}> Modern borders and names (towns, countries)</label>
          <label><input type="checkbox" id="chora-export-marine"${s.ne.marine ? ' checked' : ''}> Seas named</label>
          <label><input type="checkbox" id="chora-export-physical"${s.ne.physical ? ' checked' : ''}> Mountains, deserts and other regions named</label>
          <label><input type="checkbox" id="chora-export-relief"${s.relief ? ' checked' : ''}${ctx.state.relief?.available === false ? ' disabled' : ''}> Shaded relief</label></p>` : ''}
        ${shown.length ? `<p><label for="chora-export-hist">Historical map</label> <select id="chora-export-hist"><option value="">None</option>${shown.map((e) => `<option value="${esc(e.key)}"${h?.key === e.key ? ' selected' : ''}>${esc(e.title)}</option>`).join('')}</select></p>` : ''}
        ${h ? historicalForm(h) : ''}
      </fieldset>
      <fieldset><legend>Places</legend>
        <p class="muted" id="chora-export-count">${esc(placesWords())}</p>
        <p><label for="chora-export-rule">Labels</label> <select id="chora-export-rule"><option value="">The preferred label of each place</option>${langs.map((l) => `<option value="${esc(l)}"${s.rule?.language === l ? ' selected' : ''}>${esc(`The name in ${l} where one is attested, else the preferred label`)}</option>`).join('')}</select>
          <label for="chora-export-lang">The file's language</label> <input id="chora-export-lang" size="6" value="${esc(s.lang || '')}"></p>
        <ul class="export-places" id="chora-export-places">${places.map(placeRow).join('')}</ul>
      </fieldset>
      <fieldset><legend>The map</legend>
        <p><label for="chora-export-title">Title</label> <input id="chora-export-title" value="${esc(s.title)}"> <label><input type="checkbox" id="chora-export-title-on"${s.furniture.title ? ' checked' : ''}> on the map</label></p>
        <p><label for="chora-export-desc">Description</label> <input id="chora-export-desc" value="${esc(s.description)}" size="48"></p>
        <p>A scale bar is always drawn. <label><input type="checkbox" id="chora-export-north"${s.furniture.north ? ' checked' : ''}> North arrow</label>
          <label><input type="checkbox" id="chora-export-inset"${s.furniture.inset ? ' checked' : ''}> Locator inset</label>
          <label><input type="checkbox" id="chora-export-key"${s.furniture.key ? ' checked' : ''}> Key to how well each place is known (its marks)</label></p>
        <p role="radiogroup" aria-label="Projection">${Object.entries(PROJECTION_WORDS).map(([k, w]) => `<label><input type="radio" name="chora-export-projection" value="${k}"${s.projection === k ? ' checked' : ''}> ${esc(w)}</label>`).join(' ')}</p>
        <p><label for="chora-export-width">Width in pixels</label> <input id="chora-export-width" type="number" min="400" max="8000" step="100" value="${s.width}">
          <label for="chora-export-dpi">PNG resolution (dots per inch)</label> <input id="chora-export-dpi" type="number" min="72" max="1200" value="${s.dpi}"></p>
      </fieldset>
      <fieldset><legend>Licence</legend>
        <p><label for="chora-export-own">Your own drawing and labels</label> <select id="chora-export-own">${MAP_LICENCES.map((l) => `<option value="${esc(l.iri)}"${l.iri === s.licence ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select></p>
        <p id="chora-export-licence"></p>
        <p id="chora-export-author">${contributor ? `Author: ${esc(contributor.name)}${contributor.orcid ? ` (${esc(contributor.orcid)})` : ''}, Chora's contributor in this browser.` : 'Author: not given yet: you are asked your name (and, if you like, your ORCID iD) before the first download, as before a save.'}</p>
      </fieldset>
      <p><button type="button" id="chora-export-preview-open">Show the preview</button>
        <button type="button" id="chora-export-svg" class="primary">Download the SVG</button>
        <button type="button" id="chora-export-png">Download the PNG</button></p>
      <p id="chora-export-overlaps" class="warn" hidden></p>
      <p id="chora-export-raster" class="muted" hidden></p>
      <details id="chora-export-commons"><summary>Wikimedia Commons: the file's description</summary>
        <textarea id="chora-export-page" rows="12" readonly spellcheck="false"></textarea>
        <p><button type="button" id="chora-export-copy">Copy the description</button> <span id="chora-export-upload"></span></p></details>`;
  }
  function historicalForm(e) {
    const r = e.rights || {}, s = settings.historical, free = r.free === true;
    return `<div class="export-hist"><p>${esc(r.words || '')}</p>
      ${r.map?.credit ? `<p class="muted">Its manifest says: “${esc(r.map.credit)}”${r.map.licence ? `; licence ${esc(r.map.licenceLabel || r.map.licence)}` : ''}.</p>` : ''}
      ${free ? '' : `<p><label for="chora-export-statement">Its rights, as you state them</label> <select id="chora-export-statement"><option value="">Choose…</option>${STATEMENTS.filter((x) => x.key !== 'manifest' || r.map?.licence).map((x) => `<option value="${esc(x.key)}"${s.statement === x.key ? ' selected' : ''}>${esc(x.words)}</option>`).join('')}</select>
        <small class="muted">Recorded as your statement, in the file's description.</small></p>`}
      <p><label for="chora-export-hist-opacity">Its opacity</label> <input id="chora-export-hist-opacity" type="range" min="0.2" max="1" step="0.05" value="${s.opacity}">
        <label for="chora-export-hist-over">Over</label> <select id="chora-export-hist-over"><option value="basemap"${s.over === 'basemap' ? ' selected' : ''}>the basemap</option><option value="alone"${s.over === 'alone' ? ' selected' : ''}>nothing: the map alone</option></select></p></div>`;
  }
  function placesWords() {
    const ticked = places.filter((p) => settings.places[p.id]?.off !== true).length;
    return `${ticked} of the ${places.length} places in view are on the map${st.places?.capped ? ` (of ${st.places.total} in view: at most ${PLACE_CAP})` : ''}. Untick a place to leave it out.`;
  }
  function placeRow(p) {
    const l = settings.labels[p.id] || {}, off = settings.places[p.id]?.off === true;
    const choices = nameChoices(p);
    return `<li data-place="${esc(p.id)}"><label><input type="checkbox" data-tick${off ? '' : ' checked'}> <span class="name">${esc(labelText(p, { rule: settings.rule, chosen: l.name }))}</span></label>
      <select data-name aria-label="Its label">${choices.map((c) => `<option value="${esc(c.key)}"${(l.name || (settings.rule ? '' : 'label')) === c.key ? ' selected' : ''}>${esc(c.text)}${c.language ? ` (${esc(c.language)}${c.script ? `, ${esc(c.script)}` : ''})` : c.preferred ? ' (preferred)' : ''}</option>`).join('')}${settings.rule ? `<option value=""${!l.name ? ' selected' : ''}>As the map's rule says</option>` : ''}</select>
      <select data-cls aria-label="Its kind">${LABEL_CLASSES.map((c) => `<option value="${c}"${(l.cls || p.cls) === c ? ' selected' : ''}>${esc(CLASS_WORDS[c])}</option>`).join('')}</select>
      <select data-size aria-label="Its size">${Object.keys(SIZES).map((k) => `<option value="${k}"${(l.size || 'medium') === k ? ' selected' : ''}>${k}</option>`).join('')}</select>
      <input data-note placeholder="A short note under it" value="${esc(l.note || '')}" maxlength="60" aria-label="A short note under its label">
      <label><input type="checkbox" data-hide${l.hidden ? ' checked' : ''}> no label</label>
      ${Array.isArray(l.offset) ? '<button type="button" class="link" data-reset>put it back</button>' : ''}</li>`;
  }

  // ---- Composing ---------------------------------------------------------------------------------
  async function background(s) {
    const b = bm(), key = JSON.stringify([b.id, s.view, s.width, s.projection, s.ne]);
    if (b.local) {
      const style = await basemaps.styleFor(b);
      const layers = neLayers(style, s.ne);
      const srcs = new Set(layers.map((id) => style.layers.find((l) => l.id === id)?.source).filter(Boolean));
      const out = {};
      for (const id of srcs) {
        const url = style.sources[id].data;
        if (!data.has(url)) data.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }));
        out[id] = await data.get(url);
      }
      return { kind: 'vector', style, data: out, layers };
    }
    if (pictures.background?.key === key) return pictures.background.value;
    let value;
    if (b.kind === 'raster') {
      const p = await raster.rasterBackground(b, s.view, s.width, s.projection);
      value = { kind: 'image', href: p.href, name: b.name, info: `${b.name}: ${p.tiles} tiles at zoom ${p.z}${p.coarser ? `, coarser than the map's size asks, to stay within ${TILE_BUDGET} tiles` : ''}` };
    } else {
      const p = await raster.renderOffscreen(await basemaps.styleFor(b), s.view, s.width, s.projection, { subjects: basemaps.subjectsOf(b) });
      value = { kind: 'image', href: p.href, name: b.name, info: `${b.name}: drawn by this browser's map${p.limited ? `, at ${p.limited} pixels wide (its graphics draw at most ${p.max} pixels each way)` : ''}` };
    }
    pictures.background = { key, value };
    return value;
  }
  async function reliefLayer(s) {
    if (!s.relief || !bm().local) return null;
    const key = JSON.stringify([s.view, s.width, s.projection]);
    if (pictures.relief?.key !== key) pictures.relief = { key, value: await raster.reliefPicture(s.view, s.width, s.projection) };
    return pictures.relief.value;
  }
  async function historicalLayer(s) {
    const h = s.historical, e = h ? entryOf(h.key) : null;
    if (!e) return null;
    const key = JSON.stringify([h.key, s.view, s.width, s.projection]);
    if (pictures.historical?.key === key) return { ...pictures.historical.value, opacity: h.opacity };
    let value;
    const kind = allmapsTransformationName(e.g);
    const misfit = await georef.toWorld(e.g, { type: 'Point', coordinates: [0, 0] }, { space: 'image' }).then((r) => r.record).catch(() => null);
    if (AFFINE.has(kind) && s.projection === 'mercator') {
      const proj = mercator(exportView(s.view, s.width));
      const W = e.g.image.width, H = e.g.image.height;
      const at = async (x, y) => proj.project((await georef.toWorld(e.g, { type: 'Point', coordinates: [x, y] }, { space: 'image', precision: 9 })).geojson.coordinates);
      const [p0, p1, p2] = await Promise.all([at(0, 0), at(W, 0), at(0, H)]);
      const matrix = [(p1[0] - p0[0]) / W, (p1[1] - p0[1]) / W, (p2[0] - p0[0]) / H, (p2[1] - p0[1]) / H, p0[0], p0[1]];
      // As many of the image's pixels as the map gives it, no more.
      const img = await raster.iiifImage(e, W * Math.hypot(matrix[0], matrix[1]));
      const mask = Array.isArray(e.g.mask) && e.g.mask.length >= 3 ? e.g.mask : [[0, 0], [W, 0], [W, H], [0, H]];
      value = { name: e.title, href: img.href, affine: { matrix, width: W, height: H, mask }, how: 'affine' };
    } else {
      const p = await raster.historicalRendered(e, s.view, s.width, s.projection);
      value = { name: e.title, href: p.href, how: 'rendered', limited: p.limited, max: p.max };
    }
    value.misfit = misfit; value.kind = kind;
    pictures.historical = { key, value };
    return { ...value, opacity: h.opacity };
  }

  function labelItems(s) {
    return places.filter((p) => s.places[p.id]?.off !== true).map((p) => {
      const l = s.labels[p.id] || {};
      return { id: p.id, text: labelText(p, { rule: s.rule, chosen: l.name }), cls: l.cls || p.cls, size: SIZES[l.size || 'medium'], note: l.note || null, hidden: !!l.hidden,
        offset: Array.isArray(l.offset) ? l.offset : null, offsetWidth: l.offsetWidth || null, point: p.point, geometries: p.geometries };
    });
  }
  function licenceParts(s, hist) {
    const b = bm(), ex = b.export || {}, parts = [];
    const alone = hist && s.historical?.over === 'alone';
    if (!alone) parts.push({ name: b.name, role: 'background', licence: ex.licence || null, data: ex.data, templates: ex.templates, refused: ex.refused });
    if (!alone && s.relief && b.local) parts.push({ name: 'the shaded relief', role: 'relief', licence: RELIEF.licence, templates: RELIEF.templates });
    if (hist) { const e = entryOf(s.historical.key); parts.push({ name: `“${e.title}”`, role: 'historical', rights: e.rights, statement: s.historical.statement || null, statedBy: contributors.load()?.name || null }); }
    return parts;
  }
  function attributionLines(s, licence, hist, author) {
    const b = bm(), ex = b.export || {}, e = hist ? entryOf(s.historical.key) : null, alone = hist && s.historical.over === 'alone';
    const lines = [`Map: ${author || 'its author'}, ${licence.licence.label}, made with PLATO tools`];
    if (!alone) lines.push(`Background: ${ex.licence?.credit || b.name}`);
    if (!alone && s.relief && b.local) lines.push(RELIEF.attribution);
    if (e) lines.push(`Historical map: “${e.title}”${e.rights?.map?.credit ? `, ${e.rights.map.credit}` : ''}; placed by its georeference${e.rights?.georeference?.licenceLabel ? ` (${e.rights.georeference.licenceLabel})` : ''}`);
    const sites = recordSites(places.filter((p) => s.places[p.id]?.off !== true));
    if (sites.length) lines.push(`Places identified with ${sites.map((x) => x.site).join(', ')}`);
    lines.push(alone ? `Coastline: as “${e.title}” draws it` : ex.coastline || `Coastline: as ${b.name} draws it`);
    return lines;
  }

  /** Make the map from the settings as they are: the SVG, the PNG's SVG, the licence and the Commons page. */
  async function compose() {
    const mine = ++seq, s = settings;
    st.phase = 'composing';
    try {
      const hist = await historicalLayer(s);
      const alone = hist && s.historical.over === 'alone';
      const [bg, rel] = alone ? [null, null] : await Promise.all([background(s), reliefLayer(s)]);
      if (mine !== seq) return;
      const contributor = contributors.load();
      const items = labelItems(s);
      const licence = composeLicence({ own: s.licence, parts: licenceParts(s, hist), places: items.map((p) => ({ label: p.text, attestations: places.find((x) => x.id === p.id).licensing })) });
      const author = contributor?.name || null;
      const meta = { ...s, made: new Date().toISOString().slice(0, 10), tools: 'PLATO tools' };
      const common = {
        view: s.view, width: s.width, projection: s.projection,
        background: bg || { kind: 'none' }, relief: rel, historical: hist ? { name: hist.name, href: hist.href, opacity: hist.opacity, affine: hist.affine } : null,
        places: items, marks: !!s.furniture.key, keyRows: keyRows(),
        furniture: { north: s.furniture.north, inset: s.furniture.inset ? await landFeatures() : null, title: s.furniture.title ? s.title : '', attribution: attributionLines(s, licence, hist, author) },
        lang: s.lang || null, title: s.title, desc: s.description, settings: meta,
        dc: { title: s.title, creator: author, rights: licence.licence.iri, date: meta.made, source: 'PLATO tools, https://pelagios.org/plato-tools/' }, measure,
      };
      const out = composeMap(common);
      if (mine !== seq) return;
      composed = { out, common, licence, hist, items, author, contributor };
      st.phase = 'ready';
      Object.assign(st, {
        background: { id: bm().id, kind: (bg || {}).kind || 'none', info: bg?.info || null }, licence: { ok: licence.ok, label: licence.licence.label, refused: licence.refused, raised: licence.raised, templates: licence.templates, words: licence.words },
        labels: out.labels.map((l) => ({ id: l.id, text: l.lines.map((x) => x.text).join(' / '), position: l.position, overlaps: l.overlaps, box: l.box })),
        overlapping: out.overlapping, size: [out.width, out.height], bounds: out.bounds, projection: out.projection, rasterInSvg: out.rasterInSvg, layers: out.layers, scale: out.scale.words,
        historical: hist ? { how: hist.how, kind: hist.kind, limited: hist.limited || null } : null, svgLength: out.svg.length,
      });
      showComposed();
    } catch (e) {
      if (mine !== seq) return;
      st.phase = 'error'; st.error = e.message;
      say(`The map could not be made: ${e.message}`, true);
      console.warn('Make a map:', e);
    }
  }
  let land = null;
  async function landFeatures() {
    land ??= fetch(new URL('./basemap/land.geojson', document.baseURI)).then((r) => r.json()).then((j) => j.features);
    return land;
  }

  /** The Commons page of the map, as an SVG or a PNG. */
  function page(format) {
    const { out, licence, hist, common } = composed, s = settings, e = hist ? entryOf(s.historical.key) : null;
    const ticked = places.filter((p) => s.places[p.id]?.off !== true);
    const records = [...new Set(ticked.flatMap((p) => p.records))];
    const b = bm();
    const sources = ['Made with PLATO tools, https://pelagios.org/plato-tools/', `Places from the dataset ${s.dataset}`];
    if (!(hist && s.historical.over === 'alone')) sources.push(`Background: ${b.name}${b.export?.licence?.credit ? ` (${b.export.licence.credit})` : ''}`);
    if (s.relief && b.local) sources.push(RELIEF.licence.credit);
    if (e) sources.push(`Historical map: “${e.title}”, ${e.manifestUrl || e.g.manifestId || e.g.imageServiceId}${e.rights?.map?.credit ? ` (${e.rights.map.credit})` : ''}`);
    if (records.length) sources.push(`Places identified with: ${records.slice(0, 20).join(', ')}${records.length > 20 ? `, and ${records.length - 20} more` : ''}`);
    const residuals = hist?.misfit && Number.isFinite(hist.misfit.controlPointMisfitKm)
      ? [`The historical map is placed by its georeference (${hist.misfit.gcps} control points, a ${georef.TRANSFORMATION_WORDS[hist.misfit.transformation] || hist.kind} transformation), which misses its control points by ${hist.misfit.controlPointMisfitKm} km on average (root mean square), ${hist.misfit.controlPointMisfitMaxKm} km at most.`] : [];
    const other = commonsName(s.title, format === 'svg' ? 'png' : 'svg');
    return {
      title: s.title, description: s.description, lang: s.lang || 'en',
      legend: `Red dots: the places; ${s.furniture.key ? 'the marks round them say how well each is known (the key); ' : ''}dotted circles, where drawn: how far each may be from its point.`,
      author: { name: composed.contributor?.name || '', orcid: composed.contributor?.orcid || null }, date: new Date().toISOString().slice(0, 10),
      mapDate: e ? String(manifestNavDate(e.manifest) || '').slice(0, 10) || null : null, projection: s.projection, bounds: out.bounds,
      scaleWords: `scale bar, true ${out.scale.words}`, sources, residuals, warp: e?.g?.annotationId ? { url: e.g.annotationId } : null,
      licence, format, rasterInSvg: out.rasterInSvg, otherVersions: [other], common,
    };
  }
  function showComposed() {
    const { out, licence } = composed;
    $('licence').innerHTML = `${licence.ok ? '' : '<strong>Not for Wikimedia Commons as it is.</strong> '}${esc(licence.words)}${licence.statements.length ? ` ${esc(licence.statements.join(' '))}` : ''}`;
    $('licence').classList.toggle('warn', !licence.ok);
    for (const id of ['svg', 'png']) { $(id).disabled = !licence.ok; $(id).title = licence.ok ? '' : 'The map cannot be shared under an open licence as it is: see the licence, above.'; }
    $('overlaps').hidden = !out.overlapping;
    $('overlaps').textContent = out.overlapping ? `${out.overlapping} label${out.overlapping === 1 ? '' : 's'} found no free place, and overlap${out.overlapping === 1 ? 's' : ''} another or the furniture: drag ${out.overlapping === 1 ? 'it' : 'them'} in the preview where ${out.overlapping === 1 ? 'it' : 'they'} should go, or leave a label out.` : '';
    const notes = [st.background?.info, out.rasterInSvg ? 'This SVG is mostly a picture (its background is embedded as one): the PNG may suit Wikimedia Commons better, which marks such an SVG {{SVG with raster elements}}.' : null,
      composed.hist?.how === 'rendered' ? `The historical map's warp is not affine (${composed.hist.kind}), so it is drawn by this browser's map${composed.hist.limited ? `, at ${composed.hist.limited} pixels wide (its graphics draw at most ${composed.hist.max} pixels each way)` : ''}, and embedded as a picture.` : null].filter(Boolean);
    $('raster').hidden = !notes.length; $('raster').textContent = notes.join(' ');
    $('count').textContent = placesWords();
    const p = page('svg');
    $('page').value = filePage(p);
    const link = uploadUrl(p, commonsName(settings.title, 'svg'));
    st.commons = { link: !!link, length: link ? link.length : null };
    $('upload').innerHTML = link ? `<a id="chora-export-upload-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(UPLOAD_LINK_TEXT)}</a>`
      : `<span class="muted">${licence.ok ? 'The description is too long to send in a link: copy it, and paste it into Commons\' upload form.' : 'No upload link: the map cannot go to Wikimedia Commons as it is.'}</span>`;
    showPreview();
  }

  // ---- The preview, and dragging a label --------------------------------------------------------
  function showPreview() {
    const box = preview.querySelector('#chora-export-preview-map');
    const doc = new DOMParser().parseFromString(composed.out.svg, 'image/svg+xml');
    const svg = document.importNode(doc.documentElement, true);
    svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.setAttribute('class', 'export-preview-svg');
    // In the page, the labels are drawn in the map's own font, as the PNG is.
    for (const t of svg.querySelectorAll('text')) t.setAttribute('font-family', `"PLATO Map Noto Sans", ${t.getAttribute('font-family')}`);
    box.replaceChildren(svg);
  }
  let drag = null;
  preview.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest?.('text[data-place]');
    if (!t || !composed) return;
    const svg = t.ownerSVGElement, l = composed.out.labels.find((x) => x.id === t.dataset.place);
    if (!l) return;
    ev.preventDefault();
    const m = svg.getScreenCTM().inverse(), at = (e) => { const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m); return [p.x, p.y]; };
    drag = { id: l.id, t, start: at(ev), box: l.box, at };
    t.setPointerCapture(ev.pointerId);
  });
  preview.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const [x, y] = drag.at(ev);
    drag.t.setAttribute('transform', `translate(${x - drag.start[0]} ${y - drag.start[1]})`);
  });
  preview.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    const [x, y] = drag.at(ev), d = drag; drag = null;
    const dx = x - d.start[0], dy = y - d.start[1];
    if (Math.hypot(dx, dy) < 1) { d.t.removeAttribute('transform'); return; }
    // The label's place, kept as its box's top left from its point, at this width.
    const item = composed.common.places.find((p) => p.id === d.id);
    const pt = projected(item);
    if (!pt) return;
    labelSet(d.id, { offset: [Math.round(d.box[0] + dx - pt[0]), Math.round(d.box[1] + dy - pt[1])], offsetWidth: settings.width });
  });
  function projected(item) {
    const l = composed.out.labels.find((x) => x.id === item.id);
    return l?.point || null;
  }
  preview.querySelector('#chora-export-close').addEventListener('click', () => { preview.hidden = true; });

  // ---- Changes -----------------------------------------------------------------------------------
  let timer = null;
  const recompose = (now = false) => { clearTimeout(timer); timer = setTimeout(() => { busy = compose(); }, now ? 0 : 250); };
  function labelSet(id, part) {
    settings.labels[id] = { ...(settings.labels[id] || {}), ...part };
    if (part.offset === null) { delete settings.labels[id].offset; delete settings.labels[id].offsetWidth; }
    const li = root.querySelector(`li[data-place="${CSS.escape(id)}"]`);
    if (li) { const p = places.find((x) => x.id === id); li.outerHTML = placeRow(p); }
    recompose(true);
  }
  root.addEventListener('change', (ev) => {
    const t = ev.target, s = settings;
    if (!s) { if (t.id === 'chora-export-remake') remake(t); return; }
    const li = t.closest('li[data-place]');
    if (li) {
      const id = li.dataset.place;
      if (t.matches('[data-tick]')) { s.places[id] = { off: !t.checked }; recompose(); return; }
      if (t.matches('[data-name]')) return labelSet(id, { name: t.value || null });
      if (t.matches('[data-cls]')) return labelSet(id, { cls: t.value });
      if (t.matches('[data-size]')) return labelSet(id, { size: t.value });
      if (t.matches('[data-note]')) return labelSet(id, { note: t.value.trim().slice(0, 60) || null });
      if (t.matches('[data-hide]')) return labelSet(id, { hidden: t.checked });
      return;
    }
    switch (t.id) {
      case 'chora-export-remake': remake(t); return;
      case 'chora-export-modern': s.ne.modern = t.checked; break;
      case 'chora-export-marine': s.ne.marine = t.checked; break;
      case 'chora-export-physical': s.ne.physical = t.checked; break;
      case 'chora-export-relief': s.relief = t.checked; break;
      case 'chora-export-hist': { const e = entryOf(t.value); s.historical = e ? historicalDefaults(e) : null; render(); break; }
      case 'chora-export-statement': s.historical.statement = t.value || null; break;
      case 'chora-export-hist-opacity': s.historical.opacity = Number(t.value); break;
      case 'chora-export-hist-over': s.historical.over = t.value; break;
      case 'chora-export-rule': s.rule = t.value ? { language: t.value } : null; if (t.value) s.lang = t.value; render(); break;
      case 'chora-export-lang': s.lang = t.value.trim() || null; break;
      case 'chora-export-title': s.title = t.value.trim() || s.title; break;
      case 'chora-export-desc': s.description = t.value.trim(); break;
      case 'chora-export-title-on': s.furniture.title = t.checked; break;
      case 'chora-export-north': s.furniture.north = t.checked; break;
      case 'chora-export-inset': s.furniture.inset = t.checked; break;
      case 'chora-export-key': s.furniture.key = t.checked; break;
      case 'chora-export-width': s.width = Math.max(400, Math.min(8000, Math.round(Number(t.value) || 1600))); break;
      case 'chora-export-dpi': s.dpi = Math.max(72, Math.min(1200, Math.round(Number(t.value) || 150))); return;
      case 'chora-export-own': s.licence = t.value; break;
      default: if (t.name === 'chora-export-projection') s.projection = t.value; else return;
    }
    recompose();
  });
  root.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t.id === 'chora-export-open') { open(); return; }
    if (t.matches?.('[data-reset]')) { labelSet(t.closest('li').dataset.place, { offset: null }); return; }
    if (t.id === 'chora-export-preview-open') { preview.hidden = false; return; }
    if (t.id === 'chora-export-copy') { copyPage(); return; }
    if (t.id === 'chora-export-svg') { download('svg'); return; }
    if (t.id === 'chora-export-png') { download('png'); return; }
  });
  async function copyPage() {
    try { await navigator.clipboard.writeText($('page').value); say('The description is copied: paste it into Commons\' upload form.'); }
    catch { $('page').select(); say('Select the description and copy it (Ctrl+C).'); }
  }

  // ---- Downloads ---------------------------------------------------------------------------------
  async function download(format) {
    await busy;
    if (!composed?.licence.ok) return;
    if (!contributors.load()) {
      const c = await ctx.askContributor?.();
      if (!c) { say('A map needs its author: give your name to download it.', true); return; }
      await compose();
    }
    const s = settings, name = commonsName(s.title, format);
    let blob;
    if (format === 'svg') blob = new Blob([composed.out.svg], { type: 'image/svg+xml' });
    else {
      say('Drawing the PNG…');
      const fonts = await cssWithData();
      const withFonts = composeMap({ ...composed.common, fonts });
      const png = await rasterise(withFonts.svg, withFonts.width, withFonts.height);
      const p = page('png');
      blob = new Blob([withMeta(png, { dpi: s.dpi, text: {
        Title: s.title, Author: composed.contributor?.name || '', Description: s.description, Copyright: `${composed.licence.licence.label} (${composed.licence.licence.iri})`,
        Source: p.sources.join('; '), Software: 'PLATO tools, https://pelagios.org/plato-tools/', 'Creation Time': new Date().toISOString(),
        'plato-tools:map': JSON.stringify(composed.common.settings),
      } })], { type: 'image/png' });
    }
    const file = new File([blob], name, { type: blob.type });
    await ctx.saveFile(file, name);
    st.downloads.push({ name, format, size: file.size });
    // In a workflow at its step "Make the map": that step's result, if the dataset open here is the one that went to it.
    const step = await ctx.host?.exported?.([file], ctx.files?.() || null);
    say([`${name} is downloaded (${Math.round(file.size / 1024).toLocaleString('en-GB')} KB).`, step].filter(Boolean).join(' '));
  }
  /** The PNG of an SVG, drawn by the browser at its own size. */
  async function rasterise(svg, w, h) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image(); img.src = url; await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      const out = await new Promise((res) => c.toBlob(res, 'image/png'));
      return new Uint8Array(await out.arrayBuffer());
    } finally { URL.revokeObjectURL(url); }
  }

  // ---- Remaking ----------------------------------------------------------------------------------
  async function remake(input) {
    const f = input.files?.[0]; input.value = '';
    if (!f) return;
    const s = settingsIn(await f.text());
    if (!s || s.version !== SETTINGS_VERSION || !s.view) { say(`${f.name} holds no settings of a map made here, so it cannot be made again.`, true); return; }
    const { made, tools, ...kept } = s;
    await open(kept);
    say(`Made again from ${f.name}'s settings.`);
  }

  return {
    open, close() { preview.hidden = true; $('body').hidden = true; st.open = false; st.phase = 'closed'; settings = null; },
    get settings() { return settings; }, compose: () => compose(), get composed() { return composed; },
    /** A dataset opened or closed: what was made of the one before goes. */
    reset() { preview.hidden = true; $('body').hidden = true; settings = null; composed = null; places = []; pictures = {}; Object.assign(st, { open: false, phase: 'closed', places: null }); },
  };
}
