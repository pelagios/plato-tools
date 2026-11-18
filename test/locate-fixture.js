// What the tests of the matched places' locations share (test/chora-locate.test.js, test/methodos-locate.test.js): a
// dataset of eleven places on a bay, the review of its lookup in the World Historical Gazetteer (a work file, with the
// sources' licences in the lookup's attribution), and that dataset with the review's decisions recorded by Krisis's own
// Finish (apply()). Nothing here asks any service anything.
import assert from 'node:assert/strict';
import { env, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { apply } from '../src/engine/krisis/apply.js';
import { WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';

export const P = 'https://example.org/places/';
export const W3 = 'https://w3id.org/whg/id/';
export const WHO = { name: 'Ada Surveyor' };
export const AT = '2026-11-18T12:00:00Z', DECIDED = '2026-11-17T10:00:00Z';
const hex = (c) => c.repeat(64);

// The sources' licences, as a lookup's answer gives them: GeoNames and OpenStreetMap say theirs; "tgn" may not
// be passed on; "wd" is named with no licence (not stated).
export const ATTRIBUTION = {
  whg: { name: 'World Historical Gazetteer', license: { spdx_id: 'CC-BY-4.0', permits_commercial: true, no_derivatives: false } },
  sources: {
    gn: { name: 'GeoNames', license: { spdx_id: 'CC-BY-4.0', permits_commercial: true, no_derivatives: false }, redistributable: true },
    osm: { name: 'OpenStreetMap', license: { spdx_id: 'ODbL-1.0', permits_commercial: true, no_derivatives: false }, redistributable: true },
    tgn: { name: 'A source that may not be passed on', license: { spdx_id: 'CC-BY-NC-4.0', permits_commercial: false, no_derivatives: null }, redistributable: false },
    wd: { name: 'A source with no licence stated' },
  },
};
// Each place, the record(s) accepted for it, and what should come of it.
export const ROWS = [
  { slug: 'gdansk', label: 'Gdańsk', cands: [{ ns: 'gn', n: 1, point: [18.6466384, 54.3520252], type: 'exactMatch' }] },                 // used
  { slug: 'oliva', label: 'Oliva', cands: [{ ns: 'gn', n: 2, point: [18.56, 54.41], type: 'closeMatch' }] },                              // used; stays a close match
  { slug: 'sopot', label: 'Sopot', cands: [{ ns: 'tgn', n: 3, point: [18.56, 54.44], type: 'exactMatch' }] },                             // may not be passed on
  { slug: 'hel', label: 'Hel', cands: [{ ns: 'wd', n: 4, point: [18.8, 54.6], type: 'exactMatch' }] },                                    // licence not stated
  { slug: 'danzig', label: 'Danzig', cands: [{ ns: 'osm', n: 5, point: null, type: 'exactMatch' }] },                                     // no location on record
  { slug: 'puck', label: 'Puck', cands: [{ ns: 'gn', n: 6, point: [18.4, 54.72], type: 'exactMatch' }] },                                 // its record, read, has two areas
  { slug: 'tczew', label: 'Tczew', cands: [{ ns: 'gn', n: 8, point: [18.79, 54.09], type: 'exactMatch' }] },                              // its record, read, has an area and one point
  { slug: 'gdynia', label: 'Gdynia', cands: [{ ns: 'gn', n: 7, point: [18.53, 54.52], type: 'exactMatch' }], located: true },             // has a location already
  { slug: 'wejherowo', label: 'Wejherowo', cands: [{ ns: 'gn', n: 10, point: [18.23, 54.6], type: 'exactMatch' }, { ns: 'gn', n: 11, point: [18.25, 54.61], type: 'exactMatch' }] },   // two records, each with a location
  { slug: 'malbork', label: 'Malbork', cands: [{ ns: 'gn', n: 9, point: [19.03, 54.04], type: 'exactMatch' }], late: true, tableGiven: true },   // accepted only after the decisions were recorded
  { slug: 'elblag', label: 'Elbląg', cands: [], tableGiven: { ns: 'gn', n: 12 } },                                                         // a match the table gave: no decision of the review's
];
const rec = (c) => `${W3}place:${c.ns}:${c.n}`;
const square = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.1, y], [x + 0.1, y + 0.1], [x, y + 0.1], [x, y]]] });
// Records read by a caller (none is fetched here): Puck's has two areas and no point; Tczew's an area and one point.
export const FEATURES = {
  'place:gn:6': { type: 'Feature', properties: { title: 'Puck' }, geometry: { type: 'GeometryCollection', geometries: [square(18.4, 54.7), square(18.6, 54.7)] } },
  'place:gn:8': { type: 'Feature', properties: { title: 'Tczew' }, geometry: { type: 'GeometryCollection', geometries: [square(18.7, 54.0), { type: 'Point', coordinates: [18.7775001234, 54.0924] }] } },
};

