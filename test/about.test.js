import { PLATO_REPO } from './paths.js';
// The dataset described (PLATO's FAIR metadata): the gazetteer header's creator, keywords, spatial,
// temporal, landingPage and uriSpace, and the tables' about sheet, one row that becomes the header.
// The about sheet's base_uri is the base the places' and sources' addresses are made from, unless a
// base is given for the conversion. rdf-tabular (strict, serialize --validate) rejected a missing
// title, status 'Published' and a three-digit temporal_from on 2026-09-30, and three broken creator
// cells for PLATO 8385472 (test/tables.test.js holds those), and accepted zero rows, two rows and a published row
// without a licence, which CSVW cannot state: PLATO tools checks those (checkAboutRules).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import Papa from 'papaparse';
import { res, file, textFile, outText, go } from './engine.js';

const CUSTOMS = `${PLATO_REPO}/schemas/tables/examples/customs`;
const HEADER = readFileSync(`${PLATO_REPO}/schemas/tables/about.csv`, 'utf8').trim();
const items = (r, sev) => r.report.items.filter((i) => i.severity === sev);
const errors = (r) => items(r, 'error');
const warnings = (r) => items(r, 'warning');
const records = (r) => outText(r.e, Object.keys(r.e.outs)[0]).trim().split('\n').map((l) => JSON.parse(l));
/** The customs example with its about.csv replaced by these rows (CSV text, no header). */
const customsWith = (rows) => readdirSync(CUSTOMS).filter((f) => f !== 'about.csv').map((f) => file(`${CUSTOMS}/${f}`))
  .concat(textFile(`${HEADER}\n${rows}`, 'about.csv'));

// ---- a full about row -> the header, and back ----------------------------------------------------
const FULL = {
  title: 'Customs, described in full', description: 'Every column of the about sheet, filled in.',
  creator: 'Stephen Gadd <https://orcid.org/0000-0003-3060-0181>;https://ror.org/052gg0110;Anne Annotator;Bea Builder', creator_name: '',
  contributor: 'https://orcid.org/0000-0002-1825-0097', licence: 'https://creativecommons.org/licenses/by/4.0/', version: '1.2',
  status: 'published', keywords: 'customs accounts;ports', spatial: 'http://www.wikidata.org/entity/Q21;http://www.wikidata.org/entity/Q145',
  temporal_from: '1480', temporal_to: '1485-09-29', landing_page: 'https://example.org/customs/about',
  dataset_uri: 'https://example.org/customs/dataset', base_uri: 'https://example.org/customs/',
};
const FULL_GAZETTEER = {
  '@id': 'https://example.org/customs/dataset', title: FULL.title, description: FULL.description, contributor: FULL.contributor,
  creator: [{ '@id': 'https://orcid.org/0000-0003-3060-0181', name: 'Stephen Gadd' }, { '@id': 'https://ror.org/052gg0110' }, { name: 'Anne Annotator' }, { name: 'Bea Builder' }],
  licence: FULL.licence, version: '1.2', status: 'published', keywords: ['customs accounts', 'ports'],
  spatial: ['http://www.wikidata.org/entity/Q21', 'http://www.wikidata.org/entity/Q145'],
  temporal: { startDate: '1480', endDate: '1485-09-29' }, landingPage: FULL.landing_page, uriSpace: 'https://example.org/customs/',
};
const fullRow = () => Papa.unparse({ fields: HEADER.split(','), data: [HEADER.split(',').map((h) => FULL[h])] }, { newline: '\n' }).split('\n')[1];

