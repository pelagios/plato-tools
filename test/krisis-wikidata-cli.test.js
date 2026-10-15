// Krisis, Wikidata items on the command line (bin/plato-tools.mjs wikidata search | batch | ids), run as a user
// runs it: a separate process, files on disk, and a stand-in for Wikidata's api.php on 127.0.0.1 (https, with a
// certificate made for the test, given to the command line by NODE_EXTRA_CA_CERTS; --api names it, which the
// command takes only for an address on this computer). Nothing goes further. The flag is the consent: without
// --allow-host, nothing is sent (and the stand-in's log, which fills when it is given, is the control).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWork } from '../src/engine/krisis/work.js';
import { CONSENT } from '../src/engine/krisis/wikidata.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'plato-tools-wikidata-test-')); made.push(d); return d; };
const certDir = scratch(), certFile = join(certDir, 'cert.pem'), keyFile = join(certDir, 'key.pem');
const made_cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
const NO_TLS = made_cert.status === 0 ? false : 'openssl could not make a certificate for the stand-in, so the commands that ask it are not run';
function cli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const X = 'https://w3id.org/cli-mint/';
const P = (id) => `${X}place/${id}`;
const AT = '2026-10-15T12:00:00Z';
const entity = (id, { label = 'Newstead', point = [-1.193, 53.081], reference = P('newstead') } = {}) => ({ id, type: 'item', labels: { en: { language: 'en', value: label } }, descriptions: {}, aliases: {},
  claims: { P31: [{ mainsnak: { snaktype: 'value', property: 'P31', datavalue: { value: { id: 'Q532' }, type: 'wikibase-entityid' } }, references: reference ? [{ snaks: { P854: [{ datavalue: { value: reference, type: 'string' } }] } }] : [] }],
    P625: [{ mainsnak: { snaktype: 'value', property: 'P625', datavalue: { value: { latitude: point[1], longitude: point[0] }, type: 'globecoordinate' } } }] } });
