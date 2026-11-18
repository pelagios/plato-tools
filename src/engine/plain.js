// The plain-language layer of the scholar-facing workflow, Map your data (Stephen, 18 November 2026): what a
// scholar is shown first, in plain words, with the tools' own names and the engine's full words kept beside
// or below them. Pure, so that it is tested in Node (test/plain.test.js); the page puts it on the screen
// (src/app.js, src/methodos/page.js). Nothing here changes what is written or reported: a report keeps
// every item, in its own words, under the plain ones.

/**
 * The formats a scholar asks for first, in plain words, by a conversion's target key: the names they have
 * in the list beside Convert at the step that writes the result, where a workflow's recipe offers them.
 */
export const PLAIN_TARGETS = {
  'table-flat': 'A spreadsheet: one row per place (CSV)',
  lpf2: 'A file for the World Historical Gazetteer (Linked Places Format v2)',
};

/**
 * The list beside Convert at a workflow's step that writes its result: the recipe's choices first, in
 * its order, then whatever else can be written, each [key, label]; `own`, the format of the file chosen,
 * is left out (a file is not converted into itself). `targets` is the engine's { key: { label } }.
 */
export function targetList(targets, choices = [], own = null) {
  const keys = [...choices.filter((k) => Object.hasOwn(targets, k)), ...Object.keys(targets).filter((k) => !choices.includes(k))];
  return keys.filter((k) => k !== own).map((k) => [k, (choices.includes(k) && PLAIN_TARGETS[k]) || targets[k].label]);
}

/**
 * What a format chosen at the step that writes the result cannot hold of the decisions a review made,
 * said before it is written (rich R1), or '' for one that holds them all. `decided` is how many
 * decisions the dataset records. Linked Places Format (either version) and the ten spreadsheet tables
 * keep each match as a link alone; the flat table also says who decided each, and of what kind.
 */
export function lossyWords(target, decided) {
  if (!decided) return '';
  const n = `the ${decided.toLocaleString('en-GB')} ${decided === 1 ? 'decision' : 'decisions'} this dataset records about which places are the same`;
  const kept = 'The workflow keeps the full dataset (PLATO JSON), which has all of it: choose PLATO JSON in the list to download that too.';
  const links = (name) => `${name}, the format chosen beside Convert, cannot hold everything in ${n}: each match is kept as a link, but not who decided it or from which candidate, and a place you said was not the same is left out. PLATO JSON keeps all of it.`;
  if (target === 'lpf' || target === 'lpf-seq') return links('Linked Places Format');
  if (target === 'lpf2' || target === 'lpf2-seq') return links('Linked Places Format v2, the file for the World Historical Gazetteer');
  if (target === 'tables') return links('The spreadsheet tables');
  if (target === 'table-flat') return `The spreadsheet, chosen beside Convert, is a summary of ${n}: each match is kept with its kind, the gazetteer it is in and who decided it, but not the candidate it answered, and a place you said was not the same is left out. ${kept}`;
  return '';
}

const n = (k) => k.toLocaleString('en-GB');
const places = (k) => `${n(k)} ${k === 1 ? 'place' : 'places'}`;
const item = (report, kind) => (report?.items || []).find((i) => i.kind === kind);
/** A WHG refusal's reason and remedy, from the report's own words for it (report.js: "… these places: each <reason>. Nothing in them is changed … by title and id.<remedy>"). */
function refusal(message) {
  const m = /these places: each (.+?)\. Nothing in them is changed to make them pass; the examples name the first few, by title and id\.(.*)$/s.exec(message || '');
  return m ? { reason: m[1], remedy: m[2].trim().replace(/^Nothing is made up for them: /, '').replace(/^t/, 'T') } : null;
}

/**
 * What came of writing a result, in plain words, for the top of the result (above the report, which keeps
 * every item in full): null when the report has nothing of the kind. For Linked Places Format v2:
 *   { kind: 'whg', tone: 'good' | 'warn', head, reasons: [{ words, remedy, examples }], notes: [words], scope }
 * `head` is "11 of 12 places would be accepted by WHG; 1 would be refused:" (with its reasons below), or that
 * all would be, or none; `scope` what the verdict is and is not (WHG's schema, as copied; not its test of shapes).
 * For the flat table: { kind: 'flat', tone: 'good', head, reasons: [], notes, scope: '' }.
 */
export function outcome(report) {
  const verdict = item(report, 'whg-verdict');
  if (verdict) {
    const reasons = (report.items || []).filter((i) => /^whg-/.test(i.kind) && refusal(i.message)).map((i) => {
      const r = refusal(i.message);
      return { words: `${places(i.count)}: each ${r.reason}.`, remedy: r.remedy, examples: (i.examples || []).map(String) };
    });
    const total = report.counts?.places || 0, refused = verdict.severity === 'warning' && total ? Math.min(verdict.count, total) : 0;
    const [said, ...rest] = verdict.message.split(/(?<=\.) (?=This is WHG's schema)/);
    const head = !total ? said
      : !refused ? said
        : refused === total ? `${total === 1 ? 'The one place would be refused by WHG' : `None of the ${n(total)} places would be accepted by WHG`}:`
          : `${n(total - refused)} of ${places(total)} would be accepted by WHG; ${n(refused)} would be refused:`;
    const notes = [];
    const temporary = item(report, 'whg-temporary-ids');
    if (temporary) notes.push(`Your places have working ids for now (${places(temporary.count)}). WHG would keep those ids as they are, so before you send this file to WHG, give the web address your places will live under (in Options, “Web address for your identifiers”) and convert again, or publish first.`);
    const unchecked = item(report, 'whg-not-checked');
    if (unchecked) notes.push(`${places(unchecked.count)} could not be checked, so what WHG would say of ${unchecked.count === 1 ? 'it' : 'them'} is not known; the report below says why.`);
    return { kind: 'whg', tone: refused || !total ? 'warn' : 'good', head, reasons, notes, scope: rest.join(' ') };
  }
  const flat = item(report, 'flat-summary');
  const unmatched = item(report, 'flat-no-match-recorded');
  if (flat || unmatched) {
    const total = report.counts?.['table rows'] ?? report.counts?.places ?? 0;
    const notes = [];
    if (unmatched) notes.push(`${places(unmatched.count)}${total ? ` of ${n(total)}` : ''} ${unmatched.count === 1 ? 'has' : 'have'} “no match recorded”: never looked up, skipped, or looked up with nothing found or accepted. The table cannot say which; your review can.`);
    notes.push('The spreadsheet is a summary to read, not the whole dataset: it cannot be read back in. Keep the PLATO JSON as the dataset itself.');
    return { kind: 'flat', tone: 'good', head: `Your spreadsheet has one row for each of the ${places(total)}, with its match and its location.`, reasons: [], notes, scope: '' };
  }
  return null;
}
