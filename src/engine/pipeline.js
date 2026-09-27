// The engine: read any supported input as one stream of PLATO records (or triples), and write it
// out in any supported format, or check it. It is given its storage and outputs by its host
// (src/engine/worker.js in the browser, test/pipeline.test.js in Node), so the same code runs in
// both. Inputs that must be gathered before they can be written (RDF, attestation-centric JSON)
// go through the on-disk triple store; everything else streams straight through.
import { Parser } from 'n3';
import Papa from 'papaparse';
import { unzipSync, strFromU8 } from 'fflate';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Json2Rdf } from '../formats/json2rdf.js';
import { Rdf2Json } from '../formats/rdf2json.js';
import { tripleNT } from '../lib/ntriples.js';
import { TripleStore } from '../lib/store.js';
import { PLATO, RDF } from '../lib/context.js';
import { featureToRecord, recordToFeature } from '../formats/lpf.js';
import { validateTables, rowToAttestation, tableIds, recordToRows, identityRow, ATTESTATION_SHEETS, tableSchemas } from '../formats/tables.js';
import { lineChunks, lines, jsonDocument, TABLE_SHEETS, DataError } from './input.js';
import { Report, LOSS_TEXT } from './report.js';

export const TARGETS = {
  'plato-jsonl': { label: 'PLATO JSON Lines (.jsonl): one place per line', ext: '.jsonl' },
  'plato-json': { label: 'PLATO JSON document (.json), place-centric', ext: '.json' },
  ntriples: { label: 'RDF, N-Triples (.nt)', ext: '.nt' },
  tables: { label: 'PLATO spreadsheet tables (.zip of eight CSV files)', ext: '.zip' },
  'lpf-seq': { label: 'Linked Places Format v1, GeoJSON sequence (.geojsonl): one feature per line', ext: '.geojsonl' },
  lpf: { label: 'Linked Places Format v1, FeatureCollection (.geojson)', ext: '.geojson' },
};
const TYPE = RDF + 'type';

// ---- resources ------------------------------------------------------------------------------------
export function prepare(res) {
  const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
  ajv.addSchema(res.core, 'https://w3id.org/plato/schemas/plato.schema.json');
  for (const p of Object.values(res.profiles)) ajv.addSchema(p);
  const v = {};
  for (const [name, p] of Object.entries(res.profiles)) {
    const arrays = new Set(['spatialEntities', 'newSpatialEntities', 'attestations', 'identityRelations']);
    const headSchema = { ...p, $id: p.$id.replace('.schema.json', '.header.schema.json'), required: (p.required || []).filter((k) => !arrays.has(k)),
      properties: Object.fromEntries(Object.entries(p.properties).filter(([k]) => !arrays.has(k))) };
    v[name] = {
      header: ajv.compile(headSchema),
      entity: p.properties.spatialEntities ? ajv.getSchema(p.$id + '#/properties/spatialEntities/items') : null,
      newEntity: p.properties.newSpatialEntities ? ajv.getSchema(p.$id + '#/properties/newSpatialEntities/items') : null,
      attestation: p.properties.attestations ? ajv.getSchema(p.$id + '#/properties/attestations/items') : null,
      identity: ajv.getSchema('https://w3id.org/plato/schemas/plato.schema.json#/$defs/identityRelation'),
    };
  }
  return { ...res, validators: v };
}
// Which schema error to show. With allErrors, a value that fails a oneOf (a source that may be a
// URI or an object) yields one error per branch, then the oneOf's own: shown in that order, an
// object source without a title read "must be string" and sent the reader after the wrong fix.
// An error about the content of a value (a missing title, a malformed address) says what to
// change, so it comes before one saying the value is of another type, and those before the
// bare "must match exactly one schema".
const RANK = { oneOf: 2, anyOf: 2, not: 2, if: 2, type: 1 };
const pick = (errs) => [...(errs || [])].sort((a, b) => (RANK[a.keyword] || 0) - (RANK[b.keyword] || 0));
const ajvMessage = (errs) => pick(errs).slice(0, 1).map((e) => `${e.instancePath || '(record)'} ${e.message}${e.params?.additionalProperty ? `: ${e.params.additionalProperty}` : ''}`).join('; ');
/** The first schema error in plain words, with the spreadsheet column where that helps. */
export function explainSchema(errs, fromTables) {
  const e = pick(errs)[0];
  if (!e) return 'does not match the PLATO JSON Schema';
  const at = e.instancePath || '';
  const col = (c) => (fromTables ? ` In the spreadsheets, fill in ${c}.` : '');
  if (e.keyword === 'required') {
    const p = e.params.missingProperty;
    if (p === 'identifier' && /types\/\d+$/.test(at)) return 'A type has no identifier: PLATO JSON requires the web address of the concept in a published vocabulary.' + col('type_uri');
    if (p === 'label') return 'A place has no label.' + col('label');
    if (p === 'toponym') return 'A name has no spelling (toponym).' + col('name');
    if (p === 'identityType') return 'An identity match does not say what kind of match it is (exactMatch, closeMatch, related, or unspecified if the source does not say): PLATO JSON requires it.' + col('match_type');
    if (p === 'title') return 'A source has no title.' + col('title');
    return `Something required is missing: ${p}.`;
  }
  if (e.keyword === 'minItems' && /attestations$/.test(at)) return 'A place has no evidence about it: PLATO JSON needs at least one attestation per place.' + (fromTables ? ' Give it at least one row in names, locations, types, relations or properties.' : '');
  if (e.keyword === 'additionalProperties') return `A key PLATO does not define: ${e.params.additionalProperty}.`;
  if (e.keyword === 'format' && e.params.format === 'uri') return 'A value that must be a full web address is not one.';
  if (e.keyword === 'enum') return `A value is not one of those allowed: ${(e.params.allowedValues || []).join(', ')}.`;
  if (e.keyword === 'not' && /attestations\/\d+$/.test(at)) return 'An attestation nested under its place also says what it is about; in place-centric JSON that is implied, and must be left out.';
  return 'does not match the PLATO JSON Schema: ' + ajvMessage(errs).replace(/"[^"]*"/g, '…');
}