test('about: a full row becomes the header gazetteer, every field, and valid PLATO', async () => {
  const r = await go(customsWith(fullRow()), 'convert', 'plato-jsonl');
  assert.deepEqual(errors(r), []);
  assert.deepEqual(warnings(r), [], 'a published row with a licence and a base_uri warns of nothing');
  const [head, ...places] = records(r);
  assert.deepEqual(head.gazetteer, FULL_GAZETTEER);
  assert.ok(res.validators['place-centric'].header(head), JSON.stringify(res.validators['place-centric'].header.errors));
  assert.ok(places.every((p) => p['@id'].startsWith('https://example.org/customs/place/')), 'the places are made under base_uri');
});
test('about: tables -> JSON -> tables gives back the same about row, and reports nothing about it', async () => {
  const a = await go(customsWith(fullRow()), 'convert', 'plato-json');
  const b = await go([textFile(outText(a.e, Object.keys(a.e.outs)[0]), 'c.json')], 'convert', 'tables');
  assert.deepEqual(errors(b), []);
  const about = strFromU8(unzipSync(b.e.outs['c-tables.zip'][0])['about.csv']);
  assert.deepEqual(Papa.parse(about, { header: true, skipEmptyLines: true }).data, [FULL]);
  assert.deepEqual(items(b, 'loss').map((i) => i.kind).filter((k) => /gazetteer|about|creator/.test(k)), []);
  // The places were made under base_uri, and are written back under it: no address is lost.
  assert.ok(!items(b, 'loss').some((i) => i.kind === 'place-address' || i.kind === 'source-address'), JSON.stringify(items(b, 'loss')));
});
// The creator cell (PLATO 8385472): 'Name <address>', an address alone or a name alone, ';'-separated;
// creator_name, for names alone, is deprecated but still read, and warned of.
test('about: the creator cell pairs a name and its address, and takes either alone; items are trimmed', async () => {
  const row = { ...FULL, creator: ' Josiah  Carberry <https://orcid.org/0000-0002-1825-0097>; https://ror.org/052gg0110;Anne Annotator ' };
  // A space after the closing bracket is outside the column's pattern (rdf-tabular does not trim), so is not tried.
  const r = await go(customsWith(Papa.unparse({ fields: HEADER.split(','), data: [HEADER.split(',').map((h) => row[h])] }, { newline: '\n' }).split('\n')[1]), 'convert', 'plato-jsonl');
  assert.deepEqual(errors(r), []);
  assert.deepEqual(warnings(r), []);
  assert.deepEqual(records(r)[0].gazetteer.creator, [{ '@id': 'https://orcid.org/0000-0002-1825-0097', name: 'Josiah  Carberry' }, { '@id': 'https://ror.org/052gg0110' }, { name: 'Anne Annotator' }]);
});
test('about: an item with a colon is an address only with a scheme an author\'s address has; otherwise it is a name', async () => {
  const row = { ...FULL, creator: 'Re:Place;urn:isni:0000000121032683;https://orcid.org/0000-0002-1825-0097;Dr. Who: a life;Re:Place <https://ror.org/052gg0110>' };
  const r = await go(customsWith(Papa.unparse({ fields: HEADER.split(','), data: [HEADER.split(',').map((h) => row[h])] }, { newline: '\n' }).split('\n')[1]), 'convert', 'plato-json');
  assert.deepEqual(errors(r), []);
  assert.deepEqual(JSON.parse(outText(r.e, Object.keys(r.e.outs)[0])).gazetteer.creator, [{ name: 'Re:Place' }, { '@id': 'urn:isni:0000000121032683' },
    { '@id': 'https://orcid.org/0000-0002-1825-0097' }, { name: 'Dr. Who: a life' }, { '@id': 'https://ror.org/052gg0110', name: 'Re:Place' }]);
  // Written back, an address that would be read as a name cannot go alone: it is reported, not changed into a name.
  const doc = { profile: 'place-centric', gazetteer: { title: 't', creator: [{ '@id': 'tag:example.org,2026:me' }, { '@id': 'x:y' }] },
    spatialEntities: [{ '@id': 'https://example.org/my-dataset/place/p', label: 'P', attestations: [{ names: [{ toponym: 'P' }], sources: ['https://example.org/my-dataset/source/s'] }] }] };
  const w = await go([textFile(JSON.stringify(doc), 'a.json')], 'convert', 'tables');
  const [about] = Papa.parse(strFromU8(unzipSync(w.e.outs['a-tables.zip'][0])['about.csv']), { header: true, delimiter: ',' }).data;
  assert.equal(about.creator, 'tag:example.org,2026:me');
  assert.deepEqual(items(w, 'loss').find((i) => i.kind === 'about-value')?.examples, ['creator: {"@id":"x:y"}']);
});
test('about: creator_name is still read, after creator, and is warned of as deprecated, not an error', async () => {
  const row = { ...FULL, creator: 'Stephen Gadd <https://orcid.org/0000-0003-3060-0181>', creator_name: 'Anne Annotator;Bea Builder' };
  const r = await go(customsWith(Papa.unparse({ fields: HEADER.split(','), data: [HEADER.split(',').map((h) => row[h])] }, { newline: '\n' }).split('\n')[1]), 'convert', 'plato-jsonl');
  assert.deepEqual(errors(r), []);
  assert.deepEqual(records(r)[0].gazetteer.creator, [{ '@id': 'https://orcid.org/0000-0003-3060-0181', name: 'Stephen Gadd' }, { name: 'Anne Annotator' }, { name: 'Bea Builder' }]);
  assert.deepEqual(tableItems(r, 'warning'), ["about.csv, column creator_name: is deprecated, and is to be withdrawn in a later release of PLATO: write these names in creator instead, which takes a name alone, or a name with its web address as 'Name <address>'"]);
  assert.deepEqual(warnings(r)[0].examples, ['about.csv row 2 creator_name: gives Anne Annotator;Bea Builder: write these names in creator instead']);
  // Written back, every author goes in creator, and creator_name is left empty.
  const a = await go(customsWith(Papa.unparse({ fields: HEADER.split(','), data: [HEADER.split(',').map((h) => row[h])] }, { newline: '\n' }).split('\n')[1]), 'convert', 'plato-json');
  const b = await go([textFile(outText(a.e, Object.keys(a.e.outs)[0]), 'c.json')], 'convert', 'tables');
  const [back] = Papa.parse(strFromU8(unzipSync(b.e.outs['c-tables.zip'][0])['about.csv']), { header: true, skipEmptyLines: true }).data;
  assert.deepEqual([back.creator, back.creator_name], ['Stephen Gadd <https://orcid.org/0000-0003-3060-0181>;Anne Annotator;Bea Builder', '']);
  // The control: the same row with its names in creator warns of nothing.
  const now = await go(customsWith(Papa.unparse({ fields: HEADER.split(','), data: [HEADER.split(',').map((h) => ({ ...row, creator: back.creator, creator_name: '' })[h])] }, { newline: '\n' }).split('\n')[1]), 'check');
  assert.deepEqual([errors(now), warnings(now)], [[], []]);
});
test('about: an author with both an address and a name is written as Name <address>; a name the cell cannot hold is reported', async () => {
  const doc = { profile: 'place-centric', gazetteer: { title: 't', creator: [{ '@id': 'https://orcid.org/0000-0003-3060-0181', name: 'Stephen Gadd' }, { name: 'Anne Annotator' },
    { '@id': 'https://ror.org/052gg0110', name: 'An <odd> institute' }, { name: 'x;y' }, { '@id': 'https://ror.org/02mhbdp94', name: '' }] },
    spatialEntities: [{ '@id': 'https://example.org/my-dataset/place/p', label: 'P', attestations: [{ names: [{ toponym: 'P' }], sources: ['https://example.org/my-dataset/source/s'] }] }] };
  const r = await go([textFile(JSON.stringify(doc), 'a.json')], 'convert', 'tables');
  // The delimiter is given: with this many ';' in the one row, Papa would guess ';'.
  const [row] = Papa.parse(strFromU8(unzipSync(r.e.outs['a-tables.zip'][0])['about.csv']), { header: true, delimiter: ',' }).data;
  assert.deepEqual([row.creator, row.creator_name], ['Stephen Gadd <https://orcid.org/0000-0003-3060-0181>;Anne Annotator;https://ror.org/052gg0110;https://ror.org/02mhbdp94', '']);
  // An empty name is no name: nothing is lost with it, so nothing is reported.
  assert.deepEqual(items(r, 'loss').find((i) => i.kind === 'creator-name')?.examples, ['https://ror.org/052gg0110: An <odd> institute']);
  assert.deepEqual(items(r, 'loss').find((i) => i.kind === 'about-value')?.examples, ['creator: {"name":"x;y"}']);
  // A value its column cannot hold is left out and reported, never written into the wrong column.
  const odd = { ...doc, gazetteer: { title: 't', contributor: 'Anne Annotator', keywords: ['ports', 'a;b'] } };
  const o = await go([textFile(JSON.stringify(odd), 'o.json')], 'convert', 'tables');
  const [orow] = Papa.parse(strFromU8(unzipSync(o.e.outs['o-tables.zip'][0])['about.csv']), { header: true }).data;
  assert.deepEqual([orow.contributor, orow.keywords], ['', 'ports']);
  assert.deepEqual(items(o, 'loss').find((i) => i.kind === 'about-value')?.examples.sort(), ['contributor: Anne Annotator', 'keywords: a;b']);
});

