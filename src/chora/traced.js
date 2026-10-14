// Tracing a historical map into a new dataset, in Chora (Stephen's decisions of 14 October 2026): what is
// kept of each map's settings, the dataset made from the map (its seed), the forms the page shows, and the
// new places a save adds, one for each feature traced. app.js wires them to the page; nothing here touches
// the DOM, so that the save's part is tested in Node (test/chora-traced.test.js).
//
// A feature traced is a draft of its own kind ('feature'): { id, kind: 'feature', placeId (its address,
// minted once it is named), placeLabel, names, types, part (a geometry added to a place named before, as its
// label's position), mapKey, geojson, role, precision, precisionKm, defaulted, trace, zoom, drawnAt }.
import { seedDataset, seedName, featureAttestation, newPlaceRecord, kindType, KINDS, TRACED_DEFAULTS, shapeOf, scriptOf, mapTimespan, navDateWords } from '../engine/chora/seed.js';
import { featureParts } from '../engine/chora/trace.js';
import { manifestNavDate } from '../engine/georef/index.js';
import { normaliseBase } from '../engine/agora/address.js';
import { ROLES, PRECISIONS } from '../engine/chora/draw.js';
import { choraDrawingNote, choraTracedRadiusNote, CHORA_TRACE } from '../engine/words.js';
import { esc, ROLE_WORDS } from './card.js';

// ---- What is kept ------------------------------------------------------------------------------------
// One record in this browser (localStorage 'chora-trace', working data: gone at the start when the user
// keeps none, as the drawings are): each map's settings by Chora's map key (overlays.js keyOf); the dataset
// made from each map until it is first saved (its text, so that the very file, and the drawings kept under
// its fingerprint, can be opened again); which map each dataset open is traced from, by the fingerprint of
// its files (drafts.js); and the map traced last.
const KEY = 'chora-trace';
const empty = () => ({ maps: {}, seeds: {}, open: {}, current: null });
/** What is kept of the tracings, checked as it is read: anything not of its shape is dropped. */
export function loadTracing() {
  let t;
  try { t = JSON.parse(localStorage.getItem(KEY)); } catch { return empty(); }
  if (!t || typeof t !== 'object') return empty();
  const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
  const out = empty();
  for (const [k, s] of Object.entries(obj(t.maps))) { const c = checked(s); if (c) out.maps[k] = c; }
  for (const [k, s] of Object.entries(obj(t.seeds))) if (s && typeof s.name === 'string' && typeof s.text === 'string' && Number.isFinite(s.lastModified)) out.seeds[k] = { name: s.name, text: s.text, lastModified: s.lastModified };
  for (const [fp, k] of Object.entries(obj(t.open))) if (typeof k === 'string') out.open[fp] = k;
  out.current = typeof t.current === 'string' ? t.current : null;
  return out;
}
export function saveTracing(t) { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* storage refused: kept for the tab only */ } }
export function forgetTracing() { try { localStorage.removeItem(KEY); } catch { /* none kept */ } }

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const role = (r) => (ROLES.includes(r) ? r : '');
const precision = (p) => (PRECISIONS.includes(p) ? p : '');
/** A map's settings, checked: each field what it says, or its default. Null for what is not settings at all. */
function checked(s) {
  if (!s || typeof s !== 'object' || typeof s.key !== 'string') return null;
  const d = s.defaults && typeof s.defaults === 'object' ? s.defaults : {};
  const shape = (k) => ({ role: role(d[k]?.role) || TRACED_DEFAULTS[k].role, precision: precision(d[k]?.precision) || TRACED_DEFAULTS[k].precision });
  return {
    key: s.key, mapTitle: str(s.mapTitle), base: normaliseBase(s.base) || '', datasetTitle: str(s.datasetTitle), date: str(s.date, 200), dateEach: s.dateEach !== false,
    language: str(s.language, 40), script: /^[A-Z][a-z]{3}$/.test(s.script) ? s.script : '', defaults: { point: shape('point'), line: shape('line'), area: shape('area') },
    precisionKm: Number.isFinite(s.precisionKm) && s.precisionKm >= 0 ? s.precisionKm : null, lastKind: str(s.lastKind, 200), outline: s.outline !== false,
    licence: /^https?:\/\/\S+$/.test(s.licence || '') ? s.licence : null, credit: str(s.credit) || null, rightsWords: str(s.rightsWords) || null,
  };
}

