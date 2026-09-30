import { PLATO_REPO } from './paths.js';
// The version check (src/engine/compare.js): PLATO's append-only rule between two versions of a
// published dataset. Every attestation of the earlier version must be in the later one, saying
// what it said; a correction is a new attestation that retracts or replaces the old one, which stays.
//
// A comparison that finds nothing is only worth having if it could have found something. So each
// breach here is one edit to a version that passes, and every passing comparison also asserts how
// many attestations it compared: a pair of files that were not read compares clean too.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, file, textFile, go, outText } from './engine.js';
import { DatabaseSync } from 'node:sqlite';
import { compare, QUERIES, Ledger } from '../src/engine/compare.js';
import { detect } from '../src/engine/input.js';
import { sha256 } from '../src/lib/sha256.js';
import { summary } from '../src/engine/words.js';

const P = 'https://w3id.org/plato#', X = 'https://example.org/';
const JUDGEMENTS = `${PLATO_REPO}/schemas/examples/place-centric-judgements.json`;
const A = X + 'attestation/';
const src = { '@id': X + 'source/s', title: 'S' };
const G1 = { '@id': X + 'g/1', title: 't', licence: 'https://creativecommons.org/licenses/by/4.0/', version: '1', status: 'published', isVersionOf: X + 'g' };
const G2 = { ...G1, '@id': X + 'g/2', version: '2', previousVersion: X + 'g/1' };
const place = (id, attestations, more = {}) => ({ '@id': `${X}place/${id}`, label: id, attestations, ...more });
/** Two places, three attestations: two with addresses, one without. */
const places = () => [
  place('a', [
    { '@id': A + 'a1', names: [{ toponym: 'Oldford' }], sources: [src], created: '2026-01-01T00:00:00Z' },
    { names: [{ toponym: 'Anon' }], timespans: [{ startEarliest: '1086', endLatest: '1086' }], sources: [src] },
  ]),
  place('b', [{ '@id': A + 'b1', geometries: [{ geojson: { type: 'Point', coordinates: [1.5, 52.25] } }], citations: [{ source: src, locator: 'f. 1' }] }]),
];
const doc = (spatialEntities, gazetteer, more = {}) => ({ profile: 'place-centric', gazetteer, spatialEntities, ...more });
const json = (d, name = 'v.json') => textFile(JSON.stringify(d), name);
const v1 = () => json(doc(places(), G1), 'v1.json');
/** The later version: the earlier one's places, edited by `edit`. */
const v2 = (edit = () => {}, gazetteer = G2) => { const p = places(); const d = doc(p, gazetteer); edit(p, d); return json(d, 'v2.json'); };

async function cmp(earlier, later) {
  const r = await compare({ earlier: await detect([].concat(earlier)), later: await detect([].concat(later)) }, env());
  return { ...r.report, incomplete: !!r.incomplete };
}
const kinds = (r, severity) => r.items.filter((i) => i.severity === severity).map((i) => i.kind).sort();
const item = (r, kind) => r.items.find((i) => i.kind === kind);

// ---- the digest ------------------------------------------------------------------------------------
test('sha256 gives the digests Node gives, across block boundaries and beyond ASCII', () => {
  const node = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const s of ['', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(119), 'a'.repeat(120), 'Ἑρμῆς χώρα 𝄞', 'x'.repeat(70000)]) assert.equal(sha256(s), node(s), `length ${s.length}`);
  for (let i = 0; i < 300; i++) { const s = randomBytes(i).toString('base64') + 'é'.repeat(i % 5); assert.equal(sha256(s), node(s)); }
  assert.notEqual(sha256('a'), sha256('b'));
});

// ---- nothing changed ---------------------------------------------------------------------------------
test('a version compared with itself: nothing deleted or changed, and all three attestations were compared', async () => {
  const r = await cmp(v1(), v2());
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  assert.deepEqual(r.counts, { earlier: 3, later: 3, unchanged: 3, changed: 0, lost: 0, added: 0, retracted: 0, superseded: 0 });
  // The one attestation without an address is said to be so; nothing else is worth a look.
  assert.deepEqual(kinds(r, 'warning'), ['earlier-unidentified']);
  assert.equal(item(r, 'earlier-unidentified').count, 1);
  assert.match(summary(r, 'compare').problems, /^Nothing was deleted or changed\.$/);
});
test("PLATO's judgements example compared with itself: all ten attestations unchanged", async () => {
  const r = await cmp(file(JUDGEMENTS), file(JUDGEMENTS));
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  assert.deepEqual([r.counts.earlier, r.counts.unchanged, r.counts.retracted], [10, 10, 0], 'the retraction it already held is not counted as new');
});

