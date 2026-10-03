// Grouping similar spellings for lookup (src/engine/hermes/cluster.js; Methodos #28, stage 1): the
// keys, the clusters, that nothing is applied unless a group is ticked, what applying a ticked group
// does to the records (and never to the source's names), saving and loading, and the command line.
// Every test that asserts an absence asserts, in the same test, a presence it could have missed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect } from '../src/engine/input.js';
import { Report } from '../src/engine/report.js';
import { genericSource, savedColumns, columnValues } from '../src/engine/hermes/generic.js';
import { resolveColumns } from '../src/engine/hermes/columns.js';
import {
  fingerprint, ngramFingerprint, cologne, phoneticKey, clusterKey, clusterValues, clusterCounter,
  checkClusters, lookupSpellings, confirmedGroups, matchingToSave, splitMatching, clustersInFile, isMatchingEnvelope, isMappingEntry,
} from '../src/engine/hermes/cluster.js';
import { textFile } from './engine.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'plato-tools-cluster-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const CSV = 'id,name,parish,lat,lon\n1,Rotherhithe,St Mary,51.5,-0.05\n2,Rotherhith,St. Mary,51.5,-0.05\n3,ROTHERHITHE.,Saint Mary,51.5,-0.05\n4,Rotherhithe,St Mary,51.5,-0.05\n5,Bermondsey,St Mary,51.49,-0.07\n';
const GROUPS = { name: { method: 'fingerprint', groups: [{ chosen: 'Rotherhithe', members: ['Rotherhith', 'ROTHERHITHE.', 'Rotherhithe'] }] } };

/** Read a CSV through the reader: the events after the header, and the report. */
async function read(text, options = {}, name = 'r.csv') {
  const input = await detect([textFile(text, name)]);
  const rep = new Report();
  const events = [];
  for await (const ev of genericSource(input, rep, options)) events.push(ev);
  return { events: events.slice(1), items: rep.toJSON().items };
}
const toponyms = (ev) => ev.value.attestations[0].names.map((n) => n.toponym);

// ---- the keys ---------------------------------------------------------------------------------------
test('fingerprint: case, punctuation, accents, spacing and word order do not count; other letters do', () => {
  const same = [
    ['Rotherhithe', 'ROTHERHITHE', 'case'],
    ['Rotherhithe', 'Rotherhithe.', 'punctuation'],
    ['Rotherhithe', '  Rotherhithe  ', 'spaces about it'],
    ['Sainte-Mère-Église', 'Sainte-Mere-Eglise', 'accents'],
    ['Ōsaka', 'Osaka', 'a macron'],
    ['Straße', 'strasse', 'ß spelt out'],
    ['Upper Newton', 'Newton, Upper', 'word order'],
    ['Newton Newton', 'Newton', 'a word repeated'],
    ['Kafr\u0007Cal', 'KafrCal', 'a control character'],
  ];
  for (const [a, b, why] of same) assert.equal(fingerprint(a), fingerprint(b), why);
  // Controls: the same tests find a difference where there is one.
  const differ = [
    ['Rotherhithe', 'Rotherhith', 'a letter dropped'],
    ['East Ham', 'West Ham', 'a different word'],
    ['Newton 2', 'Newton 3', 'a different number'],
    ['St Albans', 'St. Albans X', 'a word added'],
    ['Saint Mary', 'St Mary', 'a short form is not expanded'],
  ];
  for (const [a, b, why] of differ) assert.notEqual(fingerprint(a), fingerprint(b), why);
  assert.equal(fingerprint('  Upper  Newton, '), 'newton upper');
  // OpenRefine removes punctuation rather than making it a space.
  assert.equal(fingerprint('St.Albans'), 'stalbans');
  assert.equal(fingerprint('...'), '');
});

