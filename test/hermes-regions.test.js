// Georeferenced Recogito regions (Hermes, pelagios/plato-tools#5): a Recogito export given with the
// IIIF Georeference Annotations of its maps (src/formats/regions.js, AnnotationReader.place). The
// constructed export and the constructed overlapping page are described in
// test/fixtures/annotations/README.md and test/fixtures/georef/README.md. Every kind is shown
// reported where it applies AND not reported where it does not (the control), and every placed
// point is compared with what src/engine/georef/ gives for the same pixels, not with numbers alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { annotationsToDocument, annotationsToDocumentPlaced, ANNOTATION_KINDS } from '../src/formats/annotations.js';
import { NO_ROLE_NOTE, SYMBOL_NOTE } from '../src/formats/regions.js';
import { readGeoreference, toWorld, georefNote, georefCitation, georefAnnotationCitation, LABEL_ANCHOR } from '../src/engine/georef/index.js';
import { detect, readable, GEOREF_REASON, MANIFEST_REASON } from '../src/engine/input.js';
import { LOSS_TEXT } from '../src/engine/report.js';
import { go, file, textFile, outText } from './engine.js';

const A = 'test/fixtures/annotations/', G = 'test/fixtures/georef/';
const REGIONS = A + 'recogito-studio-regions-constructed.json';
const ITEMS = JSON.parse(readFileSync(REGIONS, 'utf8'));
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ROCQUE = G + 'bpl-rocque-annotation.json', ROCQUE_M = G + 'bpl-rocque-manifest.json';
const LOC = G + 'loc-chesapeake-annotationpage.json', LOC_OVERLAP = G + 'loc-chesapeake-overlapping-constructed.json';
const CANVAS = 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/8623qf00m';
const id = (n) => `3b7e2f10-6c4d-4e5a-9f8b-${String(n).padStart(12, '0')}`;
const item = (n) => ITEMS.find((a) => a.id === id(n));

const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('attestation-centric.schema.json'));
ajv.addSchema(load('place-centric.schema.json'));
const AC = 'https://w3id.org/plato/schemas/attestation-centric.schema.json', PC = 'https://w3id.org/plato/schemas/place-centric.schema.json';
const valid = (schema, doc) => { const v = ajv.getSchema(schema); return v(doc) ? null : v.errors.slice(0, 3); };

/**
 * The export placed through the files given ({ georefs, manifests }: paths or Files):
 * { doc, reported: [[kind, example]], of(kind), attestation(n) }.
 */
async function placed({ georefs = [], manifests = [] }, items = ITEMS) {
  const reported = [];
  const f = (x) => (typeof x === 'string' ? file(x) : x);
  const doc = await annotationsToDocumentPlaced(items, 'regions.json', (k, e) => reported.push([k, e]), { georefs: georefs.map(f), manifests: manifests.map(f) });
  const of = (kind) => reported.filter(([k]) => k === kind).map(([, e]) => e);
  const attestation = (n) => doc.attestations.find((a) => a.notes?.includes(`urn:uuid:${id(n)}`));
  return { doc, reported, of, attestation };
}
const unplaced = () => {
  const reported = [];
  const doc = annotationsToDocument(ITEMS, 'regions.json', (k, e) => reported.push([k, e]));
  return { doc, reported, of: (kind) => reported.filter(([k]) => k === kind).map(([, e]) => e), attestation: (n) => doc.attestations.find((a) => a.notes?.includes(`urn:uuid:${id(n)}`)) };
};
const rocque = () => readGeoreference(json(ROCQUE), { manifest: json(ROCQUE_M) });
const exampleFor = (examples, n) => examples.filter((e) => e.startsWith(id(n)));

// ---- independent arithmetic -------------------------------------------------------------------------
/** Great-circle distance (haversine, mean Earth radius 6371.0088 km), written here, not imported. */
function km([a, b], [c, d]) {
  const rad = (x) => (x * Math.PI) / 180;
  const s = Math.sin(rad(d - b) / 2) ** 2 + Math.cos(rad(b)) * Math.cos(rad(d)) * Math.sin(rad(c - a) / 2) ** 2;
  return 2 * 6371.0088 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
/** A polygon's area centroid by a fan of triangles from its first vertex. */
function fanCentroid(points) {
  let area = 0, x = 0, y = 0;
  const [p0] = points;
  for (let i = 1; i + 1 < points.length; i++) {
    const [p1, p2] = [points[i], points[i + 1]];
    const t = ((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1])) / 2;
    area += t; x += (t * (p0[0] + p1[0] + p2[0])) / 3; y += (t * (p0[1] + p1[1] + p2[1])) / 3;
  }
  return [x / area, y / area];
}
const outlineVertices = (g) => (g.type === 'Polygon' ? g.coordinates.flat(1) : g.coordinates.flat(2));
/** What the reader must have written for a region with this centre, outline and role. */
async function expected(g, centre, outline, role, bbox) {
  const { geojson: point, record } = await toWorld(g, { type: 'Point', coordinates: centre }, { space: 'image', role });
  const { geojson: shape } = await toWorld(g, outline, { space: 'image' });
  const far = Math.max(...outlineVertices(shape).map((v) => km(point.coordinates, v)));
  return {
    geometry: { geojson: point, ...(role ? { role } : {}), precisionKm: [Math.ceil(far * 100 - 1e-9) / 100] },
    far,
    note: georefNote(record),
    citations: [georefCitation(record, { region: bbox }), georefAnnotationCitation(record)],
  };
}

