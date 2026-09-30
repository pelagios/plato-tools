// Chora's search box (search() in src/engine/chora/store.js): a place is found by its label and by
// every current name its attestations give it, toponym and romanized form, case and accents aside,
// in dataset order; a hit by a name that is not the label says which name it was. Each name left out
// here (withdrawn, denied) has its control beside it: the same name, not withdrawn or not denied, IS
// found, so that no absence below could pass by the search finding nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, textFile, go, outText } from './engine.js';
import { detect } from '../src/engine/input.js';
import { load, fold } from '../src/engine/chora/store.js';

const X = 'https://example.org/', P = 'https://w3id.org/plato#';
const id = (s) => `${X}place/${s}`, att = (s) => `${X}attestation/${s}`;
const src = { '@id': X + 'source/s', title: 'A survey' };
const named = (a, ...names) => ({ '@id': att(a), names, sources: [src] });
const retract = (a, target) => ({ '@id': att(a), meta: { targetAttestation: att(target), metaType: P + 'Retracts' }, sources: [src] });

/**
 * Byzantium's "Nova Roma" is retracted by an attestation under ANOTHER place (Rome), so it is known
 * to be withdrawn only once the whole dataset is read. `retracted: false` leaves the retraction out.
 */
const dataset = ({ retracted = true, denied = true } = {}) => ({
  profile: 'place-centric',
  gazetteer: { '@id': X + 'g', title: 'Chora search test', status: 'published', version: '1' },
  spatialEntities: [
    { '@id': id('conway'), label: 'Conway', attestations: [named('c1', { toponym: 'Aberconwy' })] },
    { '@id': id('byzantium'), label: 'Byzantium', ccodes: ['TR'], attestations: [
      named('b1', { toponym: 'Constantinople' }),
      named('b2', { toponym: 'Κωνσταντινούπολις', language: 'grc', romanized: 'Konstantinoupolis' }),
      named('b3', { toponym: 'Nova Roma' }),
      // The same name twice: once withdrawn, once not. It stays a current name.
      named('b4', { toponym: 'Lygos' }),
      named('b5', { toponym: 'Lygos' }),
      { '@id': att('b6'), negated: denied, names: [{ toponym: 'Troia' }], sources: [src] },
    ] },
    { '@id': id('athens'), label: 'Athens', ccodes: ['GR'], attestations: [named('a1', { toponym: 'Ἀθῆναι', language: 'grc', romanized: 'Athēnai' })] },
    { '@id': id('rome'), label: 'Rome', attestations: [
      named('r1', { toponym: 'Roma' }),
      ...(retracted ? [retract('r2', 'b3'), retract('r3', 'b4')] : []),
    ] },
    { '@id': id('concord'), label: 'Concord', attestations: [] },
    // No @id: found under its position, as everywhere else in Chora.
    { label: 'Nameless', attestations: [named('n1', { toponym: 'Anonymopolis' })] },
    ...[1, 2, 3, 4, 5].map((k) => ({ '@id': id(`v${k}`), label: `Place ${k}`, attestations: [named(`v${k}`, { toponym: `Villa ${k}` })] })),
  ],
});
async function open(ds = dataset(), name = 'search.json') {
  const e = env();
  return load(await detect([textFile(typeof ds === 'string' ? ds : JSON.stringify(ds), name)]), e, await e.openDb());
}
const hits = (r) => r.items.map((i) => (i.matched ? `${i.label} — ${i.matched}` : i.label));

test('a place is found by a name that is not its label, and the hit says which name', async () => {
  const s = await open();
  const r = s.search('constantinople');
  assert.equal(r.total, 1);
  assert.deepEqual(r.items, [{ id: id('byzantium'), label: 'Byzantium', ccodes: ['TR'], hasGeometry: false, matched: 'Constantinople' }]);
  // A place found by its label says nothing more: the label is what the list shows already.
  assert.deepEqual(s.search('byzant').items, [{ id: id('byzantium'), label: 'Byzantium', ccodes: ['TR'], hasGeometry: false }]);
  // A place with no @id, found by a name.
  assert.deepEqual(hits(s.search('anonymo')), ['Nameless — Anonymopolis']);
  assert.equal(s.search('anonymo').items[0].id, '#6');
});

test('a romanized name is found, and shown as the name that matched', async () => {
  const s = await open();
  assert.deepEqual(hits(s.search('konstantinou')), ['Byzantium — Konstantinoupolis']);
});

test('names are folded as labels are: case and accents aside, in any script', async () => {
  const s = await open();
  assert.deepEqual(hits(s.search('athenai')), ['Athens — Athēnai'], 'the romanized form, its macron folded');
  assert.deepEqual(hits(s.search('ΑΘΗΝΑΙ')), ['Athens — Ἀθῆναι'], 'the Greek toponym, breathing and accent folded, upper case');
  assert.deepEqual(hits(s.search('κωνσταντινουπολις')), ['Byzantium — Κωνσταντινούπολις']);
});

test('a withdrawn name is not found, even when retracted under another place; not withdrawn, it is', async () => {
  const s = await open();
  assert.equal(s.search('nova roma').total, 0);
  // Presence in the same dataset: the place is there, and found by its other names.
  assert.deepEqual(hits(s.search('constantinople')), ['Byzantium — Constantinople']);
  // The same name given again by an attestation that is not withdrawn stays a current name.
  assert.deepEqual(hits(s.search('lygos')), ['Byzantium — Lygos']);
  const control = await open(dataset({ retracted: false }));
  assert.deepEqual(hits(control.search('nova roma')), ['Byzantium — Nova Roma']);
});