/** A map's settings before the user has given any: from the map (its title, its navDate, its rights), with the base address in Options. */
export function defaultSettings({ key, title, manifest, rights, base }) {
  return checked({
    key, mapTitle: title || '', base: base || '', datasetTitle: `Places traced from ${title || 'a historical map'}`, date: navDateWords(manifestNavDate(manifest)), dateEach: true,
    language: '', script: '', defaults: TRACED_DEFAULTS, precisionKm: null, lastKind: '', outline: true,
    licence: rights?.map?.licence || null, credit: rights?.map?.credit || null, rightsWords: rights?.words || null,
  });
}

/**
 * The settings form's values (`v`, as the page reads them: strings, and booleans for its boxes) made a map's
 * settings, from `was`: { settings } or { error } in words. The base address is needed (decision 8).
 */
export function settingsFrom(v, was) {
  const base = normaliseBase(String(v.base || '').trim());
  if (!base) return { error: CHORA_TRACE.needBase };
  const language = String(v.language || '').trim();
  if (language && !/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/.test(language)) return { error: CHORA_TRACE.badLanguage(language) };
  const km = String(v.precisionKm ?? '').trim();
  if (km && !(Number.isFinite(+km) && +km >= 0)) return { error: CHORA_TRACE.badRadius };
  const shape = (k) => ({ role: role(v[`${k}Role`]) || TRACED_DEFAULTS[k].role, precision: precision(v[`${k}Precision`]) || TRACED_DEFAULTS[k].precision });
  return { settings: checked({ ...was, base, datasetTitle: String(v.datasetTitle || '').trim() || was.datasetTitle, date: String(v.date || '').trim(), dateEach: !!v.dateEach,
    language, script: scriptOf(language) ? String(v.script || '') : '', defaults: { point: shape('point'), line: shape('line'), area: shape('area') },
    precisionKm: km ? +km : null, outline: !!v.outline }) };
}

/** The dataset a tracing begins with, as a file: from the map's settings (seed.js seedDataset), named for the map. */
export function seedFile(settings, { now = Date.now() } = {}) {
  const text = JSON.stringify(seedDataset({ mapTitle: settings.mapTitle, title: settings.datasetTitle, base: settings.base }), null, 2) + '\n';
  return { name: seedName(settings.mapTitle), text, lastModified: now };
}

// ---- What a new feature is taken to be ------------------------------------------------------------------
/** The role and precision a feature traced is given until the user says otherwise: the map's, by its shape, marked as defaulted. */
export function featureDefaults(settings, geojson) {
  const d = settings?.defaults?.[shapeOf(geojson)] || TRACED_DEFAULTS[shapeOf(geojson)];
  return { role: d.role, precision: d.precision, defaulted: true, ...(Number.isFinite(settings?.precisionKm) ? { precisionKm: settings.precisionKm, radiusMine: true } : {}) };
}
/**
 * A drawing added to a place named before ("Add to … instead"): a point is taken to be where the map writes the
 * place's name (a label anchor, decision 4), with no precision, until the user says otherwise; a line or an area
 * keeps the map's defaults for its shape.
 */
export const addedPart = (geojson) => (/Point$/.test(geojson?.type) ? { role: 'LabelAnchor', precision: '', defaulted: true } : {});
/** The name given in the form, made a PLATO name: the toponym as written, its language and script, its romanised form. */
export function nameOf({ toponym, language, script, romanized }) {
  const t = String(toponym || '').trim();
  const out = { toponym: t };
  if (String(language || '').trim()) out.language = String(language).trim();
  if (script && /^[A-Z][a-z]{3}$/.test(script)) out.script = script;
  if (String(romanized || '').trim()) out.romanized = String(romanized).trim();
  return out;
}

// ---- What a save adds -----------------------------------------------------------------------------------
/**
 * The new places of the features traced (`drafts`, of kind 'feature'), one for each place named: its
 * address, its label, and one attestation (decision 4) with its names, every geometry drawn for it (the
 * first is the one it was named from, then those added to it, a label's position among them), its kind, the
 * map's date (when the map's settings date each place by it), the map cited and how it was traced
 * (featureParts), or, drawn on the basemap, Chora's drawing note. `settingsOf(key)` gives a map's settings;
 * `contributor`, `version` as the save has them. Returns { newPlaces, unnamed: the drafts not yet named }.
 * Throws DrawError, in words, for anything PLATO would not accept.
 */
