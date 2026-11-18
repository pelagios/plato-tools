// The country hint (P0-7; Stephen, 18 November 2026): a table's Country column names a present-day
// country; a gazetteer lookup of its places is ORDERED by that country and is never filtered by it.
// A fake fetch stands in for WHG: nothing here goes on the network.
//
// Each absence has a presence beside it, in the same test and by the same search: "no countries in the
// request" beside a place whose own country codes ARE sent when the filter is asked for; "no ccodes
// written" beside a column of codes that IS written; "not promoted" beside a candidate that is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, textFile, outText, go } from './engine.js';
import { detect } from '../src/engine/input.js';
import { countryOf, countryName } from '../src/engine/countries.js';
import { guessColumns, applyColumns, isCountryHeading, GENERIC_KINDS } from '../src/engine/hermes/columns.js';
import { createLookup, memoryLedger, WHG_ENDPOINT } from '../src/engine/gazetteer/index.js';
import { gather } from '../src/engine/krisis/match.js';
import { readWork, serialiseWork } from '../src/engine/krisis/work.js';
import { planQueries, rankGazetteer, runLookup, hintOf, countryCheck, HINT_SIMILARITY_BAND, LOOKUP_DEFAULTS } from '../src/engine/krisis/lookup.js';
import { planGuarded } from '../src/engine/krisis/guards.js';
import { LOOKUP_WORDS, lookupPage } from '../src/engine/words.js';
import { LOSS_TEXT } from '../src/engine/report.js';

const NOW = '2026-11-18T12:00:00Z';
const BASE = 'https://example.org/t/';
const PRIVATE = { get shared() { return false; }, get locks() { return null; }, get ledger() { return memoryLedger(); } };
function fakeWhg(table) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const out = { attribution: null };
    for (const [k, q] of Object.entries(body.queries)) out[k] = { result: table[q.query] ?? [] };
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { fetch, calls };
}
const lookupWith = (fake) => createLookup({ endpoint: WHG_ENDPOINT, token: 'test-token', fetch: fake.fetch, sleep: () => Promise.resolve(), queryRate: null, ...PRIVATE });
const cand = (n, name, cc, more = {}) => ({ id: `place:gn:${n}`, name, score: 100 - n, match: n === 1, description: cc ? `Country: ${cc}` : '', ...(cc ? { ccodes: [cc] } : {}), namespace: 'gn', alt_names: [], ...more });
const candOf = (work, n) => work.candidates.find((c) => c.gazetteer?.id === `place:gn:${n}`);
const idsOf = (work, iri) => work.candidates.filter((c) => c.candidate_source === iri).map((c) => c.gazetteer.id.replace('place:gn:', ''));
const sentQueries = (fake) => fake.calls.flatMap((b) => Object.values(b.queries));

async function gatherCsv(csv, name = 'places.csv') {
  const input = await detect([textFile(csv, name)]);
  return gather({ subjects: input, options: { base: BASE } }, env());
}
const byLabel = (g, label) => g.places.find((p) => p.label === label);

// WHG's answer to "Samarkand" as the live test found it: hamlets of the name in other countries first,
// the city tenth, every score relative to the best in the answer.
const SAMARKANDS = [
  cand(1, 'Samarkand', 'RU'), cand(2, 'Samarkand', 'KZ'), cand(3, 'Samarkand', 'IR'), cand(4, 'Samarkand', null), cand(5, 'Samarkand', 'TJ'),
  cand(6, 'Samarkand', 'RU'), cand(7, 'Samarkand', 'AF'), cand(8, 'Samarkand', 'KG'), cand(9, 'Samarkand', 'US'), cand(10, 'Samarkand', 'UZ'),
];

