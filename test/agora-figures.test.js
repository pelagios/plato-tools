// Agora and the figures of a statistical table (PLATO issue #14; plan #34 item 11, stage B3). A figure
// is a number at an address in its table: a county has no "persons: 280", its male agricultural
// labourers do. The site's place page once printed every property as "label: value", so a figure
// read as a fact of the place with its coordinates dropped, the one statement #14 was designed to
// prevent; and its N-Triples download left the figures without their Data Cube. These tests hold the
// page to saying the coordinates, the table and the universe, to saying so when the coordinates are
// missing, and the site to a cube download (only where the dataset holds figures) whose figure
// addresses lead to their place's page.
//
// Every absence asserted is paired with a presence in the same test: the figures are on the page and
// in the cube, an ordinary property is still printed as it was, and a dataset with no figures is
// published the same way, so a site that was never written, or a search that finds nothing, cannot pass.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { res, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { publish } from '../src/engine/agora/index.js';
import { NodeHost } from '../src/node/host.js';
import { graph, checks } from '../src/lib/datacube.js';

const BASE = 'https://w3id.org/test-fig/';
const SDMX_DIM = 'http://purl.org/linked-data/sdmx/2009/dimension#';
const QB = 'http://purl.org/linked-data/cube#';
const TABLE = BASE + 'table/occupations-1851';
const OCC = BASE + 'dim/occupation', SEX = SDMX_DIM + 'sex';
const PERSONS = BASE + 'measure/persons';
const COUNTY = BASE + 'place/example-county';
const code = (c) => ({ '@id': BASE + 'code/' + c });
const dir = mkdtempSync(join(tmpdir(), 'plato-tools-figures-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let runs = 0;

/**
 * One county's figures, as a census table gives them, each with an address that is a fragment of the
 * county's (as the figures reader will mint them): a total, a part of it and its male part (each the
 * next one's universe), a printed dash, a figure with no coordinates at all, a figure given an
 * occupation but not the table's other coordinate (sex), and an ordinary property beside them.
 */
function figuresDataset({ figures = true } = {}) {
  const fig = (id, extra) => ({ '@id': `${COUNTY}#f-${id}`, property: PERSONS, label: 'persons', dataSet: TABLE, ...extra });
  const properties = [
    fig('total', { value: 1000, dimensions: { [OCC]: code('all'), [SEX]: code('sex-T') } }),
    fig('agri', { value: 300, dimensions: { [OCC]: code('agricultural-labourer'), [SEX]: code('sex-T') }, universe: `${COUNTY}#f-total` }),
    fig('agri-m', { value: 280, dimensions: { [OCC]: code('agricultural-labourer'), [SEX]: code('sex-M') }, universe: `${COUNTY}#f-agri` }),
    fig('miner-f', { dimensions: { [OCC]: code('miner'), [SEX]: code('sex-F') }, attributes: { [SDMX_DIM.replace('dimension', 'attribute') + 'obsStatus']: code('nil-or-not-applicable') }, sourceLabel: '—' }),
    fig('nowhere', { value: 77 }),
    fig('half', { value: 12, dimensions: { [OCC]: code('weaver') } }),
    { property: BASE + 'measure/elevation', label: 'elevation', value: 12.5, unit: 'http://www.wikidata.org/entity/Q11573' },
  ];
  // The tables come before the places: the tools read a document's header first.
  const tables = [{
    '@id': TABLE, title: 'Occupations of persons aged 20 and over, 1851', isPartOf: BASE + 'source/census-1851',
    structure: { '@id': TABLE + '/structure', components: [{ dimension: SDMX_DIM + 'refArea' }, { dimension: SDMX_DIM + 'refPeriod' }, { dimension: OCC }, { dimension: SEX }, { measure: PERSONS }] },
  }];
  const doc = {
    profile: 'place-centric',
    gazetteer: { '@id': BASE, title: figures ? 'Occupations (test)' : 'No figures (test)', uriSpace: BASE, status: 'published', version: '1', licence: 'https://creativecommons.org/licenses/by/4.0/' },
    ...(figures ? { dataSets: tables } : {}),
    spatialEntities: [{
      '@id': COUNTY, label: 'Example County',
      attestations: [{
        '@id': COUNTY + '#a-00000001',
        ...(figures ? { properties } : { names: [{ toponym: 'Example County' }] }),
        timespans: [{ startEarliest: '1851', endLatest: '1851', sourceLabel: '1851' }],
        citations: [{ source: { '@id': BASE + 'source/census-1851', title: 'Census of Great Britain, 1851' }, locator: 'Table 1' }],
      }],
    }],
  };
  return doc;
}

async function site(doc, options = {}) {
  const host = new NodeHost({ outDir: join(dir, `run-${++runs}`) });
  const { env } = host.env(res);
  const r = await publish({ part: 'site', input: await detect([textFile(JSON.stringify(doc), 'figures.json')]), options }, env);
  host.cleanup();
  const siteDir = r.outputs[0]?.path;
  assert.ok(siteDir, `no site: ${JSON.stringify(r.report.items.map((i) => [i.severity, i.kind, i.examples?.[0]]))}`);
  return {
    r, siteDir, kinds: r.report.items.map((i) => i.kind),
    has: (p) => !!siteDir && existsSync(join(siteDir, p)),
    read: (p) => readFileSync(join(siteDir, p), 'utf8'),
    downloads: () => readdirSync(join(siteDir, 'download')),
  };
}
/** The element of a page with this id, as far as its closing tag. */
const element = (html, id) => {
  const at = html.indexOf(` id="${id}"`);
  assert.ok(at >= 0, `no element with id ${id}`);
  const start = html.lastIndexOf('<', at);
  return html.slice(start, html.indexOf('</li>', at));
};
const pageOf = async (opts) => { const s = await site(figuresDataset(), opts); return { s, html: s.read('place/example-county/index.html') }; };

test('a figure with its coordinates is shown with them, its table and its universe, never as "label: value"', async () => {
  const { s, html } = await pageOf();
  assert.ok(s.has('place/example-county/index.html'));
  // The male agricultural labourers: the value, with the coordinates that make it a statement.
  const m = element(html, 'f-agri-m');
  assert.match(m, /<strong>280<\/strong>/);
  assert.match(m, /persons/);
  assert.match(m, /occupation[^<]*<\/[a-z]+>[^<]*agricultural labourer|occupation:?\s[^;<]*agricultural labourer/i);
  assert.match(m, /sex[^;]*sex-M/i);
  // Its universe is a link to the figure it is a part of, on this page.
  assert.match(m, /href="[^"]*#f-agri"/);
  // The table is named once, with its title, for the figures under it.
  assert.match(html, /Occupations of persons aged 20 and over, 1851/);
  // The place and the date are the attestation's: the page says so.
  assert.match(html, /place and date are this attestation's|this attestation's place and date/i);
  // The bare form that said a county has 280 persons is nowhere on the page, in any markup.
  assert.doesNotMatch(html, /persons<\/a>:\s*280|persons:\s*280|persons<\/[a-z]+>:\s*280/);
  assert.doesNotMatch(html, /persons<\/a>:\s*(1000|300)\b/);
  // The control: a property that is not a figure is printed as it always was.
  assert.match(html, /elevation<\/a>: 12\.5/);
});

test('a printed dash is shown as a dash with its status, never as a value', async () => {
  const { html } = await pageOf();
  const e = element(html, 'f-miner-f');
  assert.match(e, /no value|not given/i);
  assert.match(e, /nil or not applicable|nil-or-not-applicable/i);
  assert.doesNotMatch(e, /<strong>0<\/strong>/);
  assert.match(e, /“—”/);
});

test('a figure with no coordinates says so, and prints no bare value', async () => {
  const { html } = await pageOf();
  // The figure is on the page (presence), says what is missing, and is not the place's property.
  const at = html.indexOf('77');
  assert.ok(at >= 0, 'the figure is on the page');
  const e = element(html, 'f-nowhere');
  assert.match(e, /no coordinates/i);
  assert.match(e, /not (a|the) (statement|property)|not to be read as|says nothing (of|about) what this place has/i);
  assert.doesNotMatch(html, /persons<\/a>:\s*77|persons:\s*77/);
  assert.doesNotMatch(e, /<strong>77<\/strong>/);
});

test("a figure that lacks one of its table's coordinates names the one it lacks", async () => {
  const { html } = await pageOf();
  const e = element(html, 'f-half');
  assert.match(e, /weaver/);
  assert.match(e, /sex[^.]*(not given|missing|unknown)|(not given|missing|no)[^.]*sex/i);
  assert.doesNotMatch(html, /persons<\/a>:\s*12\b|persons:\s*12\b/);
  // A figure that has every coordinate its table declares is not told it lacks one.
  assert.doesNotMatch(element(html, 'f-agri-m'), /not given|missing/i);
});

test("a figure's address is a fragment of its place's page: the element it leads to is there", async () => {
  const { html } = await pageOf();
  for (const id of ['f-total', 'f-agri', 'f-agri-m', 'f-miner-f', 'f-nowhere', 'f-half']) assert.ok(html.includes(` id="${id}"`), id);
  // The attestation's own anchor is still there beside them.
  assert.ok(html.includes(' id="a-00000001"'));
});

test("a figure's JSON-LD is unchanged: the page's words are not a second record of it", async () => {
  const { s } = await pageOf();
  const doc = JSON.parse(s.read('place/example-county.jsonld'));
  const props = doc.spatialEntities[0].attestations[0].properties;
  assert.equal(props.length, 7);
  assert.equal(props.find((p) => p['@id'].endsWith('#f-agri-m')).value, 280);
});

test('the cube download is made where the dataset holds figures, and not where it holds none', async () => {
  const withFigures = await site(figuresDataset());
  const file = withFigures.downloads().find((f) => /-cube\.nt\.gz$/.test(f));
  assert.ok(file, `no cube download among ${withFigures.downloads()}`);
  // Beside the others, listed on the landing page, and where the 404 page points.
  assert.ok(withFigures.downloads().some((f) => /\.jsonl\.gz$/.test(f)) && withFigures.downloads().some((f) => /[^e]\.nt\.gz$/.test(f)));
  assert.ok(withFigures.read('index.html').includes(`download/${file}`));
  assert.ok(withFigures.read('404.html').includes(`download/${file}`));
  const without = await site(figuresDataset({ figures: false }));
  assert.ok(without.has('place/example-county/index.html') && without.downloads().some((f) => /\.jsonl\.gz$/.test(f)), 'the site was made');
  assert.ok(!without.downloads().some((f) => /cube/.test(f)));
  assert.doesNotMatch(without.read('index.html'), /cube/i);
});

test('the cube download is a Data Cube that passes its integrity checks, and its figure addresses lead to the place page', async () => {
  const s = await site(figuresDataset());
  const nt = gunzipSync(readFileSync(join(s.siteDir, 'download', s.downloads().find((f) => /-cube\.nt\.gz$/.test(f))))).toString('utf8');
  // The figures are observations, with the measure, the area and the period the page's data does not repeat.
  assert.match(nt, new RegExp(`<${COUNTY}#f-agri-m> <http://www\\.w3\\.org/1999/02/22-rdf-syntax-ns#type> <${QB}Observation>`));
  assert.ok(nt.includes(`<${COUNTY}#f-agri-m> <${PERSONS}> "280"`), 'the measure statement');
  assert.ok(nt.includes(`<${COUNTY}#f-agri-m> <${SDMX_DIM}refArea> <${COUNTY}>`), 'refArea');
  assert.match(nt, new RegExp(`<${COUNTY}#f-agri-m> <${SDMX_DIM}refPeriod> "1851"`));
  // Without the cube, the plain download has no observations (the control: the difference is the cube's).
  const plain = gunzipSync(readFileSync(join(s.siteDir, 'download', s.downloads().find((f) => /[^e]\.nt\.gz$/.test(f))))).toString('utf8');
  assert.ok(!plain.includes(QB + 'Observation'));
  // Every figure is a place-page fragment, and the element is on the page it leads to.
  const html = s.read('place/example-county/index.html');
  const ids = [...nt.matchAll(new RegExp(`^<(${COUNTY}#[^>]+)> <http://www\\.w3\\.org/1999/02/22-rdf-syntax-ns#type> <${QB}Observation>`, 'gm'))].map((m) => m[1]);
  assert.ok(ids.length >= 5, `observations: ${ids.length}`);
  for (const id of ids) assert.ok(html.includes(` id="${id.split('#')[1]}"`), id);
  // The integrity checks have something to check, and the figures that carry every coordinate pass IC-1, IC-2 and IC-14 (the
  // table's coordinates are not all given by the two figures made faulty on purpose, which IC-11 finds).
  const c = Object.fromEntries(checks(graph(nt)).map((x) => [x.ic, x]));
  for (const ic of ['IC-1', 'IC-2', 'IC-14']) assert.equal(c[ic].status, 'pass', ic);
  assert.equal(c['IC-11'].status, 'fail', 'the two figures without all their coordinates are found');
  assert.equal(c['IC-11'].violations.length, 2);
});

test('the estimate holds for a site of figures: 1 to 1.3 times what is written, cube download included', async () => {
  // A county of some 500 figures (Vision of Britain's shape), several counties, so that the figures are most of the site.
  const doc = figuresDataset();
  const one = doc.spatialEntities[0];
  const codes = Array.from({ length: 125 }, (_, i) => `occ-${i}`);
  const make = (n) => {
    const iri = `${BASE}place/county-${n}`;
    const properties = codes.flatMap((c) => ['sex-M', 'sex-F', 'sex-T', 'sex-X'].map((x) => ({
      '@id': `${iri}#f-${c}-${x}`, property: PERSONS, label: 'persons', dataSet: TABLE, value: 100 + n * 7 + c.length,
      dimensions: { [OCC]: code(c), [SEX]: code(x) },
    })));
    return { ...one, '@id': iri, label: `County ${n}`, attestations: [{ ...one.attestations[0], '@id': iri + '#a-00000001', properties }] };
  };
  doc.spatialEntities = Array.from({ length: 12 }, (_, n) => make(n));
  const s = await site(doc);
  const walk = (root, at = '') => readdirSync(join(root, at), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(root, join(at, d.name)) : [join(at, d.name)]));
  const written = walk(s.siteDir).reduce((n, f) => n + statSync(join(s.siteDir, f)).size, 0);
  const est = s.r.report.counts.estimate;
  assert.ok(s.downloads().some((f) => /-cube\.nt\.gz$/.test(f)), 'the cube download was made');
  assert.ok(written > 500_000, `a site of figures was written: ${written}`);
  console.log(`figures: estimated ${est}, wrote ${written} (${(est / written).toFixed(2)})`);
  assert.ok(est >= written, `short: estimated ${est}, wrote ${written}`);
  assert.ok(est <= 1.3 * written, `too high: estimated ${est}, wrote ${written}`);
});