export function newPlacesOf(drafts, { settingsOf = () => null, contributor, version } = {}) {
  const features = drafts.filter((d) => d.kind === 'feature');
  const unnamed = features.filter((d) => !d.placeId);
  const groups = new Map();
  for (const d of features) if (d.placeId) (groups.get(d.placeId) || groups.set(d.placeId, []).get(d.placeId)).push(d);
  const newPlaces = [];
  for (const [id, list] of groups) {
    const main = list.find((d) => !d.part) || list[0];
    const parts = [main, ...list.filter((d) => d !== main)];
    const s = settingsOf(main.mapKey) || {};
    const date = mapTimespan(s.date);
    // Each part's map cited with that map's own credit and date, by the key it was traced from: never another sheet's.
    const sourceOf = (t) => { const own = settingsOf(t.key); return own ? { credit: own.credit || null, timespan: mapTimespan(own.date) } : null; };
    const traced = featureParts(parts.map((p) => ({ trace: p.trace, role: p.role, geometry: p.geojson, zoom: p.zoom })), { version, sourceOf });
    const radius = parts.find((p) => p.radiusMine && Number.isFinite(p.precisionKm));
    // Chora's drawing note has no full stop of its own (words.js): one is put before a sentence after it.
    const how = traced ? traced.notes : choraDrawingNote({ basemap: main.basemap, zoom: main.zoom });
    const notes = radius ? `${how}${/[.!?]$/.test(how) ? '' : '.'} ${choraTracedRadiusNote(radius.precisionKm)}` : how;
    const a = featureAttestation({
      geometries: parts.map((p) => ({ geojson: p.geojson, role: p.role || undefined, precision: p.precision || undefined, precisionKm: Number.isFinite(p.precisionKm) ? p.precisionKm : undefined })),
      names: main.names || [], types: main.types || [], timespan: s.dateEach !== false ? date : null,
      contributor, created: main.drawnAt, ...(traced ? { citations: traced.citations } : {}), notes,
    });
    newPlaces.push(newPlaceRecord({ id, label: main.placeLabel || main.names?.[0]?.toponym || id, attestations: [a] }));
  }
  return { newPlaces, unnamed };
}

// ---- The page's words and forms -------------------------------------------------------------------------
const opt = (vals, cur, words) => vals.map((x) => `<option value="${esc(x)}"${x === cur ? ' selected' : ''}>${esc(words(x))}</option>`).join('');
const roleWords = (r) => (r === 'LabelAnchor' ? 'where the map writes its name' : ROLE_WORDS[r] || r);
const SHAPES = [['point', 'Points'], ['line', 'Lines'], ['area', 'Areas']];
/** The datalist of the kinds offered (seed.js KINDS), for the name form's kind field. */
export const kindsList = (id) => `<datalist id="${id}">${KINDS.map((k) => `<option value="${esc(k.label)}"></option>`).join('')}</datalist>`;
const SCRIPT_NAMES = { Arab: 'Arabic', Hebr: 'Hebrew', Grek: 'Greek', Cyrl: 'Cyrillic', Cyrs: 'Old Church Slavonic Cyrillic', Hani: 'Chinese characters', Jpan: 'Japanese', Kore: 'Korean', Deva: 'Devanagari',
  Beng: 'Bengali', Guru: 'Gurmukhi', Gujr: 'Gujarati', Orya: 'Odia', Taml: 'Tamil', Telu: 'Telugu', Knda: 'Kannada', Mlym: 'Malayalam', Sinh: 'Sinhala', Thai: 'Thai', Laoo: 'Lao', Khmr: 'Khmer',
  Mymr: 'Burmese', Tibt: 'Tibetan', Geor: 'Georgian', Armn: 'Armenian', Ethi: 'Ethiopic', Syrc: 'Syriac', Armi: 'Aramaic', Goth: 'Gothic', Phnx: 'Phoenician', Ugar: 'Ugaritic', Egyp: 'Egyptian hieroglyphs',
  Xsux: 'cuneiform', Xpeo: 'Old Persian cuneiform', Phli: 'Pahlavi', Sogd: 'Sogdian', Orkh: 'Old Turkic', Thaa: 'Thaana', Copt: 'Coptic', Linb: 'Linear B' };
export const scriptName = (s) => SCRIPT_NAMES[s] || s;
/** The choice of script for names in a language that implies one other than Latin (decision 3: asked only then). */
export function scriptChoice(id, language, chosen) {
  const implied = scriptOf(language);
  if (!implied) return '';
  return `<label for="${id}">${esc(CHORA_TRACE.scriptQuestion)}</label><select id="${id}">${opt([implied, 'Latn'], chosen || implied, (s) => (s === 'Latn' ? CHORA_TRACE.latinScript : `${scriptName(s)} (${s})`))}</select>`;
}

/**
 * The settings form for tracing the map `s` (its settings), in Chora's panel: the base address (needed; fixed
 * once places have addresses under it), the dataset's title, the map's date and whether each place is dated by
 * it, the language of the names (the script where it implies one), the defaults for points, lines and areas,
 * an uncertainty radius of the user's own, and in a workflow that looks the places up, the outline as its Scope.
 */
