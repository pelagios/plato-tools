// Map your data, "read" (13 November 2026): a table is read as its maker meant it.
//   S1  a column headed "place" or "Site" is the name; with no heading that says, the first column
//       of words is; a matching with neither a name nor an address is warned of.
//   D1  a table with no ids can have its rows numbered, at the user's asking (Stephen's ruling of
//       13 November 2026): row-1, row-2…, said to be made up, never made from a name.
//   R-05 (robust review) a list of names with no heading row keeps its first name: the page ticks
//       "The first row is a place, not a heading" beforehand where the first row is no known heading.
// The fixtures in test/fixtures/myd/ are the reviews' own (handoff myd-2026-11), unchanged. Every
// test that asserts an absence asserts, in the same test, a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as COLUMNS from '../src/engine/hermes/columns.js';
import * as GENERIC from '../src/engine/hermes/generic.js';
import { columnWarnings, COLUMN_WORDS } from '../src/engine/words.js';
import { detect, HEADERLESS_REASON } from '../src/engine/input.js';
import { Report } from '../src/engine/report.js';
import { file, textFile } from './engine.js';

// By name from the namespace: on a tree without these, each is undefined and each test fails on its own.
const { guessColumns, resolveColumns, mappingToSave, numbersRows, ROW_NUMBER, NAME_FALLBACK } = COLUMNS;
const { genericSource, mappingOf, withFirstRow } = GENERIC;
const FX = 'test/fixtures/myd/';
const plain = (o) => ({ ...o });
const fx = (name) => file(FX + name);

/** Read a table of places through the reader: its places, and what was reported. */
async function read(f, options = {}) {
  const input = await detect([f]);
  assert.ok(input.format, input.reason);
  const rep = new Report(), places = [];
  for await (const ev of genericSource(input, rep, options)) if (ev.type === 'record') places.push(ev.value);
  const { items } = rep.toJSON();
  return { input, places, items, of: (k) => items.find((i) => i.kind === k) };
}
/** The columns and first rows of a fixture, as the guess is given them. */
async function guessOf(name) {
  const input = await detect([fx(name)]);
  return mappingOf(input);
}

