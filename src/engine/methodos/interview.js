// Methodos: the interview (docs/plans/methodos.md, section 3; decision 2 of section 12). Not a
// chatbot: a fixed set of questions whose answers choose one of the named recipes and set its
// parameters, so that the same answers always give the same workflow, and a test can say which.
//   1. What do you have?           (HAVE)
//   2. What do you want at the end? (WANT; "not sure" leads to the plain grid of the tools' cards)
//   3. Anything of these?           only the recipe's yes-or-no questions the first two left open.
// No composition: answers that name no recipe say so, and which tools do the work meanwhile.
import { OPERATIONS } from './operations.js';
import { RECIPES } from './recipes/index.js';
import { applies } from './recipe.js';

export const HAVE = Object.freeze([
  ['table', 'A list of place names (a spreadsheet or CSV)'],
  ['text', 'A text that names places'],
  ['tei', 'An edition in TEI'],
  ['recogito', 'Annotations from Recogito'],
  ['plato', 'A dataset already in a PLATO format'],
  ['map', 'A map image'],
  ['nothing', 'Nothing yet'],
].map(([key, words]) => Object.freeze({ key, words })));

export const WANT = Object.freeze([
  ['map', 'Places on a map, each identified in a gazetteer'],
  ['publish', 'A citable, published dataset'],
  ['version', 'A new version of a published dataset, checked'],
  ['convert', 'A file in another format'],
  ['match', 'A match of two datasets'],
  ['cube', 'Figures as a Data Cube'],
  ['commons', 'A map image for Wikipedia or Commons'],
  ['unsure', 'I am not sure: show me what the tools can do'],
].map(([key, words]) => Object.freeze({ key, words })));

// The answers that name a recipe: [have, want] -> the recipe, the answers the first two questions
// settle, and the recipe's yes-or-no questions still to ask, in the recipe's order.
// `base`: when the base address is asked (Stephen, 4 October 2026: only for workflows that mint
// addresses; 12 October 2026: by every workflow that publishes, in one shared field, optional): under any of
// the yes-or-no answers in `when` (given, or settled by the first two questions), else always; and needed
// where `needed` is true, or names an answer that is yes (Map your data, when the table gives regions, which
// are minted under it). Map your data asks it with regions (needed) and when publishing (optional); Places
// from an edition and Places from Recogito when publishing; Publish a dataset always (optional).
// Why the base address is needed, where it is (said under its field): the regions a table gives are minted under it
// (REGIONS), or every place traced from a map is (TRACED).
const REGIONS = 'Needed: the regions are given addresses under it.';
const TRACED = 'Needed: every place you trace is given its address under it as you name it.';
const LISTED = 'Needed: each place of your list is given its address under it, against which what the gazetteer matches it with is recorded.';
/** The words under the base address's field saying why it is needed (baseAsked's `why`, else the regions'). */
export const baseWhy = (asked) => asked?.why || REGIONS;
const ROUTES = [
  // 'will-mint' (Issue #36: Wikidata items for the places no gazetteer knows) is asked last, and is no unless answered.
  { have: 'table', want: 'map', recipe: 'map-your-data', set: { target: 'plato-json' }, ask: ['has-regions', 'will-draw', 'will-publish', 'will-mint'], base: { when: ['has-regions', 'will-publish'], needed: 'has-regions' } },
  { have: 'table', want: 'publish', recipe: 'map-your-data', set: { target: 'plato-json', 'will-publish': true }, ask: ['has-regions', 'will-draw', 'will-mint'], base: { when: ['has-regions', 'will-publish'], needed: 'has-regions' } },
  { have: 'plato', want: 'publish', recipe: 'publish-a-dataset', set: {}, ask: [], base: { needed: false } },
  // An edition, or annotations: Map your data's questions but the regions (neither says which region each place
  // is in); the base address when publishing, optional, as Publish a dataset asks it (minting takes it).
  ...[['tei', 'places-from-tei'], ['recogito', 'places-from-recogito']].flatMap(([have, recipe]) => [
    { have, want: 'map', recipe, set: { target: 'plato-json' }, ask: ['will-draw', 'will-publish'], base: { when: 'will-publish', needed: false } },
    { have, want: 'publish', recipe, set: { target: 'plato-json', 'will-publish': true }, ask: ['will-draw'], base: { when: 'will-publish', needed: false } },
  ]),
  // Two datasets: the user's table, read as Map your data reads it, or a dataset already in a PLATO format, taken as
  // it is, matched with another (chosen at the match). `from-table` is the route's, never asked. The base address:
  // for a table always, optional (its places have their addresses under it, which the decisions name); for a PLATO
  // dataset, whose places have theirs, when publishing, as Publish a dataset asks it.
  { have: 'table', want: 'match', recipe: 'match-two-datasets', set: { target: 'plato-json', 'from-table': true }, ask: ['into-dataset', 'will-publish', 'will-mint'], base: { needed: false } },
  { have: 'plato', want: 'match', recipe: 'match-two-datasets', set: { target: 'plato-json', 'from-table': false }, ask: ['into-dataset', 'will-publish', 'will-mint'], base: { when: 'will-publish', needed: false } },
  // A historical map, traced into a new dataset (Stephen, 14 October 2026): the base address is needed from the
  // start, as every place traced is given its address under it as it is named; the lookup asked as a question.
  { have: 'map', want: 'map', recipe: 'trace-a-map', set: { target: 'plato-json' }, ask: ['will-identify', 'will-publish', 'will-mint'], base: { needed: true, why: TRACED } },
  { have: 'map', want: 'publish', recipe: 'trace-a-map', set: { target: 'plato-json', 'will-publish': true }, ask: ['will-identify', 'will-mint'], base: { needed: true, why: TRACED } },
  // A map image to share (Stephen, 14 October 2026; #37): the places of a list, a table or a PLATO dataset identified as Map your
  // data identifies them, then made into a map in Chora. `from-table` is the route's, never asked. The base address: for a list
  // or a table, needed (its places have their addresses only under it, which the lookup records its matches against); for a
  // PLATO dataset, whose places have theirs, not asked.
  { have: 'table', want: 'commons', recipe: 'make-an-open-map', set: { 'from-table': true }, ask: [], base: { needed: true, why: LISTED } },
  { have: 'plato', want: 'commons', recipe: 'make-an-open-map', set: { 'from-table': false }, ask: [] },
];

