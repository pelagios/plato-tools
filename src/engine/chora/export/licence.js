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
// states from a short list, recorded as their statement; refused only while nothing is stated.
// Not legal advice: a reading of the licences' terms, as the FAIR report's is. Pure.
import { licenceTerms, licenceReasons, attestationLicences, rightsStatement } from '../../agora/licence.js';

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
 * map; or the licence its manifest gives, taken as it is.
 */
export const STATEMENTS = [
  { key: 'PD-old-100', template: '{{PD-old-100}}', words: "In the public domain: its author died more than 100 years ago ({{PD-old-100}})" },
  { key: 'PD-Art|PD-old-100', template: '{{PD-Art|PD-old-100}}', words: 'A faithful photograph of a map in the public domain, its author dead more than 100 years ({{PD-Art|PD-old-100}})' },
  { key: 'manifest', template: null, words: 'The licence its manifest gives' },
];
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
 * refused: [{ name, why }], templates: the Commons templates beside the licence, credits: [words], statements:
 * [words] (the rights the user stated), words: the verdict in words }.
 */
export function composeLicence({ own = OWN_DEFAULT, parts = [], places = [] } = {}) {
  let chosen = mapLicenceOf(own) || mapLicenceOf(OWN_DEFAULT);
  const refused = [], templates = [], credits = [], statements = [];
  const addTemplate = (t) => { if (t && !templates.includes(t)) templates.push(t); };
  // Each thing the map takes something from, as { name, iri }: the licence it is read against.
  const subjects = [];
  for (const p of parts) {
    if (p.refused) { refused.push({ name: p.name, why: p.refused }); continue; }
    for (const t of p.templates || []) addTemplate(t);
    if (p.role === 'historical') {
      const r = p.rights || {};
      const mapIri = r.map?.licence || null;
      if (r.map?.credit) credits.push(`${p.name}: ${r.map.credit}`);
      if (r.free === true) subjects.push({ name: p.name, iri: mapIri });
      else if (!p.statement) refused.push({ name: p.name, why: `its rights are not clear (${r.words || 'its manifest names no licence'}), and none are stated: say what they are` });
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
  const ok = refused.length === 0;
  const words = ok
    ? `The map can be shared under ${chosen.label}${raised.length ? ` (${raised.map((r) => r.why).join('; ')})` : ''}.`
    : `The map cannot go to Wikimedia Commons as it is: ${refused.map((r) => `${r.name}: ${r.why}`).join('; ')}.`;
  return { ok, licence: chosen, raised, refused, templates, credits, statements, words };
}

/**
 * The rights to pre-select for a historical map whose own are not clear, from the year its manifest dates it
 * (navDate, or a date in its label): a faithful photograph of a map in the public domain, for a map made more
 * than 120 years before `now` (Commons' own rule of thumb for a work whose author is not known); else none,
 * for the user to choose. Only pre-selected: the statement is the user's.
 */
export function suggestedStatement(year, now = new Date().getUTCFullYear()) {
  return Number.isFinite(year) && year <= now - 120 ? 'PD-Art|PD-old-100' : null;
}
