// Krisis: finish a review. The decisions in a work file become PLATO attestations
// (src/engine/krisis/identity.js), written out in one of two ways:
//
// - 'attestations': a PLATO document holding only the new attestations. It is attestation-centric
//   (attestation-centric.schema.json), the profile PLATO has for attesting evidence about places
//   that already exist without redefining them: each attestation names its place in `about`, and
//   the document's gazetteer names the dataset the places belong to. Nothing of the places is
//   copied, so the file cannot contradict the dataset it adds to.
// - 'dataset': the subject dataset in PLATO JSON with the new attestations appended to its places,
//   then checked with the version check (the original as the earlier version, the new file as the
//   later). NOT YET AVAILABLE: it needs a hook in the pipeline (options.augment) that another change
//   is adding. See writeDataset below, the one place that will change.
import { Report } from '../report.js';
import { DataError } from '../input.js';
import { readWork, filesDiffer, checkReviewer } from './work.js';
import { attestationsFrom } from './identity.js';

export const OUTPUTS = ['attestations', 'dataset'];
const AC = 'https://w3id.org/plato/schemas/attestation-centric.schema.json';
const TEXT = {
  'work-unreadable': 'The work file cannot be used, so nothing was written',
  'no-reviewer': 'The review does not say who made it: give the reviewer\'s name, which each attestation records as its contributor. Nothing was written.',
  'bad-reviewer': 'The reviewer cannot be recorded as PLATO records a contributor, so nothing was written',
  'subjects-differ': 'The files given are not the ones this review was made of: the places may have changed since. Check the attestations before adding them.',
  'nothing-decided': 'No decision in this review makes an attestation (only "Same place" and "Different places" do), so there is nothing to write.',
  'dataset-not-yet': 'Writing the dataset with the new attestations added is not yet available; choose the new attestations only.',
  'not-valid': 'An attestation made from the review does not match the PLATO JSON Schema, which is a fault in the tools; please report it',
};

/** The name a review's outputs are made from: the subject dataset's, without its extension. */
const stemOf = (subjects, work, options) => (options.name || subjects?.files?.[0]?.name || work.subjects.files[0]?.name || 'review').replace(/\.(gz)$/i, '').replace(/\.[^.]+$/, '');

/**
 * Turn a review's decisions into attestations and write them. `subjects` is the subject dataset as
 * detect() describes it (compared with the files the review was made of, and read again for the
 * 'dataset' output), `work` a work file's object or text. options: output ('attestations' or
 * 'dataset'), reviewer ({ name, orcid? }, else the work file's), date (to stamp every attestation
 * with, else each is dated by its decisions), name (the stem of the output's name).
 * Returns { report, outputs, attestations }, with `incomplete` when nothing could be written.
 */
export async function apply({ subjects, work, options = {} }, env) {
  const rep = new Report();
  const progress = env.progress || (() => {});
  const t0 = Date.now();
  const fail = () => ({ report: rep.toJSON(), outputs: [], attestations: [], incomplete: true });
  const output = options.output || 'attestations';
  if (!OUTPUTS.includes(output)) throw new Error(`Not an output of a review: ${output}`);
  let w;
  try { w = typeof work === 'string' ? readWork(work) : readWork(JSON.parse(JSON.stringify(work))); }
  catch (e) { if (!(e instanceof DataError)) throw e; rep.error('work-unreadable', TEXT['work-unreadable'], e.message); return fail(); }
  const reviewer = options.reviewer || w.reviewer;
  if (!reviewer) { rep.error('no-reviewer', TEXT['no-reviewer']); return fail(); }
  try { checkReviewer(reviewer); } catch (e) { if (!(e instanceof DataError)) throw e; rep.error('bad-reviewer', TEXT['bad-reviewer'], e.message); return fail(); }
  if (subjects?.files) {
    const differ = await filesDiffer(w.subjects, subjects.files);
    if (differ.length) rep.add('warning', 'subjects-differ', TEXT['subjects-differ'], differ.join(', '), differ.length);
  }
  progress({ phase: 'applying', elapsedMs: Date.now() - t0 });
  const made = attestationsFrom(w, { reviewer, date: options.date });
  rep.counts = {
    attestations: made.length,
    matchAttestations: made.filter((m) => !m.attestation.negated).length,
    distinctAttestations: made.filter((m) => m.attestation.negated).length,
    relations: made.reduce((n, m) => n + m.attestation.identities.length, 0),
  };
  if (output === 'dataset') return writeDataset({ subjects, made, work: w, options }, env, rep, fail);
  if (!made.length) { rep.warning('nothing-decided', TEXT['nothing-decided']); return { report: rep.toJSON(), outputs: [], attestations: [] }; }

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

// TODO(Krisis, output 'dataset'): blocked on the pipeline hook `options.augment`, which lands on main
// from another change; do not add it to pipeline.js here. When it has landed, this becomes:
//
//   const bySubject = new Map();
//   for (const { subject, attestation } of made) (bySubject.get(subject) || bySubject.set(subject, []).get(subject)).push(attestation);
//   const r = await run({ input: subjects, action: 'convert', target: 'plato-json', options: { name: stemOf(subjects, work, options) + '.krisis',
//     augment: (record) => bySubject.has(record['@id']) ? { ...record, attestations: [...(record.attestations || []), ...bySubject.get(record['@id'])] } : record } }, env);
//   then compare({ earlier: subjects, later: <the output, detected> }, env), merging both reports into `rep`.
async function writeDataset({ subjects, made, work, options }, env, rep, fail) {
  void subjects; void made; void work; void options; void env;
  rep.error('dataset-not-yet', TEXT['dataset-not-yet']);
  return fail();
}
