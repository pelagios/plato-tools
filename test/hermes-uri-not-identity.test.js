// WHG's LP-TSV has a column title_uri holding the URL of the source where the NAME was found, one value
// for many places. A heading that only ENDS like an address is not the place's address when the table has
// a column of ids (issue #42: 100 rows became 79 places). Every test that asserts an absence asserts, in
// the same test, a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/engine/input.js';
import { Report, LOSS_TEXT } from '../src/engine/report.js';
import { genericSource } from '../src/engine/hermes/generic.js';
import { GENERIC_KINDS, guessColumns } from '../src/engine/hermes/columns.js';
import { textFile } from './engine.js';

async function readAll(csv) {
  const input = await detect([textFile(csv, 'x.csv')]);
  const rep = new Report();
  const events = [];
  for await (const ev of genericSource(input, rep, {})) events.push(ev);
  const { items } = rep.toJSON();
  return { events, items, of: (k) => items.find((i) => i.kind === k), places: events.filter((e) => e.type === 'record').length, attestations: events.filter((e) => e.type === 'attestation') };
}

const LP = 'id,title,title_uri\na1,Emesa,https://example.org/src/\na2,Harran,https://example.org/src/\na3,Gora,\n';

test('title_uri beside an id column is a note: three rows stay three places, and no merge is reported', async () => {
  const r = await readAll(LP);
  assert.equal(r.places, 3, 'present: three places');
  assert.equal(r.attestations.length, 0, 'no attestations about a shared address');
  assert.equal(r.of('generic-address-merges-ids'), undefined);
});

test('the guess says why title_uri is a note, and a heading named uri is still the address (control)', async () => {
  const g = guessColumns(['id', 'title', 'title_uri'], [{ id: 'a1', title: 'Emesa', title_uri: 'https://example.org/src/' }]);
  assert.equal(g.mapping.title_uri, 'note');
  assert.match(g.reasons.title_uri, /column of ids/);
  const c = guessColumns(['id', 'title', 'uri'], [{ id: 'a1', title: 'Emesa', uri: 'https://example.org/src/' }]);
  assert.equal(c.mapping.uri, 'address', 'control: a heading exactly uri is read as the address');
});

test('title_uri with NO id column is still the address (control: the rule needs an id column)', async () => {
  const g = guessColumns(['title', 'title_uri'], [{ title: 'Emesa', title_uri: 'https://example.org/p/1' }]);
  assert.equal(g.mapping.title_uri, 'address');
});

test('a real address column that merges rows with different ids says so, naming both rows', async () => {
  const r = await readAll('id,title,uri\na1,Emesa,https://example.org/p/1\na2,Homs,https://example.org/p/1\na3,Gora,https://example.org/p/2\n');
  assert.equal(r.attestations.length, 3, 'present: each row is an attestation');
  const m = r.of('generic-address-merges-ids');
  assert.ok(m, 'reported');
  assert.equal(m.n ?? 1, 1);
  assert.match(m.examples[0], /row 3.*a2.*row 2.*a1/);
  assert.equal(GENERIC_KINDS['generic-address-merges-ids'], 'warning');
  assert.ok(LOSS_TEXT['generic-address-merges-ids']);
});

test('rows that share an address AND an id are not reported as merged (control)', async () => {
  const r = await readAll('id,title,uri\na1,Emesa,https://example.org/p/1\na1,Emesa,https://example.org/p/1\n');
  assert.equal(r.attestations.length, 2, 'present: both rows read');
  assert.equal(r.of('generic-address-merges-ids'), undefined);
});
