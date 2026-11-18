// The plain-language layer of the scholar-facing workflow, Map your data (Stephen, 18 November 2026): what a
// scholar is shown first, in plain words, with the tools' own names and the engine's full words kept beside
// or below them. Pure, so that it is tested in Node (test/plain.test.js); the page puts it on the screen
// (src/app.js, src/methodos/page.js). Nothing here changes what is written or reported: a report keeps
// every item, in its own words, under the plain ones.

/**
 * The tools in plain words, by their own names: what each is called first in the list of tools and in a
 * scholar-facing workflow's steps, its own (Greek) name kept beside it, small, with toolTip() as its title.
 */
export const PLAIN_TOOLS = {
  Methodos: 'Guided steps', Hermes: 'Read my table', Elenchos: 'Check', Metaphrasis: 'Convert', Arithmos: 'Count and compare',
  Krisis: 'Find in gazetteers', Chora: 'Map', Agora: 'Publish', Mneme: 'Compare versions',
};
/** The title of a tool's own name where it stands beside the plain one: "Krisis: the tool that does this". */
export const toolTip = (tool) => `${tool}: the tool that does this`;

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
      return { words: i.count === 1 ? `1 place ${r.reason}.` : `${places(i.count)}: each ${r.reason}.`, remedy: r.remedy, examples: (i.examples || []).map(String) };
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

/**
 * A report's items said in one plain sentence, by kind, where the engine's own words are an expert's: the
 * page shows these first in a scholar-facing workflow, with the engine's words in full below them.
 */
const WORKING_IDS = 'Your places have working ids for now, which is all you need to carry on. Permanent web addresses are only needed if you publish (or send the file to a gazetteer), and are asked for then.';
export const PLAIN_REPORT = {
  'generic-stand-in-base': WORKING_IDS,
  'stand-in-written': WORKING_IDS,
  'attestations-unaddressed': 'These decisions have no web address of their own yet (your places have working ids for now), so if you change one of them later, the earlier answer cannot be taken back for you. To avoid that, give the web address your places will live under, in Options, before you save your decisions.',
  'whg-temporary-ids': 'Your places have working ids for now. WHG would keep those ids as they are: before you send this file to WHG, give the web address your places will live under, or publish first.',
};

/**
 * What recording a review's decisions came to, in plain words (the page's summary of Finish in a scholar-facing
 * workflow), from the run's counts: "Recorded 7 decisions: 8 matches accepted, 0 places said to be different."
 * Returns { problems, counted } as words.js summary() does, or null where the counts are not Finish's.
 */
export function decisionsSummary(report) {
  const c = report?.counts || {}, nErr = report?.errors || 0, v = c.versionCheck;
  if (c.attestations === undefined) return null;
  const many = (k, one, more) => `${n(k || 0)} ${k === 1 ? one : more}`;
  const made = `Recorded ${many(c.attestations, 'decision', 'decisions')}: ${many((c.relations || 0) - (c.distinctAttestations || 0), 'match', 'matches')} accepted, ${many(c.distinctAttestations, 'place', 'places')} said to be different`
    + `${c.retracted ? `, ${many(c.retracted, 'earlier answer', 'earlier answers')} withdrawn` : ''}.`
    + (c.replaced ? ` ${many(c.replaced, 'earlier answer was', 'earlier answers were')} taken out and replaced.` : '')
    + (c.unchanged ? ` ${many(c.unchanged, 'decision was', 'decisions were')} already in your data, saying the same, and not written again.` : '');
  const problems = nErr ? `${many(nErr, 'problem', 'problems')} found.` : !c.attestations ? 'Nothing to save.' : v ? 'Your decisions were saved with your places.' : 'Your decisions were saved.';
  if (!v) return { problems, counted: made };
  const kept = v.changed || v.lost ? `the check of what was there before found ${[v.changed ? `${many(v.changed, 'statement', 'statements')} changed` : '', v.lost ? `${many(v.lost, 'statement', 'statements')} no longer there` : ''].filter(Boolean).join(' and ')}`
    : 'nothing that was there before was deleted or changed';
  return { problems, counted: `${made} Your ${many(c.places, 'place', 'places')} had ${many(v.earlier, 'statement', 'statements')} about them, and now have ${n(v.later)}, with ${n(v.added)} added; ${kept}.` };
}

/**
 * What a step that is the scholar's own waits for, in plain words, by its operation, where the tools' own words
 * (operations.js, waitsFor) are an expert's: completes "This step is yours: it waits for …".
 */
export const PLAIN_WAITS = {
  review: 'you to decide on each suggested match, in the review below',
  // The optional steps: the regions (asked for with "the table says which region each place is in"), the Wikidata items, and the places put on the map by hand.
  'lookup.levels': 'you to settle the regions your places are in, the widest first: press “Review the regions level by level” below, and decide on each region',
  'wikidata.items': 'you to create the Wikidata items, in the panel “Wikidata items” below the review: search Wikidata for the places with no match, run the batch yourself in QuickStatements, then check and record the new items there',
  place: 'you to put the places still without a location on the map, by drawing or tracing them, and to save there (saving on the map does this step)',
};

/**
 * The step done on the map by hand (drawing or tracing the places still without a location), in plain words: what the
 * workflow says there in place of the tools' own words, which name the map by its own name (Chora).
 */
