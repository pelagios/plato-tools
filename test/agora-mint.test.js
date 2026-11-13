import { PLATO_REPO } from './paths.js';
// Agora's minting (src/engine/agora/mint.js): a copy of the dataset in which every attestation has a
// permanent address, <place>#a-<hash of what it says>. The addresses must come out the same however
// often and in whatever order the data is minted, must never replace one that exists, must be kept
// from a previous release, and must not be written at all if the copy would break the append-only
// rule against that release. Every check of an absence here is paired with a presence in the same
// test: a copy with no addresses at all would pass "no address was changed".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, file, textFile, go, outText } from './engine.js';
import { detect } from '../src/engine/input.js';
import { publish } from '../src/engine/agora/index.js';
import { TEXT } from '../src/engine/agora/mint.js';
import { sha256 } from '../src/lib/sha256.js';
import { gzipSync, gunzipSync } from 'fflate';

const P = 'https://w3id.org/plato#', X = 'https://example.org/';
const KING_JOHN = `${PLATO_REPO}/schemas/examples/place-centric-king-john.json`;
const JUDGEMENTS = `${PLATO_REPO}/schemas/examples/place-centric-judgements.json`;
const CUSTOMS = `${PLATO_REPO}/schemas/tables/examples/customs`;
const src = { '@id': X + 'source/s', title: 'S' };
const G = { '@id': X, title: 't', licence: 'https://creativecommons.org/licenses/by/4.0/', uriSpace: X, status: 'draft' };
const PUB = { ...G, status: 'published', version: '1' };
const place = (id, attestations) => ({ '@id': `${X}place/${id}`, label: id, attestations });
const doc = (spatialEntities, gazetteer = G) => ({ profile: 'place-centric', gazetteer, spatialEntities });
const json = (d, name = 'd.json') => textFile(JSON.stringify(d), name);
/** Two places: one attestation with an address of its own, three without. */
const places = () => [
  place('a', [
    { '@id': X + 'attestation/a1', names: [{ toponym: 'Oldford' }], sources: [src] },
    { names: [{ toponym: 'Anon' }], timespans: [{ startEarliest: '1086', endLatest: '1086' }], sources: [src] },
    { names: [{ toponym: 'Other' }], sources: [src] },
  ]),
  place('b', [{ geometries: [{ geojson: { type: 'Point', coordinates: [1.5, 52.25] } }], citations: [{ source: src, locator: 'f. 1' }] }]),
];

async function mint(input, { previous, options = {} } = {}) {
  const e = env();
  const i = await detect([].concat(input));
  const r = await publish({ part: 'mint', input: i, previous: previous && await detect([].concat(previous)), options: { name: i.files[0].name, ...options } }, e);
  const out = r.outputs[0];
  return { ...r.report, incomplete: !!r.incomplete, outputs: r.outputs, text: out ? outText(e, out.name) : null };
}
const records = (text) => text.trim().split('\n').slice(1).map((l) => JSON.parse(l));
/** Each attestation of the copy: its place, its address, and what it says without the address. */
const attestations = (text) => records(text).flatMap((r) => (r.attestations || []).map((a) => {
  const { '@id': id, ...rest } = a;
  return { place: r['@id'], id, says: JSON.stringify(rest) };
}));
const kinds = (r, severity) => r.items.filter((i) => i.severity === severity).map((i) => i.kind).sort();
const item = (r, kind) => r.items.find((i) => i.kind === kind);
const HASH8 = /#a-[0-9a-f]{8}$/;

// ---- the hash ---------------------------------------------------------------------------------------
test('version 1 of the hash, pinned: the place, then the sorted statements, SHA-256, first 8 hex digits', async () => {
  // Written out by hand, so that a change to how the statements are made cannot pass unseen: every
  // address already minted would stop being reproducible.
  const text = `${X}place/a\n${P}attests_about <${X}place/a>\n${P}attests_name [${P}toponym "Oldford"]`;
  const expected = `${X}place/a#a-` + createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
  const r = await mint(json(doc([place('a', [{ names: [{ toponym: 'Oldford' }] }])])));
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  assert.deepEqual(attestations(r.text).map((a) => a.id), [expected]);
  // Control: another spelling is another address.
  const other = await mint(json(doc([place('a', [{ names: [{ toponym: 'Oldeford' }] }])])));
  assert.notEqual(attestations(other.text)[0].id, expected);
  assert.match(attestations(other.text)[0].id, HASH8);
});

test('the hash takes the text as given: an NFC and an NFD spelling are different content, with different addresses', async () => {
  const nfc = 'Z\u00fcrich', nfd = 'Zu\u0308rich';
  assert.equal(nfc.normalize('NFC'), nfd.normalize('NFC'), 'the same name to a reader');
  const hashOf = (name) => `${X}place/a#a-` + createHash('sha256').update(`${X}place/a\n${P}attests_about <${X}place/a>\n${P}attests_name [${P}toponym "${name}"]`, 'utf8').digest('hex').slice(0, 8);
  const [c, d] = [await mint(json(doc([place('a', [{ names: [{ toponym: nfc }] }])]))), await mint(json(doc([place('a', [{ names: [{ toponym: nfd }] }])])))];
  // Each is the hash of its own bytes, unnormalised; so the two differ.
  assert.deepEqual(attestations(c.text).map((a) => a.id), [hashOf(nfc)]);
  assert.deepEqual(attestations(d.text).map((a) => a.id), [hashOf(nfd)]);
  assert.notEqual(hashOf(nfc), hashOf(nfd));
});