// ---- sources: every input becomes a stream of events ------------------------------------------
// { type: 'header', value } | { type: 'record', value } | { type: 'attestation', value } | { type: 'idr', value } | { type: 'triple', s, p, o }

async function* platoJsonl(file, rep) {
  let first = true;
  for await (const { line, n } of lines(file)) {
    let v;
    try { v = JSON.parse(line); } catch (e) { rep.error('json-syntax', 'A line is not valid JSON', `line ${n}: ${e.message}`); continue; }
    if (first) { first = false; if (v.profile) { yield { type: 'header', value: v }; continue; } yield { type: 'header', value: { profile: 'place-centric', gazetteer: { title: file.name } } }; }
    if (v.subject && v.object && v.identityType !== undefined) yield { type: 'idr', value: v, n };
    else if (v.about !== undefined && !v.label && !v.attestations) yield { type: 'attestation', value: v, n };
    else yield { type: 'record', value: v, n };
  }
}
async function* platoJson(file) {
  const keys = ['gazetteer', 'profile', '$schema'];
  const head = {};
  for await (const { path, value } of jsonDocument(file, { arrays: ['spatialEntities', 'newSpatialEntities', 'attestations', 'identityRelations'], keys, onlyKeys: true })) head[path] = value;
  if (!('gazetteer' in head)) for await (const { path, value } of jsonDocument(file, { keys })) head[path] = value;   // header after the arrays: rare
  yield { type: 'header', value: head };
  let n = 0;
  for await (const { path, value } of jsonDocument(file, { arrays: ['spatialEntities', 'newSpatialEntities', 'attestations', 'identityRelations'] })) {
    n++;
    if (path === 'identityRelations') yield { type: 'idr', value, n };
    else if (path === 'attestations') yield { type: 'attestation', value, n };
    else yield { type: 'record', value, n, newEntity: path === 'newSpatialEntities' };
  }
}
async function* lpfSource(file, seq, rep) {
  yield { type: 'header', value: { profile: 'place-centric', gazetteer: { title: file.name } } };
  const loss = (l) => rep.loss(l.kind, LOSS_TEXT[l.kind] || l.kind, l.value);
  const each = seq ? (async function* () {
    for await (const { line, n } of lines(file)) {
      let v;
      try { v = JSON.parse(line); } catch (e) { rep.error('json-syntax', 'A line is not valid JSON', `line ${n}: ${e.message}`); continue; }
      if (v && v.type === 'Feature') yield { v, n };
    }
  })()
    : (async function* () { let n = 0; for await (const { value } of jsonDocument(file, { arrays: ['features'] })) yield { v: value, n: ++n }; })();
  for await (const { v, n } of each) {
    if (!v['@id']) rep.warning('lpf-no-id', 'An LPF feature has no @id', `feature ${n}`);
    if (!v.properties?.title) rep.warning('lpf-no-title', 'An LPF feature has no properties.title', v['@id'] || `feature ${n}`);
    if (!v.names?.length) rep.warning('lpf-no-names', 'An LPF feature has no names (LPF requires at least one)', v['@id'] || `feature ${n}`);
    yield { type: 'record', value: featureToRecord(v, loss), n };
  }
}
async function* rdfSource(file, format, rep) {
  if (format === 'turtle') {
    // N3 accepts any object with on('data') / on('end') as a stream; this shim feeds it chunks.
    const handlers = {}; const quads = []; let finished = false, failure = null;
    const input = { on: (ev, fn) => { handlers[ev] = fn; return input; } };
    new Parser({ format: 'text/turtle' }).parse(input, (err, q) => { if (err) failure = err; else if (q) quads.push(q); else finished = true; });
    for await (const chunk of lineChunks(file)) {
      handlers.data(chunk);
      if (failure) { rep.error('rdf-syntax', 'The Turtle cannot be parsed', failure.message); return; }
      while (quads.length) { const q = quads.shift(); yield { type: 'triple', s: q.subject, p: q.predicate, o: q.object }; }
    }
    handlers.end();
    while (quads.length) { const q = quads.shift(); yield { type: 'triple', s: q.subject, p: q.predicate, o: q.object }; }
    if (failure) rep.error('rdf-syntax', 'The Turtle cannot be parsed', failure.message);
    return;
  }
  const fmt = format === 'nquads' ? 'N-Quads' : 'N-Triples';
  let lineNo = 0;
  for await (const chunk of lineChunks(file)) {
    let quads;
    try { quads = new Parser({ format: fmt, blankNodePrefix: '' }).parse(chunk); }
    catch (e) {
      // Report the failing line precisely, then carry on line by line within this chunk.
      quads = [];
      for (const [i, l] of chunk.split('\n').entries()) {
        if (!l.trim()) continue;
        try { quads.push(...new Parser({ format: fmt, blankNodePrefix: '' }).parse(l + '\n')); }
        catch (e2) { rep.error('rdf-syntax', 'A line is not valid ' + fmt, `line ${lineNo + i + 1}: ${e2.message.split('\n')[0]}`); }
      }
    }
    lineNo += (chunk.match(/\n/g) || []).length;
    for (const q of quads) yield { type: 'triple', s: q.subject, p: q.predicate, o: q.object };
  }
}

