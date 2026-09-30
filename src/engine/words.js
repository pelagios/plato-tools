// What the tools say about a run, in the browser (src/app.js) and in the terminal (bin/), so that
// both give the same messages in the same words.
export function fmtBytes(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes'; }
export function fmtTime(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; }
export const FORMAT_NAMES = { tables: 'PLATO spreadsheet tables', 'plato-json': 'a PLATO JSON document', 'plato-jsonl': 'PLATO JSON Lines', ntriples: 'RDF (N-Triples)', nquads: 'RDF (N-Quads)', turtle: 'RDF (Turtle)', lpf: 'a Linked Places Format FeatureCollection', 'lpf-seq': 'a Linked Places Format sequence', 'w3c-annotations': 'W3C Web Annotations (as Recogito exports them)' };
/** What a detected input is, in words: "PLATO JSON Lines (place-centric)". */
export const formatName = (input) => FORMAT_NAMES[input.format] + (input.profile ? ` (${input.profile})` : '') + (input.lpfVersion === 2 ? ', version 2' : '');

// A count in words, singular for one: "1 place", "2 places", "1 identity relation".
const ONE = { 'earlier attestations': 'earlier attestation', annotations: 'annotation', places: 'place', attestations: 'attestation', 'identity relations': 'identity relation', triples: 'triple', 'triples written': 'triple written', 'table rows': 'table row', observations: 'Data Cube observation' };
const MANY = { observations: 'Data Cube observations' };
const count = (n, what) => `${n.toLocaleString('en-GB')} ${n === 1 ? ONE[what] || what : MANY[what] || what}`;

/**
 * What the page and the command line add to a PLATO pin that is not the head of PLATO's main branch
 * (`npm run vendor -- --ref NAME`): a draft, which must never pass for a release. Empty otherwise.
 */
export const draftNote = (v) => (v?.draft ? `DRAFT: PLATO's ${v.ref} branch, not a release` : '');

/** A progress event in words: "Loading into the working database: 1,000 triples (3 s)". */
export function progressText(p) {
  const bits = [];
  if (p.triples) bits.push(count(p.triples, 'triples'));
  if (p.places) bits.push(count(p.places, 'places'));
  if (p.attestations) bits.push(count(p.attestations, 'attestations'));
  const phase = { reading: 'Reading', loading: 'Loading into the working database', indexing: 'Indexing', writing: 'Writing', done: 'Finishing', read: 'Read', comparing: 'Comparing the two versions' }[p.phase] || p.phase;
  // The version check reads two inputs, one after the other, and says which it is on.
  const which = p.version ? `${p.version === 'earlier' ? 'Earlier' : 'Later'} version${p.again ? ', again, to see what changed' : ''}: ` : '';
  return `${which}${phase}${bits.length ? ': ' + bits.join(', ') : ''} (${fmtTime(p.elapsedMs || 0)})`;
}

/**
 * The two halves of a report's summary: "2 problems found." and "Read 3 places, 5 attestations."
 * A comparison of two versions (`action` 'compare') counts other things, in other words.
 */
export function summary(report, action) {
  const c = report.counts;
  if (action === 'compare') return compareSummary(report);
  if (action === 'publish') return publishSummary(report);
  const counted = ['annotations', 'places', 'attestations', 'identity relations', 'triples', 'triples written', 'table rows', 'observations'].filter((k) => c[k]).map((k) => count(c[k], k)).join(', ');
  const nErr = report.errors;
  return {
    problems: nErr ? `${nErr.toLocaleString('en-GB')} problem${nErr === 1 ? '' : 's'} found.` : 'No problems found.',
    counted: counted ? `Read ${counted}.` : '',
  };
}

/** What changed in one example of a version check, a line for each statement only one version makes. */
export function explainedLines(x) {
  return [...x.earlier.map((t) => `Only in the earlier version: ${t}`), ...x.later.map((t) => `Only in the later version: ${t}`)];
}

/** The summary of a version check: whether the append-only rule holds, and what became of the earlier attestations. */
function compareSummary(report) {
  const c = report.counts, n = (x) => (x || 0).toLocaleString('en-GB');
  if (c.earlier === undefined) return { problems: 'The two versions could not be compared.', counted: '' };
  const parts = [`${n(c.unchanged)} unchanged`];
  if (c.changed) parts.push(`${n(c.changed)} changed`);
  if (c.lost) parts.push(`${n(c.lost)} no longer there`);
  const withdrawn = [c.retracted ? `retracts ${n(c.retracted)}` : '', c.superseded ? `replaces ${n(c.superseded)}` : ''].filter(Boolean).join(' and ');
  const nErr = report.errors;
  return {
    problems: nErr ? `${n(nErr)} problem${nErr === 1 ? '' : 's'} found.`
      : c.unchanged === c.earlier ? 'Nothing was deleted or changed.' : 'The append-only rule is not broken, but see the warnings.',
    counted: `Of ${count(c.earlier, 'earlier attestations')}, ${parts.join(', ')}. The later version has ${count(c.later, 'attestations')}, ${n(c.added)} of them new${withdrawn ? `; it ${withdrawn} of the earlier ones` : ''}.`,
  };
}

/**
 * The summary of a part of publishing (Agora): whether anything stops publication, and what the
 * part counted. Each part counts in its own words (report.counts.said, a list of short phrases).
 */
function publishSummary(report) {
  const nErr = report.errors, said = report.counts.said || [];
  return {
    problems: nErr ? `${nErr.toLocaleString('en-GB')} problem${nErr === 1 ? '' : 's'} to fix before publishing.` : 'Nothing stops publication.',
    counted: said.length ? said.join(' ') : '',
  };
}

/** The report's groups, in order, with a title and a line saying what each means, for `action` 'check', 'convert' or 'compare'. */
export function groups(action) {
  const checking = action === 'check';
  if (action === 'publish') return [
    { severity: 'error', title: 'Problems', intro: 'These stop the dataset being published as it is.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth fixing: the dataset can be published, but is harder to find, cite or reuse.' },
  ];
  if (action === 'compare') return [
    { severity: 'error', title: 'Problems', intro: 'These break the append-only rule: once a dataset is published, its attestations are added to, never deleted or changed.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look; none of these breaks the rule.' },
  ];
  return [
    { severity: 'error', title: 'Problems', intro: 'These must be fixed for the data to be valid PLATO.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look; the data can still be used.' },
    { severity: 'loss', title: checking ? 'Would not be carried over' : 'Not carried over',
      intro: checking ? 'PLATO JSON has no place for these, so a conversion to it would leave them out.' : 'The target format has no place for these, so they are left out.' },
  ];
}