// ---- the fixture ------------------------------------------------------------------------------------
test('the constructed export is in the shape Recogito Studio writes image annotations (key order, target, bodies)', () => {
  assert.equal(ITEMS.length, 16);
  for (const a of ITEMS) {
    assert.deepEqual(Object.keys(a), ['id', 'target', 'motivation', '@context', 'type', 'created', 'creator', 'body'], a.id);
    assert.deepEqual(Object.keys(a.target), ['source', 'type', 'selector'], a.id);
    assert.deepEqual(Object.keys(a.creator), ['id', 'name', 'avatar']);
    for (const b of a.body) assert.deepEqual(Object.keys(b).slice(0, 3), ['created', 'creator', 'purpose']);
  }
  // Annotorious writes an unrotated rectangle as a media fragment and a rotated one as SVG.
  assert.equal(item(1).target.selector.value, 'xywh=pixel:5120,5600,230,72');
  assert.match(item(3).target.selector.value, /^<svg><rect x="6932" y="5370" width="280" height="40" transform="rotate\(-11\.4591559026164\d* 7072 5390\)" \/><\/svg>$/);
});

// ---- detection ---------------------------------------------------------------------------------------
test('detect(): one export with georeferences and manifests is one input, in any order; the export alone has none', async () => {
  const group = await detect([file(ROCQUE), file(REGIONS), file(ROCQUE_M), file(LOC)]);
  assert.equal(group.format, 'w3c-annotations');
  assert.equal(group.shape, 'array');
  assert.equal(readable(group), true);
  assert.deepEqual(group.files.map((f) => f.name), ['recogito-studio-regions-constructed.json']);
  assert.deepEqual(group.georefs.map((f) => f.name), ['bpl-rocque-annotation.json', 'loc-chesapeake-annotationpage.json']);
  assert.deepEqual(group.manifests.map((f) => f.name), ['bpl-rocque-manifest.json']);
  const alone = await detect([file(REGIONS)]);
  assert.equal(alone.format, 'w3c-annotations');
  assert.equal('georefs' in alone || 'manifests' in alone, false, 'control: one file gives what it always gave');
});
test('detect(): two exports, a georeference or manifest alone, and an export with another kind of file are refused with a reason', async () => {
  const two = await detect([file(REGIONS), file(A + 'recogito-studio-constructed.json'), file(ROCQUE)]);
  assert.equal(two.format, null);
  assert.match(two.reason, /2 of the files chosen are annotation exports/);
  const lone = await detect([file(ROCQUE)]);
  assert.deepEqual([lone.format, lone.reason, readable(lone)], ['georef', GEOREF_REASON, false]);
  const manifest = await detect([file(ROCQUE_M)]);
  assert.deepEqual([manifest.format, manifest.reason, readable(manifest)], ['manifest', MANIFEST_REASON, false]);
  const noExport = await detect([file(ROCQUE), file(ROCQUE_M)]);
  assert.equal(noExport.format, null);
  assert.match(noExport.reason, /No Recogito export was chosen/);
  const other = await detect([file(REGIONS), file(ROCQUE), file('test/fixtures/lpf-readme-example.json')]);
  assert.equal(other.format, null);
  assert.match(other.reason, /lpf-readme-example\.json is neither/);
  // Control: the same export with only georeferences is accepted.
  assert.equal((await detect([file(REGIONS), file(ROCQUE)])).format, 'w3c-annotations');
});