// ---- tables: sheets from CSV files, a zip or a workbook -----------------------------------------
async function readSheets(input, env) {
  const sheets = {};
  const put = (name, text) => { const b = name.split('/').pop().toLowerCase().replace(/\.csv$/, ''); if (TABLE_SHEETS.includes(b)) sheets[b] = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy' }); };
  if (input.container === 'csv') for (const f of input.files) put(f.name, await f.text());
  else if (input.container === 'zip') {
    let z;
    try { z = unzipSync(new Uint8Array(await input.files[0].arrayBuffer())); }
    catch (e) { throw new DataError(`The zip is damaged or incomplete, so its tables cannot be read (${String(e && e.message || e)}).`); }
    for (const [name, data] of Object.entries(z)) if (name.toLowerCase().endsWith('.csv')) put(name, strFromU8(data));
  } else {
    const XLSX = env.xlsx;
    let wb;
    try { wb = XLSX.read(new Uint8Array(await input.files[0].arrayBuffer()), { type: 'array', raw: false }); }
    catch (e) { throw new DataError(`The workbook is damaged or incomplete, so its sheets cannot be read (${String(e && e.message || e)}).`); }
    for (const name of wb.SheetNames) if (TABLE_SHEETS.includes(name.toLowerCase())) put(name, XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, rawNumbers: false }));
  }
  return sheets;
}
async function* tablesSource(input, env, rep, options) {
  const sheets = await readSheets(input, env);
  const sets = new Map();
  await validateTables(env.csvMeta, {
    header: async (n) => (sheets[n] ? sheets[n].meta.fields : null),
    rows: async function* (n) { yield* sheets[n].data; },
    keys: { add: async (t, k) => { const s = sets.get(t) || sets.set(t, new Set()).get(t); if (s.has(k)) return false; s.add(k); return true; }, has: async (t, k) => !!sets.get(t)?.has(k) },
    issue: (i) => rep.error('table', `${i.table}${i.column ? `, column ${i.column}` : ''}: ${i.message.replace(/'[^']*'/, "'…'")}`, `${i.table}${i.row ? ` row ${i.row + 1}` : ''}${i.column ? ` ${i.column}` : ''}: ${i.message}`),
  });
  const base = options.base || 'https://example.org/dataset/';
  yield { type: 'header', value: { profile: 'place-centric', gazetteer: { '@id': base, title: options.title || 'Converted from PLATO spreadsheet tables' } } };
  const rows = (n) => (sheets[n] ? sheets[n].data : []);
  const sources = new Map(rows('sources').map((r) => [r.source_id, r]));
  const ids = tableIds(base, (id) => sources.get(id));
  const byPlace = new Map();
  for (const sheet of ATTESTATION_SHEETS) for (const row of rows(sheet)) {
    if (!row.place_id) continue;
    (byPlace.get(row.place_id) || byPlace.set(row.place_id, []).get(row.place_id)).push(rowToAttestation(sheet, row, ids));
  }
  const idrs = new Map();
  for (const r of rows('identities')) if (r.place_id) (idrs.get(r.place_id) || idrs.set(r.place_id, []).get(r.place_id)).push(r);
  let n = 0;
  for (const p of rows('places')) {
    n++;
    // place_id reaches the data as the record's own identifier (plato:entity_identifier), as the
    // table definitions write it, not only as the tail of the minted address.
    const rec = { '@id': ids.place(p.place_id), label: p.label, entityIdentifier: p.place_id, attestations: byPlace.get(p.place_id) || [] };
    if (p.country_codes) rec.ccodes = p.country_codes.split(';');
    for (const r of idrs.get(p.place_id) || []) {
      (rec.identityRelations ||= []).push(Object.fromEntries(Object.entries({
        subject: rec['@id'], object: r.same_as, identityType: r.match_type || undefined, certainty: r.certainty !== '' ? Number(r.certainty) : undefined,
        basis: r.basis || undefined, source: r.source_id ? ids.source(r.source_id) : undefined }).filter(([, v]) => v !== undefined)));
    }
    yield { type: 'record', value: rec, n };
  }
}