// ---- S1: the name --------------------------------------------------------------------------------
test('S1: a column headed "place" or "Site" is read as the name; with a name column, "town" is not', async () => {
  const places = await guessOf('places.csv');
  assert.deepEqual(plain(places.mapping), { place: 'name', county: 'within' });
  assert.match(places.reasons.place, /the heading "place" reads as the place's name/);
  const sites = await guessOf('sites.xlsx');
  assert.deepEqual(plain(sites.mapping), { Site: 'name', Lat: 'latitude', Long: 'longitude', Notes: 'note' });
  for (const h of ['Place', 'places', 'Place names', 'site', 'Site name', 'Town', 'village', 'settlement', 'City', 'locality', 'Location', 'Ort', 'Lieu', 'Nom', 'nombre', 'nome']) {
    assert.equal(guessColumns([h], [{ [h]: 'Preston' }, { [h]: 'Chester' }]).mapping[h], 'name', h);
  }
  // Control: beside a column whose heading says it is the name, in either order, "town" is not the
  // name, and says why; and a "location" of numbers is not a name.
  for (const headers of [['name', 'town'], ['town', 'name']]) {
    const g = guessColumns(headers, [{ name: 'The Swan', town: 'Preston' }, { name: 'The Bull', town: 'Chester' }]);
    assert.deepEqual(plain(g.mapping), { name: 'name', town: 'note' }, headers.join());
    assert.match(g.reasons.town, /could be the place's name, but the column "name" is read as the name/);
  }
  assert.equal(guessColumns(['location'], [{ location: '53.76' }, { location: '53.19' }]).mapping.location, 'note');
  // And the file is then read: 8 sites, where before not one row became a place.
  const r = await read(fx('sites.xlsx'));
  assert.equal(r.places.length, 8);
  assert.equal(r.of('generic-nothing-converted'), undefined);
});

test('S1: with no heading that says which column holds the names, the first column of words is taken, and says so', () => {
  const rows = [{ num: '101', what: 'Accrington', area: 'Lancashire' }, { num: '102', what: 'Blackburn', area: 'Lancashire' }, { num: '103', what: 'Chester', area: 'Cheshire' }, { num: '104', what: 'Malpas', area: 'Cheshire' }];
  const g = guessColumns(['num', 'what', 'area'], rows);
  assert.deepEqual(plain(g.mapping), { num: 'note', what: 'name', area: 'note' });
  assert.equal(g.reasons.what, NAME_FALLBACK);
  assert.match(NAME_FALLBACK, /no heading says which column holds the names.*change it if that is wrong/);
  // Controls: a column of numbers is not taken, nor one of codes, nor one that mostly repeats, nor
  // any column when another is the places' web address.
  assert.equal(guessColumns(['n'], [{ n: '12' }, { n: '15' }]).mapping.n, 'note');
  assert.equal(guessColumns(['code'], [{ code: 'A1' }, { code: 'B2' }]).mapping.code, 'note');
  assert.equal(guessColumns(['area'], rows).mapping.area, 'note');
  const a = guessColumns(['uri', 'what'], rows.map((r, i) => ({ uri: `https://example.org/p/${i}`, what: r.what })));
  assert.deepEqual(plain(a.mapping), { uri: 'address', what: 'note' });
});

test('S1: a matching with neither a name nor an address is warned of in the Columns panel\'s words', () => {
  const W = COLUMN_WORDS;
  assert.match(W.noName, /No column is read as the place's name yet/);
  assert.ok(columnWarnings({ a: 'note', b: 'latitude', c: 'longitude' }).includes(W.noName));
  // Control: with a name, or with the places' addresses, it is not; the warning of no ids still is.
  const named = columnWarnings({ a: 'name' });
  assert.ok(!named.includes(W.noName) && named.includes(W.noIds));
  assert.ok(!columnWarnings({ a: 'address' }).includes(W.noName));
});

// ---- D1: number the rows -------------------------------------------------------------------------
test('D1: a table with no ids, its rows numbered at the user\'s asking, gives row-1 to row-5, said once to be made up', async () => {
  // The made column by its name in a saved matching, as the command line's --columns would give it.
  const columns = { name: 'name', '(row number)': 'id' };
  const r = await read(fx('14-one-column.csv'), { columns, base: 'https://example.org/mine/' });
  assert.deepEqual(r.places.map((p) => [p.entityIdentifier, p.label]), [['row-1', 'Aquae Sulis'], ['row-2', 'Eboracum'], ['row-3', 'Deva Victrix'], ['row-4', 'Eboracum'], ['row-5', 'Lindum Colonia']]);
  // The two Eboracums are apart, each with an address of its own, and no id is made from a name.
  assert.deepEqual(r.places.map((p) => p['@id']), [1, 2, 3, 4, 5].map((k) => `https://example.org/mine/place/row-${k}`));
  assert.ok(!r.places.some((p) => /eboracum|aquae/i.test(p['@id'])));
  const said = r.of('generic-row-number-ids');
  assert.equal(said?.severity, 'warning');
  assert.equal(said.count, 1);
  assert.match(said.message, /made up/);
  assert.match(said.message, /rows added or moved later change them/);
  assert.equal(r.of('generic-no-ids'), undefined);
  // The made column is in the matching, last, with its reason, and is kept when the matching is saved.
  assert.equal(ROW_NUMBER, '(row number)');
  assert.ok(numbersRows(columns));
  const m = await mappingOf(r.input, columns);
  assert.deepEqual(m.headers, ['name', ROW_NUMBER]);
  assert.match(m.reasons[ROW_NUMBER], /made up at your asking/);
  assert.deepEqual(m.problems, []);
  assert.deepEqual(plain(mappingToSave(m.mapping)), columns);
  // Control: unasked, the same file has no ids (and is told so), and nothing is numbered.
  const bare = await read(fx('14-one-column.csv'));
  assert.equal(bare.places.length, 5);
  assert.ok(bare.places.every((p) => p['@id'] === undefined));
  assert.ok(bare.of('generic-no-ids'));
  assert.equal(bare.of('generic-row-number-ids'), undefined);
  assert.ok(columnWarnings((await mappingOf(bare.input)).mapping).includes(COLUMN_WORDS.noIds), 'the panel offers the button on this warning');
});

test('D1: a table with ids of its own keeps them, is offered no numbering, and a guess never numbers the rows', async () => {
  const r = await read(fx('00-baseline-with-ids.csv'));
  assert.deepEqual(r.places.map((p) => p.entityIdentifier), ['bath', 'york', 'chester', 'lincoln', undefined]);
  assert.equal(r.of('generic-row-number-ids'), undefined);
  const m = await mappingOf(r.input);
  assert.equal(m.mapping.id, 'id');
  assert.ok(!Object.hasOwn(m.mapping, ROW_NUMBER));
  assert.ok(!columnWarnings(m.mapping).includes(COLUMN_WORDS.noIds), 'no warning, so no button');
  // Asked for beside an id column of the file's own, the made column loses: one column only is the id.
  const both = resolveColumns(['id', 'name', ROW_NUMBER], [], { id: 'id', name: 'name', [ROW_NUMBER]: 'id' });
  assert.equal(both.mapping.id, 'id');
  assert.equal(both.mapping[ROW_NUMBER], 'note');
  // Control for numbersRows: only "id" asks; a note or a skip does not.
  assert.ok(!numbersRows({ name: 'name', [ROW_NUMBER]: 'note' }) && !numbersRows({ name: 'name' }) && !numbersRows(undefined));
});

// ---- robust R-05: a list with no heading row ---------------------------------------------------------
test('R-05: a one-column file with no heading row keeps its first name once the first row is said to be a place', async () => {
  const f = () => fx('14c-one-column-no-header.csv');
  const input = await detect([f()]);
  assert.equal(input.headingDoubt, true, 'the page ticks the Reading option beforehand on this');
  const said = await read(f(), { firstRowIsPlace: true });
  assert.deepEqual(said.places.map((p) => p.label), ['Aquae Sulis', 'Eboracum', 'Deva Victrix', 'Lindum Colonia']);
  assert.equal(said.of('generic-first-row-is-place')?.severity, 'warning');
  assert.equal(said.of('generic-heading-doubt'), undefined);
  const m = await mappingOf(withFirstRow(input, true));
  assert.deepEqual(m.headers, ['name']);
  assert.deepEqual(plain(m.mapping), { name: 'name' });
  // Numbered too, the first name is row-1.
  const numbered = await read(f(), { firstRowIsPlace: true, columns: { name: 'name', '(row number)': 'id' } });
  assert.deepEqual(numbered.places.map((p) => [p.entityIdentifier, p.label])[0], ['row-1', 'Aquae Sulis']);
  // Said to be a heading (the option unticked), it is one: three places, as before, and no more is said.
  const heading = await read(f(), { firstRowIsPlace: false });
  assert.deepEqual(heading.places.map((p) => p.label), ['Eboracum', 'Deva Victrix', 'Lindum Colonia']);
  assert.equal(heading.of('generic-heading-doubt'), undefined);
  assert.equal(heading.of('generic-first-row-is-place'), undefined);
  // Nobody says (the command line): read as a heading, as before, but no longer without a word.
  const unsaid = await read(f());
  assert.equal(unsaid.places.length, 3);
  assert.deepEqual(unsaid.of('generic-heading-doubt')?.examples, ['14c-one-column-no-header.csv: "Aquae Sulis"']);
});

test('R-05: a file with a heading these tools know is not doubted, and a first row of decimals is still refused', async () => {
  const headed = await detect([fx('14-one-column.csv')]);
  assert.equal(headed.format, 'csv');
  assert.equal(headed.headingDoubt, undefined);
  const r = await read(fx('14-one-column.csv'));
  assert.equal(r.places.length, 5);
  assert.equal(r.of('generic-heading-doubt'), undefined);
  // "place" and "Site" are known too; a table of two columns is never doubted on its first row's words.
  assert.equal((await detect([textFile('Site\nChester\nPreston\n', 's.csv')])).headingDoubt, undefined);
  assert.equal((await detect([textFile('Chester,Cheshire\nPreston,Lancashire\n', 't.csv')])).headingDoubt, undefined);
  assert.equal((await detect([fx('08b-no-header-row.csv')])).reason, HEADERLESS_REASON);
  // Control: the doubt is found where it should be (the same call, on a list with no heading).
  assert.equal((await detect([textFile('Chester\nPreston\n', 'u.csv')])).headingDoubt, true);
  // Asked for a file that is not a plain CSV table, the option changes nothing.
  assert.equal(withFirstRow({ format: 'geojson' }, true).firstRowIsPlace, undefined);
});
