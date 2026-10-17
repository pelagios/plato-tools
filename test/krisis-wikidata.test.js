// Krisis: Wikidata items for the places no gazetteer knows (src/engine/krisis/wikidata.js, Issue #36): which
// places qualify, what the batch says of each (its text asserted line by line), the licence gate, the work
// file's mint section, the Q-ids back (pasted or read), each checked before it is recorded, and the record
// written by Finish as a pure addition. Nothing here goes on the network: the dataset is a fixture read by the
// real pipeline, and Wikidata's answers are JSON of the shape its API gives. Each absence has its presence beside
// it: a place left out for one reason is shown ready once that reason is taken away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, textFile } from './engine.js';
import { detect } from '../src/engine/input.js';
import { run } from '../src/engine/pipeline.js';
import { readWork, serialiseWork, decide } from '../src/engine/krisis/work.js';
import { apply } from '../src/engine/krisis/apply.js';
import { gather } from '../src/engine/krisis/match.js';
import {
  qualifying, planItems, quickStatementsV1, mintCollector, mintGate, consentRecord, consentFits, classOf, countryOf, codeOfCountry, countryWords, decimalsFor, describe, tidyDescription,
  readPastedQids, verifyItem, matchItems, pairPasted, recordMinted, unrecordMinted, recordBatch, mintOf, entityCandidate, regionItem, searchState, batchName, qsDate, wdLangOf,
  CONSENT, CLASSES, MAX_ITEMS, VERIFY_KM, WIKIDATA_SERVICE, ENTITY, ALGORITHM, STATEMENTS, wdLang,
} from '../src/engine/krisis/wikidata.js';

const X = 'https://w3id.org/mint-test/';
const P = (id) => `${X}place/${id}`;
const WD = 'http://www.wikidata.org/entity/';
const AT = '2026-10-15T12:00:00Z';
const REVIEWER = { name: 'Lu Reviewer', orcid: 'https://orcid.org/0000-0002-1825-0097' };
const src = { '@id': `${X}source/survey`, title: 'The 1296 survey', authorityType: 'source' };
const ncSrc = { '@id': 'https://maps.example/nc', title: 'A map for non-commercial use', authorityType: 'dataset', licence: 'https://creativecommons.org/licenses/by-nc/4.0/' };
const att = (o) => ({ contributor: { name: 'A. Editor' }, created: AT, ...o });

/** The fixture dataset: a place-centric document under a CC BY licence, as the plan reads it. */
function dataset({ licence = 'https://creativecommons.org/licenses/by/4.0/', status = 'draft' } = {}) {
  return {
    profile: 'place-centric',
    gazetteer: { '@id': X, uriSpace: X, title: 'Lost places of the Trent', licence, status, creator: [{ name: 'A. Editor' }] },
    spatialEntities: [
      // Newstead: two names (tagged), a point with a precision, dates, a parish kind, a source cited: the whole item.
      { '@id': P('newstead'), label: 'Newstead', ccodes: ['GB'], attestations: [
        att({ names: [{ toponym: 'Newstead', language: 'en' }, { toponym: 'Novum Locum', language: 'la' }, { toponym: 'Newsted', language: 'en' }], timespans: [{ startEarliest: '1296', endLatest: '1540' }],
          types: [{ identifier: 'http://vocab.getty.edu/aat/300008372', label: 'village' }], geometries: [{ geojson: { type: 'Point', coordinates: [-1.19345678, 53.08123456] }, precisionKm: 1 }], citations: [{ source: src }] }),
      ] },
      // Atlantis: no point, in no region: left out as such.
      { '@id': P('atlantis'), label: 'Atlantis', attestations: [att({ names: [{ toponym: 'Atlantis', language: 'en' }], types: [{ label: 'city' }], citations: [{ source: src }] })] },
      // Cliffe: its only point is copied from a map for non-commercial use (not free for CC0), its name is free.
      { '@id': P('cliffe'), label: 'Cliffe', ccodes: ['GB'], attestations: [
        att({ names: [{ toponym: 'Cliffe', language: 'en' }], types: [{ label: 'hamlet' }], citations: [{ source: src }] }),
        att({ geometries: [{ geojson: { type: 'Point', coordinates: [-0.9, 53.2] } }], citations: [{ source: ncSrc, citationFunction: 'http://purl.org/spar/cito/citesAsEvidence' }] }),
      ] },
      // Linby: already linked to GeoNames by the dataset: a gazetteer knows it.
      { '@id': P('linby'), label: 'Linby', ccodes: ['GB'], attestations: [att({ names: [{ toponym: 'Linby', language: 'en' }], geometries: [{ geojson: { type: 'Point', coordinates: [-1.2, 53.05] } }], citations: [{ source: src }],
        identities: [{ subject: P('linby'), object: 'https://sws.geonames.org/2644510/', identityType: 'exactMatch' }] })] },
      // Papplewick: nothing cites a source.
      { '@id': P('papplewick'), label: 'Papplewick', ccodes: ['GB'], attestations: [att({ names: [{ toponym: 'Papplewick', language: 'en' }], geometries: [{ geojson: { type: 'Point', coordinates: [-1.18, 53.03] } }] })] },
      // Blidworth: a village (a kind), matched in the review to a WHG record: not minted.
      { '@id': P('blidworth'), label: 'Blidworth', ccodes: ['GB'], attestations: [att({ names: [{ toponym: 'Blidworth', language: 'en' }], types: [{ label: 'village' }], geometries: [{ geojson: { type: 'Point', coordinates: [-1.1, 53.1] } }], citations: [{ source: src }] })] },
      // Kirkby: no kind at all, a name with no language tag.
      { '@id': P('kirkby'), label: 'Kirkby', ccodes: ['GB'], attestations: [att({ names: [{ toponym: 'Kirkby' }], geometries: [{ geojson: { type: 'Point', coordinates: [-1.25, 53.1] } }], citations: [{ source: src }] })] },
    ],
  };
}
const FILE = (d = dataset()) => textFile(JSON.stringify(d), 'trent.json');