export function settingsForm(s, { started = false, identify = false, fileTitle = null } = {}) {
  const shapes = SHAPES.map(([k, words]) => `<fieldset class="trace-shape" data-shape="${k}"><legend>${esc(words)}</legend>
      <label>What it marks <select id="chora-tset-${k}-role">${opt(ROLES.filter((r) => r !== 'LabelAnchor'), s.defaults[k].role, roleWords)}</select></label>
      <label>How well known <select id="chora-tset-${k}-precision">${opt(PRECISIONS, s.defaults[k].precision, (p) => p.replace('_', ' '))}</select></label></fieldset>`).join('');
  return `<form id="chora-trace-form" novalidate>
    <p class="trace-map">${esc(CHORA_TRACE.settingsFor(s.mapTitle))}</p>
    ${s.rightsWords ? `<p class="${/^Free to reuse/.test(s.rightsWords) ? 'muted' : 'note'}" id="chora-trace-rights">${esc(s.rightsWords)}</p>` : ''}
    <label for="chora-tset-base">${esc(CHORA_TRACE.baseQuestion)}</label>
    <input id="chora-tset-base" type="url" required aria-required="true" autocomplete="url" spellcheck="false" value="${esc(s.base)}"${started ? ' readonly aria-describedby="chora-tset-base-fixed"' : ' aria-describedby="chora-tset-base-help"'}>
    <p class="muted" id="${started ? 'chora-tset-base-fixed' : 'chora-tset-base-help'}">${esc(started ? CHORA_TRACE.baseFixed : CHORA_TRACE.baseHelp)}</p>
    <label for="chora-tset-title">${esc(CHORA_TRACE.titleQuestion)}</label>
    <input id="chora-tset-title" value="${esc(started && fileTitle ? fileTitle : s.datasetTitle)}" autocomplete="off"${started ? ' readonly aria-describedby="chora-tset-title-fixed"' : ''}>
    ${started ? `<p class="muted" id="chora-tset-title-fixed">${esc(CHORA_TRACE.titleFixed)}</p>` : ''}
    <label for="chora-tset-date">${esc(CHORA_TRACE.dateQuestion)}</label>
    <input id="chora-tset-date" value="${esc(s.date)}" autocomplete="off" placeholder="1764" aria-describedby="chora-tset-date-help">
    <p class="muted" id="chora-tset-date-help">${esc(CHORA_TRACE.dateHelp)}</p>
    <label><input type="checkbox" id="chora-tset-date-each"${s.dateEach ? ' checked' : ''}> ${esc(CHORA_TRACE.dateEach)}</label>
    <label for="chora-tset-lang">${esc(CHORA_TRACE.languageQuestion)}</label>
    <input id="chora-tset-lang" value="${esc(s.language)}" autocomplete="off" spellcheck="false" placeholder="en" aria-describedby="chora-tset-lang-help">
    <p class="muted" id="chora-tset-lang-help">${esc(CHORA_TRACE.languageHelp)}</p>
    <div id="chora-tset-script-box">${scriptChoice('chora-tset-script', s.language, s.script)}</div>
    <details class="trace-defaults"><summary>${esc(CHORA_TRACE.defaultsSummary)}</summary>
      <p class="muted">${esc(CHORA_TRACE.defaultsHelp)}</p>${shapes}
      <label for="chora-tset-km">${esc(CHORA_TRACE.radiusQuestion)}</label>
      <input id="chora-tset-km" inputmode="decimal" value="${s.precisionKm ?? ''}" autocomplete="off" aria-describedby="chora-tset-km-help">
      <p class="muted" id="chora-tset-km-help">${esc(CHORA_TRACE.radiusHelp)}</p>
    </details>
    ${identify ? `<label><input type="checkbox" id="chora-tset-outline"${s.outline ? ' checked' : ''}> ${esc(CHORA_TRACE.outlineQuestion)}</label>` : ''}
    <p id="chora-tset-error" class="warn" hidden></p>
    <p><button class="primary" type="submit">${esc(started ? CHORA_TRACE.keepSettings : CHORA_TRACE.begin)}</button> <button type="button" id="chora-tset-cancel">Cancel</button></p>
  </form>`;
}

