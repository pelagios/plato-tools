// The matched places' locations taken together (src/engine/chora/locate.js): from the review's work file (the
// accepted matches, each candidate's point as the gazetteer answered, and the sources' licences in the lookup's
// attribution), into the dataset the decisions were recorded in. No request is made: nothing here has a fetch.
// The dataset is made by Krisis's own Finish (apply()), so that the identities are as a review writes them.
// Every absence asserted here is beside a presence the same call could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { apply } from '../src/engine/krisis/apply.js';
import { readWork, serialiseWork } from '../src/engine/krisis/work.js';
import { P, W3, WHO, AT, DECIDED, FEATURES, ATTRIBUTION, datasetText, workOf, recorded } from './locate-fixture.js';
import { locate, plan, acceptedMatches, placeFacts, locationAttestations, LOCATED_WORD } from '../src/engine/chora/locate.js';
import { CITES_AS_EVIDENCE } from '../src/engine/chora/adopt.js';
import { locateWords, LOCATE_TEXT } from '../src/engine/words.js';

async function located(options = {}, how = {}) {
  const { table, file } = how.dataset || await recorded();
  const e = env();
  const work = how.work || workOf(table, how);
  const r = await locate({ subjects: await detect([file]), work, options: { reopen: (o) => new File(e.outs[o.name], o.name), created: AT, contributor: WHO, features: FEATURES, ...options } }, e);
  const name = r.outputs[0]?.name;
  return { ...r, e, file, table, before: JSON.parse(await file.text()), doc: name ? JSON.parse(e.outs[name].join('')) : null, name };
}
const place = (doc, slug) => doc.spatialEntities.find((x) => x['@id'] === P + slug);
const geometries = (doc, slug) => (place(doc, slug).attestations || []).filter((a) => a.geometries);
const identities = (doc, slug) => (place(doc, slug).attestations || []).flatMap((a) => (a.identities || []).map((i) => ({ ...i, by: a.contributor?.name ?? null })));
const statuses = (p) => Object.fromEntries(p.places.map((x) => [x.id.slice(P.length), x.status]));

test('what would be done is counted first, every matched place in exactly one count, and nothing is written', async () => {
  const r = await located({ planOnly: true });
  assert.deepEqual(r.outputs, []);
  assert.deepEqual(Object.keys(r.e.outs), [], 'nothing was written');
  assert.deepEqual(r.plan.counts, { matched: 10, use: 3, located: 1, noLocation: 1, unknownLicence: 1, notRedistributable: 1, leftForYou: 2, notRecorded: 1 });
  const c = r.plan.counts;
  assert.equal(c.use + c.located + c.noLocation + c.unknownLicence + c.notRedistributable + c.leftForYou + c.notRecorded, c.matched);
  assert.deepEqual(statuses(r.plan), { gdansk: 'use', oliva: 'use', sopot: 'not-redistributable', hel: 'unknown-licence', danzig: 'no-location', puck: 'several-locations',
    tczew: 'use', gdynia: 'located', wejherowo: 'several-matches', malbork: 'not-recorded' });
  // With the sources whose licence is not stated used too: one more, and none left out for that.
  assert.deepEqual([r.withUnknown.use, r.withUnknown.unknownLicence, r.withUnknown.matched], [4, 0, 10]);
  assert.equal(r.words, 'Use the locations of 3 of 10 matched places; 1 already has a location; 1 has no location on record; 1 left out because its licence is not stated; '
    + '1 left out because its source does not allow copying; 2 left for you to place by hand (1: the record gives more than one location; 1: more than one record was matched, each with a location); 1 skipped because its match is not recorded in this dataset.');
  assert.deepEqual(r.plan.leftWhy, { 'several-locations': 1, 'several-matches': 1 });
  // Each place not used is named in the report, with why.
  const said = r.report.items.flatMap((i) => i.examples.map((x) => `${i.kind}: ${x}`));
  assert.ok(said.includes('locate-several-matches: Wejherowo: more than one record was matched, each with a location'), said.join('\n'));
  assert.ok(said.includes('locate-several-locations: Puck: the record gives more than one location'));
  assert.ok(said.some((x) => x.startsWith('locate-not-redistributable: Sopot')));
});