/** The work file after a WHG lookup and a Wikidata search, with the decisions made: as the page would leave it. */
function workAfterReview(places) {
  const place = (p) => ({ label: p.label, names: p.names, point: p.point, ...(p.ccodes ? { ccodes: p.ccodes } : {}), ...(p.types ? { types: p.types } : {}), ...(p.typeIds ? { typeIds: p.typeIds } : {}) });
  const w = { krisis: 3, generated_at: AT, algorithm_version: 'krisis-lookup 1', match_parameters: {}, subjects: { title: 'Lost places of the Trent', uri: X, files: [] }, others: null,
    places: Object.fromEntries(places.map((p) => [p.iri, place(p)])), regions: {}, candidates: [], reviewer: REVIEWER, cursor: 0, lookups: [] };
  const q = (iris, state = 'answered') => Object.fromEntries(iris.map((iri) => [iri, { state, sent: [w.places[iri].label], found: 0, added: 0 }]));
  const all = places.map((p) => p.iri);
  w.lookups.push({ id: 'l1', service: { endpoint: 'https://whgazetteer.org/reconcile/', title: 'World Historical Gazetteer', uri: 'https://whgazetteer.org/' }, started_at: AT, finished_at: AT, algorithm_version: 'krisis-lookup 1', parameters: {}, attribution: null, counts: {}, stopped: null, queries: q(all) });
  w.lookups.push({ id: 'l2', service: { ...WIKIDATA_SERVICE }, started_at: AT, finished_at: AT, algorithm_version: ALGORITHM, parameters: { nearKm: 5 }, attribution: null, counts: {}, stopped: null, queries: q(all) });
  // Blidworth matched to a WHG record; Newstead's one Wikidata hit judged not this one; Kirkby's hit still undecided.
  const cand = (id, iri, target, lookup, decision) => ({ id, candidate_source: iri, candidate_candidate: target, similarity_score: 0.9, distance_km: 2, candidate_status: 'suggested', lookup, generated_at: AT, algorithm_version: 'krisis-lookup 1',
    other: { label: 'X', names: ['X'], point: null, source: { title: 'T' } }, gazetteer: { service: 'x', id: 'y', score: null, confidence: null, match: false, answer_rank: 1, description: null, namespace: null, query: null }, decision: null });
  w.candidates.push(cand('l1-1', P('blidworth'), 'https://w3id.org/whg/id/place:gn:2655603', 'l1'), cand('l2-1', P('newstead'), `${WD}Q999`, 'l2'), cand('l2-2', P('kirkby'), `${WD}Q998`, 'l2'));
  decide(w, 'l1-1', 'match', { at: AT }); decide(w, 'l2-1', 'not-this', { at: AT });
  return readWork(serialiseWork(w));
}

/** The dataset read as the plan reads it: gather()'s places (with their links and names' tags) and the collector's records. */
async function read(d = dataset()) {
  const e = env();
  const subjects = await detect([FILE(d)]);
  const g = await gather({ subjects }, e);
  const c = mintCollector(null);
  const r = await run({ input: subjects, action: 'check', options: { sink: c.sink } }, env());
  assert.ok(!r.incomplete, 'the fixture reads');
  return { places: g.places, records: c.result(), subjects };
}

test('the kinds of place as Wikidata classes: the dataset\'s own class as it is, an AAT concept, a word, a settlement of no listed kind, the user\'s choice, or none', () => {
  assert.deepEqual(classOf({ typeIds: ['http://www.wikidata.org/entity/Q532'] }), { qid: 'Q532', word: 'village', how: 'dataset-class' });
  assert.deepEqual(classOf({ typeIds: ['https://www.wikidata.org/wiki/Q7777777'], types: ['moated site'] }), { qid: 'Q7777777', word: null, how: 'dataset-class' });
  assert.deepEqual(classOf({ typeIds: ['http://vocab.getty.edu/aat/300008372'] }), { qid: 'Q532', word: 'village', how: 'kind' });
  assert.deepEqual(classOf({ types: ['Parishes'] }), { qid: 'Q102496', word: 'parish', how: 'kind' });
  assert.deepEqual(classOf({ types: ['deserted-settlement'] }), { qid: 'Q22674925', word: 'former populated place', how: 'kind' }, 'Wikidata\'s own label for the class');
  assert.deepEqual(classOf({ types: ['suburb'] }), { qid: 'Q486972', word: 'human settlement', how: 'facet' }, 'a settlement facet with no class of its own');
  assert.equal(classOf({ types: ['moated site'] }), null, 'nothing known');
  assert.deepEqual(classOf({ types: ['moated site'] }, 'Q5084'), { qid: 'Q5084', word: 'hamlet', how: 'chosen' });
  assert.equal(classOf({ types: ['moated site'] }, 'Q1'), null, 'a choice must be one of the classes offered');
  assert.ok(CLASSES.every((c) => /^Q\d+$/.test(c.qid) && c.word), 'every class has a Q-id and a word');
});

