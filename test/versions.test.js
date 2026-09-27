import { PLATO_REPO } from './paths.js';
// PLATO e96d90d (issue #9): a gazetteer's version and status, and the current state. A published
// gazetteer is append-only, so a claim is withdrawn (plato:Retracts) or replaced
// (plato:Supersedes), never deleted. PLATO JSON and RDF keep all of it; LPF and the spreadsheet
// tables, which cannot express meta-attestations, show only the current state: every attestation
// that is the target of a Retracts or Supersedes is absent from their output, and reported. This is
// the denial rule's safety class (test/judgements.test.js): nothing the data withdraws is written as
// current. Every absence asserted here is paired with a presence in the same output, or with a
// control that finds the same thing when it is not withdrawn, so that a search that cannot match
// does not pass for an absence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import Papa from 'papaparse';
import { file, textFile, outText, go } from './engine.js';
import { recordToFeature } from '../src/formats/lpf.js';
import { recordToRows } from '../src/formats/tables.js';

const JUDGEMENTS = `${PLATO_REPO}/schemas/examples/place-centric-judgements.json`;
const P = 'https://w3id.org/plato#', DCAT = 'http://www.w3.org/ns/dcat#';
const BAD = 'https://whgazetteer.org/example/attestation/littleworth-bad-import';
const errors = (r) => r.report.items.filter((i) => i.severity === 'error');
const lossKinds = (r) => r.report.items.filter((i) => i.severity === 'loss').map((i) => i.kind);
const loss = (r, kind) => r.report.items.find((i) => i.severity === 'loss' && i.kind === kind);
const sheet = (zipBytes, name) => Papa.parse(strFromU8(unzipSync(zipBytes)[name]), { header: true, skipEmptyLines: true }).data;
const doc = () => JSON.parse(readFileSync(JUDGEMENTS, 'utf8'));
const src = { '@id': 'https://example.org/source/s', title: 'S' };
const place = (id, attestations) => ({ '@id': `https://example.org/place/${id}`, label: id, attestations });
const gazetteer = { '@id': 'https://example.org/g', title: 't' };
const placeDoc = (spatialEntities, g = gazetteer) => ({ profile: 'place-centric', gazetteer: g, spatialEntities });

/** Everything an output says, as one string to search, and the features or rows it holds. */
async function written(input, target, name) {
  const r = await go([input], 'convert', target);
  const stem = name.replace(/\.[^.]+$/, '');
  if (target === 'tables') {
    const zip = r.e.outs[`${stem}-tables.zip`][0];
    const rows = Object.fromEntries(['names', 'locations', 'types', 'relations', 'properties'].map((s) => [s, sheet(zip, `${s}.csv`)]));
    return { r, rows, text: JSON.stringify(rows) };
  }
  const text = outText(r.e, `${stem}.${target === 'lpf' ? 'geojson' : 'geojsonl'}`);
  const features = target === 'lpf' ? JSON.parse(text).features : text.trim().split('\n').slice(1).map((l) => JSON.parse(l));
  return { r, features, text };
}
/** The coordinates of every location an output holds, as "x y" strings. */
const points = (out) => (out.rows ? out.rows.locations.map((l) => `${l.longitude} ${l.latitude}`)
  : out.features.flatMap((f) => (!f.geometry ? [] : f.geometry.type === 'GeometryCollection' ? f.geometry.geometries : [f.geometry])).map((g) => g.coordinates.join(' ')));
const toponyms = (out) => (out.rows ? out.rows.names.map((n) => n.name) : out.features.flatMap((f) => (f.names || []).map((n) => n.toponym)));

// ---- versions ------------------------------------------------------------------------------------
const VERSIONED = { '@id': 'https://example.org/g/2026-09', title: 't', version: '2026-09', status: 'published',
  isVersionOf: 'https://example.org/g', previousVersion: 'https://example.org/g/2026-06' };