test('n-gram fingerprint (n = 2): spacing, and a letter whose pairs are already there, do not count; other letters do', () => {
  assert.equal(ngramFingerprint('Paris'), 'arispari');
  assert.equal(ngramFingerprint('Rother hithe'), ngramFingerprint('Rotherhithe'));
  assert.equal(ngramFingerprint('Rotherhith'), ngramFingerprint('Rotherhithe'));   // the bigram "he" is already in it
  // Controls: a fingerprint does not join these, and the n-gram one would not join different names.
  assert.notEqual(fingerprint('Rother hithe'), fingerprint('Rotherhithe'));
  assert.notEqual(ngramFingerprint('Whittby'), ngramFingerprint('Whitby'));   // a doubled letter adds a pair (tt)
  assert.notEqual(ngramFingerprint('Bermondsey'), ngramFingerprint('Rotherhithe'));
  assert.notEqual(ngramFingerprint('Ham'), ngramFingerprint('Hum'));
  // Shorter than n: itself, never the empty key every short value would share.
  assert.equal(ngramFingerprint('A'), 'a');
  assert.notEqual(ngramFingerprint('A'), ngramFingerprint('B'));
});

test('phonetic: Cologne phonetics, by its published examples, word by word, never coding a word to nothing', () => {
  assert.equal(cologne('Müller-Lüdenscheidt'), '65752682');
  assert.equal(cologne('Wikipedia'), '3412');
  assert.equal(cologne('Breschnew'), '17863');
  // A digit inside a word with a Latin letter is coded as the letters are: repeated, it is one.
  assert.equal(cologne('a22'), cologne('a2'));
  assert.notEqual(cologne('a23'), cologne('a2'));   // the control: another digit is not
  assert.notEqual(phoneticKey('22'), phoneticKey('2'));   // a word of digits alone is kept whole
  // Sounds alike, spelt differently.
  assert.equal(phoneticKey('Meyer'), phoneticKey('Maier'));
  assert.equal(phoneticKey('Rotherhithe'), phoneticKey('Rotherhith'));
  assert.equal(phoneticKey('Philipstown'), phoneticKey('Filipstown'));
  // Controls: different sounds stay apart; whole words are coded (Soundex's B631 joins these two).
  assert.notEqual(phoneticKey('Bradford'), phoneticKey('Bradfield'));
  assert.notEqual(phoneticKey('Bermondsey'), phoneticKey('Rotherhithe'));
  assert.notEqual(phoneticKey('Newton 2'), phoneticKey('Newton 3'));
  // A word with no Latin letter is kept, so two different Greek names do not collide on nothing.
  assert.notEqual(phoneticKey('Αθήνα'), phoneticKey('Σπάρτη'));
  assert.equal(phoneticKey('Αθήνα'), phoneticKey('ΑΘΗΝΑ'));
  assert.ok(phoneticKey('Αθήνα').length > 0);
  assert.throws(() => clusterKey('x', 'soundex'), /not a way of grouping/);
});

// ---- the clusters ------------------------------------------------------------------------------------
test('clusterValues: clusters of two or more distinct values, members by count, suggested the most frequent (a tie: the first met)', () => {
  const c = clusterValues(['Rotherhithe', 'ROTHERHITHE.', 'Rotherhithe', 'Bermondsey', 'Rotherhith', '', '   ', 'bermondsey', 'Deptford']);
  assert.deepEqual(c, [
    { key: 'rotherhithe', members: [{ value: 'Rotherhithe', count: 2 }, { value: 'ROTHERHITHE.', count: 1 }], suggested: 'Rotherhithe' },
    { key: 'bermondsey', members: [{ value: 'Bermondsey', count: 1 }, { value: 'bermondsey', count: 1 }], suggested: 'Bermondsey' },
  ]);
  // A tie goes to the first met: the same values in the other order suggest the other spelling.
  assert.equal(clusterValues(['bermondsey', 'Bermondsey'])[0].suggested, 'bermondsey');
  // One distinct value repeated is no cluster; nor is a value alone (Deptford above).
  assert.deepEqual(clusterValues(['Deptford', 'Deptford']), []);
  assert.equal(clusterValues(['Rotherhithe', 'Rotherhith'], { method: 'ngram-fingerprint' }).length, 1);
  assert.equal(clusterValues(['Rotherhithe', 'Rotherhith'], { method: 'fingerprint' }).length, 0);
});