// Answers that name no recipe yet: what to use meanwhile, by what is wanted, as the page's tool keys
// (#tool=<key>; 'read' is Hermes, at the drop zone; 'chora' is Chora's own page).
const MEANWHILE = {
  map: { why: 'Map your data starts from a list of place names.', tools: ['read', 'match', 'chora'] },
  publish: { why: 'Publish a dataset starts from a dataset in a PLATO format: bring yours into PLATO first.', tools: ['read', 'publish'] },
  version: { why: 'Release a new version is not a workflow yet.', tools: ['versions', 'publish'] },
  convert: { why: 'A conversion is one step, not a workflow.', tools: ['read', 'convert'] },
  match: { why: 'Match two datasets starts from a table of places, or a dataset in a PLATO format: bring yours into PLATO first, or match it with Krisis, which matches any two datasets, one step at a time.', tools: ['read', 'match'] },
  cube: { why: 'Figures as a Data Cube is one tool, not a workflow.', tools: ['figures'] },
  commons: { why: 'Make an open map starts from a list of place names, a table, or a dataset in a PLATO format: bring yours into PLATO first; or open a dataset in Chora, and make the map there ("Make a map").', tools: ['read', 'chora'] },
};
const TEXT = 'Places from a text is not available yet: finding the places named in a text is deferred.';

/**
 * Where two answers lead: { kind: 'recipe', recipe, set, ask } (a recipe key, the answers already
 * settled, and the keys of the yes-or-no questions still to ask); { kind: 'grid' } for "not sure";
 * { kind: 'none', why, tools } when no recipe fits; null until both are answered.
 */
export function choose(have, want) {
  if (!HAVE.some((h) => h.key === have) || !WANT.some((w) => w.key === want)) return null;
  if (want === 'unsure') return { kind: 'grid' };
  const r = ROUTES.find((x) => x.have === have && x.want === want);
  if (r) return { kind: 'recipe', recipe: r.recipe, set: { ...r.set }, ask: [...r.ask], ...(r.base ? { base: { ...r.base } } : {}) };
  const m = MEANWHILE[want];
  return { kind: 'none', why: have === 'text' && (want === 'map' || want === 'publish') ? TEXT : m.why, tools: [...m.tools] };
}

/**
 * The questions still to ask, with their words, from the recipe: [{ key, question, answers?, default? }],
 * `answers` the words of Yes and of No where the recipe names them, `default` the answer given until another is.
 */
export const questionsFor = (choice) => (choice?.kind === 'recipe' ? choice.ask.map((key) => {
  const q = RECIPES[choice.recipe].asks[key];
  return { key, question: q.question, ...(q.answers ? { answers: [...q.answers] } : {}), ...(typeof q.default === 'boolean' ? { default: q.default } : {}) };
}) : []);
/** A yes-or-no answer given, else the question's default, else undefined. */
const given = (choice, yesNo, k) => (typeof yesNo[k] === 'boolean' ? yesNo[k] : RECIPES[choice.recipe].asks[k].default);

