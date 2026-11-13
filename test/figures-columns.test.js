// The mapping of a table of figures (src/engine/hermes/columns.js, figures.js): the roles a column can
// have besides a place's (period, dimension, value, figure), the table's description beside the columns,
// what a saved mapping gives back, and what is refused. The place half is hermes-columns.test.js's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, FIGURE_FIELDS, figuresSpec, resolveColumns, guessColumns, mappingToSave } from '../src/engine/hermes/columns.js';
import { readsFigures } from '../src/engine/hermes/figures.js';
import { savedColumns, mappingOf } from '../src/engine/hermes/generic.js';
import { splitMatching } from '../src/engine/hermes/cluster.js';
import { detect } from '../src/engine/input.js';

const HEADERS = ['Id', 'Place', 'Year', 'Occupation', 'Persons', 'Farmers', 'All'];
const COLUMNS = {
  Id: 'id', Place: 'name', Year: 'period',
  Occupation: { field: 'dimension', dimension: 'occupation' },
  Persons: { field: 'value', measure: 'persons' },
  Farmers: { field: 'figure', coordinates: { occupation: 'Farmers' }, measure: 'persons' },
  All: { field: 'figure', coordinates: { occupation: 'All' }, measure: 'persons', totalOf: ['Farmers'] },
};
const TABLE = { title: 'T', source: 'S', dimensions: { occupation: { total: 'All' } } };
const problems = (r) => r.problems.map((p) => `${p.kind}: ${p.example}`);