test('clusterValues is deterministic: the same values in any order give the same clusters in the same order', () => {
  const values = [];
  for (let i = 0; i < 200; i++) values.push(['Rotherhithe', 'ROTHERHITHE', 'Bermondsey', 'BERMONDSEY', 'Upper Newton', 'Newton Upper', 'Deptford'][i % 7] + (i % 3 ? '' : '.'));
  let seed = 7;
  const shuffled = [...values].sort(() => ((seed = (seed * 16807) % 2147483647) % 3) - 1);
  assert.notDeepEqual(shuffled, values);
  for (const method of ['fingerprint', 'ngram-fingerprint', 'phonetic']) {
    const a = clusterValues(values, { method }), b = clusterValues(values, { method }), c = clusterValues(shuffled, { method });
    assert.deepEqual(a, b, method);
    // The order of the clusters and the counts do not depend on the order read; only a tie's suggestion may.
    assert.deepEqual(c.map((x) => [x.key, x.members.map((m) => m.value).sort(), x.members.map((m) => m.count).sort()]), a.map((x) => [x.key, x.members.map((m) => m.value).sort(), x.members.map((m) => m.count).sort()]), method);
    assert.ok(a.length >= 3, method);
  }
});

test('a large column (100,000 values) is clustered in reasonable time and memory: a Map by key', () => {
  const t0 = performance.now(), m0 = process.memoryUsage().heapUsed;
  const c = clusterCounter({ method: 'fingerprint' });
  for (let i = 0; i < 100_000; i++) c.add(i % 2 ? `Place ${(i >> 1) % 5000}` : `PLACE ${(i >> 1) % 5000}.`);
  const clusters = c.clusters();
  const ms = performance.now() - t0, mb = (process.memoryUsage().heapUsed - m0) / 2 ** 20;
  assert.equal(c.distinct, 10_000);
  assert.equal(clusters.length, 5000);
  assert.ok(clusters.every((x) => x.members.length === 2 && x.members[0].count + x.members[1].count === 20));
  assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);
  assert.ok(mb < 200, `${mb.toFixed(0)} MB`);
});

// ---- nothing applied without a tick; a ticked group applied --------------------------------------------
test('the groups shown are applied only when ticked: unticked, no lookup spelling and no note', () => {
  const shown = [{ ticked: false, chosen: 'Rotherhithe', members: [{ value: 'Rotherhithe' }, { value: 'Rotherhith' }] }, { ticked: true, chosen: 'Bermondsey', members: ['Bermondsey', 'bermondsey'] }];
  const c = confirmedGroups('name', 'fingerprint', shown);
  assert.deepEqual(Object.keys(c), ['name']);
  assert.deepEqual(c.name.groups, [{ chosen: 'Bermondsey', members: ['Bermondsey', 'bermondsey'] }]);
  assert.equal(Object.keys(confirmedGroups('name', 'fingerprint', shown.map((g) => ({ ...g, ticked: false })))).length, 0);
  // A ticked group with no spelling chosen is not applied either.
  assert.equal(Object.keys(confirmedGroups('name', 'fingerprint', [{ ticked: true, chosen: '  ', members: ['a', 'A'] }])).length, 0);
  // Another column's groups are kept; this column's replaced whole.
  const both = confirmedGroups('parish', 'fingerprint', [{ ticked: true, chosen: 'St Mary', members: ['St Mary', 'St. Mary'] }], c);
  assert.deepEqual(Object.keys(both).sort(), ['name', 'parish']);
});

test('read with no groups: no event has a lookup spelling, and the names are the source\'s', async () => {
  const { events } = await read(CSV);
  assert.equal(events.length, 5);
  assert.ok(events.every((e) => !('lookupName' in e) && !('lookupValues' in e)));
  assert.ok(events.every((e) => !String(e.value.attestations[0].notes || '').includes('Grouped for lookup')));
  assert.deepEqual(events.map((e) => e.value.label), ['Rotherhithe', 'Rotherhith', 'ROTHERHITHE.', 'Rotherhithe', 'Bermondsey']);
  // The control, in the same test: the same file read with the group ticked has them.
  const ticked = await read(CSV, { clusters: GROUPS });
  assert.equal(ticked.events.filter((e) => e.lookupName === 'Rotherhithe').length, 4);
});