// ---- the rule kept: additions, retractions, supersessions ----------------------------------------------
test('added attestations, one retracting and one replacing earlier ones, keep the rule, and are counted', async () => {
  const later = v2((p) => {
    p[0].attestations.push({ '@id': A + 'a2', names: [{ toponym: 'Newford' }], sources: [src], created: '2026-09-01T00:00:00Z', meta: { targetAttestation: A + 'a1', metaType: P + 'Supersedes' } });
    p[1].attestations.push({ '@id': A + 'b2', sources: [src], created: '2026-09-01T00:00:00Z', meta: { targetAttestation: A + 'b1', metaType: P + 'Retracts' } });
    p.push(place('c', [{ '@id': A + 'c1', names: [{ toponym: 'Third' }], sources: [src], created: '2026-09-01T00:00:00Z' }]));
  });
  const r = await cmp(v1(), later);
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  assert.deepEqual(r.counts, { earlier: 3, later: 6, unchanged: 3, changed: 0, lost: 0, added: 3, retracted: 1, superseded: 1 });
  assert.equal(item(r, 'added-without-created'), undefined);
  assert.match(summary(r, 'compare').counted, /3 of them new; it retracts 1 and replaces 1 of the earlier ones/);
});
test('an added attestation that does not say when it was made is a warning, by its address or its place', async () => {
  const later = v2((p) => { p[0].attestations.push({ '@id': A + 'a2', names: [{ toponym: 'N' }], sources: [src] }, { names: [{ toponym: 'M' }], sources: [src] }); });
  const r = await cmp(v1(), later);
  assert.equal(r.errors, 0);
  assert.equal(item(r, 'added-without-created').count, 2);
  assert.deepEqual(item(r, 'added-without-created').examples.sort(), [`an attestation about ${X}place/a`, A + 'a2'].sort());
});

// ---- the rule broken: each one edit to a version that passes ---------------------------------------------
test('an attestation deleted is a problem, named by its address', async () => {
  const r = await cmp(v1(), v2((p) => { p[1].attestations = []; }));
  assert.deepEqual(kinds(r, 'error'), ['attestation-removed']);
  assert.deepEqual(item(r, 'attestation-removed').examples, [A + 'b1']);
  assert.deepEqual([r.counts.unchanged, r.counts.lost, r.counts.changed], [2, 1, 0]);
  assert.match(summary(r, 'compare').problems, /^1 problem found\.$/);
});
test('deleting an attestation and retracting it in the same version is still a deletion: the retracted claim stays', async () => {
  const r = await cmp(v1(), v2((p) => { p[1].attestations = [{ '@id': A + 'b2', sources: [src], created: '2026-09-01T00:00:00Z', meta: { targetAttestation: A + 'b1', metaType: P + 'Retracts' } }]; }));
  assert.deepEqual(kinds(r, 'error'), ['attestation-removed']);
});
for (const [what, edit] of [
  ['a name respelt', (p) => { p[0].attestations[0].names[0].toponym = 'Oldeford'; }],
  ['a statement added to it', (p) => { p[0].attestations[0].notes = 'now with a note'; }],
  ['a statement taken from it', (p) => { delete p[0].attestations[0].created; }],
  ['its source changed for another', (p) => { p[0].attestations[0].sources = [{ '@id': X + 'source/other', title: 'Other' }]; }],
  ['a second name added', (p) => { p[0].attestations[0].names.push({ toponym: 'Also' }); }],
  ['moved to another place', (p) => { p[1].attestations.push(p[0].attestations.shift()); }],
]) {
  test(`an attestation changed (${what}) is a problem, named by its address`, async () => {
    const r = await cmp(v1(), v2(edit));
    assert.deepEqual(kinds(r, 'error'), ['attestation-changed'], JSON.stringify(r.items));
    assert.deepEqual(item(r, 'attestation-changed').examples, [A + 'a1']);
    assert.deepEqual([r.counts.unchanged, r.counts.changed, r.counts.lost], [2, 1, 0]);
  });
}
test('a coordinate changed in a geometry, and a locator in a citation, are each a change', async () => {
  for (const edit of [(p) => { p[1].attestations[0].geometries[0].geojson.coordinates = [52.25, 1.5]; }, (p) => { p[1].attestations[0].citations[0].locator = 'f. 2'; }]) {
    const r = await cmp(v1(), v2(edit));
    assert.deepEqual(item(r, 'attestation-changed')?.examples, [A + 'b1'], JSON.stringify(r.items));
  }
});
test('an attestation with no address, changed or deleted, is a problem that names its place and says the two cannot be told apart', async () => {
  for (const edit of [(p) => { p[0].attestations[1].timespans[0].endLatest = '1087'; }, (p) => { p[0].attestations.pop(); }]) {
    const r = await cmp(v1(), v2(edit));
    assert.deepEqual(kinds(r, 'error'), ['attestation-gone'], JSON.stringify(r.items));
    assert.deepEqual(item(r, 'attestation-gone').examples, [X + 'place/a']);
    assert.match(item(r, 'attestation-gone').message, /deleted, or changed/);
    assert.equal(r.counts.lost, 1);
  }
});
test('two attestations with no address that say the same: losing one of them is found', async () => {
  const twin = { names: [{ toponym: 'Twin' }], sources: [src] };
  const earlier = json(doc([place('a', [twin, twin])], G1));
  assert.equal((await cmp(earlier, json(doc([place('a', [twin, twin])], G2)))).errors, 0);
  const r = await cmp(earlier, json(doc([place('a', [twin])], G2)));
  assert.equal(item(r, 'attestation-gone')?.count, 1, JSON.stringify(r.items));
});
test('an attestation with no address is not found in one that says the same under an address the earlier version had', async () => {
  // a1 is copied over the unaddressed attestation: a1 is still there, but the other is gone.
  const r = await cmp(v1(), v2((p) => { p[0].attestations.pop(); }));
  assert.equal(item(r, 'attestation-gone')?.count, 1);
  const same = { names: [{ toponym: 'Same' }], sources: [src] };
  const earlier = json(doc([place('a', [{ '@id': A + 'x', ...same }, same])], G1));
  const r2 = await cmp(earlier, json(doc([place('a', [{ '@id': A + 'x', ...same }])], G2)));
  assert.equal(item(r2, 'attestation-gone')?.count, 1, JSON.stringify(r2.items));
});
test('an attestation with no address that is given one, and says what it said, is unchanged', async () => {
  const r = await cmp(v1(), v2((p) => { p[0].attestations[1]['@id'] = A + 'a-anon'; }));
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  assert.equal(r.counts.unchanged, 3);
});

