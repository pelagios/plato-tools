import { PLATO_REPO } from './paths.js';
// Elenchos (check) on candidate sets (PLATO 05cf78a; the candidate set specification's section 13.3):
// what no schema can see, within a set, across the sets given together (--candidates), and between
// the sets and the dataset they were made for. Ported from the specification's prototype
// (elenchos.py, with its tests in neg.py): every rule has a case that must raise it and a control,
// in the same test, that must not. Each mutation is schema-valid where the rule is not the schema's,
// so that what is found is the rule's finding and not a schema refusal passing for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { go, file, textFile, outText, res } from './engine.js';
import { detect } from '../src/engine/input.js';
import { sha256 } from '../src/lib/sha256.js';
import { candidateText } from '../src/engine/candidates.js';

const EX = `${PLATO_REPO}/schemas/examples`;
const CS = JSON.parse(readFileSync(`${EX}/candidate-set-judgements.json`, 'utf8'));
const AC = JSON.parse(readFileSync(`${EX}/attestation-centric-judgements.json`, 'utf8'));
const copy = (x) => structuredClone(x);
const SET = CS.candidateSet['@id'], SUBJ = CS.candidates[0].subject;
const ID = CS.candidates[0]['@id'], HEX = ID.split('#c-')[1];
const LATER = SET.replace('2026-09-09', '2026-10-01');

/** The minting rule of section 5, for the fixtures: the shortest prefix (8, 12 …) differing from every other hash given. */
function mint(c, setIri, others = []) {
  const h = sha256(candidateText(c)), hs = others.map((o) => sha256(candidateText(o)));
  let n = 8;
  while (hs.some((o) => o !== h && o.slice(0, n) === h.slice(0, n))) n += 4;
  return `${setIri.split('#')[0]}#c-${h.slice(0, n)}`;
}
const json = (doc, name = 'set.json') => textFile(JSON.stringify(doc), name);
const asSet = async (doc, name) => detect([json(doc, name)]);
/** Check `main` (a document) with the candidate sets `sets` (documents), as --candidates gives them. */
async function check(main, sets, name = 'main.json') {
  const candidates = sets ? await Promise.all(sets.map((s, i) => asSet(s, `given-${i + 1}.json`))) : undefined;
  return (await go([json(main, name)], 'check', null, candidates ? { candidates } : {})).report;
}
const found = (r, kind, severity) => r.items.filter((i) => i.kind === kind && (!severity || i.severity === severity));
const kindsOf = (r) => r.items.filter((i) => i.severity !== 'loss' && i.kind !== 'no-label').map((i) => `${i.severity} ${i.kind}`).sort();
// The schema must accept what these rules are shown on (neg.py's valid()).
const schemaOk = (doc) => {
  const V = res.validators['candidate-set'];
  const { candidates, ...head } = doc;
  assert.ok(V.header(head), JSON.stringify(V.header.errors));
  for (const c of candidates) assert.ok(V.candidate(c), `${c['@id']}: ${JSON.stringify(V.candidate.errors)}`);
};

test('controls: the example set alone, given twice, and with its dataset, raise nothing', async () => {
  for (const r of [await check(CS), await check(CS, [CS]), await check(AC, [CS])]) assert.deepEqual(kindsOf(r), [], JSON.stringify(r.items));
  // The sets given were read, and counted: a check that read none would pass the same.
  assert.equal((await check(AC, [CS])).counts['candidates given'], 2);
});

// ---- within one set ------------------------------------------------------------------------------
test('duplicate-id: two candidates with one @id in a set is an error; the example is the control', async () => {
  const d = copy(CS); d.candidates[1]['@id'] = d.candidates[0]['@id'];
  schemaOk(d);
  const r = await check(d);
  assert.deepEqual(found(r, 'duplicate-id', 'error').map((i) => i.examples), [[ID]]);
  assert.equal(found(r, 'described-differently').length, 0, 'one set: duplicate-id, not two copies disagreeing');
  assert.equal(found(await check(CS), 'duplicate-id').length, 0);
});

