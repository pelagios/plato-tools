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
import { sha256 } from '../src/lib/sha256.js';

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
  }
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
