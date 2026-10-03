// The regions a place lies in (Hermes, for Methodos's stage 1 and Krisis): "within" columns guessed
// from their headings and numbered widest first, a saved mapping with levels, a column split into
// levels, the chain on the reader's events (never a key of PLATO JSON), plato:ContainedIn
// attestations and minted regions under a base address of the user's own (else a note), the
// within.js exports Krisis and Methodos read, and the pasted list. Every test of an absence has a
// presence beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { detect } from '../src/engine/input.js';
import { Report, LOSS_TEXT } from '../src/engine/report.js';
import { genericSource, mappingOf, regionId, columnsOf } from '../src/engine/hermes/generic.js';
import { guessColumns, resolveColumns, mappingToSave, splitCell, expandSplits, splitRow, applyColumns, GENERIC_KINDS } from '../src/engine/hermes/columns.js';
import { withinOf, withinChains, withinLevels, containerKey, withinNote, regionIndex, CONTAINED_IN } from '../src/engine/hermes/within.js';
import { PLATO_REPO } from './paths.js';
import { pastedListCsv, pastedListFile, PASTED_FILE_NAME } from '../src/engine/hermes/pasted.js';
import { isColumns } from '../src/engine/krisis/work.js';
import { gather } from '../src/engine/krisis/match.js';
import { columnWarnings } from '../src/engine/words.js';
import { run } from '../src/engine/pipeline.js';
import { sha256 } from '../src/lib/sha256.js';
import { textFile, go, outText, env } from './engine.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const load = (f) => JSON.parse(readFileSync(`public/plato/${f}`, 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
ajv.addSchema(load('place-centric.schema.json'));
const validPlaceCentric = (doc) => { const v = ajv.getSchema('https://w3id.org/plato/schemas/place-centric.schema.json'); return v(doc) ? null : v.errors.slice(0, 3); };
const BASE = 'https://example.org/parishes/';

/** Every event the generic reader gives for a CSV text, and its report. */
async function eventsOf(csv, options = {}, name = 'places.csv') {
  const input = await detect([textFile(csv, name)]);
  const rep = new Report();
  const events = [];
  for await (const ev of genericSource(input, rep, options)) events.push(ev);
  const items = rep.toJSON().items;
  return { events, items, kinds: new Set(items.map((i) => i.kind)), of: (k) => items.find((i) => i.kind === k) };
}
const rows = (events) => events.filter((e) => (e.type === 'record' || e.type === 'attestation') && !e.region);

// ---- the guess ---------------------------------------------------------------------------------------
test('each kind of region is guessed from its heading, case and punctuation aside, and numbered widest first by WHG\'s ranks', () => {
  const headers = ['Name', 'PARISH NAME', 'Hundred', 'District', 'Diocese', 'Deanery', 'county', 'State', 'Country', 'Township', 'Civil-Parish', 'Oblast', 'Wapentake', 'Land', 'Province', 'Region', 'Arrondissement', 'Commune', 'Municipality', 'Shire', 'Department', 'Nation'];
  const g = guessColumns(headers, [Object.fromEntries(headers.map((h) => [h, `${h} value`]))]);
  for (const h of headers.slice(1)) assert.equal(g.mapping[h], 'within', h);
  assert.equal(g.mapping.Name, 'name');   // control: the name is still the name
  // The levels are positional, 1 to n, with no gaps: one level for each column.
  assert.deepEqual(Object.values(g.levels).sort((a, b) => a - b), headers.slice(1).map((_, i) => i + 1));
  const before = (a, b) => assert.ok(g.levels[a] < g.levels[b], `${a} (${g.levels[a]}) before ${b} (${g.levels[b]})`);
  before('Country', 'State'); before('State', 'county'); before('county', 'District');
  before('District', 'Hundred');   // WHG's ranks: district 30 above hundred 40
  before('Hundred', 'Diocese'); before('Diocese', 'Deanery'); before('Deanery', 'PARISH NAME');
  assert.equal(g.levels.Country, 1);
  assert.match(g.reasons.Country, /a country, the widest of the 21 regions, so at level 1/);
  // Two of one kind keep the file's order.
  before('Country', 'Nation'); before('PARISH NAME', 'Township');
});
test('administrative levels (admin1, ADM2, adm0) and "contained in" are guessed as regions, a column of codes is not', () => {
  const headers = ['name', 'admin2', 'ADM0', 'Admin 1', 'contained in', 'adm3_code'];
  const sample = [{ name: 'Rotherhithe', admin2: 'Surrey', ADM0: 'England', 'Admin 1': 'South East', 'contained in': 'Bermondsey', adm3_code: '12' }];
  const g = guessColumns(headers, sample);
  assert.deepEqual([g.levels.ADM0, g.levels['Admin 1'], g.levels.admin2, g.levels['contained in']], [1, 2, 3, 4]);
  assert.equal(g.mapping.adm3_code, 'note');   // no kind: adm3_code is not adm3
  // A column of numbers under a region's heading is codes, not names.
  const codes = guessColumns(['name', 'admin1'], [{ name: 'A', admin1: '12' }, { name: 'B', admin1: '07' }]);
  assert.equal(codes.mapping.admin1, 'note');
  assert.match(codes.reasons.admin1, /numbers, not names/);
  // Control: the same heading with names is a region.
  assert.equal(guessColumns(['name', 'admin1'], [{ name: 'A', admin1: 'Kent' }]).mapping.admin1, 'within');
});
test('headings that only contain a kind\'s word are not regions', () => {
  const g = guessColumns(['name', 'Countryside', 'Parishioners', 'county_council_id'], [{ name: 'A', Countryside: 'x', Parishioners: 'y', county_council_id: 'z' }]);
  assert.deepEqual([g.mapping.Countryside, g.mapping.Parishioners, g.mapping.county_council_id], ['note', 'note', 'note']);
  assert.equal(g.mapping.name, 'name');
});

