// A source's own stance (plato:source_stance, JSON sourceStance, tables stance) and a source's licence
// (dcterms:license, JSON licence on a source, tables licence on sources), PLATO 6ffd1b6. Both came from
// the markets corpus: Blome 1673 passes claims on without vouching for them, and the project admits
// sources by their licence.
import { PLATO_REPO } from './paths.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import Papa from 'papaparse';
import { file, textFile, outText, go } from './engine.js';

const P = 'https://w3id.org/plato#', LICENSE = 'http://purl.org/dc/terms/license', PDM = 'https://creativecommons.org/publicdomain/mark/1.0/';
const JUDGEMENTS = `${PLATO_REPO}/schemas/examples/place-centric-judgements.json`;
const items = (r, sev) => r.report.items.filter((i) => i.severity === sev);
const kinds = (r, sev) => items(r, sev).map((i) => i.kind);
const doc = () => JSON.parse(readFileSync(JUDGEMENTS, 'utf8'));
const kingsbury = (d) => d.spatialEntities.find((e) => e['@id'].endsWith('/kingsbury'));

test('JSON -> RDF: the stance is on the attestation and the licence on the source, both as IRIs', async () => {
  const nt = outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt');
  const stance = nt.split('\n').filter((l) => l.includes('#source_stance>'));
  assert.equal(stance.length, 2, nt);
  for (const l of stance) {
    const subj = l.split(' ')[0];
    assert.ok(nt.includes(`${subj} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${P}Attestation>`) || nt.includes(`${subj} <${P}attests_about>`), `the stance is on an attestation: ${l}`);
  }
  assert.ok(stance.some((l) => l.includes(`<${P}StanceReported>`)) && stance.some((l) => l.includes(`<${P}StanceDoubted>`)));
  assert.match(nt, new RegExp(`<https://whgazetteer\\.org/example/source/county-description-1673> <${LICENSE}> <${PDM.replace(/[./]/g, '\\$&')}> \\.`));
});

test('RDF -> JSON gives both back, and a second pass is identical', async () => {
  const nt1 = outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt');
  const b = await go([textFile(nt1, 'j.nt')], 'convert', 'plato-jsonl');
  assert.deepEqual(items(b, 'loss'), []);
  const recs = outText(b.e, 'j.jsonl').trim().split('\n').slice(1).map((l) => JSON.parse(l));
  const k = recs.find((x) => x['@id'].endsWith('/kingsbury'));
  assert.deepEqual(k.attestations.map((a) => a.sourceStance).sort(), [P + 'StanceDoubted', P + 'StanceReported']);
  assert.ok(JSON.stringify(k).includes(`"licence":"${PDM}"`), JSON.stringify(k));
  const nt2 = outText((await go([textFile(outText(b.e, 'j.jsonl'), 'j2.jsonl')], 'convert', 'ntriples')).e, 'j2.nt');
  const named = (t) => new Set(t.split('\n').filter((l) => l && !l.startsWith('_:')));
  const [s1, s2] = [named(nt1), named(nt2)];
  assert.deepEqual([...s1].filter((l) => !s2.has(l)), [], 'lost');
  assert.deepEqual([...s2].filter((l) => !s1.has(l)), [], 'added');
});

test('LPF has no place for either: both are reported, and the reported market is still written', async () => {
  const r = await go([file(JUDGEMENTS)], 'convert', 'lpf');
  assert.ok(kinds(r, 'loss').includes('dropped:attestation.sourceStance'), kinds(r, 'loss'));
  assert.ok(kinds(r, 'loss').includes('dropped:source.licence'), kinds(r, 'loss'));
  assert.match(items(r, 'loss').find((i) => i.kind === 'dropped:attestation.sourceStance').message, /as if the source simply asserted it/);
  const fc = JSON.parse(outText(r.e, 'place-centric-judgements.geojson'));
  const f = fc.features.find((x) => x['@id'].endsWith('/kingsbury'));
  assert.equal(f.types.length, 2, 'unlike a denial, a stance does not leave the attestation out');
});

test('control: without a stance or a licence, LPF reports neither', async () => {
  const d = doc(); for (const a of kingsbury(d).attestations) { delete a.sourceStance; for (const c of a.citations) delete c.source.licence; }
  const r = await go([textFile(JSON.stringify(d), 'plain.json')], 'convert', 'lpf');
  assert.ok(!kinds(r, 'loss').includes('dropped:attestation.sourceStance'));
  assert.ok(!kinds(r, 'loss').includes('dropped:source.licence'));
});

test('the tables write the stance by its word and the licence on the source row, and read them back', async () => {
  const a = await go([file(JUDGEMENTS)], 'convert', 'tables');
  assert.ok(!kinds(a, 'loss').some((k) => /sourceStance|licence/.test(k)), kinds(a, 'loss'));
  const zip = unzipSync(a.e.outs['place-centric-judgements-tables.zip'][0]);
  const rows = (n) => Papa.parse(strFromU8(zip[n]), { header: true, skipEmptyLines: true }).data;
  assert.deepEqual(rows('types.csv').filter((x) => x.place_id === 'kingsbury').map((x) => x.stance).sort(), ['Doubted', 'Reported']);
  assert.equal(rows('sources.csv').find((x) => x.source_id === 'county-description-1673').licence, PDM);
  const b = await go([textFile(JSON.stringify(doc()), 'x.json')], 'convert', 'tables');
  const back = await go([new File([b.e.outs['x-tables.zip'][0]], 'x.zip')], 'convert', 'plato-json');
  assert.deepEqual(items(back, 'error'), []);
  const d = JSON.parse(outText(back.e, Object.keys(back.e.outs)[0]));
  const atts = d.spatialEntities.flatMap((x) => x.attestations || []);
  assert.deepEqual(atts.map((x) => x.sourceStance).filter(Boolean).sort(), [P + 'StanceDoubted', P + 'StanceReported']);
  assert.ok(JSON.stringify(d).includes(`"licence":"${PDM}"`));
});

test("a stance that is not one of PLATO's words is reported by the tables, not written", async () => {
  const d = doc(); kingsbury(d).attestations[0].sourceStance = 'https://example.org/stance/hearsay';
  const r = await go([textFile(JSON.stringify(d), 's.json')], 'convert', 'tables');
  assert.ok(kinds(r, 'loss').includes('dropped:attestation.sourceStance'), kinds(r, 'loss'));
  const zip = unzipSync(r.e.outs['s-tables.zip'][0]);
  // Both of Kingsbury's markets are written: this one without its stance, the other with PLATO's word.
  const types = Papa.parse(strFromU8(zip['types.csv']), { header: true, skipEmptyLines: true }).data;
  assert.deepEqual(types.filter((x) => x.place_id === 'kingsbury').map((x) => [x.type_label, x.stance]), [['market', ''], ['market', 'Doubted']]);
  assert.doesNotMatch(strFromU8(zip['types.csv']), /hearsay/);
});

test('the check rejects a licence written in words', async () => {
  const d = doc(); kingsbury(d).attestations[0].citations[0].source.licence = 'Public Domain Mark';
  const r = await go([textFile(JSON.stringify(d), 'l.json')], 'check');
  assert.ok(items(r, 'error').length > 0, 'a licence in words is not an address');
  const ok = await go([file(JUDGEMENTS)], 'check');
  assert.deepEqual(items(ok, 'error'), [], 'control: the example itself passes');
});