// ---- what is compared is what is said, not how it is written ----------------------------------------------
test('the same statements written another way are unchanged: keys reordered, a source cited by address, places reordered', async () => {
  const later = v2((p) => {
    p[0].attestations[0] = Object.fromEntries(Object.entries(p[0].attestations[0]).reverse());
    p[1].attestations[0].citations[0].source = src['@id'];      // described in full elsewhere in the file
    p.reverse();
  });
  const r = await cmp(v1(), later);
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  assert.deepEqual([r.counts.unchanged, r.counts.added], [3, 0]);
  assert.deepEqual(kinds(r, 'warning'), ['earlier-unidentified']);
});
for (const target of ['ntriples', 'plato-jsonl']) {
  test(`a version converted to ${target} compares as unchanged with the JSON it came from, both ways round`, async () => {
    const conv = await go([v1()], 'convert', target, { typing: true });
    const name = Object.keys(conv.e.outs)[0];
    const other = textFile(outText(conv.e, name), name);
    for (const [a, b] of [[v1(), other], [other, v1()]]) {
      const r = await cmp(a, b);
      assert.equal(r.errors, 0, JSON.stringify(r.items));
      assert.deepEqual([r.counts.earlier, r.counts.unchanged, r.counts.added], [3, 3, 0]);
      assert.equal(item(r, 'description-changed'), undefined);
    }
    // control: the same conversion of an edited version is found to differ
    const edited = await go([v2((p) => { p[0].attestations[0].names[0].toponym = 'Oldeford'; })], 'convert', target, { typing: true });
    const r = await cmp(v1(), textFile(outText(edited.e, Object.keys(edited.e.outs)[0]), name));
    assert.deepEqual(item(r, 'attestation-changed')?.examples, [A + 'a1'], JSON.stringify(r.items));
  });
}