test('the counts in the words of the confirmation, as the page says them', () => {
  assert.equal(locateWords({ matched: 7, use: 5, noLocation: 1, unknownLicence: 1 }), 'Use the locations of 5 of 7 matched places; 1 has no location on record; 1 left out because its licence is not stated.');
  assert.equal(locateWords({ matched: 1, use: 1 }), 'Use the locations of 1 of 1 matched place.');
  assert.equal(locateWords({ matched: 2, use: 0, unknownLicence: 2 }), 'None of the 2 matched places has a location that can be used; 2 left out because their licence is not stated.');
  assert.equal(locateWords({ matched: 0 }), 'No place was matched in the review, so there is no location to use.');
  // The places left for the person are said with why each is, never under one reason that is not theirs.
  assert.equal(locateWords({ matched: 3, use: 1, leftForYou: 2 }, { 'bad-location': 1, 'no-record': 1 }),
    'Use the locations of 1 of 3 matched places; 2 left for you to place by hand (1: the record\'s location cannot be held as it is; 1: the record matched has no address in the gazetteer).');
  assert.equal(locateWords({ matched: 3, use: 1, leftForYou: 2 }), 'Use the locations of 1 of 3 matched places; 2 left for you to place by hand.');
  // The box: how many ticking it would use, and how many of those left out for the licence it would not.
  assert.equal(LOCATE_TEXT.unknownBox(1, 1), '1 left out because its licence is not stated: use it anyway (recorded)');
  assert.equal(LOCATE_TEXT.unknownBox(6, 7), '6 left out because their licence is not stated: use them anyway (recorded). The other 1 would then have more than one location that may be used, and stays left for you');
  assert.match(LOCATE_TEXT.point, /its representative point\), not the record's full shape\.$/);
  assert.equal(LOCATE_TEXT.who('Ada Surveyor', false), 'They will be recorded in the name of Ada Surveyor.');
  assert.match(LOCATE_TEXT.who('Ada Surveyor', true), /Ada Surveyor, the reviewer named in the review \(no name is held on this page\)\.$/);
  assert.match(LOCATE_TEXT.who(null, false), /^No name is held yet/);
  assert.equal(LOCATE_TEXT.go(5), 'Use the locations of 5 places');
  assert.equal(LOCATE_TEXT.unknownLabel(1), 'Use it anyway (recorded)');
});

