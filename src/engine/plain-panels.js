// The plain-language layer of the panels a scholar-facing workflow opens (Map your data; src/engine/plain.js is the
// layer of its steps and reports): the review of regions, the Wikidata items, the search of a gazetteer on the map,
// the end of the review where the list of suggestions is saved, and the publishing reports that named a command-line
// flag on the page. Each panel keeps the tools' own words (src/engine/words.js), said as they are outside such a
// workflow and on the command line; here are the ones said in their place within one, by the same keys, so that a
// word not listed is the tools' own. Nothing here changes what is sent, written or reported.
// The map's own words are plain everywhere (words.js CHORA_*, and CARD_SAID here; test/chora-plain.test.js), so
// only what a search sends is laid over them.
import { REGION_PAGE, WIKIDATA_WORDS, CHORA_ADOPT_PAGE } from './words.js';

// Whether the plain words are the ones said: on the page, while a scholar-facing workflow is followed (src/app.js
// sets <body data-plain>); in a test, as setPlain() says.
let forced = null;
/** Say the plain words (true), the tools' own (false), or as the page stands (null): for the tests. */
export const setPlain = (on) => { forced = on === null || on === undefined ? null : !!on; };
export const plainOn = () => (forced !== null ? forced : typeof document !== 'undefined' && document.body?.dataset?.plain !== undefined);

const isWords = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** `own` with `plain` laid over it: a group of words (an object) is laid over key by key, anything else replaced. */
export function laidOver(own, plain) {
  const out = { ...own };
  for (const [k, v] of Object.entries(plain)) out[k] = isWords(v) && isWords(own[k]) ? { ...own[k], ...v } : v;
  return out;
}
/** A panel's words: the plain ones while plainOn(), else its own; read word by word, so that it follows the page. */
export function wordsOf(own, plain) {
  const merged = laidOver(own, plain);
  return new Proxy(own, { get: (t, k) => (plainOn() ? merged : t)[k] });
}

const n = (k) => k.toLocaleString('en-GB');
const many = (k, one, more = `${one}s`) => `${n(k)} ${k === 1 ? one : more}`;

/** How a search was widened, said after what it was looked up within. */
const WIDENED = {
  countries: 'without the countries', 'contained-in': 'in the area around the region, not the gazetteer’s own outline of it',
  ancestor: 'in the region above that instead', all: 'everywhere', unconstrained: 'looked up before the regions above it were settled',
};
const NO_OUTLINE = {
  'no-geometry': 'the gazetteer gives no outline for its match', 'point-only': 'the gazetteer gives only a point for its match, not an outline',
  unavailable: 'the gazetteer could not give the record of its match',
};
/** The review of regions (words.js REGION_PAGE). */
export const PLAIN_REGION = {
  how: 'The regions your places are in are looked up first, the widest first. Each is looked for inside the region above it, so settle one level before the next: settling a region opens the regions and places inside it.',
  nav: { locked: (name) => `${name} waiting` },
  identity: { closeMatch: 'much the same region', exactMatch: 'the same region' },
  states: { locked: 'waiting until the region above is settled', ready: 'ready to look up', review: 'looked up: decide below', settled: 'settled' },
  constraint({ looked, kinds, name, countries, radius, needsArea, noArea, relaxed, from, unconstrained }) {
    const verb = looked ? 'Looked up' : 'To be looked up';
    if (unconstrained) return `${verb} everywhere, before the regions were settled.`;
    const parts = [];
    if (kinds.includes('contained_in')) parts.push(`inside ${name}`);
    if (kinds.includes('area')) parts.push(`in the area around ${name} (about ${n(radius)} km across)`);
    if (needsArea) parts.push(`in the area around ${name}`);
    if (kinds.includes('countries')) parts.push(`in ${countries.join(', ')}`);
    const widened = relaxed && relaxed !== 'unconstrained' ? ` Widened: ${WIDENED[relaxed] || relaxed}.` : '';
    if (!parts.length) {
      const why = noArea ? ` (${name} cannot be looked inside: ${NO_OUTLINE[noArea] || noArea})` : from === null && !relaxed ? ' (no region above it is matched)' : '';
      return `${verb} everywhere${why}.${widened}`;
    }
    return `${verb} ${parts.join(' and ')}.${widened}`;
  },
  failedClosed: (name) => `WHG could not keep this search to ${name}, so it answered nothing. That does not mean there is no match: look it up again more widely, with a button below.`,
  approximate: (name) => `WHG kept this search to ${name} only roughly: a place just outside may be suggested, or one just inside left out.`,
  uncoded: 'This search was kept to the countries named, so a place for which WHG records no country is left out, even the right one. If it is missing, look again without the countries.',
  union: (k) => `Matched to ${many(k, 'record')}: what lies inside it is looked for in all of their areas together.`,
  relax: { all: 'Everywhere' },
  cost: (text, p) => `${text} (${many(p.queries, 'search', 'searches')})`,
  candidates: (k) => (k ? `${k === 1 ? 'One suggestion' : `${n(k)} suggestions`} from WHG:` : 'WHG suggested nothing.'),
  confirm: (d, c, name) => `This clears ${many(d, 'decision')} and ${many(c, 'suggestion')} below ${name}.`,
  cleared: (d, c, name) => `Cleared ${many(d, 'decision')} and ${many(c, 'suggestion')} below ${name}.`,
  unconstrained: 'Look up everywhere',
  unconstrainedAll: (k) => `Look up ${k === 1 ? 'it' : `all ${many(k, 'waiting place')}`} everywhere`,
};
export const REGION_SAID = wordsOf(REGION_PAGE, PLAIN_REGION);