test('countries by ISO code, both ways; language codes; decimals by precision; the description', () => {
  assert.deepEqual(countryOf('gb'), { qid: 'Q145', name: 'United Kingdom' });
  assert.equal(countryOf('ZZ'), null);
  assert.equal(codeOfCountry('Q145'), 'GB');
  assert.equal(codeOfCountry('Q1'), null);
  // A region is dropped; a script Wikidata has a code for is kept (sr-latn); a transliteration's tag (grc-Latn, la-Latn too: Latin has no such variant) names no slot.
  assert.deepEqual(['en', 'en-GB', 'la-Latn', 'grc', 'grc-Latn', 'sr-Latn', 'zh-Hant', 'und', 'mul', 'zxx', '', null].map(wdLang), ['en', 'en', null, 'grc', null, 'sr-latn', 'zh-hant', null, null, null, null, null]);
  assert.deepEqual([wdLangOf('grc-Latn'), wdLangOf('', 'la'), wdLangOf(null, null), wdLangOf('cy-GB', 'en')], ['unsupported', 'la', null, 'cy']);
  // The article before a country, as Wikidata's descriptions write it: a small table, and "The Bahamas" lowered.
  assert.deepEqual(['GB', 'fr', 'BS', 'NL', 'US', 'ZZ'].map(countryWords), ['the United Kingdom', 'France', 'the Bahamas', 'the Kingdom of the Netherlands', 'the United States', null]);
  assert.deepEqual([undefined, 0, 0.05, 1, 10, 1000].map(decimalsFor), [6, 6, 4, 3, 2, 0]);
  assert.equal(describe({ kindWord: 'former populated place', region: 'Nottinghamshire', country: 'the United Kingdom', years: [1296, 1540] }), 'former populated place in Nottinghamshire, the United Kingdom, attested 1296–1540');
  assert.equal(describe({ kindWord: 'village', years: [1296, 1296] }), 'village, attested 1296');
  assert.equal(describe({ kindWord: null }), 'place');
  assert.equal(tidyDescription('  Village in  Kent. '), 'village in Kent');
  assert.equal(tidyDescription('UK village'), 'UK village', 'a capital that is an initialism is kept');
});

test('which places qualify: each reason to leave one out, and the same place ready once the reason is gone', async () => {
  const { places, records } = await read();
  const w = workAfterReview(places);
  const r = qualifying(w, places, { records: records.records, base: X });
  // Cliffe has the dataset's representative point (from its non-free attestation) and a source: it qualifies here; the plan, which reads the licences, leaves its point out.
  assert.deepEqual(r.ready, [P('newstead'), P('cliffe')]);
  assert.deepEqual(r.leftOut.matched, [P('blidworth')]);
  assert.deepEqual(r.leftOut.linked, [P('linby')]);
  assert.deepEqual(r.leftOut.undecided, [P('kirkby')]);
  assert.deepEqual(r.leftOut.noPoint, [P('atlantis')]);
  assert.deepEqual(r.leftOut.noSource, [P('papplewick')]);
  assert.equal(r.whgNotSearched, 0);
  // Taking each reason away: Kirkby's hit decided; Blidworth's match undone; Atlantis given a region matched to a Wikidata item.
  decide(w, 'l2-2', 'distinct', { basis: 'Another Kirkby', at: AT });
  decide(w, 'l1-1', 'not-this', { at: AT });   // undone to null it would be undecided, which is a reason of its own
  w.regions = { [`${X}place/region-notts`]: { label: 'Nottinghamshire', names: ['Nottinghamshire'], level: 1, container: 'c', within: null, count: 1, outcome: 'matched' } };
  w.places[P('atlantis')].within = `${X}place/region-notts`; w.places[P('atlantis')].level = 1;
  w.candidates.push({ id: 'l1-9', candidate_source: `${X}place/region-notts`, candidate_candidate: 'https://w3id.org/whg/id/place:wd:Q21', similarity_score: 1, distance_km: null, candidate_status: 'confirmed', lookup: 'l1',
    other: { label: 'Nottinghamshire', names: ['Nottinghamshire'], point: null, source: { title: 'WHG' } }, gazetteer: { service: 'x', id: 'place:wd:Q21', score: null, confidence: null, match: true, answer_rank: 1, description: null, namespace: 'wd', query: null },
    decision: { kind: 'match', identityType: 'exactMatch', decided_at: AT } });
  const again = qualifying(readWork(serialiseWork(w)), places, { records: records.records, base: X });
  assert.deepEqual(again.ready.sort(), [P('atlantis'), P('blidworth'), P('cliffe'), P('kirkby'), P('newstead')].sort());
  assert.deepEqual(regionItem(w, P('atlantis')), { key: `${X}place/region-notts`, label: 'Nottinghamshire', qid: 'Q21' });
  // Not searched in Wikidata, or searched and not answered: never ready; and a place kept out of the review, or of minting.
  const w2 = workAfterReview(places);
  w2.lookups[1].queries[P('newstead')].state = 'unanswered';
  assert.deepEqual(qualifying(w2, places, { base: X }).leftOut.unanswered, [P('newstead')]);
  delete w2.lookups[1].queries[P('newstead')];
  assert.deepEqual(qualifying(w2, places, { base: X }).leftOut.notSearched, [P('newstead')]);
  assert.equal(searchState(w2, P('newstead')), null);
  const w3 = workAfterReview(places);
  w3.places[P('newstead')].rowState = 'exclude';
  assert.deepEqual(qualifying(w3, places).leftOut.rowState, [P('newstead')]);
  const w4 = workAfterReview(places);
  mintOf(w4).items[P('newstead')] = { excluded: true };
  assert.deepEqual(qualifying(w4, places).leftOut.excluded, [P('newstead')]);
  // A place whose address is not under the base, or not a web address, has nothing the dataset will serve to cite.
  const w5 = workAfterReview([...places, { iri: 'urn:x-local:1', label: 'Nowhere', names: ['Nowhere'], point: [0, 50], identities: { linked: [], denied: [] } }]);
  assert.deepEqual(qualifying(w5, null, { base: X }).leftOut.noAddress, ['urn:x-local:1']);
  assert.deepEqual(qualifying(w5, null, { base: 'https://elsewhere.example/' }).leftOut.outsideBase.includes(P('newstead')), true);
  // Never looked up in any other gazetteer: counted, not a reason.
  const w6 = workAfterReview(places); w6.lookups = [w6.lookups[1]]; w6.candidates = w6.candidates.filter((c) => c.lookup !== 'l1');
  const r6 = qualifying(w6, places);   // no records given, so no source is asked for: Papplewick is ready too, and Blidworth has no match now
  assert.deepEqual([r6.ready.length, r6.whgNotSearched], [4, 4]);
});