test('the locations are written into the dataset: one geometry for each place used, citing the record and its source\'s licence, and nothing else changes', async () => {
  const r = await located();
  assert.equal(r.report.errors, 0, JSON.stringify(r.report.items));
  assert.equal(r.name, `bay.krisis-dataset.${LOCATED_WORD}.json`);
  assert.deepEqual(r.batch.used, [P + 'gdansk', P + 'oliva', P + 'tczew']);
  assert.deepEqual({ id: r.batch.id, by: r.batch.contributor, allowUnknown: r.batch.allowUnknown, unknown: r.batch.unknown }, { id: AT, by: WHO, allowUnknown: false, unknown: 0 });
  assert.equal(r.report.counts.attestationsAdded, 3);
  // Every place as it was, with at most one attestation after its own: a location, for the three used.
  assert.equal(r.doc.spatialEntities.length, r.before.spatialEntities.length);
  for (const was of r.before.spatialEntities) {
    const now = r.doc.spatialEntities.find((x) => x['@id'] === was['@id']), slug = was['@id'].slice(P.length);
    const added = now.attestations.slice(was.attestations.length);
    assert.deepEqual(now.attestations.slice(0, was.attestations.length), was.attestations, `${slug}: its own attestations as they were`);
    assert.equal(added.length, ['gdansk', 'oliva', 'tczew'].includes(slug) ? 1 : 0, slug);
    for (const a of added) assert.deepEqual(Object.keys(a).sort(), ['citations', 'contributor', 'created', 'geometries', 'notes'], `${slug}: a location and nothing else (no identity)`);
  }
  const [g] = geometries(r.doc, 'gdansk');
  assert.deepEqual(g.geometries, [{ geojson: { type: 'Point', coordinates: [18.6466384, 54.3520252] }, reprPoint: [18.6466384, 54.3520252], role: g.geometries[0].role }]);
  assert.match(g.geometries[0].role, /RepresentativePoint$/);
  assert.deepEqual(g.contributor, WHO);
  assert.equal(g.created, AT);
  assert.deepEqual(g.citations, [{ source: { ...g.citations[0].source, title: 'World Historical Gazetteer', licence: 'https://spdx.org/licenses/CC-BY-4.0' }, locator: W3 + 'place:gn:1', citationFunction: CITES_AS_EVIDENCE }]);
  assert.equal(g.notes, `World Historical Gazetteer's representative point for record ${W3}place:gn:1 ("Gdańsk"; upstream source: GeoNames (gn); id 1; licence CC-BY-4.0; World Historical Gazetteer's own licence: CC-BY-4.0) `
    + `(one point standing for the place, not the record's full shape), copied from its answer to the lookup, of 2026-11-16; coordinates rounded to 7 decimal places; in PLATO tools, with the locations of the other matched places (batch ${AT}). `
    + 'The review had recorded this record as a match (exactMatch); only the location is added here, and how the two are matched is not changed.');
  // Tczew's record was read by the caller: of its area and its one point, the point, and the note says it is the record's own.
  const [t] = geometries(r.doc, 'tczew');
  assert.deepEqual(t.geometries[0].geojson, { type: 'Point', coordinates: [18.7775001, 54.0924] });
  assert.match(t.notes, /^Copied from World Historical Gazetteer record .*place:gn:8/);
  // The check that nothing else changed counted exactly the three added (it could have counted more, or a change).
  assert.equal(r.report.counts.use, 3);
});

test('a close match stays a close match: no identity is written, changed or upgraded for any place', async () => {
  const r = await located();
  const all = (doc) => doc.spatialEntities.flatMap((e) => (e.attestations || []).flatMap((a) => a.identities || []));
  // The presence: Oliva was given its location in this run, and Gdańsk's exact match is there to be found.
  assert.equal(geometries(r.doc, 'oliva').length, 1);
  assert.deepEqual(identities(r.doc, 'gdansk'), [{ subject: P + 'gdansk', object: W3 + 'place:gn:1', identityType: 'exactMatch', by: 'Ada Surveyor' }]);
  assert.deepEqual(identities(r.doc, 'oliva').map((i) => [i.object, i.identityType]), [[W3 + 'place:gn:2', 'closeMatch']]);
  assert.deepEqual(all(r.doc), all(r.before), 'the identities of the whole dataset, as they were');
  assert.equal(all(r.doc).filter((i) => i.identityType === 'exactMatch' && i.subject === P + 'oliva').length, 0);
});

test('a source that may not be passed on, one with no licence stated, a record with no location, and a place with a location already are each left as they were', async () => {
  const r = await located();
  // The presence: the same run located Gdańsk.
  assert.equal(geometries(r.doc, 'gdansk').length, 1);
  for (const slug of ['sopot', 'hel', 'danzig', 'puck', 'wejherowo', 'malbork', 'elblag']) assert.equal(geometries(r.doc, slug).length, 0, slug);
  assert.deepEqual(geometries(r.doc, 'gdynia'), geometries(r.before, 'gdynia'), 'the location it had, and no other');
  assert.equal(geometries(r.doc, 'gdynia').length, 1);
});

