// The licence of a map made from Chora's view (#37; Stephen's decisions of 14 October 2026), worked out by
// combining the licences of everything the map is made from, read by the one table these tools know
// licences by (src/engine/agora/licence.js: licenceTerms, licenceReasons, attestationLicences):
//   - the user's own drawing and labels: CC BY 4.0 unless they choose another (CC BY-SA 4.0, or CC0);
//   - the background (basemaps.js's `export` field of each preset: { licence: { iri, credit, confirmed },
//     data?, templates?, refused? }), the shaded relief, and a georeferenced historical map (rights.js's
//     reading of its manifest and georeference, or the rights the user states for it);
//   - the sources of the places shown (each attestation's sources, attestationLicences).
// Share-alike anywhere raises the map's licence to CC BY-SA 4.0, and the Commons block says why; credit asked
// anywhere raises CC0 to CC BY 4.0. Data under the ODbL (OpenStreetMap's) is not raised by: a map drawn from
// it is a Produced Work, which may be under any licence, and Commons' {{ODbL OpenStreetMap}} is put beside.
// Refused for Commons, each named with why: a licence these tools do not know (any pasted background among
// them), a rights statement (which grants nothing), no commercial use (NC), no adaptations (ND), and CARTO's
// basemaps (commercial terms). A historical map with no clear licence is used under the rights the user
// states from a short list, recorded as their statement; refused only while nothing is stated. A rights statement
// that says the map is in the public domain (rightsstatements.org NoC-US) is that: {{PD-US}}; one that says no
// copyright is known (NKC) asks the user to state it. The sources of the places that ask for credit are credited,
// by the gazetteer they come from (Pleiades, not the World Historical Gazetteer it was looked up through).
// {{self|…}} is written only for a map wholly the user's own or in the public domain; else the licence's plain
// template, its parts credited in the source.
// Not legal advice: a reading of the licences' terms, as the FAIR report's is. Pure.
import { licenceTerms, licenceReasons, attestationLicences, rightsStatement, sourcesTaken } from '../../agora/licence.js';
import { gazetteerOf } from './places.js';

const CC = 'https://creativecommons.org/';
/** The licences a map may be given, from the least asked of its reuser to the most, each with its Commons template. */
export const MAP_LICENCES = [
  { iri: `${CC}publicdomain/zero/1.0/`, id: 'CC0-1.0', label: 'CC0 1.0', template: 'cc-zero' },
  { iri: `${CC}licenses/by/4.0/`, id: 'CC-BY-4.0', label: 'CC BY 4.0', template: 'cc-by-4.0' },
  { iri: `${CC}licenses/by-sa/4.0/`, id: 'CC-BY-SA-4.0', label: 'CC BY-SA 4.0', template: 'cc-by-sa-4.0' },
];
/** The licence the user's own drawing and labels are given unless they choose another. */
export const OWN_DEFAULT = MAP_LICENCES[1].iri;
export const PD_MARK = `${CC}publicdomain/mark/1.0/`;
/**
 * The rights a user may state for a historical map whose own say nothing clear, as Commons' templates: the
 * map is out of copyright (its author dead over a hundred years), or it is a faithful photograph of such a
 * map, or of a map published more than 120 years ago whose author is not known to have died within the last 70
 * (Commons' {{PD-old-assumed}}); or the licence its manifest gives, taken as it is.
 */