// ---- addresses given, and kept ---------------------------------------------------------------------------
test('every attestation without an address is given one under its place; the one it had is not touched', async () => {
  const r = await mint(json(doc(places())));
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  const a = attestations(r.text);
  assert.equal(a.length, 4);
  assert.equal(a[0].id, X + 'attestation/a1', 'the address it had');
  for (const x of a.slice(1)) assert.ok(x.id.startsWith(x.place + '#a-') && HASH8.test(x.id), x.id);
  assert.equal(new Set(a.map((x) => x.id)).size, 4);
  assert.equal(r.counts.minted, 3); assert.equal(r.counts.kept, 1); assert.equal(r.counts.inherited, 0);
  assert.deepEqual(r.counts.said, ['Gave 3 attestations addresses; 1 already had them; 0 kept from the previous release.']);
  // Nothing but the addresses changed: each record is the input's, with @id added to its attestations.
  const back = records(r.text).map((rec) => ({ ...rec, attestations: rec.attestations.map((x, i) => (i === 0 && rec['@id'].endsWith('/a') ? x : (({ '@id': _, ...rest }) => rest)(x))) }));
  assert.deepEqual(back, places());
});
test('minting the copy again changes nothing: the same bytes, and nothing minted', async () => {
  const once = await mint(json(doc(places())));
  assert.equal(once.counts.minted, 3);
  const twice = await mint(textFile(once.text, 'd-with-ids.jsonl'));
  assert.equal(twice.text, once.text);
  assert.deepEqual([twice.counts.minted, twice.counts.kept], [0, 4]);
  assert.equal(twice.outputs[0].name, 'd-with-ids-with-ids.jsonl');
});
test('the order of places and of attestations does not change any address', async () => {
  const a = attestations((await mint(json(doc(places())))).text);
  const p = places().reverse(); p[1].attestations.reverse();
  const b = attestations((await mint(json(doc(p)))).text);
  const key = (x) => x.place + ' ' + x.says + ' ' + x.id;
  assert.deepEqual(b.map(key).sort(), a.map(key).sort());
  assert.notDeepEqual(b.map((x) => x.id), a.map((x) => x.id), 'control: the order did change');
});
test('twins (two attestations of a place that say the same) get -2, -3 in file order; the first has the bare hash', async () => {
  const twin = { names: [{ toponym: 'Twin' }], sources: [src] };
  const r = await mint(json(doc([place('a', [twin, { names: [{ toponym: 'Else' }] }, twin, twin]), place('b', [twin])])));
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  const ids = attestations(r.text).map((x) => x.id);
  assert.match(ids[0], HASH8);
  assert.deepEqual([ids[2], ids[3]], [ids[0] + '-2', ids[0] + '-3']);
  assert.match(ids[1], HASH8); assert.notEqual(ids[1], ids[0]);
  // Of another place, the same words are another attestation, with an address of its own and no counter.
  assert.match(ids[4], HASH8); assert.ok(ids[4].startsWith(X + 'place/b#'));
  assert.equal(r.counts.twins, 2);
  // A twin already addressed takes the bare hash; the one without it the next counter.
  const again = await mint(json(doc([place('a', [twin, { '@id': ids[0], ...twin }])])));
  assert.deepEqual(attestations(again.text).map((x) => x.id), [ids[0] + '-2', ids[0]]);
});
test('a hash that begins like another of the same place gives both 12 digits, whatever the order; twins still count on', async () => {
  // A hash that collides in its first 8 digits for everything.
  const hash = (t) => '0000abcd' + sha256(t).slice(8);
  const one = { names: [{ toponym: 'One' }] }, two = { names: [{ toponym: 'Two' }] };
  const r = await mint(json(doc([place('a', [one, two, one]), place('b', [one])])), { options: { hash } });
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  const ids = attestations(r.text).map((x) => x.id);
  assert.match(ids[0], /#a-0000abcd[0-9a-f]{4}$/); assert.match(ids[1], /#a-0000abcd[0-9a-f]{4}$/);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids[2], ids[0] + '-2');
  assert.equal(ids[3], X + 'place/b#a-0000abcd', 'alone in its place: 8 digits, collision or not');
  assert.equal(r.counts.lengthened, 3);
  const swapped = attestations((await mint(json(doc([place('a', [two, one, one]), place('b', [one])])), { options: { hash } })).text).map((x) => x.id);
  assert.deepEqual([...swapped].sort(), [...ids].sort());
  // Control: with the real hash the same attestations have 8 digits.
  const real = attestations((await mint(json(doc([place('a', [one, two, one])])))).text).map((x) => x.id);
  assert.ok(real.slice(0, 2).every((id) => HASH8.test(id)), real.join(' '));
});
test('a retraction is given an address that includes the address of what it retracts, which is kept', async () => {
  const target = { '@id': X + 'attestation/t', names: [{ toponym: 'Wrong' }], sources: [src] };
  const retraction = (to) => ({ sources: [src], meta: { metaType: P + 'Retracts', targetAttestation: to } });
  const r = await mint(json(doc([place('a', [target, retraction(target['@id'])])])));
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  const [t, m] = attestations(r.text);
  assert.equal(t.id, target['@id']);
  assert.match(m.id, HASH8);
  const other = attestations((await mint(json(doc([place('a', [{ ...target, '@id': X + 'attestation/u' }, retraction(X + 'attestation/u')])])))).text);
  assert.notEqual(other[1].id, m.id, 'another target, another retraction');
});

// ---- what cannot be minted --------------------------------------------------------------------------------
test('a place whose address is not under the base: its attestations are left without addresses, and it is a problem', async () => {
  const d = doc([place('a', [{ names: [{ toponym: 'In' }] }]), { '@id': 'https://elsewhere.org/p/q', label: 'q', attestations: [{ names: [{ toponym: 'Out' }] }, { names: [{ toponym: 'Out2' }] }] }]);
  const r = await mint(json(d));
  assert.deepEqual(kinds(r, 'error'), ['place-outside-base']);
  assert.equal(item(r, 'place-outside-base').count, 2);
  assert.deepEqual(item(r, 'place-outside-base').examples, ['https://elsewhere.org/p/q']);
  const a = attestations(r.text);
  assert.deepEqual(a.map((x) => x.id === undefined), [false, true, true], 'the place under the base is minted; the other is not');
  assert.equal(r.counts.outside, 2);
});
test('a place under the base but not at <base>place/<id> (DEEP\'s shape) has its attestations minted all the same', async () => {
  const deep = { '@id': `${X}places/deep-7`, label: 'deep', attestations: [{ names: [{ toponym: 'Deep' }] }] };
  const nested = { '@id': `${X}place/a/b#it`, label: 'nested', attestations: [{ names: [{ toponym: 'Nested' }] }] };
  const r = await mint(json(doc([deep, nested, { '@id': 'https://elsewhere.org/p/q', label: 'q', attestations: [{ names: [{ toponym: 'Out' }] }] }])));
  assert.deepEqual(kinds(r, 'error'), ['place-outside-base']);
  assert.deepEqual(item(r, 'place-outside-base').examples, ['https://elsewhere.org/p/q']);
  const a = attestations(r.text);
  assert.match(a[0].id, new RegExp(`^${X}places/deep-7#a-[0-9a-f]{8}$`));
  assert.match(a[1].id, new RegExp(`^${X}place/a/b#a-[0-9a-f]{8}$`));
  assert.equal(a[2].id, undefined);
  assert.deepEqual([r.counts.minted, r.counts.outside], [2, 1]);
});
test('no base address, or a dataset with problems: nothing is written', async () => {
  const noBase = await mint(json(doc(places(), { title: 't' })));
  assert.deepEqual(kinds(noBase, 'error'), ['no-base']);
  assert.equal(noBase.outputs.length, 0);
  const given = await mint(json(doc(places(), { title: 't' })), { options: { base: X } });
  assert.equal(given.errors, 0, 'control: a base given for the run will do');
  assert.equal(given.outputs.length, 1);
  const broken = places(); broken[0].attestations[1].certainty = 'very';
  const bad = await mint(json(doc(broken)));
  assert.deepEqual(kinds(bad, 'error'), ['dataset-has-problems']);
  assert.equal(bad.outputs.length, 0);
});

test('a published dataset without the previous release: refused when it names a previous version, a warning when it is the first; a draft, neither', async () => {
  const later = { ...PUB, version: '2', previousVersion: `${X}release/v1` };
  const refused = await mint(json(doc(places(), later)));
  assert.deepEqual(kinds(refused, 'error'), ['no-previous-release']);
  assert.equal(item(refused, 'no-previous-release').message, TEXT['no-previous-release']);
  assert.deepEqual(item(refused, 'no-previous-release').examples, [`${X}release/v1`]);
  assert.equal(refused.outputs.length, 0);
  assert.equal(refused.text, null);
  // A first publication: written, with the warning that the next must be minted against it.
  const first = await mint(json(doc(places(), PUB)));
  assert.equal(first.errors, 0, JSON.stringify(first.items));
  assert.equal(item(first, 'no-previous-release')?.severity, 'warning');
  assert.equal(item(first, 'no-previous-release').message, TEXT['no-previous-release-first']);
  assert.equal(first.outputs.length, 1);
  // The controls: the same later release with its previous one given is written with neither; a
  // draft naming a previous version, without it, is written with neither too.
  const withPrevious = await mint(json(doc(places(), later)), { previous: textFile(first.text, 'v1-with-ids.jsonl') });
  assert.equal(item(withPrevious, 'no-previous-release'), undefined, withPrevious.items.map((i) => i.kind).join());
  assert.equal(withPrevious.outputs.length, 1);
  const draft = await mint(json(doc(places(), { ...G, previousVersion: `${X}release/v1` })));
  assert.equal(item(draft, 'no-previous-release'), undefined);
  assert.equal(draft.outputs.length, 1);
});

// ---- the previous release ---------------------------------------------------------------------------------
const strip = (ps) => ps.map((p) => ({ ...p, attestations: p.attestations.map(({ '@id': _, ...a }) => a) }));
test('addresses are inherited from the previous release, even ones this would not have made', async () => {
  const previous = await mint(json(doc(places(), PUB), 'v1.json'));
  // The next release, kept without addresses (as tables are): everything is as it was, and one added.
  const next = strip(places()); next[1].attestations.push({ names: [{ toponym: 'New' }], created: '2026-09-30T00:00:00Z' });
  const r = await mint(json(doc(next, { ...PUB, version: '2' }), 'v2.json'), { previous: textFile(previous.text, 'v1-with-ids.jsonl') });
  assert.equal(r.errors, 0, JSON.stringify(r.items));
  const was = attestations(previous.text), is = attestations(r.text);
  assert.deepEqual(is.slice(0, 3).map((x) => x.id), was.slice(0, 3).map((x) => x.id));
  assert.equal(is[0].id, X + 'attestation/a1', 'the hand-made address, kept from the previous release');
  assert.match(is[5 - 1].id, HASH8);
  assert.deepEqual([r.counts.inherited, r.counts.minted, r.counts.kept], [4, 1, 0]);
  assert.match(r.counts.said[0], /Gave 5 attestations addresses; 0 already had them; 4 kept from the previous release\./);
  // Control: without the previous release, the hand-made address is not made again.
  const fresh = await mint(json(doc(next, { ...PUB, version: '2' }), 'v2.json'));
  assert.match(attestations(fresh.text)[0].id, HASH8);
});
test('the copy is not written if a published attestation of the previous release is gone from it; withdrawn instead, it is', async () => {
  const previous = await mint(json(doc(places(), PUB), 'v1.json'));
  const prevFile = () => textFile(previous.text, 'v1-with-ids.jsonl');
  const gone = strip(places()); gone[1].attestations = [];
  const r = await mint(json(doc(gone, { ...PUB, version: '2' }), 'v2.json'), { previous: prevFile() });
  assert.deepEqual(kinds(r, 'error'), ['attestation-removed']);
  assert.match(item(r, 'attestation-removed').message, /^Compared with the previous release .*plato:Retracts.*plato:Supersedes/);
  assert.deepEqual(item(r, 'attestation-removed').examples, [attestations(previous.text)[3].id]);
  assert.equal(r.outputs.length, 0);
  assert.match(r.counts.said[1], /^Nothing was written.*do not delete it\.$/);
  // Withdrawn instead: kept, and retracted by a new attestation, which points at its address.
  const kept = strip(places());
  kept[1].attestations.push({ sources: [src], created: '2026-09-30T00:00:00Z', meta: { metaType: P + 'Retracts', targetAttestation: attestations(previous.text)[3].id } });
  const ok = await mint(json(doc(kept, { ...PUB, version: '2' }), 'v2.json'), { previous: prevFile() });
  assert.equal(ok.errors, 0, JSON.stringify(ok.items));
  assert.equal(ok.outputs.length, 1);
  assert.deepEqual([ok.counts.previous.retracted, ok.counts.previous.unchanged, ok.counts.inherited], [1, 4, 4]);
});
test('a changed attestation, against a published release, is not written either; against a draft, it is, with a warning', async () => {
  const changed = strip(places()); changed[0].attestations[1].names[0].toponym = 'Anon.';
  for (const [status, written] of [['published', false], ['draft', true]]) {
    const previous = await mint(json(doc(places(), { ...PUB, status }), 'v1.json'));
    const r = await mint(json(doc(changed, { ...PUB, status, version: '2' }), 'v2.json'), { previous: textFile(previous.text, 'v1-with-ids.jsonl') });
    assert.equal(r.outputs.length === 1, written, `${status}: ${JSON.stringify(r.items)}`);
    assert.equal(item(r, 'attestation-removed')?.severity, written ? 'warning' : 'error', status);
    // Against a draft it is written, and the summary says, not only a warning among others, what
    // would be refused once the previous release is published.
    if (written) assert.match(r.counts.said.join(' '), /Against the previous release, which is a draft: 1 of its attestations is gone\. Written, as a draft binds nothing; once it is published, this would be refused/);
    else assert.doesNotMatch(r.counts.said.join(' '), /which is a draft/);
  }
  // Nothing lost against a draft: no such line.
  const previous = await mint(json(doc(places(), G), 'v1.json'));
  const same = await mint(json(doc(strip(places()), { ...G, version: '2' }), 'v2.json'), { previous: textFile(previous.text, 'v1-with-ids.jsonl') });
  assert.equal(same.outputs.length, 1);
  assert.ok(same.items.some((i) => i.kind === 'earlier-not-published'), 'control: the previous release is a draft');
  assert.doesNotMatch(same.counts.said.join(' '), /which is a draft/);
});

// ---- tables, and the check ---------------------------------------------------------------------------------
const csvs = (dir) => readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => file(join(dir, f)));
test('the same tables minted twice give the same copy; with every sheet in reverse order, the same addresses', async () => {
  const a = await mint(csvs(CUSTOMS), { options: { name: 'customs' } });
  assert.equal(a.errors, 0, JSON.stringify(a.items));
  assert.ok(a.counts.minted >= 4, JSON.stringify(a.counts));
  assert.equal(a.outputs[0].name, 'customs-with-ids.jsonl');
  const b = await mint(csvs(CUSTOMS), { options: { name: 'customs' } });
  assert.equal(b.text, a.text);
  // Every sheet with its rows reversed.
  const flipped = readdirSync(CUSTOMS).filter((f) => f.endsWith('.csv')).map((f) => {
    const [head, ...rows] = readFileSync(join(CUSTOMS, f), 'utf8').trimEnd().split('\n');
    return textFile([head, ...rows.reverse()].join('\n') + '\n', f);
  });
  const c = await mint(flipped, { options: { name: 'customs' } });
  const key = (x) => x.place + ' ' + x.says + ' ' + x.id;
  assert.deepEqual(attestations(c.text).map(key).sort(), attestations(a.text).map(key).sort());
  assert.notEqual(c.text, a.text, 'control: the order did change');
});
// The judgements example has an address for every attestation already, and retracts one of them.
for (const [name, input, options, minted] of [['the tables', () => csvs(CUSTOMS), {}, 4], ["PLATO's King John example", () => file(KING_JOHN), {}, 47],
  ["PLATO's judgements example, all addressed already", () => file(JUDGEMENTS), { base: 'https://whgazetteer.org/example/' }, 0]]) {
  test(`the copy of ${name} passes the check, with every attestation addressed`, async () => {
    const r = await mint(input(), { options: { name: 'x', ...options } });
    assert.equal(r.errors, 0, JSON.stringify(r.items));
    assert.equal(r.counts.minted, minted);
    const c = await go([textFile(r.text, 'x-with-ids.jsonl')], 'check');
    assert.equal(c.report.errors, 0, JSON.stringify(c.report.items));
    const a = attestations(r.text);
    assert.ok(a.length > 3 && c.report.counts.attestations === a.length, `${a.length} attestations`);
    assert.ok(a.every((x) => typeof x.id === 'string'));
    assert.equal(new Set(a.map((x) => x.id)).size, a.length, 'no address given twice');
  });
}