// ---- things with addresses of their own --------------------------------------------------------------------
test('a source described differently is a warning, not a breach: the attestations citing it are unchanged themselves', async () => {
  const r = await cmp(v1(), v2((p) => { for (const x of p) for (const a of x.attestations) { if (a.sources) a.sources = [{ ...src, title: 'S, corrected' }]; if (a.citations) a.citations[0].source = { ...src, title: 'S, corrected' }; } }));
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  assert.deepEqual(item(r, 'description-changed')?.examples, [src['@id']]);
  assert.equal(r.counts.unchanged, 3);
});
// A facet with its own address (a Name that attestations share) is part of what each attestation
// pointing to it says. Without this, a dataset that gives every name an address could respell every
// toponym and pass.
const N = X + 'name/n';
// PLATO JSON repeats a shared name in full wherever it is used (the schema requires its toponym).
const shared = (name, more = []) => [place('a', [{ '@id': A + 'a1', names: [{ '@id': N, ...name }], sources: [src] }, ...more]), place('b', [{ '@id': A + 'b1', names: [{ '@id': N, ...name }], sources: [src] }])];
const sharedPair = (was, is, more) => cmp(json(doc(shared(was), G1)), json(doc(shared(is, more), G2)));
test('a name shared under its own address, unchanged, is no finding, however the file writes it', async () => {
  const r = await sharedPair({ toponym: 'Oldford' }, { toponym: 'Oldford' });
  assert.deepEqual([r.errors, r.counts.unchanged, kinds(r, 'warning')], [0, 2, []]);
});
test('a name shared under its own address, respelt, breaks the rule: the attestations pointing to it no longer say what they said', async () => {
  const r = await sharedPair({ toponym: 'Oldford' }, { toponym: 'Oldeford' });
  assert.deepEqual(kinds(r, 'error'), ['facet-changed'], JSON.stringify(r.items));
  assert.deepEqual(item(r, 'facet-changed').examples, [N]);
  // Not also "has more said of it": that warning says what was said still holds, which a respelling denies.
  assert.deepEqual(kinds(r, 'warning'), [], JSON.stringify(r.items));
  assert.equal(r.counts.unchanged, 2, 'the attestations themselves are unchanged, and counted so');
  assert.deepEqual(item(r, 'facet-changed').explained, [{ example: N, earlier: ['plato:toponym "Oldford"'], later: ['plato:toponym "Oldeford"'] }]);
});
test('a shared name no longer described at all breaks the rule too', async () => {
  // In JSON a name is always described where it is used; in RDF its description can simply go.
  const earlier = json(doc(shared({ toponym: 'Oldford' }), G1));
  const nt = outText((await go([earlier], 'convert', 'ntriples')).e, 'v.nt');
  assert.match(nt, new RegExp(`^<${N}> `, 'm'));
  const r = await cmp(earlier, textFile(nt.split('\n').filter((l) => !l.startsWith(`<${N}> `)).join('\n'), 'later.nt'));
  assert.deepEqual(kinds(r, 'error'), ['facet-removed'], JSON.stringify(r.items));
  assert.deepEqual(item(r, 'facet-removed').examples, [N]);
});
test('a shared name that goes with the only attestations pointing to it is not reported twice: their deletion is the problem', async () => {
  const r = await cmp(json(doc(shared({ toponym: 'Oldford' }), G1)), json(doc([place('a', []), place('b', [])], G2)));
  assert.deepEqual(kinds(r, 'error'), ['attestation-removed'], JSON.stringify(r.items));
  assert.equal(item(r, 'attestation-removed').count, 2);
});
test('a shared name with more said of it is a warning: what was said still holds', async () => {
  const r = await sharedPair({ toponym: 'Oldford' }, { toponym: 'Oldford', language: 'enm' });
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  assert.deepEqual(item(r, 'facet-added-to')?.examples, [N]);
  assert.deepEqual(item(r, 'facet-added-to').explained, [{ example: N, earlier: [], later: ['plato:language "enm"'] }]);
});
test('before publication a respelt shared name is a warning, like any other breach', async () => {
  const r = await cmp(json(doc(shared({ toponym: 'Oldford' }), { ...G1, status: 'draft' })), json(doc(shared({ toponym: 'Oldeford' }), G2)));
  assert.equal(r.errors, 0);
  assert.ok(kinds(r, 'warning').includes('facet-changed'));
});
test('giving a name an address is a change to its attestation: it now points to a thing others may share', async () => {
  const bare = [place('a', [{ '@id': A + 'a1', names: [{ toponym: 'Oldford' }], sources: [src] }])];
  const named = [place('a', [{ '@id': A + 'a1', names: [{ '@id': N, toponym: 'Oldford' }], sources: [src] }])];
  const r = await cmp(json(doc(bare, G1)), json(doc(named, G2)));
  assert.deepEqual(item(r, 'attestation-changed')?.examples, [A + 'a1'], JSON.stringify(r.items));
  assert.deepEqual(item(r, 'attestation-changed').explained, [{ example: A + 'a1', earlier: ['plato:attests_name [plato:toponym "Oldford"]'], later: [`plato:attests_name <${N}>`] }]);
});