test('only the review\'s own accepted matches count: a match the table gave is not one, with or without a later decision the dataset does not record', async () => {
  const r = await located();
  // Elbląg has a match in the dataset (the table's, with no contributor) and no decision: it is not among the matched places at all.
  assert.deepEqual(identities(r.before, 'elblag'), [{ subject: P + 'elblag', object: W3 + 'place:gn:12', identityType: 'closeMatch', basis: 'given by the table', by: null }]);
  assert.equal(r.plan.places.some((x) => x.id === P + 'elblag'), false);
  assert.equal(r.plan.places.some((x) => x.id === P + 'gdansk'), true);
  // Malbork: accepted in the review after the decisions were recorded, so the dataset holds only the table's match to that record: skipped, and said.
  assert.deepEqual(identities(r.before, 'malbork').map((i) => [i.object, i.by]), [[W3 + 'place:gn:9', null]]);
  assert.equal(statuses(r.plan).malbork, 'not-recorded');
  // The same place, once the dataset records the review's decision on it (a Finish with it accepted), is used.
  const table = textFile(datasetText(), 'bay.json'), e = env();
  const a = await apply({ subjects: await detect([table]), work: workOf(table), options: { reviewer: WHO, date: DECIDED } }, e);
  const again = await located({}, { dataset: { table, file: new File(e.outs[a.outputs[0].name], a.outputs[0].name) } });
  assert.equal(statuses(again.plan).malbork, 'use');
  assert.equal(geometries(again.doc, 'malbork').length, 1);
});

