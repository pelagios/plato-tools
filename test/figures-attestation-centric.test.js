import { PLATO_REPO } from './paths.js';
// Figures in an attestation-centric document (census figures as a Data Cube, plan #34 item 11,
// design section 6: "Not known: whether the cube export ... behave[s] identically on
// attestation-centric figures"). The figures reader writes one attestation per source row, each
// about its place, so the cube export and the Data Cube checks must give what they give for PLATO's
// own example, where one attestation carries a county's whole table. This is the first test of
// the branch: it settles whether the reader may write attestation-centric output (it may) or must
// group by place first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { go, outText, textFile } from './engine.js';
import { integrity } from './datacube.js';

const STATS = `${PLATO_REPO}/schemas/examples/place-centric-statistics.json`;
test('PLATO\'s statistics example is there to test against', () => {
  assert.ok(existsSync(STATS), `${STATS} not found: set PLATO_REPO to a checkout of PLATO at the pinned commit`);
});
const EXAMPLE = existsSync(STATS) ? JSON.parse(readFileSync(STATS, 'utf8')) : null;
const doc = () => structuredClone(EXAMPLE);
const cube = async (d, name) => {
  const r = await go([textFile(JSON.stringify(d), name)], 'convert', 'ntriples', { cube: true });
  return { r, text: outText(r.e, name.replace(/\.json$/, '.nt')) };
};
const lines = (nt) => nt.split('\n').filter(Boolean);
const summary = (nt) => integrity(nt).map((x) => [x.ic, x.status, x.evaluated, x.violations.length]);

/**
 * The example as the figures reader writes it: attestation-centric, each figure in an attestation of
 * its own (a source row), every attestation about its county, the county a new place with none.
 */
function perRow(d, { counties = ['Example County'] } = {}) {
  const { spatialEntities, ...head } = d;
  const county = spatialEntities[0], [att] = county.attestations;
  const attestations = [], places = [];
  counties.forEach((label, c) => {
    const about = c ? `${county['@id']}-${c}` : county['@id'];
    places.push({ '@id': about, label, attestations: [] });
    att.properties.forEach((p, i) => {
      attestations.push({
        about, timespans: att.timespans, citations: [{ source: att.citations[0].source, locator: `row ${c * 10 + i + 2}` }],
        properties: [c ? { ...p, '@id': `${p['@id']}-${c}`, ...(p.universe ? { universe: `${p.universe}-${c}` } : {}) } : p],
      });
    });
  });
  return { ...head, $schema: undefined, profile: 'attestation-centric', attestations, newSpatialEntities: places };
}

test('one attestation to a figure, all about one place: the cube is the example\'s, and the five checks pass over their counts', async () => {
  const want = await cube(doc(), 'place.json'), got = await cube(perRow(doc()), 'rows.json');
  assert.deepEqual(got.r.report.items.filter((i) => ['error', 'warning', 'loss'].includes(i.severity)), []);
  assert.deepEqual(want.r.report.items.filter((i) => ['error', 'warning', 'loss'].includes(i.severity)), []);
  // The same statements about the figures, whichever way the document was grouped: attestations
  // have other addresses, so those lines are set aside, and what is compared is every line
  // that names a figure, a table or the cube's own terms.
  const figureLines = (nt) => lines(nt).filter((l) => /\/table\/|purl\.org\/linked-data/.test(l) && !/attests_|has_citation|sourced_by/.test(l)).sort();
  assert.ok(figureLines(want.text).length > 40, 'the comparison has lines to compare');
  assert.deepEqual(figureLines(got.text), figureLines(want.text));
  const s = summary(got.text);
  assert.deepEqual(s, [['IC-1', 'pass', 5, 0], ['IC-2', 'pass', 1, 0], ['IC-11', 'pass', 20, 0], ['IC-12', 'pass', 5, 0], ['IC-14', 'pass', 4, 0]]);
  assert.deepEqual(s, summary(want.text));
});

test('every figure has its place and its year (refArea and refPeriod) though its attestation holds that one figure only', async () => {
  const { text } = await cube(perRow(doc()), 'rows.json');
  const area = lines(text).filter((l) => /^\S+ <[^>]*dimension#refArea> /.test(l)), period = lines(text).filter((l) => /^\S+ <[^>]*dimension#refPeriod> /.test(l));
  assert.equal(area.length, 5); assert.equal(period.length, 5);
  assert.ok(period.every((l) => l.endsWith('"1851"^^<http://www.w3.org/2001/XMLSchema#gYear> .')), period.join('\n'));
});

test('two places, each with its rows: the same figure for two places is two observations, not a duplicate', async () => {
  const { text } = await cube(perRow(doc(), { counties: ['Example County', 'Other County'] }), 'rows.json');
  assert.deepEqual(summary(text), [['IC-1', 'pass', 10, 0], ['IC-2', 'pass', 1, 0], ['IC-11', 'pass', 40, 0], ['IC-12', 'pass', 10, 0], ['IC-14', 'pass', 8, 0]]);
});

test('control: the same coordinates twice for one place and year, in two attestations, are found as a duplicate', async () => {
  const d = perRow(doc());
  // A second row for the male agricultural figure, under another address (a row read twice).
  const twin = structuredClone(d.attestations[2]);
  twin.properties[0]['@id'] += '-again'; delete twin.properties[0].universe;
  d.attestations.push(twin);
  const { text } = await cube(d, 'rows.json');
  const s = summary(text);
  assert.equal(s.find((x) => x[0] === 'IC-12')[1], 'fail', JSON.stringify(s));
  assert.equal(s.find((x) => x[0] === 'IC-12')[3], 1);
});

test('control: a figure whose table has no structure is found by IC-2, not passed over, in this shape too', async () => {
  const d = perRow(doc());
  delete d.dataSets[0].structure;
  const { text } = await cube(d, 'rows.json');
  assert.equal(integrity(text).find((x) => x.ic === 'IC-2').status, 'fail');
});
