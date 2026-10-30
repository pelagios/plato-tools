// Arithmos: "Check the Data Cube" (plan #34, item 11, branch B0). The action `datacube` of run(): the Data Cube
// integrity constraints and the checks on the figures (src/lib/datacube.js: IC-1, 2, 11, 12 and 14, P-1 to P-4,
// and IC-19 when a code file is given), as a report like any other run's, so that the page, the command line and
// Methodos (the operation check.cube) say the same.
//
// The input is a cube export (N-Triples written by convert --to ntriples --cube), or a PLATO dataset (or any
// input the converter reads), which is converted to its cube export in memory first, and whose own problems are
// part of the report. Q9: a constraint that fails blocks (an error), P-2, the arithmetic of a universe's
// parts, warns; a constraint with nothing to evaluate is a warning (never passed), and every constraint is noted with
// the count it evaluated, so that a verdict is never separated from its denominator.
import { cubeChecks, graphOfFile, GraphBuilder, CHECK_WORDS } from '../lib/datacube.js';
import { lineChunks } from './input.js';
import { run } from './pipeline.js';
import { FIGURE_KINDS } from './figurecheck.js';
import { CUBE_CHECK_TEXT } from './report.js';

/** At most this many violations are examples of a finding; the rest are counted. */
const EXAMPLES = 5;

export async function checkCube({ input, options = {} }, env, rep) {
  const { codes, ...rest } = options;
  const codesText = codes ? await codes.text() : undefined;
  let g;
  if (input.format === 'ntriples') g = await graphOfFile(input.files[0], { codes });
  else {
    // The cube export, made in memory: the converter writes it as text, and the graph is read from it as it is written.
    const builder = new GraphBuilder();
    const sink = async (name) => ({ write: (s) => builder.write(s), writeBytes: () => {}, close: async () => ({ name, size: 0 }) });
    const made = await run({ input, action: 'convert', target: 'ntriples', options: { ...rest, cube: true } }, { ...env, output: sink });
    // The dataset's own problems and warnings are part of this report; the figure kinds are left out, as the cube check says the same in its own words.
    for (const i of made.report.items) {
      if ((i.severity === 'error' || i.severity === 'warning') && !FIGURE_KINDS.includes(i.kind)) {
        for (const e of i.examples.length ? i.examples : [undefined]) rep.add(i.severity, i.kind, i.message, e, i.examples.length ? 1 : i.count);
        if (i.examples.length && i.count > i.examples.length) rep.add(i.severity, i.kind, i.message, undefined, i.count - i.examples.length);
      }
    }
    if (made.incomplete) return { report: rep.toJSON(), outputs: [], incomplete: true, ...(made.aborted ? { aborted: true } : {}) };
    g = builder.finish({ codes: codesText });
  }
  const results = cubeChecks(g);
  rep.counts.observations = results[0].evaluated;
  rep.counts.checks = results.map(({ ic, status, evaluated, violations, blocks, skipped }) => ({ ic, status, evaluated, violations: violations.length, blocks, ...(skipped ? { skipped } : {}) }));
  for (const r of results) {
    const what = CHECK_WORDS[r.ic], kind = r.ic.toLowerCase();
    rep.note('cube-checked', CUBE_CHECK_TEXT.checked(r.ic, what, r.status, r.evaluated, r.skipped));
    if (r.status === 'fail') {
      const message = (r.blocks ? CUBE_CHECK_TEXT.fail : CUBE_CHECK_TEXT.warn)(r.ic, what, r.violations.length);
      const add = r.blocks ? rep.error : rep.warning;
      for (const v of r.violations.slice(0, EXAMPLES)) add.call(rep, kind, message, v);
      if (r.violations.length > EXAMPLES) rep.add(r.blocks ? 'error' : 'warning', kind, message, undefined, r.violations.length - EXAMPLES);
    // The five integrity constraints over nothing are not a pass, and are said so; P-1 to P-4 over nothing are usual (a table with no totals) and only noted above.
    } else if (r.status === 'not-tested' && !r.ic.startsWith('P-')) rep.warning('cube-not-tested', CUBE_CHECK_TEXT.notTested(r.ic, what));
  }
  return { report: rep.toJSON(), outputs: [] };
}
