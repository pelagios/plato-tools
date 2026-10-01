// Krisis: finish a review. The decisions in a work file become PLATO attestations
// (src/engine/krisis/identity.js), written out in one of two ways:
//
// - 'dataset' (the default): the subject dataset in PLATO JSON (place-centric) with the new
//   attestations appended to the places they are about. The dataset is converted by the pipeline
//   (run(), whatever format it came in), which hands each place to options.augment on its way to the
//   writer; then the version check (compare.js) reads the original as the earlier version and the new
//   file as the later, and anything it finds deleted or changed is a fault in the tools.
// - 'attestations': a PLATO document holding only the new attestations. It is attestation-centric
//   (attestation-centric.schema.json), the profile PLATO has for attesting evidence about places
//   that already exist without redefining them: each attestation names its place in `about`, and
//   the document's gazetteer names the dataset the places belong to. Nothing of the places is
//   copied, so the file cannot contradict the dataset it adds to.
import { Report } from '../report.js';
import { DataError, detect } from '../input.js';
import { run, CANDIDATE_SET_TEXT } from '../pipeline.js';
import { compare } from '../compare.js';
import { KRISIS_TEXT } from '../words.js';
import { readWork, filesDiffer, checkReviewer, NOT_READ_KINDS } from './work.js';
import { attestationsFrom, datasetSource } from './identity.js';

export const OUTPUTS = ['attestations', 'dataset'];
const AC = 'https://w3id.org/plato/schemas/attestation-centric.schema.json';
const TEXT = {
  'work-unreadable': 'The work file cannot be used, so nothing was written',
  'no-reviewer': 'The review does not say who made it: give the reviewer\'s name, which each attestation records as its contributor. Nothing was written.',
  'bad-reviewer': 'The reviewer cannot be recorded as PLATO records a contributor, so nothing was written',
  'subjects-differ': 'The files given are not the ones this review was made of: the places may have changed since. Check the attestations before adding them.',
  'nothing-decided': 'No decision in this review makes an attestation (only "Same place" and "Different places" do), so there is nothing to write.',
  'not-valid': 'An attestation made from the review does not match the PLATO JSON Schema, which is a fault in the tools; please report it',
};

const sameMapping = (a, b) => { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]); };

/** The name a review's outputs are made from: the subject dataset's, without its extension. */
const stemOf = (subjects, work, options) => (options.name || subjects?.files?.[0]?.name || work.subjects.files[0]?.name || 'review').replace(/\.(gz)$/i, '').replace(/\.[^.]+$/, '');

/**
 * Turn a review's decisions into attestations and write them. `subjects` is the subject dataset as
 * detect() describes it (compared with the files the review was made of, and read again for the
 * 'dataset' output), `work` a work file's object or text. options: output ('dataset', the default,
 * or 'attestations'), reviewer ({ name, orcid? }, else the work file's), date (to stamp every
 * attestation with, else each is dated by its decisions), name (the stem of the output's name),
 * base (spreadsheet tables: the base address of their places, as given to match()), columns (a table
 * of places: the mapping of its columns, else the one in the work file), othersTitle
 * (the other dataset's title, for the source the attestations cite, in place of the work file's).
 * Returns { report, outputs, attestations }, with `incomplete` when nothing could be written.
 */