// ---- the command line ------------------------------------------------------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const dir = mkdtempSync(join(tmpdir(), 'plato-tools-mint-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const write = (name, d) => { const p = join(dir, name); writeFileSync(p, typeof d === 'string' ? d : JSON.stringify(d)); return p; };

test('publish mint on the command line: 0 and the copy; with --previous, 1 and nothing written when a published attestation is gone', () => {
  const out1 = join(dir, 'one'), out2 = join(dir, 'two'), out3 = join(dir, 'three');
  mkdirSync(out1); mkdirSync(out2); mkdirSync(out3);
  const first = cli('publish', 'mint', '--out', out1, write('v1.json', doc(places(), PUB)));
  assert.equal(first.code, 0, first.out + first.err);
  assert.match(first.out, /Nothing stops publication\. Gave 3 attestations addresses; 1 already had them; 0 kept from the previous release\./);
  const prev = join(out1, 'v1-with-ids.jsonl');
  assert.ok(existsSync(prev));
  const gone = strip(places()); gone[1].attestations = [];
  const bad = cli('publish', 'mint', '--previous', prev, '--out', out2, write('v2.json', doc(gone, { ...PUB, version: '2' })));
  assert.equal(bad.code, 1, bad.out + bad.err);
  assert.match(bad.out, /Nothing was written/);
  assert.deepEqual(readdirSync(out2), []);
  const good = cli('publish', 'mint', '--previous', prev, '--out', out3, write('v2.json', doc(strip(places()), { ...PUB, version: '2' })));
  assert.equal(good.code, 0, good.out + good.err);
  assert.match(good.out, /4 kept from the previous release/);
  assert.deepEqual(readdirSync(out3), ['v2-with-ids.jsonl']);
  assert.equal(readFileSync(join(out3, 'v2-with-ids.jsonl'), 'utf8').split('\n').slice(1).join('\n'), readFileSync(prev, 'utf8').split('\n').slice(1).join('\n'), 'the same records, with the same addresses');
  const missing = cli('publish', 'mint', '--previous', join(dir, 'nowhere.jsonl'), '--out', out3, write('v3.json', doc(places(), PUB)));
  assert.equal(missing.code, 2, missing.out + missing.err);
});