test('read with a ticked group: lookupName on the event, the note on the attestation, the PLATO name still the source\'s', async () => {
  const { events, items } = await read(CSV, { clusters: GROUPS });
  const [r1, r2, r3, r4, r5] = events;
  for (const e of [r1, r2, r3, r4]) { assert.equal(e.lookupName, 'Rotherhithe'); assert.equal(e.lookupValues.name, 'Rotherhithe'); }
  // The source's spellings, in the label and the name, unchanged.
  assert.deepEqual([r1, r2, r3, r4].map((e) => e.value.label), ['Rotherhithe', 'Rotherhith', 'ROTHERHITHE.', 'Rotherhithe']);
  assert.deepEqual(toponyms(r2), ['Rotherhith']);
  assert.deepEqual(toponyms(r3), ['ROTHERHITHE.']);
  // The note is a line of its own after the row's other notes (the parish column is kept as one).
  assert.equal(r2.value.attestations[0].notes, 'parish: St. Mary\nGrouped for lookup with: ROTHERHITHE., Rotherhithe (spelling chosen: Rotherhithe)');
  assert.equal(r1.value.attestations[0].notes, 'parish: St Mary\nGrouped for lookup with: Rotherhith, ROTHERHITHE. (spelling chosen: Rotherhithe)');
  // Not a member: nothing (the control for the four above).
  assert.ok(!('lookupName' in r5));
  assert.equal(r5.value.attestations[0].notes, 'parish: St Mary');
  assert.equal(items.filter((i) => i.severity === 'error').length, 0);
});

test('a grouped column that is not the name gives a per-column lookup value, not lookupName; a column the file lacks is warned of', async () => {
  const parish = { parish: { method: 'fingerprint', groups: [{ chosen: 'St Mary', members: ['St Mary', 'St. Mary'] }] }, county: { groups: [{ chosen: 'Surrey', members: ['Surrey', 'Surry'] }] } };
  const { events, items } = await read(CSV, { clusters: parish });
  const [r1, r2, r3] = events;
  assert.equal(r2.lookupValues.parish, 'St Mary');
  assert.ok(!('lookupName' in r2));
  assert.match(r2.value.attestations[0].notes, /^parish: St\. Mary\nThe column "parish" grouped for lookup with: St Mary \(spelling chosen: St Mary\)$/);
  assert.equal(r1.lookupValues.parish, 'St Mary');
  assert.ok(!('lookupValues' in r3));   // Saint Mary is in no group
  assert.ok(items.some((i) => i.kind === 'generic-clusters-unknown-column' && i.severity === 'warning' && i.examples.includes('county')));
});

test('groups that cannot be used are refused, saying why', () => {
  assert.throws(() => checkClusters([]), /one JSON object/);
  assert.throws(() => checkClusters({ name: { groups: 'x' } }), /list of "groups"/);
  assert.throws(() => checkClusters({ name: { groups: [{ chosen: '', members: ['a'] }] } }), /Group 1/);
  assert.throws(() => checkClusters({ name: { method: 'soundex', groups: [] } }), /not a way of grouping/);
  assert.throws(() => checkClusters({ name: { groups: [{ chosen: 'A', members: ['a', 'b'] }, { chosen: 'B', members: ['b '] }] } }), /in two groups/);
  // The control: the same shape, well made, is taken.
  assert.equal(checkClusters({ name: { groups: [{ chosen: 'A', members: ['a', 'b'] }, { chosen: 'B', members: ['c'] }] } }).name.method, 'fingerprint');
  // A column called __proto__ is a column.
  assert.ok(Object.hasOwn(checkClusters(JSON.parse('{"__proto__": {"groups": [{"chosen": "A", "members": ["a"]}]}}')), '__proto__'));
  assert.equal(lookupSpellings(undefined).columns.length, 0);
});