test('a source with no licence stated is used only when that is chosen for the batch, and the choice is written into the note of that location, with the name', async () => {
  const no = await located();
  assert.equal(geometries(no.doc, 'hel').length, 0);
  assert.equal(geometries(no.doc, 'gdansk').length, 1);
  const yes = await located({ allowUnknown: true });
  assert.deepEqual(yes.batch.used, [P + 'gdansk', P + 'oliva', P + 'hel', P + 'tczew']);
  assert.deepEqual([yes.batch.allowUnknown, yes.batch.unknown], [true, 1]);
  const [h] = geometries(yes.doc, 'hel');
  assert.match(h.notes, /licence not stated;/);
  assert.match(h.notes, / The gazetteer does not state a licence for this record's source: Ada Surveyor chose to use it all the same, for this batch\.$/);
  assert.equal(h.citations[0].source.licence, undefined, 'no licence is claimed for it');
  assert.equal(h.citations[0].locator, W3 + 'place:wd:4');
  // A place whose source says its licence carries no such note, in the same batch.
  const [g] = geometries(yes.doc, 'gdansk');
  assert.doesNotMatch(g.notes, /chose to use it/);
  assert.equal(g.citations[0].source.licence, 'https://spdx.org/licenses/CC-BY-4.0');
  // Chosen or not, a source that may not be passed on is never used.
  assert.equal(geometries(yes.doc, 'sopot').length, 0);
  assert.equal(statuses(yes.plan).sopot, 'not-redistributable');
});

test('without the review\'s licences every source reads as not stated: nothing is used by default, and the dataset is handed on as it was', async () => {
  const r = await located({ features: null }, { attribution: null });
  assert.deepEqual(r.outputs, []);
  assert.deepEqual(Object.keys(r.e.outs), []);
  // The presence: the places were matched and have points; they are counted as left out for the licence, not lost:
  // all seven with a point and no location yet, Sopot among them (that its source may not be passed on is in the licences too).
  assert.deepEqual([r.plan.counts.matched, r.plan.counts.use, r.plan.counts.unknownLicence, r.plan.counts.notRedistributable], [10, 0, 7, 0]);
  assert.equal(statuses(r.plan).sopot, 'unknown-licence');
  assert.ok(r.report.items.some((i) => i.kind === 'locate-nothing' && i.message === LOCATE_TEXT.nothing));
  assert.equal(r.report.errors, 0);
});

test('with no record read, the point the gazetteer answered with is the location: no request is made, and none could be', async () => {
  const fetched = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (...a) => { fetched.push(a); throw new Error('no request may be made'); };
  try {
    const r = await located({ features: null });
    // Puck, whose record (when read) has two areas, is located by its answered point here; Tczew by its answered point too.
    assert.equal(statuses(r.plan).puck, 'use');
    assert.deepEqual(geometries(r.doc, 'puck')[0].geometries[0].geojson, { type: 'Point', coordinates: [18.4, 54.72] });
    assert.deepEqual(geometries(r.doc, 'tczew')[0].geometries[0].geojson, { type: 'Point', coordinates: [18.79, 54.09] });
    assert.match(geometries(r.doc, 'tczew')[0].notes, /^World Historical Gazetteer's representative point for record/);
    assert.equal(r.plan.counts.use, 4);
    assert.deepEqual(fetched, []);
  } finally { globalThis.fetch = real; }
});

test('each location is recorded in a name: with none given and none in the review, nothing is written, in words', async () => {
  const r = await located({ contributor: undefined }, { reviewer: null });
  assert.deepEqual(r.outputs, []);
  assert.equal(r.incomplete, true);
  assert.deepEqual(r.report.items.filter((i) => i.severity === 'error').map((i) => [i.kind, i.message]), [['locate-no-name', LOCATE_TEXT['no-name']]]);
  // The review's own reviewer is taken when none is given (the presence: the same call, with one, writes).
  const ok = await located({ contributor: undefined });
  assert.equal(ok.report.errors, 0);
  assert.deepEqual(geometries(ok.doc, 'gdansk')[0].contributor, WHO);
  // An address with @ in it is never written as a name.
  const bad = await located({ contributor: { name: 'ada@example.org' } });
  assert.deepEqual(bad.outputs, []);
  assert.deepEqual(bad.report.items.filter((i) => i.severity === 'error').map((i) => i.kind), ['locate-bad-name']);
  assert.doesNotMatch(JSON.stringify(bad.report), /ada@example\.org/);
});

test('the parts, pure: the matches a review accepted, a plan from the dataset\'s facts, and the attestations of a plan', async () => {
  const { table, file } = await recorded();
  const work = readWork(serialiseWork(workOf(table)));
  const matched = acceptedMatches(work);
  assert.equal(matched.size, 10);
  assert.equal(matched.get(P + 'wejherowo').length, 2);
  // A rejected candidate, one of another service, and a place the reviewer leaves out are not accepted matches.
  const other = JSON.parse(JSON.stringify(work));
  other.candidates.find((c) => c.id === 'l1-1').decision = { kind: 'not-this', decided_at: DECIDED }; other.candidates.find((c) => c.id === 'l1-1').candidate_status = 'rejected';
  other.candidates.find((c) => c.id === 'l1-2').gazetteer.service = 'https://www.wikidata.org/w/api.php';
  other.places[P + 'sopot'].rowState = 'exclude';
  assert.deepEqual([...acceptedMatches(other).keys()].map((k) => k.slice(P.length)), ['hel', 'danzig', 'puck', 'tczew', 'gdynia', 'wejherowo', 'malbork']);
  const read = await placeFacts(await detect([file]), new Set(matched.keys()), env());
  assert.equal(read.incomplete, false);
  assert.deepEqual([read.facts.get(P + 'gdynia').located, read.facts.get(P + 'gdansk').located], [true, false]);
  assert.deepEqual([...read.facts.get(P + 'gdansk').reviewed], [W3 + 'place:gn:1']);
  assert.deepEqual([...read.facts.get(P + 'malbork').reviewed], [], 'the table\'s match is not a review\'s');
  const p = plan({ work, facts: read.facts });
  // A place the dataset does not have (the review is of another file) is counted as skipped, never invented.
  const fewer = new Map(read.facts); fewer.delete(P + 'gdansk');
  assert.equal(plan({ work, facts: fewer }).places.find((x) => x.id === P + 'gdansk').status, 'not-in-dataset');
  assert.equal(p.places.find((x) => x.id === P + 'gdansk').status, 'use');
  const made = locationAttestations(p, { contributor: WHO, created: AT, batch: 'b' });
  assert.deepEqual(made.map((m) => m.placeId.slice(P.length)), ['gdansk', 'oliva', 'puck', 'tczew']);
  assert.ok(made.every((m) => m.attestation.identities === undefined && m.attestation.geometries.length === 1));
  // A match recorded as related is not the same place: left for the person, while the same record as a close match is used.
  const rel = JSON.parse(JSON.stringify(work));
  rel.candidates.find((c) => c.id === 'l1-2').decision.identityType = 'related';
  assert.deepEqual([plan({ work: rel, facts: read.facts }).places.find((x) => x.id === P + 'oliva').status, p.places.find((x) => x.id === P + 'oliva').status], ['related', 'use']);
});

// ---- what "a licence stated" means, several records for one place, and whose name an opt-in carries ----------------------
const sources = (gn) => ({ ...ATTRIBUTION, sources: { ...ATTRIBUTION.sources, gn } });
/** The review, with one candidate's source changed (its namespace: where its licence is looked for). */
function workWith(table, id, namespace, more = {}) {
  const w = workOf(table, { late: false, ...more });
  w.candidates.find((c) => c.id === id).gazetteer.namespace = namespace;
  return w;
}

test('a licence is stated only when it is one the tools recognise: "All rights reserved", "unknown" and other words are not, and nothing is copied under them unasked', async () => {
  for (const words of ['All rights reserved', 'unknown', 'see the website', 'CC-BY-9.9']) {
    // GeoNames' licence given as those words, as a string and as the service's object, and nothing said about passing on.
    for (const license of [words, { spdx_id: words, permits_commercial: null, no_derivatives: null }]) {
      const r = await located({ features: null }, { attribution: sources({ name: 'GeoNames', license }) });
      assert.deepEqual([statuses(r.plan).gdansk, statuses(r.plan).oliva, r.plan.counts.use], ['unknown-licence', 'unknown-licence', 0], JSON.stringify(license));
      assert.deepEqual(r.outputs, [], 'nothing is written');
      // The presence: the same places, the same points, counted as left out for the licence (Gdańsk, Oliva, Puck, Tczew, Hel, and Wejherowo's two).
      assert.equal(r.plan.counts.unknownLicence, 6);
    }
  }
  // Ticked, such a source is used as one with no licence stated: no licence is claimed for it, in the citation or the note.
  const yes = await located({ features: null, allowUnknown: true }, { attribution: sources({ name: 'GeoNames', license: 'All rights reserved' }) });
  const [g] = geometries(yes.doc, 'gdansk');
  assert.equal(g.citations[0].source.licence, undefined);
  assert.equal(g.citations[0].locator, W3 + 'place:gn:1');
  assert.match(g.notes, /licence not stated;/);
  assert.match(g.notes, /Ada Surveyor chose to use it all the same, for this batch\.$/);
  assert.doesNotMatch(JSON.stringify(g), /spdx\.org/);
  // A licence the tools do recognise, however it is cased, is one: used unasked, and written as its SPDX address.
  const ok = await located({ features: null }, { attribution: sources({ name: 'GeoNames', license: 'cc-by-sa-4.0' }) });
  assert.equal(statuses(ok.plan).gdansk, 'use');
  assert.equal(geometries(ok.doc, 'gdansk')[0].citations[0].source.licence, 'https://spdx.org/licenses/CC-BY-SA-4.0');
});

test('a place matched to two records: the licensed one is used only when it is the only one that may be, and the note names the other; two that may be used are never chosen between', async () => {
  const data = await recorded();
  // Wejherowo's second record from a source with no licence stated. Unticked, only the first may be used: used, and said.
  const mixed = () => workWith(data.table, 'l1-11', 'wd');
  const no = await located({ features: null }, { dataset: data, work: mixed() });
  const w = no.plan.places.find((x) => x.id === P + 'wejherowo');
  assert.deepEqual([w.status, w.record, w.passedOver], ['use', W3 + 'place:gn:10', [{ record: W3 + 'place:gn:11', why: 'unknown-licence' }]]);
  const [g] = geometries(no.doc, 'wejherowo');
  assert.deepEqual([g.geometries[0].geojson.coordinates, g.citations[0].locator], [[18.23, 54.6], W3 + 'place:gn:10']);
  assert.match(g.notes, new RegExp(` The place was matched to 2 records; this is the only one whose location may be used \\(not used: ${W3}place:gn:11, no licence is stated for its source\\)\\.`));
  // A place matched to one record says nothing of the kind (the absence, beside the presence above, in one file).
  assert.doesNotMatch(geometries(no.doc, 'gdansk')[0].notes, /was matched to/);
  // Ticked, both may be used, and they differ: nothing chooses. The place is left for the person and counted, and is not located.
  const yes = await located({ features: null, allowUnknown: true }, { dataset: data, work: mixed() });
  assert.equal(statuses(yes.plan).wejherowo, 'several-matches');
  assert.equal(geometries(yes.doc, 'wejherowo').length, 0);
  assert.equal(geometries(yes.doc, 'hel').length, 1, 'the same press did use a source with no licence stated');
  assert.deepEqual([no.plan.counts.leftForYou, yes.plan.counts.leftForYou], [0, 1]);
  // What the box may promise: unticked, the plan says how many ticking would use (Hel alone), not every place left out or matched so.
  // Unticked, five are used (Gdańsk, Oliva, Puck, Tczew, Wejherowo); ticking takes Wejherowo out and brings Hel in: five again.
  assert.deepEqual([no.plan.unknownUsed, no.withUnknownPlan.unknownUsed, no.plan.counts.unknownLicence, no.plan.counts.use, no.withUnknown.use], [0, 1, 1, 5, 5]);
  assert.deepEqual([no.batch.used.includes(P + 'wejherowo'), yes.batch.used.includes(P + 'wejherowo'), yes.batch.used.includes(P + 'hel')], [true, false, true]);
  // The other record from a source that may not be passed on: the same, with its own reason; and never used, ticked or not.
  for (const allowUnknown of [false, true]) {
    const r = await located({ features: null, allowUnknown }, { dataset: data, work: workWith(data.table, 'l1-11', 'tgn') });
    assert.equal(statuses(r.plan).wejherowo, 'use');
    assert.match(geometries(r.doc, 'wejherowo')[0].notes, /not used: \S+place:gn:11, its source does not allow copying\)/);
    assert.equal(geometries(r.doc, 'wejherowo')[0].citations[0].locator, W3 + 'place:gn:10');
  }
  // Both licensed, each with a point: never chosen between (as the fixture is).
  const both = await located({ features: null }, { dataset: data });
  assert.equal(statuses(both.plan).wejherowo, 'several-matches');
  assert.equal(geometries(both.doc, 'wejherowo').length, 0);
});

test('the choice to use a source with no licence stated is recorded in the name given with it: never the review\'s own reviewer, and with no name nothing is written', async () => {
  // The review names its reviewer; no name is given with the press. Unticked, the review's reviewer is taken (the presence).
  const plain = await located({ contributor: undefined });
  assert.deepEqual(geometries(plain.doc, 'gdansk')[0].contributor, WHO);
  // Ticked, that name is not taken for the choice: nothing is written, and it is said why.
  const r = await located({ contributor: undefined, allowUnknown: true });
  assert.deepEqual(r.outputs, []);
  assert.deepEqual(Object.keys(r.e.outs), []);
  assert.deepEqual(r.report.items.filter((i) => i.severity === 'error').map((i) => [i.kind, i.message]), [['locate-no-name-for-choice', LOCATE_TEXT['no-name-for-choice']]]);
  // With the name given at the press, it is that name the choice and every location carry, not the review's.
  const named = await located({ contributor: { name: 'Bea Mapper' }, allowUnknown: true });
  assert.match(geometries(named.doc, 'hel')[0].notes, /Bea Mapper chose to use it all the same, for this batch\.$/);
  assert.deepEqual(geometries(named.doc, 'hel')[0].contributor, { name: 'Bea Mapper' });
  assert.doesNotMatch(geometries(named.doc, 'hel')[0].notes, /Ada Surveyor/);
  assert.equal(named.batch.contributor.name, 'Bea Mapper');
});

test('each location says what it is: the gazetteer\'s one point for the record, not its full shape', async () => {
  const r = await located({ features: null });
  for (const slug of ['gdansk', 'oliva', 'puck', 'tczew']) {
    const [g] = geometries(r.doc, slug);
    assert.equal(g.geometries[0].geojson.type, 'Point');
    assert.match(g.notes, /^World Historical Gazetteer's representative point for record .* \(one point standing for the place, not the record's full shape\), copied from its answer to the lookup/);
  }
  // Only a record a caller read itself is said to be copied from the record (no page does: nothing is fetched).
  const read = await located();
  assert.match(geometries(read.doc, 'tczew')[0].notes, /^Copied from World Historical Gazetteer record/);
  assert.doesNotMatch(geometries(read.doc, 'tczew')[0].notes, /representative point/);
});