test('a gzipped dataset gives a gzipped copy, the same records as the plain one; a plain dataset, a plain copy; a site is made from the gzipped copy', async () => {
  const text = JSON.stringify(doc(places()));
  const run = async (f) => {
    const e = env();
    const i = await detect([f]);
    const r = await publish({ part: 'mint', input: i, options: { name: i.files[0].name } }, e);
    const out = r.outputs[0];
    return { r, name: out.name, bytes: Buffer.concat(e.outs[out.name].map((p) => Buffer.from(p))) };
  };
  const gz = await run(new File([gzipSync(new TextEncoder().encode(text))], 'd.json.gz'));
  const plain = await run(textFile(text, 'd.json'));
  assert.equal(gz.r.report.errors, 0, JSON.stringify(gz.r.report.items));
  assert.equal(gz.name, 'd-with-ids.jsonl.gz');
  assert.deepEqual([...gz.bytes.subarray(0, 2)], [0x1f, 0x8b]);
  assert.equal(Buffer.from(gunzipSync(gz.bytes)).toString('utf8'), plain.bytes.toString('utf8'));
  // Control: the plain dataset's copy is plain text, named without .gz, and has its addresses.
  assert.equal(plain.name, 'd-with-ids.jsonl');
  assert.equal(plain.bytes[0], '{'.charCodeAt(0));
  assert.equal(attestations(plain.bytes.toString('utf8')).filter((a) => HASH8.test(a.id)).length, 3);
  // The gzipped copy is what gets committed, and the site is made from it.
  const e = env();
  const site = await publish({ part: 'site', input: await detect([new File([gz.bytes], gz.name)]), options: { toolsRef: 'abc1234' } }, e);
  assert.equal(site.report.errors, 0, JSON.stringify(site.report.items.filter((i) => i.severity === 'error')));
  assert.equal(site.report.counts.places, 2);
  assert.equal(site.outputs.length, 2);
});