// ---- saving and loading -----------------------------------------------------------------------------
test('saved and loaded: the groups ride beside the mapping in { columns, clusters }, which no column heading can clash with', async () => {
  const mapping = { id: 'id', name: 'name', parish: 'note', lat: 'latitude', lon: 'longitude' };
  // No group ticked: the mapping is saved alone, as before.
  assert.deepEqual(matchingToSave(mapping, {}), mapping);
  const text = JSON.stringify(matchingToSave(mapping, GROUPS));
  const back = JSON.parse(text);
  assert.ok(isMatchingEnvelope(back));
  assert.deepEqual(splitMatching(back).columns, mapping);
  assert.deepEqual(checkClusters(clustersInFile(back)), checkClusters(GROUPS));
  // The run's options read the envelope's mapping, never the envelope as a mapping.
  assert.deepEqual(savedColumns(back), mapping);
  const headers = Object.keys(mapping);
  assert.deepEqual(resolveColumns(headers, [], splitMatching(back).columns).problems, []);
  // The control: the envelope given as a mapping would be wrong, column by column.
  assert.ok(resolveColumns(headers, [], back).problems.length > 0);
  // A file whose columns are called "columns" and "clusters" is still a mapping, not an envelope.
  const odd = { columns: 'name', clusters: 'note' };
  assert.ok(!isMatchingEnvelope(odd));
  assert.deepEqual(splitMatching(odd).columns, odd);
  // Applied after the round trip exactly as before it.
  const a = await read(CSV, { clusters: GROUPS }), b = await read(CSV, { columns: splitMatching(back).columns, clusters: clustersInFile(back) });
  assert.deepEqual(b.events.map((e) => [e.lookupName, e.value]), a.events.map((e) => [e.lookupName, e.value]));
  assert.equal(b.events.filter((e) => e.lookupName).length, 4);
  // { clusters } alone, and the clusters alone, are read alike; so is a column called "clusters".
  assert.deepEqual(clustersInFile({ clusters: GROUPS }), GROUPS);
  assert.deepEqual(clustersInFile(GROUPS), GROUPS);
  const col = { clusters: { groups: [{ chosen: 'A', members: ['a'] }] } };
  assert.deepEqual(clustersInFile(col), col);
});

// Columns headed "field", "columns" and "clusters": the envelope is still told from a mapping.
const ODD_CSV = 'id,field,columns,clusters,name,lat,lon\n1,a,b,c,Rotherhithe,51.5,-0.05\n2,a,b,c,Rotherhith,51.5,-0.05\n3,a,b,c,Bermondsey,51.49,-0.07\n';
const ODD_MAPPING = { id: 'id', field: 'note', columns: 'note', clusters: 'note', name: 'name', lat: 'latitude', lon: 'longitude' };
const ODD_GROUPS = { name: { method: 'fingerprint', groups: [{ chosen: 'Rotherhithe', members: ['Rotherhithe', 'Rotherhith'] }] } };

