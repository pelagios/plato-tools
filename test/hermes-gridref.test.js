// Grid references (src/engine/hermes/gridref.js) and the column read as one (columns.js, `gridref`).
// Every test that asserts an absence asserts, in the same test, a presence it could have missed; each
// tolerance has a control that a plausible mistake (the square's corner for its centre, no datum
// shift) would fall outside.
//
// The reference values, and where they come from:
//   - Ordnance Survey, "A Guide to Coordinate Systems in Great Britain" (v3.6, 2020): the worked
//     examples of annex C (E 651409.903, N 313177.270 <-> 52°39'27.2531"N, 1°43'04.5177"E on
//     OSGB36) and annex D (ETRS89 53°36'43.1653"N, 1°39'51.9920"W, 299.800 m -> OSGB36
//     53°36'42.2972"N, 1°39'46.5416"W -> E 422297.792, N 412878.741);
//   - Ordnance Survey's OSTN15/OSGM15 developer pack (OSTN15-OSGM15-DevelopersPack.zip): the test
//     points of OSTN15_OSGM15_TestInput_OSGBtoETRS.txt and their ETRS89 results in
//     OSTN15_OSGM15_TestOutput_OSGBtoETRS.txt, through OSTN15 (about 0.1 m), so independent of the
//     Helmert transformation tested; and, for the Irish Grid, OSGM15_NI_TestInput_IGtoETRS89.txt and
//     OSGM15_NI_TestOutput_IGtoETRS89.txt (Northern Ireland). ETRS89 and WGS 84 are taken as one,
//     as the OS guide does at this accuracy (section 6.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGridRef, gridToLatLon, latLonToGrid, datumToWgs84, wgs84ToDatum, gridRefToWgs84, GRIDS } from '../src/engine/hermes/gridref.js';
import { guessColumns, applyColumns, GENERIC_KINDS } from '../src/engine/hermes/columns.js';
import { LOSS_TEXT } from '../src/engine/report.js';
import { COLUMN_CHOICES } from '../src/engine/words.js';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { textFile, go, outText } from './engine.js';