// ---- sinks -------------------------------------------------------------------------------------
class TextSink {
  constructor(out) { this.out = out; this.buf = []; this.len = 0; }
  write(s) { this.buf.push(s); this.len += s.length; if (this.len > 1 << 20) this.flush(); }
  flush() { if (this.buf.length) { this.out.write(this.buf.join('')); this.buf = []; this.len = 0; } }
  async close() { this.flush(); return this.out.close(); }
}

// ---- the run -------------------------------------------------------------------------------------
/**
 * Check or convert one input. A file whose content stops the reader part-way (JSON cut short or
 * not well formed, damaged compression, a broken zip) is a problem in the data, so it ends in a
 * report like any other, with what was read before it and no outputs: only a failure of the tools
 * themselves is thrown.
 */
export async function run(job, env) {
  const rep = new Report();
  try { return await runChecked(job, env, rep); }
  catch (e) {
    if (!(e instanceof DataError)) throw e;
    rep.error('unreadable', 'The file could not be read to the end, so only the part before the problem was checked', e.message);
    return { report: rep.toJSON(), outputs: [], incomplete: true };
  }
}
async function runChecked({ input, action, target, options = {} }, env, rep) {
  const res = env.resources;
  const progress = env.progress || (() => {});
  const t0 = Date.now();
  let lastBeat = 0;
  const beat = (phase, extra = {}) => { const now = Date.now(); if (now - lastBeat > 250 || extra.force) { lastBeat = now; progress({ phase, ...rep.counts, elapsedMs: now - t0, ...extra }); } };

  const source = input.format === 'plato-jsonl' ? platoJsonl(input.files[0], rep)
    : input.format === 'plato-json' ? platoJson(input.files[0])
    : input.format === 'lpf' || input.format === 'lpf-seq' ? lpfSource(input.files[0], input.format === 'lpf-seq', rep)
    : input.format === 'tables' ? tablesSource(input, env, rep, options)
    : ['ntriples', 'nquads', 'turtle'].includes(input.format) ? rdfSource(input.files[0], input.format, rep) : null;
  if (!source) throw new Error(`Unsupported input: ${input.format}`);
  if ((input.format === 'lpf' || input.format === 'lpf-seq') && input.lpfVersion === 2) {
    rep.error('lpf-v2', 'Linked Places Format v2 is not yet specified, so it cannot be read. It will be supported once the specification is published.');
    return { report: rep.toJSON(), outputs: [] };
  }
  const isRdf = ['ntriples', 'nquads', 'turtle'].includes(input.format);
  const needsStore = isRdf || input.profile === 'attestation-centric';
  const typing = options.typing ? { types: res.types, typedBounds: true, wktPoints: true } : {};
  const profileName = input.profile || 'place-centric';
  const V = res.validators[profileName] || res.validators['place-centric'];

  // Where the records go: a writer for the target, or nothing when checking.
  const outputs = [];
  let writer = null;
  const idrsBySubject = new Map();
  if (action === 'convert' && (target === 'lpf' || target === 'lpf-seq') && !needsStore && input.format.startsWith('plato')) {
    // DEEP-style files list identity relations after every place; LPF needs them on the feature.
    const again = input.format === 'plato-jsonl' ? platoJsonl(input.files[0], new Report()) : platoJson(input.files[0]);
    for await (const ev of again) if (ev.type === 'idr') (idrsBySubject.get(ev.value.subject) || idrsBySubject.set(ev.value.subject, []).get(ev.value.subject)).push(ev.value);
  }
  if (action === 'convert') writer = await makeWriter(target, env, rep, { ...options, idrsBySubject }, typing, outputs, input);

  // Checking (and writing) records as they stream past.
  const checkRecord = (ev) => {
    const f = ev.newEntity ? V.newEntity : ev.type === 'record' ? V.entity : ev.type === 'attestation' ? V.attestation : V.identity;
    if (f && !f(ev.value)) rep.error('schema', explainSchema(f.errors, input.format === 'tables'), `${ev.value?.['@id'] || ev.value?.subject || `item ${ev.n}`}: ${ajvMessage(f.errors)}`);
    // A nested identity relation may leave out its subject, which is then its place; if it gives
    // one, it must be that place, or in RDF it has two subjects. A schema cannot say this.
    if (ev.type === 'record' && ev.value && Array.isArray(ev.value.identityRelations)) {
      for (const ir of ev.value.identityRelations) {
        if (ir && ir.subject !== undefined && ev.value['@id'] !== undefined && ir.subject !== ev.value['@id'])
          rep.error('identity-subject-mismatch', 'An identity relation nested under a place names a different place as its subject; leave the subject out, or move the relation to the place it is about', `${ev.value['@id']}: ${ir.subject}`);
      }
    }
  };
  // What the JSON-to-RDF converter could not use, in words. Every kind it can raise is named here.
  const jsonIssue = (i) => {
    if (i.kind === 'record-failed') return rep.error('record-failed', 'A record could not be converted to RDF and is left out; the rest of the file was still checked', `${i.value}: ${i.error}`);
    if (i.kind === 'null-value') return rep.warning('null-value', `An empty value (null) is left out of RDF (${i.where})`, i.where);
    if (i.kind === 'unconvertible') return rep.warning('unconvertible', `A value of the wrong kind cannot be turned into RDF and is left out (${i.where})`, i.value);
    if (i.kind === 'relative-iri') return rep.warning(i.kind, `A value that must be a full web address is not one, so it is dropped in RDF (${i.where})`, i.value);
    if (i.kind === 'not-in-rdf') return rep.warning(i.kind, `${LOSS_TEXT['not-in-rdf']} (${i.key})`, i.key);
    return rep.warning(i.kind, `A key PLATO does not define is dropped: ${i.value}`, i.value);
  };
  const dry = new Json2Rdf(res.context, () => {}, { onIssue: jsonIssue });

  if (!needsStore) {
    let header = null;
    for await (const ev of source) {
      if (ev.type === 'header') {
        header = ev.value;
        if (input.format.startsWith('plato') && !V.header(header)) rep.error('schema', `The document header does not match the PLATO JSON Schema: ${ajvMessage(V.header.errors)}`);
        dry.header(header);
        writer && writer.header(header);
        continue;
      }
      if (input.format.startsWith('plato') || input.format === 'lpf' || input.format === 'lpf-seq' || input.format === 'tables') checkRecord(ev);
      if (ev.type === 'record') { rep.count('places'); rep.count('attestations', ev.value?.attestations?.length || 0); dry.record(ev.newEntity ? 'newSpatialEntities' : 'spatialEntities', ev.value); }
      else if (ev.type === 'idr') { rep.count('identity relations'); dry.record('identityRelations', ev.value); }
      if (writer) {
        try { writer.event(ev); }
        catch (e) { rep.error('record-failed', 'A record could not be written and is left out of the output; the rest of the file was still converted', `${ev.value?.['@id'] || `item ${ev.n}`}: ${e && e.message || e}`); }
      }
      beat('reading');
    }
  } else {
    // Gather everything in the on-disk store first, then read it back one place at a time.
    const store = new TripleStore(await env.openDb());
    // Here the store's converter is the only one that sees the records, so it reports.
    const w = new Json2Rdf(res.context, (s, p, o) => store.add(s, p, o), { onIssue: jsonIssue });
    let header = null, batch = 0;
    store.beginBatch();
    for await (const ev of source) {
      if (ev.type === 'triple') { store.add(ev.s, ev.p, ev.o); if (++batch % 50000 === 0) { store.endBatch(); store.beginBatch(); beat('loading', { triples: store.count }); } continue; }
      if (ev.type === 'header') { header = ev.value; w.header(header); dry.header(header); if (!V.header(header)) rep.error('schema', `The document header does not match the PLATO JSON Schema: ${ajvMessage(V.header.errors)}`); continue; }
      checkRecord(ev);
      w.record(ev.type === 'idr' ? 'identityRelations' : ev.type === 'attestation' ? 'attestations' : ev.newEntity ? 'newSpatialEntities' : 'spatialEntities', ev.value);
      if (++batch % 5000 === 0) { store.endBatch(); store.beginBatch(); beat('loading', { triples: store.count }); }
    }
    store.endBatch();
    rep.count('triples', store.count);
    beat('indexing', { triples: store.count, force: true });
    store.index();
    if (isRdf) checkGraph(store, res, rep);
    const r2j = new Rdf2Json({ context: res.context, core: res.core, profile: res.profiles['place-centric'], types: res.types }, store, {
      onLoss: (l) => rep.loss(l.kind, `${LOSS_TEXT[l.kind] || l.kind}`, l.predicate || l.value),
      onIssue: (i) => rep.warning(i.kind, i.kind === 'multiple-values' ? `A value that PLATO JSON allows once appears several times; the first is kept (${i.key})` : i.kind, i.node),
    });
    const docs = [...store.subjects(TYPE, PLATO + 'Gazetteer')];
    const docId = docs[0] || firstSubjectWith(store, PLATO + 'contains_entity') || firstSubjectWith(store, PLATO + 'contains_attestation');
    const head = docId ? { $schema: 'https://w3id.org/plato/schemas/place-centric.schema.json', ...r2j.header(docId) } : { profile: 'place-centric', gazetteer: { title: input.files[0].name } };
    head.profile = 'place-centric';
    writer && writer.header(head);
    const idrIds = docId ? [...objectsOf(store, docId, PLATO + 'contains_identity_relation')] : [...store.subjects(TYPE, PLATO + 'IdentityRelation')];
    if (target === 'lpf' || target === 'lpf-seq') for (const i of idrIds) { const v = r2j.identityRelation(i); (idrsBySubject.get(v.subject) || idrsBySubject.set(v.subject, []).get(v.subject)).push(v); }
    const entities = docId && firstSubjectWith(store, PLATO + 'contains_entity') ? objectsOf(store, docId, PLATO + 'contains_entity') : distinctEntities(store);
    let n = 0;
    for (const e of entities) {
      const rec = r2j.entity(e);
      if (!rec.label) { rec.label = e; rep.warning('no-label', 'A place has no label; its identifier is used as its label', e); }
      n++; rep.count('places'); rep.count('attestations', rec.attestations?.length || 0);
      if (isRdf && !V.entity(rec)) rep.error('schema', explainSchema(V.entity.errors, false), `${e}: ${ajvMessage(V.entity.errors)}`);
      writer && writer.event({ type: 'record', value: rec, n });
      beat('writing', { places: n });
    }
    for (const i of idrIds) { rep.count('identity relations'); writer && writer.event({ type: 'idr', value: r2j.identityRelation(i) }); }
    store.close();
  }
  if (writer) await writer.close();
  progress({ phase: 'done', ...rep.counts, elapsedMs: Date.now() - t0 });
  return { report: rep.toJSON(), outputs };
}
function firstSubjectWith(store, p) {
  const q = store.db.prepare('SELECT s FROM t WHERE p=? LIMIT 1');
  try { const i = store.pid.get(p); if (i === undefined) return null; q.bind([i]); return q.step() ? q.get(0) : null; } finally { q.finalize(); }
}
function* objectsOf(store, s, p) {
  const i = store.pid.get(p); if (i === undefined) return;
  const q = store.db.prepare('SELECT o FROM t WHERE s=? AND p=?');
  try { q.bind([s, i]); while (q.step()) yield q.get(0); } finally { q.finalize(); }
}
function* distinctEntities(store) {
  const tp = store.pid.get(TYPE), ab = store.pid.get(PLATO + 'attests_about');
  const q = store.db.prepare(`SELECT DISTINCT e FROM (SELECT s AS e FROM t WHERE p=? AND o=? UNION SELECT o AS e FROM t WHERE p=? AND k<2)`);
  try { q.bind([tp ?? -1, PLATO + 'SpatialEntity', ab ?? -1]); while (q.step()) yield q.get(0); } finally { q.finalize(); }
}
/** Graph-level checks an RDF input gets: every PLATO term it uses is declared, and every attestation says what it is about. */
function checkGraph(store, res, rep) {
  for (const p of store.pname) if (p.startsWith(PLATO) && !res.terms.has(p)) rep.error('undeclared-term', 'A predicate in the PLATO namespace is not declared in the ontology', p);
  const q = store.db.prepare('SELECT DISTINCT o FROM t WHERE k=0 AND o LIKE ?');
  try { q.bind([PLATO + '%']); while (q.step()) { const o = q.get(0); if (!res.terms.has(o)) rep.error('undeclared-term', 'A class or concept in the PLATO namespace is not declared in the ontology', o); } } finally { q.finalize(); }
  const tp = store.pid.get(TYPE), ab = store.pid.get(PLATO + 'attests_about');
  if (tp !== undefined) {
    const c = store.db.prepare('SELECT s FROM t WHERE p=? AND o=? AND s NOT IN (SELECT s FROM t WHERE p=?) LIMIT 5');
    try { c.bind([tp, PLATO + 'Attestation', ab ?? -1]); while (c.step()) rep.error('attestation-without-subject', 'An attestation does not say what it is about (plato:attests_about)', c.get(0)); } finally { c.finalize(); }
  }
}