/** The dataset as the table was converted: each place a name; Gdynia a location; Malbork and Elbląg a match the table gave (no contributor). */
export function datasetText() {
  const source = { title: 'places.csv', authorityType: 'source' };
  return JSON.stringify({
    $schema: 'https://w3id.org/plato/schemas/place-centric.schema.json', profile: 'place-centric',
    gazetteer: { '@id': P, title: 'Places on the bay' },
    spatialEntities: ROWS.map((r) => ({
      '@id': P + r.slug, label: r.label,
      attestations: [
        { names: [{ toponym: r.label }], sources: [source] },
        ...(r.located ? [{ geometries: [{ geojson: { type: 'Point', coordinates: [18.5, 54.5] }, reprPoint: [18.5, 54.5] }], sources: [source] }] : []),
        ...(r.tableGiven ? [{ identities: [{ subject: P + r.slug, object: rec(r.tableGiven === true ? r.cands[0] : r.tableGiven), identityType: 'closeMatch', basis: 'given by the table' }], sources: [source] }] : []),
      ],
    })),
  }, null, 1);
}
/** The review's work file: a lookup of WHG with its attribution, a candidate for each record, each accepted (but `late` ones, unless asked). */
export function workOf(file, { late = true, attribution = ATTRIBUTION, reviewer = WHO } = {}) {
  const places = {}, candidates = [], queries = {};
  for (const r of ROWS) {
    places[P + r.slug] = { label: r.label, names: [r.label], point: null };
    queries[P + r.slug] = { state: 'answered', sent: [r.label] };
    for (const c of r.cands) {
      const accepted = !r.late || late;
      candidates.push({
        id: `l1-${c.n}`, candidate_source: P + r.slug, candidate_candidate: rec(c), similarity_score: 1, distance_km: null,
        candidate_status: accepted ? 'confirmed' : 'suggested', lookup: 'l1',
        other: { label: r.label, names: [r.label], point: c.point, source: { title: 'World Historical Gazetteer' } },
        gazetteer: { service: WHG_ENDPOINT, id: `place:${c.ns}:${c.n}`, score: 100, confidence: 90, match: true, answer_rank: 1, description: '', namespace: c.ns, query: r.label },
        decision: accepted ? { kind: 'match', identityType: c.type, decided_at: DECIDED } : null,
      });
    }
  }
  return {
    krisis: 3, generated_at: DECIDED, algorithm_version: 'krisis-lookup 1', match_parameters: {},
    subjects: { title: 'Places on the bay', uri: P, files: [{ name: file.name, size: file.size, sha256: hex('a') }] }, others: null,
    places, regions: {}, candidates, reviewer, cursor: 0,
    lookups: [{ id: 'l1', service: { endpoint: WHG_ENDPOINT, title: 'World Historical Gazetteer', uri: 'https://whgazetteer.org/' }, started_at: '2026-11-16T09:00:00Z', finished_at: '2026-11-16T09:01:00Z',
      algorithm_version: 'krisis-lookup 1', parameters: {}, attribution, counts: {}, stopped: null, queries }],
  };
}
/** The dataset with the review's decisions recorded by Krisis's Finish, as the step before this one leaves it. */
export async function recorded() {
  const table = textFile(datasetText(), 'bay.json');
  const e = env();
  const a = await apply({ subjects: await detect([table]), work: workOf(table, { late: false }), options: { reviewer: WHO, date: DECIDED } }, e);
  assert.equal(a.report.errors, 0, JSON.stringify(a.report.items));
  const [o] = a.outputs;
  return { table, file: new File(e.outs[o.name], o.name) };
}