// ---- no georeferences: exactly as before ---------------------------------------------------------------
// Digests of what the Recogito fixtures converted to, and what they reported, computed by digests()
// below on hermes-landing 5adecc1, before georeferenced regions existed (the same run twice gave the
// same digests). Only a change meant to alter how the Recogito reader reads these fixtures may
// change them.
const BEFORE = {
  'recogito-studio-constructed.json': ['e3d9a40ad81071be149abb6b17d5ef1f90b9ed38cdbcb9251da9f59f05b69c99', '0280424f635de0d76c00623313d72801b1585f943b465c80f835540dcfeb33de', '2a8275d88d0a87ff44b8d107d456edfe34feaddc017e89bc6d925fc04e995499', '2f9bedcfc081528db67baf8aa4fb3f3f4e3f6109466252806efd3bb9dc47102d'],
  'recogito-v1-constructed.jsonld': ['91016b7eb07c841d0d74d349a5249241e5f127d25a4c16581cf246d5c78ac604', 'ca3a4f96705f858a25f2ddaf350b4f63d6c39365ea3a7adfbbe4dcfe01e2194f', '3af4b1dcfba3de8e9b1d0c70f56115be28d2fde38b0aeec0e809a14437b34ce1', 'd06f2a8d646bd77be03ce2ef0e2423a8e158ff49bb1cd10a6fae5cd39d5f9bff'],
  'recogito-v1-islandia-map.jsonld': ['10cff5296782c5e53d19921fb8ec093bb08c40ca7d711b9ac2cf71bdc32e88dc', '1f1656a5bffd2497aedfbf349de12aeeb9703b6e60bcd8ed26ffd75c68da9d20', '562da1d629381f86b4371731ca14836cb60a61b1e9bc8c1284b3ad8b933725e5', '22973deb745e508a135798062d7cb890094d9737d4eb0178ea0d34ae9c78bb9d'],
  'recogito-v1-linked-traces-readme.json': ['0e304faa898f9ce4e60465be72e3ef2482544f82eb36f4ae2e32e3d303555ccc', '65070340e7495123455bef7001a6a92d664a321a28909cbc31b0ffa7a4da6677', 'ef1d9a69bbbc5bf7caabd36f9a8227af4128ce1b30a25bab1c7d20b76eb5ea2e', 'b2cb7d4098557ceb2f6190382f6493380be0aaccf76aa8383f77c186aaf7a2cc'],
  'recogito-v1-paulinus-csv.jsonld': ['bed4462f8cfa0d2689f35bf167f5d3b04c1d0dfdfa0c5a1fe6f56d75badb2286', '8077bbc89ea4c4a97e1e112c7d467ed97d4cd67a41498d8daf9e5d26332d39da', '7c5e53d3c2e397db1230db6b0db87eea4aa9daa9fdad0749308c803d19f81a86', '6895955ab58f1580d9958f74a11cb2bf618ae7afb2551394e8a7f3fe3917e793'],
  'recogito-v1-pliny-text.jsonld': ['fac33d058c83d724f3deb38da7678113e1602ef9457fc98a2096ec72954315ee', '4876189b9aac50da7df998eab982fb521de7a34f47cc1017fd5d6b8c3f8c2c97', '8705e3a107d1d2917aecfce2a098f4a99a6b9262bd1447291fc5e18e18fa3fcc', 'e232cb2dda2e8c90921cf407a95dc68a933899ca7ce2d87c461e737416283b9d'],
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
async function digests(f) {
  const reported = [];
  const doc = annotationsToDocument(json(A + f), f, (k, e) => reported.push([k, e]));
  const out = [sha(JSON.stringify({ doc, reported }))];
  for (const [t, ext] of [['plato-json', '.json'], ['plato-jsonl', '.jsonl'], ['ntriples', '.nt']]) {
    const r = await go([file(A + f)], 'convert', t);
    out.push(sha(outText(r.e, f.replace(/\.[^.]+$/, '') + ext) + '\n--report--\n' + JSON.stringify(r.report)));
  }
  return out;
}
test('without georeferences, the existing Recogito fixtures convert and report byte for byte as before', async () => {
  const existing = readdirSync(A).filter((f) => /\.json(ld)?$/.test(f) && f !== 'recogito-studio-regions-constructed.json').sort();
  assert.deepEqual(existing, Object.keys(BEFORE).sort(), 'every existing fixture is covered');
  for (const [f, want] of Object.entries(BEFORE)) assert.deepEqual(await digests(f), want, f);
  // Control: the comparison can fail (one fixture's digests are not another's).
  assert.notDeepEqual(await digests('recogito-v1-pliny-text.jsonld'), BEFORE['recogito-v1-islandia-map.jsonld']);
});
test('without georeferences the regions stay locators in words, and each SVG shape is reported as before', () => {
  const u = unplaced();
  assert.equal(u.doc.attestations.filter((a) => a.geometries).length, 0);
  assert.equal(u.of('annotation-selector').length, 4, 'the polygon, the rotated rectangle, the ellipse and the curve');
  assert.equal(u.reported.filter(([k]) => k.startsWith('annotation-region') || k.startsWith('annotation-georef')).length, 0);
  assert.equal(u.attestation(1).citations[0].locator, 'region at x 5120, y 5600, 230 by 72 pixels');
});
test('without georeferences Allmaps is never loaded; with them it is, once (in a process of its own)', () => {
  const script = `
    const { go, file } = await import(${JSON.stringify(new URL('./engine.js', import.meta.url).href)});
    const { allmapsImportCount } = await import(${JSON.stringify(new URL('../src/engine/georef/index.js', import.meta.url).href)});
    const before = allmapsImportCount();
    const a = await go([file(${JSON.stringify(REGIONS)})], 'convert', 'plato-json');
    const without = allmapsImportCount();
    const b = await go([file(${JSON.stringify(REGIONS)}), file(${JSON.stringify(ROCQUE)})], 'convert', 'plato-json');
    console.log(JSON.stringify({ before, without, with: allmapsImportCount(), attestations: [a.report.counts.attestations, b.report.counts.attestations] }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const counts = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(counts.attestations, [16, 16], 'both runs converted the export');
  assert.equal(counts.before, 0);
  assert.equal(counts.without, 0, 'no georeferences: nothing of Allmaps loaded');
  assert.equal(counts.with, 1, 'control: the counter moves when a georeference is used');
});

// ---- placed: the Rocque/Dury map, with its manifest -----------------------------------------------------
let main;
const MAIN = () => (main ??= placed({ georefs: [ROCQUE], manifests: [ROCQUE_M] }));
const rotated = (x, y, w, h, rot) => {
  const cx = x + w / 2, cy = y + h / 2, c = Math.cos(rot), s = Math.sin(rot);
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c]);
};
const bboxOf = (pts) => { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; };
const ring = (pts) => ({ type: 'Polygon', coordinates: [[...pts, pts[0]]] });
const ONTARIO = [[5524, 5352], [5906, 5350], [5908, 5410], [5522, 5414]];
const GEORGES = rotated(6932, 5370, 280, 40, -0.2);
// Each placed region: its centre worked out here, its outline, its role, and its pixel bbox.
const CASES = {
  1: { what: 'the rectangle round LAKE ERIE, with a transcription', centre: [5120 + 115, 5600 + 36], outline: { xywh: '5120,5600,230,72' }, role: LABEL_ANCHOR, bbox: [5120, 5600, 230, 72] },
  2: { what: 'the polygon round LAKE ONTARIO, with a quote', centre: fanCentroid(ONTARIO), outline: ring(ONTARIO), role: LABEL_ANCHOR, bbox: bboxOf(ONTARIO) },
  3: { what: 'the rotated rectangle along St Georges Bank', centre: [7072, 5390], outline: ring(GEORGES), role: LABEL_ANCHOR, bbox: bboxOf(GEORGES) },
  4: { what: 'the ellipse round LAKE HURON', centre: [5040, 5170], outline: { svg: item(4).target.selector.value }, role: LABEL_ANCHOR, bbox: [4850, 5138, 380, 64] },
  5: { what: 'Montreal, with no transcription', centre: [6140 + 70, 5074 + 16], outline: { xywh: '6140,5074,140,32' }, role: undefined, bbox: [6140, 5074, 140, 32] },
  6: { what: 'the Worcester symbol, tagged "symbol" (no role for now)', centre: [6358 + 7.5, 5510 + 7.5], outline: { xywh: '6358,5510,15,15' }, role: undefined, note: SYMBOL_NOTE, bbox: [6358, 5510, 15, 15] },
  8: { what: 'the loose box round "45", whose centre is on the map', centre: [188 + 96, 2190 + 30], outline: { xywh: '188,2190,192,60' }, role: LABEL_ANCHOR, bbox: [188, 2190, 192, 60] },
  9: { what: 'Boston, on the full-size picture', centre: [6278 + 60, 5480 + 15], outline: { xywh: '6278,5480,120,30' }, role: LABEL_ANCHOR, bbox: [6278, 5480, 120, 30] },
  16: { what: 'Albany, tagged "Label"', centre: [6096 + 55, 5482 + 14], outline: { xywh: '6096,5482,110,28' }, role: LABEL_ANCHOR, bbox: [6096, 5482, 110, 28] },
};
const NOTE = (c) => (c.role ? undefined : c.note ?? NO_ROLE_NOTE);
for (const [n, c] of Object.entries(CASES)) {
  test(`placed: ${c.what}: the point is toWorld of its centre, the radius holds its outline, the citations and note are georef's own`, async () => {
    const { attestation } = await MAIN();
    const g = await rocque();
    const want = await expected(g, c.centre, c.outline, c.role, c.bbox);
    const att = attestation(Number(n));
    assert.deepEqual(att.geometries, [want.geometry]);
    // The radius holds the whole outline, and is no more than 0.01 km beyond it.
    const radius = att.geometries[0].precisionKm[0];
    assert.ok(radius >= want.far && radius - want.far < 0.01 + 1e-9, `${radius} for ${want.far}`);
    assert.ok(want.far > 0.5, 'the outline is not a point');
    // The image's citation (as it is without georeferences) gives way to the map's, then the
    // georeference's: one evidence citation.
    const image = unplaced().attestation(Number(n)).citations;
    assert.equal(image.length, 1);
    assert.deepEqual(att.citations, want.citations);
    assert.equal(att.citations[0].citationFunction, 'http://purl.org/spar/cito/citesAsEvidence');
    assert.equal(att.citations[1].citationFunction, 'http://purl.org/spar/cito/usesMethodIn');
    assert.ok(!att.citations.some((x) => x.source['@id'] === image[0].source['@id']), 'the image is not cited as well');
    const notes = att.notes.split('\n');
    assert.ok(notes.includes(want.note), att.notes);
    assert.match(want.note, /retrieval date not recorded\./);
    assert.equal(want.note.includes('The position is where the map writes the name'), c.role === LABEL_ANCHOR, 'the label-anchor sentence exactly when the role is LabelAnchor');
    for (const x of [NO_ROLE_NOTE, SYMBOL_NOTE]) assert.equal(notes.includes(x), NOTE(c) === x, x);
    // The region in words goes to the notes where it says more than the canvas locator (a rectangle's
    // exact pixels); an SVG shape's words ("a shape drawn on the image") say nothing more.
    const words = `Drawn on the map: ${image[0].locator}.`;
    assert.equal(notes.includes(words), 'xywh' in c.outline, words);
    assert.equal(valid(AC, { profile: 'attestation-centric', gazetteer: { title: 't' }, attestations: [att] }), null);
  });
}
test('placed: the points differ from each other and lie where the map is (a control on the comparison above)', async () => {
  const { doc } = await MAIN();
  const points = doc.attestations.filter((a) => a.geometries).map((a) => a.geometries[0].geojson.coordinates);
  assert.equal(points.length, Object.keys(CASES).length);
  assert.equal(new Set(points.map((p) => p.join())).size, points.length);
  // (Not the "45" in the border, far from every control point, where the georeference is stretched.)
  for (const n of Object.keys(CASES).filter((k) => k !== '8')) {
    const [lon, lat] = (await MAIN()).attestation(Number(n)).geometries[0].geojson.coordinates;
    assert.ok(lon > -90 && lon < -60 && lat > 40 && lat < 47, `${n}: ${lon}, ${lat}`);
  }
  // Lake Erie's label is placed within 100 km of the lake's middle (-81.2, 42.2), Lake Ontario's of its (-77.9, 43.7).
  assert.ok(km((await MAIN()).attestation(1).geometries[0].geojson.coordinates, [-81.2, 42.2]) < 100);
  assert.ok(km((await MAIN()).attestation(2).geometries[0].geojson.coordinates, [-77.9, 43.7]) < 100);
});
test('placed: the whole document, and the PLATO JSON converted from it, are valid; the points survive the conversion', async () => {
  const { doc } = await MAIN();
  assert.equal(valid(AC, doc), null);
  const r = await go([file(REGIONS), file(ROCQUE), file(ROCQUE_M)], 'convert', 'plato-json');
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items.filter((i) => i.severity === 'error')));
  const pc = JSON.parse(outText(r.e, 'recogito-studio-regions-constructed.json'));
  assert.equal(valid(PC, pc), null);
  const geoms = pc.spatialEntities.flatMap((p) => p.attestations.flatMap((a) => a.geometries || []));
  assert.equal(geoms.length, Object.keys(CASES).length);
  assert.equal(geoms.filter((x) => x.role === LABEL_ANCHOR).length, 7);
  assert.equal(geoms.filter((x) => x.role !== undefined && x.role !== LABEL_ANCHOR).length, 0);
  const erie = pc.spatialEntities.find((p) => p['@id'] === 'http://www.wikidata.org/entity/Q5492').attestations.find((a) => a.geometries);
  assert.deepEqual(erie.geometries, (await MAIN()).attestation(1).geometries);
  // Control: the same export alone gives no geometry at all.
  const alone = await go([file(REGIONS)], 'convert', 'plato-json');
  const pc0 = JSON.parse(outText(alone.e, 'recogito-studio-regions-constructed.json'));
  assert.equal(pc0.spatialEntities.flatMap((p) => p.attestations.flatMap((a) => a.geometries || [])).length, 0);
  assert.equal(pc0.spatialEntities.length, pc.spatialEntities.length);
});