test('the figure roles are fields of the mapping, with words, and period alone takes one column', () => {
  for (const f of ['period', 'dimension', 'value', 'figure']) { assert.ok(FIELDS[f].words, f); assert.ok(FIGURE_FIELDS.has(f), f); }
  assert.equal(FIELDS.period.single, true);
  assert.equal(FIELDS.value.single, false, 'several measures, several columns');
  assert.ok(!FIGURE_FIELDS.has('name') && !FIGURE_FIELDS.has('date'));
});
test('a mapping with the roles and their entries resolves as given, and gives the entries back', () => {
  for (const saved of [COLUMNS, { columns: COLUMNS, table: TABLE }, { columns: COLUMNS }]) {
    const r = resolveColumns(HEADERS, [], saved);
    assert.deepEqual(problems(r), []);
    assert.deepEqual({ ...r.mapping }, { Id: 'id', Place: 'name', Year: 'period', Occupation: 'dimension', Persons: 'value', Farmers: 'figure', All: 'figure' });
    assert.deepEqual({ ...r.figures.Occupation }, { dimension: 'occupation' });
    assert.deepEqual({ ...r.figures.All }, { measure: 'persons', coordinates: { occupation: 'All' }, totalOf: ['Farmers'] });
    assert.equal(r.figures.Id, undefined);
    assert.deepEqual(r.table, saved.table);
    // ... and the entries go back into the one JSON object that is saved.
    assert.deepEqual(JSON.parse(JSON.stringify(mappingToSave(r.mapping, r.patterns, r.levels, r.splits, r.figures))), COLUMNS);
  }
});
test('a role given as a word alone is the role with nothing said of it', () => {
  const r = resolveColumns(['County', 'Persons'], [], { County: 'name', Persons: 'value' });
  assert.deepEqual(problems(r), []);
  assert.deepEqual([r.mapping.Persons, r.figures.Persons], ['value', undefined]);
});
test('an entry with a key that does not go with its role, or a value given wrongly, keeps the column in the notes and says why', () => {
  const bad = {
    Id: 'id', Place: 'name',
    Year: { field: 'period', measure: 'x' },
    Occupation: { field: 'dimension', coordinates: { a: 'b' } },
    Persons: { field: 'value', dimension: 'x' },
    Farmers: { field: 'figure', dimension: 'x' },
    All: { field: 'figure', totalOf: 'Farmers' },
    extra1: { field: 'name', totalOf: ['a'] },
    extra2: { field: 'figure', coordinates: {} },
    extra3: { field: 'figure', coordinates: { a: '' } },
    extra4: { field: 'value', measure: '' },
    extra5: { field: 'dimension', dimension: 3 },
    extra6: { field: 'figure', totalOf: ['a', 'a'] },
  };
  const r = resolveColumns(Object.keys(bad), [], bad);
  assert.equal(r.problems.length, 11);
  assert.ok(r.problems.every((p) => p.kind === 'generic-mapping'));
  for (const h of ['Year', 'Occupation', 'Persons', 'Farmers', 'All', 'extra1', 'extra2', 'extra3', 'extra4', 'extra5', 'extra6']) assert.equal(r.mapping[h], 'note', h);
  assert.deepEqual([r.mapping.Id, r.mapping.Place], ['id', 'name']);
  assert.deepEqual(Object.keys(r.figures), []);
  assert.match(r.problems.find((p) => p.example.startsWith('Year')).example, /"measure" goes with "value" or "figure", not "period"/);
  // Control: the same keys on the roles that take them are accepted.
  const good = resolveColumns(HEADERS, [], COLUMNS);
  assert.equal(good.problems.length, 0);
});
test('one period column only', () => {
  const r = resolveColumns(['Id', 'a', 'b'], [], { Id: 'id', a: 'period', b: 'period' });
  assert.deepEqual([r.mapping.a, r.mapping.b], ['period', 'note']);
  assert.equal(r.problems.length, 1);
});
test('a column headed "columns" or "table" is a column, not the description: an entry for each is a mapping alone', () => {
  const alone = { columns: 'note', table: { field: 'value', measure: 'persons' }, Place: 'name' };
  assert.equal(figuresSpec(alone), null);
  const r = resolveColumns(['columns', 'table', 'Place'], [], alone);
  assert.deepEqual({ ...r.mapping }, { columns: 'note', table: 'value', Place: 'name' });
  assert.equal(r.table, undefined);
  assert.equal(figuresSpec({ columns: COLUMNS, table: TABLE }).table, TABLE);
  assert.equal(figuresSpec({ columns: COLUMNS }).columns, COLUMNS);
  assert.equal(figuresSpec({ columns: COLUMNS, table: 'x' }), null);
  // Control: a mapping with both headings and a table beside it is a description, and the columns are not read as columns.
  assert.ok(figuresSpec({ columns: { columns: 'note' }, table: { title: 'x' } }));
  // The run's options carry the description too, and a saved matching with groups of spellings keeps it.
  assert.deepEqual(savedColumns({ columns: { columns: COLUMNS, table: TABLE }, base: 'x' }), { columns: COLUMNS, table: TABLE });
  assert.deepEqual(splitMatching({ columns: COLUMNS, table: TABLE, clusters: { Place: { method: 'fingerprint', groups: [] } } }).columns.table, TABLE);
});
test('which mappings are tables of figures', () => {
  assert.equal(readsFigures(COLUMNS), true);
  assert.equal(readsFigures({ columns: COLUMNS, table: TABLE }), true);
  assert.equal(readsFigures({ columns: { Persons: 'value' } }), true);
  assert.equal(readsFigures({ Year: 'period' }), true);
  // Control: a table of places is not, nor is a mapping that is nothing.
  assert.equal(readsFigures({ Name: 'name', When: 'date', Lat: 'latitude' }), false);
  assert.equal(readsFigures({ columns: { Name: 'name' }, table: {} }), false);
  assert.equal(readsFigures(undefined), false);
  assert.equal(readsFigures([]), false);
});
test('a guess never makes a column of figures: only a mapping given does', () => {
  const g = guessColumns(['Place', 'Year', 'Persons', 'Count', 'Total', 'Value'], [{ Place: 'A', Year: '1851', Persons: '5', Count: '1', Total: '6', Value: '7' }]);
  assert.ok(!Object.values(g.mapping).some((f) => FIGURE_FIELDS.has(f)), JSON.stringify(g.mapping));
  // "Place" is read as the name (columns.js, WEAK_NAME); a heading that says nothing of its role is kept in the notes.
  assert.equal(g.mapping.Place, 'name');
  assert.equal(g.mapping.Persons, 'note', 'a heading that says nothing of its role is kept in the notes');
  assert.deepEqual({ ...g.figures }, {});
});
test('a table of figures is read by the engine as the mapping says: the mapping of a run, and its profile', async () => {
  const f = new File(['Id,Place,Year,Occupation,Persons\na,A,1851,x,1\n'], 't.csv');
  const input = await detect([f]);
  const m = await mappingOf(input, { columns: { Id: 'id', Place: 'name', Year: 'period', Occupation: { field: 'dimension' }, Persons: { field: 'value' } }, table: { title: 'T' } });
  assert.deepEqual({ ...m.mapping }, { Id: 'id', Place: 'name', Year: 'period', Occupation: 'dimension', Persons: 'value' });
  assert.deepEqual(m.table, { title: 'T' });
  assert.deepEqual(m.headers, ['Id', 'Place', 'Year', 'Occupation', 'Persons']);
});