test('the plan: labels and aliases by language, the class, the point to its precision, the country, the description prefilled or edited, what is not free left out and said', async () => {
  const { places, records } = await read();
  const w = workAfterReview(places);
  decide(w, 'l2-2', 'not-this', { at: AT });   // Kirkby reviewed
  const plan = planItems({ work: w, places, records, options: { base: X } });
  assert.equal(plan.gate.kind, 'consent');
  const n = plan.items.find((it) => it.iri === P('newstead'));
  assert.deepEqual(n.labels, { en: 'Newstead', la: 'Novum Locum' });
  assert.deepEqual(n.aliases, { en: ['Newsted'] });
  assert.deepEqual(n.class, { qid: 'Q532', word: 'village', how: 'kind' });
  assert.deepEqual(n.point, [-1.193, 53.081], 'rounded to the decimals its precision (1 km) allows');
  assert.equal(n.decimals, 3);
  assert.deepEqual(n.country, { qid: 'Q145', name: 'United Kingdom' });
  assert.equal(n.region, null);
  assert.deepEqual(n.years, [1296, 1540]);
  assert.equal(n.description, 'village in the United Kingdom, attested 1296–1540', 'the article, as Wikidata\'s descriptions have it');
  assert.deepEqual(n.warnings, []);
  // A name tagged as a transliteration (grc-Latn) goes on no slot and is said; a romanised form goes under the dataset's language, else is said.
  const greek = JSON.parse(JSON.stringify(dataset()));
  greek.spatialEntities[0].attestations[0].names = [{ toponym: '\u039d\u03b5\u03ce\u03c3\u03c4\u03b5\u03b4', language: 'grc', romanized: 'Neosted' }, { toponym: 'Neosted', language: 'grc-Latn' }, { toponym: 'Newstead', language: 'en' }];
  const gk = await read(greek);
  const gw = workAfterReview(gk.places); decide(gw, 'l2-2', 'not-this', { at: AT });
  const g1 = planItems({ work: gw, places: gk.places, records: gk.records, options: { base: X } }).items.find((it) => it.iri === P('newstead'));
  assert.deepEqual(g1.labels, { grc: '\u039d\u03b5\u03ce\u03c3\u03c4\u03b5\u03b4', en: 'Newstead' });
  assert.deepEqual(g1.aliases, {}, 'the transliteration is on no slot, the romanised form under no language');
  assert.ok(g1.warnings.includes('language-unsupported') && g1.warnings.includes('romanised-no-language'), g1.warnings);
  const g2 = planItems({ work: gw, places: gk.places, records: gk.records, options: { base: X, lang: 'en' } }).items.find((it) => it.iri === P('newstead'));
  assert.deepEqual(g2.aliases, { en: ['Neosted'] }, 'the romanised form goes under the dataset\'s language');
  assert.ok(!g2.warnings.includes('romanised-no-language') && g2.warnings.includes('language-unsupported'));
  // A tab in a name: written as a space, and said; a quote is not a problem.
  const tabbed = JSON.parse(JSON.stringify(dataset()));
  tabbed.spatialEntities[0].attestations[0].names[0].toponym = 'New\tstead "the old"';
  const tb = await read(tabbed);
  const tw = workAfterReview(tb.places); decide(tw, 'l2-2', 'not-this', { at: AT });
  const t1 = planItems({ work: tw, places: tb.places, records: tb.records, options: { base: X } }).items.find((it) => it.iri === P('newstead'));
  assert.deepEqual(t1.warnings, ['whitespace-replaced']);
  // Cliffe: its name is free, its only point is not: no P625, said; it still qualifies with no point? No: no point and no region is left out.
  assert.ok(plan.left.noPoint.includes(P('cliffe')), 'a point copied from a non-free source is no point for the item');
  // Kirkby: no kind: left out until the user chooses one; its untagged name takes the dataset's language, or is warned of.
  assert.ok(plan.left.noKind.includes(P('kirkby')));
  mintOf(w).items[P('kirkby')] = { kind: 'Q5084', description: 'A hamlet by the Erewash.' };
  assert.ok(planItems({ work: w, places, records, options: { base: X } }).left.noLanguage.includes(P('kirkby')), 'a kind chosen, its one name still has no language');
  const withLang = planItems({ work: w, places, records, options: { base: X, lang: 'en' } });
  const k = withLang.items.find((it) => it.iri === P('kirkby'));
  assert.deepEqual([k.class.qid, k.labels, k.description], ['Q5084', { en: 'Kirkby' }, 'a hamlet by the Erewash'], 'the choice and the edit, tidied');
  const noLang = planItems({ work: w, places, records, options: { base: X } });
  assert.ok(noLang.left.noLanguage.includes(P('kirkby')) && !noLang.items.some((it) => it.iri === P('kirkby')), 'no language for its one name: no label, no item');
  assert.deepEqual(withLang.count, { items: 2, statements: 7 + 5 }, 'Newstead: 2 labels, 1 alias, the description, P31, P625, P17; Kirkby: 1 label, the description, P31, P625, P17');
});