test('a base given for the run is written into the copy, so the site and the w3id rules use it too', async () => {
  const B = 'https://w3id.org/other/';
  const d = doc([{ ...place('a', [{ names: [{ toponym: 'Anon' }], sources: [src] }]), '@id': B + 'place/a' }]);
  const r = await mint(json(d), { options: { base: B } });
  const head = JSON.parse(r.text.split('\n')[0]);
  assert.equal(head.gazetteer.uriSpace, B);
  assert.equal(head.gazetteer['@id'], B);          // it was the old base, so it follows
  assert.ok(records(r.text)[0].attestations[0]['@id'].startsWith(B + 'place/a#a-'));
  assert.ok(item(r, 'base-written'));
  // Control: without a base for the run, the dataset's own is kept and nothing is said.
  const own = await mint(json(doc(places())));
  assert.equal(JSON.parse(own.text.split('\n')[0]).gazetteer.uriSpace, X);
  assert.equal(item(own, 'base-written'), undefined);
  // The same base, written without its closing '/', is not a different one.
  const same = await mint(json(doc(places())), { options: { base: X.slice(0, -1) } });
  assert.equal(item(same, 'base-written'), undefined);
});

// ---- the stand-in base: nothing temporary is ever published (Stephen, 13 November 2026) ------------------------
// The dataset the Map your data review ended with (rich2: five places in five minted regions, nine identities each
// promotedFrom a candidate of an exported set), as it was made under example.org/lancs/, moved here to the stand-in
// base a table with no base address is read under, and to a real one as the control.
const { STAND_IN_BASE, OLD_STAND_IN_BASE, holdsStandIn } = await import('../src/engine/agora/address.js');
const { TEXT: AGORA_TEXT } = await import('../src/engine/agora/index.js');
const RICH2 = readFileSync(new URL('./fixtures/myd/rich2.krisis-dataset.json', import.meta.url), 'utf8');
const REAL = 'https://gazetteer.example.edu/lancs/';
const rich2 = (base) => JSON.parse(RICH2.replaceAll('https://example.org/lancs/', base));
/** What must survive a move of base untouched in number: the places, the regions among them, the identities and what they were promoted from, and every relation's target. */
const tally = (text) => {
  const recs = text.trimStart().startsWith('{"$schema"') && !text.includes('\n{') ? JSON.parse(text).spatialEntities : records(text);
  const atts = recs.flatMap((r) => r.attestations || []);
  const ids = atts.flatMap((a) => [].concat(a.identities || a.identityRelations || []).concat(a.subject ? [a] : []));
  const all = JSON.stringify(recs);
  return { places: recs.length, regions: recs.filter((r) => r['@id'].includes('/place/region-')).length, attestations: atts.length,
    subjects: (all.match(/"subject":/g) || []).length, promotedFrom: (all.match(/"promotedFrom":/g) || []).length, relatesTo: (all.match(/"relatesTo":/g) || []).length, identities: ids.length };
};
async function part(name, d, options = {}) {
  const e = env();
  const input = await detect([json(d, 'rich2.json')]);
  const r = await publish({ part: name, input, options: { name: 'rich2.json', ...options } }, e);
  return { report: r.report, outputs: r.outputs, e, refused: r.report.items.find((i) => i.kind === 'stand-in-address') };
}