/** One feature traced, in the list of those traced: its name (or that it is not named yet), its kind and shape, what it marks and how well. */
export function tracedItem(d, { partOf = null } = {}) {
  const shape = { Point: 'A point', MultiPoint: 'Points', LineString: 'A line', MultiLineString: 'Lines', Polygon: 'An area', MultiPolygon: 'Areas' }[d.geojson.type] || d.geojson.type;
  const roles = ROLES.filter((r) => r !== 'LabelAnchor' || d.geojson.type === 'Point');
  const name = d.part ? CHORA_TRACE.partOf(partOf || d.placeLabel || '') : d.placeId ? d.placeLabel || d.names?.[0]?.toponym || '' : null;
  return `<li data-draft="${esc(d.id)}"${d.placeId ? '' : ' data-unnamed'}>
    ${name !== null ? `<button type="button" class="link traced-name" data-show>${esc(name)}</button>` : `<span class="warn">${esc(CHORA_TRACE.notNamed)}</span> <button type="button" data-name>${esc(CHORA_TRACE.nameIt)}</button>`}
    <span class="muted">${esc([d.types?.[0]?.label, shape].filter(Boolean).join(' · '))}${d.trace ? '' : ` · ${esc(CHORA_TRACE.notTraced)}`}</span>
    <label>What it marks <select data-field="role"><option value="">Not said</option>${opt(roles, d.role, roleWords)}</select></label>
    <label>How well known <select data-field="precision"><option value="">Not said</option>${opt(PRECISIONS, d.precision, (p) => p.replace('_', ' '))}</select></label>
    ${d.defaulted ? `<span class="muted" data-defaulted>${esc(CHORA_TRACE.defaulted)}</span>` : ''}
    ${d.radiusMine ? `<span class="muted" data-radius>${esc(CHORA_TRACE.radiusMine(d.precisionKm))}</span>` : ''}
    ${d.traceNote ? `<span class="note" data-trace-note>${esc(d.traceNote)}</span>` : ''}
    ${d.placeId && !d.part ? `<button type="button" data-edit>${esc(CHORA_TRACE.edit)}</button>` : ''} <button type="button" data-remove>Remove</button></li>`;
}

/**
 * The name form, over the map: the name as the map writes it, the place's label (a display form, not evidence,
 * the name until changed), its kind (the last chosen kept), the name's language (the map's, editable here), its
 * script where the language implies one, and a romanised form. `addTo` names the place a drawing may be added to
 * instead (the last named), `editing` the feature whose names are changed.
 */
export function nameForm({ what, toponym = '', label = '', kind = '', language = '', script = '', romanized = '', addTo = null, editing = false }) {
  const scriptBox = scriptChoice('chora-name-script', language, script);
  const roman = scriptOf(language) && script !== 'Latn';
  return `<form id="chora-name-form" novalidate>
    <p class="name-what" id="chora-name-what">${esc(what)}</p>
    <label for="chora-name-toponym">${esc(CHORA_TRACE.toponymQuestion)}</label>
    <input id="chora-name-toponym" value="${esc(toponym)}" autocomplete="off" spellcheck="false" required aria-required="true">
    <label for="chora-name-label">${esc(CHORA_TRACE.labelQuestion)} <small>${esc(CHORA_TRACE.labelHelp)}</small></label>
    <input id="chora-name-label" value="${esc(label)}" autocomplete="off" placeholder="${esc(CHORA_TRACE.labelPlaceholder)}">
    <label for="chora-name-kind">${esc(CHORA_TRACE.kindQuestion)} <small>(optional)</small></label>
    <input id="chora-name-kind" value="${esc(kind)}" list="chora-kinds" autocomplete="off">${kindsList('chora-kinds')}
    <label for="chora-name-lang">${esc(CHORA_TRACE.nameLanguage)}</label>
    <input id="chora-name-lang" value="${esc(language)}" autocomplete="off" spellcheck="false" placeholder="en">
    <div id="chora-name-script-box">${scriptBox}</div>
    <div id="chora-name-roman-box"${roman ? '' : ' hidden'}><label for="chora-name-romanized">${esc(CHORA_TRACE.romanizedQuestion)} <small>(optional)</small></label>
    <input id="chora-name-romanized" value="${esc(romanized)}" autocomplete="off" spellcheck="false"></div>
    <p id="chora-name-error" class="warn" hidden></p>
    <p class="name-buttons"><button class="primary" type="submit">${esc(editing ? CHORA_TRACE.saveName : CHORA_TRACE.addPlace)}</button>
    ${addTo && !editing ? `<button type="button" id="chora-name-to">${esc(CHORA_TRACE.addTo(addTo))}</button>` : ''}
    <button type="button" id="chora-name-cancel">${esc(editing ? 'Cancel' : CHORA_TRACE.discard)}</button></p>
  </form>`;
}
export { kindType };
