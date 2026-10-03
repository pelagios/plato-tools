// Methodos: what one step hands the next. A hand-off is a list of references to files, never the
// files themselves: { type, name, size, sha256 }, as Krisis's work file records its inputs
// (fileRecords in src/engine/krisis/work.js), plus a type from the closed list below. The runner
// refuses a hand-off of the wrong type, in words, before anything runs.
import { fileRecords, filesDiffer } from '../krisis/work.js';

/** The types a hand-off may have, each with the words that name it to the user. */
export const TYPES = {
  files: 'the files as they were chosen',
  dataset: 'a file of places the tools wrote',
  mapping: "a table's columns matched to PLATO",
  'work.krisis': 'a Krisis work file (.krisis.json)',
  'work.hermes-text': "a Hermes work file of a text's places (.hermes-text.json)",
  deposit: 'the files for a deposit (the FAIR report and citation)',
  site: "a dataset's web site, and the files for its repository",
  w3id: 'the permanent-address rules for w3id.org',
};

export class HandoffError extends Error {
  constructor(message) { super(message); this.name = 'HandoffError'; }
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Whether `r` is one well-formed reference. */
export function isRef(r) {
  return !!r && typeof r === 'object' && Object.hasOwn(TYPES, r.type) && typeof r.name === 'string' && r.name !== ''
    && Number.isSafeInteger(r.size) && r.size >= 0 && typeof r.sha256 === 'string' && HEX64.test(r.sha256);
}

/** References to `files` (File or Blob with a name), each of `type`: read through once, for the hash. */
export async function refsOf(files, type) {
  if (!Object.hasOwn(TYPES, type)) throw new HandoffError(`"${type}" is not a type of hand-off; the types are ${Object.keys(TYPES).join(', ')}.`);
  return (await fileRecords(files)).map((r) => ({ type, ...r }));
}

/** The words for a list of types: "a dataset, or the files as they were chosen". */
export const typeWords = (types) => [].concat(types).map((t) => TYPES[t] || `"${t}"`).join(', or ');

/**
 * Refuse, in words, a hand-off that is not a non-empty list of references of one of `accepted`.
 * `what` says where it goes ('the input "dataset" of the step "Build the site"').
 */
export function checkHandoff(refs, accepted, what) {
  if (!Array.isArray(refs) || !refs.length) throw new HandoffError(`Nothing was handed to ${what}: it takes ${typeWords(accepted)}.`);
  for (const r of refs) {
    if (!isRef(r)) throw new HandoffError(`What was handed to ${what} is not a reference to a file (a name, a size and a SHA-256), so it is refused.`);
    if (![].concat(accepted).includes(r.type))
      throw new HandoffError(`${r.name} is ${TYPES[r.type]}, but ${what} takes ${typeWords(accepted)}, so it is refused and nothing was run.`);
  }
  return refs;
}

/**
 * The names of the references no file in `files` matches (by size and SHA-256), and of the files
 * that match no reference: empty when the files are the ones the references name. Krisis's own
 * filesDiffer, over a hand-off.
 */
export const refsDiffer = (refs, files) => filesDiffer({ files: refs }, files);