// ---- the names ------------------------------------------------------------------------------------------
test('a country name resolves to its one ISO code; a name that is not one present-day country resolves to nothing', () => {
  assert.deepEqual(countryOf('Turkey'), { code: 'TR', name: 'Turkey' });
  assert.equal(countryOf('  uzbekistan ')?.code, 'UZ', 'case and spaces do not count');
  assert.equal(countryOf('the Netherlands')?.code, 'NL', 'a leading "the", and the short name of a longer label');
  assert.equal(countryOf("Côte d'Ivoire")?.code, 'CI');
  assert.equal(countryOf('St Lucia')?.code, 'LC');
  for (const uk of ['UK', 'United Kingdom', 'Great Britain', 'England', 'Scotland', 'Wales']) assert.equal(countryOf(uk)?.code, 'GB', uk);
  assert.equal(countryOf('USA')?.code, 'US');
  assert.equal(countryOf('TR')?.code, 'TR', 'a code in capitals is itself');
  // Not resolved, by the same function that resolved those above.
  assert.equal(countryOf('tr'), null, 'a code is read only in capitals');
  assert.equal(countryOf('ZZ'), null, 'two capitals that are no code');
  for (const none of ['Congo', 'Korea', 'America', 'Persia', 'Ottoman Empire', 'Turkey or Greece', '', null]) assert.equal(countryOf(none), null, String(none));
  assert.equal(countryName('uz'), 'Uzbekistan');
  assert.equal(countryName('ZZ'), null);
});

test('only a heading that names a country by name is a country column', () => {
  for (const h of ['Country', 'country_name', 'Nation', 'COUNTRY LABEL']) assert.equal(isCountryHeading(h), true, h);
  for (const h of ['State', 'Region', 'adm0', 'County', 'countrycode', 'Land', 'name']) assert.equal(isCountryHeading(h), false, h);
});

// ---- Hermes: the column stays a region, and gives the hint ---------------------------------------------------
test('a Country column is still a region the place lies in, and its country is carried as a hint, not as ccodes', async () => {
  const csv = 'id,name,Country\n1,Samarkand,Uzbekistan\n2,Constantinople,Turkey\n3,Trebizond,Ottoman Empire\n4,Merv,\n';
  const rows = [{ id: '1', name: 'Samarkand', Country: 'Uzbekistan' }];
  const guess = guessColumns(['id', 'name', 'Country'], rows);
  assert.equal(guess.mapping.Country, 'within', 'the column is a region level, as before');
  const reported = [];
  const a = applyColumns(rows[0], guess.mapping, { levels: { Country: 1 }, report: (k, e) => reported.push([k, e]) });
  assert.deepEqual(a.within, [{ level: 1, value: 'Uzbekistan', column: 'Country' }]);
  assert.deepEqual(a.countryHint, { code: 'UZ', name: 'Uzbekistan' });
  assert.equal(a.ccodes, undefined, 'no country codes are made of a name');
  assert.deepEqual(reported, []);
  // A value that names no one country gives no hint, and is reported; the region is carried all the same.
  const b = applyColumns({ id: '3', name: 'Trebizond', Country: 'Ottoman Empire' }, guess.mapping, { where: 'row 4', levels: { Country: 1 }, report: (k, e) => reported.push([k, e]) });
  assert.equal(b.countryHint, undefined);
  assert.deepEqual(b.within, [{ level: 1, value: 'Ottoman Empire', column: 'Country' }]);
  assert.deepEqual(reported, [['generic-country-unresolved', 'row 4, Country: Ottoman Empire']]);
  assert.equal(GENERIC_KINDS['generic-country-unresolved'], 'warning');
  assert.match(LOSS_TEXT['generic-country-unresolved'], /Nothing is lost/);
  // A column of the same values under a heading that names no country gives no hint (and no report).
  const c = applyColumns({ id: '1', name: 'Samarkand', Land: 'Uzbekistan' }, { id: 'id', name: 'name', Land: 'within' }, { levels: { Land: 1 }, report: (k, e) => reported.push([k, e]) });
  assert.deepEqual(c.within, [{ level: 1, value: 'Uzbekistan', column: 'Land' }]);
  assert.equal(c.countryHint, undefined);
  assert.equal(reported.length, 1, 'nothing more reported');
  // Two country columns that name different countries give none, and say so.
  const d = applyColumns({ name: 'X', Country: 'Turkey', Nation: 'Greece' }, { name: 'name', Country: 'within', Nation: 'within' }, { where: 'row 2', levels: { Country: 1, Nation: 2 }, report: (k, e) => reported.push([k, e]) });
  assert.equal(d.countryHint, undefined);
  assert.deepEqual(reported[1], ['generic-country-unresolved', 'row 2: Country: Turkey, Nation: Greece']);

  // Through the reader and gather(): the hint is on the place, the region is still a region, and the report counts the value not used.
  const g = await gatherCsv(csv);
  assert.deepEqual(byLabel(g, 'Samarkand').countryHint, { code: 'UZ', name: 'Uzbekistan' });
  assert.deepEqual(byLabel(g, 'Constantinople').countryHint, { code: 'TR', name: 'Turkey' });
  assert.equal(byLabel(g, 'Trebizond').countryHint, undefined, 'a historical state gives no hint');
  assert.equal(byLabel(g, 'Merv').countryHint, undefined, 'an empty cell gives no hint');
  assert.deepEqual(byLabel(g, 'Trebizond').chain, [{ level: 1, value: 'Ottoman Empire' }], 'and is still its region');
  assert.deepEqual(byLabel(g, 'Samarkand').chain, [{ level: 1, value: 'Uzbekistan' }]);
  assert.equal(byLabel(g, 'Samarkand').ccodes, undefined, 'the hint is not the place\'s ccodes');
  // The conversion's report counts the value not used (gather()'s own report is of the reading for a lookup, and carries none of the reader's).
  const r = await go([textFile(csv, 'places.csv')], 'convert', 'plato-json', { base: BASE });
  const item = r.report.items.find((i) => i.kind === 'generic-country-unresolved');
  assert.deepEqual([item?.severity, item?.count, item?.examples], ['warning', 1, ['row 4, Country: Ottoman Empire']], 'one value not used, counted, with its row');
  assert.equal(r.report.errors, 0);
});