test('an attestation that keeps what it says but loses its address is a breach whose remedy is the address', async () => {
  const r = await cmp(v1(), v2((p) => { delete p[1].attestations[0]['@id']; }));
  assert.deepEqual(kinds(r, 'error'), ['attestation-readdressed'], JSON.stringify(r.items));
  assert.deepEqual(item(r, 'attestation-readdressed').examples, [A + 'b1']);
  assert.match(item(r, 'attestation-readdressed').message, /give it back its address/);
  assert.deepEqual([r.counts.changed, r.counts.lost, r.counts.added], [1, 0, 0]);
  // and under another address, the same
  assert.deepEqual(kinds(await cmp(v1(), v2((p) => { p[1].attestations[0]['@id'] = A + 'b1-renamed'; })), 'error'), ['attestation-readdressed']);
  // control: deleted outright, it is removed
  assert.deepEqual(kinds(await cmp(v1(), v2((p) => { p[1].attestations = []; })), 'error'), ['attestation-removed']);
});
test('a place read without a label is not reported as relabelled against a version that gives its label', async () => {
  // Attestation-centric JSON names no labels; the reader gives each place its address as a stand-in.
  const ac = json({ profile: 'attestation-centric', gazetteer: G1, attestations: [{ '@id': A + 'a1', about: X + 'place/a', names: [{ toponym: 'Oldford' }], sources: [src] }] }, 'ac.json');
  const pc = json(doc([place('a', [{ '@id': A + 'a1', names: [{ toponym: 'Oldford' }], sources: [src] }])], G2));
  const r = await cmp(ac, pc);
  assert.deepEqual([r.errors, r.counts.unchanged], [0, 1], JSON.stringify(r.items));
  assert.equal(item(r, 'description-changed'), undefined, JSON.stringify(r.items));
  // control: a real label that changes is still reported
  const pc2 = json(doc([place('a', [{ '@id': A + 'a1', names: [{ toponym: 'Oldford' }], sources: [src] }])], G1));
  assert.deepEqual(item(await cmp(pc2, json(doc([{ ...place('a', [{ '@id': A + 'a1', names: [{ toponym: 'Oldford' }], sources: [src] }]), label: 'A, renamed' }], G2))), 'description-changed')?.examples, [X + 'place/a']);
});

// ---- what changed ---------------------------------------------------------------------------------------------
test('a changed attestation is shown with what each version says of it that the other does not', async () => {
  const r = await cmp(v1(), v2((p) => { p[0].attestations[0].names[0].toponym = 'Oldeford'; p[0].attestations[0].notes = 'respelt'; }));
  assert.deepEqual(item(r, 'attestation-changed').explained, [{ example: A + 'a1',
    earlier: ['plato:attests_name [plato:toponym "Oldford"]'],
    later: ['plato:attests_name [plato:toponym "Oldeford"]', 'plato:notes "respelt"'] }]);
  // control: with nothing changed, nothing is explained, and the versions are not read again
  assert.ok((await cmp(v1(), v2())).items.every((i) => !i.explained));
});
test('only as many changed attestations are explained as the report shows examples of', async () => {
  const many = (suffix) => json(doc(Array.from({ length: 12 }, (_, i) => place(`p${i}`, [{ '@id': `${A}m${i}`, names: [{ toponym: `N${i}${suffix}` }], sources: [src] }])), suffix ? G2 : G1));
  const c = item(await cmp(many(''), many('x')), 'attestation-changed');
  assert.deepEqual([c.count, c.examples.length, c.explained.length], [12, 5, 5]);
  assert.deepEqual(c.explained.map((x) => x.example), c.examples);
});

