// Mneme's revision (src/engine/revise.js; plan #34, item 10; Issue #23): a new version of a published
// dataset, edited freely, made to keep PLATO's append-only rule against its previous release. One case per
// rule of the table in the design (what the new version deleted, changed, dropped, added, readdressed, or
// left without an address), and per edge: each failing case beside its control, so that an absence (no
// retraction written) is read beside the presence that the same code writes one when it should; the output
// minted with Agora changes no address; the version check's counts exact; and a writer deliberately broken
// (options.tamper) caught by the step's own checks, so that those checks are shown able to fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, textFile, outText } from './engine.js';
import { detect } from '../src/engine/input.js';
import { revise, SUPERSEDES, withdrawalOf, outputName, headerOf, summaryLine, baseOf, reportName, releaseReport } from '../src/engine/revise.js';
import { RETRACTS } from '../src/engine/krisis/withdraw.js';
import { compare } from '../src/engine/compare.js';
import { publish } from '../src/engine/agora/index.js';
import { run } from '../src/engine/pipeline.js';
import { collectWithdrawn, resolveWithdrawn } from '../src/formats/shared.js';
import { summary } from '../src/engine/words.js';
import { PLATO } from '../src/lib/context.js';
import { checkReviewer } from '../src/engine/krisis/work.js';

const X = 'https://example.org/g/';
const P = (k) => `${X}place/${k}`;
const src = { '@id': X + 'source/s', title: 'S' };
const att = (id, name, extra = {}) => ({ '@id': `${P(id.split(':')[0])}#a-${id.split(':')[1]}`, names: [{ toponym: name }], citations: [{ source: src }], created: '2026-01-01T00:00:00Z', ...extra });
const place = (k, label, attestations) => ({ '@id': P(k), label, attestations });
const G = { '@id': X + 'release/v1', title: 'G', licence: 'https://creativecommons.org/licenses/by/4.0/', status: 'published', version: 'v1', uriSpace: X };
/** The previous release: three places, four attestations, every one with an address. */
const v1 = (more = {}) => ({ profile: 'place-centric', gazetteer: { ...G, ...more }, spatialEntities: [
  place('a', 'A', [att('a:11111111', 'Alpha'), att('a:22222222', 'Alfa')]),
  place('b', 'B', [att('b:33333333', 'Beta')]),
  place('c', 'C', [att('c:44444444', 'Gamma')]),
] });
/** The new version, edited three ways: one attestation changed, one deleted, one place dropped, and a place added. */
const v2 = () => ({ profile: 'place-centric', gazetteer: { ...G, '@id': X, version: undefined, status: 'draft' }, spatialEntities: [
  place('a', 'A', [att('a:11111111', 'Alpha'), att('a:22222222', 'Alfa respelt')]),
  place('b', 'B', []),
  place('d', 'D', [{ names: [{ toponym: 'Delta' }], citations: [{ source: src }] }]),
] });
const json = (d, name) => textFile(JSON.stringify(d), name);
const input = (d, name = 'v.json') => detect([typeof d === 'string' ? textFile(d, name) : json(d, name)]);
const reviewer = { name: 'R. Viewer', orcid: 'https://orcid.org/0000-0002-1825-0097' };
const DATE = '2026-10-17T12:00:00Z';
/** Revise `later` against `earlier` (documents, or inputs), with the reviewer and the date set unless overridden. */
async function revised(earlier, later, options = {}) {
  const e = env();
  const r = await revise({ earlier: earlier.format ? earlier : await input(earlier, 'v1.json'), later: later.format ? later : await input(later, 'v2.json'), options: { reviewer, date: DATE, ...options } }, e);
  const text = r.outputs.length ? outText(e, r.outputs[0].name) : null;
  const account = r.outputs.length > 1 ? JSON.parse(outText(e, r.outputs[1].name)) : null;
  return { r, e, text, doc: text && JSON.parse(text), account, kinds: r.report.items.map((i) => i.kind), item: (k) => r.report.items.find((i) => i.kind === k) };
}
const atts = (doc, k) => doc.spatialEntities.find((p) => p['@id'] === P(k))?.attestations;
const metas = (doc, k) => atts(doc, k).filter((a) => a.meta).map((a) => [a.meta.metaType === RETRACTS ? 'Retracts' : a.meta.metaType === SUPERSEDES ? 'Supersedes' : a.meta.metaType, a.meta.targetAttestation]);
/** The current state of a document's withdrawals: target -> kind. */
const status = (doc) => { const w = new Map(); for (const p of doc.spatialEntities) collectWithdrawn(p.attestations, w); return Object.fromEntries([...resolveWithdrawn(w).status].map(([k, v]) => [k.slice(X.length), v])); };
/** The version check, as a user would run it on two documents. */
const mneme = async (earlier, later) => (await compare({ earlier: await input(earlier, 'v1.json'), later: await input(later, 'v2.json') }, env())).report;