const dms = (d, m, s, sign = 1) => sign * (d + m / 60 + s / 3600);
const ARCSEC = 1 / 3600;
/** Ground distance in metres between two [latitude, longitude] points (haversine, mean radius). */
function metres([y1, x1], [y2, x2]) {
  const r = Math.PI / 180, a = Math.sin((y2 - y1) * r / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin((x2 - x1) * r / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}
const toWgs = (grid, E, N) => datumToWgs84(grid, ...gridToLatLon(grid, E, N));

// ---- the OS guide's worked examples ---------------------------------------------------------------
test("the OS guide's annex C example: eastings and northings to latitude and longitude, and back, to its stated precision", () => {
  const [lat, lon] = gridToLatLon('osgb', 651409.903, 313177.270);
  // The guide gives the result to 0.0001 of a second of arc.
  assert.ok(Math.abs(lat - dms(52, 39, 27.2531)) < 0.00005 * ARCSEC, `latitude ${lat}`);
  assert.ok(Math.abs(lon - dms(1, 43, 4.5177)) < 0.00005 * ARCSEC, `longitude ${lon}`);
  const [E, N] = latLonToGrid('osgb', dms(52, 39, 27.2531), dms(1, 43, 4.5177));
  assert.ok(Math.abs(E - 651409.903) < 0.001 && Math.abs(N - 313177.270) < 0.001, `${E}, ${N}`);
  // Control: a metre east is far outside that tolerance.
  const [, lon1] = gridToLatLon('osgb', 651410.903, 313177.270);
  assert.ok(Math.abs(lon1 - dms(1, 43, 4.5177)) > 0.01 * ARCSEC);
});

test("the OS guide's annex D example: its Helmert parameters, and the way back from its grid coordinates to WGS 84", () => {
  // Forward, WGS 84 -> OSGB36 by the guide's own table 4 (our parameters with every sign changed back).
  const [lat, lon] = wgs84ToDatum('osgb', dms(53, 36, 43.1653), dms(1, 39, 51.9920, -1), 299.8);
  assert.ok(Math.abs(lat - dms(53, 36, 42.2972)) < 0.0005 * ARCSEC, `latitude ${lat}`);
  assert.ok(Math.abs(lon - dms(1, 39, 46.5416, -1)) < 0.0005 * ARCSEC, `longitude ${lon}`);
  // Back, from the example's eastings and northings to WGS 84: the reversed Helmert is good to centimetres.
  const w = toWgs('osgb', 422297.792, 412878.741);
  assert.ok(metres(w, [dms(53, 36, 43.1653), dms(1, 39, 51.9920, -1)]) < 0.02, `${w}`);
  // Control: without the datum shift the point is over 100 m from WGS 84.
  assert.ok(metres(gridToLatLon('osgb', 422297.792, 412878.741), [dms(53, 36, 43.1653), dms(1, 39, 51.9920, -1)]) > 100);
});

// ---- known points, independently published ---------------------------------------------------------
// [id, easting, northing, ETRS89 latitude, longitude] from the OSTN15 developer pack's test files.
const GB = [
  ['TP08', 362269.991, 169978.690, 51.42754743020, -2.54407618349],
  ['TP09', 530624.974, 178388.464, 51.48936564950, -0.11992557180],
  ['TP20', 422242.186, 433818.701, 53.80021519630, -1.66379168242],
  ['TP27', 319188.434, 670947.534, 55.92478265510, -3.29479219337],
  ['TP38', 421300.525, 1072147.239, 59.53470794490, -1.62516966058],
  ['TP40', 395999.668, 1138728.951, 60.13308091660, -2.07382822798],
];
test('OSTN15 test points in Great Britain come within the Helmert transformation\'s 3.5 m', () => {
  for (const [id, E, N, lat, lon] of GB) {
    const d = metres(toWgs('osgb', E, N), [lat, lon]);
    assert.ok(d < GRIDS.osgb.accuracyM, `${id}: ${d.toFixed(2)} m`);
    // Control: on OSGB36, untransformed, each is more than 50 m away.
    assert.ok(metres(gridToLatLon('osgb', E, N), [lat, lon]) > 50, id);
  }
  // The guide's 3.5 m is at 95%: at the edges of the grid it is exceeded. TP31 (North Uist), 4.9 m.
  const d31 = metres(toWgs('osgb', 9587.906, 899449.000), [57.81351838410, -8.57854456076]);
  assert.ok(d31 > GRIDS.osgb.accuracyM && d31 < 5, `TP31: ${d31.toFixed(2)} m`);
});
test('OSNI test points come within the Irish Grid transformation\'s 1 m', () => {
  const NI = [
    ['NI_IG_1', 223657.156, 340618.902, dms(54, 18, 49.673618), dms(7, 38, 14.133209, -1)],
    ['NI_IG_2', 308131.471, 390483.856, dms(54, 45, 2.413355), dms(6, 19, 17.094677, -1)],
    ['NI_IG_10', 289507.735, 329405.008, dms(54, 12, 20.875523), dms(6, 37, 44.494849, -1)],
  ];
  for (const [id, E, N, lat, lon] of NI) {
    assert.ok(metres(toWgs('irish', E, N), [lat, lon]) < GRIDS.irish.accuracyM, id);
    // Controls: untransformed, and read on the National Grid's projection instead, both far off.
    assert.ok(metres(gridToLatLon('irish', E, N), [lat, lon]) > 50, id);
    assert.ok(metres(toWgs('osgb', E, N), [lat, lon]) > 10000, id);
  }
});
test('a grid reference, as written, comes to the published point within its precision', () => {
  // TP09 (Lambeth) to the metre: TQ 30624 78388; its square's centre is at most 0.71 m from the point.
  const g = gridRefToWgs84('TQ 30624 78388');
  assert.ok(metres([g.lat, g.lon], [51.48936564950, -0.11992557180]) < g.precisionKm * 1000 + 0.71);
  const ni = gridRefToWgs84('J 08131 90483');   // NI_IG_2
  assert.ok(metres([ni.lat, ni.lon], [dms(54, 45, 2.413355), dms(6, 19, 17.094677, -1)]) < ni.precisionKm * 1000 + 0.71);
  // Control: the same digits under the wrong square letters are 100 km away.
  const off = gridRefToWgs84('TL 30624 78388');
  assert.ok(metres([off.lat, off.lon], [51.48936564950, -0.11992557180]) > 90000);
});

// ---- letters, digits, precision and the centre -----------------------------------------------------
test('the letters name the 500 km and 100 km squares, on either grid, and spaces do not matter', () => {
  assert.deepEqual([parseGridRef('TQ 33760 80560').easting, parseGridRef('TQ 33760 80560').northing], [533760, 180560]);
  assert.deepEqual([parseGridRef('tq3376080560').easting, parseGridRef('TQ  33760   80560').northing], [533760, 180560]);
  assert.deepEqual([parseGridRef('SV00').easting, parseGridRef('SV00').northing], [0, 0]);   // the false origin's square
  assert.deepEqual([parseGridRef('HP 6 1').easting, parseGridRef('HP 6 1').northing], [460000, 1210000]);   // Shetland
  assert.deepEqual([parseGridRef('NN 16667 71244').easting, parseGridRef('NN 16667 71244').northing], [216667, 771244]);
  const ie = parseGridRef('O 15 34');
  assert.deepEqual([ie.grid, ie.easting, ie.northing, ie.sizeM], ['irish', 315000, 234000, 1000]);
  assert.equal(parseGridRef('V00').easting, 0);
  assert.equal(parseGridRef('SU1234').grid, 'osgb');
});
test('n digits per axis name a square of 10^(5-n) m, and the precision is its half diagonal, or the transformation\'s accuracy where larger', () => {
  const cases = [
    ['SU', 100000, 70.710678, true], ['SU13', 10000, 7.071068, true], ['SU1234', 1000, 0.707107, true],
    ['SU123456', 100, 0.070711, false], ['SU12345678', 10, 0.007071, false], ['SU1234567890', 1, 0.0035, false],
  ];
  for (const [ref, size, km, approximate] of cases) {
    const g = gridRefToWgs84(ref);
    assert.equal(g.sizeM, size, ref);
    assert.equal(g.precisionKm, km, ref);
    assert.equal(g.approximate, approximate, ref);
  }
  // On the Irish Grid the transformation's 1 m is larger than a 1 m square's half diagonal.
  assert.equal(gridRefToWgs84('O 15000 34000').precisionKm, 0.001);
  assert.equal(gridRefToWgs84('O 15 34').precisionKm, 0.707107);
});
test('the point is the centre of the square, not its south-west corner', () => {
  for (const [ref, E, N] of [['SU1234', 412500, 134500], ['SU', 450000, 150000], ['SU123456', 412350, 145650]]) {
    const g = gridRefToWgs84(ref);
    const [e, n] = latLonToGrid('osgb', ...wgs84ToDatum('osgb', g.lat, g.lon));
    assert.ok(Math.abs(e - E) < 0.05 && Math.abs(n - N) < 0.05, `${ref}: ${e}, ${n}`);
    // Control: the corner is half the square's side away on each axis.
    const p = parseGridRef(ref);
    assert.ok(Math.abs(e - p.easting) > p.sizeM / 2 - 0.05, ref);
  }
  assert.match(gridRefToWgs84('SU1234').note, /centre of its 1 km square, easting 412500 m, northing 134500 m/);
});
test('a reference that is not one says why', () => {
  const bad = {
    'TQ123': /odd number of digits \(3\)/, 'TQ 337 80560': /differ in length \(3 and 5\)/, 'IA12': /letter I is not used/,
    'AA12': /AA is not a 100 km square/, 'TZ12': /TZ is not a 100 km square/, 'SU123456789012': /more than the ten/,
    'Q-1234': /not a grid reference/, 'Q2 1234': /differ in length \(1 and 4\)/, '': /not a grid reference/, '533760, 180560': /not a grid reference/,
  };
  for (const [ref, why] of Object.entries(bad)) assert.match(parseGridRef(ref).error || '', why, ref);
  // Control: their neighbours that are references are read.
  for (const ref of ['TQ1234', 'TQ 337 805', 'HU12', 'TV12', 'SU1234567890']) assert.equal(parseGridRef(ref).error, undefined, ref);
});

// ---- the column -------------------------------------------------------------------------------------
const plain = (o) => ({ ...o });
function read(row, mapping) {
  const reported = [];
  const a = applyColumns(row, mapping, { where: 'row 2', fileName: 'f.csv', report: (k, e) => reported.push([k, e]) });
  return { a, reported, kinds: reported.map(([k]) => k) };
}
test('a grid reference column is guessed from its heading, if its values are references, and from its values alone', () => {
  const rows = [{ 'Grid Ref': 'TQ 33760 80560', NGR: 'SU1234', 'OS grid': 'SU', 'irish grid': 'O 15 34', refs: 'TQ3380', label: 'TQ3380', code: 'NY' }];
  for (const h of ['Grid Ref', 'NGR', 'OS grid', 'irish grid']) assert.equal(guessColumns([h], rows).mapping[h], 'gridref', h);
  const g = guessColumns(['refs'], rows);
  assert.equal(g.mapping.refs, 'gridref');
  assert.match(g.reasons.refs, /its one sampled value is a grid reference/);
  // Controls: a heading that already names a field keeps it; letters alone (a state code) are not
  // guessed from values; a grid heading over values that are not references is a note.
  assert.equal(guessColumns(['label'], rows).mapping.label, 'name');
  assert.equal(guessColumns(['code'], rows).mapping.code, 'note');
  const n = guessColumns(['ngr'], [{ ngr: 'north' }, { ngr: 'south' }]);
  assert.equal(n.mapping.ngr, 'note');
  assert.match(n.reasons.ngr, /none of its 2 sampled values are a grid reference/);
  // One column only: the second is a note.
  assert.deepEqual(plain(guessColumns(['ngr', 'refs'], rows).mapping), { ngr: 'gridref', refs: 'note' });
  // A postcode is not a grid reference.
  assert.equal(guessColumns(['pc'], [{ pc: 'SW1A 1AA' }, { pc: 'EH1 1YZ' }]).mapping.pc, 'note');
  assert.ok(COLUMN_CHOICES.gridref.includes('Grid reference'));
});
test('a row with a grid reference has its location: the centre, precision, approximate for coarse squares, and the reference as written', () => {
  const { a, reported } = read({ n: 'Box Hill', g: 'TQ 1751' }, { n: 'name', g: 'gridref' });
  assert.deepEqual(reported, []);
  const [geo] = a.attestation.geometries;
  const want = gridRefToWgs84('TQ 1751');
  assert.deepEqual(geo.reprPoint, [want.lon, want.lat]);
  assert.deepEqual(geo.geojson, { type: 'Point', coordinates: [want.lon, want.lat] });
  assert.deepEqual(geo.precisionKm, [0.707107]);
  assert.deepEqual(geo.spatialPrecision, ['approximate']);
  assert.equal(geo.sourceLabel, 'TQ 1751');
  assert.match(a.attestation.notes, /Helmert transformation from OSGB36 to WGS 84.*3\.5 m \(95%\)/);
  // Control: a fine reference is not called approximate, and still has its precision.
  const fine = read({ n: 'x', g: 'TQ 17500 51500' }, { n: 'name', g: 'gridref' }).a.attestation.geometries[0];
  assert.equal(fine.spatialPrecision, undefined);
  assert.deepEqual(fine.precisionKm, [0.0035]);
  assert.match(read({ n: 'x', g: 'O 15 34' }, { n: 'name', g: 'gridref' }).a.attestation.notes, /Irish Grid \(TM65\).*EPSG 1641/);
});
test('an invalid reference is a loss naming the value, and the rest of the row is carried', () => {
  assert.equal(GENERIC_KINDS['generic-gridref-invalid'], 'loss');
  assert.ok(LOSS_TEXT['generic-gridref-invalid'] && LOSS_TEXT['generic-gridref-disagrees']);
  for (const v of ['TQ123', 'AA12', 'IA12', 'nowhere']) {
    const { a, reported } = read({ n: 'Somewhere', g: v }, { n: 'name', g: 'gridref' });
    assert.equal(reported.length, 1, v);
    assert.equal(reported[0][0], 'generic-gridref-invalid');
    assert.ok(reported[0][1].includes(`(${v})`) && reported[0][1].startsWith('row 2, g: '), reported[0][1]);
    assert.equal(a.attestation.geometries, undefined, v);
    assert.equal(a.label, 'Somewhere');
  }
});
test('with a latitude and longitude too, they win; the reference is a note, and a warning if the two disagree', () => {
  const m = { n: 'name', la: 'latitude', lo: 'longitude', g: 'gridref' };
  const g = gridRefToWgs84('TQ 30624 78388');
  // Agreeing: the latitude and longitude, the reference kept in the notes, nothing reported.
  const ok = read({ n: 'P', la: String(g.lat), lo: String(g.lon), g: 'TQ 30624 78388' }, m);
  assert.deepEqual(ok.reported, []);
  assert.equal(ok.a.attestation.geometries.length, 1);
  assert.deepEqual(ok.a.attestation.geometries[0].reprPoint, [g.lon, g.lat]);
  assert.equal(ok.a.attestation.geometries[0].sourceLabel, undefined);
  assert.match(ok.a.attestation.notes, /^g: TQ 30624 78388$/m);
  // Disagreeing by 1 km: warned, the latitude and longitude still used.
  const far = read({ n: 'P', la: '51.4983', lo: '-0.1199', g: 'TQ 30624 78388' }, m);
  assert.deepEqual(far.kinds, ['generic-gridref-disagrees']);
  assert.match(far.reported[0][1], /is 0\.99\d km from latitude 51\.4983, longitude -0\.1199/);
  assert.deepEqual(far.a.attestation.geometries.map((x) => x.reprPoint), [[-0.1199, 51.4983]]);
  assert.equal(GENERIC_KINDS['generic-gridref-disagrees'], 'warning');
  // Coarse coordinates allow more: 51.5, -0.1 (half a decimal place, about 5 km) is not warned of.
  assert.deepEqual(read({ n: 'P', la: '51.5', lo: '-0.1', g: 'TQ 30624 78388' }, m).reported, []);
  // An invalid reference beside coordinates: reported, kept as a note, the coordinates used.
  const bad = read({ n: 'P', la: '51.5', lo: '-0.1', g: 'TQ123' }, m);
  assert.deepEqual(bad.kinds, ['generic-gridref-invalid']);
  assert.match(bad.a.attestation.notes, /g: TQ123/);
  assert.equal(bad.a.attestation.geometries.length, 1);
});

// ---- through the engine ------------------------------------------------------------------------------
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('place-centric.schema.json'));
test('through the engine: a CSV of grid references, guessed, converted to PLATO JSON that is valid, with the bad one reported', async () => {
  const csv = 'id,name,grid ref\nbh,Box Hill,TQ 1751\nlb,Lambeth,TQ 30624 78388\ndb,Dublin,O 15 34\nxx,Nowhere,TQ123\n';
  const r = await go([textFile(csv, 'refs.csv')], 'convert', 'plato-json');
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items.filter((i) => i.severity === 'error')));
  const doc = JSON.parse(outText(r.e, Object.keys(r.e.outs)[0]));
  const v = ajv.getSchema('https://w3id.org/plato/schemas/place-centric.schema.json');
  assert.ok(v(doc), JSON.stringify(v.errors?.slice(0, 3)));
  const geo = (label) => doc.spatialEntities.find((p) => p.label === label).attestations?.[0]?.geometries;
  assert.equal(geo('Box Hill')[0].sourceLabel, 'TQ 1751');
  assert.deepEqual(geo('Dublin')[0].precisionKm, [0.707107]);
  assert.equal(geo('Nowhere'), undefined);
  const bad = r.report.items.find((i) => i.kind === 'generic-gridref-invalid');
  assert.ok(bad && bad.examples.some((e) => e.includes('(TQ123)')), JSON.stringify(bad));
});