const PLAIN_LEFT_OUT = {
  matched: 'matched to a record already', minted: 'already given an item (its number is recorded: to make another, take it out below)',
  undecided: 'with a suggestion still to decide', noAddress: 'with no web address of its own to cite',
  outsideBase: 'with a web address that is not under your dataset’s own', noSource: 'with no source cited for it (Wikidata asks for a serious, public reference)',
};
/** The panel of Wikidata items (words.js WIKIDATA_WORDS). QuickStatements and "batch" are Wikidata's own names for what the scholar meets there, said once in the opening. */
export const PLAIN_WIKIDATA = {
  intro: 'A place left with no match (every suggestion judged not it, or none found) can be given an entry of its own in Wikidata, which Wikidata calls an item. First each place is searched for in Wikidata itself, by name and near its point, and anything found goes into your review like any other suggestion. Then a list of commands (a “batch”) is written for the places still without a match: you run it yourself in QuickStatements, a Wikidata tool, with your own Wikidata account, and these tools never write to Wikidata. Last, once the items exist, you bring their numbers (each begins with Q) back here: each is checked, and recorded as a match, which “Save your decisions” writes into your data.',
  unrecord: 'Take the item’s number out (to make another item)',
  unrecorded: (qid) => `${qid} taken out of the review: the place may be given an item again. A match already written into your data is withdrawn when you next save your decisions.`,
  statements: {
    labels: 'Names, one in each language (Wikidata’s “labels”)', aliases: 'Other names (Wikidata’s “aliases”)', p31: 'The kind of place (Wikidata’s “instance of”, P31)',
    p625: 'Where it is (Wikidata’s “coordinate location”, P625)', p17: 'Its country (P17), from the country code',
    p131: 'The region it is in (P131), where your review of regions matched that region to a Wikidata item',
  },
  leftOut: PLAIN_LEFT_OUT,
  leftOutLine: (left) => Object.entries(left).filter(([, v]) => v.length).map(([k, v]) => `${many(v.length, 'place')} ${PLAIN_LEFT_OUT[k] || WIKIDATA_WORDS.leftOut[k]}`).join('; '),
  unpublished: 'Your data is not published yet, so the web addresses the batch cites may not lead anywhere, and it is being published that makes a place a serious, public reference: publish first, or be sure that every address will work.',
  howTo: [...WIKIDATA_WORDS.howTo.slice(0, 3), 'Then come back here and bring the new items’ numbers in, below.'],
  idsHeading: '5. Bring the new items back',
  pasteLabel: 'Paste the numbers of the new items (each begins with Q; one a line, in the batch’s order; or the table QuickStatements shows):',
  check: 'Check the items',
  noBatch: 'Write a batch first: the items are checked against its rows.',
  pastedCounts: (p) => `${many(p.pairs.length, 'number')} set against the batch’s rows${p.extraQids ? `; ${many(p.extraQids, 'number')} beyond its rows ignored` : ''}${p.rowsLeft ? `; ${many(p.rowsLeft, 'row')} without one` : ''}.`,
  record: (k) => `Record ${many(k, 'match', 'matches')}`,
  recorded: (k) => `${many(k, 'match', 'matches')} recorded in the review: “Save your decisions” writes ${k === 1 ? 'it' : 'them'} into your data. Save the review as well.`,
  needName: 'Give your name as the reviewer first: each match records who made it.',
};
export const WIKIDATA_SAID = wordsOf(WIKIDATA_WORDS, PLAIN_WIKIDATA);

const scopeSaid = ({ labels = [], countries = [] } = {}) => [labels.length ? `inside ${labels.join(' or ')}` : '', countries.length ? `in ${countries.join(' or ')}` : ''].filter(Boolean).join(', ');
/**
 * The search of a gazetteer for one place, on the map (words.js CHORA_ADOPT_PAGE, whose words are plain in themselves,
 * in a workflow or not): within a scholar-facing workflow what a search sends is said without the type and the gazetteer's ids.
 */
export const PLAIN_ADOPT = {
  sends: ({ lang, ...scope }) => `Sent to the gazetteer: the name${lang ? `, and its language (${lang})` : ''}; ${scopeSaid(scope) ? `looked for only ${scopeSaid(scope)}` : 'looked for everywhere'}.`,
  where: (scope) => scopeSaid(scope),
};
export const ADOPT_SAID = wordsOf(CHORA_ADOPT_PAGE, PLAIN_ADOPT);

