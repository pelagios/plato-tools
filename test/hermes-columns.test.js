// Matching the columns of a table of places to PLATO (src/engine/hermes/columns.js): the guess from
// the headings, a saved mapping checked against the columns there are, and one row read through it.
// Every test that asserts an absence asserts, in the same test, a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessColumns, resolveColumns, applyColumns, normaliseHeader, geometryToPlato, wktFault, FIELDS, OTHER, GENERIC_KINDS, FEATURE_ID } from '../src/engine/hermes/columns.js';
import { LOSS_TEXT } from '../src/engine/report.js';

// The mapping has no prototype (so that a column called __proto__ is kept): compared as a plain object.
const plain = (o) => ({ ...o });
const guess = (headers, rows = []) => plain(guessColumns(headers, rows).mapping);
/** Read one row, collecting what is reported: { a, reported: [[kind, example]], kinds }. */
function read(row, mapping, opts = {}) {
  const reported = [];
  const a = applyColumns(row, mapping, { where: 'row 2', fileName: 'f.csv', report: (k, e) => reported.push([k, e]), ...opts });
  return { a, reported, kinds: new Set(reported.map(([k]) => k)) };
}

// ---- the guess --------------------------------------------------------------------------------------
test('headings are matched whatever their case, spacing and punctuation', () => {
  assert.equal(normaliseHeader(' Place-Name '), 'placename');
  assert.equal(normaliseHeader('Longitude (°)'), 'longitude');
  assert.equal(normaliseHeader('Géo_Nom'), 'geonom');
  const rows = [{ 'Place Name': 'Roma', LAT: '41.9', Long: '12.5', 'Alt. names': 'Rome', 'Feature_Type': 'city', ID: 'r1' }];
  assert.deepEqual(guess(['Place Name', 'LAT', 'Long', 'Alt. names', 'Feature_Type', 'ID'], rows),
    { 'Place Name': 'name', LAT: 'latitude', Long: 'longitude', 'Alt. names': 'alternativeNames', Feature_Type: 'type', ID: 'id' });
});
test('each of the maintainer\'s examples is guessed as the field it names', () => {
  const cases = { name: 'name', toponym: 'name', title: 'name', label: 'name', lat: 'latitude', latitude: 'latitude', y: 'latitude',
    lon: 'longitude', lng: 'longitude', long: 'longitude', longitude: 'longitude', x: 'longitude', id: 'id', identifier: 'id',
    type: 'type', feature_type: 'type', language: 'language', source: 'source', citation: 'source', date: 'date', start: 'start', end: 'end', wkt: 'wkt' };
  const row = { lat: '1', latitude: '1', y: '1', lon: '1', lng: '1', long: '1', longitude: '1', x: '1' };
  for (const [h, f] of Object.entries(cases)) assert.equal(guess([h], [row])[h], f, h);
});
test('an address column counts only when its values are web addresses; otherwise it is a note', () => {
  const heads = ['uri', 'url', 'wikidata', 'pleiades', 'geonames', 'whg'];
  for (const h of heads) {
    assert.equal(guess([h], [{ [h]: 'https://example.org/p/1' }])[h], 'address', `${h} with addresses`);
    const g = guessColumns([h], [{ [h]: 'Q220' }]);
    assert.equal(g.mapping[h], 'note', `${h} without addresses`);
    assert.match(g.reasons[h], /its one sampled value is not a web address/);
  }
  // An id column of addresses is the place's address; an id column of words is the id.
  assert.equal(guess(['id'], [{ id: 'https://pleiades.stoa.org/places/579885' }]).id, 'address');
  assert.equal(guess(['id'], [{ id: '579885' }]).id, 'id');
  // A heading that names a gazetteer, with a suffix, is read the same way.
  assert.equal(guess(['wikidata_uri'], [{ wikidata_uri: 'http://www.wikidata.org/entity/Q220' }]).wikidata_uri, 'address');
});
// Rows of one column: `k` web addresses, then `n - k` values that are not.
const addressRows = (h, n, k) => Array.from({ length: n }, (_, i) => ({ [h]: i < k ? `https://pleiades.stoa.org/places/${579885 + i}` : `stray ${i}` }));
test('one stray value does not stop a gazetteer column being the address, and the reason says how many are addresses', () => {
  for (const h of ['uri', 'pleiades', 'link', 'id']) {
    const g = guessColumns([h], addressRows(h, 50, 49));
    assert.equal(g.mapping[h], 'address', `${h}: 49 of 50`);
    assert.match(g.reasons[h], /49 of its 50 sampled values are web addresses/);
  }
  // Control: all of them, said as all.
  const all = guessColumns(['uri'], addressRows('uri', 3, 3));
  assert.equal(all.mapping.uri, 'address');
  assert.match(all.reasons.uri, /all 3 of its sampled values are web addresses/);
});
test('a column mostly not of addresses stays a note unless its heading names a gazetteer, and the reason says how many were', () => {
  // "link" names no gazetteer: under half is not enough.
  const link = guessColumns(['link'], addressRows('link', 10, 4));
  assert.equal(link.mapping.link, 'note');
  assert.match(link.reasons.link, /only 4 of its 10 sampled values are web addresses/);
  // An id column mostly of local ids is the id.
  assert.equal(guess(['id'], addressRows('id', 10, 4)).id, 'id');
  // Control: the same values under a heading that names a gazetteer, and half of them under "link", are the address.
  assert.equal(guess(['wikidata'], addressRows('wikidata', 10, 1)).wikidata, 'address');
  assert.equal(guess(['link'], addressRows('link', 10, 5)).link, 'address');
  // None at all is a note, whatever the heading, and says so.
  const none = guessColumns(['wikidata'], addressRows('wikidata', 10, 0));
  assert.equal(none.mapping.wikidata, 'note');
  assert.match(none.reasons.wikidata, /none of its 10 sampled values is a web address/);
});
test('the columns whose headings name a gazetteer are listed, for the warning when none is the address', () => {
  const g = guessColumns(['name', 'geonames_id', 'gazetteer', 'link', 'wiki (column 3)', FEATURE_ID], [{ name: 'Roma', geonames_id: '3169070' }], { 'wiki (column 3)': 'wikidata' });
  assert.deepEqual(g.gazetteer, ['geonames_id', 'gazetteer', 'wiki (column 3)']);
  assert.deepEqual(resolveColumns(['name', 'uri'], [], { name: 'name', uri: 'note' }).gazetteer, ['uri'], 'a saved mapping lists them too');
});