// ---- JSON -> RDF -> JSON ------------------------------------------------------------------------------
test('about: JSON -> RDF -> JSON gives back every new header key, unchanged', async () => {
  const g = { ...FULL_GAZETTEER, creator: [{ '@id': 'https://orcid.org/0000-0003-3060-0181', name: 'Stephen Gadd' }, { name: 'Anne Annotator' }, { '@id': 'https://ror.org/052gg0110' }] };
  const doc = { profile: 'place-centric', gazetteer: g, spatialEntities: [{ '@id': 'https://example.org/customs/place/p', label: 'P', attestations: [{ names: [{ toponym: 'P' }] }] }] };
  for (const typing of [false, true]) {
    const a = await go([textFile(JSON.stringify(doc), 'g.json')], 'convert', 'ntriples', { typing });
    assert.deepEqual(errors(a), []);
    const nt = outText(a.e, 'g.nt');
    for (const line of ['<https://orcid.org/0000-0003-3060-0181> <http://xmlns.com/foaf/0.1/name> "Stephen Gadd" .',
      '<https://example.org/customs/dataset> <http://www.w3.org/ns/dcat#landingPage> <https://example.org/customs/about> .',
      '<https://example.org/customs/dataset> <http://rdfs.org/ns/void#uriSpace> "https://example.org/customs/" .']) assert.ok(nt.split('\n').includes(line), `missing: ${line}`);
    for (const target of ['plato-json', 'plato-jsonl']) {
      const b = await go([textFile(nt, 'g.nt')], 'convert', target);
      assert.deepEqual(errors(b), []);
      assert.deepEqual(items(b, 'loss'), [], `typing ${typing}, ${target}`);
      assert.deepEqual(records(b)[0].gazetteer ?? JSON.parse(outText(b.e, 'g.json')).gazetteer, g, `typing ${typing}, ${target}`);
    }
  }
});