test('the batch text, line by line: CREATE with its comment, LAST with labels, aliases, description and each statement referenced S854 and S813', async () => {
  const { places, records } = await read();
  const w = workAfterReview(places);
  decide(w, 'l2-2', 'not-this', { at: AT });
  w.regions = { [`${X}place/region-notts`]: { label: 'Nottinghamshire', names: ['Nottinghamshire'], level: 1, container: 'c', within: null, count: 1, outcome: 'matched' } };
  w.places[P('newstead')].within = `${X}place/region-notts`; w.places[P('newstead')].level = 1;
  w.candidates.push({ id: 'l1-9', candidate_source: `${X}place/region-notts`, candidate_candidate: 'https://w3id.org/whg/id/place:wd:Q21', similarity_score: 1, distance_km: null, candidate_status: 'confirmed', lookup: 'l1',
    other: { label: 'Nottinghamshire', names: ['Nottinghamshire'], point: null, source: { title: 'WHG' } }, gazetteer: { service: 'x', id: 'place:wd:Q21', score: null, confidence: null, match: true, answer_rank: 1, description: null, namespace: 'wd', query: null },
    decision: { kind: 'match', identityType: 'exactMatch', decided_at: AT } });
  const plan = planItems({ work: w, places, records, options: { base: X, only: [P('newstead')] } });
  assert.equal(plan.items.length, 1);
  const text = quickStatementsV1(plan.items, { date: '2026-10-15', title: 'Lost places of the Trent' });
  const ref = `\tS854\t"${P('newstead')}"\tS813\t+2026-10-15T00:00:00Z/11`;
  assert.deepEqual(text.split('\n'), [
    `CREATE /* PLATO tools: Lost places of the Trent; ${P('newstead')} */`,
    'LAST\tLen\t"Newstead"',
    'LAST\tLla\t"Novum Locum"',
    'LAST\tAen\t"Newsted"',
    'LAST\tDen\t"village in Nottinghamshire, the United Kingdom, attested 1296–1540"',
    `LAST\tP31\tQ532${ref}`,
    `LAST\tP625\t@53.081/-1.193${ref}`,
    `LAST\tP17\tQ145${ref}`,
    `LAST\tP131\tQ21${ref}`,
    '',
  ]);
  // The statements switched off are left out; a title with @ in it is never written; a quote in a name is written as a closing quotation mark.
  const fewer = quickStatementsV1(plan.items, { date: '2026-10-15', title: 'editor@example.org', statements: { aliases: false, p17: false, p131: false } });
  assert.ok(!fewer.includes('@example') && !fewer.includes('Aen') && !fewer.includes('P17') && !fewer.includes('P131') && fewer.includes('P625'));
  assert.equal(fewer.split('\n')[0], `CREATE /* PLATO tools: ${P('newstead')} */`);
  // A quote inside a text is written as it is (QuickStatements takes the outer quotes); a tab is a space; an address is never altered.
  const quoted = quickStatementsV1([{ ...plan.items[0], iri: 'https://w3id.org/x/place/a"b', labels: { en: 'The "Hall"' }, aliases: {}, description: 'a hall\twith a tab' }], { date: '2026-10-15' });
  assert.ok(quoted.includes('LAST\tLen\t"The "Hall""') && quoted.includes('"a hall with a tab"') && quoted.includes('S854\t"https://w3id.org/x/place/a"b"'), quoted);
  // The description is English by construction: Den, whatever the labels' languages (a Latin-first dataset).
  const latinFirst = quickStatementsV1([{ ...plan.items[0], labels: { la: 'Novum Locum', en: 'Newstead' }, aliases: {} }], { date: '2026-10-15', statements: { p31: false, p625: false, p17: false, p131: false } });
  assert.deepEqual(latinFirst.split('\n').slice(1, 4), ['LAST\tLla\t"Novum Locum"', 'LAST\tLen\t"Newstead"', 'LAST\tDen\t"village in Nottinghamshire, the United Kingdom, attested 1296–1540"']);
  assert.ok(!latinFirst.includes('\tDla\t'), 'never a Latin description');
  assert.throws(() => qsDate('yesterday'), /Not a date/);
  assert.equal(batchName('trent.krisis.json'), 'trent.wikidata.qs.txt');
  assert.equal(quickStatementsV1([], { date: '2026-10-15' }), '');
  assert.equal(plan.count.statements, 8);
});