test('the guard: mint, report and site each refuse a dataset under the stand-in base, and one under a real base that still holds a temporary address; the same dataset under a real base is accepted', async () => {
  const temporary = rich2(STAND_IN_BASE);
  assert.ok(JSON.stringify(temporary).includes(STAND_IN_BASE + 'place/region-'), 'the fixture has regions under the stand-in');
  // A region left behind: under a real base, one place still ContainedIn a region at its temporary address.
  const behind = (stray) => {
    const d = rich2(REAL);
    const rel = d.spatialEntities.at(-1).attestations.find((a) => a.relations).relations[0];
    rel.relatesTo = rel.relatesTo.replace(REAL, stray);
    return d;
  };
  for (const name of ['mint', 'report', 'site']) {
    // 1. The base itself is the stand-in: as the dataset's own base, and as the base given for the run.
    for (const [why, d, options] of [['its own base', { ...temporary, gazetteer: { ...temporary.gazetteer, uriSpace: STAND_IN_BASE } }, {}], ['the base given', temporary, { base: STAND_IN_BASE }]]) {
      const r = await part(name, d, options);
      assert.equal(r.refused?.severity, 'error', `${name}, ${why}`);
      assert.deepEqual(r.outputs, [], `${name}, ${why}: nothing is written`);
      assert.ok(r.refused.examples[0].startsWith(STAND_IN_BASE), `${name}: the example is a temporary address`);
      // In plain words: what they are, that nothing was written, and what to do.
      assert.match(r.refused.message, /temporary web addresses|web addresses are temporary/);
      assert.match(r.refused.message, /Nothing temporary is ever published, so nothing was written/);
      assert.match(r.refused.message, /the web address your places will live under/);
      assert.equal(r.refused.message, AGORA_TEXT[name === 'mint' ? 'stand-in-address-mint' : 'stand-in-address']);
    }
    // 2. A real base, and one address still temporary. The report and the site refuse it whatever it is under;
    //    minting, which is where temporary addresses are moved, refuses the one it cannot move (another temporary host).
    const stray = name === 'mint' ? 'https://elsewhere.invalid/x/' : STAND_IN_BASE;
    const left = await part(name, behind(stray), { base: REAL });
    assert.equal(left.refused?.severity, 'error', `${name}: a region left behind`);
    assert.equal(left.refused.count, 1, name);
    assert.ok(left.refused.examples[0].startsWith(stray + 'place/region-'), name);
    assert.deepEqual(left.outputs, [], `${name}: nothing is written`);
    // 3. The control: the same dataset under the real base is not refused, and is written.
    const ok = await part(name, rich2(REAL), { base: REAL });
    assert.equal(ok.refused, undefined, `${name}: a real base`);
    assert.ok(!ok.report.items.some((i) => i.kind === 'stand-in-rewritten'), `${name}: nothing was moved`);
    assert.equal(ok.outputs.length > 0, true, `${name}: written (${ok.report.items.filter((i) => i.severity === 'error').map((i) => i.kind)})`);
  }
  // The stand-in used before 13 November 2026 is as temporary.
  const old = await part('site', rich2(OLD_STAND_IN_BASE), { base: OLD_STAND_IN_BASE });
  assert.equal(old.refused?.severity, 'error');
  // The w3id rules too, which a stand-in never had.
  const w3id = await part('w3id', temporary, { base: STAND_IN_BASE, maintainers: ['someone'], repo: 'someone/lancs' });
  assert.equal(w3id.refused?.severity, 'error'); assert.deepEqual(w3id.outputs, []);
});