export const STATEMENTS = [
  { key: 'PD-old-100', template: '{{PD-old-100}}', words: "In the public domain: its author died more than 100 years ago ({{PD-old-100}})" },
  { key: 'PD-Art|PD-old-100', template: '{{PD-Art|PD-old-100}}', words: 'A faithful photograph of a map in the public domain, its author dead more than 100 years ({{PD-Art|PD-old-100}})' },
  { key: 'PD-Art|PD-old-assumed', template: '{{PD-Art|PD-old-assumed}}', words: 'A faithful photograph of a map published more than 120 years ago, its author not known to have died within the last 70 ({{PD-Art|PD-old-assumed}})' },
  { key: 'manifest', template: null, words: 'The licence its manifest gives' },
];
/** What the user states by choosing one, where the map's own licence refuses it (Bridgeman v. Corel). */
export const OVERRIDE_WORDS = "By choosing one, you state that the scan is a faithful reproduction of a map in the public domain, which carries no copyright of its own: that overrides the licence its holder states.";
const NOC_US = /^NoC-US\b/, NKC = /^NKC\b/;
/**
 * Whether the user must state a historical map's rights (rights.js rightsOf): when its own do not say it is free
 * to reuse, and when they say only that no copyright is known (rightsstatements.org NKC), which is not a licence
 * and not a statement that it is in the public domain. A map said to be in the public domain in the United States
 * (NoC-US) needs none: it is {{PD-US}}.
 */
export function needsStatement(rights) {
  const st = rightsStatement(rights?.map?.licence || '');
  return rights?.free !== true || (!!st && NKC.test(st));
}
const ODBL = 'ODbL-1.0';

/** The map licence (MAP_LICENCES) of an address, or null. */
const mapLicenceOf = (iri) => MAP_LICENCES.find((l) => licenceTerms(l.iri)?.id === licenceTerms(iri)?.id) || null;
const stricter = (l) => MAP_LICENCES[Math.min(MAP_LICENCES.length - 1, MAP_LICENCES.indexOf(l) + 1)];

/**
 * What one licence (an address) asks of the map, against the map's candidate licence `map` (licenceTerms):
 * { refuse: why, or null; raise: 'sa' | 'attribution' | null }.
 */
function asks(iri, map) {
  if (!iri) return { refuse: 'its licence is not known' };
  const statement = rightsStatement(iri);
  if (statement) return { refuse: `it has a rights statement (${statement}), which is not a licence: it grants nothing` };
  const t = licenceTerms(iri);
  if (!t) return { refuse: `its licence (${iri}) is not one these tools know` };
  if (t.nc) return { refuse: `its licence (${t.id}) allows no commercial use, which Wikimedia Commons does not accept` };
  if (t.nd) return { refuse: `its licence (${t.id}) allows no adaptations, which Wikimedia Commons does not accept` };
  const reasons = licenceReasons(t, map);
  if (reasons.includes('sa') && t.id !== ODBL) return { raise: 'sa', terms: t };
  if (reasons.includes('attribution')) return { raise: 'attribution', terms: t };
  return { terms: t };
}

/**
 * The licence of the map. `own`: the address of the licence the user chose for their own drawing and labels
 * (one of MAP_LICENCES; OWN_DEFAULT unless chosen). `parts`: what it is made from, each { name, role
 * ('background' | 'relief' | 'historical'), licence: { iri, credit } | null, data?: { iri, credit } (a
 * licence its data is under, apart from its look: OpenStreetMap's ODbL), refused?: why (CARTO's terms),
 * templates?: Commons templates it carries ({{Natural Earth}}) }; a historical map's { rights (rights.js
 * rightsOf), statement?: a STATEMENTS key the user chose, statedBy?: their name } in place of `licence`.
 * `places`: [{ label, attestations }], the places shown, with the attestations their sources are read from.
 *
 * Returns { ok, licence: MAP_LICENCES's entry, raised: [{ to, by, why }] (why it is not the user's own),
 * refused: [{ name, why }], templates: the Commons templates beside the licence, credits: [words] (of the parts),
 * placeCredits: [words] (the places' sources that ask for credit, placeCredits), statements: [words] (the rights
 * the user stated), words: the verdict in words, self: whether the map is wholly its maker's own or in the public
 * domain (then {{self|…}}) }.
 */