test('the licence gate: the public domain passes, credit or share-alike asks consent, and the rest is refused in words', () => {
  const g = (licence) => mintGate({ licence });
  assert.deepEqual(g('https://creativecommons.org/publicdomain/zero/1.0/'), { kind: 'free', licence: 'CC0-1.0', why: null });
  assert.equal(g('https://creativecommons.org/publicdomain/mark/1.0/').kind, 'free');
  assert.deepEqual(g('https://creativecommons.org/licenses/by/4.0/'), { kind: 'consent', licence: 'CC-BY-4.0', why: 'by' });
  assert.deepEqual(g('https://creativecommons.org/licenses/by-sa/4.0/'), { kind: 'consent', licence: 'CC-BY-SA-4.0', why: 'sa' });
  assert.equal(g('https://opendatacommons.org/licenses/odbl/1-0/').why, 'sa');
  assert.equal(g('http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/').kind, 'consent');
  assert.deepEqual(g('https://creativecommons.org/licenses/by-nc/4.0/'), { kind: 'refused', licence: 'CC-BY-NC-4.0', why: 'nc' });
  assert.equal(g('https://creativecommons.org/licenses/by-nd/4.0/').why, 'nd');
  assert.deepEqual(g('http://rightsstatements.org/vocab/InC/1.0/'), { kind: 'refused', licence: 'rights statement InC 1.0', why: 'rights-statement' });
  assert.deepEqual(g(undefined), { kind: 'refused', licence: null, why: 'no-licence' });
  assert.deepEqual(g('https://example.org/my-licence'), { kind: 'refused', licence: 'https://example.org/my-licence', why: 'unknown' });
  // The consent record: the statement, who (never an address), when.
  const c = consentRecord({ by: REVIEWER, at: AT, licence: 'CC-BY-4.0' });
  assert.deepEqual(c, { statement: CONSENT, by: REVIEWER, at: AT, licence: 'CC-BY-4.0' });
  assert.throws(() => consentRecord({ by: { name: 'lu@example.org' }, at: AT }), /@/);
  assert.throws(() => consentRecord({ by: { name: '' }, at: AT }), /must have a name/);
  assert.match(CONSENT, /release these statements under CC0/);
});

test("the work file's mint section is read back whole, and a malformed one is refused in words", async () => {
  const { places } = await read();
  const w = workAfterReview(places);
  const m = mintOf(w);
  m.consent = consentRecord({ by: REVIEWER, at: AT, licence: 'CC-BY-4.0' });
  m.items[P('newstead')] = { description: 'a village', kind: 'Q532' };
  m.options = { statements: { ...m.options.statements, p131: false }, lang: 'en' };
  const b = recordBatch(w, { items: [{ iri: P('newstead') }], name: 'trent.wikidata.qs.txt', sha256: 'a'.repeat(64), at: AT, statements: m.options.statements });
  assert.equal(b.id, 'q1');
  assert.deepEqual(readWork(serialiseWork(w)).mint, w.mint);
  const bad = (change, re) => { const x = JSON.parse(serialiseWork(w)); change(x); assert.throws(() => readWork(JSON.stringify(x)), re); };
  bad((x) => { x.mint.version = 2; }, /not of version 1/);
  bad((x) => { x.mint.consent.statement = 'I agree'; }, /mint\.consent/);
  bad((x) => { x.mint.consent.by.name = 'lu@example.org'; }, /address with @/);
  bad((x) => { x.mint.options.statements.p99 = true; }, /mint\.options/);
  bad((x) => { x.mint.options.lang = 'English'; }, /mint\.options/);
  bad((x) => { x.mint.items['https://elsewhere.example/p'] = {}; }, /mint\.items/);
  bad((x) => { x.mint.items[P('newstead')].kind = 'village'; }, /mint\.items/);
  bad((x) => { x.mint.batches[0].id = 'b1'; }, /mint\.batches/);
  bad((x) => { x.mint.qids = { [P('newstead')]: { qid: 'Q1', how: 'typed', at: AT } }; }, /mint\.qids/);
  bad((x) => { x.mint.user = 'lu@example.org'; }, /mint\.user/);
  // The presence beside the refusals: the same file without the change reads.
  assert.ok(readWork(serialiseWork(w)).mint.batches.length === 1);
});

/** An entity as wbgetentities gives it: labels, aliases, P625, P31, P17, and a P854 reference on P31. */
function entity(id, { label = 'Newstead', lang = 'en', point = [-1.193, 53.081], reference = P('newstead'), cls = 'Q532', country = 'Q145', aliases = [] } = {}) {
  const refs = reference ? [{ snaks: { P854: [{ snaktype: 'value', property: 'P854', datavalue: { value: reference, type: 'string' } }] } }] : [];
  return { id, type: 'item', labels: { [lang]: { language: lang, value: label } }, descriptions: { en: { language: 'en', value: 'a village' } }, aliases: { en: aliases.map((value) => ({ language: 'en', value })) },
    claims: { P31: [{ mainsnak: { snaktype: 'value', property: 'P31', datavalue: { value: { id: cls }, type: 'wikibase-entityid' } }, references: refs }],
      ...(point ? { P625: [{ mainsnak: { snaktype: 'value', property: 'P625', datavalue: { value: { latitude: point[1], longitude: point[0], precision: 0.0001 }, type: 'globecoordinate' } } }] } : {}),
      ...(country ? { P17: [{ mainsnak: { snaktype: 'value', property: 'P17', datavalue: { value: { id: country }, type: 'wikibase-entityid' } } }] } : {}) } };
}