// ---- writers ---------------------------------------------------------------------------------
async function makeWriter(target, env, rep, options, typing, outputs, input) {
  const stem = (options.name || input.files[0].name).replace(/\.(gz)$/i, '').replace(/\.[^.]+$/, '');
  const open = async (ext) => { const o = await env.output(stem + ext); return new TextSink(o); };
  const loss = (l) => rep.loss(l.kind, LOSS_TEXT[l.kind] || l.kind, l.value);
  if (target === 'plato-jsonl' || target === 'plato-json') {
    const sink = await open(TARGETS[target].ext);
    let started = false, inIdrs = false;
    return {
      header(h) {
        const head = { $schema: 'https://w3id.org/plato/schemas/place-centric.schema.json', ...h, profile: 'place-centric' };
        if (target === 'plato-jsonl') sink.write(JSON.stringify(head) + '\n');
        else { const s = JSON.stringify(head); sink.write(s.slice(0, -1) + (s.length > 2 ? ',' : '') + '"spatialEntities":['); }
      },
      event(ev) {
        if (ev.type === 'attestation') { rep.warning('attestation-centric', 'Attestation-centric input is regrouped by place for place-centric output'); return; }
        const line = JSON.stringify(ev.value);
        if (target === 'plato-jsonl') { sink.write(line + '\n'); return; }
        if (ev.type === 'idr' && !inIdrs) { sink.write('],"identityRelations":['); inIdrs = true; started = false; }
        if (ev.type === 'record' && inIdrs) { rep.warning('order', 'A place came after the identity relations; it is written with them'); }
        sink.write((started ? ',' : '') + line); started = true;
      },
      async close() { if (target === 'plato-json') sink.write(']}'); outputs.push(await sink.close()); },
    };
  }
  if (target === 'ntriples') {
    const sink = await open('.nt');
    let triples = 0;
    const wrapped = new Json2Rdf(env.resources.context, (s, p, o) => { triples++; sink.write(tripleNT(s, p, o)); }, { ...typing, onIssue: () => {} });
    return {
      header(h) { wrapped.header(h); },
      event(ev) { wrapped.record(ev.type === 'idr' ? 'identityRelations' : ev.type === 'attestation' ? 'attestations' : ev.newEntity ? 'newSpatialEntities' : 'spatialEntities', ev.value); },
      async close() { rep.count('triples written', triples); outputs.push(await sink.close()); },
    };
  }
  if (target === 'lpf' || target === 'lpf-seq') {
    const sink = await open(TARGETS[target].ext);
    let first = true;
    const pending = new Map();   // identity relations that arrive after their place (DEEP writes them last)
    const feats = [];
    return {
      header(h) {
        const head = { type: 'FeatureCollection', '@context': 'https://raw.githubusercontent.com/LinkedPasts/linked-places-format/main/linkedplaces-context-v1.1.jsonld', title: h.gazetteer?.title };
        if (target === 'lpf-seq') sink.write(JSON.stringify(head) + '\n'); else { const s = JSON.stringify(head); sink.write(s.slice(0, -1) + ',"features":['); }
      },
      event(ev) {
        if (ev.type !== 'record') return;
        const f = recordToFeature(ev.value, options.idrsBySubject.get(ev.value['@id']) || [], loss);
        sink.write(target === 'lpf-seq' ? JSON.stringify(f) + '\n' : (first ? '' : ',') + JSON.stringify(f)); first = false;
      },
      async close() { if (target === 'lpf') sink.write(']}'); outputs.push(await sink.close()); },
    };
  }
  if (target === 'tables') return tablesWriter(env, rep, options, outputs, stem, loss);
  throw new Error(`Unknown target: ${target}`);
}