// ---- a saved mapping with levels ---------------------------------------------------------------
test('a saved mapping gives each region its level; two at one level keep the second as a note; it saves back as given', () => {
  const headers = ['Name', 'Parish', 'County', 'Country', 'Shire'];
  const saved = { Name: 'name', Parish: { field: 'within', level: 6 }, County: { field: 'within', level: 3 }, Country: { field: 'within', level: 1 }, Shire: { field: 'within', level: 3 } };
  const r = resolveColumns(headers, [], saved);
  assert.deepEqual({ ...r.levels }, { Parish: 6, County: 3, Country: 1 });
  assert.equal(r.mapping.Shire, 'note');
  assert.deepEqual(r.problems, [{ kind: 'generic-within-same-level', example: 'Shire: level 3 is already the column "County"' }]);
  assert.equal(GENERIC_KINDS['generic-within-same-level'], 'warning');
  assert.ok(LOSS_TEXT['generic-within-same-level'] && LOSS_TEXT['generic-split-extra-parts'] && LOSS_TEXT['generic-within-no-base']);
  const back = mappingToSave(r.mapping, r.patterns, r.levels, r.splits);
  assert.deepEqual(JSON.parse(JSON.stringify(back)), { Name: 'name', Parish: { field: 'within', level: 6 }, County: { field: 'within', level: 3 }, Country: { field: 'within', level: 1 }, Shire: 'note' });
});
test('a region given no level takes the next free; a level that is not a whole number, or a level on another field, is refused', () => {
  const r = resolveColumns(['Name', 'Parish', 'County', 'Hundred', 'Type'], [], { Name: 'name', Parish: 'within', County: { field: 'within', level: 2 }, Hundred: { field: 'within', level: 0 }, Type: { field: 'type', level: 2 } });
  assert.equal(r.levels.Parish, 3);
  assert.match(r.reasons.Parish, /next free/);
  assert.equal(r.mapping.Hundred, 'note');
  assert.equal(r.mapping.Type, 'note');
  assert.deepEqual(r.problems.map((p) => p.kind), ['generic-mapping', 'generic-mapping']);
  assert.match(r.problems[0].example, /^Hundred: the level 0 is not a whole number/);
  assert.match(r.problems[1].example, /^Type: "level" goes with "within"/);
});
test('the page warns of two regions at one level, as the engine reports them', () => {
  const w = columnWarnings({ A: 'within', B: 'within', C: 'split' }, [], {}, {}, { A: 1, B: 2 }, { C: { separator: ',', levels: [3, 2] } });
  assert.equal(w.filter((x) => /both at level 2/.test(x)).length, 1);
  assert.ok(w.some((x) => /“B” and “C”/.test(x)));
  // Control: distinct levels, no such warning.
  assert.ok(!columnWarnings({ A: 'within', B: 'within' }, [], {}, {}, { A: 1, B: 2 }).some((x) => /both at level/.test(x)));
});
test('the work file takes a mapping with regions and splits (Krisis, isColumns), and refuses a bad level', () => {
  assert.ok(isColumns({ Name: 'name', Parish: { field: 'within', level: 3 }, Place: { field: 'split', separator: ', ', levels: [3, 2, 1], firstIsName: true } }));
  assert.ok(isColumns({ Id: { field: 'address', pattern: 'https://pleiades.stoa.org/places/{id}' } }));   // control: as before
  assert.ok(!isColumns({ Parish: { field: 'within', level: 0 } }));
  assert.ok(!isColumns({ Place: { field: 'split', separator: '' } }));
  assert.ok(!isColumns({ Parish: { field: 'within', level: 2, extra: 1 } }));
});