/**
 * What the map's card says of a place's drawings, and the question before the first is saved: the same in a workflow
 * and outside one (until November 2026 they spoke of attestations outside a workflow, and these were laid over them).
 */
export const CARD_SAID = {
  who: 'Your drawings will be saved under your name, as yours. Who are you?',
  withdrawn: (k) => `${many(k, 'withdrawn statement')} not shown.`,
  draw: 'Draw with the tools on the map. Each drawing is added to what is recorded of this place; nothing already there is changed.',
};

/**
 * The list of suggestions, saved at the end of the review (the tools' "candidate set"): PLAIN_SUGGESTIONS by the key each
 * part has on the page (index.html, data-plain-words), with the end of the review's other parts (plain.js PLAIN_FINISH).
 */
export const PLAIN_SUGGESTIONS = {
  export: 'Save the list of suggestions',
  earlier: 'Lists saved before…',
  'export-note': 'The list records what was suggested for each of your places, so that each decision can say which suggestion it answers. If you published such lists before, give them first: what is already in them is left out.',
};
/** What saving the list came to (words.js candidatesSummary says the same in the tools' own), from its report's counts. */
export function plainExported(c = {}) {
  const left = c.leftOut ? ` ${many(c.leftOut, 'suggestion was', 'suggestions were')} already in a list saved before, and ${c.leftOut === 1 ? 'is' : 'are'} left out of this one.` : '';
  if (c.candidates === undefined) return 'The list of suggestions could not be made.';
  if (!c.candidates) return `No list was written: every suggestion was already in a list saved before.${left}`;
  return `The list of suggestions was saved: it holds ${many(c.candidates, 'suggestion')}.${left} Save the review as well (“Save the review”): it now records which list each suggestion is in.`;
}
/**
 * What stands in the way of saving the decisions with the regions, in plain words (containment.js relateProblem and
 * unexported say the same in the tools' own): `unnamed` decisions do not yet say which suggestion they answer.
 */
export const plainUnexported = (unnamed) => (unnamed
  ? `${many(unnamed, 'of your decisions does', 'of your decisions do')} not yet say which suggestion ${unnamed === 1 ? 'it answers' : 'they answer'}: press “${PLAIN_SUGGESTIONS.export}”, under the review, first, and then “Save your decisions” again.`
  : null);
export const PLAIN_NO_REGIONS = 'The review has no regions, so there is no region to record a place in: find the regions first (the step before).';
export const plainBareRegions = (bare, total) => `${n(bare)} of the ${many(total, 'region')} ${bare === 1 ? 'has' : 'have'} no web address of ${bare === 1 ? 'its' : 'their'} own yet, so nothing can be recorded about ${bare === 1 ? 'it' : 'them'}: give the web address your places will live under (in Options, “Web address for your identifiers”), prepare your places again, and find their regions.`;

/**
 * A report's items said for the page where the tools' own words name the command line (a flag such as --base, which
 * the page does not have): said first wherever the page shows the report, in a workflow or not, with the tools' own
 * words in full below, as plain.js PLAIN_REPORT's are.
 */
export const PAGE_REPORT = {
  'not-w3id': 'These rules are only for a dataset whose web address begins https://w3id.org/, and yours does not (the example gives it). If your own address is to stay as it is, this step is not needed: your site is its address. For an address that goes on working wherever the site moves, give one of the form https://w3id.org/your-name/ in Options (“Web address for your identifiers”), give every place its permanent address again, and then write these rules.',
  'no-maintainers': 'w3id.org asks who looks after the name: give at least one GitHub user name in Options (“w3id maintainers”).',
  'no-site-url': 'The rules send readers on to your dataset’s web site, and where that is is not known yet: in Options, give the GitHub repository it is published from, or “Where the site is served”.',
  'site-is-base': 'The site’s address is the same as the web address of your identifiers, so the rules would send readers round in a circle. In Options, give the site’s own address (“Where the site is served”), or the GitHub repository it is published from.',
  'release-without-repo': 'A release is named in Options (“Release name”), but not the GitHub repository it is published in, so its address would lead nowhere and nothing was written. Give the repository too, or clear the release name.',
};
/** In a scholar-facing workflow (plain.js PLAIN_REPORT is laid over these on the page): what saving the decisions says of the list of suggestions. */
export const PLAIN_SUGGESTIONS_REPORT = {
  'answers-not-exported': `Some of your decisions do not say which suggestion they answer, because the list of suggestions was last saved before those suggestions were made. Your decisions are saved all the same. To have each say what it answers, press “${PLAIN_SUGGESTIONS.export}” again, under the review, and then save your decisions again.`,
  'publish-candidate-sets': 'Your decisions say which suggestion each answers, by the web address of the list of suggestions (the examples name each list). If you publish your data, publish each list with it, so that a reader can follow a decision back to what was suggested.',
};