// ---- each kind, with its control -----------------------------------------------------------------------
test('every region kind has words, and a severity the report knows', () => {
  const kinds = Object.keys(ANNOTATION_KINDS).filter((k) => /^annotation-(region|georef|manifest)-/.test(k));
  assert.equal(kinds.length, 12);
  for (const k of kinds) { assert.ok(LOSS_TEXT[k], k); assert.ok(['loss', 'warning', 'error'].includes(ANNOTATION_KINDS[k]), k); }
});
test('annotation-region-shape: once for each placed region, and for nothing else', async () => {
  const { of } = await MAIN();
  const shapes = of('annotation-region-shape');
  assert.deepEqual(shapes.map((e) => e.slice(0, 36)).sort(), Object.keys(CASES).map((n) => id(n)).sort());
  assert.equal(ANNOTATION_KINDS['annotation-region-shape'], 'loss');
});
test('annotation-region-no-label-evidence: the region with no transcription, quote or "label" tag, and the symbol; not the others', async () => {
  const { of, attestation } = await MAIN();
  assert.deepEqual(of('annotation-region-no-label-evidence'), [id(5), id(6)]);
  assert.equal('role' in attestation(5).geometries[0], false);
  assert.equal(attestation(1).geometries[0].role, LABEL_ANCHOR, 'control: a transcription makes a label');
  assert.equal(attestation(2).geometries[0].role, LABEL_ANCHOR, 'control: a quote makes a label');
  assert.equal(attestation(16).geometries[0].role, LABEL_ANCHOR, 'control: a tag "Label" makes a label');
});
test('the tag conventions: "label" (any case, free or from a vocabulary) makes a label; "symbol" gives no role even beside a transcription', async () => {
  const six = item(6), five = item(5);
  const words = { created: six.created, creator: six.body[0].creator, purpose: 'transcribing', value: 'Worcester' };
  const vocabTag = (label) => ({ ...six.body[1], value: { label, id: `http://example.org/vocab/${label.replace(/ /g, '-')}` }, format: 'application/json' });
  const cases = [
    [{ ...six, body: [six.body[0], vocabTag('Map symbols'), words] }, null, SYMBOL_NOTE],
    [{ ...six, body: [six.body[0], words] }, LABEL_ANCHOR, null],
    [{ ...six, body: [six.body[0], { ...six.body[1], value: 'Symbolic' }] }, null, NO_ROLE_NOTE],
    [{ ...five, body: [five.body[0], { ...six.body[1], value: ' LABEL ' }] }, LABEL_ANCHOR, null],
    [{ ...five, body: [five.body[0], vocabTag('Map labels')] }, LABEL_ANCHOR, null],
    [{ ...five, body: [five.body[0], { ...six.body[1], value: 'labelled' }] }, null, NO_ROLE_NOTE],
  ];
  for (const [i, [a, role, note]] of cases.entries()) {
    const r = await placed({ georefs: [ROCQUE], manifests: [ROCQUE_M] }, [a]);
    const [att] = r.doc.attestations;
    assert.equal(att.geometries?.[0].role ?? null, role, `case ${i}`);
    for (const x of [NO_ROLE_NOTE, SYMBOL_NOTE]) assert.equal(att.notes.split('\n').includes(x), note === x, `case ${i}: ${x}`);
  }
});
test('annotation-region-outside-map: a centre outside the mask, wholly or partly; no geometry for either', async () => {
  const { of, attestation } = await MAIN();
  const out = of('annotation-region-outside-map');
  assert.equal(out.length, 2);
  assert.match(exampleFor(out, 7)[0], /has its centre outside the map .*56425c69f9cd4f1b, and lies wholly outside$/);
  assert.match(exampleFor(out, 15)[0], /has its centre outside the map .*, though part of it is inside$/);
  assert.equal(attestation(7).geometries, undefined);
  assert.equal(attestation(15).geometries, undefined);
  assert.ok(attestation(8).geometries, 'control: a region reaching outside with its centre inside is placed');
});
test('annotation-region-crosses-map-edge: the loose box whose centre is on the map, placed; not a region wholly inside', async () => {
  const { of, attestation } = await MAIN();
  const x = of('annotation-region-crosses-map-edge');
  assert.equal(x.length, 1);
  assert.match(x[0], new RegExp(`^${id(8)}: the rectangle xywh=pixel:188,2190,192,60 on .* reaches beyond the map .*56425c69f9cd4f1b$`));
  assert.ok(attestation(8).geometries);
  assert.equal(ANNOTATION_KINDS['annotation-region-crosses-map-edge'], 'warning');
  assert.equal(exampleFor(x, 1).length, 0, 'control: Lake Erie is wholly inside');
});
test('annotation-region-image-url: the picture address, with full size assumed for "max"; not for the canvas', async () => {
  const { of, attestation } = await MAIN();
  assert.deepEqual(of('annotation-region-image-url'), [`${id(9)}: https://iiif.digitalcommonwealth.org/iiif/2/commonwealth:8623qf00m/full/max/0/default.jpg (size "max": the full size was assumed)`]);
  assert.ok(attestation(9).geometries, 'it is placed');
  assert.equal(ANNOTATION_KINDS['annotation-region-image-url'], 'warning');
  // A picture at size "full" is the whole image, so nothing is assumed.
  const full = { ...item(9), target: { ...item(9).target, source: item(9).target.source.replace('/full/max/', '/full/full/') } };
  const r = await placed({ georefs: [ROCQUE] }, [full]);
  assert.deepEqual(r.of('annotation-region-image-url'), [`${id(9)}: https://iiif.digitalcommonwealth.org/iiif/2/commonwealth:8623qf00m/full/full/0/default.jpg`]);
});
test('annotation-region-no-georef: a cropped picture (saying why), the second sheet, and a map whose georeference was not given', async () => {
  const { of, attestation } = await MAIN();
  const none = of('annotation-region-no-georef');
  assert.equal(none.length, 3);
  assert.match(exampleFor(none, 10)[0], /is a cropped picture of the image https:\/\/iiif\.digitalcommonwealth\.org\/iiif\/2\/commonwealth:8623qf00m/);
  assert.match(exampleFor(none, 12)[0], /canvas\/qr46xn78z, which no georeference given is for/);
  assert.match(exampleFor(none, 14)[0], /ct008615, which no georeference given is for/);
  for (const n of [10, 12, 14]) assert.equal(attestation(n).geometries, undefined);
});
test('annotation-region-not-iiif: a region on a Recogito v1 document; not one on a IIIF canvas', async () => {
  const { of } = await MAIN();
  assert.deepEqual(of('annotation-region-not-iiif'), [`${id(13)}: the rectangle xywh=pixel:1200,800,300,60 on https://recogito.pelagios.org/part/7d2c4e1a-0b3f-4a5e-9c8d-1e2f3a4b5c6d`]);
});
test('annotation-region-unplaced: a curved outline, with the reason; the run goes on', async () => {
  const { of, attestation } = await MAIN();
  const u = of('annotation-region-unplaced');
  assert.equal(u.length, 1);
  assert.match(u[0], new RegExp(`^${id(11)}: an SVG shape on .*: The SVG path uses the command "C"`));
  assert.equal(attestation(11).geometries, undefined);
  assert.ok(attestation(12), 'annotations after it were read');
});
test('annotation-region-ambiguous: inside both masks of the constructed page, naming both; inside one of the real page, placed', async () => {
  const both = await placed({ georefs: [LOC_OVERLAP] });
  const amb = both.of('annotation-region-ambiguous');
  assert.equal(amb.length, 1);
  assert.match(amb[0], new RegExp(`^${id(14)}: the rectangle xywh=pixel:2750,5000,100,40 on .* is inside 2 maps: `));
  assert.ok(amb[0].includes('https://example.org/constructed/loc-chesapeake-overlapping/7b478a66b60e91b3') && amb[0].includes('https://annotations.allmaps.org/maps/d1e107975cac64ec'), amb[0]);
  assert.equal(both.attestation(14).geometries, undefined);
  // Control: the real page, whose masks do not overlap, places the same region through its second map.
  const real = await placed({ georefs: [LOC] });
  assert.deepEqual(real.of('annotation-region-ambiguous'), []);
  const att = real.attestation(14);
  assert.equal(att.geometries.length, 1);
  assert.equal('role' in att.geometries[0], false, 'no transcription: no role');
  assert.equal(att.citations[1].source['@id'], 'https://annotations.allmaps.org/maps/d1e107975cac64ec');
  // No manifest: the canvas's size is unknown, so the region is cited on the image, in image pixels.
  assert.match(att.citations[0].locator, /^https:\/\/tile\.loc\.gov\/image-services\/iiif\/service:gmd:gmd384:g3842:g3842c:ct008615#xywh=\d+,\d+,\d+,\d+$/);
  // The real page's masks really do not overlap: a region between them is in neither.
  const gap = { ...item(14), target: { ...item(14).target, selector: { ...item(14).target.selector, value: 'xywh=pixel:2450,5000,100,40' } } };
  assert.match((await placed({ georefs: [LOC] }, [gap])).of('annotation-region-outside-map')[0], /has its centre outside each of the maps .*7b478a66b60e91b3; .*d1e107975cac64ec, and lies wholly outside$/);
});
test('annotation-georef-unused: a map that placed nothing is named; the maps that placed something are not', async () => {
  const r = await placed({ georefs: [ROCQUE, LOC], manifests: [ROCQUE_M] });
  const unused = r.of('annotation-georef-unused');
  assert.equal(unused.length, 1);
  assert.match(unused[0], /https:\/\/annotations\.allmaps\.org\/maps\/7b478a66b60e91b3 \(loc-chesapeake-annotationpage\.json\)$/);
  assert.ok(r.attestation(14).geometries, 'the other map on the page placed the Chesapeake region');
  assert.ok(r.attestation(1).geometries, 'and the Rocque map its regions');
});
test('annotation-georef-unreadable: a broken georeference or manifest is an error, and the run goes on with the rest', async () => {
  const r = await placed({ georefs: [textFile('{"type": "Annotation", ', 'broken.json'), textFile(JSON.stringify({ type: 'Annotation', motivation: 'painting' }), 'painting.json'), ROCQUE], manifests: [textFile('[1, 2', 'broken-manifest.json')] });
  const bad = r.of('annotation-georef-unreadable');
  assert.equal(bad.length, 3, bad.join('\n'));
  assert.match(bad.find((e) => e.startsWith('broken.json')), /^broken\.json: it is not well-formed JSON/);
  assert.match(bad.find((e) => e.startsWith('painting.json')), /^painting\.json: .*not "georeferencing"/);
  assert.match(bad.find((e) => e.startsWith('broken-manifest.json')), /^broken-manifest\.json: it is not well-formed JSON/);
  assert.equal(ANNOTATION_KINDS['annotation-georef-unreadable'], 'error');
  assert.ok(r.attestation(1).geometries, 'control: the good georeference still placed its regions');
  // With no georeference readable at all, every region is one no georeference is for.
  const none = await placed({ georefs: [textFile('nope', 'nope.json')] });
  assert.equal(none.of('annotation-region-no-georef').length, 15, 'every region but the one on a Recogito v1 document');
  assert.equal(none.of('annotation-region-not-iiif').length, 1);
});
test('annotation-manifest-unused: a manifest of another object; the map\'s own manifest is used and not named', async () => {
  const r = await placed({ georefs: [ROCQUE], manifests: [ROCQUE_M, G + 'lynn-atlas-manifest.json'] });
  assert.deepEqual(r.of('annotation-manifest-unused'), ['lynn-atlas-manifest.json']);
  assert.match(r.attestation(1).notes, /of manifest https:\/\/ark\.digitalcommonwealth\.org\/ark:\/50959\/ks65px29g\/manifest\./);
  // A manifest given without any georeference: named, and nothing is placed.
  const alone = await go([file(REGIONS), file(ROCQUE_M)], 'check');
  assert.deepEqual(alone.report.items.find((i) => i.kind === 'annotation-manifest-unused')?.examples, ['bpl-rocque-manifest.json']);
  assert.equal(alone.report.items.filter((i) => i.kind.startsWith('annotation-region')).length, 0);
});
test('with georeferences, an SVG shape is reported by its region kind, never also as annotation-selector, and never dropped', async () => {
  const { of, reported } = await MAIN();
  assert.deepEqual(of('annotation-selector'), []);
  // The four SVG shapes (2, 3, 4 placed; 11 unplaced) each have a region kind.
  for (const n of [2, 3, 4, 11]) assert.ok(reported.some(([k, e]) => k.startsWith('annotation-region') && e.startsWith(id(n))), n);
  assert.equal(unplaced().of('annotation-selector').length, 4, 'control: without georeferences they are reported as before');
  // An annotation that cannot be converted (a second target with no source) is not placed, so its
  // shape is reported as annotation-selector, as it would be without georeferences.
  const broken = { ...item(2), target: [item(2).target, { selector: { type: 'FragmentSelector', value: 'xywh=pixel:1,1,2,2' } }] };
  const r = await placed({ georefs: [ROCQUE] }, [broken]);
  assert.deepEqual(r.of('annotation-selector'), ['SvgSelector: the shape drawn on the image']);
  assert.equal(r.of('annotation-malformed').length, 1);
});
test('an annotation linking one region to two places gives both attestations the point, and reports the shape once', async () => {
  const one = item(1);
  const two = { ...one, body: [...one.body, { ...one.body[0], value: { ...one.body[0].value, id: 'http://www.wikidata.org/entity/Q1163' } }] };
  const r = await placed({ georefs: [ROCQUE], manifests: [ROCQUE_M] }, [two]);
  assert.equal(r.doc.attestations.length, 2);
  assert.deepEqual(r.doc.attestations[0].geometries, r.doc.attestations[1].geometries);
  assert.notEqual(r.doc.attestations[0].geometries, r.doc.attestations[1].geometries, 'not one object shared');
  assert.equal(r.of('annotation-region-shape').length, 1);
});

// ---- the command line ------------------------------------------------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
test('--georef and --manifest: the command line writes what the engine gives for the files dropped together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-tools-regions-'));
  try {
    const r = cli('convert', '--to', 'plato-json', '--out', dir, '--georef', ROCQUE, '--manifest', ROCQUE_M, REGIONS);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /W3C Web Annotations \(as Recogito exports them\), with 1 georeference and 1 IIIF manifest to place its regions/);
    const written = readFileSync(join(dir, 'recogito-studio-regions-constructed.json'), 'utf8');
    const engine = await go([file(REGIONS), file(ROCQUE), file(ROCQUE_M)], 'convert', 'plato-json');
    assert.equal(written, outText(engine.e, 'recogito-studio-regions-constructed.json'));
    assert.ok(written.includes(LABEL_ANCHOR));
    // Control: without the flags, the same export gives no point.
    const plain = cli('convert', '--to', 'plato-json', '--out', dir, '--overwrite', REGIONS);
    assert.equal(plain.code, 0, plain.out + plain.err);
    assert.ok(!readFileSync(join(dir, 'recogito-studio-regions-constructed.json'), 'utf8').includes(LABEL_ANCHOR));
    // Repeatable: two georeferences, as a JSON line saying which were given.
    const two = cli('check', '--json', '--georef', ROCQUE, '--georef', LOC, REGIONS);
    assert.equal(two.code, 0, two.out + two.err);
    const line = JSON.parse(two.out.split('\n')[0]);
    assert.deepEqual(line.georefs, [ROCQUE, LOC]);
    assert.ok(line.items.some((i) => i.kind === 'annotation-georef-unused'), 'the Chesapeake page\'s first map placed nothing');
    assert.ok(!line.items.some((i) => i.kind === 'annotation-region-no-georef' && i.examples.some((e) => e.startsWith(id(14)))), 'its second placed region 14');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('--georef and --manifest: a usage error (exit 2) with anything but a Recogito export, with compare, for a missing file, or a manifest alone', () => {
  const lpf = cli('check', '--georef', ROCQUE, 'test/fixtures/lpf-readme-example.json');
  assert.equal(lpf.code, 2);
  assert.match(lpf.err, /--georef and --manifest are for a Recogito export \(W3C Web Annotations\), and test\/fixtures\/lpf-readme-example\.json is a Linked Places Format FeatureCollection/);
  assert.equal(cli('check', 'test/fixtures/lpf-readme-example.json').code, 0, 'control: the same file checks without the flag');
  const cmp = cli('compare', '--georef', ROCQUE, REGIONS, REGIONS);
  assert.equal(cmp.code, 2);
  assert.match(cmp.err, /are for check and convert/);
  const missing = cli('check', '--georef', 'no-such-georef.json', REGIONS);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no-such-georef\.json, given with --georef or --manifest, cannot be read: there is no such file/);
  const manifestOnly = cli('check', '--manifest', ROCQUE_M, REGIONS);
  assert.equal(manifestOnly.code, 2);
  assert.match(manifestOnly.err, /give the georeference too/);
  assert.match(cli('--help').out, /--georef FILE/);
});