// ---- the chain on the events -------------------------------------------------------------------
const PARISHES = 'id,Name,Parish,County,Country\n1,Mill, Rotherhithe ,Surrey,England\n2,Farm,,,England\n3,Barn,,,\n';
test('each record carries its chain, widest first, empty cells skipped, values trimmed; no chain, no key', async () => {
  const { events } = await eventsOf(PARISHES);
  const r = rows(events);
  assert.deepEqual(r[0].within, [{ level: 1, value: 'England', column: 'Country' }, { level: 2, value: 'Surrey', column: 'County' }, { level: 3, value: 'Rotherhithe', column: 'Parish' }]);
  assert.deepEqual(r[1].within, [{ level: 1, value: 'England', column: 'Country' }]);   // a gap: parish and county empty
  assert.ok(!Object.hasOwn(r[2], 'within'));
  assert.ok(Object.hasOwn(r[0], 'within'));   // control
  assert.deepEqual(withinOf(r[2]), []);
});
test('an attestation event carries its chain too (a column of web addresses, and rows with the same id)', async () => {
  const byAddress = await eventsOf('uri,Name,County,Country\nhttps://www.wikidata.org/entity/Q1,Mill,Surrey,England\nhttps://www.wikidata.org/entity/Q2,Farm,,\n');
  const atts = rows(byAddress.events);
  assert.deepEqual(atts.map((e) => e.type), ['attestation', 'attestation']);
  assert.deepEqual(atts[0].within.map((c) => c.value), ['England', 'Surrey']);
  assert.ok(!Object.hasOwn(atts[1], 'within'));
  const same = await eventsOf('id,Name,County\n7,Mill,Surrey\n7,Mill,Surrey\n', { sameId: true });
  assert.deepEqual(rows(same.events).filter((e) => e.type === 'attestation').map((e) => e.within[0].value), ['Surrey', 'Surrey']);
});
test('the chain is never written into PLATO JSON; without a base address it is a note, said once', async () => {
  const { e, report } = await go([textFile(PARISHES, 'places.csv')], 'convert', 'plato-json');
  const text = outText(e, 'places.json');
  assert.ok(!text.includes('"within"'));
  assert.ok(text.includes('Within (as the source gives it): England > Surrey > Rotherhithe > Mill'));   // presence: the note
  assert.ok(text.includes('Within (as the source gives it): England > Farm'));
  assert.ok(!text.includes(CONTAINED_IN));
  assert.equal(report.items.filter((i) => i.kind === 'generic-within-no-base').length, 1);
  assert.equal(validPlaceCentric(JSON.parse(text)), null);
});
test('the note is the chain, widest first, then the place\'s own name', () => {
  assert.equal(withinNote([{ level: 1, value: 'England' }, { level: 2, value: 'Surrey' }], 'Rotherhithe'), 'Within (as the source gives it): England > Surrey > Rotherhithe');
});