test('the table of rules: deleted is put back and retracted, changed is put back and superseded, a place dropped is a tombstone, added gets an address and a date; the header is a release\'s; the version check passes with exact counts', async () => {
  const { r, doc, kinds, item } = await revised(v1(), v2(), { release: 'v2' });
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const c = r.report.counts;
  assert.deepEqual([c.kept, c.changed, c.removed, c.tombstones, c.added, c.stamped, c.placesAdded], [1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual([c.retracted, c.superseded, c.addedAll, c.attestations, c.previous], [2, 1, 4, 8, 4]);
  // Changed: the old form back as it was, the new form beside it with Supersedes, under a new address in Agora's form.
  const a = atts(doc, 'a');
  assert.deepEqual(a.slice(0, 2), v1().spatialEntities[0].attestations, 'the previous release\'s attestations, exactly as they were');
  assert.equal(a.length, 3);
  assert.deepEqual(metas(doc, 'a'), [['Supersedes', `${P('a')}#a-22222222`]]);
  assert.match(a[2]['@id'], new RegExp(`^${P('a')}#a-[0-9a-f]{8}$`));
  assert.equal(a[2].names[0].toponym, 'Alfa respelt');
  // Deleted: back, and retracted by an attestation of the reviewer's, dated.
  const b = atts(doc, 'b');
  assert.deepEqual(b[0], v1().spatialEntities[1].attestations[0]);
  assert.deepEqual(metas(doc, 'b'), [['Retracts', `${P('b')}#a-33333333`]]);
  assert.deepEqual([b[1].contributor, b[1].created], [reviewer, DATE]);
  assert.match(b[1]['@id'], new RegExp(`^${P('b')}#a-[0-9a-f]{8}$`));
  // Dropped: a tombstone, the place as it was, its one attestation retracted; its description kept.
  const cc = doc.spatialEntities.find((p) => p['@id'] === P('c'));
  assert.equal(cc.label, 'C');
  assert.deepEqual(metas(doc, 'c'), [['Retracts', `${P('c')}#a-44444444`]]);
  // Added: an address, and a created of this revision.
  const d = atts(doc, 'd');
  assert.equal(d.length, 1); assert.match(d[0]['@id'], new RegExp(`^${P('d')}#a-[0-9a-f]{8}$`)); assert.equal(d[0].created, DATE);
  // The header: a release's.
  const g = doc.gazetteer;
  assert.deepEqual([g['@id'], g.version, g.previousVersion, g.isVersionOf, g.status], [`${X}release/v2`, 'v2', `${X}release/v1`, X, 'published']);
  for (const k of ['superseded', 'retracted', 'tombstone', 'created-stamped', 'later-not-published', 'release-written']) assert.ok(kinds.includes(k), k);
  assert.deepEqual(item('tombstone').examples, [P('c')]);
  assert.deepEqual(item('superseded').examples, [`${P('a')}#a-22222222`]);
  // The current state: the superseded and the retracted withdrawn, nothing else.
  assert.deepEqual(status(doc), { 'place/a#a-22222222': 'superseded', 'place/b#a-33333333': 'retracted', 'place/c#a-44444444': 'retracted' });
  // The version check, as a user would run it: nothing deleted or changed, the withdrawals counted.
  const m = await mneme(v1(), doc);
  assert.equal(m.errors, 0, JSON.stringify(m.items));
  assert.deepEqual([m.counts.unchanged, m.counts.added, m.counts.retracted, m.counts.superseded], [4, 4, 2, 1]);
  assert.deepEqual(c.versionCheck, { earlier: 4, later: 8, unchanged: 4, changed: 0, lost: 0, added: 4, retracted: 2, superseded: 1 });
  // And the unrevised new version fails that same check: the control that the check can fail.
  const bad = await mneme(v1(), v2());
  assert.ok(bad.errors >= 3, JSON.stringify(bad.items));
  assert.ok(['attestation-removed', 'attestation-changed'].every((k) => bad.items.some((i) => i.kind === k)));
  // The summary, in words.
  assert.equal(c.said[0], 'Kept 1 attestation; superseded 1 and retracted 2 (1 place withdrawn whole); 1 added (1 new place).');
  assert.match(summary(r.report, 'revise').counted, /it retracts 2 and replaces 1 of the earlier ones/);
  assert.equal(r.outputs[0].name, 'v2-revised.json');
  // The release report beside it (Stephen, 17 October 2026): the counts by category, every chain closed and every tombstone
  // named, who signed the retractions (the reviewer, as the dataset's maintainer) and when; a cross-check of the words above.
  const { account } = await revised(v1(), v2(), { release: 'v2' });
  assert.equal(r.outputs[1].name, 'v2.release.json');
  assert.deepEqual([account.format, account.version], ['plato-tools-release', 1]);
  assert.deepEqual(account.counts, { unchanged: 1, new: 1, superseded: 1, retracted: 2, tombstones: 1, chainsClosed: 0, places: 3, placesAdded: 1, attestations: 8, previousAttestations: 4 });
  assert.deepEqual([account.chainsClosed, account.tombstones], [[], [P('c')]]);
  assert.deepEqual(account.release, { '@id': `${X}release/v2`, version: 'v2', previousVersion: `${X}release/v1`, isVersionOf: X });
  assert.deepEqual(account.previous, { '@id': `${X}release/v1`, version: 'v1' });
  assert.deepEqual([account.maintainer, account.date], [reviewer, DATE]);
  assert.deepEqual(account.versionCheck, c.versionCheck);
  assert.equal(account.revised.file, 'v2-revised.json'); assert.match(account.revised.sha256, /^[0-9a-f]{64}$/);
  // Its counts are the words' (the cross-check): the same figures the summary line says.
  assert.equal(summaryLine({ kept: account.counts.unchanged, superseded: account.counts.superseded, retracted: account.counts.retracted, tombstones: account.counts.tombstones, added: account.counts.new, placesAdded: account.counts.placesAdded }), c.said[0]);
  assert.equal(reportName('deep-plato-revised.json'), 'deep-plato.release.json');
});

test('nothing changed: the same content, the header edits only, said as nothing revised; and a draft as the previous release is warned of, and revised against', async () => {
  const same = { ...v1(), gazetteer: { ...G, '@id': X, status: 'draft', version: undefined } };
  const { r, doc, kinds } = await revised(v1(), same, { release: 'v2' });
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.ok(kinds.includes('nothing-revised'));
  assert.deepEqual([r.report.counts.kept, r.report.counts.retracted, r.report.counts.superseded, r.report.counts.addedAll], [4, 0, 0, 0]);
  assert.equal(doc.gazetteer.version, 'v2');
  assert.deepEqual(status(doc), {}, 'nothing withdrawn');
  // The presence beside it: the edited version, through the same code, is not "nothing revised".
  const edited = await revised(v1(), v2(), { release: 'v2' });
  assert.ok(!edited.kinds.includes('nothing-revised'));
  // A draft previous release binds nothing, and is said; the revision is still written.
  const draft = await revised(v1({ status: 'draft' }), v2());
  assert.equal(draft.r.report.errors, 0, JSON.stringify(draft.r.report.items));
  assert.ok(draft.kinds.includes('earlier-not-published'));
  assert.equal(draft.r.report.counts.retracted, 2);
});

test('Agora\'s minting of the revised dataset against the previous release keeps every address: none changes, the previous release\'s are inherited', async () => {
  const { doc } = await revised(v1(), v2(), { release: 'v2' });
  const e = env();
  const minted = await publish({ part: 'mint', input: await input(doc, 'v2-revised.json'), previous: await input(v1(), 'v1.json'), options: { name: 'v2-revised.json' } }, e);
  assert.equal(minted.report.errors, 0, JSON.stringify(minted.report.items));
  assert.deepEqual([minted.report.counts.minted, minted.report.counts.kept], [0, 8], 'every attestation had its address already');
  const lines = outText(e, minted.outputs[0].name).trim().split('\n').slice(1).map((l) => JSON.parse(l));
  const before = doc.spatialEntities.flatMap((p) => p.attestations.map((a) => a['@id'])).sort();
  assert.deepEqual(lines.flatMap((p) => p.attestations.map((a) => a['@id'])).sort(), before);
  // The control: minted afresh as a draft, without the addresses, the same content gets the same addresses for what the revision minted.
  const bare = { ...doc, gazetteer: { ...doc.gazetteer, status: 'draft', previousVersion: undefined }, spatialEntities: doc.spatialEntities.map((p) => ({ ...p, attestations: p.attestations.map(({ '@id': _, ...a }) => a) })) };
  const e2 = env();
  const again = await publish({ part: 'mint', input: await input(bare, 'bare.json'), options: { name: 'bare.json' } }, e2);
  assert.equal(again.report.errors, 0);
  const fresh = outText(e2, again.outputs[0].name).trim().split('\n').slice(1).map((l) => JSON.parse(l)).flatMap((p) => p.attestations.map((a) => a['@id']));
  for (const id of before.filter((x) => !/#a-[1-4]{8}$/.test(x))) assert.ok(fresh.includes(id), `${id} is what Agora would have minted`);
});

test('the tables case, no addresses at all (a CSV table of places under a base): unchanged rows inherit their addresses, a respelt name is paired (one deleted, one added, the same kind and source) and supersedes, a deleted row is retracted, a new row is added', async () => {
  const B = 'https://example.org/t/';
  const csv = (rows) => textFile('id,name,latitude,longitude,source\n' + rows.map((r) => r.join(',')).join('\n') + '\n', 'places.csv');
  const rows = [['n', 'Newton', '52.0', '-1.0', 'Survey'], ['k', 'Kingsbury', '51.58', '-0.28', 'Survey'], ['w', 'Windermere', '54.38', '-2.91', 'Survey']];
  // The previous release: the table read under the base, minted by Agora (every release of a table is minted afresh).
  const e = env();
  const minted = await publish({ part: 'mint', input: await detect([csv(rows)]), options: { name: 'places.csv', base: B } }, e);
  assert.equal(minted.report.errors, 0, JSON.stringify(minted.report.items));
  const prevText = outText(e, minted.outputs[0].name).replace('"status":"draft"', '"status":"published"');
  const prev = prevText.split('\n')[0].includes('"status":"published"') ? prevText : prevText.replace(/"gazetteer":\{/, '"gazetteer":{"status":"published",');
  const earlier = await detect([textFile(prev, 'places-with-ids.jsonl')]);
  const prevIds = prev.trim().split('\n').slice(1).map((l) => JSON.parse(l)).flatMap((p) => p.attestations.map((a) => a['@id']));
  assert.equal(prevIds.length, 3);
  // The new version: Newton respelt, Kingsbury deleted, Ambleside added.
  const later = await detect([csv([['n', 'Newtown', '52.0', '-1.0', 'Survey'], ['w', 'Windermere', '54.38', '-2.91', 'Survey'], ['a', 'Ambleside', '54.43', '-2.96', 'Survey']])]);
  const { r, doc, kinds, item } = await revised(earlier, later, { base: B, release: 'v2' });
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const c = r.report.counts;
  assert.deepEqual([c.inherited, c.kept, c.paired, c.removed, c.tombstones, c.added, c.retracted, c.superseded], [1, 0, 1, 0, 1, 2, 1, 1]);
  assert.ok(kinds.includes('paired') && kinds.includes('inherited') && kinds.includes('dataset-now-plato-json'));
  assert.deepEqual(item('paired').examples, [`${prevIds.find((i) => i.includes('place/n#'))} (${B}place/n)`]);
  const newton = doc.spatialEntities.find((p) => p['@id'] === `${B}place/n`).attestations;
  assert.equal(newton.length, 2);
  const oldNewton = newton.find((a) => a.names[0].toponym === 'Newton'), newNewton = newton.find((a) => a.names[0].toponym === 'Newtown');
  assert.equal(oldNewton['@id'], prevIds.find((i) => i.includes('place/n#')), 'the deleted row back under its address');
  assert.deepEqual([newNewton.meta.metaType, newNewton.meta.targetAttestation], [SUPERSEDES, oldNewton['@id']]);
  const windermere = doc.spatialEntities.find((p) => p['@id'] === `${B}place/w`).attestations;
  assert.deepEqual(windermere.map((a) => a['@id']), [prevIds.find((i) => i.includes('place/w#'))], 'the unchanged row inherits its address');
  const kingsbury = doc.spatialEntities.find((p) => p['@id'] === `${B}place/k`).attestations;
  assert.deepEqual(kingsbury.map((a) => a.meta?.metaType ?? null), [null, RETRACTS], 'a tombstone');
  assert.equal(doc.gazetteer.uriSpace, B);
  const m = await compare({ earlier, later: await input(doc, 'revised.json') }, env());
  assert.equal(m.report.errors, 0, JSON.stringify(m.report.items));
  assert.deepEqual([m.report.counts.retracted, m.report.counts.superseded, m.report.counts.added], [1, 1, 3]);
  // The control: the same table unchanged inherits every address, and nothing is revised.
  const same = await revised(earlier, await detect([csv(rows)]), { base: B, release: 'v2' });
  assert.equal(same.r.report.errors, 0, JSON.stringify(same.r.report.items));
  assert.deepEqual([same.r.report.counts.inherited, same.r.report.counts.retracted, same.r.report.counts.superseded, same.r.report.counts.addedAll], [3, 0, 0, 0]);
  assert.ok(same.kinds.includes('nothing-revised'));
  // And the pairing is not guessed: two attestations of one place deleted and two added (both respelt, without addresses), nothing is paired: two retractions, two additions.
  const both = v1(); both.gazetteer = { ...G, '@id': X, version: undefined };
  both.spatialEntities[0].attestations = both.spatialEntities[0].attestations.map(({ '@id': _, ...a }, i) => ({ ...a, names: [{ toponym: `Respelt ${i}` }] }));
  const un = await revised(v1(), both);
  assert.equal(un.r.report.errors, 0, JSON.stringify(un.r.report.items));
  assert.deepEqual([un.r.report.counts.paired, un.r.report.counts.removed, un.r.report.counts.added], [0, 2, 2]);
});

test('a chain: A replaced by B in one release, B changed again in the next: C supersedes B, and A is retracted with it (chain closed), so that only C is current; without the retraction, A would be current again', async () => {
  const r2 = await revised(v1(), v2(), { release: 'v2' });
  const B = atts(r2.doc, 'a')[2];
  assert.equal(B.names[0].toponym, 'Alfa respelt');
  // The third release: B edited again, in a copy that lost its meta (as an edit in a table does, which has no column for it).
  const v3 = JSON.parse(JSON.stringify(r2.doc));
  v3.spatialEntities[0].attestations[2] = { ...B, names: [{ toponym: 'Alfa respelt again' }], meta: undefined };
  const r3 = await revised(r2.doc, v3, { release: 'v3' });
  assert.equal(r3.r.report.errors, 0, JSON.stringify(r3.r.report.items));
  assert.equal(r3.r.report.counts.chainClosed, 1);
  assert.deepEqual(r3.item('chain-closed').examples, [`${P('a')}#a-22222222`]);
  assert.deepEqual([r3.account.chainsClosed, r3.account.counts.chainsClosed], [[`${P('a')}#a-22222222`], 1], 'the release report names the chain closed');
  const a = atts(r3.doc, 'a');
  const C = a.find((x) => x.names?.[0].toponym === 'Alfa respelt again');
  assert.deepEqual(C.meta, { targetAttestation: B['@id'], metaType: SUPERSEDES });
  const chain = a.find((x) => x.meta?.metaType === RETRACTS && x.meta.targetAttestation === `${P('a')}#a-22222222`);
  assert.ok(chain, 'A is retracted'); assert.match(chain.notes, /does not become current again/);
  assert.deepEqual(status(r3.doc), { 'place/a#a-22222222': 'retracted', [B['@id'].slice(X.length)]: 'superseded', 'place/b#a-33333333': 'retracted', 'place/c#a-44444444': 'retracted' });
  const current = a.filter((x) => x.names && !status(r3.doc)[x['@id'].slice(X.length)]).map((x) => x.names[0].toponym);
  assert.deepEqual(current, ['Alpha', 'Alfa respelt again'], 'one spelling of Alfa is current: the newest');
  // Without the chain closed, the same document says A is current again: the hazard the retraction answers.
  const open = { ...r3.doc, spatialEntities: r3.doc.spatialEntities.map((p) => ({ ...p, attestations: p.attestations.filter((x) => x !== chain) })) };
  assert.equal(status(open)['place/a#a-22222222'], undefined, 'A revived');
  // The version check counts the replacement of B as new; A, withdrawn already in release 2, is not newly withdrawn for it.
  assert.deepEqual([r3.r.report.counts.versionCheck.retracted, r3.r.report.counts.versionCheck.superseded], [0, 1]);
  assert.deepEqual([r3.r.report.counts.retracted, r3.r.report.counts.superseded], [0, 1]);
  // B edited in a copy that keeps its meta (Supersedes A): an attestation's meta is one object, so the copy keeps it, replacing A
  // under its new address, and B is retracted beside it; A is withdrawn by the copy, which holds, so no chain retraction is written.
  const v3m = JSON.parse(JSON.stringify(r2.doc));
  v3m.spatialEntities[0].attestations[2] = { ...B, names: [{ toponym: 'Alfa respelt, meta kept' }] };
  const r3m = await revised(r2.doc, v3m, { release: 'v3' });
  assert.equal(r3m.r.report.errors, 0, JSON.stringify(r3m.r.report.items));
  assert.deepEqual([r3m.r.report.counts.removed, r3m.r.report.counts.added, r3m.r.report.counts.chainClosed, r3m.r.report.counts.changed], [1, 1, 0, 0]);
  const am = atts(r3m.doc, 'a');
  const Cm = am.find((x) => x.names?.[0].toponym === 'Alfa respelt, meta kept');
  assert.deepEqual(Cm.meta, B.meta); assert.notEqual(Cm['@id'], B['@id']);
  assert.deepEqual(status(r3m.doc)[B['@id'].slice(X.length)], 'retracted');
  assert.deepEqual(status(r3m.doc)['place/a#a-22222222'], 'superseded');
  assert.deepEqual(am.filter((x) => x.names && !status(r3m.doc)[x['@id'].slice(X.length)]).map((x) => x.names[0].toponym), ['Alpha', 'Alfa respelt, meta kept']);
});

test('a withdrawal written by hand in the new version is respected, not doubled; a hand-written Supersedes whose target is a superseder gets the chain closed too', async () => {
  const r2 = await revised(v1(), v2(), { release: 'v2' });
  const B = atts(r2.doc, 'a')[2];
  // By hand: Beta's retraction is kept (it is the revision's own, from release 2), and B is replaced by hand, with no chain closing of the user's.
  const v3 = JSON.parse(JSON.stringify(r2.doc));
  v3.spatialEntities[0].attestations.splice(2, 1, { names: [{ toponym: 'Alfa by hand' }], citations: [{ source: src }], created: DATE, meta: { targetAttestation: B['@id'], metaType: SUPERSEDES } });
  const r3 = await revised(r2.doc, v3, { release: 'v3' });
  assert.equal(r3.r.report.errors, 0, JSON.stringify(r3.r.report.items));
  assert.deepEqual([r3.r.report.counts.withdrawnByYou, r3.r.report.counts.chainClosed, r3.r.report.counts.removed, r3.r.report.counts.changed], [1, 1, 0, 0]);
  const a = atts(r3.doc, 'a');
  assert.equal(a.filter((x) => x.meta?.targetAttestation === B['@id']).length, 1, 'the user\'s withdrawal, and no second');
  assert.deepEqual(status(r3.doc)['place/a#a-22222222'], 'retracted', 'A retracted with it');
  // The control: the same without the hand-written Supersedes is a deletion, retracted by the revision itself.
  const v3b = JSON.parse(JSON.stringify(r2.doc)); v3b.spatialEntities[0].attestations.splice(2, 1);
  const r3b = await revised(r2.doc, v3b, { release: 'v3' });
  assert.equal(r3b.r.report.errors, 0, JSON.stringify(r3b.r.report.items));
  assert.deepEqual([r3b.r.report.counts.withdrawnByYou, r3b.r.report.counts.removed, r3b.r.report.counts.chainClosed], [0, 1, 1]);
});

test('an attestation the previous release had already withdrawn, deleted now, is put back only; a retraction deleted or changed is put back and holds, said', async () => {
  const r2 = await revised(v1(), v2(), { release: 'v2' });
  // Alfa (superseded in release 2) deleted in release 3: back, nothing more. Beta's retraction deleted: back, holding.
  const v3 = JSON.parse(JSON.stringify(r2.doc));
  v3.spatialEntities[0].attestations.splice(1, 1);
  v3.spatialEntities[1].attestations.splice(1, 1);
  const r3 = await revised(r2.doc, v3, { release: 'v3' });
  assert.equal(r3.r.report.errors, 0, JSON.stringify(r3.r.report.items));
  assert.deepEqual([r3.r.report.counts.alreadyWithdrawn, r3.r.report.counts.removed, r3.r.report.counts.retracted, r3.r.report.counts.superseded], [1, 0, 0, 0]);
  assert.ok(r3.kinds.includes('withdrawal-kept') && r3.kinds.includes('already-withdrawn'));
  assert.deepEqual(status(r3.doc), status(r2.doc), 'the current state is as it was');
  assert.equal(atts(r3.doc, 'b').length, 2);
  // The control: deleting a current attestation of the same release is retracted.
  const v3b = JSON.parse(JSON.stringify(r2.doc)); v3b.spatialEntities[0].attestations.splice(0, 1);
  const r3b = await revised(r2.doc, v3b, { release: 'v3' });
  assert.deepEqual([r3b.r.report.counts.alreadyWithdrawn, r3b.r.report.counts.removed], [0, 1]);
});

test('an address lost (the same attestation without it, or under another) is given back; one used twice is settled; an address of another place is refused', async () => {
  const same = v1();
  same.gazetteer = { ...G, '@id': X, version: undefined, status: 'draft' };
  delete same.spatialEntities[0].attestations[0]['@id'];                          // without it
  same.spatialEntities[1].attestations[0]['@id'] = `${P('b')}#a-deadbeef`;        // under another
  const { r, doc, kinds } = await revised(v1(), same);
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.deepEqual([r.report.counts.inherited, r.report.counts.readdressed, r.report.counts.addedAll], [1, 1, 0]);
  assert.ok(kinds.includes('readdressed-restored'));
  assert.deepEqual([atts(doc, 'a')[0]['@id'], atts(doc, 'b')[0]['@id']], [`${P('a')}#a-11111111`, `${P('b')}#a-33333333`]);
  assert.deepEqual(status(doc), {});
  // Twice: the one saying what was published keeps it; the other replaces it.
  const twice = v1(); twice.gazetteer = { ...G, '@id': X, version: undefined };
  twice.spatialEntities[0].attestations.push(att('a:11111111', 'Alpha again'));
  const t = await revised(v1(), twice);
  assert.equal(t.r.report.errors, 0, JSON.stringify(t.r.report.items));
  assert.ok(t.kinds.includes('address-twice'));
  assert.deepEqual(metas(t.doc, 'a'), [['Supersedes', `${P('a')}#a-11111111`]]);
  assert.equal(atts(t.doc, 'a').filter((a) => a['@id'] === `${P('a')}#a-11111111`).length, 1, 'the address once');
  // Moved: refused, nothing written.
  const moved = v1(); moved.gazetteer = { ...G, '@id': X, version: undefined };
  moved.spatialEntities[1].attestations[0]['@id'] = `${P('a')}#a-22222222`; moved.spatialEntities[0].attestations.splice(1, 1);
  const mv = await revised(v1(), moved);
  assert.ok(mv.r.incomplete && mv.kinds.includes('address-moved'), JSON.stringify(mv.r.report.items));
  assert.equal(mv.text, null, 'nothing written');
});

test('refused in words, nothing written: no reviewer, a previous release without addresses, two bases, the same release name, a facet with an address changed; each beside the same data accepted', async () => {
  const ok = await revised(v1(), v2(), { release: 'v2' });
  assert.equal(ok.r.report.errors, 0);
  const no = await revise({ earlier: await input(v1(), 'v1.json'), later: await input(v2(), 'v2.json'), options: { release: 'v2' } }, env());
  assert.ok(no.incomplete && no.report.items.some((i) => i.kind === 'no-reviewer'));
  const bad = await revised(v1(), v2(), { reviewer: { name: 'R', orcid: 'not-an-orcid' } });
  assert.ok(bad.r.incomplete && bad.kinds.includes('bad-reviewer'));
  const un = v1(); for (const p of un.spatialEntities) for (const a of p.attestations) delete a['@id'];
  const unaddressed = await revised(un, v2());
  assert.ok(unaddressed.r.incomplete && unaddressed.item('previous-unaddressed')?.count === 4, JSON.stringify(unaddressed.r.report.items));
  assert.equal(unaddressed.text, null);
  const other = v2(); other.gazetteer = { ...other.gazetteer, uriSpace: 'https://example.org/other/' };
  const bases = await revised(v1(), other);
  assert.ok(bases.r.incomplete && bases.kinds.includes('base-differs'), JSON.stringify(bases.r.report.items));
  assert.deepEqual(bases.item('base-differs').examples, [`${X} and https://example.org/other/`]);
  // The base given for this run settles it: the same new version, under the previous release's base.
  const given = await revised(v1(), other, { base: X });
  assert.equal(given.r.report.errors, 0, JSON.stringify(given.r.report.items));
  assert.ok(given.kinds.includes('base-written')); assert.equal(given.doc.gazetteer.uriSpace, X);
  const sameName = await revised(v1(), v2(), { release: 'v1' });
  assert.ok(sameName.r.incomplete && sameName.kinds.includes('same-release'));
  // A shared name with an address of its own (a facet), respelt: the attestation is unchanged, what it says is not.
  const shared = { ...v1(), spatialEntities: [place('a', 'A', [{ ...att('a:11111111', 'Alpha'), names: [{ '@id': X + 'name/alpha', toponym: 'Alpha' }] }])] };
  const facet = JSON.parse(JSON.stringify(shared)); facet.spatialEntities[0].attestations[0].names[0].toponym = 'Alpha, respelt'; facet.gazetteer = { ...G, '@id': X, version: undefined };
  const f = await revised(shared, facet);
  assert.ok(f.r.incomplete && f.kinds.includes('facet-changed'), JSON.stringify(f.r.report.items));
  assert.deepEqual(f.item('facet-changed').examples, [X + 'name/alpha']);
  assert.equal(f.text, null, 'nothing written');
  const fOk = await revised(shared, { ...JSON.parse(JSON.stringify(shared)), gazetteer: { ...G, '@id': X, version: undefined } });
  assert.equal(fOk.r.report.errors, 0, 'the control: the shared name as it was');
});

test('a release carries an address on every attestation: a deleted attestation of a place outside the base cannot be retracted (no address for the retraction), and one added there cannot be addressed: each refused, nothing written; the same under the base is revised', async () => {
  const out = v1(); out.spatialEntities[1]['@id'] = 'https://elsewhere.org/place/b'; out.spatialEntities[1].attestations[0]['@id'] = 'https://elsewhere.org/place/b#a-33333333';
  const later = v2(); later.spatialEntities[1]['@id'] = 'https://elsewhere.org/place/b';
  const r = await revised(out, later);
  assert.ok(r.r.incomplete && r.kinds.includes('cannot-withdraw-outside-base'), JSON.stringify(r.r.report.items));
  assert.deepEqual(r.item('cannot-withdraw-outside-base').examples, ['https://elsewhere.org/place/b']);
  assert.equal(r.text, null);
  const added = v2(); added.spatialEntities[2]['@id'] = 'https://elsewhere.org/place/d';
  const a = await revised(v1(), added);
  assert.ok(a.r.incomplete && a.kinds.includes('attestations-unaddressed'), JSON.stringify(a.r.report.items));
  assert.deepEqual(a.item('attestations-unaddressed').examples, ['https://elsewhere.org/place/d']);
  assert.equal(a.text, null, 'nothing written');
  const ok = await revised(v1(), v2());
  assert.equal(ok.r.report.errors, 0);
  assert.ok(ok.doc.spatialEntities.every((p) => p.attestations.every((x) => typeof x['@id'] === 'string')), 'every attestation written has an address');
});

test('a decision answered both ways in the new version is passed through as the error it is (Krisis withdraws a changed answer; this does not)', async () => {
  const who = { name: 'J. Udge' };
  const yes = { '@id': `${P('a')}#a-55555555`, identities: [{ object: 'https://example.org/other/a', identityType: 'exactMatch' }], contributor: who, created: '2026-01-01T00:00:00Z', citations: [{ source: src }] };
  const earlier = v1(); earlier.spatialEntities[0].attestations.push(yes);
  const later = JSON.parse(JSON.stringify(earlier)); later.gazetteer = { ...G, '@id': X, version: undefined };
  later.spatialEntities[0].attestations.push({ identities: [{ object: 'https://example.org/other/a', identityType: 'exactMatch' }], negated: true, contributor: who, created: DATE, citations: [{ source: src }] });
  const r = await revised(earlier, later);
  assert.ok(r.r.incomplete && r.kinds.includes('answered-both-ways'), JSON.stringify(r.r.report.items));
  assert.equal(r.text, null);
  // The control: the denial withdrawing the acceptance (as Krisis writes it) passes.
  const withdrawn = JSON.parse(JSON.stringify(later));
  withdrawn.spatialEntities[0].attestations.push({ meta: { targetAttestation: yes['@id'], metaType: RETRACTS }, contributor: who, created: DATE });
  const ok = await revised(earlier, withdrawn);
  assert.equal(ok.r.report.errors, 0, JSON.stringify(ok.r.report.items));
  assert.equal(ok.r.report.counts.withdrawnByYou, 0); assert.equal(ok.r.report.counts.retracted, 1);
});

test('the review\'s cases: a retraction retracted restores its target (said, not a fault); deleting A when its only retraction is itself retracted retracts A; a withdrawn twin is not inherited by a row put back; a version with addresses is never paired; the header still the previous release\'s is refused without a release name', async () => {
  const R = { '@id': `${P('a')}#a-r1`, meta: { targetAttestation: `${P('a')}#a-11111111`, metaType: RETRACTS }, contributor: reviewer, created: '2026-02-01T00:00:00Z' };
  // 1. Restored, PLATO's way: the new version retracts the retraction.
  const prev1 = { ...v1(), spatialEntities: [place('a', 'A', [att('a:11111111', 'Alpha'), R])] };
  const next1 = { ...prev1, gazetteer: { ...G, '@id': X, version: undefined }, spatialEntities: [place('a', 'A', [att('a:11111111', 'Alpha'), R, { meta: { targetAttestation: R['@id'], metaType: RETRACTS }, contributor: reviewer, created: DATE, notes: 'restored' }])] };
  const restored = await revised(prev1, next1);
  assert.equal(restored.r.report.errors, 0, JSON.stringify(restored.r.report.items));
  assert.deepEqual(restored.item('restored').examples, [`${P('a')}#a-11111111`]);
  assert.equal(status(restored.doc)['place/a#a-11111111'], undefined, 'Alpha current again');
  // The control: the same without the restoring retraction keeps Alpha withdrawn, and nothing is said restored.
  const kept = await revised(prev1, { ...next1, spatialEntities: [place('a', 'A', [att('a:11111111', 'Alpha'), R])] });
  assert.equal(kept.r.report.errors, 0); assert.equal(kept.item('restored'), undefined); assert.equal(status(kept.doc)['place/a#a-11111111'], 'retracted');
  // 3. A closer that no longer holds: R retracts A, R2 retracts R (A current). Deleting A: R is not a withdrawal that stands, so A is retracted.
  const R2 = { '@id': `${P('a')}#a-r2`, meta: { targetAttestation: R['@id'], metaType: RETRACTS }, contributor: reviewer, created: '2026-03-01T00:00:00Z' };
  const prev3 = { ...v1(), spatialEntities: [place('a', 'A', [att('a:11111111', 'Alpha'), R, R2])] };
  const gone = await revised(prev3, { ...prev3, gazetteer: { ...G, '@id': X, version: undefined }, spatialEntities: [place('a', 'A', [R, R2])] });
  assert.equal(gone.r.report.errors, 0, JSON.stringify(gone.r.report.items));
  assert.deepEqual([gone.r.report.counts.withdrawnByYou, gone.r.report.counts.removed], [0, 1]);
  assert.equal(status(gone.doc)['place/a#a-11111111'], 'retracted');
  // The control: a retraction by hand that holds is respected, not doubled.
  const byHand = await revised(prev3, { ...prev3, gazetteer: { ...G, '@id': X, version: undefined }, spatialEntities: [place('a', 'A', [R, R2, { meta: { targetAttestation: `${P('a')}#a-11111111`, metaType: RETRACTS }, contributor: reviewer, created: DATE }])] });
  assert.deepEqual([byHand.r.report.counts.withdrawnByYou, byHand.r.report.counts.removed], [1, 0]);
  // 4. The tables case: Alfa deleted in release 2 (retracted), put back in release 3 with the same content and no address: a new attestation, not its dead twin.
  const r2 = await revised(v1(), { ...v1(), gazetteer: { ...G, '@id': X, version: undefined }, spatialEntities: [place('a', 'A', [{ ...att('a:11111111', 'Alpha'), '@id': undefined }]), ...v1().spatialEntities.slice(1)] }, { release: 'v2' });
  assert.equal(r2.r.report.errors, 0, JSON.stringify(r2.r.report.items)); assert.equal(status(r2.doc)['place/a#a-22222222'], 'retracted');
  const v3 = JSON.parse(JSON.stringify(r2.doc)); v3.gazetteer = { ...v3.gazetteer, '@id': X, version: undefined };
  v3.spatialEntities[0].attestations = [{ names: [{ toponym: 'Alpha' }], citations: [{ source: src }], created: '2026-01-01T00:00:00Z' }, { names: [{ toponym: 'Alfa' }], citations: [{ source: src }], created: '2026-01-01T00:00:00Z' }];
  const back = await revised(r2.doc, v3, { release: 'v3' });
  assert.equal(back.r.report.errors, 0, JSON.stringify(back.r.report.items));
  assert.deepEqual([back.r.report.counts.inherited, back.r.report.counts.added, back.r.report.counts.alreadyWithdrawn], [1, 1, 1]);
  const alfas = atts(back.doc, 'a').filter((x) => x.names?.[0].toponym === 'Alfa');
  assert.equal(alfas.length, 2); assert.notEqual(alfas[0]['@id'], alfas[1]['@id']);
  const live = alfas.find((x) => !status(back.doc)[x['@id'].slice(X.length)]);
  assert.ok(live && live['@id'] !== `${P('a')}#a-22222222`, 'the row put back is current, under an address of its own');
  // 2. A version with addresses is never paired: A2 deleted, an unrelated attestation of the same kind and source added.
  const addressed = { ...v1(), gazetteer: { ...G, '@id': X, version: undefined }, spatialEntities: [place('a', 'A', [att('a:11111111', 'Alpha'), { names: [{ toponym: 'Unrelated' }], citations: [{ source: src }], created: DATE }]), ...v1().spatialEntities.slice(1)] };
  const np = await revised(v1(), addressed);
  assert.equal(np.r.report.errors, 0, JSON.stringify(np.r.report.items));
  assert.deepEqual([np.r.report.counts.paired, np.r.report.counts.removed, np.r.report.counts.added], [0, 1, 1]);
  // The control: the same place with no addresses at all is paired (the tables case, above).
  const bare = { ...addressed, spatialEntities: [place('a', 'A', [{ ...att('a:11111111', 'Alpha'), '@id': undefined }, { names: [{ toponym: 'Unrelated' }], citations: [{ source: src }], created: DATE }]), ...v1().spatialEntities.slice(1)] };
  const pp = await revised(v1(), bare);
  assert.deepEqual([pp.r.report.counts.paired, pp.r.report.counts.removed], [1, 0]);
  // 6. The -with-ids copy edited, its header untouched, and no release name: refused as the same release name is.
  const untouched = { ...v1(), spatialEntities: [place('a', 'A', [att('a:11111111', 'Alpha'), att('a:22222222', 'Alfa respelt')]), ...v1().spatialEntities.slice(1)] };
  const same = await revised(v1(), untouched);
  assert.ok(same.r.incomplete && same.kinds.includes('same-release-header'), JSON.stringify(same.r.report.items));
  assert.equal(same.text, null);
  const named = await revised(v1(), untouched, { release: 'v2' });
  assert.equal(named.r.report.errors, 0, 'the control: with a release name it is revised');
  assert.equal(named.doc.gazetteer.version, 'v2');
});

test('a writer gone wrong is caught by the step\'s own checks, and nothing is written: a retraction dropped (revived, not all withdrawn), an attestation of a tombstone lost (not append-only), the chain retraction dropped (revived)', async () => {
  const noRetraction = await revised(v1(), v2(), { tamper: (rec) => (rec['@id'] === P('b') ? { ...rec, attestations: rec.attestations.filter((a) => !a.meta) } : rec) });
  assert.ok(noRetraction.r.incomplete && noRetraction.kinds.includes('not-all-withdrawn'), JSON.stringify(noRetraction.r.report.items));
  assert.equal(noRetraction.text, null, 'nothing written');
  const lostOld = await revised(v1(), v2(), { tamper: (rec) => (rec['@id'] === P('c') ? { ...rec, attestations: rec.attestations.filter((a) => a.meta) } : rec) });
  assert.ok(lostOld.r.incomplete && lostOld.kinds.includes('not-all-added'), JSON.stringify(lostOld.r.report.items));
  assert.equal(lostOld.text, null);
  // The count kept, the content not: the tombstone's attestation written changed is the version check's to find.
  const changedOld = await revised(v1(), v2(), { tamper: (rec) => (rec['@id'] === P('c') ? { ...rec, attestations: rec.attestations.map((a) => (a.meta ? a : { ...a, names: [{ toponym: 'Gamma, altered' }] })) } : rec) });
  assert.ok(changedOld.r.incomplete && changedOld.kinds.includes('not-append-only'), JSON.stringify(changedOld.r.report.items));
  assert.equal(changedOld.text, null);
  const r2 = await revised(v1(), v2(), { release: 'v2' });
  const v3 = JSON.parse(JSON.stringify(r2.doc)); v3.gazetteer = { ...v3.gazetteer, '@id': X, version: undefined }; v3.spatialEntities[0].attestations[2] = { ...v3.spatialEntities[0].attestations[2], names: [{ toponym: 'Alfa once more' }], meta: undefined };
  const chainDropped = await revised(r2.doc, v3, { tamper: (rec) => (rec['@id'] === P('a') ? { ...rec, attestations: rec.attestations.filter((a) => a.meta?.targetAttestation !== `${P('a')}#a-22222222` || a.meta.metaType !== RETRACTS) } : rec) });
  assert.ok(chainDropped.r.incomplete && chainDropped.kinds.includes('revived'), JSON.stringify(chainDropped.r.report.items));
  assert.deepEqual(chainDropped.item('revived').examples, [`${P('a')}#a-22222222`]);
  // An attestation written without an address (one whose statements could not be made gets no digest, and none) is caught on the read-back.
  const noId = await revised(v1(), v2(), { tamper: (rec) => (rec['@id'] === P('d') ? { ...rec, attestations: rec.attestations.map(({ '@id': _, ...a }) => a) } : rec) });
  assert.ok(noId.r.incomplete && noId.kinds.includes('not-all-addressed'), JSON.stringify(noId.r.report.items));
  assert.deepEqual(noId.item('not-all-addressed').examples, [P('d')]);
  // The control: the same tamper that changes nothing passes.
  const untouched = await revised(v1(), v2(), { tamper: (rec) => rec });
  assert.equal(untouched.r.report.errors, 0);
});

test('stopped by the caller: nothing written, said as stopped; the previous release unreadable: refused', async () => {
  const ctl = new AbortController(); ctl.abort();
  const r = await revise({ earlier: await input(v1(), 'v1.json'), later: await input(v2(), 'v2.json'), options: { reviewer, signal: ctl.signal } }, env());
  assert.ok(r.aborted && r.incomplete && r.outputs.length === 0);
  const cut = JSON.stringify(v1()).slice(0, 200);
  const bad = await revised(await input(cut, 'v1.json'), v2());
  assert.ok(bad.r.incomplete && bad.kinds.includes('previous-not-read'), JSON.stringify(bad.r.report.items));
});

test('the base address of a version: the one given, else uriSpace, else isVersionOf (a release\'s own address is under the base\'s release folder, as DEEP\'s), else the address\'s folder; a release shaped as DEEP\'s is revised under it', async () => {
  assert.equal(baseOf({ gazetteer: { uriSpace: 'https://w3id.org/whg-epns', '@id': 'https://w3id.org/whg-epns/release/data-2026-09-28' } }), 'https://w3id.org/whg-epns/');
  assert.equal(baseOf({ gazetteer: { '@id': 'https://w3id.org/whg-epns/release/data-2026-09-28', isVersionOf: 'https://w3id.org/whg-epns/' } }), 'https://w3id.org/whg-epns/');
  assert.equal(baseOf({ gazetteer: { '@id': 'https://w3id.org/whg-epns/release/data-2026-09-28' } }), 'https://w3id.org/whg-epns/release/', 'the address\'s folder alone: not the base, which is why isVersionOf comes first');
  assert.equal(baseOf({ gazetteer: { '@id': 'https://w3id.org/whg-epns/release/data-2026-09-28' } }, 'https://w3id.org/whg-epns'), 'https://w3id.org/whg-epns/');
  assert.equal(baseOf({}), null);
  // DEEP's shape: no uriSpace, the release's address as @id, the base in isVersionOf, places at <base>02/000001 (not <base>place/…).
  const deep = (g, places) => ({ profile: 'place-centric', gazetteer: g, spatialEntities: places });
  const E = 'https://example.org/epns/';
  const pl = (k, atts) => ({ '@id': `${E}02/${k}`, label: k, attestations: atts });
  const a = (k, h, name) => ({ '@id': `${E}02/${k}#${h}`, names: [{ toponym: name }], citations: [{ source: src }], created: '2026-01-01T00:00:00Z' });
  const prev = deep({ title: 'D', licence: G.licence, status: 'published', '@id': `${E}release/r1`, version: 'r1', isVersionOf: E }, [pl('000001', [a('000001', 'headword', 'Ashby'), a('000001', 'form-1', 'Asby')]), pl('000002', [a('000002', 'headword', 'Barton')])]);
  const next = deep({ title: 'D', licence: G.licence, status: 'published', '@id': `${E}release/r1`, isVersionOf: E }, [pl('000001', [a('000001', 'headword', 'Ashby')]), pl('000002', [a('000002', 'headword', 'Barton')])]);
  const { r, doc } = await revised(prev, next, { release: 'r2' });
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.deepEqual([r.report.counts.retracted, r.report.counts.kept], [1, 2]);
  assert.deepEqual([doc.gazetteer['@id'], doc.gazetteer.isVersionOf, doc.gazetteer.previousVersion], [`${E}release/r2`, E, `${E}release/r1`]);
  assert.match(doc.spatialEntities[0].attestations.find((x) => x.meta)['@id'], new RegExp(`^${E}02/000001#a-[0-9a-f]{8}$`), 'the retraction addressed under the place, outside <base>place/');
});

test('the pieces: the output\'s name, the header found in the writer\'s text, the summary line, what a meta withdraws', () => {
  assert.equal(outputName('deep-plato.jsonl.gz'), 'deep-plato-revised.json');
  assert.equal(outputName('places'), 'places-revised.json');
  assert.deepEqual(headerOf('{"gazetteer":{"title":"T"},"spatialEntities":['), { head: { gazetteer: { title: 'T' } }, at: 27 });
  assert.deepEqual(headerOf('{"gazetteer":{"title":"spatialEntities\\":[","x":1},"spatialEntities":[{'), { head: { gazetteer: { title: 'spatialEntities":[', x: 1 } }, at: 51 }, 'the key inside a value does not close the header');
  assert.equal(headerOf('{"gazetteer":{"title":"T"}'), null);
  assert.equal(summaryLine({ kept: 2, inherited: 3, superseded: 1, retracted: 2, tombstones: 1, added: 4, placesAdded: 0 }), 'Kept 5 attestations; superseded 1 and retracted 2 (1 place withdrawn whole); 4 added.');
  assert.equal(summaryLine({ kept: 1 }), 'Kept 1 attestation.');
  assert.deepEqual(withdrawalOf({ meta: { targetAttestation: 'x', metaType: 'plato:Retracts' } }), { kind: 'retracted', target: 'x' });
  assert.deepEqual(withdrawalOf({ meta: { targetAttestation: 'x', metaType: SUPERSEDES } }), { kind: 'superseded', target: 'x' });
  assert.equal(withdrawalOf({ meta: { targetAttestation: 'x', metaType: 'plato:Contradicts' } }), null);
  assert.equal(withdrawalOf({}), null);
});

// ---- the review's findings (R1 to R4) -----------------------------------------------------------------------
const CONTRADICTS = { targetAttestation: `${P('a')}#a-11111111`, metaType: PLATO + 'Contradicts' };

test('a changed attestation that carries a relation of its own (meta: Contradicts) keeps it: PLATO\'s meta is one object, so the old form is retracted beside it instead of replaced by it (R1)', async () => {
  const later = v2();
  later.spatialEntities[0].attestations[1] = att('a:22222222', 'Alfa respelt', { meta: CONTRADICTS });
  const { r, doc } = await revised(v1(), later, { release: 'v2' });
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  const a = atts(doc, 'a');
  const mine = a.find((x) => x.names?.[0].toponym === 'Alfa respelt');
  assert.deepEqual(mine.meta, CONTRADICTS, 'the new form says what it said');
  assert.equal(status(doc)['place/a#a-22222222'], 'retracted', 'the old form is withdrawn all the same');
  assert.deepEqual(a.slice(0, 2), v1().spatialEntities[0].attestations, 'the previous release\'s attestations as they were');
  assert.ok(r.report.items.some((i) => i.kind === 'meta-kept'), 'said');
  // The presence beside it: the same change without a meta is superseded, as the table of rules has it.
  const plain = await revised(v1(), v2(), { release: 'v2' });
  assert.equal(status(plain.doc)['place/a#a-22222222'], 'superseded');
  // The tables case: no addresses in the new version, one deleted and one added of a kind would be paired, and the pairing would write Supersedes over the meta.
  const tables = v2();
  tables.spatialEntities[0].attestations = [att('a:11111111', 'Alpha'), att('a:22222222', 'Alfa respelt', { meta: CONTRADICTS })].map(({ '@id': _, ...x }) => x);
  const paired = await revised(v1(), tables, { release: 'v2' });
  assert.equal(paired.r.report.errors, 0, JSON.stringify(paired.r.report.items));
  assert.deepEqual(atts(paired.doc, 'a').find((x) => x.names?.[0].toponym === 'Alfa respelt').meta, CONTRADICTS, 'not paired over');
  assert.equal(status(paired.doc)['place/a#a-22222222'], 'retracted');
  assert.equal(paired.r.report.counts.paired, 0);
  const free = JSON.parse(JSON.stringify(tables)); delete free.spatialEntities[0].attestations[1].meta;
  assert.equal((await revised(v1(), free, { release: 'v2' })).r.report.counts.paired, 1, 'control: without the meta the same two are paired');
});

test('the release name is one an address can hold (Agora\'s rule): "v 2", "2.0/final" and ".hidden" are refused, nothing written; "v2", "2.0" and "r_1~b" pass (R2)', async () => {
  for (const bad of ['v 2', '2.0/final', '.hidden', 'v2?']) {
    const x = await revised(v1(), v2(), { release: bad });
    assert.ok(x.r.incomplete && x.kinds.includes('bad-release'), `${bad}: ${JSON.stringify(x.r.report.items)}`);
    assert.equal(x.text, null, 'nothing written');
    assert.deepEqual(x.item('bad-release').examples, [bad]);
  }
  for (const good of ['v2', '2.0', 'r_1~b']) assert.equal((await revised(v1(), v2(), { release: good })).r.report.errors, 0, good);
});

test('a facet changed is refused when the previous release is a draft too: the revised dataset is written as published, and cannot say again what the kept attestations said (R3)', async () => {
  const shared = { ...v1(), spatialEntities: [place('a', 'A', [{ ...att('a:11111111', 'Alpha'), names: [{ '@id': X + 'name/alpha', toponym: 'Alpha' }] }])] };
  shared.gazetteer = { ...G, status: 'draft' };
  const facet = JSON.parse(JSON.stringify(shared)); facet.spatialEntities[0].attestations[0].names[0].toponym = 'Alpha, respelt'; facet.gazetteer = { ...G, '@id': X, version: undefined, status: 'draft' };
  const f = await revised(shared, facet, { release: 'v2' });
  assert.ok(f.r.incomplete && f.kinds.includes('facet-changed'), JSON.stringify(f.r.report.items));
  assert.equal(f.text, null, 'nothing written');
  // The presence beside it: the same draft, the facet as it was, is revised (and said to be a draft).
  const same = await revised(shared, { ...JSON.parse(JSON.stringify(shared)), gazetteer: { ...G, '@id': X, version: undefined, status: 'draft' } }, { release: 'v2' });
  assert.equal(same.r.report.errors, 0, JSON.stringify(same.r.report.items));
  assert.ok(same.kinds.includes('earlier-not-published'));
});

test('a reviewer named by an address with @ in it is refused, in words that do not repeat it: it would be written into every retraction and the release report (R4)', async () => {
  const email = 'lu.reviewer@example.org';
  assert.throws(() => checkReviewer({ name: email }), (e) => /address with @ in it/.test(e.message) && !e.message.includes(email));
  assert.deepEqual(checkReviewer({ name: 'Lu Reviewer' }), { name: 'Lu Reviewer' }, 'presence beside it');
  const x = await revised(v1(), v2(), { release: 'v2', reviewer: { name: email } });
  assert.ok(x.r.incomplete && x.kinds.includes('bad-reviewer'), JSON.stringify(x.r.report.items));
  assert.equal(x.text, null, 'nothing written');
  assert.ok(!JSON.stringify(x.r.report).includes(email), 'the address is not in the report');
  assert.ok(!JSON.stringify(x.r.report).includes('@example'), 'nor any part of it');
});