// ---- the base address ------------------------------------------------------------------------------
test('about: base_uri makes the addresses when no base is given, and a base given overrides it with a warning', async () => {
  const files = () => readdirSync(CUSTOMS).map((f) => file(`${CUSTOMS}/${f}`));
  const r = await go(files(), 'convert', 'plato-jsonl');
  assert.deepEqual(errors(r), []);
  assert.deepEqual(warnings(r), []);
  const [head, ...places] = records(r);
  assert.ok(places.some((p) => p['@id'] === 'https://whgazetteer.org/example/customs/place/bristol'), places.map((p) => p['@id']).join(', '));
  assert.equal(head.gazetteer['@id'], 'https://whgazetteer.org/example/customs/');
  assert.equal(head.gazetteer.uriSpace, 'https://whgazetteer.org/example/customs/');
  const o = await go(files(), 'convert', 'plato-jsonl', { base: 'https://example.org/other/' });
  assert.deepEqual(errors(o), []);
  const [, ...moved] = records(o);
  assert.ok(moved.some((p) => p['@id'] === 'https://example.org/other/place/bristol'), moved.map((p) => p['@id']).join(', '));
  const w = warnings(o);
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.match(w[0].message, /^about\.csv, column base_uri: differs from the base given for this conversion, which is used instead/);
  assert.deepEqual(w[0].examples, ['about.csv row 2 base_uri: is https://whgazetteer.org/example/customs/, but https://example.org/other/ was given for this conversion and is used instead']);
  // The same base, given again (with or without its final slash), is no reason to warn.
  const same = await go(files(), 'convert', 'plato-jsonl', { base: 'https://whgazetteer.org/example/customs' });
  assert.deepEqual(warnings(same), []);
});