test('a saved matching for a table with columns headed "field", "columns" and "clusters" is still read as { columns, clusters }', async () => {
  // The control: an ordinary heading in place of each.
  for (const [heading, why] of [['field', 'a column headed "field"'], ['columns', 'a column headed "columns"'], ['clusters', 'a column headed "clusters"'], ['parish', 'the control: an ordinary heading']]) {
    const mapping = { id: 'id', [heading]: 'note', name: 'name' };
    const saved = JSON.parse(JSON.stringify(matchingToSave(mapping, ODD_GROUPS)));
    assert.ok(isMatchingEnvelope(saved), why);
    assert.deepEqual(splitMatching(saved).columns, mapping, why);
    assert.deepEqual(clustersInFile(saved), ODD_GROUPS, why);
    assert.deepEqual(savedColumns({ columns: mapping, clusters: ODD_GROUPS }), mapping, why);
    assert.deepEqual(savedColumns({ columns: mapping, base: undefined }), mapping, why);
    assert.deepEqual(savedColumns({ columns: mapping }), mapping, why);   // options holding the mapping alone
  }
  // All three at once, through the reader: the groups applied, the mapping's columns kept as notes.
  const saved = JSON.parse(JSON.stringify(matchingToSave(ODD_MAPPING, ODD_GROUPS)));
  const { columns, clusters } = splitMatching(saved);
  assert.deepEqual(columns, ODD_MAPPING);
  const { events } = await read(ODD_CSV, { columns, clusters: clustersInFile(saved) });
  assert.equal(events.filter((e) => e.lookupName === 'Rotherhithe').length, 2);
  assert.match(events[0].value.attestations[0].notes, /^field: a\ncolumns: b\nclusters: c\nGrouped for lookup/);
  assert.ok(!('lookupName' in events[2]));
  // A mapping alone stays a mapping, whatever its columns are called, a pattern's entry included.
  const alone = [
    { columns: 'name', clusters: 'note' },
    { columns: { field: 'address', pattern: 'https://pleiades.stoa.org/places/{id}' }, clusters: 'note', name: 'name' },
    { columns: { field: 'address', pattern: 'https://pleiades.stoa.org/places/{id}' }, clusters: { field: 'note' } },
    { field: 'note', columns: { field: 'name' }, name: 'name' },
  ];
  for (const m of alone) {
    assert.ok(!isMatchingEnvelope(m), JSON.stringify(m));
    assert.deepEqual(splitMatching(m).columns, m);
    assert.equal(savedColumns(m), m, JSON.stringify(m));
  }
  // An entry is told exactly: { field, pattern } only, of strings.
  assert.ok(isMappingEntry('name') && isMappingEntry({ field: 'name' }) && isMappingEntry({ field: 'address', pattern: 'x{id}' }));
  for (const v of [{ field: 'note', name: 'name' }, { field: 'address', pattern: 3 }, { field: 1 }, [], null, { name: { groups: [] } }]) assert.ok(!isMappingEntry(v), JSON.stringify(v));
});

test('convert --columns F --clusters F with F saved for a table with a column headed "field": the mapping and the groups both used', () => {
  const d = scratch(), f = join(d, 'odd.csv'), g = join(d, 'odd.json');
  writeFileSync(f, ODD_CSV);
  writeFileSync(g, JSON.stringify(matchingToSave(ODD_MAPPING, ODD_GROUPS)));
  const out = scratch();
  const r = cli('convert', '--to', 'plato-json', '--out', out, '--json', '--columns', g, '--clusters', g, f);
  assert.equal(r.code, 0, r.err + r.out);
  const doc = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'));
  const notes = doc.spatialEntities.map((p) => p.attestations[0].notes || '');
  assert.equal(notes.filter((n) => n.includes('(spelling chosen: Rotherhithe)')).length, 2);
  assert.ok(notes.every((n) => n.startsWith('field: a\ncolumns: b\nclusters: c')));
  assert.equal(JSON.parse(r.out.trim().split('\n')[0]).items.filter((i) => /mapping/.test(i.kind)).length, 0);
});

test('columnValues streams one column as the reader reads it, and names the columns for one it lacks', async () => {
  const input = await detect([textFile(CSV, 'r.csv')]);
  const vs = [];
  for await (const v of columnValues(input, 'name')) vs.push(v);
  assert.deepEqual(vs, ['Rotherhithe', 'Rotherhith', 'ROTHERHITHE.', 'Rotherhithe', 'Bermondsey']);
  await assert.rejects(async () => { for await (const v of columnValues(input, 'nom')) void v; }, /no column "nom"; the columns are "id", "name"/);
});

// ---- the command line ---------------------------------------------------------------------------------
test('plato-tools cluster prints the proposed clusters as JSON and applies nothing', () => {
  const d = scratch(), f = join(d, 'r.csv');
  writeFileSync(f, CSV);
  const r = cli('cluster', '--column', 'name', f);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.method, 'fingerprint');
  assert.equal(j.values, 5);
  assert.deepEqual(j.clusters, clusterValues(['Rotherhithe', 'Rotherhith', 'ROTHERHITHE.', 'Rotherhithe', 'Bermondsey']));
  assert.equal(j.clusters.length, 1);
  assert.equal(JSON.parse(cli('cluster', '--column', 'name', '--method', 'ngram-fingerprint', f).out).clusters[0].members.length, 3);
  assert.deepEqual(readdirSync(d), ['r.csv']);   // nothing written
  // Refusals, before anything is read: exit 2, nothing on stdout.
  for (const args of [['cluster', f], ['cluster', '--column', 'name', '--method', 'soundex', f], ['cluster', '--column', 'nom', f], ['check', '--column', 'name', f]]) {
    const x = cli(...args);
    assert.equal(x.code, 2, args.join(' '));
    assert.equal(x.out, '');
  }
});