// ---- ContainedIn and minted regions, under a base address -----------------------------------------
const NEWTONS = 'id,Name,Parish,County,Country\n1,Mill,Newton,Lancashire,England\n2,Farm,Newton,Cheshire,England\n3,Barn,Newton,Cheshire,England\n';
test('with a base address, each row\'s place is ContainedIn its narrowest region, citing what its row cites; schema-valid', async () => {
  const { e, report } = await go([textFile(NEWTONS, 'places.csv')], 'convert', 'plato-json', { base: BASE });
  const doc = JSON.parse(outText(e, 'places.json'));
  assert.equal(validPlaceCentric(doc), null);
  assert.equal(report.errors, 0);
  assert.ok(!JSON.stringify(doc).includes('"within"'));
  assert.ok(!JSON.stringify(doc).includes('Within (as the source gives it)'));   // written as relations, not the note
  assert.ok(!JSON.stringify(doc).includes('"sequence"'));   // a sequence orders a route's members, not regions
  const mill = doc.spatialEntities.find((p) => p['@id'] === `${BASE}place/1`);
  const contained = mill.attestations.filter((a) => a.relations);
  const key = containerKey(3, 'Newton', ['England', 'Lancashire']);
  assert.deepEqual(contained.map((a) => a.relations), [[{ relationType: CONTAINED_IN, relatesTo: `${BASE}place/region-${sha256(key).slice(0, 16)}` }]]);
  // PLATO a6bc022: no relatedLabel or relationLabel on a minted region's relation (its name is its own name attestation)
  assert.ok(!JSON.stringify(doc).includes('relatedLabel') && !JSON.stringify(doc).includes('relationLabel'));
  assert.ok(JSON.stringify(doc).includes('"relatesTo"'));   // control: the relations are there
  assert.equal(regionId(key), `region-${sha256(key).slice(0, 16)}`);
  assert.deepEqual(contained[0].citations, mill.attestations[0].citations);   // the file and the row, as the row's attestation
  assert.equal(contained[0].citations[0].locator, 'row 2');
});
test('each region is minted once, named, labelled with its parents, contained in its parent; two Newtons under different chains are two, identical chains one', async () => {
  const { e } = await go([textFile(NEWTONS, 'places.csv')], 'convert', 'plato-json', { base: BASE });
  const doc = JSON.parse(outText(e, 'places.json'));
  const regions = doc.spatialEntities.filter((p) => p['@id'].includes('/place/region-'));
  // England; Lancashire, Cheshire; Newton (Lancashire), Newton (Cheshire): the third row adds none.
  assert.deepEqual(regions.map((r) => r.label).sort(), ['Cheshire (England)', 'England', 'Lancashire (England)', 'Newton (Cheshire, England)', 'Newton (Lancashire, England)']);
  assert.equal(new Set(regions.map((r) => r['@id'])).size, 5);
  const byLabel = (l) => regions.find((r) => r.label === l);
  const newtonC = byLabel('Newton (Cheshire, England)');
  assert.equal(newtonC.entityIdentifier, JSON.stringify([3, 'England', 'Cheshire', 'Newton']));
  const england = byLabel('England');
  // Each region a name attestation, as its source writes it, citing the row it was first met in; the widest no parent.
  assert.deepEqual(england.attestations.map((a) => [a.names?.[0]?.toponym, a.relations, a.citations[0].locator]), [['England', undefined, 'row 2']]);
  const lancs = byLabel('Lancashire (England)');
  assert.deepEqual(lancs.attestations.map((a) => a.names?.[0]?.toponym ?? a.relations[0]), ['Lancashire', { relationType: CONTAINED_IN, relatesTo: england['@id'] }]);
  assert.equal(newtonC.attestations[1].relations[0].relatesTo, byLabel('Cheshire (England)')['@id']);
  // Farm and Barn are in the same Newton; Mill in the other.
  const narrowest = (id) => doc.spatialEntities.find((p) => p['@id'] === `${BASE}place/${id}`).attestations.find((a) => a.relations).relations[0].relatesTo;
  assert.equal(narrowest(2), newtonC['@id']);
  assert.equal(narrowest(3), newtonC['@id']);
  assert.equal(narrowest(1), byLabel('Newton (Lancashire, England)')['@id']);   // control
});
test('converted regions have the shape of PLATO\'s worked example (place-centric-regions.json)', async (t) => {
  const path = `${PLATO_REPO}/schemas/examples/place-centric-regions.json`;
  if (!existsSync(path)) { t.skip(`PLATO at ${PLATO_REPO} has no schemas/examples/place-centric-regions.json (from 1d2cf6e): repin to compare`); return; }
  const example = JSON.parse(readFileSync(path, 'utf8'));
  const { e } = await go([textFile('id,Name,County,Country\nr,Rotherhithe,Surrey,England\n', 'places.csv')], 'convert', 'plato-json', { base: BASE });
  const doc = JSON.parse(outText(e, 'places.json'));
  // The shape: for each place, its name attestation, and one ContainedIn to the nearest container; a region labelled "Surrey (England)".
  const shape = (d) => d.spatialEntities.map((p) => ({ label: p.label, atts: p.attestations.filter((a) => !a.identities).map((a) => (a.names ? ['name', a.names[0].toponym] : ['in', a.relations[0].relationType, d.spatialEntities.find((q) => q['@id'] === a.relations[0].relatesTo)?.label])) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  assert.deepEqual(shape(doc), shape(example));
});
test('region events are tagged, carry their parents as their chain, and are left out of the rows\' chains and levels', async () => {
  const { events } = await eventsOf(NEWTONS, { base: BASE });
  const regionEvents = events.filter((e) => e.region);
  assert.equal(regionEvents.length, 5);
  const newton = regionEvents.find((e) => e.value.label === 'Newton (Lancashire, England)');
  assert.deepEqual(newton.within.map((c) => c.value), ['England', 'Lancashire']);
  assert.deepEqual(newton.region, { level: 3, key: containerKey(3, 'Newton', ['England', 'Lancashire']) });
  assert.equal(withinChains(events).length, 3);
  assert.equal(withinLevels(events).get(1).size, 1);
});
test('attestation-centric rows with a base: regions are new places, their attestations given about them, and records read back carry within', async () => {
  const csv = 'uri,Name,County,Country\nhttps://www.wikidata.org/entity/Q1,Mill,Surrey,England\n';
  const { events } = await eventsOf(csv, { base: BASE });
  const surrey = events.find((e) => e.region && e.type === 'record' && e.value.label === 'Surrey (England)');
  assert.equal(surrey.newEntity, true);
  assert.ok(events.some((e) => e.type === 'attestation' && e.region && e.value.about === surrey.value['@id'] && e.value.relations?.[0].relatesTo === events.find((x) => x.region && x.type === 'record' && x.value.label === 'England')?.value['@id'] && !Object.hasOwn(e.value.relations[0], 'relatedLabel')));
  assert.ok(events.some((e) => e.type === 'attestation' && e.region && e.value.about === surrey.value['@id'] && e.value.names?.[0].toponym === 'Surrey'));
  // Through run(): regrouped by place in the store, each record's event given back its chain.
  const seen = [];
  const sink = { header() {}, event(ev) { seen.push(ev); }, async close() {} };
  const input = await detect([textFile(csv, 'places.csv')]);
  await run({ input, action: 'check', options: { base: BASE, sink } }, env());
  const mill = seen.find((ev) => ev.value?.['@id'] === 'http://www.wikidata.org/entity/Q1');
  assert.deepEqual(mill.within.map((c) => c.value), ['England', 'Surrey']);
  assert.ok(!Object.hasOwn(mill.value, 'within'));
  const back = seen.find((ev) => ev.value?.['@id'] === surrey.value['@id']);
  assert.deepEqual(back.region, surrey.region);
  // And read back from PLATO alone, through the regions as the sink received them.
  assert.deepEqual(withinOf({ type: 'record', value: mill.value }, regionIndex(seen)).map((c) => [c.level, c.value]), [[1, 'England'], [2, 'Surrey']]);
});
test('withinOf reads the chain back from PLATO, following ContainedIn up through the regions, agreeing with the event\'s own', async () => {
  const sparse = 'id,Name,Parish,County,Country\n1,Mill,Rotherhithe,,England\n';   // a gap: no county
  for (const csv of [NEWTONS, sparse]) {
    const { events } = await eventsOf(csv, { base: BASE });
    const regions = regionIndex(events);
    assert.ok(regions.size >= 2);
    for (const ev of rows(events)) {
      const fromPlato = withinOf({ type: ev.type, value: ev.value }, regions);
      assert.deepEqual(fromPlato.map((c) => [c.level, c.value]), ev.within.map((c) => [c.level, c.value]));
      assert.ok(fromPlato.every((c) => c.iri.startsWith(`${BASE}place/region-`)));
    }
  }
  // Controls: without the regions, or without the ContainedIn attestations (no base), nothing to read back.
  const { events } = await eventsOf(NEWTONS, { base: BASE });
  assert.deepEqual(withinOf({ type: 'record', value: rows(events)[0].value }), []);
  const plain = await eventsOf(NEWTONS);
  assert.deepEqual(withinOf({ type: 'record', value: rows(plain.events)[0].value }, regionIndex(events)), []);
});
test('plato:ContainedIn is a RelationType of the vendored ontology, at the IRI the reader writes', (t) => {
  const ttl = readFileSync('public/plato/ontology.ttl', 'utf8');
  const prefix = /@prefix plato: <([^>]+)>/.exec(ttl)?.[1];
  assert.equal(prefix, 'https://w3id.org/plato#');
  const declared = /\nplato:ContainedIn\s+a plato:RelationType\b/.test(ttl);
  if (!declared) { t.skip('the vendored ontology has no plato:ContainedIn yet: repin PLATO to a commit that declares it'); return; }
  assert.equal(CONTAINED_IN, `${prefix}ContainedIn`);
  assert.match(ttl, /plato:ContainedIn[\s\S]{0,400}authority_uri "http:\/\/vocab\.getty\.edu\/ontology#broaderPartitive"/);
  // Control: a name the ontology does not declare is not found by the same test.
  assert.ok(!/\nplato:ContainedWithin\s+a plato:RelationType\b/.test(ttl));
});

// ---- within.js -------------------------------------------------------------------------------------
test('containerKey tells "Newport" under different parents apart, and labels holding "/" or "," from their neighbours', () => {
  assert.notEqual(containerKey(3, 'Newport', ['Wales', 'Monmouthshire']), containerKey(3, 'Newport', ['England', 'Isle of Wight']));
  assert.equal(containerKey(3, 'Newport', ['Wales', 'Monmouthshire']), containerKey(3, 'Newport', ['Wales', 'Monmouthshire']));
  assert.equal(containerKey(2, 'c', ['a']), JSON.stringify([2, 'a', 'c']));
  // Joined with "/" or ",", these pairs would be one key; as JSON they are two.
  assert.equal(['a/b', 'c'].join('/'), ['a', 'b/c'].join('/'));   // control: the naive key collides
  assert.notEqual(containerKey(2, 'c', ['a/b']), containerKey(2, 'b/c', ['a']));
  assert.equal(['a,b', 'c'].join(','), ['a', 'b,c'].join(','));
  assert.notEqual(containerKey(2, 'c', ['a,b']), containerKey(2, 'b,c', ['a']));
  assert.notEqual(containerKey(1, 'x'), containerKey(2, 'x'));
});
test('withinLevels groups identical containers by level, widest first, with the rows that name them', async () => {
  const { events } = await eventsOf(NEWTONS);
  const levels = withinLevels(events);
  assert.deepEqual([...levels.keys()], [1, 2, 3]);
  assert.equal(levels.get(1).size, 1);
  const england = levels.get(1).get(containerKey(1, 'England'));
  assert.deepEqual(england.rows.map((r) => r.n), [1, 2, 3]);
  assert.deepEqual(england.parents, []);
  const newtons = [...levels.get(3).values()];
  assert.equal(newtons.length, 2);
  const cheshire = levels.get(3).get(containerKey(3, 'Newton', ['England', 'Cheshire']));
  assert.deepEqual({ level: cheshire.level, value: cheshire.value, parents: cheshire.parents, names: cheshire.rows.map((r) => r.name) }, { level: 3, value: 'Newton', parents: ['England', 'Cheshire'], names: ['Farm', 'Barn'] });
  assert.equal(cheshire.rows[0].iri, 'https://example.org/my-dataset/place/2');
});
test('withinChains gives each row\'s name and chain, in order', async () => {
  const { events } = await eventsOf(PARISHES);
  assert.deepEqual(withinChains(events).map((c) => [c.name, c.chain.map((x) => x.value)]), [['Mill', ['England', 'Surrey', 'Rotherhithe']], ['Farm', ['England']], ['Barn', []]]);
});

// ---- split into levels -------------------------------------------------------------------------
test('a cell split into levels: parts narrowest first, the first part the name when chosen, extra parts named', () => {
  assert.deepEqual(splitCell('Rotherhithe, Surrey, England', { separator: ', ', levels: [3, 2, 1] }), { parts: [{ level: 3, value: 'Rotherhithe' }, { level: 2, value: 'Surrey' }, { level: 1, value: 'England' }], extra: [] });
  assert.deepEqual(splitCell('Rotherhithe,Surrey ,  England', { separator: ', ', levels: [2, 1], firstIsName: true }), { name: 'Rotherhithe', parts: [{ level: 2, value: 'Surrey' }, { level: 1, value: 'England' }], extra: [] });
  assert.deepEqual(splitCell('A, B, C, D', { separator: ',', levels: [2, 1] }).extra, ['C', 'D']);
  assert.deepEqual(splitCell('', { separator: ',', levels: [1] }), { parts: [], extra: [] });
});
test('a split column becomes the name and its levels, row by row; parts beyond the levels are reported as a loss', async () => {
  const csv = 'id,Place\n1,"Rotherhithe, Surrey, England"\n2,"Hythe, Kent, England, UK"\n';
  const columns = { id: 'id', Place: { field: 'split', separator: ', ', levels: [2, 1], firstIsName: true } };
  const { events, of } = await eventsOf(csv, { columns });
  const r = rows(events);
  assert.equal(r[0].value.label, 'Rotherhithe');
  assert.deepEqual(r[0].within, [{ level: 1, value: 'England', column: 'Place' }, { level: 2, value: 'Surrey', column: 'Place' }]);
  assert.match(r[0].value.attestations[0].notes, /^Within \(as the source gives it\): England > Surrey > Rotherhithe$/);
  assert.equal(GENERIC_KINDS['generic-split-extra-parts'], 'loss');
  assert.deepEqual(of('generic-split-extra-parts').examples, ['row 3, Place: "UK" (2 levels given)']);
  // Control: the first row had no extra part, and only one row is reported.
  assert.equal(of('generic-split-extra-parts').count, 1);
});
test('a split is saved in the mapping, its levels guessed from the first rows when not given; a bad one is refused', () => {
  const headers = ['Place'], sample = [{ Place: 'A, B, C' }, { Place: 'D, E' }];
  const r = resolveColumns(headers, sample, { Place: { field: 'split', separator: ', ', firstIsName: true } });
  assert.deepEqual(r.splits.Place, { separator: ', ', levels: [2, 1], firstIsName: true });
  assert.deepEqual(JSON.parse(JSON.stringify(mappingToSave(r.mapping, r.patterns, r.levels, r.splits))), { Place: { field: 'split', separator: ', ', levels: [2, 1], firstIsName: true } });
  for (const bad of [{ field: 'split' }, { field: 'split', separator: ',', levels: [2, 2] }, { field: 'split', separator: ',', levels: ['x'] }, 'split']) {
    const b = resolveColumns(headers, sample, { Place: bad });
    assert.equal(b.mapping.Place, 'note', JSON.stringify(bad));
    assert.equal(b.problems[0].kind, 'generic-mapping');
  }
});
test('with a name column already, a split\'s first part is one of the place\'s other names', () => {
  const { mapping, levels, from } = expandSplits({ Name: 'name', Place: 'split' }, {}, { Place: { separator: ',', levels: [1], firstIsName: true } });
  const row = splitRow({ Name: 'Rotherhithe Mill', Place: 'Rotherhithe, England' }, { Place: { separator: ',', levels: [1], firstIsName: true } });
  const a = applyColumns(row, mapping, { levels, from });
  assert.deepEqual(a.attestation.names, [{ toponym: 'Rotherhithe Mill' }, { toponym: 'Rotherhithe' }]);
  assert.deepEqual(a.within, [{ level: 1, value: 'England', column: 'Place' }]);
});

// ---- the pasted list ------------------------------------------------------------------------------
test('a pasted list becomes a CSV of one column, "name", that the tables reader reads as names', async () => {
  const text = '  St Mary; Kent \r\n\nNewport, Isle of Wight\nThe "Old" Mill\tbarn\n';
  assert.equal(pastedListCsv(text), 'name\n"St Mary; Kent"\n"Newport, Isle of Wight"\n"The ""Old"" Mill\tbarn"\n');
  assert.equal(pastedListCsv(' \n\n'), null);
  const f = pastedListFile(text);
  assert.equal(f.name, PASTED_FILE_NAME);
  const input = await detect([f]);
  assert.equal(input.format, 'csv');
  const { headers, sample } = await columnsOf(input);
  assert.deepEqual(headers, ['name']);
  assert.deepEqual(sample.map((r) => r.name), ['St Mary; Kent', 'Newport, Isle of Wight', 'The "Old" Mill\tbarn']);
  const m = await mappingOf(input);
  assert.equal(m.mapping.name, 'name');
  // Control: the same names unquoted would be read with ";" or "," as a separator.
  const loose = await detect([new File(['name\nSt Mary; Kent\nNewport, Isle of Wight\n'], 'loose.csv')]);
  assert.notDeepEqual((await columnsOf(loose)).sample.map((r) => r.name), ['St Mary; Kent', 'Newport, Isle of Wight']);
});

// ---- through the run, and Krisis -------------------------------------------------------------------
test('the chain survives run()\'s sink on each record event, as the version check, gather and match read them', async () => {
  const seen = [];
  const sink = { header() {}, event(ev) { seen.push(ev); }, async close() {} };
  const input = await detect([textFile(PARISHES, 'places.csv')]);
  // The options readSide (src/engine/krisis/match.js) gives run().
  const r = await run({ input, action: 'check', options: { base: undefined, columns: { id: 'id', Name: 'name', Parish: { field: 'within', level: 3 }, County: { field: 'within', level: 2 }, Country: { field: 'within', level: 1 } }, sink } }, env());
  assert.equal(r.report.errors, 0);
  const records = seen.filter((ev) => ev.type === 'record');
  assert.equal(records.length, 3);
  assert.deepEqual(records[0].within.map((c) => c.value), ['England', 'Surrey', 'Rotherhithe']);
  assert.ok(!Object.hasOwn(records[0].value, 'within'));
  assert.ok(!Object.hasOwn(records[2], 'within'));
});
test('Krisis gathers the places of a table with regions, read by a mapping with levels', async () => {
  const columns = { id: 'id', Name: 'name', Parish: { field: 'within', level: 3 }, County: { field: 'within', level: 2 }, Country: { field: 'within', level: 1 } };
  const input = await detect([textFile(PARISHES, 'places.csv')]);
  const g = await gather({ subjects: input, options: { columns } }, env());
  assert.equal(g.incomplete, undefined);
  assert.deepEqual(g.places.map((p) => p.label), ['Mill', 'Farm', 'Barn']);
  // With a base, the regions are places of their own too, which Krisis can look up.
  const withBase = await gather({ subjects: input, options: { columns, base: BASE } }, env());
  assert.ok(withBase.places.some((p) => p.label === 'Surrey (England)' && p.iri.includes('/place/region-')));
});

// ---- the command line ------------------------------------------------------------------------------
test('command line: --split splits a column into levels, prints it in the mapping, and names extra parts', () => {
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-within-'));
  try {
    writeFileSync(join(d, 'places.csv'), 'Place\n"Rotherhithe, Surrey, England, UK"\n');
    const r = cli('check', '--split', 'Place=, :name,2,1', join(d, 'places.csv'));
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(r.out.includes('{"Place":{"field":"split","separator":", ","levels":[2,1],"firstIsName":true}}'), r.out);
    assert.match(r.out, /row 2, Place: "UK" \(2 levels given\)/);
    const j = JSON.parse(cli('check', '--json', '--split', 'Place=, :name,2,1', join(d, 'places.csv')).out.split('\n')[0]);
    assert.deepEqual(j.columns[0], { column: 'Place', field: 'split', separator: ', ', levels: [2, 1], firstIsName: true, reason: 'as the mapping given says' });
    // Refused: a column the file does not have, "name" not first, a level twice; and for another command.
    assert.equal(cli('check', '--split', 'Nowhere=,', join(d, 'places.csv')).code, 2);
    assert.match(cli('check', '--split', 'Place=,:2,name', join(d, 'places.csv')).err, /"name" can only come first/);
    assert.match(cli('check', '--split', 'Place=,:2,2', join(d, 'places.csv')).err, /a level is given twice/);
    assert.match(cli('compare', '--split', 'Place=,', join(d, 'places.csv'), join(d, 'places.csv')).err, /--split is for check, convert and preview/);
    // Control: without --split, the column is a note.
    assert.ok(cli('check', join(d, 'places.csv')).out.includes('{"Place":"note"}'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('command line: regions guessed from the headings are printed with their levels, and --help names --split and the pasted list', () => {
  const d = mkdtempSync(join(tmpdir(), 'plato-tools-within-'));
  try {
    writeFileSync(join(d, 'places.csv'), 'Name,Parish,Country\nMill,Rotherhithe,England\n');
    const r = cli('check', join(d, 'places.csv'));
    assert.ok(r.out.includes('{"Name":"name","Parish":{"field":"within","level":2},"Country":{"field":"within","level":1}}'), r.out);
    const help = cli('--help').out;
    assert.match(help, /--split COLUMN=SEP\[:LEVELS\]/);
    assert.match(help, /pasted list/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
