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
  ['unsure', 'I am not sure: show me what the tools can do'],
].map(([key, words]) => Object.freeze({ key, words })));

// The answers that name a recipe: [have, want] -> the recipe, the answers the first two questions
// settle, and the recipe's yes-or-no questions still to ask, in the recipe's order.
// `base`: when the base address is asked (Stephen, 4 October 2026: only for workflows that mint
// addresses): under a yes-or-no answer (Map your data, when the table gives regions, which are minted
// under it), and then needed; or always (Publish a dataset, whose minting may take it), and then optional.
const ROUTES = [
  { have: 'table', want: 'map', recipe: 'map-your-data', set: { target: 'plato-json' }, ask: ['has-regions', 'will-draw', 'will-publish'], base: { when: 'has-regions', needed: true } },
  { have: 'table', want: 'publish', recipe: 'map-your-data', set: { target: 'plato-json', 'will-publish': true }, ask: ['has-regions', 'will-draw'], base: { when: 'has-regions', needed: true } },
  { have: 'plato', want: 'publish', recipe: 'publish-a-dataset', set: {}, ask: [], base: { needed: false } },
];

// Answers that name no recipe yet: what to use meanwhile, by what is wanted, as the page's tool keys
// (#tool=<key>; 'read' is Hermes, at the drop zone; 'chora' is Chora's own page).
const MEANWHILE = {
  map: { why: 'Map your data starts from a list of place names.', tools: ['read', 'match', 'chora'] },
  publish: { why: 'Publish a dataset starts from a dataset in a PLATO format: bring yours into PLATO first.', tools: ['read', 'publish'] },
  version: { why: 'Release a new version is not a workflow yet.', tools: ['versions', 'publish'] },
  convert: { why: 'A conversion is one step, not a workflow.', tools: ['read', 'convert'] },
  match: { why: 'Matching two datasets is one tool, not a workflow.', tools: ['match'] },
  cube: { why: 'Figures as a Data Cube is one tool, not a workflow.', tools: ['figures'] },
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

/** The questions still to ask, with their words, from the recipe: [{ key, question }]. */
export const questionsFor = (choice) => (choice?.kind === 'recipe' ? choice.ask.map((key) => ({ key, question: RECIPES[choice.recipe].asks[key].question })) : []);

/**
 * Whether the base address is asked under these answers: { needed } (needed: a workflow that mints
 * regions under it cannot go on without one), or null when it is not asked.
 */
export function baseAsked(choice, yesNo = {}) {
  const b = choice?.kind === 'recipe' ? choice.base : null;
  if (!b || (b.when && yesNo[b.when] !== true)) return null;
  return { needed: !!b.needed, question: RECIPES[choice.recipe].asks.base.question };
}
/** A base address as the interview takes one: a web address, trimmed, or null. */
export const baseAnswer = (v) => (typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim()) ? v.trim() : null);

/** The recipe's answers: those the first two questions settled, the yes-or-no answers given (true or false), and the base address where it is asked and given. */
export function answersFor(choice, yesNo = {}, { base } = {}) {
  const a = { ...choice.set };
  for (const k of choice.ask) if (typeof yesNo[k] === 'boolean') a[k] = yesNo[k];
  if (baseAsked(choice, yesNo) && baseAnswer(base)) a.base = baseAnswer(base);
  return a;
}

/** Whether every question still to ask has been answered, the base address among them where it is needed. */
export const answered = (choice, yesNo = {}, { base } = {}) => choice?.kind === 'recipe' && choice.ask.every((k) => typeof yesNo[k] === 'boolean')
  && !(baseAsked(choice, yesNo)?.needed && !baseAnswer(base));

// What the end of a workflow says of a step that was skipped because it is not available yet, by the
// step's operation; any other such step is named in the general words below. (The regions step, the
// one such step once, is available now: Krisis's region review, level by level.)
const SKIPPED = {};

/**
 * The workflow the answers give, as the tracker shows it: each step that runs, with its tool, its
 * act in plain English and, where its operation is not available yet, why; and the steps the answers
 * leave out. A step not available yet does not stop the workflow: it is shown, and skipped
 * (`unavailable` lists them), and `notes` says at the end what was not done for it.
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