test('Well-Known Text is checked: the shapes PLATO takes, well formed, on the earth; anything else says what is wrong', () => {
  for (const ok of ['Point(12.5 41.9)', 'POINT (12.5 41.9)', 'POINT Z (1 2 3)', 'POINT ZM (1 2 3 4)', 'SRID=4326;POINT(1 2)', 'LINESTRING(0 0, 1 1)', 'POLYGON((0 0, 1 0, 1 1, 0 0))',
    'MULTIPOINT((1 2), (3 4))', 'MULTIPOINT(1 2, 3 4)', 'MULTILINESTRING((0 0, 1 1), (2 2, 3 3))', 'MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))']) assert.equal(wktFault(ok), null, ok);
  const bad = {
    '48.39,4.52': /not Well-Known Text/, 'POINT(1, 2)': /not written as Well-Known Text writes one/, 'POINT(1 2), (3 4)': /not written/, 'POINT(1 2': /not written/,
    'POINT(200 10)': /longitude 200/, 'POINT(10 95)': /latitude 95/, 'LINESTRING(0 0)': /fewer than 2/, 'POLYGON((0 0, 1 0, 1 1, 0 1))': /not closed/,
    'GEOMETRYCOLLECTION(POINT(1 2))': /GEOMETRYCOLLECTION/, 'SRID=27700;POINT(1 2)': /SRID 27700/, '<http://www.wikidata.org/entity/Q405> Point(1 2)': /another globe/,
    'POINT EMPTY': /empty/, 'POINT M (1 2)': /M means 3/, 'CIRCLE(1 2)': /not Well-Known Text/,
  };
  for (const [t, why] of Object.entries(bad)) assert.match(wktFault(t)?.why || 'passed', why, t);
  assert.equal(wktFault('POINT(200 10)').range, true);
});
test('a WKT cell that is not valid is reported with why, and the rest of the row kept; a valid one is carried as written', () => {
  const m = { name: 'name', wkt: 'wkt' };
  const bad = read({ name: 'Troyes', wkt: '48.39,4.52' }, m);
  assert.deepEqual(bad.reported, [['generic-wkt-invalid', 'row 2, wkt: it is not Well-Known Text (such as POINT(12.5 41.9)) (48.39,4.52)']]);
  assert.equal(bad.a.attestation.geometries, undefined);
  assert.equal(bad.a.label, 'Troyes', 'the rest of the row is kept');
  const off = read({ name: 'X', wkt: 'POINT(200 10)' }, m);
  assert.ok(off.kinds.has('generic-coordinate-range'));
  const good = read({ name: 'Troyes', wkt: 'POINT(4.07 48.30)' }, m);
  assert.deepEqual(good.reported, []);
  assert.deepEqual(good.a.attestation.geometries, [{ wkt: 'POINT(4.07 48.30)' }]);
});
test("the Wikidata Query Service's columns: item is the address, itemLabel the name, coord (Point(lon lat)) WKT; a coord that is not WKT is a note", () => {
  const rows = [{ item: 'http://www.wikidata.org/entity/Q220', itemLabel: 'Rome', coord: 'Point(12.4828 41.8931)' }, { item: 'http://www.wikidata.org/entity/Q90', itemLabel: 'Paris', coord: 'Point(2.3514 48.8575)' }];
  const g = guessColumns(['item', 'itemLabel', 'coord'], rows);
  assert.deepEqual(plain(g.mapping), { item: 'address', itemLabel: 'name', coord: 'wkt' });
  assert.match(g.reasons.coord, /all 2 of its sampled values are Well-Known Text/);
  const n = guessColumns(['coord'], [{ coord: '48.39,4.52' }, { coord: '47.1,2.3' }]);
  assert.equal(n.mapping.coord, 'note');
  assert.match(n.reasons.coord, /none of its 2 sampled values are Well-Known Text/);
});
test('features with a geometry of their own: latitude and longitude properties are guessed as notes, saying why; without one, as coordinates', () => {
  const rows = [{ NAME: 'Rome', LATITUDE: '41.9', LONGITUDE: '12.5' }];
  const g = guessColumns(['NAME', 'LATITUDE', 'LONGITUDE'], rows, {}, { ownGeometry: true });
  assert.deepEqual(plain(g.mapping), { NAME: 'name', LATITUDE: 'note', LONGITUDE: 'note' });
  assert.match(g.reasons.LATITUDE, /the features have a geometry of their own/);
  assert.deepEqual(guess(['NAME', 'LATITUDE', 'LONGITUDE'], rows), { NAME: 'name', LATITUDE: 'latitude', LONGITUDE: 'longitude' }, 'control');
});
test('a coordinate column needs a number among its values; one stray word does not stop it', () => {
  assert.equal(guess(['lat'], [{ lat: '51.5' }, { lat: 'north' }]).lat, 'latitude');
  const g = guessColumns(['lat'], [{ lat: 'north' }, { lat: 'south' }]);
  assert.equal(g.mapping.lat, 'note');
  assert.match(g.reasons.lat, /none of its values is a number/);
  assert.equal(guess(['x', 'y'], [{ x: '12.5', y: '41.9' }]).x, 'longitude', 'control: numeric x is a longitude');
});
test('a field one column only can hold goes to the first such column; the next is kept in the notes, and says why', () => {
  const g = guessColumns(['name', 'title', 'lat', 'latitude'], [{ lat: '1', latitude: '2' }]);
  assert.deepEqual(plain(g.mapping), { name: 'name', title: 'note', lat: 'latitude', latitude: 'note' });
  assert.match(g.reasons.title, /already column "name"/);
  // Several columns may be other names, types or sources.
  assert.deepEqual(guess(['names', 'aliases', 'type', 'category']), { names: 'alternativeNames', aliases: 'alternativeNames', type: 'type', category: 'type' });
});
test('an unknown column is kept in the notes, never guessed into anything that would claim the source said it', () => {
  const g = guessColumns(['name', 'population', 'Remarks'], [{ name: 'A', population: '500', Remarks: 'x' }]);
  assert.equal(g.mapping.name, 'name', 'control: a known column is matched');
  assert.deepEqual([g.mapping.population, g.mapping.Remarks], ['note', 'note']);
  assert.match(g.reasons.population, /not one these tools recognise/);
  for (const f of Object.values(g.mapping)) assert.ok(FIELDS[f] || OTHER[f], f);
});
test("a GeoJSON feature's own id is guessed as the id, ahead of any property", () => {
  const g = guessColumns([FEATURE_ID, 'id', 'name'], [{ [FEATURE_ID]: 'f1', id: '7', name: 'A' }]);
  assert.deepEqual(plain(g.mapping), { [FEATURE_ID]: 'id', id: 'note', name: 'name' });
});