// The candidate set written beside the dataset at the relate step (<stem>.candidates.json) is not rewritten by
// minting, so it still holds temporary addresses. No part of publishing takes it: handed to one as the dataset,
// it is refused whole and nothing is written, so it cannot reach a deposit or the site through the tools. The
// refusal is of a candidate set as such (the control under a real base is refused too); the presence that
// shows these parts can write at all is the dataset under the real base.
test('the candidate set left beside the dataset, still under the stand-in, is taken by no part of publishing: mint, report and site each refuse it and write nothing', async () => {
  const SET = readFileSync(`${PLATO_REPO}/schemas/examples/candidate-set-regions.json`, 'utf8');
  const under = (base) => SET.replaceAll('https://whgazetteer.org/example/', base);
  assert.ok(holdsStandIn(under(STAND_IN_BASE)), 'the set holds temporary addresses');
  assert.ok(JSON.parse(under(STAND_IN_BASE)).candidates.length > 0, 'and has candidates');
  for (const name of ['mint', 'report', 'site']) {
    for (const [why, text, options] of [['no base', under(STAND_IN_BASE), {}], ['a real base given', under(STAND_IN_BASE), { base: REAL }], ['made under a real base', under(REAL), { base: REAL }]]) {
      const e = env();
      const input = await detect([textFile(text, 'rich2.candidates.json')]);
      assert.equal(input.profile, 'candidate-set', 'read as a candidate set');
      const r = await publish({ part: name, input, options: { name: 'rich2.candidates.json', ...options } }, e);
      assert.ok(r.report.errors > 0, `${name}, ${why}: refused`);
      assert.deepEqual(r.outputs, [], `${name}, ${why}: no outputs`);
      assert.deepEqual(Object.keys(e.outs), [], `${name}, ${why}: nothing is written`);
    }
    // The presence: the same part writes the dataset under the real base, with no temporary address in it.
    const ok = await part(name, rich2(REAL), { base: REAL });
    assert.ok(ok.outputs.length > 0, `${name}: the dataset is written`);
    assert.ok(Object.values(ok.e.outs).every((parts) => !parts.some((p) => typeof p === 'string' && holdsStandIn(p))), `${name}: nothing temporary in what is written`);
  }
});