// ---- an address used twice ------------------------------------------------------------------------------------
test('an address the later version uses twice, once unchanged and once saying something else, is a changed attestation', async () => {
  const again = { '@id': A + 'a1', names: [{ toponym: 'Another' }], sources: [src] };
  const r = await cmp(v1(), v2((p) => { p[1].attestations.push(again); }));
  assert.deepEqual(kinds(r, 'error'), ['attestation-changed'], JSON.stringify(r.items));
  assert.deepEqual(item(r, 'attestation-changed').examples, [A + 'a1']);
  assert.ok(item(r, 'attestation-changed').explained[0].later.includes('plato:attests_name [plato:toponym "Another"]'));
  // control: the same address twice saying the same thing both times, in both versions, is unchanged
  const twice = () => { const p = places(); p[0].attestations.push(structuredClone(p[0].attestations[0])); return p; };
  assert.equal((await cmp(json(doc(twice(), G1)), json(doc(twice(), G2)))).errors, 0);
});
test('an attestation with no address and no date of making, given an address, is not reported as added', async () => {
  const r = await cmp(v1(), v2((p) => { p[0].attestations[1]['@id'] = A + 'a-anon'; }));
  assert.equal(item(r, 'added-without-created'), undefined, JSON.stringify(r.items));
  // control: one that is new, with an address and no date, is
  assert.deepEqual(item(await cmp(v1(), v2((p) => { p[0].attestations.push({ '@id': A + 'new', names: [{ toponym: 'N' }], sources: [src] }); })), 'added-without-created')?.examples, [A + 'new']);
});
test('a place relabelled is a warning; a place with no attestations that is dropped is one too', async () => {
  const earlier = json(doc([...places(), place('empty', [])], G1));
  const r = await cmp(earlier, v2((p) => { p[0].label = 'A, renamed'; }));
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  assert.deepEqual(item(r, 'description-changed')?.examples, [X + 'place/a']);
  assert.deepEqual(item(r, 'description-removed')?.examples, [X + 'place/empty']);
});
test("the gazetteer's own description changes from version to version, and that is not reported", async () => {
  const r = await cmp(v1(), v2(() => {}, { ...G2, title: 'A new title', description: 'More said' }));
  assert.deepEqual(kinds(r, 'warning'), ['earlier-unidentified']);
});
test('an identity match removed or changed is a warning: the rule is about attestations', async () => {
  const idr = (certainty) => [{ '@id': X + 'match/1', subject: X + 'place/a', object: 'https://www.geonames.org/1/', identityType: 'closeMatch', certainty }, { subject: X + 'place/b', object: 'https://www.geonames.org/2/', identityType: 'exactMatch' }];
  const earlier = json(doc(places(), G1, { identityRelations: idr(0.7) }));
  const same = await cmp(earlier, json(doc(places(), G2, { identityRelations: idr(0.7) })));
  assert.deepEqual([same.errors, kinds(same, 'warning')], [0, ['earlier-unidentified']]);
  const r = await cmp(earlier, json(doc(places(), G2, { identityRelations: [{ ...idr(0.9)[0] }] })));
  assert.equal(r.errors, 0);
  assert.deepEqual(item(r, 'identity-changed')?.examples, [X + 'match/1']);
  assert.deepEqual(item(r, 'identity-gone')?.examples, [X + 'place/b']);
  assert.deepEqual(item(await cmp(earlier, v2()), 'identity-removed')?.examples, [X + 'match/1']);
  assert.equal(r.counts.unchanged, 3, 'identity matches are not counted among the attestations');
});

// ---- when the rule binds, and what the versions say of themselves --------------------------------------------
test('before publication the rule does not bind: the same deletion is a warning, and the report says why', async () => {
  const draft = json(doc(places(), { ...G1, status: 'draft' }));
  const r = await cmp(draft, v2((p) => { p[1].attestations = []; }));
  assert.equal(r.errors, 0);
  assert.ok(kinds(r, 'warning').includes('attestation-removed') && kinds(r, 'warning').includes('earlier-not-published'), JSON.stringify(kinds(r, 'warning')));
  assert.match(summary(r, 'compare').problems, /see the warnings/);
  // and with no status at all
  const { status, ...noStatus } = G1;
  assert.ok(kinds(await cmp(json(doc(places(), noStatus)), v2()), 'warning').includes('earlier-not-published'));
});
test('what the versions say of themselves: a later one not published, the same version, another previous version, another gazetteer', async () => {
  const has = async (g, kind) => kinds(await cmp(v1(), v2(() => {}, g)), 'warning').includes(kind);
  for (const [kind, g] of [['later-not-published', { ...G2, status: 'draft' }], ['same-version', { ...G2, version: '1' }],
    ['previous-version-differs', { ...G2, previousVersion: X + 'g/0' }], ['different-gazetteer', { ...G2, isVersionOf: X + 'another' }]]) {
    assert.equal(await has(g, kind), true, kind);
    assert.equal(await has(G2, kind), false, `control: ${kind}`);
  }
});