test('an item is verified by its label, its point within 1 km and our reference on it; each failing on its own is named', () => {
  const item = { iri: P('newstead'), labels: { en: 'Newstead', la: 'Novum Locum' }, point: [-1.193, 53.081] };
  assert.deepEqual(verifyItem(entity('Q1'), item), { ok: true, label: true, distanceKm: 0, near: true, reference: true });
  assert.deepEqual(verifyItem(entity('Q1', { label: 'Novum Locum', lang: 'la' }), item).ok, true, 'a label in any language');
  assert.equal(verifyItem(entity('Q1', { label: 'Newstead Abbey' }), item).label, false);
  const near = verifyItem(entity('Q1', { point: [-1.2, 53.081] }), item);
  assert.equal(near.near, true); assert.ok(near.distanceKm > 0.4 && near.distanceKm < VERIFY_KM, `0.47 km west is within: ${near.distanceKm}`);
  assert.equal(verifyItem(entity('Q1', { point: [-1.22, 53.081] }), item).near, false, '1.8 km away is not it');
  assert.equal(verifyItem(entity('Q1', { reference: 'https://elsewhere.example/x' }), item).reference, false);
  assert.equal(verifyItem(entity('Q1', { point: null }), item).ok, false, 'no point on the item, where the row has one');
  assert.equal(verifyItem(entity('Q1', { point: null }), { ...item, point: null }).ok, true, 'a row without a point (P131 only) asks no distance');
  assert.equal(verifyItem(entity('Q1', { reference: null }), item).ok, false);
});