// ---- a saved mapping --------------------------------------------------------------------------------
test('a saved mapping is used as given, where it is a mapping of these columns', () => {
  const r = resolveColumns(['A', 'B', 'C'], [], { A: 'name', B: 'skip', C: 'note' });
  assert.deepEqual(plain(r.mapping), { A: 'name', B: 'skip', C: 'note' });
  assert.deepEqual(r.problems, []);
});
test('what a saved mapping gets wrong is reported, and the column concerned is kept in the notes', () => {
  const r = resolveColumns(['A', 'B', 'C', 'D'], [], { A: 'name', B: 'colour', C: 'name', E: 'id' });
  assert.deepEqual(plain(r.mapping), { A: 'name', B: 'note', C: 'note', D: 'note' });
  const kinds = r.problems.map((p) => [p.kind, p.example.split(':')[0]]);
  assert.deepEqual(kinds, [['generic-mapping', 'B'], ['generic-mapping', 'C'], ['generic-mapping-missing-column', 'D'], ['generic-mapping-unknown-column', 'E']]);
  const notObject = resolveColumns(['name'], [], ['name']);
  assert.equal(notObject.problems[0].kind, 'generic-mapping');
  assert.equal(notObject.mapping.name, 'name', 'the guess is used instead');
});

// ---- one row ------------------------------------------------------------------------------------------
const M = { n: 'name', alt: 'alternativeNames', lat: 'latitude', lon: 'longitude', t: 'type', lang: 'language', d: 'date', s: 'start', e: 'end', w: 'wkt', rem: 'note', junk: 'skip' };
test('a row becomes one attestation in the shapes of the spreadsheet tables', () => {
  const { a, reported } = read({ n: 'Roma', alt: 'Rome; Urbs|Roma', lat: '41.9', lon: '12.5', t: 'city;https://vocab.getty.edu/aat/300008389', lang: 'la', d: 'Augustan', s: '-27', e: '14', w: 'POINT (12.5 41.9)', rem: 'capital', junk: 'x' }, M);
  assert.deepEqual(reported, []);
  assert.equal(a.label, 'Roma');
  assert.deepEqual(a.attestation, {
    names: [{ toponym: 'Roma', language: 'la' }, { toponym: 'Rome' }, { toponym: 'Urbs' }],
    geometries: [{ reprPoint: [12.5, 41.9], geojson: { type: 'Point', coordinates: [12.5, 41.9] }, wkt: 'POINT (12.5 41.9)' }],
    types: [{ label: 'city' }, { identifier: 'https://vocab.getty.edu/aat/300008389', label: 'https://vocab.getty.edu/aat/300008389' }],
    timespans: [{ sourceLabel: 'Augustan', startEarliest: '-0027', endLatest: '0014' }],
    sources: [{ title: 'f.csv', authorityType: 'source' }],
    citations: [{ source: { title: 'f.csv', authorityType: 'source' }, locator: 'row 2' }],
    notes: 'rem: capital',
  });
  assert.deepEqual(a.skipped, ['junk']);
});
test('a source column names the source instead of the file', () => {
  const { a } = read({ n: 'A', src: 'https://example.org/book' }, { n: 'name', src: 'source' });
  assert.deepEqual(a.attestation.citations, [{ source: { '@id': 'https://example.org/book', title: 'https://example.org/book', authorityType: 'source' } }]);
  const { a: b } = read({ n: 'A', src: '' }, { n: 'name', src: 'source' });
  assert.equal(b.attestation.citations[0].source.title, 'f.csv', 'an empty source cell leaves the file as the source');
});
test('a missing, non-numeric or out-of-range coordinate is reported by kind, and the rest of the row is kept', () => {
  const cases = [[{ lat: '51.5' }, 'generic-coordinate-missing'], [{ lat: '51°30′', lon: '0' }, 'generic-coordinate-not-number'], [{ lat: '95', lon: '10' }, 'generic-coordinate-range'], [{ lat: '10', lon: '190' }, 'generic-coordinate-range']];
  for (const [row, kind] of cases) {
    const { a, kinds } = read({ n: 'A', ...row }, M);
    assert.ok(kinds.has(kind), `${JSON.stringify(row)}: ${kind}`);
    assert.equal(a.attestation.geometries, undefined);
    assert.deepEqual(a.attestation.names, [{ toponym: 'A' }], 'the name is still carried');
  }
  const ok = read({ n: 'A', lat: '-90', lon: '180' }, M);
  assert.deepEqual([...ok.kinds], []);
  assert.deepEqual(ok.a.attestation.geometries[0].reprPoint, [180, -90], 'control: the limits themselves are places');
});
test('dates that are not years or ISO dates, and languages that are not codes, are reported and not carried', () => {
  const { a, reported } = read({ n: 'A', s: 'c. 75', e: '1066-10-14', lang: 'Latin (classical)' }, M);
  assert.deepEqual(reported, [['generic-date-invalid', 'row 2, s: c. 75'], ['generic-language-invalid', 'row 2: Latin (classical)']]);
  assert.deepEqual(a.attestation.timespans, [{ endLatest: '1066-10-14' }], 'control: the good date is carried');
  assert.deepEqual(a.attestation.names, [{ toponym: 'A' }]);
  // A language with no name to be the language of is not lost: it is kept in the notes.
  assert.equal(read({ lang: 'la', alt: 'X' }, M).a.attestation.notes, 'lang: la');
});
test('with no name, the label is the first other name; with neither there is no label', () => {
  assert.equal(read({ alt: 'Urbs; Roma' }, M).a.label, 'Urbs');
  assert.equal(read({ lat: '1', lon: '1' }, M).a.label, undefined);
  assert.equal(read({ n: 'Roma' }, M).a.label, 'Roma', 'control');
});
test('the address column gives the address only when it is a web address', () => {
  const m = { n: 'name', w: 'address', i: 'id' };
  assert.deepEqual([read({ w: 'https://www.wikidata.org/wiki/Q220' }, m).a.address, read({ w: 'Q220' }, m).a.address, read({ w: 'Q220' }, m).a.addressText],
    ['https://www.wikidata.org/wiki/Q220', undefined, 'Q220']);
  // Rows about an address keep their id in the notes, since the place is not theirs to name.
  const { a } = read({ n: 'R', w: 'https://www.wikidata.org/wiki/Q220', i: 'r1' }, m, { idAsNote: true });
  assert.equal(a.attestation.notes, 'i: r1');
  assert.equal(read({ n: 'R', i: 'r1' }, m).a.attestation.notes, undefined, 'control: a place-centric row does not');
});
test('a GeoJSON geometry is kept, a GeometryCollection refused, and anything else not a geometry reported', () => {
  const r = [];
  const report = (k, e) => r.push(k);
  assert.deepEqual(geometryToPlato({ type: 'Point', coordinates: [1, 2] }, report), [{ reprPoint: [1, 2], geojson: { type: 'Point', coordinates: [1, 2] } }]);
  assert.deepEqual(geometryToPlato({ type: 'LineString', coordinates: [[1, 2], [3, 4]] }, report), [{ geojson: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } }]);
  assert.deepEqual(r, [], 'control: good geometries report nothing');
  assert.deepEqual(geometryToPlato({ type: 'GeometryCollection', geometries: [] }, report), []);
  assert.deepEqual(geometryToPlato({ type: 'Circle', coordinates: [1, 2] }, report), []);
  assert.deepEqual(geometryToPlato(null, report), []);
  assert.deepEqual(r, ['generic-geometry-collection', 'generic-geometry-invalid']);
  // A geometry column in a CSV holds the geometry written out as GeoJSON.
  const { a } = read({ n: 'A', g: '{"type":"Point","coordinates":[3,4]}' }, { n: 'name', g: 'geometry' });
  assert.deepEqual(a.attestation.geometries, [{ reprPoint: [3, 4], geojson: { type: 'Point', coordinates: [3, 4] } }]);
});
test('every position of every geometry type is checked: numbers, on the earth, enough of them, rings closed', () => {
  const at = (g) => { const r = []; const out = geometryToPlato(g, (k, e) => r.push([k, e]), 'feature 1'); return { out, r }; };
  const sq = [[0, 0], [1, 0], [1, 1], [0, 0]];
  // Controls: a well-formed geometry of each type is kept, with nothing reported.
  for (const g of [{ type: 'MultiPoint', coordinates: [[1, 2], [3, 4, 100]] }, { type: 'LineString', coordinates: [[1, 2], [3, 4]] }, { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]]] },
    { type: 'Polygon', coordinates: [sq] }, { type: 'MultiPolygon', coordinates: [[sq], [sq, sq]] }, { type: 'Point', coordinates: [-180, 90] }]) {
    const { out, r } = at(g);
    assert.deepEqual([out.length, r], [1, []], g.type);
    assert.deepEqual(out[0].geojson, g, g.type);
  }
  const cases = [
    [{ type: 'LineString', coordinates: [[1, 2], [3, 95]] }, 'generic-coordinate-range', 'feature 1: LineString: position 2 has latitude 95, outside -90 to 90'],
    [{ type: 'MultiPolygon', coordinates: [[sq], [[[0, 0], [190, 0], [1, 1], [0, 0]]]] }, 'generic-coordinate-range', 'feature 1: MultiPolygon: position 2 of ring 1 of polygon 2 has longitude 190, outside -180 to 180'],
    [{ type: 'Point', coordinates: [200, 0] }, 'generic-coordinate-range', 'feature 1: Point: the point has longitude 200, outside -180 to 180'],
    [{ type: 'LineString', coordinates: [[1, 2]] }, 'generic-geometry-invalid', 'feature 1: LineString: the geometry has 1 positions, fewer than 2'],
    [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, 'generic-geometry-invalid', 'feature 1: Polygon: ring 1 does not end where it begins, so it is not closed'],
    [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] }, 'generic-geometry-invalid', 'feature 1: Polygon: ring 1 has 3 positions, fewer than 4'],
    [{ type: 'MultiPoint', coordinates: [[1, 2, 3, 4]] }, 'generic-geometry-invalid', 'feature 1: MultiPoint: position 1 is 4 numbers, not two or three'],
    [{ type: 'Point', coordinates: ['1', 2] }, 'generic-geometry-invalid', 'feature 1: Point: the point is not all numbers (["1",2])'],
    [{ type: 'MultiLineString', coordinates: [[1, 2], [3, 4]] }, 'generic-geometry-invalid', 'feature 1: MultiLineString: position 1 of line 1 is not a list of numbers (1)'],
    [{ type: 'Polygon', coordinates: [] }, 'generic-geometry-invalid', 'feature 1: Polygon: the geometry has 0 rings, fewer than 1'],
  ];
  for (const [g, kind, example] of cases) assert.deepEqual(at(g), { out: [], r: [[kind, example]] }, JSON.stringify(g));
  // In a row, the geometry is lost and the rest of the row kept.
  const { a, reported } = read({ n: 'Roma', g: JSON.stringify(cases[4][0]) }, { n: 'name', g: 'geometry' });
  assert.deepEqual([a.label, a.attestation.geometries, reported.map(([k]) => k)], ['Roma', undefined, ['generic-geometry-invalid']]);
  assert.match(reported[0][1], /^row 2, g: Polygon: ring 1 does not end where it begins/);
});
test('a column called __proto__ or constructor is a column like any other, guessed or given', () => {
  const g = guessColumns(['__proto__', 'constructor', 'name'], [{ __proto__: null, ['__proto__']: 'x', constructor: 'y', name: 'Roma' }]);
  assert.equal(Object.getPrototypeOf(g.mapping), null);
  assert.deepEqual(Object.keys(g.mapping), ['__proto__', 'constructor', 'name']);
  assert.deepEqual(Object.values(g.mapping), ['note', 'note', 'name']);
  assert.match(g.reasons.__proto__ ?? '', /not one these tools recognise/);
  const r = resolveColumns(['__proto__', 'name'], [], JSON.parse('{"__proto__": "id", "name": "name"}'));
  assert.deepEqual([Object.keys(r.mapping), r.mapping.__proto__, r.mapping.name, r.problems], [['__proto__', 'name'], 'id', 'name', []]);
});
test('a saved matching that names constructor, toString or __proto__ as a field is reported, and the column kept in the notes', () => {
  for (const f of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = resolveColumns(['A', 'B'], [], { A: 'name', B: f });
    assert.equal(r.mapping.B, 'note', f);
    assert.equal(r.mapping.A, 'name', `control (${f}): a field is taken`);
    assert.deepEqual(r.problems.map((p) => [p.kind, p.example.split(':')[0]]), [['generic-mapping', 'B']], f);
    assert.match(r.reasons.B, /which is not a field/);
  }
});
test('every kind the reader reports has words, and a severity the report knows', () => {
  // The loop proves nothing of an empty list: kinds the other tests here meet must be in it.
  for (const k of ['generic-mapping', 'generic-column-skipped', 'generic-coordinate-range', 'generic-wkt-invalid', 'generic-no-ids', 'generic-empty'])
    assert.ok(k in GENERIC_KINDS, `${k} is not among ${Object.keys(GENERIC_KINDS).join(', ')}`);
  for (const [k, sev] of Object.entries(GENERIC_KINDS)) {
    assert.ok(LOSS_TEXT[k], k);
    assert.ok(['loss', 'warning', 'error'].includes(sev), k);
    assert.doesNotMatch(LOSS_TEXT[k], /contribution|submission/i, k);
  }
});