test('the rewrite: minted with the real base, every address under the stand-in is moved to it, none is left anywhere in the copy, and nothing is lost on the way', async () => {
  const before = tally(JSON.stringify(rich2(STAND_IN_BASE)));
  assert.deepEqual([before.places, before.regions, before.subjects, before.promotedFrom, before.relatesTo], [10, 5, 9, 9, 9], 'the fixture, counted');
  const e = env();
  const r = await publish({ part: 'mint', input: await detect([json(rich2(STAND_IN_BASE), 'rich2.json')]), options: { name: 'rich2.json', base: REAL } }, e);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items.filter((i) => i.severity === 'error')));
  assert.ok(!r.report.items.some((i) => i.kind === 'place-outside-base'), 'as it ended before: place-outside-base');
  const text = outText(e, r.outputs[0].name);
  // No stand-in survives, searched as text: the host, the base, and the guard's own test.
  assert.equal(text.includes('.invalid'), false);
  assert.equal(text.includes('temporary'), false);
  assert.equal(holdsStandIn(text), false);
  // And nothing is lost: an empty or shorter copy cannot pass.
  const after = tally(text);
  assert.deepEqual(after, before);
  const head = JSON.parse(text.split('\n')[0]).gazetteer;
  assert.equal(head.uriSpace, REAL); assert.equal(head['@id'], REAL);
  assert.deepEqual(head.candidateSets.map((s) => s.startsWith(REAL + 'candidates/')), [true]);
  const recs = records(text);
  assert.ok(recs.every((p) => p['@id'].startsWith(REAL + 'place/')));
  const atts = recs.flatMap((p) => p.attestations);
  assert.ok(atts.every((a) => typeof a['@id'] === 'string' && a['@id'].startsWith(REAL + 'place/')), 'every attestation has its address, under the real base');
  const targets = atts.flatMap((a) => (a.relations || []).map((x) => x.relatesTo));
  assert.equal(targets.length, 9);
  assert.ok(targets.every((t) => recs.some((p) => p['@id'] === t)), 'every relation still points at a place of the dataset');
  assert.ok([...text.matchAll(/"promotedFrom":"([^"]+)"/g)].every((m) => m[1].startsWith(head.candidateSets[0] + '#c-')), 'each identity still names its candidate, in the set at its new address');
  // It is exactly the copy minted from the same dataset made under the real base from the start.
  const direct = env();
  const d = await publish({ part: 'mint', input: await detect([json(rich2(REAL), 'rich2.json')]), options: { name: 'rich2.json', base: REAL } }, direct);
  assert.equal(text, outText(direct, d.outputs[0].name));
  // Said, with the count, so that the user knows the earlier files are not for publishing.
  const said = r.report.items.find((i) => i.kind === 'stand-in-rewritten');
  assert.equal(said?.severity, 'warning'); assert.deepEqual(said.examples, [REAL]);
  assert.ok(said.count >= 10 + 9 + 9 + 9, `moved ${said.count}`);
  // The copy is then taken by the report and the site, which refused the dataset before it.
  for (const name of ['report', 'site']) {
    const next = env();
    const n = await publish({ part: name, input: await detect([textFile(text, r.outputs[0].name)]), options: {} }, next);
    assert.ok(!n.report.items.some((i) => i.kind === 'stand-in-address'), name);
    assert.equal(n.outputs.length > 0, true, `${name}: ${n.report.items.filter((i) => i.severity === 'error').map((i) => i.kind)}`);
  }
});

test('a file written from a dataset still under the stand-in (LPF, RDF, tables) says, once, that it holds temporary addresses and is not for publishing; one under a real base says nothing', async () => {
  for (const target of ['lpf', 'ntriples', 'tables', 'plato-jsonl']) {
    const t = await go([json(rich2(STAND_IN_BASE), 'rich2.json')], 'convert', target);
    const said = t.report.items.filter((i) => i.kind === 'stand-in-written');
    assert.equal(said.length, 1, target);
    assert.equal(said[0].severity, 'warning');
    assert.equal(said[0].count, 10, `${target}: each of the ten places and regions holds one`);
    assert.ok(said[0].examples[0].startsWith(STAND_IN_BASE), target);
    assert.match(said[0].message, /temporary web addresses/);
    assert.match(said[0].message, /not for publishing, nor for sending to a gazetteer/);
    // The control: the same dataset under a real base, written the same way, with the same places.
    const r = await go([json(rich2(REAL), 'rich2.json')], 'convert', target);
    assert.ok(!r.report.items.some((i) => i.kind === 'stand-in-written'), target);
    assert.equal(r.report.counts.places, t.report.counts.places);
    assert.equal(r.report.counts.places, 10);
  }
  // A table read with no base says it in the reader's own words, and is not told twice.
  const table = await go([textFile('id,name\n1,Mill\n', 'places.csv')], 'convert', 'lpf');
  assert.deepEqual(table.report.items.filter((i) => /stand-in/.test(i.kind)).map((i) => i.kind), ['generic-stand-in-base']);
});