// ---- PLATO's rules for the about sheet -------------------------------------------------------------
const tableItems = (r, sev) => items(r, sev).filter((i) => i.kind === 'table').map((i) => i.message);
test('about: no row, or two rows, is an error; one row is not', async () => {
  const none = await go(customsWith(''), 'check');
  assert.deepEqual(tableItems(none, 'error'), ['about.csv: has no row: give one row describing the dataset, with at least its title']);
  const two = await go(customsWith('One,,,,,https://creativecommons.org/licenses/by/4.0/,,draft,,,,,,,https://example.org/c/\nTwo,,,,,,,draft,,,,,,,\n'), 'check');
  assert.deepEqual(tableItems(two, 'error'), ['about.csv: has more than one row: it describes the dataset as a whole, in exactly one row']);
  assert.deepEqual(errors(two)[0].examples, ['about.csv row 3: has 2 rows; it describes the dataset as a whole, in exactly one row']);
  const one = await go(customsWith('One,,,,,https://creativecommons.org/licenses/by/4.0/,,draft,,,,,,,https://example.org/c/\n'), 'check');
  assert.deepEqual(errors(one), [], 'a positive control');
  assert.deepEqual(warnings(one), []);
});
test('about: a published dataset without a licence is an error; a draft without one, a warning', async () => {
  const pub = await go(customsWith('T,,,,,,,published,,,,,,,https://example.org/c/\n'), 'check');
  assert.deepEqual(tableItems(pub, 'error'), ["about.csv, column licence: is empty, but status is 'published': a published dataset must state its licence"]);
  const draft = await go(customsWith('T,,,,,,,draft,,,,,,,https://example.org/c/\n'), 'check');
  assert.deepEqual(errors(draft), []);
  assert.deepEqual(tableItems(draft, 'warning'), ["about.csv, column licence: is empty: say under what licence others may reuse the dataset (it is required once status is 'published')"]);
  const licensed = await go(customsWith('T,,,,,https://creativecommons.org/licenses/by/4.0/,,published,,,,,,,https://example.org/c/\n'), 'check');
  assert.deepEqual([errors(licensed), warnings(licensed)], [[], []], 'a positive control: published, with a licence');
});
test('about: a missing base_uri is a warning that the addresses will not be permanent', async () => {
  const r = await go(customsWith('T,,,,,https://creativecommons.org/licenses/by/4.0/,,draft,,,,,,,\n'), 'convert', 'plato-jsonl');
  assert.deepEqual(errors(r), []);
  assert.deepEqual(tableItems(r, 'warning'), ['about.csv, column base_uri: is empty, so the addresses of places and sources are made from a stand-in base and will not be permanent: give a base address you control']);
  const [head, ...places] = records(r);
  assert.ok(places.every((p) => p['@id'].startsWith('https://example.org/my-dataset/place/')), 'the stand-in base');
  assert.equal(head.gazetteer['@id'], 'https://example.org/my-dataset/', 'with no dataset_uri, the base is the gazetteer\'s address, as before');
  const given = await go(customsWith('T,,,,,https://creativecommons.org/licenses/by/4.0/,,draft,,,,,,,\n'), 'check', undefined, { base: 'https://example.org/c/' });
  assert.match(tableItems(given, 'warning')[0], /^about\.csv, column base_uri: is empty, so the addresses of places and sources are made from the base given for this conversion/);
});

// ---- the JSON Schema -------------------------------------------------------------------------------
test('about: the JSON Schema rejects a published gazetteer without a licence, and accepts a draft', () => {
  // The dataset profiles: a candidate set (PLATO 53c5a40) has no gazetteer.
  const datasets = Object.entries(res.validators).filter(([name]) => name !== 'candidate-set');
  assert.deepEqual(datasets.map(([name]) => name).sort(), ['attestation-centric', 'place-centric']);
  for (const [name, v] of datasets) {
    const ok = (g) => v.header({ profile: name, gazetteer: g });
    assert.equal(ok({ title: 't', status: 'published' }), false, `${name}: published, no licence`);
    assert.match(JSON.stringify(v.header.errors), /licence/);
    assert.equal(ok({ title: 't', status: 'published', licence: 'https://creativecommons.org/licenses/by/4.0/' }), true, `${name}: published, with a licence`);
    assert.equal(ok({ title: 't', status: 'draft' }), true, `${name}: a draft`);
    assert.equal(ok({ title: 't' }), true, `${name}: no status`);
    assert.equal(ok({ title: 't', creator: [{}] }), false, `${name}: a creator with neither an address nor a name`);
    assert.equal(ok({ title: 't', temporal: { startDate: '921' } }), false, `${name}: a three-digit year`);
  }
});
test('about: a published document without a licence is reported by the check', async () => {
  const doc = (g) => JSON.stringify({ profile: 'place-centric', gazetteer: g, spatialEntities: [{ '@id': 'https://example.org/p', label: 'P', attestations: [{ names: [{ toponym: 'P' }] }] }] });
  const bad = await go([textFile(doc({ title: 't', status: 'published' }), 'b.json')], 'check');
  assert.ok(errors(bad).some((e) => e.kind === 'schema' && /licence/.test(e.message)), JSON.stringify(errors(bad)));
  const good = await go([textFile(doc({ title: 't', status: 'draft' }), 'g.json')], 'check');
  assert.deepEqual(errors(good), []);
});