test('the converted PLATO holds no country code made from a name, though it holds one from a column of codes', async () => {
  const toPlato = async (csv) => {
    const r = await go([textFile(csv, 'places.csv')], 'convert', 'plato-json', { base: BASE });
    return JSON.parse(outText(r.e, r.outputs[0].name));
  };
  const named = await toPlato('id,name,Country\n1,Samarkand,Uzbekistan\n');
  const coded = await toPlato('id,name,ccodes\n1,Samarkand,UZ\n');
  const has = (doc) => JSON.stringify(doc).includes('"ccodes"');
  assert.equal(has(coded), true, 'control: a column of codes is written as ccodes');
  assert.equal(has(named), false, 'a country name is not');
  assert.equal(JSON.stringify(named).includes('countryHint'), false, 'nor is the hint itself: it rides on the events only');
  assert.ok(JSON.stringify(named).includes('Uzbekistan'), 'the region is written');
});

// ---- what is sent ---------------------------------------------------------------------------------------------
test('the hint is in no query, even when the country filter is asked for; the preview shows exactly what is sent and says the hint is not', async () => {
  const g = await gatherCsv('id,name,Country\n1,Samarkand,Uzbekistan\n');
  const hinted = byLabel(g, 'Samarkand');
  const own = { iri: BASE + 'place/own', label: 'Bukhara', names: ['Bukhara'], point: null, ccodes: ['UZ'] };
  const plain = planQueries([hinted, own]);
  assert.deepEqual(plain.preview.first, [{ query: 'Samarkand', type: 'Place', limit: 10 }, { query: 'Bukhara', type: 'Place', limit: 10 }]);
  assert.equal(plain.preview.countryHints, 1, 'one place is ordered by a hint: the one with no codes of its own');
  assert.equal(plain.preview.limit, LOOKUP_DEFAULTS.limit, 'no more candidates are asked for because of a hint');
  assert.ok(LOOKUP_WORDS.preview(plain.preview).some((l) => /a country from your table's country column\. It is not sent, and leaves nothing out/.test(l)));
  // The filter, asked for: the place's own codes are sent, the hint never.
  const filtered = planQueries([hinted, own], { countries: true });
  assert.deepEqual(filtered.preview.first, [{ query: 'Samarkand', type: 'Place', limit: 10 }, { countries: ['UZ'], query: 'Bukhara', type: 'Place', limit: 10 }]);
  assert.equal(filtered.preview.withoutCountries, 1, 'the hinted place is counted as looked up without the filter');
  // Without a hint the preview does not speak of one.
  const none = planQueries([own]);
  assert.equal(Object.hasOwn(none.preview, 'countryHints'), false);
  assert.ok(!LOOKUP_WORDS.preview(none.preview).some((l) => /country column/.test(l)));
});

// ---- the ranking ------------------------------------------------------------------------------------------------
const gz = (n, name, cc, more = {}) => ({ id: `g${n}`, iri: `https://example.org/g/${n}`, name, altNames: [], coords: null, ccodes: cc ? [cc] : null, answer_rank: n, ...more });
test('rankGazetteer: with a hint, the candidate in that country leads; every candidate is kept; without it, the service\'s order', () => {
  const list = [gz(1, 'Samarkand', 'RU'), gz(2, 'Samarkand', 'KZ'), gz(3, 'Samarkand', null), gz(4, 'Samarkand', 'UZ'), gz(5, 'Samarkand', 'US')];
  const place = { label: 'Samarkand', names: ['Samarkand'], point: null };
  const order = (p, l = list) => rankGazetteer(p, l).map((r) => r.candidate.id);
  assert.deepEqual(order(place), ['g1', 'g2', 'g3', 'g4', 'g5'], 'control: with no hint, the service\'s order');
  const hinted = { ...place, countryHint: { code: 'UZ', name: 'Uzbekistan' } };
  const ranked = rankGazetteer(hinted, list);
  assert.deepEqual(ranked.map((r) => r.candidate.id), ['g4', 'g1', 'g2', 'g3', 'g5'], 'the one in Uzbekistan first, the rest in their order: none demoted');
  assert.equal(ranked.length, list.length, 'nothing dropped');
  assert.deepEqual(ranked.map((r) => r.ccodes_agree), [true, false, false, null, false], 'and each says whether it is in the country (null: no country recorded)');
  // A hint in lower case, as a hand-edited work file might hold it.
  assert.equal(order({ ...place, countryHint: { code: 'uz', name: 'Uzbekistan' } })[0], 'g4');
  // The place's own country codes come before a hint that says otherwise.
  assert.equal(hintOf({ ...hinted, ccodes: ['RU'] }), null);
  assert.equal(order({ ...hinted, ccodes: ['RU'] })[0], 'g1');
});

test('rankGazetteer: the hint promotes only a name about as good as the best, and distance stays primary', () => {
  const place = { label: 'Samarkand', names: ['Samarkand'], point: null, countryHint: { code: 'UZ', name: 'Uzbekistan' } };
  // In the country, but a different name: not put before the exact name elsewhere.
  const poor = [gz(1, 'Samarkand', 'RU'), gz(2, 'Tashkent', 'UZ')];
  const r = rankGazetteer(place, poor);
  assert.ok(r[0].similarity_score - r[1].similarity_score > HINT_SIMILARITY_BAND, 'control: the names are not comparable');
  assert.deepEqual(r.map((x) => x.candidate.id), ['g1', 'g2']);
  assert.equal(r[1].ccodes_agree, true, 'it is still said to be in the country');
  // The same two with a near spelling in the country: promoted.
  const near = rankGazetteer(place, [gz(1, 'Samarkand', 'RU'), gz(2, 'Samarqand', 'UZ')]);
  assert.ok(near.find((x) => x.candidate.id === 'g2').similarity_score >= near.find((x) => x.candidate.id === 'g1').similarity_score - HINT_SIMILARITY_BAND, 'control: comparable names');
  assert.deepEqual(near.map((x) => x.candidate.id), ['g2', 'g1']);
  // With coordinates, the nearer candidate leads whatever its country; the hint orders those as near.
  const at = { ...place, point: [66.97, 39.65] };
  const placed = rankGazetteer(at, [gz(1, 'Samarkand', 'UZ', { coords: [67.5, 39.9] }), gz(2, 'Samarkand', 'TJ', { coords: [66.98, 39.65] })]);
  assert.deepEqual(placed.map((x) => x.candidate.id), ['g2', 'g1'], 'distance first');
  const tied = rankGazetteer(at, [gz(1, 'Samarkand', 'TJ', { coords: [66.98, 39.65] }), gz(2, 'Samarkand', 'UZ', { coords: [66.98, 39.65] })]);
  assert.deepEqual(tied.map((x) => x.candidate.id), ['g2', 'g1'], 'at the same distance, the one in the country');
});

// ---- the lookup, end to end -------------------------------------------------------------------------------------
test('a lookup of a table with a Country column sends bare names, keeps all ten candidates, and lists the one in the country first', async () => {
  const g = await gatherCsv('id,name,Country\n1,Samarkand,Uzbekistan\n2,Bukhara,\n');
  const fake = fakeWhg({ Samarkand: SAMARKANDS, Bukhara: SAMARKANDS.map((c) => ({ ...c, id: c.id + '0', name: 'Bukhara' })) });
  const { work, plan } = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all' }, now: () => NOW });
  // What was sent is what the preview showed, and holds no country.
  assert.deepEqual(sentQueries(fake), plan.preview.first);
  assert.deepEqual(sentQueries(fake), [{ query: 'Samarkand', type: 'Place', limit: 10 }, { query: 'Bukhara', type: 'Place', limit: 10 }]);
  const sam = byLabel(g, 'Samarkand').iri, buk = byLabel(g, 'Bukhara').iri;
  assert.deepEqual(idsOf(work, sam), ['10', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 'all ten, the city in Uzbekistan first');
  assert.deepEqual(idsOf(work, buk), ['10', '20', '30', '40', '50', '60', '70', '80', '90', '100'], 'control: a place with no country keeps the service\'s order');
  // The work file keeps the hint, and reads back with it; the place has no ccodes.
  assert.deepEqual(work.places[sam].countryHint, { code: 'UZ', name: 'Uzbekistan' });
  assert.equal(work.places[sam].ccodes, undefined);
  assert.equal(work.places[buk].countryHint, undefined);
  assert.deepEqual(readWork(serialiseWork(work)).places[sam].countryHint, { code: 'UZ', name: 'Uzbekistan' });
  // The review's line for each candidate.
  const line = (n) => lookupPage.country(countryCheck(work.places[sam], candOf(work, n)));
  assert.equal(line(10), 'In the country the table gives (Uzbekistan).');
  assert.equal(line(1), 'Not in the country the table gives (Uzbekistan): RU.');
  assert.equal(line(4), 'The gazetteer records no country for it; the table gives Uzbekistan.');
  assert.equal(countryCheck(work.places[buk], work.candidates.find((c) => c.candidate_source === buk)), null, 'no line for a place whose table gives no country');
  assert.equal(lookupPage.country(null), '');
});

test('the bulk accept leaves a top candidate outside the table\'s country to the reviewer, and takes one inside it', async () => {
  const g = await gatherCsv('id,name,Country\n1,Aksu,Turkey\n2,Bartin,Turkey\n3,Cumra,\n');
  const top = (n, name, cc) => [cand(1, name, cc, { id: `place:gn:${n}`, score: 100, match: true })];
  const fake = fakeWhg({ Aksu: top(1, 'Aksu', 'KZ'), Bartin: top(2, 'Bartin', 'TR'), Cumra: top(3, 'Cumra', 'KZ') });
  const { work } = await runLookup({ lookup: lookupWith(fake), subjects: g.subjects, places: g.places, options: { places: 'all' }, now: () => NOW });
  assert.deepEqual([candOf(work, 1).ccodes_agree, candOf(work, 2).ccodes_agree, candOf(work, 3).ccodes_agree], [false, true, null]);
  const p = planGuarded(work);
  const accepted = p.accept.map((c) => c.gazetteer.id).sort();
  assert.deepEqual(accepted, ['place:gn:2', 'place:gn:3'], 'the one in Turkey, and (control) the one whose table gives no country, though it too is in KZ');
  assert.equal(p.leftOut.ccodes, 1, 'the one in another country is left for the reviewer, and counted');
  assert.ok(work.candidates.some((c) => c.gazetteer.id === 'place:gn:1'), 'it is still a candidate: nothing was dropped');
});

test('rows about one place (the same web address) give the hint when they name one country, and none when they name two', async () => {
  const P = 'https://pleiades.stoa.org/places/';
  const csv = `uri,name,Country\n${P}1,Smyrna,Turkey\n${P}1,Izmir,Turkey\n${P}2,Adrianople,Turkey\n${P}2,Edirne,Greece\n${P}3,Nicaea,\n${P}3,Iznik,Turkey\n`;
  const input = await detect([textFile(csv, 'places.csv')]);
  const g = await gather({ subjects: input, options: { base: BASE } }, env());
  const of = (n) => g.places.find((p) => p.iri === P + n);
  assert.equal(g.places.length, 3, 'control: three places of six rows');
  assert.deepEqual(of(1).countryHint, { code: 'TR', name: 'Turkey' }, 'two rows, one country');
  assert.deepEqual(of(3).countryHint, { code: 'TR', name: 'Turkey' }, 'one row gives it, the other is empty');
  assert.equal(of(2).countryHint, undefined, 'two countries: none is used');
});