const ENTITIES = { Q77: entity('Q77'), Q78: entity('Q78', { label: 'Kirkby', point: [-1.25, 53.1], reference: P('kirkby') }), Q79: entity('Q79', { label: 'Elsewhere', reference: 'https://elsewhere.example/' }) };
// The stand-in: wbsearchentities, CirrusSearch near a point, wbgetentities, usercontribs; every request kept.
const requests = [];
const server = NO_TLS ? null : createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, (req, res) => {
  const u = new URL(req.url, 'https://127.0.0.1'), p = u.searchParams;
  requests.push({ url: req.url, headers: req.headers, action: p.get('action'), list: p.get('list') });
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (p.get('action') === 'wbsearchentities') return json({ search: p.get('search') === 'Newstead' ? [{ id: 'Q77', label: 'Newstead' }] : [] });
  if (p.get('action') === 'query' && p.get('list') === 'search') return json({ query: { search: [] } });
  if (p.get('action') === 'wbgetentities') return json({ entities: Object.fromEntries(p.get('ids').split('|').map((id) => [id, ENTITIES[id] || { id, missing: '' }])) });
  if (p.get('action') === 'query' && p.get('list') === 'usercontribs') return json({ query: { usercontribs: [{ title: 'Q78', timestamp: '2026-10-15T13:00:00Z', comment: '' }, { title: 'Q79', timestamp: '2026-10-15T13:01:00Z', comment: '' }] } });
  res.writeHead(404); res.end('{}');
});
let api;
before(async () => { if (server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); api = `https://127.0.0.1:${server.address().port}/w/api.php`; } });
after(() => { server?.close(); for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** The dataset (CC BY, published) and the review after a WHG lookup: Newstead and Kirkby with no match, Linby linked. */
function fixture({ licence = 'https://creativecommons.org/licenses/by/4.0/', searched = false } = {}) {
  const dir = scratch();
  const src = { '@id': `${X}source/survey`, title: 'The 1296 survey', authorityType: 'source' };
  const att = (o) => ({ contributor: { name: 'A. Editor' }, created: AT, ...o });
  const place = (id, label, lon, lat, more = {}) => ({ '@id': P(id), label, ccodes: ['GB'], attestations: [att({ names: [{ toponym: label, language: 'en' }], types: [{ label: 'village' }], geometries: [{ geojson: { type: 'Point', coordinates: [lon, lat] } }], citations: [{ source: src }], ...more })] });
  writeFileSync(join(dir, 'trent.json'), JSON.stringify({ profile: 'place-centric', gazetteer: { '@id': X, uriSpace: X, title: 'Lost places of the Trent', licence, status: 'published', creator: [{ name: 'A. Editor' }] },
    spatialEntities: [place('newstead', 'Newstead', -1.193, 53.081, { timespans: [{ startEarliest: '1296', endLatest: '1540' }] }), place('kirkby', 'Kirkby', -1.25, 53.1),
      place('linby', 'Linby', -1.2, 53.05, { identities: [{ subject: P('linby'), object: 'https://sws.geonames.org/2644510/', identityType: 'exactMatch' }] })] }));
  const q = (iris) => Object.fromEntries(iris.map((iri) => [iri, { state: 'answered', sent: [iri.split('/').pop()], found: 0, added: 0 }]));
  const places = { [P('newstead')]: { label: 'Newstead', names: ['Newstead'], point: [-1.193, 53.081], ccodes: ['GB'], types: ['village'] }, [P('kirkby')]: { label: 'Kirkby', names: ['Kirkby'], point: [-1.25, 53.1], ccodes: ['GB'], types: ['village'] }, [P('linby')]: { label: 'Linby', names: ['Linby'], point: [-1.2, 53.05], ccodes: ['GB'] } };
  const all = Object.keys(places);
  const work = { krisis: 3, generated_at: AT, algorithm_version: 'krisis-lookup 1', match_parameters: {}, subjects: { title: 'Lost places of the Trent', uri: X, files: [] }, others: null, places, regions: {}, candidates: [], reviewer: { name: 'Lu Reviewer' }, cursor: 0,
    lookups: [{ id: 'l1', service: { endpoint: 'https://whgazetteer.org/reconcile/', title: 'World Historical Gazetteer', uri: 'https://whgazetteer.org/' }, started_at: AT, finished_at: AT, algorithm_version: 'krisis-lookup 1', parameters: {}, attribution: null, counts: {}, stopped: null, queries: q(all) },
      ...(searched ? [{ id: 'l2', service: { endpoint: 'https://www.wikidata.org/w/api.php', title: 'Wikidata', uri: 'https://www.wikidata.org/' }, started_at: AT, finished_at: AT, algorithm_version: 'krisis-wikidata 1', parameters: {}, attribution: null, counts: {}, stopped: null, queries: q(all) }] : [])] };
  writeFileSync(join(dir, 'trent.krisis.json'), JSON.stringify(work, null, 2));
  return dir;
}
const workOf = (dir) => readWork(readFileSync(join(dir, 'trent.krisis.json'), 'utf8'));

test('search: a dry run says what would be sent and sends nothing; without --allow-host nothing is sent either, in words; with it, the stand-in is asked, the hit goes into the review, and the search is recorded', { skip: NO_TLS }, async () => {
  const dir = fixture();
  requests.length = 0;
  const dry = await cli(['wikidata', 'search', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--dry-run']);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /Would search 2 places in Wikidata: 2 names, and items within 5 km of 2 points \(this sends their coordinates\), in 6 requests, one at a time\./);
  const refused = await cli(['wikidata', 'search', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--api', api]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /give --allow-host wikidata, the consent to ask it/);
  assert.equal(requests.length, 0, 'nothing sent');
  assert.deepEqual(workOf(dir).lookups.length, 1, 'nothing recorded');
  const run = await cli(['wikidata', 'search', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--api', api, '--allow-host', `https://127.0.0.1:${server.address().port}`, '--allow-host', 'wikidata']);
  assert.equal(run.code, 0, run.out + run.err);
  assert.deepEqual(requests.map((r) => r.action + (r.list ? `:${r.list}` : '')), ['wbsearchentities', 'query:search', 'wbgetentities', 'wbsearchentities', 'query:search'], 'control: the run sends, in series, the entities fetched once where something was found');
  assert.ok(requests.every((r) => r.url.includes('origin=*') && r.headers['api-user-agent']?.startsWith('plato-tools/')), JSON.stringify(requests[0].headers));
  assert.match(run.out, /Searched 2 places in Wikidata: 2 places were answered, 1 with nothing found, 1 hit added to the review\./);
  assert.match(run.out, /1 place has a Wikidata hit still to decide/);
  const w = workOf(dir);
  assert.equal(w.lookups.length, 2);
  assert.equal(w.lookups[1].service.title, 'Wikidata');
  assert.deepEqual(w.candidates.map((c) => [c.candidate_source, c.candidate_candidate]), [[P('newstead'), 'http://www.wikidata.org/entity/Q77']]);
  // Linby, linked to GeoNames, was not searched; the hit's place is undecided, Kirkby answered with nothing.
  assert.deepEqual(Object.keys(w.lookups[1].queries).sort(), [P('kirkby'), P('newstead')]);
});

test('batch: a CC BY dataset needs --consent (recorded with the name and the date); the batch is written and recorded; NC is refused; --statements narrows it', { skip: false }, async () => {
  const dir = fixture({ searched: true });
  const no = await cli(['wikidata', 'batch', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--out', dir]);
  assert.equal(no.code, 2, no.out + no.err);
  assert.match(no.out, /give --consent, with --reviewer, to state: I hold the rights in this dataset/);
  assert.ok(!existsSync(join(dir, 'trent.wikidata.qs.txt')), 'nothing written');
  const noName = await cli(['wikidata', 'batch', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--out', dir, '--consent']);
  assert.equal(noName.code, 2); assert.match(noName.out, /--consent needs --reviewer/);
  const email = await cli(['wikidata', 'batch', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--out', dir, '--consent', '--reviewer', 'lu@example.org']);
  assert.equal(email.code, 2); assert.match(email.err, /address with @ in it, which is never written/);
  const ok = await cli(['wikidata', 'batch', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--out', dir, '--consent', '--reviewer', 'Lu Reviewer']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /Confirmed by Lu Reviewer on \d{4}-\d{2}-\d{2}, for the dataset's licence CC-BY-4\.0\./);
  assert.match(ok.out, /2 items, 10 statements\./);
  assert.match(ok.out, /Batch q1 written: trent\.wikidata\.qs\.txt \(2 items\)/);
  assert.match(ok.out, /1\. Open QuickStatements/);
  assert.match(ok.out, /Left out: 1 place linked to a gazetteer record already\./);
  const text = readFileSync(join(dir, 'trent.wikidata.qs.txt'), 'utf8');
  const lines = text.split('\n');
  assert.equal(lines[0], `CREATE /* PLATO tools: Lost places of the Trent; ${P('newstead')} */`);
  assert.equal(lines[1], 'LAST\tLen\t"Newstead"');
  assert.match(lines[2], /^LAST\tDen\t"village in United Kingdom, attested 1296–1540"$/);
  assert.match(lines[3], new RegExp(`^LAST\\tP31\\tQ532\\tS854\\t"${P('newstead')}"\\tS813\\t\\+\\d{4}-\\d{2}-\\d{2}T00:00:00Z/11$`));
  assert.match(lines[4], /^LAST\tP625\t@53\.081\/-1\.193\tS854/);
  assert.match(lines[5], /^LAST\tP17\tQ145\tS854/);
  assert.ok(lines.filter((l) => l.startsWith('CREATE')).length === 2 && !text.includes('P131'), 'no region: no P131');
  const w = workOf(dir);
  assert.equal(w.mint.consent.statement, CONSENT);
  assert.deepEqual(w.mint.consent.by, { name: 'Lu Reviewer' });
  assert.deepEqual(w.mint.batches.map((b) => [b.id, b.places, b.items, b.name]), [['q1', [P('newstead'), P('kirkby')], 2, 'trent.wikidata.qs.txt']]);
  // Written again without --overwrite: refused; with --statements, only those.
  const again = await cli(['wikidata', 'batch', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--out', dir]);
  assert.equal(again.code, 2); assert.match(again.out, /already exists/);
  const fewer = await cli(['wikidata', 'batch', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--out', dir, '--overwrite', '--statements', 'labels,p31']);
  assert.equal(fewer.code, 0, fewer.out + fewer.err);
  const t2 = readFileSync(join(dir, 'trent.wikidata.qs.txt'), 'utf8');
  assert.ok(!t2.includes('P625') && !t2.includes('Den') && t2.includes('P31') && t2.includes('Len'), t2);
  assert.equal(workOf(dir).mint.batches.length, 2);
  const bad = await cli(['wikidata', 'batch', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--out', dir, '--overwrite', '--statements', 'labels,p99']);
  assert.equal(bad.code, 2); assert.match(bad.err, /p99 is not one of/);
  // A licence for non-commercial use is refused, with the reason, and nothing written; one with no search yet has nothing to write.
  const nc = fixture({ licence: 'https://creativecommons.org/licenses/by-nc/4.0/', searched: true });
  const r = await cli(['wikidata', 'batch', join(nc, 'trent.json'), '--review', join(nc, 'trent.krisis.json'), '--out', nc, '--consent', '--reviewer', 'Lu Reviewer']);
  assert.equal(r.code, 2); assert.match(r.out, /No batch can be made from this dataset: its licence \(CC-BY-NC-4\.0\) allows no commercial use/);
  assert.ok(!existsSync(join(nc, 'trent.wikidata.qs.txt')));
  const unsearched = fixture();
  const u = await cli(['wikidata', 'batch', join(unsearched, 'trent.json'), '--review', join(unsearched, 'trent.krisis.json'), '--out', unsearched, '--consent', '--reviewer', 'Lu Reviewer']);
  assert.equal(u.code, 1, 'a problem with the data, not with the command'); assert.match(u.out, /No place qualifies for an item yet/); assert.match(u.out, /2 places not yet searched in Wikidata/);
});

test('ids: pasted Q-ids are checked in the stand-in before being recorded, the user\'s new items read and matched by their reference, each said; apply then writes the identities', { skip: NO_TLS }, async () => {
  const dir = fixture({ searched: true });
  const b = await cli(['wikidata', 'batch', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--out', dir, '--consent', '--reviewer', 'Lu Reviewer']);
  assert.equal(b.code, 0, b.out + b.err);
  writeFileSync(join(dir, 'qids.txt'), 'Q77\nQ4242\n');
  const allow = ['--api', api, '--allow-host', `https://127.0.0.1:${server.address().port}`, '--allow-host', 'wikidata'];
  const noName = await cli(['wikidata', 'ids', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--qids', join(dir, 'qids.txt'), ...allow]);
  assert.equal(noName.code, 2); assert.match(noName.err, /needs --reviewer/);
  requests.length = 0;
  const refused = await cli(['wikidata', 'ids', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--qids', join(dir, 'qids.txt'), '--reviewer', 'Lu Reviewer', '--api', api]);
  assert.equal(refused.code, 2); assert.match(refused.err, /checking the Q-ids in Wikidata sends requests to it/);
  assert.equal(requests.length, 0, 'nothing sent without the consent');
  // Pasted: Q77 is Newstead's (verified), Q4242 does not exist: Kirkby's row gets nothing.
  const pasted = await cli(['wikidata', 'ids', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--qids', join(dir, 'qids.txt'), '--reviewer', 'Lu Reviewer', ...allow]);
  assert.equal(pasted.code, 1, pasted.out + pasted.err);
  assert.deepEqual(requests.map((r) => r.action), ['wbgetentities'], 'control: one read, of both ids');
  assert.match(pasted.out, /2 ids set against the batch's rows\./);
  assert.match(pasted.out, new RegExp(`${P('newstead')}: Q77 Verified: the label, the point \\(0 km away\\), and the reference to this place\\.`));
  assert.match(pasted.out, new RegExp(`${P('kirkby')}: Q4242 Not recorded: there is no such item in Wikidata\\.`));
  assert.match(pasted.out, /1 identity recorded in the review/);
  let w = workOf(dir);
  assert.deepEqual(Object.entries(w.mint.qids).map(([iri, r]) => [iri, r.qid, r.how]), [[P('newstead'), 'Q77', 'pasted']]);
  const minted = w.lookups.find((l) => l.parameters?.minted);
  assert.ok(minted && w.candidates.some((c) => c.lookup === minted.id && c.candidate_candidate === 'http://www.wikidata.org/entity/Q77' && c.decision?.kind === 'match'));
  // The user's own new items: Q78 carries Kirkby's reference (recorded), Q79 none of the batch's (left).
  requests.length = 0;
  const mine = await cli(['wikidata', 'ids', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--user', 'Lu Reviewer', '--reviewer', 'Lu Reviewer', ...allow]);
  assert.equal(mine.code, 0, mine.out + mine.err);
  assert.deepEqual(requests.map((r) => r.action + (r.list ? `:${r.list}` : '')), ['query:usercontribs', 'wbgetentities']);
  assert.ok(requests[0].url.includes('ucuser=Lu+Reviewer') && requests[0].url.includes(`ucstart=${encodeURIComponent(workOf(dir).mint.batches[0].at)}`), requests[0].url);
  assert.match(mine.out, /2 new items since the batch was written; 1 of them carries a reference to a place of the batch\./);
  assert.match(mine.out, new RegExp(`${P('kirkby')}: Q78 Verified`));
  w = workOf(dir);
  assert.deepEqual(Object.entries(w.mint.qids).map(([iri, r]) => [iri, r.qid, r.how]), [[P('newstead'), 'Q77', 'pasted'], [P('kirkby'), 'Q78', 'contribs']]);
  assert.equal(w.mint.user, 'Lu Reviewer');
  const atEmail = await cli(['wikidata', 'ids', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--user', 'lu@example.org', '--reviewer', 'Lu Reviewer', ...allow]);
  assert.equal(atEmail.code, 2); assert.match(atEmail.err, /never an address with @ in it/);
  // Then apply writes the two identities into the dataset, citing Wikidata, as a pure addition.
  const a = await cli(['apply', join(dir, 'trent.json'), '--review', join(dir, 'trent.krisis.json'), '--reviewer', 'Lu Reviewer', '--out', dir, '--json']);
  assert.equal(a.code, 0, a.out + a.err);
  const j = JSON.parse(a.out.trim().split('\n')[0]);
  assert.equal(j.counts.attestations, 2);
  assert.deepEqual([j.counts.versionCheck.added, j.counts.versionCheck.changed, j.counts.versionCheck.lost], [2, 0, 0]);
  const out = JSON.parse(readFileSync(join(dir, 'trent.krisis-dataset.json'), 'utf8'));
  const n = out.spatialEntities.find((p) => p['@id'] === P('newstead'));
  const id = n.attestations.find((x) => x.identities);
  assert.deepEqual(id.identities[0].object, 'http://www.wikidata.org/entity/Q77');
  assert.equal(id.citations[0].source.title, 'Wikidata');
  assert.match(id['@id'], new RegExp(`^${P('newstead')}#a-[0-9a-f]{8}`));
  assert.ok(!JSON.stringify(out).includes('@example'), 'no address with @ anywhere');
});