test('same-candidate-twice: one candidate listed twice under two ids is an error', async () => {
  const d = copy(CS);
  d.candidates[1] = { ...d.candidates[0], '@id': `${SET}#c-${sha256(candidateText(d.candidates[0])).slice(0, 12)}`, similarityScore: 0.5 };
  schemaOk(d);
  const r = await check(d);
  assert.equal(found(r, 'same-candidate-twice', 'error').length, 1, JSON.stringify(r.items));
  assert.equal(found(r, 'id-not-minted').length, 0, 'the 12-digit id is a prefix of its hash');
  assert.equal(found(await check(CS), 'same-candidate-twice').length, 0);
});

test('id-not-under-set: an @id under the subject (the withdrawn form) or under another set is an error', async () => {
  for (const bad of [`${SUBJ}#c-${HEX}`, `${SET}-other#c-${HEX}`]) {
    const d = copy(CS); d.candidates[0]['@id'] = bad;
    schemaOk(d);
    const r = await check(d);
    assert.deepEqual(found(r, 'id-not-under-set', 'error').map((i) => i.examples[0]), [`${bad}: the candidate set is ${SET}`], bad);
  }
  assert.equal(found(await check(CS), 'id-not-under-set').length, 0);
});

test('id-not-minted: an @id whose hex is not its hash is a warning, naming how the hash begins', async () => {
  const d = copy(CS), wrong = HEX.slice(0, -1) + (HEX.endsWith('0') ? '1' : '0');
  d.candidates[0]['@id'] = `${SET}#c-${wrong}`;
  schemaOk(d);
  const r = await check(d);
  assert.deepEqual(found(r, 'id-not-minted', 'warning').map((i) => i.examples[0]), [`${SET}#c-${wrong}: its hash begins ${HEX}`]);
  // The control: the example's ids are minted by the rule; and a changed score keeps the id right (not hashed).
  const s = copy(CS); s.candidates[0].similarityScore = 0.1;
  assert.equal(found(await check(s), 'id-not-minted').length, 0);
  assert.equal(found(await check(CS), 'id-not-minted').length, 0);
});

test('subject-is-object: a candidate matching a place with itself is a warning', async () => {
  const d = copy(CS); d.candidates[0].object = SUBJ; d.candidates[0]['@id'] = mint(d.candidates[0], SET);
  schemaOk(d);
  const r = await check(d);
  assert.deepEqual(kindsOf(r), ['warning subject-is-object'], JSON.stringify(r.items));
  assert.equal(found(await check(CS), 'subject-is-object').length, 0);
});