export function composeLicence({ own = OWN_DEFAULT, parts = [], places = [] } = {}) {
  let chosen = mapLicenceOf(own) || mapLicenceOf(OWN_DEFAULT);
  const refused = [], templates = [], credits = [], statements = [];
  const addTemplate = (t) => { if (t && !templates.includes(t)) templates.push(t); };
  // Each thing the map takes something from, as { name, iri }: the licence it is read against.
  const subjects = [];
  let others = false;   // whether anything in it is someone else's under a licence (not the public domain): then no {{self}}
  for (const p of parts) {
    if (p.refused) { refused.push({ name: p.name, why: p.refused }); continue; }
    for (const t of p.templates || []) addTemplate(t);
    if (p.role === 'historical') {
      const r = p.rights || {};
      const mapIri = r.map?.licence || null, st = rightsStatement(mapIri || '');
      if (r.map?.credit) credits.push(`${p.name}: ${r.map.credit}`);
      if (!needsStatement(r) && st && NOC_US.test(st)) addTemplate('{{PD-US}}');   // in the public domain, as its holder says
      else if (!needsStatement(r)) subjects.push({ name: p.name, iri: mapIri });
      else if (!p.statement) {
        refused.push({ name: p.name, why: r.free === false
          ? `its licence (${r.map?.licenceLabel || mapIri}) does not let it go to Wikimedia Commons; if the map itself is in the public domain, state its rights: a faithful scan of it overrides the licence its holder states`
          : `its rights are not clear (${r.words || 'its manifest names no licence'}), and none are stated: say what they are` });
      }
      else {
        const s = STATEMENTS.find((x) => x.key === p.statement);
        if (!s) refused.push({ name: p.name, why: `"${p.statement}" is not one of the rights that can be stated` });
        else if (s.key === 'manifest') { subjects.push({ name: p.name, iri: mapIri }); statements.push(`The rights of ${p.name} are stated${p.statedBy ? ` by ${p.statedBy}` : ''} to be the licence its manifest gives (${r.map?.licenceLabel || mapIri || 'none'}).`); }
        else { addTemplate(s.template); statements.push(`The rights of ${p.name} are stated${p.statedBy ? ` by ${p.statedBy}` : ''}: ${s.words}.`); }
      }
      // The georeference that places it is a work of its own (Allmaps': CC0).
      const g = r.georeference;
      if (g) subjects.push({ name: `the georeference of ${p.name}`, iri: g.licence || null });
      continue;
    }
    subjects.push({ name: p.name, iri: p.licence?.iri || null });
    if (p.licence?.iri && !licenceTerms(p.licence.iri)?.pd) others = true;
    if (p.licence?.credit) credits.push(`${p.name}: ${p.licence.credit}`);
    if (p.data) {
      if (licenceTerms(p.data.iri)?.id === ODBL) addTemplate('{{ODbL OpenStreetMap}}');
      else subjects.push({ name: `the data of ${p.name}`, iri: p.data.iri });
      if (p.data.credit) credits.push(`${p.name}'s data: ${p.data.credit}`);
    }
  }
  // The licence: raised, one step at a time, until nothing asks for more (at most twice: CC0, CC BY, CC BY-SA).
  const raised = [];
  for (let round = 0; round < MAP_LICENCES.length; round++) {
    const map = licenceTerms(chosen.iri);
    let raise = null;
    for (const s of subjects) {
      const a = asks(s.iri, map);
      if (a.raise && (!raise || a.raise === 'sa')) raise = { by: s.name, kind: a.raise, terms: a.terms };
    }
    for (const pl of places) for (const att of pl.attestations || []) {
      const { reasons } = attestationLicences(att, map);
      for (const [r, { licence, source }] of reasons) {
        if ((r === 'sa' && licence !== ODBL) || r === 'attribution') { if (!raise || r === 'sa') raise = { by: `${source || 'a source'} (of ${pl.label})`, kind: r, terms: { id: licence } }; }
      }
    }
    if (!raise) break;
    const to = raise.kind === 'sa' ? MAP_LICENCES[2] : stricter(chosen);
    if (to === chosen) break;
    raised.push({ to: to.label, by: raise.by, why: raise.kind === 'sa' ? `${raise.by} is under ${raise.terms.id}, which is share-alike: what is made from it must be shared alike, so the map is ${to.label}` : `${raise.by} is under ${raise.terms.id}, which asks for credit, so the map cannot be CC0: it is ${to.label}` });
    chosen = to;
  }
  // What is refused, against the licence as it ended.
  const map = licenceTerms(chosen.iri);
  for (const s of subjects) { const a = asks(s.iri, map); if (a.refuse) refused.push({ name: s.name, why: a.refuse }); }
  const seen = new Set();
  for (const pl of places) for (const att of pl.attestations || []) {
    const { reasons } = attestationLicences(att, map);
    for (const [r, { licence, source }] of reasons) {
      if (r === 'sa' && licence === ODBL) { addTemplate('{{ODbL OpenStreetMap}}'); continue; }
      const why = r === 'nc' ? `it is under ${licence}, which allows no commercial use` : r === 'nd' ? `it is under ${licence}, which allows no adaptations`
        : r === 'rights-statement' ? `it has a ${licence}, which is not a licence` : r === 'unknown' ? `its licence (${licence}) is not one these tools know` : null;
      if (!why) continue;
      const name = `${source || 'a source'}, cited for ${pl.label}`;
      if (!seen.has(name + why)) { seen.add(name + why); refused.push({ name, why }); }
    }
  }
  // The places' sources that ask for credit, credited by the gazetteer they come from.
  const credited = placeCredits(places).map((c) => c.words);
  if (credited.length) others = true;
  for (const s of subjects) { const t = licenceTerms(s.iri); if (t && !t.pd) others = true; }
  const ok = refused.length === 0;
  const words = ok
    ? `The map can be shared under ${chosen.label}${raised.length ? ` (${raised.map((r) => r.why).join('; ')})` : ''}.`
    : `The map cannot go to Wikimedia Commons as it is: ${refused.map((r) => `${r.name}: ${r.why}`).join('; ')}.`;
  return { ok, licence: chosen, raised, refused, templates, credits, placeCredits: credited, statements, words, self: !others };
}