test('a denied name is not found; the same name not denied is', async () => {
  const s = await open();
  assert.equal(s.search('troia').total, 0);
  const control = await open(dataset({ denied: false }));
  assert.deepEqual(hits(control.search('troia')), ['Byzantium — Troia']);
});

test('hits by label and by name come together in dataset order, a place once however many of its names match', async () => {
  const s = await open();
  // Conway by its label (and by its name Aberconwy too: shown once, as a label hit), Byzantium by a
  // name, Concord by its label: in the order of the file, not labels first.
  assert.deepEqual(hits(s.search('con')), ['Conway', 'Byzantium — Constantinople', 'Concord']);
  assert.equal(s.search('con').total, 3);
  // Rome by its label and its name Roma; Byzantium's Nova Roma is withdrawn, so Byzantium is not here.
  assert.deepEqual(hits(s.search('rom')), ['Rome']);
  // Several of a place's names match: the first of them, in attestation order, is shown.
  assert.deepEqual(hits(s.search('on')), ['Conway', 'Byzantium — Constantinople', 'Concord', 'Nameless — Anonymopolis']);
  const empty = s.search('');
  assert.equal(empty.total, 11, 'an empty query lists every place once');
  assert.deepEqual(empty.items.slice(0, 5).map((i) => i.label), ['Conway', 'Byzantium', 'Athens', 'Rome', 'Concord']);
  assert.ok(empty.items.every((i) => !('matched' in i)));
  assert.equal(s.search('%').total, 0, 'a wildcard is searched for as itself in names too');
});

test('paging goes on from the last place shown (keyset, not an offset), and keeps the count and the matched names', async () => {
  const s = await open();
  const first = s.search('villa', { limit: 2 });
  assert.equal(first.total, 5);
  assert.deepEqual(hits(first), ['Place 1 — Villa 1', 'Place 2 — Villa 2']);
  assert.equal(typeof first.next, 'number', 'a page with more after it says where the next begins');
  const second = s.search('villa', { after: first.next, limit: 2 });
  assert.equal(second.total, 5);
  assert.deepEqual(hits(second), ['Place 3 — Villa 3', 'Place 4 — Villa 4']);
  const last = s.search('villa', { after: second.next, limit: 2 });
  assert.deepEqual(hits(last), ['Place 5 — Villa 5']);
  assert.equal(last.next, null, 'the last page has nothing after it');
  // Exactly a page's worth left: still no next page.
  assert.equal(s.search('villa', { after: first.next, limit: 3 }).next, null);
  // The empty query pages the same way.
  const e1 = s.search('', { limit: 4 });
  assert.deepEqual(e1.items.map((i) => i.label), ['Conway', 'Byzantium', 'Athens', 'Rome']);
  assert.deepEqual(s.search('', { after: e1.next, limit: 2 }).items.map((i) => i.label), ['Concord', 'Nameless']);
});

test('the count is worked out once per query, not again for each page', async () => {
  const s = await open();
  const counted = [];
  const one = s.one.bind(s);
  s.one = (sql, params) => { if (/COUNT/i.test(sql)) counted.push(params?.[0] ?? ''); return one(sql, params); };
  const a = s.search('villa', { limit: 2 });
  s.search('villa', { after: a.next, limit: 2 });
  s.search('VÍLLA', { after: a.next, limit: 2 });
  assert.equal(counted.length, 1, `counted ${counted.length} times`);
  assert.equal(s.search('place', { limit: 2 }).total, 5);
  assert.equal(counted.length, 2, 'a new query is counted');
});

test('ligatures and old letters are folded as their spellings: œ, æ, þ, ð, ß', async () => {
  assert.equal(fold('Brabœuf'), 'braboeuf');
  assert.equal(fold('ÆTHELNEY'), 'aethelney');
  assert.equal(fold('Þanet'), 'thanet');
  assert.equal(fold('Ðorp'), 'thorp');
  assert.equal(fold('Straße'), 'strasse');
  assert.equal(fold('STRAẞE'), 'strasse');
  const ds = dataset();
  ds.spatialEntities.push({ '@id': id('brabœuf'), label: 'Brabœuf', attestations: [named('l1', { toponym: 'Þanet' })] });
  const s = await open(ds);
  assert.deepEqual(hits(s.search('braboeuf')), ['Brabœuf']);
  assert.deepEqual(hits(s.search('BRABŒUF')), ['Brabœuf'], 'the query is folded as the labels are');
  assert.deepEqual(hits(s.search('thanet')), ['Brabœuf — Þanet']);
});

test('the overview reads a covering index of the places with a point, not the records', async () => {
  const s = await open();
  const seen = [];
  const prepare = s.db.prepare.bind(s.db);
  s.db.prepare = (sql) => { seen.push(sql); return prepare(sql); };
  s.overview();
  s.db.prepare = prepare;
  assert.equal(seen.length, 1);
  const plan = [...s.rows('EXPLAIN QUERY PLAN ' + seen[0], [1])].map((q) => q.get(3)).join(' | ');
  assert.match(plan, /COVERING INDEX/, plan);
});

test('names reach the search from every route: JSON Lines and N-Triples', async () => {
  for (const target of ['plato-jsonl', 'ntriples']) {
    const r = await go([textFile(JSON.stringify(dataset()), 'search.json')], 'convert', target);
    const name = r.outputs[0].name;
    const s = await open(outText(r.e, name), name);
    assert.deepEqual(hits(s.search('konstantinou')), ['Byzantium — Konstantinoupolis'], target);
    assert.equal(s.search('nova roma').total, 0, target);
    assert.equal(s.search('constantinople').total, 1, target);
  }
});