// ---- a comparison that compared nothing must not pass ---------------------------------------------------------
test('an earlier version with no attestations is a problem: nothing was tested', async () => {
  const r = await cmp(json(doc([place('a', [])], G1)), v2());
  assert.deepEqual(kinds(r, 'error'), ['nothing-to-compare']);
});
test('an earlier version cut short is not compared, and says so; a later one likewise', async () => {
  const cut = textFile(JSON.stringify(doc(places(), G1)).slice(0, 300), 'cut.json');
  for (const [a, b, word] of [[cut, v2(), 'earlier'], [v1(), cut, 'later']]) {
    const r = await cmp(a, b);
    assert.equal(r.incomplete, true);
    assert.deepEqual(kinds(r, 'error'), ['unreadable']);
    assert.match(item(r, 'unreadable').message, new RegExp(`The ${word} version could not be read to the end`));
    assert.match(summary(r, 'compare').problems, /could not be compared/);
  }
});
test('a version with a line that cannot be read is a problem: the comparison is not of the whole of it', async () => {
  const lines = (d) => [JSON.stringify({ profile: d.profile, gazetteer: d.gazetteer }), ...d.spatialEntities.map((x) => JSON.stringify(x))];
  const good = textFile(lines(doc(places(), G2)).join('\n') + '\n', 'v2.jsonl');
  assert.equal((await cmp(v1(), good)).errors, 0, 'control: the same lines, all readable, compare clean');
  const l = lines(doc(places(), G1)); l[2] = l[2].slice(0, 40);
  const r = await cmp(textFile(l.join('\n') + '\n', 'v1.jsonl'), good);
  assert.deepEqual(kinds(r, 'error'), ['version-not-read']);
  assert.match(item(r, 'version-not-read').message, /earlier version could not be read/);
});
test("a version's own problems are the check's to list: the comparison says they are there, and still compares", async () => {
  const r = await cmp(v1(), v2((p) => { p[0].notAKey = true; }));
  assert.equal(r.errors, 0);
  assert.equal(item(r, 'version-has-problems')?.count, 1, JSON.stringify(r.items));
  assert.equal(r.counts.unchanged, 3);
});
test('a key PLATO does not define makes no statement, so it is not compared, and the report says so', async () => {
  const withKey = (value) => (p) => { p[0].attestations[0].myOwnKey = value; };
  const r = await cmp(json(doc((() => { const p = places(); withKey('one')(p); return p; })(), G1)), v2(withKey('two')));
  assert.equal(r.counts.unchanged, 3, 'the difference is not seen');
  const w = r.items.filter((i) => i.kind === 'not-compared');
  assert.deepEqual(w.map((i) => i.message.split(' has ')[0]).sort(), ['The earlier version', 'The later version'], JSON.stringify(r.items));
  assert.match(w[0].message, /cannot be written as PLATO RDF.*difference there would not be seen.*myOwnKey/);
  assert.ok(!(await cmp(v1(), v2())).items.some((i) => i.kind === 'not-compared'), 'control');
});

// ---- at any size ------------------------------------------------------------------------------------------------
test('every lookup the comparison makes goes by an index on more than the version, so its time grows with the data, not its square', () => {
  const db = new DatabaseSync(':memory:');
  Ledger.tables(db); Ledger.indexes(db);
  for (const [name, sql] of Object.entries(QUERIES)) {
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail);
    assert.ok(plan.length, name);
    // Every step after the first is a lookup made once per row of the first: it must find its rows
    // through an index, and narrow by more than the version.
    for (const d of plan.slice(1).filter((x) => /^(SCAN|SEARCH)/.test(x))) {
      assert.match(d, /^SEARCH/, `${name}: ${plan.join(' | ')}`);
      assert.doesNotMatch(d, /\(v=\?\)$/, `${name}: ${plan.join(' | ')}`);
    }
  }
  // control: the lookup by digest as it was first written, which SQLite answers from the wrong index
  const was = db.prepare('EXPLAIN QUERY PLAN ' + QUERIES.unaddressed.replaceAll(/ INDEXED BY a[ih]/g, '')).all().map((r) => r.detail);
  assert.ok(was.some((d) => /^SEARCH n .*\(v=\?\)$/.test(d)), was.join(' | '));
});
test('ten thousand attestations without addresses, a twentieth of them changed: each change is found', async () => {
  const many = (edit) => json(doc(Array.from({ length: 2000 }, (_, i) => place(`p${i}`, Array.from({ length: 5 }, (_, j) => ({ names: [{ toponym: `N${i}-${j}${edit && j === 0 && i % 4 === 0 ? ' altered' : ''}` }], sources: [src] })))), edit ? G2 : G1));
  const r = await cmp(many(false), many(true));
  assert.deepEqual([r.counts.earlier, r.counts.unchanged, r.counts.lost, r.counts.added], [10000, 9500, 500, 500]);
  assert.equal(item(r, 'attestation-gone').count, 500);
});