export const PLAIN_MAP = {
  open: 'Open the map',
  chooseSaved: 'Choose the file you saved from the map first, in “Choose your data”.',
  unchanged: (names) => `${names} is the file that went to the map, as it was: nothing drawn there is in it. Save on the map once you have drawn, or choose the file you saved there in “Choose your data”; or, if there was nothing to draw, say so (“Nothing to draw: go on with this dataset”).`,
  notFromIt: (names) => `Open ${names} on the map and save there, or choose a file saved from it and say the step is done.`,
  saved: (names, title) => `${names}, saved on the map: the step “${title}” is done with it.`,
  nothingDrawn: (names) => `Nothing was drawn on the map: the workflow goes on with ${names}, as it was.`,
  takenUp: (chosenAgain = '') => `This step is done on the map.${chosenAgain} Open the map to draw: saving there does this step, with the file it writes. Or choose a file you saved from the map before, and say the step is done.`,
  handback: (names) => ` The map had saved ${names}: choose it in “Choose your data”, and say the step is done.`,
};

/**
 * The publishing steps in plain words. PLAIN_PARTS: the entries of the list beside "Prepare", by their values (index.html,
 * #part), as the list names them in a scholar-facing workflow. PLAIN_PUBLISH: what each step does, by its operation.
 */
export const PLAIN_PARTS = {
  report: 'Check how well the dataset is described, and write the details an archive asks for',
  mint: 'Give every place and source a permanent web address',
  site: 'Make a web site of the places (for GitHub Pages)',
  w3id: 'Write the rules that keep the addresses permanent (w3id.org)',
};
export const PLAIN_PUBLISH = {
  'publish.mint': 'It gives each place, and each statement about it, a permanent web address under the address of your dataset, so that others can cite them; the working ids are replaced.',
  'publish.report': 'It reports what the description of your dataset still needs for others to find and reuse it (the FAIR report), and writes the details an archive such as Zenodo asks for.',
  'publish.site': 'It makes a web site of your places, a page for each, ready to be put on GitHub Pages.',
  'publish.w3id': 'It writes the rules that w3id.org needs, so that the addresses of your places still work if the site ever moves.',
};
/** The part of the list beside "Prepare" that a publishing operation prepares, in plain words. */
export const plainPart = (op) => PLAIN_PARTS[String(op).replace(/^publish\./, '')];
/** What the workflow says at a publishing step: which entry to choose, what to press, and what it does. */
export const publishNext = (op) => `In the list below, choose “${plainPart(op)}”, then press Prepare. ${PLAIN_PUBLISH[op]}`;

/**
 * The end of the review, where the decisions are saved (the tools' "Finish"), in plain words, by the key each part of
 * it has on the page (index.html, data-plain). The two ways of treating a changed decision, and the set of suggestions
 * to publish, are behind the fold there.
 */
export const PLAIN_FINISH = {
  legend: 'Save your decisions',
  dataset: 'Add my decisions to my places (the usual choice). The result is compared with what you began with, to show that nothing was lost or changed.',
  attestations: 'Only my decisions, as a file of their own, to add to a dataset later',
  'draft-legend': 'If you have changed your mind about a match since you last saved, and your data is not yet published',
  withdraw: 'Keep the earlier answer on record, marked as withdrawn (this keeps the history)',
  replace: 'Remove the earlier answer, and write the new one in its place',
  'draft-note': 'Once your data is published, its earlier answers are always kept: a changed decision marks them as withdrawn, whichever you choose.',
  button: 'Save your decisions',
};
/** Above the button that saves the decisions: what saving will cite (the tools' own: words.js, LOOKUP_WORDS.cites). `sources` are [{ title, '@id'? }]. */
export const plainCites = (sources) => (sources.length
  ? `Each decision is saved with its source: ${sources.map((s) => (s['@id'] ? `${s.title} (${s['@id']})` : s.title)).join('; ')}.`
  : 'Nothing is decided yet, so there is nothing to save.');
/** After the decisions are saved, in place of the tools' "This Finish is recorded in the review …". */
export const PLAIN_RECORDED = 'What was saved, and by whom, is noted in your review, so that saving again later can tell what it wrote before: save the review too (“Save the review”).';
/** What the workflow says to press at the step that saves the decisions. */
export const PRESS_SAVE = `“${PLAIN_FINISH.button}”, below the review`;
/** The fold within the review's end, and within the lookup: what each holds. */
export const FINISH_EXPERT_NOTE = 'What happens to an answer you change later, and the list of suggestions for publishing. Neither is needed to save your decisions.';
export const LOOKUP_EXPERT_NOTE = 'Another service, each place’s other names and spellings, the language of the names, filters, and the first queries exactly as they would be sent. None of it is needed to look your places up.';
export const LOOKUP_SENT = 'The first queries, exactly as they would be sent:';
/** Under a candidate's buttons in the review: what the two ways of saying no each do. */
export const DECISION_HINT = '“Not this one” sets this suggestion aside and writes nothing to your data. “Different places” records, with your reason, that the two are known to be different places.';
/** The label of the list that says what a "Same place" is recorded as (exact match, close match). */
export const SAME_PLACE_LABEL = 'Record “Same place” as';
/** Beside a column read as the country each place lies in: what else it does (a lookup's hint, never a filter). */
export const COUNTRY_HINT = 'Also a hint when your places are looked up in a gazetteer: candidates in this country are listed first, and none is left out.';
/** Before a type's code that has no readable name in the data, in the review. */
export const TYPE_CODE = 'type code';
/** The fold that holds what is not the step's own, in a scholar-facing workflow. */
export const EXPERT_SUMMARY = 'More options (for experts)';
export const EXPERT_NOTE = 'Everything else these tools can do with the file chosen. None of it is needed for this workflow.';