test('convert --clusters applies the saved groups: the notes are written, the names are the source\'s; without it, nothing', () => {
  const d = scratch(), f = join(d, 'r.csv'), g = join(d, 'groups.json');
  writeFileSync(f, CSV);
  writeFileSync(g, JSON.stringify(matchingToSave({ id: 'id', name: 'name', parish: 'note', lat: 'latitude', lon: 'longitude' }, GROUPS)));
  const convert = (...args) => {
    const out = scratch();
    const r = cli('convert', '--to', 'plato-json', '--out', out, '--json', ...args);
    assert.equal(r.code, 0, r.err + r.out);
    return JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'));
  };
  const withGroups = convert('--clusters', g, f);
  const notes = withGroups.spatialEntities.map((p) => p.attestations[0].notes || '');
  assert.equal(notes.filter((n) => n.includes('(spelling chosen: Rotherhithe)')).length, 4);
  assert.deepEqual(withGroups.spatialEntities.map((p) => p.label), ['Rotherhithe', 'Rotherhith', 'ROTHERHITHE.', 'Rotherhithe', 'Bermondsey']);
  // The control: the same file, as --columns only, applies no group (and says the groups are not used).
  const out = scratch();
  const r = cli('convert', '--to', 'plato-json', '--out', out, '--json', '--columns', g, f);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /used only when the file is given with --clusters/);
  const plain = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'));
  assert.ok(plain.spatialEntities.every((p) => !String(p.attestations[0].notes || '').includes('Grouped for lookup')));
  assert.equal(plain.spatialEntities.length, 5);
  // A malformed groups file is refused before anything is read.
  const bad = join(d, 'bad.json');
  writeFileSync(bad, JSON.stringify({ name: { groups: [{ chosen: 'A', members: ['a'] }, { chosen: 'B', members: ['a'] }] } }));
  const x = cli('convert', '--to', 'plato-json', '--out', scratch(), '--clusters', bad, f);
  assert.equal(x.code, 2);
  assert.match(x.err, /in two groups/);
});

test('--clusters with an input that is not a table of places (TEI, a Recogito export) says, on stderr, that the groups are not used for it', () => {
  const d = scratch(), f = join(d, 'r.csv'), g = join(d, 'groups.json');
  writeFileSync(f, CSV);
  writeFileSync(g, JSON.stringify(GROUPS));
  const tei = fileURLToPath(new URL('./fixtures/tei/keys-constructed.xml', import.meta.url));
  const recogito = fileURLToPath(new URL('./fixtures/annotations/recogito-studio-constructed.json', import.meta.url));
  const said = /not a table of places; the groups of spellings given with --clusters are not used for it/;
  for (const [file, what] of [[tei, 'TEI XML edition'], [recogito, 'W3C Web Annotations']]) {
    for (const args of [['check', '--clusters', g, file], ['preview', '--clusters', g, file], ['convert', '--to', 'plato-json', '--out', scratch(), '--clusters', g, file]]) {
      const r = cli(...args);
      assert.ok(r.code === 0 || r.code === 1, `${args[0]} ${what}: ${r.err}`);
      assert.match(r.err, said, `${args[0]} ${what}`);
      assert.ok(r.err.includes(what), `${args[0]} ${what}`);
      // The control, in the same run: without --clusters, nothing is said.
      const plain = cli(...args.filter((a, i) => a !== '--clusters' && args[i - 1] !== '--clusters'));
      assert.doesNotMatch(plain.err, said);
    }
  }
  // The control: with a table of places, the groups are used and nothing is said; given both, it is said for the other only.
  const t = cli('check', '--clusters', g, f);
  assert.equal(t.code, 0, t.err);
  assert.doesNotMatch(t.err, said);
  const both = cli('check', '--clusters', g, f, tei);
  assert.equal(both.err.match(new RegExp(said, 'g')).length, 1);
  assert.ok(both.err.includes('keys-constructed.xml'));
});