// ---- the command line ------------------------------------------------------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const dir = mkdtempSync(join(tmpdir(), 'plato-tools-compare-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const write = (name, d) => { const p = join(dir, name); writeFileSync(p, typeof d === 'string' ? d : JSON.stringify(d)); return p; };

test('compare on the command line: exit 0 and the summary when nothing was deleted or changed', () => {
  const r = cli('compare', write('a.json', doc(places(), G1)), write('b.json', doc(places(), G2)));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^Earlier: .*a\.json: a PLATO JSON document \(place-centric\)\nLater: {3}.*b\.json: a PLATO JSON document/);
  assert.match(r.out, /\n {2}Nothing was deleted or changed\. Of 3 earlier attestations, 3 unchanged\. The later version has 3 attestations, 0 of them new\./);
});
test('control: exit 1 when an attestation was changed, with the problem and its address; --json gives the same as an object', () => {
  const p = places(); p[0].attestations[0].names[0].toponym = 'Oldeford';
  const a = write('a.json', doc(places(), G1)), b = write('changed.json', doc(p, G2));
  const r = cli('compare', a, b);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /\n {2}1 problem found\. Of 3 earlier attestations, 2 unchanged, 1 changed\./);
  assert.match(r.out, /Problems\. These break the append-only rule/);
  assert.ok(r.out.includes(`\n        ${A}a1\n            Only in the earlier version: plato:attests_name [plato:toponym "Oldford"]\n            Only in the later version: plato:attests_name [plato:toponym "Oldeford"]\n`), r.out);
  const j = JSON.parse(cli('compare', '--json', a, b).out);
  assert.deepEqual([j.type, j.status, j.errors, j.exitCode, j.counts.changed, j.earlier.format, j.later.input], ['comparison', 'problems', 1, 1, 1, 'plato-json', b]);
  assert.equal(j.items.find((i) => i.kind === 'attestation-changed').examples[0], A + 'a1');
});
test('compare on the command line: exit 2 for one input, a missing file, or a version cut short', () => {
  const a = write('a.json', doc(places(), G1));
  const one = cli('compare', a);
  assert.equal(one.code, 2); assert.match(one.err, /compare takes two inputs, the earlier version and then the later one; 1 was given/);
  const missing = cli('compare', a, join(dir, 'nowhere.json'));
  assert.equal(missing.code, 2); assert.match(missing.out, /Could not be compared: .*nowhere\.json: There is no such file or directory/);
  const cut = cli('compare', a, write('cut.json', JSON.stringify(doc(places(), G2)).slice(0, 300)));
  assert.equal(cut.code, 2, cut.out); assert.match(cut.out, /The two versions could not be compared\./); assert.match(cut.out, /The later version could not be read to the end/);
  assert.equal(cli('compare', '--to', 'ntriples', a, a).code, 2);
});
test('compare on the command line reads a version in any format: JSON against its own N-Triples', () => {
  const a = write('a.json', doc(places(), G1));
  assert.equal(cli('convert', '--to', 'ntriples', '--out', dir, a).code, 0);
  const r = cli('compare', a, join(dir, 'a.nt'));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Later: {3}.*a\.nt: RDF \(N-Triples\)/);
  assert.match(r.out, /Of 3 earlier attestations, 3 unchanged/);
  assert.match(readFileSync(join(dir, 'a.nt'), 'utf8'), /attests_about/);
});

test('a version whose spatialEntities is not a list was not read whole, so it cannot pass', async () => {
  const bad = await cmp(v1(), json(doc({}, G2), 'v2.json'));
  assert.ok(item(bad, 'version-not-read'), kinds(bad, 'error').join());
  assert.ok(item(bad, 'version-not-read').message.includes('spatialEntities'));
  // Control: the same comparison with a list is not refused for that.
  const good = await cmp(v1(), v2());
  assert.equal(item(good, 'version-not-read'), undefined);
});