function tablesWriter(env, rep, options, outputs, stem, loss) {
  const schemas = tableSchemas(env.csvMeta);
  const header = Object.fromEntries(schemas.map((t) => [t.name, t.columns.map((c) => c.titles)]));
  const buffers = Object.fromEntries(schemas.map((t) => [t.name, []]));
  const places = new Map(), sources = new Map(), usedIds = new Set();
  const shortId = (iri, fallback) => {
    let s = (iri || fallback || 'x').replace(/[#/]+$/, '').split(/[#/]/).pop() || fallback || 'x';
    s = decodeURIComponent(s).replace(/\s+/g, '-');
    let id = s, k = 2; while (usedIds.has(id)) id = `${s}-${k++}`;
    usedIds.add(id); return id;
  };
  const ids = {
    place(iri, label, own, ccodes, entityIdentifier) {
      let p = places.get(iri);
      // A record's own identifier (from a place_id, say) is its place_id again, so tables round-trip.
      if (!p) { p = { place_id: entityIdentifier && !usedIds.has(entityIdentifier) ? (usedIds.add(entityIdentifier), entityIdentifier) : shortId(iri, 'place'), label: label || iri, country_codes: '', own }; places.set(iri, p); }
      if (own) { p.own = true; if (label) p.label = label; if (ccodes?.length) p.country_codes = ccodes.join(';'); }
      return p.place_id;
    },
    source(src) {
      if (!src) { if (!sources.has('')) sources.set('', { source_id: 'none', title: 'No source given', citation: '', uri: '', date: 'undated', from: '', to: '', derived_from: '' }); return 'none'; }
      const s = typeof src === 'string' ? { '@id': src } : src;
      const key = s['@id'] || JSON.stringify([s.title, s.citation, s.uri]);
      let r = sources.get(key);
      if (!r) {
        const ts = s.timespan || {};
        r = { source_id: shortId(s['@id'], 'source'), title: s.title || s['@id'], citation: s.citation || '', uri: s.uri || '', date: ts.sourceLabel || ts.label || (ts.startEarliest ? [ts.startEarliest, ts.endLatest].filter(Boolean).join('-') : 'undated'),
          from: ts.startEarliest || '', to: ts.endLatest || '', derived_from: '' };
        sources.set(key, r);
        if (s.derivedFrom) r.derived_from = this.source(s.derivedFrom);
      }
      return r.source_id;
    },
  };
  return {
    header() {},
    event(ev) {
      if (ev.type === 'record') { const rows = recordToRows(ev.value, ids, loss); for (const [k, v] of Object.entries(rows)) buffers[k]?.push(...v); }
      else if (ev.type === 'idr') buffers.identities.push(identityRow(ev.value, ids, loss));
      else if (ev.type === 'attestation') loss({ kind: 'attestation-centric' });
    },
    async close() {
      buffers.places = [...places.values()].map(({ own, ...r }) => r);
      buffers.sources = [...sources.values()];
      const files = {};
      for (const t of schemas) files[t.url] = Papa.unparse({ fields: header[t.name], data: buffers[t.name].map((r) => header[t.name].map((h) => (r[h] === undefined || r[h] === null ? '' : String(r[h])))) }, { newline: '\n' }) + '\n';
      const { zipSync, strToU8 } = await import('fflate');
      const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
      const o = await env.output(stem + '-tables.zip', true);
      o.writeBytes(zip);
      outputs.push(await o.close());
      rep.count('table rows', Object.values(buffers).reduce((n, b) => n + b.length, 0));
    },
  };
}