/** A licence's short name: CC BY 3.0, CC BY-SA 4.0, ODbL-1.0. */
const shortName = (t) => { const m = /^CC-(.+)-(\d\.\d)$/.exec(t.id); return m ? `CC ${m[1]} ${m[2]}` : t.id; };
/**
 * The sources of the places that ask for credit (a licence with BY), each once: [{ name, licence, words }]. A
 * source the places were looked up through (the World Historical Gazetteer, whose records carry the upstream
 * gazetteer's licence) is named by the gazetteer its record is of, from the record's address (the citation's
 * locator): "Pleiades (CC BY 3.0), through the World Historical Gazetteer".
 */
export function placeCredits(places) {
  const out = new Map();
  for (const pl of places || []) for (const a of pl.attestations || []) {
    const cited = (a.citations || []).filter((c) => c?.source && typeof c.source === 'object');
    for (const { source } of sourcesTaken(a)) {
      const t = licenceTerms(source.licence || '');
      if (!t?.by) continue;
      const title = typeof source.title === 'string' && source.title ? source.title : 'a source';
      const locator = cited.find((c) => c.source === source)?.locator;
      const upstream = typeof locator === 'string' ? gazetteerOf(locator) : null;
      const through = upstream && upstream !== title && /World Historical Gazetteer/i.test(title);
      const name = through ? upstream : title;
      const words = `${name} (${shortName(t)})${through ? `, through the ${title}` : ''}`;
      if (!out.has(words)) out.set(words, { name, licence: t.id, words });
    }
  }
  return [...out.values()];
}

/**
 * The rights to pre-select for a historical map (rights.js rightsOf), from the year its manifest dates it (its
 * navDate): a faithful photograph of a map published more than 120 years before `now`, its author not known to
 * have died within the last 70 ({{PD-Art|PD-old-assumed}}, Commons' rule for such a work); else none. Only where
 * its rights say nothing either way (free === null): a map its holder licenses for no commercial use (free ===
 * false) is never pre-selected, so that the refusal stays until the user chooses to state otherwise. Only
 * pre-selected: the statement is the user's.
 */
export function suggestedStatement(rights, year, now = new Date().getUTCFullYear()) {
  if (rights?.free !== null) return null;
  return Number.isFinite(year) && year <= now - 120 ? 'PD-Art|PD-old-assumed' : null;
}