test('items read from the user\'s own contributions are matched to the batch\'s rows by the reference they carry, and verified; the rest are left', () => {
  const items = [{ iri: P('newstead'), labels: { en: 'Newstead' }, point: [-1.193, 53.081] }, { iri: P('kirkby'), labels: { en: 'Kirkby' }, point: [-1.25, 53.1] }];
  const entities = { Q11: entity('Q11'), Q12: entity('Q12', { label: 'Kirkby', point: [-1.25, 53.1], reference: P('kirkby') }), Q13: entity('Q13', { label: 'Something else', reference: 'https://elsewhere.example/' }), Q14: { id: 'Q14', missing: '' } };
  const m = matchItems(entities, items);
  assert.deepEqual(m.matched.map((x) => [x.qid, x.iri, x.verified.ok]), [['Q11', P('newstead'), true], ['Q12', P('kirkby'), true]]);
  assert.deepEqual(m.unmatched, ['Q13']);
  assert.deepEqual(m.twice, []);
  // Two items carrying one row's address: neither is taken.
  const two = matchItems({ Q11: entity('Q11'), Q15: entity('Q15') }, items);
  assert.deepEqual(two.matched, []); assert.deepEqual(two.twice, [{ iri: P('newstead'), qids: ['Q11', 'Q15'] }]);
  // Pasted ids, in the rows' order; what is beyond them counted.
  assert.deepEqual(readPastedQids('Q11\nQ12 and https://www.wikidata.org/wiki/Q13, Q11 again; Q0 is none'), ['Q11', 'Q12', 'Q13']);
  assert.deepEqual(pairPasted(['Q11', 'Q12', 'Q13'], items), { pairs: [{ qid: 'Q11', iri: P('newstead') }, { qid: 'Q12', iri: P('kirkby') }], extraQids: 1, rowsLeft: 0 });
  assert.deepEqual(pairPasted(['Q11'], items).rowsLeft, 1);
  // An entity as a candidate for the review (the search): its names, point, classes and country.
  const c = entityCandidate(entity('Q11', { aliases: ['Newstede'] }), { lang: 'en' });
  assert.deepEqual([c.id, c.iri, c.name, c.altNames, c.coords, c.ccodes, c.types, c.score, c.match, c.namespace], ['Q11', `${WD}Q11`, 'Newstead', ['Newstede'], [-1.193, 53.081], ['GB'], [{ id: 'wikidata:Q532', name: 'wikidata:Q532' }], null, false, 'wd']);
  assert.match(entityCandidate(entity('Q11'), { foundBy: 'near' }).description, /^found near the place's point; a village$/);
  assert.equal(entityCandidate({ id: 'P31' }), null);
});

test('a verified Q-id is recorded as the reviewer\'s decision, and Finish writes it as an identity, citing Wikidata, as a pure addition; finishing again writes nothing new', async () => {
  const { places, records, subjects } = await read();
  const w = workAfterReview(places);
  decide(w, 'l2-2', 'not-this', { at: AT });
  const plan = planItems({ work: w, places, records, options: { base: X, lang: 'en', only: [P('newstead')] } });
  const batch = recordBatch(w, { items: plan.items, name: 'trent.wikidata.qs.txt', sha256: 'b'.repeat(64), at: AT });
  const verified = verifyItem(entity('Q4242'), plan.items[0]);
  assert.throws(() => recordMinted(w, P('newstead'), 'Q4242', { batch, reviewer: REVIEWER, how: 'pasted', verified: { ...verified, ok: false }, at: AT }), /not verified/);
  assert.throws(() => recordMinted(w, P('newstead'), 'Q4242', { batch, reviewer: { name: 'lu@example.org' }, how: 'pasted', verified, at: AT }), /name/);
  const c = recordMinted(w, P('newstead'), 'Q4242', { batch, reviewer: REVIEWER, how: 'pasted', verified, at: AT });
  assert.equal(c.candidate_candidate, `${WD}Q4242`);
  assert.deepEqual([c.decision.kind, c.decision.identityType, c.candidate_status], ['match', 'exactMatch', 'confirmed']);
  assert.match(c.decision.basis, /QuickStatements batch q1 of 2026-10-15/);
  const l = w.lookups.find((x) => x.parameters?.minted);
  assert.ok(l && l.service.title === 'Wikidata' && l.queries[P('newstead')].minted === 'Q4242' && c.lookup === l.id);
  assert.deepEqual(w.mint.qids[P('newstead')], { qid: 'Q4242', how: 'pasted', batch: 'q1', at: AT, verified: { label: true, distanceKm: 0, reference: true } });
  assert.equal(recordMinted(w, P('newstead'), 'Q4242', { batch, reviewer: REVIEWER, how: 'contribs', verified, at: AT }), c, 'recorded again: the same candidate, its decision kept');
  // Never minted twice: the place is left out as 'minted' whatever its decisions say since (the minted candidate flipped to "not this one"); the way back is the record taken out.
  decide(w, c.id, 'not-this', { at: AT });
  const after = qualifying(w, places, { records: records.records, base: X });
  assert.ok(!after.ready.includes(P('newstead')) && after.leftOut.minted.includes(P('newstead')), JSON.stringify(after));
  assert.deepEqual(planItems({ work: w, places, records, options: { base: X, lang: 'en' } }).left.minted, [P('newstead')]);
  decide(w, c.id, 'match', { at: AT });
  assert.equal(unrecordMinted(w, P('newstead')), 'Q4242');
  assert.equal(unrecordMinted(w, P('newstead')), null, 'nothing recorded now');
  assert.equal(w.mint.qids[P('newstead')], undefined);
  assert.equal(c.decision, null); assert.equal(c.candidate_status, 'suggested');
  assert.equal(l.queries[P('newstead')], undefined);
  const back = qualifying(w, places, { records: records.records, base: X });
  assert.ok(!back.leftOut.minted.includes(P('newstead')) && back.leftOut.undecided.includes(P('newstead')), 'the way back: its candidate is to decide again, and the place can qualify once it is');
  decide(w, c.id, 'not-this', { at: AT });
  assert.ok(qualifying(w, places, { records: records.records, base: X }).ready.includes(P('newstead')), 'control: ready again');
  assert.deepEqual(readWork(serialiseWork(w)), w);
  recordMinted(w, P('newstead'), 'Q4242', { batch, reviewer: REVIEWER, how: 'pasted', verified, at: AT });
  // A consent fits the licence it was made for, and no other (the dataset relicensed since).
  assert.equal(consentFits(consentRecord({ by: REVIEWER, at: AT, licence: 'CC-BY-4.0' }), mintGate({ licence: 'https://creativecommons.org/licenses/by/4.0/' })), true);
  assert.equal(consentFits(consentRecord({ by: REVIEWER, at: AT, licence: 'CC-BY-4.0' }), mintGate({ licence: 'https://creativecommons.org/licenses/by-sa/4.0/' })), false);
  assert.equal(consentFits(null, mintGate({ licence: 'https://creativecommons.org/licenses/by/4.0/' })), false);
  const text = serialiseWork(w);
  assert.deepEqual(readWork(text), w, 'the work file reads back');
  // Finish: the identity written, citing Wikidata, and Mneme's version check finds exactly the additions.
  const e = env();
  const r = await apply({ subjects, work: text, options: { reviewer: REVIEWER } }, e);
  assert.equal(r.incomplete, undefined, JSON.stringify(r.report.items));
  assert.equal(r.report.errors, 0);
  // Blidworth's WHG match and Newstead's Wikidata item: two attestations added, nothing changed or lost.
  assert.equal(r.report.counts.versionCheck.added, 2);
  assert.deepEqual([r.report.counts.versionCheck.changed, r.report.counts.versionCheck.lost], [0, 0]);
  const made = r.attestations.find((m) => m.subject === P('newstead')).attestation;
  assert.deepEqual(made.identities, [{ subject: P('newstead'), object: `${WD}Q4242`, identityType: 'exactMatch', basis: c.decision.basis }]);
  assert.deepEqual(made.citations, [{ source: { title: 'Wikidata', authorityType: 'dataset', '@id': 'https://www.wikidata.org/' } }]);
  assert.match(made.notes, /looking the place up in Wikidata \(krisis-wikidata 1\)/);
  assert.ok(!/@/.test(JSON.stringify(made).replace(/@id/g, '')), 'no address with @ in it is written');
  // The dataset written, finished again: nothing new.
  const out = textFile(e.outs['trent.krisis-dataset.json'].join(''), 'trent.krisis-dataset.json');
  const again = await apply({ subjects: await detect([out]), work: serialiseWork(r.work), options: { reviewer: REVIEWER } }, env());
  assert.ok(again.report.items.some((i) => i.kind === 'nothing-new'), JSON.stringify(again.report.items.map((i) => i.kind)));
  assert.equal(again.outputs.length, 0);
});

test('the cap and the constants the page and the command line say', () => {
  assert.equal(MAX_ITEMS, 250);
  assert.equal(VERIFY_KM, 1);
  assert.equal(ENTITY, 'http://www.wikidata.org/entity/');
  assert.deepEqual(STATEMENTS, ['labels', 'aliases', 'description', 'p31', 'p625', 'p17', 'p131']);
});