test("the schema's refusals of a candidate are worded for a person: the #a- form, and a status other than 'suggested'", async () => {
  const a = copy(CS); a.candidates[0]['@id'] = ID.replace('#c-', '#a-');
  const ra = await check(a);
  assert.ok(found(ra, 'schema', 'error').some((i) => /#c- and 8, 12, 16 … lower-case hex digits/.test(i.message) && /#a- is an attestation's/.test(i.message)), JSON.stringify(ra.items));
  for (const status of ['confirmed', 'rejected', 'deferred']) {
    const d = copy(CS); d.candidates[0].status = status;
    const r = await check(d);
    assert.ok(found(r, 'schema', 'error').some((i) => /'confirmed' and 'rejected' are no longer statuses/.test(i.message) && /identity attestation/.test(i.message)), status);
  }
  assert.equal((await check(CS)).errors, 0);
});

// ---- across the sets given ----------------------------------------------------------------------------
/** A later set, under its own IRI, that lists the example's first candidate again, correctly minted. */
function rerun() {
  const d = copy(CS); d.candidateSet['@id'] = LATER; d.candidateSet.issued = '2026-10-01';
  const c = { ...d.candidates[0], generatedAt: '2026-10-01T09:00:00Z' }; c['@id'] = mint(c, LATER);
  d.candidates = [c];
  schemaOk(d);
  return d;
}
test('already-published: a later set that lists a candidate an earlier set published is an error, whatever order they are given in', async () => {
  const later = rerun();
  assert.deepEqual(kindsOf(await check(later)), [], 'the later set alone is clean');
  for (const r of [await check(later, [CS]), await check(CS, [later])]) {
    assert.deepEqual(found(r, 'already-published', 'error').map((i) => i.examples[0]), [`${later.candidates[0]['@id']}: first published as ${ID}`], JSON.stringify(r.items));
  }
  // The control: a later set with a candidate no earlier set published.
  const fresh = rerun(); fresh.candidates[0].object = 'https://whgazetteer.org/example/county-survey/newton-fen'; fresh.candidates[0]['@id'] = mint(fresh.candidates[0], LATER);
  assert.deepEqual(kindsOf(await check(fresh, [CS])), []);
});

test('described-differently: two copies of one set that disagree are an error, naming the keys; identical copies are not reported', async () => {
  for (const [key, value] of [['similarityScore', 0.5], ['generatedAt', '2026-10-01T00:00:00Z']]) {
    const d = copy(CS); d.candidates[0][key] = value;
    schemaOk(d);
    const r = await check(CS, [d]);
    assert.deepEqual(found(r, 'described-differently', 'error').map((i) => i.examples[0]), [`${ID}: ${key}`], key);
    assert.equal(found(r, 'already-published').length, 0, 'a copy of one set publishes nothing again');
  }
  assert.deepEqual(kindsOf(await check(CS, [copy(CS)])), []);
});

// Two real candidates whose SHA-256 share their first 8 hex digits (3f04af4c), found by the prototype's search.
const REAL = { subject: 'https://whgazetteer.org/example/entity/newton-by-the-river', algorithmVersion: 'matcher 2.1', matchParameters: '{"threshold":0.8}' };
const [REAL_A, REAL_B] = [20128, 138143].map((n) => ({ ...REAL, object: `https://whgazetteer.org/example/county-survey/r${n}` }));
test("the hash text is json2rdf's JCS, and the hashes are those JSON.stringify gave: PLATO's example ids, and the colliding pair", () => {
  // PLATO's two example ids, by name, so that the comparison below cannot pass over an empty list.
  assert.deepEqual(CS.candidates.map((c) => c['@id'].split('#c-')[1]).sort(), ['1ec753bb', '8ed2901c']);
  for (const c of [...CS.candidates, REAL_A, REAL_B]) {
    assert.equal(candidateText(c), JSON.stringify([c.subject, c.object, c.algorithmVersion, c.matchParameters ?? '']));
  }
  for (const c of CS.candidates) assert.equal(c['@id'], `${SET.split('#')[0]}#c-${sha256(candidateText(c)).slice(0, 8)}`);
  assert.equal(sha256(candidateText(REAL_A)).slice(0, 8), '3f04af4c');
  // An absent matchParameters is hashed as "", not as null.
  assert.equal(candidateText({ subject: 's', object: 'o', algorithmVersion: 'v' }), '["s","o","v",""]');
});

function collidingSets({ lengthen, laterIri = LATER }) {
  const s1 = copy(CS), a = { ...CS.candidates[0], ...REAL_A }; a['@id'] = mint(a, SET); s1.candidates = [a];
  const s2 = copy(CS); s2.candidateSet['@id'] = laterIri; s2.candidateSet.issued = '2026-10-01';
  const b = { ...CS.candidates[0], ...REAL_B }; b['@id'] = mint(b, laterIri, lengthen ? [a] : []); s2.candidates = [b];
  schemaOk(s1); schemaOk(s2);
  return [s1, s2];
}
test('not-distinct: a newcomer not lengthened against an earlier set under the same base is a warning; lengthened, or under another base, it is not', async () => {
  assert.equal(sha256(candidateText(REAL_A)).slice(0, 8), '3f04af4c');
  assert.equal(sha256(candidateText(REAL_B)).slice(0, 8), '3f04af4c');
  const [s1, s2] = collidingSets({ lengthen: false });
  const r = await check(s1, [s2]);
  assert.deepEqual(found(r, 'not-distinct', 'warning').map((i) => i.examples), [[s2.candidates[0]['@id']]], JSON.stringify(r.items));
  const [t1, t2] = collidingSets({ lengthen: true });
  assert.equal(t2.candidates[0]['@id'].split('#c-')[1].length, 12);
  assert.deepEqual(kindsOf(await check(t1, [t2])), []);
  // Another producer's series (another base address): only its minter knew what it was given.
  const [u1, u2] = collidingSets({ lengthen: false, laterIri: 'https://elsewhere.example/sets/run-2026-10-01' });
  assert.deepEqual(kindsOf(await check(u1, [u2])), []);
});

// ---- with the dataset -----------------------------------------------------------------------------
test('ends-disagree: a set the dataset lists, made for another dataset, is an error', async () => {
  const d = copy(CS); d.candidateSet.candidatesFor = 'https://whgazetteer.org/example/gazetteer/elsewhere';
  schemaOk(d);
  const r = await check(AC, [d]);
  assert.deepEqual(found(r, 'ends-disagree', 'error').map((i) => i.examples[0]),
    [`${SET}: made for https://whgazetteer.org/example/gazetteer/elsewhere, not ${AC.gazetteer['@id']}`]);
  assert.equal(found(await check(AC, [CS]), 'ends-disagree').length, 0);
});

test('set-not-listed: a set made for the dataset that its candidateSets does not list is a warning', async () => {
  const b = copy(CS); b.candidateSet['@id'] = `${SET}-b`;
  for (const c of b.candidates) c['@id'] = c['@id'].replace(SET, `${SET}-b`);
  schemaOk(b);
  const r = await check(AC, [CS, b]);
  assert.deepEqual(found(r, 'set-not-listed', 'warning').map((i) => i.examples), [[`${SET}-b`]], JSON.stringify(r.items));
  // The controls: listed, it is not reported; and a dataset with no candidateSets key lists nothing to miss.
  const listed = copy(AC); listed.gazetteer.candidateSets.push(`${SET}-b`);
  assert.equal(found(await check(listed, [CS, b]), 'set-not-listed').length, 0);
  const none = copy(AC); delete none.gazetteer.candidateSets;
  assert.equal(found(await check(none, [CS, b]), 'set-not-listed').length, 0);
});

test('promoted-from-unresolved: an answer to a candidate in none of the sets given is a warning, one for each relation', async () => {
  const a = copy(AC); a.attestations[0].identities[0].promotedFrom = `${SET}#c-00000000`;
  a.attestations[1].identities[0].promotedFrom = `${SET}#c-11111111`;
  const r = await check(a, [CS]);
  const [item] = found(r, 'promoted-from-unresolved', 'warning');
  assert.equal(item?.count, 2, JSON.stringify(r.items));
  assert.equal(item.examples[0], `https://whgazetteer.org/example/identity/river-mill-2: ${SET}#c-00000000`);
  assert.equal(found(await check(AC, [CS]), 'promoted-from-unresolved').length, 0);
});

test('promoted-from-other-pair: an answer whose places are not its candidate\'s, in either order, is a warning', async () => {
  const a = copy(AC); a.attestations[0].identities[0].object = 'https://whgazetteer.org/example/county-survey/newton-fen';
  const r = await check(a, [CS]);
  assert.equal(found(r, 'promoted-from-other-pair', 'warning').length, 1, JSON.stringify(r.items));
  // The control: the same pair the other way round is the candidate's pair.
  const swapped = copy(AC), idr = swapped.attestations[0].identities[0];
  [idr.subject, idr.object] = [idr.object, idr.subject];
  assert.equal(found(await check(swapped, [CS]), 'promoted-from-other-pair').length, 0);
});

test('with no set given, a dataset that answers candidates gets one note, naming the sets it lists, not a warning for each relation', async () => {
  const r = await check(AC);
  const notes = found(r, 'candidates-not-given', 'note');
  assert.equal(notes.length, 1, JSON.stringify(r.items));
  assert.match(notes[0].message, /^2 identity relations answer candidates \(promotedFrom\); give the candidate sets/);
  assert.deepEqual(notes[0].examples, [SET]);
  assert.equal(found(r, 'promoted-from-unresolved').length, 0);
  // The controls: given the sets, no note; a dataset with no candidates in it, none either.
  assert.equal(found(await check(AC, [CS]), 'candidates-not-given').length, 0);
  const plain = JSON.parse(readFileSync(`${EX}/place-centric-constantinople.json`, 'utf8'));
  assert.equal(found(await check(plain), 'candidates-not-given').length, 0);
});

test('from RDF, the dataset\'s answers and candidateSets are read back from the graph and checked the same', async () => {
  const nt = outText((await go([file(`${EX}/attestation-centric-judgements.json`)], 'convert', 'ntriples')).e, 'attestation-centric-judgements.nt');
  const given = [await asSet(CS, 'cs.json')];
  const ok = (await go([textFile(nt, 'd.nt')], 'check', null, { candidates: given })).report;
  assert.deepEqual(kindsOf(ok), [], JSON.stringify(ok.items));
  assert.ok(nt.includes('#c-8ed2901c>'), 'the fixture has the answer to break');
  const bad = (await go([textFile(nt.replaceAll('#c-8ed2901c>', '#c-00000000>'), 'd.nt')], 'check', null, { candidates: given })).report;
  assert.equal(found(bad, 'promoted-from-unresolved', 'warning').length, 1, JSON.stringify(bad.items));
  const elsewhere = copy(CS); elsewhere.candidateSet.candidatesFor = 'https://whgazetteer.org/example/gazetteer/elsewhere';
  const ends = (await go([textFile(nt, 'd.nt')], 'check', null, { candidates: [await asSet(elsewhere, 'e.json')] })).report;
  assert.equal(found(ends, 'ends-disagree', 'error').length, 1, JSON.stringify(ends.items));
});

test('a set given that is not a candidate set, or that its profile refuses, is reported, said to be in that set', async () => {
  const r = (await go([json(AC, 'd.json')], 'check', null, { candidates: [await detect([json(AC, 'not-a-set.json')])] })).report;
  assert.deepEqual(found(r, 'candidates-not-a-candidate-set', 'error').map((i) => i.examples[0]), ['not-a-set.json: plato-json (attestation-centric)']);
  const bad = copy(CS); bad.candidates[1].status = 'confirmed';
  const s = await check(AC, [bad]);
  assert.ok(found(s, 'schema', 'error').some((i) => /^In the candidate set given-1\.json: A candidate's status/.test(i.message)), JSON.stringify(s.items));
  assert.equal((await check(AC, [CS])).errors, 0);
});

// ---- the command line -------------------------------------------------------------------------------
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
test('check --candidates: with a dataset, alone, and refused where it is not a candidate set or not a check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plato-tools-elenchos-'));
  try {
    const elsewhere = copy(CS); elsewhere.candidateSet.candidatesFor = 'https://whgazetteer.org/example/gazetteer/elsewhere';
    writeFileSync(join(dir, 'elsewhere.json'), JSON.stringify(elsewhere));
    writeFileSync(join(dir, 'later.json'), JSON.stringify(rerun()));
    const ok = cli('check', `${EX}/attestation-centric-judgements.json`, '--candidates', `${EX}/candidate-set-judgements.json`);
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.match(ok.out, /No problems found\. Read 1 place, 2 attestations, 2 candidates in the candidate sets given/);
    const bad = cli('check', `${EX}/attestation-centric-judgements.json`, '--candidates', join(dir, 'elsewhere.json'));
    assert.equal(bad.code, 1, bad.out + bad.err);
    assert.match(bad.out, /says it is for another dataset/);
    // Alone: the first set is checked, with the others; the later set repeats a published candidate.
    const alone = cli('check', '--candidates', `${EX}/candidate-set-judgements.json`, '--candidates', join(dir, 'later.json'), '--json');
    assert.equal(alone.code, 1, alone.out + alone.err);
    const [r] = alone.out.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(r.input, `${EX}/candidate-set-judgements.json`);
    assert.deepEqual(r.items.filter((i) => i.severity === 'error').map((i) => i.kind), ['already-published']);
    // Refused: a dataset given as a candidate set, and --candidates on anything but check, convert to LPF and apply.
    const notSet = cli('check', '--candidates', `${EX}/attestation-centric-judgements.json`);
    assert.equal(notSet.code, 2);
    assert.match(notSet.err, /given with --candidates, is a PLATO JSON document \(attestation-centric\), not a candidate set/);
    const convert = cli('convert', '--to', 'ntriples', '--out', dir, `${EX}/candidate-set-judgements.json`, '--candidates', `${EX}/candidate-set-judgements.json`);
    assert.equal(convert.code, 2);
    assert.match(convert.err, /--candidates is for check, convert --to lpf or lpf-seq, and apply\./);
    // The guard comes before match and apply are dispatched: match is refused by it, and apply passes
    // it, to be refused by apply itself for what it lacks (the guard's words absent, apply's present).
    const match = cli('match', `${EX}/attestation-centric-judgements.json`, '--candidates', `${EX}/candidate-set-judgements.json`);
    assert.equal(match.code, 2);
    assert.match(match.err, /--candidates is for check, convert --to lpf or lpf-seq, and apply\./);
    const apply = cli('apply', '--candidates', `${EX}/candidate-set-judgements.json`);
    assert.equal(apply.code, 2);
    assert.match(apply.err, /apply takes one dataset of places to match; 0 were given/);
    assert.doesNotMatch(apply.err, /--candidates is for/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
