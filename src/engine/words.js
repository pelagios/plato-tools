// What the tools say about a run, in the browser (src/app.js) and in the terminal (bin/), so that
// both give the same messages in the same words.
export function fmtBytes(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes'; }
export function fmtTime(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; }
export const FORMAT_NAMES = { tables: 'PLATO spreadsheet tables', 'plato-json': 'a PLATO JSON document', 'plato-jsonl': 'PLATO JSON Lines', ntriples: 'RDF (N-Triples)', nquads: 'RDF (N-Quads)', turtle: 'RDF (Turtle)', lpf: 'a Linked Places Format FeatureCollection', 'lpf-seq': 'a Linked Places Format sequence' };
/** What a detected input is, in words: "PLATO JSON Lines (place-centric)". */
export const formatName = (input) => FORMAT_NAMES[input.format] + (input.profile ? ` (${input.profile})` : '') + (input.lpfVersion === 2 ? ', version 2' : '');

/** A progress event in words: "Loading into the working database: 1,000 triples (3 s)". */
export function progressText(p) {
  const bits = [];
  if (p.triples) bits.push(`${p.triples.toLocaleString('en-GB')} triples`);
  if (p.places) bits.push(`${p.places.toLocaleString('en-GB')} places`);
  if (p.attestations) bits.push(`${p.attestations.toLocaleString('en-GB')} attestations`);
  const phase = { reading: 'Reading', loading: 'Loading into the working database', indexing: 'Indexing', writing: 'Writing', done: 'Finishing' }[p.phase] || p.phase;
  return `${phase}${bits.length ? ': ' + bits.join(', ') : ''} (${fmtTime(p.elapsedMs || 0)})`;
}

/** The two halves of a report's summary: "2 problems found." and "Read 3 places, 5 attestations." */
export function summary(report) {
  const c = report.counts;
  const counted = ['places', 'attestations', 'identity relations', 'triples', 'triples written', 'table rows'].filter((k) => c[k]).map((k) => `${c[k].toLocaleString('en-GB')} ${k}`).join(', ');
  const nErr = report.errors;
  return {
    problems: nErr ? `${nErr.toLocaleString('en-GB')} problem${nErr === 1 ? '' : 's'} found.` : 'No problems found.',
    counted: counted ? `Read ${counted}.` : '',
  };
}

/** The report's groups, in order, with a title and a line saying what each means. */
export function groups(checking) {
  return [
    { severity: 'error', title: 'Problems', intro: 'These must be fixed for the data to be valid PLATO.' },
    { severity: 'warning', title: 'Warnings', intro: 'Worth a look; the data can still be used.' },
    { severity: 'loss', title: checking ? 'Would not be carried over' : 'Not carried over',
      intro: checking ? 'PLATO JSON has no place for these, so a conversion to it would leave them out.' : 'The target format has no place for these, so they are left out.' },
  ];
}