// ---- review findings (#28) ---------------------------------------------------------------------------
test("a missing value's marker (R's NA, N/A, NULL, a dash) in a grid reference column is an empty cell: no location, nothing reported", async () => {
  // "NA" alone is otherwise the National Grid's 100 km square NA, in the Atlantic west of the Hebrides.
  assert.equal(parseGridRef('NA').error, undefined);
  for (const v of ['NA', 'na', 'N/A', 'n/a', 'NULL', '-']) {
    const { a, reported } = read({ n: 'x', g: v }, { n: 'name', g: 'gridref' });
    assert.deepEqual(reported, [], v);
    assert.equal(a.attestation.geometries, undefined, v);
    assert.equal(a.label, 'x', v);
  }
  // Control: a reference in the same column is converted.
  assert.equal(read({ n: 'x', g: 'TQ3380' }, { n: 'name', g: 'gridref' }).a.attestation.geometries.length, 1);
  // Through the engine, the column guessed from its heading.
  const csv = 'id,name,grid ref\na,Alpha,NA\nb,Beta,TQ3380\nc,Gamma,N/A\nd,Delta,SU1234\ne,Eps,NULL\nf,Zeta,TQ1751\ng,Eta,na\nh,Theta,NY2000\ni,Iota,-\n';
  const r = await go([textFile(csv, 'na.csv')], 'convert', 'plato-json');
  const doc = JSON.parse(outText(r.e, Object.keys(r.e.outs)[0]));
  const place = (label) => doc.spatialEntities.find((p) => p.label === label);
  for (const label of ['Alpha', 'Gamma', 'Eps', 'Eta', 'Iota']) {
    assert.ok(place(label), label);   // the row is carried...
    assert.equal(place(label).attestations?.[0]?.geometries, undefined, label);   // ...with no location
  }
  assert.deepEqual(r.report.items.filter((i) => i.kind.startsWith('generic-gridref')).map((i) => i.examples), []);
  // Control: the reference beside them is converted, to the square's centre in London.
  const beta = place('Beta').attestations[0].geometries[0];
  assert.equal(beta.sourceLabel, 'TQ3380');
  assert.ok(Math.abs(beta.reprPoint[1] - 51.508) < 0.01 && Math.abs(beta.reprPoint[0] + 0.078) < 0.01, JSON.stringify(beta));
});