export async function apply({ subjects, work, options = {} }, env) {
  const rep = new Report();
  const progress = env.progress || (() => {});
  const t0 = Date.now();
  const fail = () => ({ report: rep.toJSON(), outputs: [], attestations: [], incomplete: true });
  const output = options.output || 'dataset';
  if (!OUTPUTS.includes(output)) throw new Error(`Not an output of a review: ${output}`);
  let w;
  try { w = typeof work === 'string' ? readWork(work) : readWork(JSON.parse(JSON.stringify(work))); }
  catch (e) { if (!(e instanceof DataError)) throw e; rep.error('work-unreadable', TEXT['work-unreadable'], e.message); return fail(); }
  const reviewer = options.reviewer || w.reviewer;
  if (!reviewer) { rep.error('no-reviewer', TEXT['no-reviewer']); return fail(); }
  try { checkReviewer(reviewer); } catch (e) { if (!(e instanceof DataError)) throw e; rep.error('bad-reviewer', TEXT['bad-reviewer'], e.message); return fail(); }
  // Spreadsheet tables' places take their addresses from the base address: another than the review's gives other places.
  const reviewedBase = w.match_parameters.base || undefined, base = options.base || undefined;
  if (subjects?.format === 'tables' && reviewedBase !== base) rep.warning('base-differs', KRISIS_TEXT.baseDiffers(reviewedBase, base));
  // A table of places is read by the mapping of its columns the review was made with, unless another is given (and said to differ).
  const reviewedColumns = w.match_parameters.columns, columns = options.columns || reviewedColumns;
  // Said both ways, as the base address is: a mapping given now to a review made by the guess differs as much as one made by another mapping.
  if (options.columns && (subjects?.format === 'csv' || subjects?.format === 'geojson') && (!reviewedColumns || !sameMapping(options.columns, reviewedColumns)))
    rep.warning('columns-differ', KRISIS_TEXT.columnsDiffer);
  options = { ...options, columns };
  if (subjects?.files) {
    const differ = await filesDiffer(w.subjects, subjects.files);
    if (differ.length) rep.add('warning', 'subjects-differ', TEXT['subjects-differ'], differ.join(', '), differ.length);
  }
  progress({ phase: 'applying', elapsedMs: Date.now() - t0 });
  // The source the attestations cite: the other dataset, by the title given now, else the work file's.
  const given = typeof options.othersTitle === 'string' ? options.othersTitle.trim() : '';
  const others = given ? { ...w.others, title: given, titleFrom: 'given' } : w.others;
  if (others.titleFrom === 'file-name') rep.warning('others-title-is-file-name', KRISIS_TEXT.othersTitleIsFileName(others.title));
  const made = attestationsFrom(w, { reviewer, date: options.date, source: datasetSource(others) });
  rep.counts = {
    attestations: made.length,
    matchAttestations: made.filter((m) => !m.attestation.negated).length,
    distinctAttestations: made.filter((m) => m.attestation.negated).length,
    relations: made.reduce((n, m) => n + m.attestation.identities.length, 0),
  };
  if (!made.length) { rep.warning('nothing-decided', TEXT['nothing-decided']); return { report: rep.toJSON(), outputs: [], attestations: [] }; }
  if (output === 'dataset') {
    // Each attestation is checked as the checker would check it in a place-centric dataset, before anything is
    // converted: the profile has no schema for an attestation alone, so it is checked under a place of its own.
    const V = env.resources.validators['place-centric'].entity;
    for (const { subject, attestation } of made) {
      if (!V({ '@id': subject, label: subject, attestations: [attestation] })) rep.error('not-valid', TEXT['not-valid'], `${subject}: ${V.errors.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
    }
    if (rep.toJSON().errors) return fail();
    return writeDataset({ subjects, made, work: w, options }, env, rep, fail);
  }

  const doc = attestationsDocument(w, made);
  // Each attestation is checked as the checker would check it: what is written must be valid PLATO.
  const V = env.resources.validators['attestation-centric'];
  for (const a of doc.attestations) if (!V.attestation(a)) rep.error('not-valid', TEXT['not-valid'], `${a.about}: ${V.attestation.errors.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
  if (rep.toJSON().errors) return fail();
  const o = await env.output(stemOf(subjects, w, options) + '.krisis-attestations.json');
  o.write(JSON.stringify(doc, null, 2) + '\n');
  const outputs = [await o.close()];
  progress({ phase: 'done', attestations: made.length, elapsedMs: Date.now() - t0 });
  return { report: rep.toJSON(), outputs, attestations: made };
}

/** The new attestations as an attestation-centric PLATO document, about the subject dataset's places. */
export function attestationsDocument(work, made) {
  const gazetteer = { ...(work.subjects.uri ? { '@id': work.subjects.uri } : {}), title: work.subjects.title };
  return { $schema: AC, profile: 'attestation-centric', gazetteer, attestations: made.map(({ subject, attestation }) => ({ about: subject, ...attestation })) };
}

// ---- the dataset, with the new attestations added -------------------------------------------------
// What the version check reports that a dataset only added to cannot have: something deleted or changed.
const CHANGED = new Set(['attestation-removed', 'attestation-changed', 'attestation-gone', 'facet-changed', 'facet-removed', 'facet-added-to',
  'identity-removed', 'identity-changed', 'identity-gone', 'description-removed', 'description-changed']);
// What stops part of the dataset being read: the dataset written would then lack what was not.
const NOT_READ = new Set(['unreadable', ...NOT_READ_KINDS]);

/**
 * env, with each output also kept as Blob parts, so that the file can be read again for the version
 * check (env has no way to read an output back). The whole output is held until the check is done.
 */
function teeing(env, kept) {
  return { ...env, output: async (name, binary) => {
    const o = await env.output(name, binary);
    const parts = [];
    return {
      write: (s) => { parts.push(new Blob([s])); o.write(s); },
      writeBytes: (b) => { parts.push(new Blob([b])); o.writeBytes(b); },
      close: async () => { const r = await o.close(); kept.set(name, parts); return r; },
    };
  } };
}

async function writeDataset({ subjects, made, work, options }, env, rep, fail) {
  const K = KRISIS_TEXT;
  if (!subjects?.format) { rep.error('no-dataset', K.noDataset); return fail(); }
  // A candidate set (PLATO 53c5a40) holds no places to add attestations to: refused, as the other tools
  // that read a dataset's records refuse it, before anything is written.
  if (subjects.profile === 'candidate-set') { rep.error('candidate-set-not-a-dataset', CANDIDATE_SET_TEXT['candidate-set-not-a-dataset']); return fail(); }
  const progress = env.progress || (() => {});
  const t0 = Date.now();
  // Each place's new attestations, appended when the pipeline hands the place over: once, should
  // the dataset give the same place twice.
  const bySubject = new Map(), met = new Set();
  for (const { subject, attestation } of made) (bySubject.get(subject) || bySubject.set(subject, []).get(subject)).push(attestation);
  const augment = (record) => {
    const id = record?.['@id'];
    if (!bySubject.has(id) || met.has(id)) return record;
    met.add(id);
    return { ...record, attestations: [...(record.attestations || []), ...bySubject.get(id)] };
  };
  const name = stemOf(subjects, work, options) + '.krisis-dataset.json';
  const kept = new Map();
  const r = await run({ input: subjects, action: 'convert', target: 'plato-json', options: { name, base: options.base, columns: options.columns, augment } }, teeing(env, kept));
  // What the conversion says of the dataset. Its own problems are its own, not the review's: they
  // are counted, and the dataset is best checked by itself. What stopped it being read is not.
  let own = 0;
  for (const i of r.report.items) {
    if (NOT_READ.has(i.kind)) rep.add('error', 'dataset-not-read', `${K.datasetNotRead}: ${i.message}`, i.examples[0], i.count);
    else if (i.severity === 'error') own += i.count;
    else rep.add(i.severity, i.kind, i.message, i.examples[0], i.count);
  }
  if (own) rep.add('warning', 'dataset-has-problems', K.datasetHasProblems, undefined, own);
  if (subjects.format !== 'plato-json' || subjects.profile === 'attestation-centric') rep.add('warning', 'dataset-now-plato-json', K.datasetNowPlatoJson(subjects), name);
  for (const [subject, list] of bySubject) if (!met.has(subject)) rep.add('error', 'not-in-dataset', K.notInDataset, subject, list.length);
  rep.counts.places = r.report.counts.places || 0;
  const parts = kept.get(name);
  if (r.incomplete || !parts || rep.toJSON().errors) return fail();

  progress({ phase: 'checking', elapsedMs: Date.now() - t0 });
  const c = await checkAppendOnly({ earlier: subjects, later: new File(parts, name), added: made.length, options }, env, rep);
  kept.clear();
  if (c.incomplete || rep.toJSON().errors) return fail();
  progress({ phase: 'done', attestations: made.length, elapsedMs: Date.now() - t0 });
  return { report: rep.toJSON(), outputs: r.outputs, attestations: made };
}

/**
 * The version check of a dataset written with new attestations: `earlier` is the subject dataset (as
 * detect() describes it), `later` the File written. It must find nothing deleted or changed, and
 * `added` attestations added. What it finds goes into `rep` (errors 'not-append-only', 'not-checked'
 * and 'not-all-added'), and its counts into rep.counts.versionCheck. Returns compare()'s result.
 */
export async function checkAppendOnly({ earlier, later, added, options = {} }, env, rep) {
  const K = KRISIS_TEXT;
  const c = await compare({ earlier, later: await detect([later]), options: { base: options.base, columns: options.columns } }, env);
  for (const i of c.report.items) {
    if (CHANGED.has(i.kind)) {
      rep.add('error', 'not-append-only', `${K.notAppendOnly} ${i.message}`, i.examples[0], i.count);
      for (const x of i.explained || []) rep.explain('not-append-only', x.example, x.earlier, x.later);
    } else if (i.kind === 'unreadable' || i.kind === 'version-not-read') rep.add('error', 'not-checked', `${K.notChecked}: ${i.message}`, i.examples[0], i.count);
    else if (i.kind === 'not-compared') rep.add('warning', i.kind, i.message, i.examples[0], i.count);
  }
  const k = c.report.counts;
  if (k.earlier !== undefined) {
    rep.counts.versionCheck = { earlier: k.earlier, later: k.later, unchanged: k.unchanged, changed: k.changed, lost: k.lost, added: k.added };
    if (k.added !== added) rep.add('error', 'not-all-added', K.notAllAdded(added, k.added));
  }
  return c;
}