test('versions: JSON -> RDF writes dcat:version, plato:gazetteer_status, dcat:isVersionOf and dcat:previousVersion', async () => {
  const d = placeDoc([place('p', [{ names: [{ toponym: 'P' }], sources: [src] }])], VERSIONED);
  const r = await go([textFile(JSON.stringify(d), 'v.json')], 'convert', 'ntriples');
  assert.deepEqual(errors(r), []);
  const nt = outText(r.e, 'v.nt');
  const g = '<https://example.org/g/2026-09>';
  for (const line of [`${g} <${DCAT}version> "2026-09" .`, `${g} <${P}gazetteer_status> "published" .`,
    `${g} <${DCAT}isVersionOf> <https://example.org/g> .`, `${g} <${DCAT}previousVersion> <https://example.org/g/2026-06> .`]) {
    assert.ok(nt.split('\n').includes(line), `missing: ${line}`);
  }
});
for (const target of ['plato-json', 'plato-jsonl']) {
  test(`versions: JSON -> RDF -> ${target} puts all four back in the header, unchanged`, async () => {
    const d = placeDoc([place('p', [{ names: [{ toponym: 'P' }], sources: [src] }])], VERSIONED);
    const nt = outText((await go([textFile(JSON.stringify(d), 'v.json')], 'convert', 'ntriples')).e, 'v.nt');
    const r = await go([textFile(nt, 'v.nt')], 'convert', target);
    assert.deepEqual(errors(r), []);
    assert.deepEqual(lossKinds(r), []);
    const text = outText(r.e, target === 'plato-json' ? 'v.json' : 'v.jsonl');
    const head = target === 'plato-json' ? JSON.parse(text) : JSON.parse(text.split('\n')[0]);
    assert.deepEqual(head.gazetteer, VERSIONED);
    // and the header that comes back is valid, and gives the same triples again
    const again = await go([textFile(text, `again.${target === 'plato-json' ? 'json' : 'jsonl'}`)], 'convert', 'ntriples');
    assert.deepEqual(errors(again), []);
    const lines = (s) => s.split('\n').filter((l) => /dcat#|gazetteer_status/.test(l)).sort();
    assert.deepEqual(lines(outText(again.e, 'again.nt')), lines(nt));
    assert.equal(lines(nt).length, 4);
  });
}
test('versions: the example document keeps its version and status through RDF', async () => {
  const nt = outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt');
  const r = await go([textFile(nt, 'j.nt')], 'convert', 'plato-jsonl');
  const head = JSON.parse(outText(r.e, 'j.jsonl').split('\n')[0]);
  assert.deepEqual([head.gazetteer.version, head.gazetteer.status], ['2026-09', 'published']);
});
for (const target of ['lpf', 'lpf-seq', 'tables']) {
  test(`versions: ${target} cannot hold them, so each is reported, and none is written`, async () => {
    const d = placeDoc([place('p', [{ names: [{ toponym: 'P' }], sources: [src] }])], VERSIONED);
    const out = await written(textFile(JSON.stringify(d), 'v.json'), target, 'v.json');
    const l = loss(out.r, 'gazetteer-version');
    assert.equal(l?.count, 4, JSON.stringify(lossKinds(out.r)));
    assert.deepEqual(l.examples.sort(), ['isVersionOf', 'previousVersion', 'status', 'version']);
    assert.match(l.message, /does not say which state of the gazetteer it holds/);
    assert.doesNotMatch(out.text, /2026-09|2026-06|published/);
    assert.deepEqual(toponyms(out), ['P'], 'the place itself is written');
    // control: a header without them reports nothing
    const plain = await written(textFile(JSON.stringify(placeDoc(d.spatialEntities)), 'v.json'), target, 'v.json');
    assert.equal(loss(plain.r, 'gazetteer-version'), undefined);
  });
}

// ---- retractions: the example --------------------------------------------------------------------
for (const target of ['lpf', 'lpf-seq', 'tables']) {
  test(`the example's retracted import is absent from ${target}, and reported as withdrawn`, async () => {
    const out = await written(file(JUDGEMENTS), target, 'place-centric-judgements.json');
    assert.deepEqual(errors(out.r), []);
    assert.deepEqual(points(out), [], 'the only location in the example is the withdrawn one');
    assert.doesNotMatch(out.text, /Batch import/, 'neither its source nor its citation is written');
    const l = loss(out.r, 'retracted');
    assert.equal(l?.count, 1, JSON.stringify(lossKinds(out.r)));
    assert.deepEqual(l.examples, [BAD]);
    assert.match(l.message, /withdrawn/); assert.match(l.message, /current state/);
    // the rest of Littleworth is still there: its place, and the other places' names
    assert.ok(toponyms(out).includes('Neuton'));
    if (target !== 'tables') assert.ok(out.features.some((f) => f['@id'].endsWith('/littleworth')));
    // The meta-attestation is reported as before: LPF as a meta-attestation, the tables as an
    // attestation with nothing to put in a row.
    assert.ok(target === 'tables' ? loss(out.r, 'attestation-without-facet') : loss(out.r, 'meta-attestation'), JSON.stringify(lossKinds(out.r)));
  });
}
for (const target of ['lpf', 'tables']) {
  test(`control: without its retraction, the import is written to ${target} at 0°, 0°`, async () => {
    const d = doc(); d.spatialEntities[0].attestations.splice(2, 1);
    const out = await written(textFile(JSON.stringify(d), 'kept.json'), target, 'kept.json');
    assert.deepEqual(points(out), ['0 0']);
    assert.equal(loss(out.r, 'retracted'), undefined);
  });
}
for (const target of ['ntriples', 'plato-json']) {
  test(`${target} keeps the retracted attestation and its retraction`, async () => {
    const r = await go([file(JUDGEMENTS)], 'convert', target);
    assert.equal(loss(r, 'retracted'), undefined);
    const text = outText(r.e, `place-centric-judgements.${target === 'ntriples' ? 'nt' : 'json'}`);
    if (target === 'ntriples') {
      assert.match(text, new RegExp(`^<${BAD}> <${P}attests_geometry> `, 'm'));
      assert.match(text, new RegExp(`<${P}meta_attestation_about> <${BAD}> \\.`));
      assert.match(text, new RegExp(`<${P}has_meta_type> <${P}Retracts> \\.`));
    } else {
      const atts = JSON.parse(text).spatialEntities[0].attestations;
      assert.ok(atts.some((a) => a['@id'] === BAD && a.geometries));
      assert.ok(atts.some((a) => a.meta?.metaType === P + 'Retracts' && a.meta.targetAttestation === BAD));
    }
  });
}

// ---- retractions: through RDF, whatever the node ---------------------------------------------------
for (const [how, rewrite] of [['an IRI', (nt) => nt], ['a blank node', (nt) => nt.replaceAll(`<${BAD}>`, '_:badimport')]]) {
  for (const target of ['lpf', 'tables']) {
    test(`from RDF, a retracted attestation that is ${how} is absent from ${target}, and reported`, async () => {
      const nt = rewrite(outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt'));
      if (how === 'a blank node') assert.match(nt, /_:badimport <https:\/\/w3id\.org\/plato#attests_geometry>/);
      const out = await written(textFile(nt, 'j.nt'), target, 'j.nt');
      assert.deepEqual(points(out), []);
      assert.ok(toponyms(out).includes('Neuton'));
      assert.equal(loss(out.r, 'retracted')?.count, 1, JSON.stringify(lossKinds(out.r)));
      // control: the same graph without the retraction's type writes the point
      const kept = await written(textFile(nt.replace(`<${P}has_meta_type> <${P}Retracts>`, `<${P}has_meta_type> <${P}Annotates>`), 'k.nt'), target, 'k.nt');
      assert.deepEqual(points(kept), ['0 0']);
    });
  }
  test(`from RDF, PLATO JSON keeps a retracted attestation that is ${how}`, async () => {
    const nt = rewrite(outText((await go([file(JUDGEMENTS)], 'convert', 'ntriples')).e, 'place-centric-judgements.nt'));
    const r = await go([textFile(nt, 'j.nt')], 'convert', 'plato-jsonl');
    assert.equal(loss(r, 'retracted'), undefined);
    const recs = outText(r.e, 'j.jsonl').trim().split('\n').slice(1).map((l) => JSON.parse(l));
    const lw = recs.find((x) => x['@id']?.endsWith('/littleworth'));
    assert.ok(lw.attestations.some((a) => a.geometries?.[0]?.geojson?.coordinates?.join(' ') === '0 0'));
  });
}

// ---- supersession, and a withdrawal anywhere in the file -------------------------------------------
const OLD = 'https://example.org/attestation/old', NEW = 'https://example.org/attestation/new';
/** A place whose name "Oldford" is replaced by "Newford", the replacement under another place, before or after it. */
function superseded(order) {
  const old = place('a', [{ '@id': OLD, names: [{ toponym: 'Oldford' }], sources: [src] }, { names: [{ toponym: 'Keptford' }], sources: [src] }]);
  const other = place('b', [{ '@id': NEW, names: [{ toponym: 'Newford' }], sources: [src], meta: { targetAttestation: OLD, metaType: P + 'Supersedes' } }]);
  return placeDoc(order === 'after' ? [old, other] : [other, old]);
}
for (const order of ['after', 'before']) {
  for (const [fmt, name, text] of [['JSON', 's.json', (d) => JSON.stringify(d)], ['JSON Lines', 's.jsonl', (d) => [JSON.stringify({ profile: d.profile, gazetteer: d.gazetteer }), ...d.spatialEntities.map((x) => JSON.stringify(x))].join('\n') + '\n']]) {
    for (const target of ['lpf', 'tables']) {
      test(`${fmt} to ${target}: a superseded name is absent, its replacement written, when the replacement comes ${order} it`, async () => {
        const out = await written(textFile(text(superseded(order)), name), target, name);
        assert.deepEqual(errors(out.r), []);
        assert.deepEqual(toponyms(out).sort(), ['Keptford', 'Newford']);
        const l = loss(out.r, 'superseded');
        assert.equal(l?.count, 1, JSON.stringify(lossKinds(out.r)));
        assert.deepEqual(l.examples, [OLD]);
        assert.match(l.message, /replaced/); assert.match(l.message, /current state/);
      });
    }
  }
}
test('attestation-centric JSON to LPF and tables: a superseded attestation is absent, and reported', async () => {
  const d = { profile: 'attestation-centric', gazetteer, attestations: [
    { '@id': OLD, about: 'https://example.org/place/a', names: [{ toponym: 'Oldford' }], sources: [src] },
    { '@id': NEW, about: 'https://example.org/place/a', names: [{ toponym: 'Newford' }], sources: [src], meta: { targetAttestation: OLD, metaType: P + 'Supersedes' } }] };
  for (const target of ['lpf', 'tables']) {
    const out = await written(textFile(JSON.stringify(d), 'ac.json'), target, 'ac.json');
    assert.deepEqual(toponyms(out), ['Newford'], target);
    assert.equal(loss(out.r, 'superseded')?.count, 1, `${target}: ${JSON.stringify(lossKinds(out.r))}`);
  }
});
test('a meta type written with the plato: prefix withdraws as the full IRI does', async () => {
  const d = superseded('after'); d.spatialEntities[1].attestations[0].meta.metaType = 'plato:Supersedes';
  const out = await written(textFile(JSON.stringify(d), 's.json'), 'lpf', 's.json');
  assert.deepEqual(toponyms(out).sort(), ['Keptford', 'Newford']);
  assert.equal(loss(out.r, 'superseded')?.count, 1);
});
test('control: a meta-attestation that neither retracts nor supersedes leaves its target in', async () => {
  for (const type of ['Supports', 'Contradicts', 'Refines', 'Annotates', 'AlternativeTo', 'DerivedFrom']) {
    const d = superseded('after'); d.spatialEntities[1].attestations[0].meta.metaType = P + type;
    const out = await written(textFile(JSON.stringify(d), 's.json'), 'tables', 's.json');
    assert.deepEqual(toponyms(out).sort(), ['Keptford', 'Newford', 'Oldford'], type);
    assert.deepEqual([loss(out.r, 'superseded'), loss(out.r, 'retracted')], [undefined, undefined], type);
  }
});
for (const where of ['after', 'before']) {
  test(`retracted and superseded both, the retraction ${where} the supersession: counted once, as withdrawn`, async () => {
    const d = superseded('after');
    const retraction = { meta: { targetAttestation: OLD, metaType: P + 'Retracts' }, sources: [src] };
    // In a place of its own, so that neither record's own retractions decide it.
    if (where === 'after') d.spatialEntities.push(place('c', [retraction])); else d.spatialEntities.unshift(place('c', [retraction]));
    for (const target of ['lpf', 'tables']) {
      const out = await written(textFile(JSON.stringify(d), 's.json'), target, 's.json');
      assert.deepEqual(toponyms(out).sort(), ['Keptford', 'Newford']);
      assert.deepEqual([loss(out.r, 'retracted')?.count, loss(out.r, 'superseded')], [1, undefined], target);
    }
  });
}
test('a writer called on one record alone still leaves out what the record itself retracts', () => {
  const rec = doc().spatialEntities[0];
  for (const write of [(l) => recordToFeature(rec, [], l), (l) => recordToRows(rec, { place: () => 'p', source: () => 's' }, l)]) {
    const kinds = [];
    const out = JSON.stringify(write((x) => kinds.push(x.kind)));
    assert.doesNotMatch(out, /Batch import|\[0,0\]|"latitude":0/);
    assert.ok(kinds.includes('retracted'), JSON.stringify(kinds));
  }
});