/**
 * Whether the base address is asked under these answers: { needed, question, why? } (needed: a workflow that
 * mints regions, or traced places, under it cannot go on without one; why: the words that say so, given by a
 * route that names its own, else baseWhy's), or null when it is not asked.
 */
export function baseAsked(choice, yesNo = {}) {
  const b = choice?.kind === 'recipe' ? choice.base : null;
  // An answer it depends on, given or settled by the first two questions ("A citable, published dataset" settles publishing).
  const yes = (k) => (yesNo[k] ?? choice.set[k] ?? RECIPES[choice.recipe].asks[k]?.default) === true;
  const when = [].concat(b?.when ?? []);
  if (!b || (when.length && !when.some(yes))) return null;
  const needed = b.needed === true || (typeof b.needed === 'string' && yes(b.needed));
  // Why it is needed, in words, only where it is (a route's own `why`, else the regions').
  return { needed, question: RECIPES[choice.recipe].asks.base.question, ...(needed && b.why ? { why: b.why } : {}) };
}
/** A base address as the interview takes one: a web address, trimmed, or null. */
export const baseAnswer = (v) => (typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim()) ? v.trim() : null);

/** The recipe's answers: those the first two questions settled, the yes-or-no answers given (true or false), and the base address where it is asked and given. */
export function answersFor(choice, yesNo = {}, { base } = {}) {
  const a = { ...choice.set };
  for (const k of choice.ask) if (typeof given(choice, yesNo, k) === 'boolean') a[k] = given(choice, yesNo, k);
  if (baseAsked(choice, yesNo) && baseAnswer(base)) a.base = baseAnswer(base);
  return a;
}

/** Whether every question still to ask has been answered, the base address among them where it is needed. */
export const answered = (choice, yesNo = {}, { base } = {}) => choice?.kind === 'recipe' && choice.ask.every((k) => typeof given(choice, yesNo, k) === 'boolean')
  && !(baseAsked(choice, yesNo)?.needed && !baseAnswer(base));

// What the end of a workflow says of a step that was skipped because it is not available yet, by the
// step's operation; any other such step is named in the general words below. (The regions step, the
// one such step once, is available now: Krisis's region review, level by level.)
const SKIPPED = {};

/**
 * The workflow the answers give, as the tracker shows it: each step that runs, with its tool, its
 * act in plain English and, where its operation is not available yet, why; the steps the answers
 * leave out; and what the workflow cannot carry from the files it begins with (`cannot`), in words.
 * A step not available yet does not stop the workflow: it is shown, and skipped (`unavailable` lists
 * them), and `notes` says at the end what was not done for it.
 */
export function plan(recipeKey, answers, { recipes = RECIPES } = {}) {
  const recipe = recipes[recipeKey];
  const steps = [], left = [];
  for (const s of recipe.steps) {
    const op = OPERATIONS[s.op];
    const row = { id: s.id, op: s.op, tool: op.tool, title: s.title || op.title, kind: op.kind, available: op.available === true ? true : op.available };
    (applies(s, answers) ? steps : left).push(row);
  }
  const skipped = steps.filter((s) => s.available !== true);
  return { key: recipe.key, title: recipe.title, version: recipe.version, digest: recipe.digest, steps, left,
    cannot: [...(recipe.cannot || [])],
    // What is to be known before it is followed, under these answers (the recipe's `before`).
    before: (recipe.before || []).filter((b) => applies(b, answers)).map((b) => b.words),
    // The files chosen at a step, not at the start (the other dataset of a match), as the tracker names them until they are.
    late: Object.entries(recipe.files || {}).filter(([, f]) => f.late).map(([key, f]) => ({ key, words: f.words })),
    unavailable: skipped.map((s) => s.id),
    notes: skipped.map((s) => SKIPPED[s.op] || `“${s.title}” was not done: it is not yet available.`) };
}

/**
 * A link that opens a new issue for a workflow the tools do not have: titled with the two answers in
 * their words, labelled Methodos. Nothing else is put in it. Null for answers the interview does not offer.
 */
export function feedbackUrl(have, want) {
  const h = HAVE.find((x) => x.key === have), w = WANT.find((x) => x.key === want);
  if (!h || !w) return null;
  const title = `Methodos: a workflow for “${h.words}” to “${w.words}”`;
  return `https://github.com/pelagios/plato-tools/issues/new?title=${encodeURIComponent(title)}&labels=Methodos`;
}
