// Methodos on the page: the interview, and the tracker that keeps the user's place in the workflow
// it chooses (docs/plans/methodos.md, sections 3 and 4.4, and phase 3 of section 9). Two
// self-contained components, each mounted on an element the host gives it, so that where they sit on
// the page can change without changing them; the host (src/app.js) is told the step the workflow is
// at through onStep, and narrows step 2 to that step's tool (#tool=) and says the step in #for-tool.
// A visitor who never opens Methodos sees the page as it was: nothing here runs until they do, bar
// reading the store for a workflow kept from before.
import { HAVE, WANT, choose, questionsFor, answersFor, answered, plan, feedbackUrl, baseAsked, baseAnswer } from '../engine/methodos/interview.js';
import { OPERATIONS } from '../engine/methodos/operations.js';
import { RECIPES } from '../engine/methodos/recipes/index.js';
import * as runner from '../engine/methodos/runner.js';
import { refsOf, refsDiffer } from '../engine/methodos/handoffs.js';
import { atBoundary, reconcile, restartRemaining, recordOf } from '../engine/methodos/record.js';
import { writeProject, readProject, projectName, ProjectError, blobSource, newerWords } from '../engine/methodos/project.js';
import { fmtBytes } from '../engine/words.js';
import { outputStore } from './outputs.js';
import { stepAt, currentInput, startFiles, keptBy, keptWords, distinct, projectWords } from './seams.js';
import { regionsSettled, notReviewed, relateProblem, writesItself } from '../engine/methodos/containment.js';
import { stepMark, whereWords, lower } from './layout.js';
import { whyWords, shareLink, ENROL, WorkbenchError } from '../engine/workbench.js';
import { stateOf, fromSnapshot } from './whg.js';

// The input of each automatic operation that the page's run takes from the files chosen in step 1: a
// run is the step's only if those files are the ones the step takes (by size and SHA-256).
const MAIN = { check: 'files', convert: 'files', compare: 'later', 'publish.report': 'dataset', 'publish.mint': 'dataset', 'publish.site': 'dataset',
  'publish.w3id': 'dataset', match: 'subjects', lookup: 'subjects', apply: 'subjects', 'relate.containment': 'subjects' };
// The page's run that does a step whose operation is not a run of its own: recording the decisions with
// the region each place is in is Krisis's Finish (its 'apply' run), on a review whose candidates are exported.
const RUN_OF = { 'relate.containment': 'apply' };
const runOf = (op) => RUN_OF[op] || op;
/** What to put right, from a run's report with errors or a run that did not finish (as adapters.js's problemOf, without the engine). */
function problemOf(r) {
  const errors = r?.report?.errors || 0;
  if (!errors && !r?.incomplete) return null;
  const items = (r.report?.items || []).filter((i) => i.severity === 'error');
  return { words: items.slice(0, 3).map((i) => i.message).join(' ') || 'The data could not be read to the end, so nothing was written.', errors };
}

// Each operation's tool on this page: the key of #tool=<key> (src/app.js, TOOLS), or null where the
// step is done elsewhere (Hermes's columns, at the drop zone; Chora, on the map, at #chora).
const PAGE_TOOL = {
  check: 'check', convert: 'convert', compare: 'versions', match: 'match', lookup: 'match', 'lookup.levels': 'match', review: 'match', apply: 'match',
  'relate.containment': 'match', 'publish.report': 'publish', 'publish.mint': 'publish', 'publish.site': 'publish', 'publish.w3id': 'publish',
};
// The tools that the interview names when no workflow fits: their names, and where each is chosen.
const TOOL_LINKS = {
  read: ['Hermes', '#files', 'bring your file into PLATO'], check: ['Elenchos', '#tool=check', 'check it'], convert: ['Metaphrasis', '#tool=convert', 'convert it'],
  figures: ['Arithmos', '#tool=figures', 'figures as RDF Data Cube'], versions: ['Mneme', '#tool=versions', 'compare two versions'],
  publish: ['Agora', '#tool=publish', 'prepare it for publishing'], match: ['Krisis', '#tool=match', 'match it with another dataset, or a gazetteer'],
  chora: ['Chora', '#chora', 'see it on the map, and draw places'],
};
/**
 * One step of a list, as a row: a disabled checkbox (ticked when done, marked when current: layout.js,
 * stepMark), labelled by the step, whose state is also said in words, visually hidden, for a screen reader.
 * The state stays in li[data-step][data-state], which the browser checks read.
 */
function stepRow(id, st, ...body) {
  const m = stepMark(st);
  const li = el('li', { className: `track-step is-${st}` });
  li.dataset.step = id; li.dataset.state = st;
  if (m.current) li.setAttribute('aria-current', 'step');
  const box = el('input', { type: 'checkbox', className: 'track-check', disabled: true, checked: m.checked });
  if (m.current) box.dataset.current = '';
  li.append(el('label', { className: 'track-label' }, box,
    el('span', { className: 'track-body' }, el('span', { className: 'track-state visually-hidden', textContent: m.words }), ' ', ...body)));
  return li;
}
/** What a workflow cannot carry (its recipe's `cannot`), each sentence a list item. */
const cannotItems = (cannot) => cannot.map((c) => el('li', { textContent: c }));
// The steps that are followed: a step not yet available is shown, and skipped.
const runs = (p) => p.steps.filter((s) => s.available === true);
const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids.filter((k) => k != null)); return e; };
const show = (node) => { node.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); node.focus({ preventScroll: true }); };

/**
 * A list of a workflow's steps, each with its state in words (not only in colour): done, now, to come,
 * or not yet available and why (skipped, and not counted); the last says what was not done (`notes`).
 */
function stepList(list, steps, at, done, notes = []) {
  list.replaceChildren();
  for (const [n, s] of steps.entries()) {
    const st = s.available !== true ? 'unavailable' : done.includes(s.id) ? 'done' : s.id === at ? 'current' : 'todo';
    list.append(stepRow(s.id, st,
      s.tool ? el('span', { className: 'track-tool', textContent: s.tool }) : null, s.tool ? ': ' : null,
      el('span', { className: 'track-act', textContent: s.title }),
      st === 'unavailable' ? el('span', { className: 'track-why', textContent: s.available }) : null,
      n === steps.length - 1 && notes.length ? el('span', { className: 'track-end', textContent: notes.join(' ') }) : null));
  }
}

/**
 * Mount Methodos: `banner` is the one line that opens the interview, hidden while the interview is
 * open or a workflow is followed; `interview` and `tracker` are the two components' elements
 * (index.html); `store` is phase 2's store (src/methodos/store.js, workflowStore()); `onStep(step)` is
 * told each step the workflow comes to, as { id, n, title, tool, text, link } (n: its place among the
 * steps followed, from 0; title: "Step n of N: Tool, what it does"; tool: a #tool= key or null; text: what
 * #for-tool says of the workflow, the step itself left to the title), and null
 * when it is left or every step is done. `page` is what the host gives of itself:
 *   files()          the files chosen in step 1;          choose(files)  choose these in step 1;
 *   pick()           open step 1's file picker;           output(name)   a File the last run wrote;
 *   ready()          a promise, settled when the engine is ready for a file;
 *   mapping()        the matching of columns shown, or null;
 *   review()         the review open, as { text, name }, or null;
 *   openWork(file)   open a Krisis work file, as "Resume a review" does;  pickWork()  choose one;
 *   ownTarget()      the format of the files chosen, as a conversion's target key, or null;
 *   base()           the base address in Options;  setBase(v)  write one there (the one store of it);
 *   forgetKept()     let the file kept from the main page go (src/lib/kept-file.js), with "Clear them";
 *   letGo(files)     a workflow is let go: keep the user's own files it held as the main page's kept file.
 *   parked()         the result of an earlier step's run, put away as the workflow went on, as { step, words }, or null;
 *   reopenResult()   show that result again.
 *   saveTarget(name) where a project is saved, asked for at the click: a promise of { write(chunk),
 *                    close(), abort() }, or of null when the user closed the save dialogue;
 *   secrets()        what a project must never hold (the WHG token), to refuse a part that does;
 *   openReview(file, files)  open a review read from a project, on `files` (chosen first, if none is).
 *   hasToken()       whether the WHG token is held;   askToken()  show the WHG section's token field, the focus in it;
 *   collaborate(el)  the "Needs permission" line for collaborate:whg, in `el`;   shareBase()  the page's own address.
 * `whg` is the page's dealings with WHG's Workbench (src/methodos/whg.js, whgProjects()), or null.
 * `build` is { version, commit } of these tools, written into a project; `projectFile` the input that chooses a project to
 * open, and `projectSaid` where what came of it is said while the tracker is not shown.
 * Returns { open(), chosen(files), placed(files), began(run), ended(run), keepChanged(on), id(), following(), viewShared(token),
 * openFromWhg(), shareTokens() }:
 * the host tells it the files chosen, the dataset a save in Chora wrote (placed), and each run of a tool as
 * it begins ({ op, files }) and ends ({ op, report, outputs, incomplete } or { op, error, partial } or
 * { op, waiting } or { op, cancelled }).
 */
export function mountMethodos({ banner, interview, tracker, store, onStep, onScope, tools, page, outputs = null, build = null, projectFile = null, projectSaid = null, whg = null }) {
  const q = (root, sel) => root.querySelector(sel);
  const have = q(interview, '#mq-have'), want = q(interview, '#mq-want'), more = q(interview, '#mq-more');
  const verdict = q(interview, '#methodos-verdict'), planEl = q(interview, '#methodos-plan');
  const startB = q(interview, '#methodos-start'), gridB = q(interview, '#methodos-grid'), heading = q(interview, 'h2');
  const yesNo = {};
  let choice = null, pending = null;

  // ---- The interview: three questions, as radio buttons, each group a fieldset with its question as legend.
  const radios = (fs, name, items) => {
    const box = el('div', { className: 'choices' });
    for (const { key, words } of items) box.append(el('label', {}, el('input', { type: 'radio', name, value: key }), ' ', words));
    fs.append(box);
  };
  radios(have, 'methodos-have', HAVE);
  radios(want, 'methodos-want', WANT);
  const picked = (name) => q(interview, `input[name="${name}"]:checked`)?.value;

  function askMore() {
    for (const n of [...more.children]) if (n.tagName !== 'LEGEND') n.remove();
    const qs = questionsFor(choice);
    more.hidden = !qs.length;
    for (const { key, question } of qs) {
      const fs = el('fieldset', { className: 'yes-no' }, el('legend', { textContent: question }));
      fs.dataset.ask = key;
      const box = el('div', { className: 'choices' });
      for (const [v, w] of [['yes', 'Yes'], ['no', 'No']]) {
        const input = el('input', { type: 'radio', name: `methodos-ask-${key}`, value: v });
        if (typeof yesNo[key] === 'boolean') input.checked = yesNo[key] === (v === 'yes');
        box.append(el('label', {}, input, ' ', w));
      }
      fs.append(box); more.append(fs);
    }
  }

  // The base address, asked only for a workflow that mints addresses (interview.js baseAsked): one
  // field, pre-filled from Options' and written back there as it is typed, so that it has one store.
  const texts = {};
  function baseField() {
    const asked = baseAsked(choice, yesNo);
    let fs = q(more, '#methodos-base-q');
    if (!asked) { fs?.remove(); more.hidden = !questionsFor(choice).length; return; }
    if (!fs) {
      const input = el('input', { type: 'url', id: 'methodos-base', name: 'methodos-base', autocomplete: 'url', spellcheck: false, value: page.base?.() || '' });
      input.setAttribute('aria-describedby', 'methodos-base-help');
      fs = el('div', { id: 'methodos-base-q', className: 'methodos-text' }, el('label', { htmlFor: 'methodos-base', textContent: asked.question }), input,
        el('p', { id: 'methodos-base-help', className: 'muted', textContent: `${asked.needed ? 'Needed: the regions are given addresses under it.' : 'Optional: minting takes it, where the dataset has none of its own.'} It is the base address in Options, which this changes too.` }));
      more.append(fs);
    } else if (q(fs, '#methodos-base') !== document.activeElement) q(fs, '#methodos-base').value = page.base?.() || q(fs, '#methodos-base').value;
    const field = q(fs, '#methodos-base');
    field.required = asked.needed; field.setAttribute('aria-required', String(asked.needed));
    texts.base = field.value;
    more.hidden = false;
  }
  /** Options' base address changed by hand: the field shows it, and the workflow takes it (one store). */
  function baseChanged() {
    const f = q(more, '#methodos-base');
    if (!f || f === document.activeElement) return;
    f.value = page.base?.() || ''; texts.base = f.value;
    verdictNow();
  }
  interview.addEventListener('input', (e) => {
    if (e.target.id !== 'methodos-base') return;
    texts.base = e.target.value; page.setBase?.(e.target.value.trim());
    verdictNow();
  });

  function verdictNow() {
    startB.hidden = true; gridB.hidden = true; planEl.replaceChildren(); planEl.hidden = true;
    delete interview.dataset.recipe;
    if (!choice) { verdict.textContent = 'Answer the first two questions, and the workflow they lead to is shown here.'; return; }
    if (choice.kind === 'grid') {
      verdict.textContent = 'Then begin with the tools themselves: each card says what it does, and choosing one shows what it can do with your file.';
      gridB.hidden = false; return;
    }
    if (choice.kind === 'none') {
      verdict.textContent = `There is no workflow for this yet. ${choice.why} Meanwhile, these tools do it:`;
      const fb = el('a', { className: 'feedback', href: feedbackUrl(picked('methodos-have'), picked('methodos-want')), target: '_blank', rel: 'noopener noreferrer', textContent: 'Tell us what you wanted to do' });
      fb.append(el('span', { className: 'visually-hidden', textContent: ' (opens in a new tab)' }));
      const ul = el('ul', { className: 'meanwhile' });
      for (const k of choice.tools) {
        const [name, href, act] = TOOL_LINKS[k];
        const a = el('a', { href, textContent: name }); a.dataset.methodosTool = k;
        ul.append(el('li', {}, a, `: ${act}`));
      }
      planEl.append(ul, el('p', { className: 'feedback-line' }, fb, ': a new issue on GitHub, where a workflow for it can be asked for.'));
      planEl.hidden = false; return;
    }
    const recipe = RECIPES[choice.recipe];
    interview.dataset.recipe = recipe.key;
    if (!answered(choice, yesNo, texts)) {
      const bad = baseAsked(choice, yesNo)?.needed && (texts.base || '').trim() && !baseAnswer(texts.base);
      verdict.textContent = `This leads to the workflow “${recipe.title}”. Answer the questions under 3${baseAsked(choice, yesNo)?.needed ? ', the base address among them,' : ''} to see its steps.${bad ? ' The base address given is not a web address: it begins https:// (or http://).' : ''}`;
      return;
    }
    const p = plan(choice.recipe, answersFor(choice, yesNo, texts));
    verdict.textContent = `Your workflow: ${p.title}, in ${runs(p).length} steps.`;
    const list = el('ol', { className: 'track' });
    list.setAttribute('role', 'list');   // list-style: none drops the list's semantics in Safari without it
    stepList(list, p.steps, null, [], p.notes);
    planEl.append(list);
    if (p.left.length) planEl.append(el('p', { className: 'track-left', textContent: `Left out by your answers: ${p.left.map((s) => lower(s.title)).join('; ')}.` }));
    // What the workflow cannot carry from the files it begins with (the recipe's `cannot`), said before it is followed.
    if (p.cannot.length) planEl.append(el('p', { className: 'track-left', textContent: 'What it cannot carry from your files:' }), el('ul', { className: 'track-note track-cannot' }, ...cannotItems(p.cannot)));
    startB.textContent = `Follow “${p.title}”`; startB.hidden = false;
    planEl.hidden = false;
  }

  interview.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'methodos-base') return;   // said as it is typed (the input listener above)
    if (t.name?.startsWith('methodos-ask-')) yesNo[t.name.slice(13)] = t.value === 'yes';
    else {
      const was = choice && choice.kind === 'recipe' ? choice.recipe : null;
      choice = choose(picked('methodos-have'), picked('methodos-want'));
      if (choice?.kind === 'recipe' && choice.recipe !== was) for (const k of Object.keys(yesNo)) if (!choice.ask.includes(k)) delete yesNo[k];
      askMore();
    }
    baseField();
    verdictNow();
  });
  // A tool named meanwhile is chosen as its card chooses it (src/app.js: step 2 narrowed, focus on step 1);
  // Chora's is a link to #chora, which opens the map (src/app.js, openChora).
  planEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-methodos-tool]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    const card = tools.querySelector(`.tool-link[data-tool="${a.dataset.methodosTool}"]`);
    close(false);
    if (card) { e.preventDefault(); card.click(); }
  });
  gridB.addEventListener('click', () => {
    close(false);
    const h = tools.querySelector('h2, h3');
    if (h) { if (!h.hasAttribute('tabindex')) h.tabIndex = -1; h.closest('nav, section')?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); h.focus({ preventScroll: true }); }
  });
  q(interview, '#methodos-close').addEventListener('click', () => close(true));
  startB.addEventListener('click', async () => {
    const recipe = RECIPES[choice.recipe];
    const p = plan(recipe.key, answersFor(choice, yesNo, texts));
    // A workflow followed before, begun or not, is left for this one: its record and its files go.
    const was = pending?.id;
    if (was) await store.dropPending(was);
    if (wf || changed) { await handOver(wf || changed.record); await outs.drop(keptBy(wf || changed.record)); await store.remove((wf || changed.record).id); }
    pending = { key: recipe.key, answers: answersFor(choice, yesNo, texts), id: `${recipe.key}-${Date.now().toString(36)}`, steps: p.steps.length };
    wf = null; wfScope = null; changed = null; note = null; active = null;
    // Kept at once, before any file (Stephen, 4 October 2026): shown as not started, and discarded in one click.
    await store.savePending(pending);
    close(false);
    render(true);
    // A file already chosen in step 1 begins the workflow at once.
    const files = page.files();
    if (files.length) chosen(files);
  });

  const bannerNow = () => { banner.hidden = !interview.hidden || !!wf || !!pending || !!changed; };
  const backTo = () => (banner.hidden ? document.querySelector('#methodos-card') : banner.querySelector('a'))?.focus();
  let opener = null;
  function open() {
    opener = document.activeElement !== document.body ? document.activeElement : null;
    interview.hidden = false; bannerNow();
    document.querySelector('#methodos-card')?.setAttribute('aria-current', 'true');   // marked as chosen while the interview is open
    if (!choice) verdictNow();
    show(heading);
  }
  function close(refocus) {
    interview.hidden = true; bannerNow();
    document.querySelector('#methodos-card')?.removeAttribute('aria-current');
    if (refocus) { if (opener?.isConnected && opener.offsetParent && !interview.contains(opener)) opener.focus(); else backTo(); }
  }

  // ---- The tracker: the workflow's steps, done, now, and to come, in the workflow rail. ------------
  // Before a file is chosen the workflow is `pending` (its recipe and answers, for this tab): the
  // runner starts when step 1's file is chosen (chosen()), and from then on the workflow is the
  // runner's state, kept as a record (src/engine/methodos/record.js) at every step boundary.
  const tList = q(tracker, '#methodos-track'), tTitle = q(tracker, '#methodos-tracker-title'), tWhere = q(tracker, '#methodos-tracker-where');
  const tSaid = q(tracker, '#methodos-said'), tMsg = q(tracker, '#methodos-message');
  const doneB = q(tracker, '#methodos-done'), backB = q(tracker, '#methodos-back'), pickB = q(tracker, '#methodos-pick');
  // The project file's (below, "The project file"): looked up here, as render() draws them.
  const projectEl = q(tracker, '#methodos-project'), projectWhat = q(tracker, '#methodos-project-what');
  const ownBox = q(tracker, '#methodos-project-own'), ownWords = q(tracker, '#methodos-project-own-words');
  const saveP = q(tracker, '#methodos-save-project'), openP = q(tracker, '#methodos-open-project');
  const replaceEl = q(tracker, '#methodos-replace'), replaceWords = q(tracker, '#methodos-replace-words');
  const openBanner = banner.querySelector('#methodos-open-banner');
  // At a phone's width the tracker is a strip, "Step n of N: …", that opens to the whole tracker and closes again.
  const strip = q(tracker, '#methodos-strip');
  strip.addEventListener('click', () => { const open = tracker.classList.toggle('open'); strip.setAttribute('aria-expanded', String(open)); });
  // Opened, it is closed again when the workflow comes to another step, or the tracker goes, so that it does not stay over the step.
  const closeStrip = () => { tracker.classList.remove('open'); strip.setAttribute('aria-expanded', 'false'); };
  let stripAt = null;   // the step the strip was last said for
  tList.addEventListener('click', (e) => { if (e.target.closest('.track-reopen')) page.reopenResult?.(); });
  const downloadB = q(tracker, '#methodos-download');
  const choraB = q(tracker, '#methodos-chora');   // Chora's step: "Open Chora" (#chora), in the tracker as under the centre's title
  const cannotEl = q(tracker, '#methodos-cannot');
  const useB = q(tracker, '#methodos-use'), reopenB = q(tracker, '#methodos-reopen'), restartB = q(tracker, '#methodos-restart');
  let wf = null;            // the runner's state, as a record ({ id, name, created, saved, ...state })
  let wfScope = null;       // the workflow's Scope (Issue #33), kept beside the runner's state and written with it (keep())
  let changed = null;       // a record the version rule would not carry on: { record, words } (reconcile's 'changed' or 'refuse')
  let note = null;          // what the tracker says beside the steps: { words, warn }
  let active = null;        // the run under way that is the current step's: { id, op }
  let chosenRefs = null;    // the files chosen in step 1, as references
  let handle = null, handleFile = null;   // the FileSystemFileHandle the workflow's file was chosen through, if any (Chromium)
  let keptHandle = null;    // the handle kept for a resumed workflow
  const outs = outputs || outputStore();   // the files the steps made, by SHA-256, to hand on to the next step (src/methodos/outputs.js)
  const heldFor = (r) => outs.held(r);
  let queue = Promise.resolve();
  const chain = (fn) => (queue = queue.then(fn).catch((e) => { say(e.message || String(e), true); render(false); }));
  const say = (words, warn = false) => { note = words ? { words, warn } : null; };
  const recipeOf = (r) => RECIPES[r.recipe?.key];
  const fileKey = (recipe) => Object.keys(recipe.files || {})[0];

  /** The step the workflow is at: the one running or waiting, else the one that stopped, failed or was cancelled, else the next to do. */
  const atStep = (state = wf) => stepAt(state);
  const followed = (state) => state.steps.filter((s) => s.state !== 'skipped');
  /** The references the step at hand takes from the files chosen in step 1 (its main input), or null; throws in words if an earlier step is not done. */
  function mainInput(state, s) {
    const slot = MAIN[s.op];
    if (!slot) return null;
    return runner.inputsOf(state, s.id)[slot] || null;
  }
  async function keep() {
    if (!wf || !atBoundary(wf)) return;
    // The Scope is the page's own copy (wfScope), never a transition's: a step's run that began before the Scope
    // was changed, and ends after, writes its state without losing the change.
    const state = { ...wf };
    delete state.scope;
    const { record, kept } = await store.save(wfScope ? { ...state, scope: wfScope } : state, { name: wf.name || (chosenRefs?.[0]?.name) });
    wf = record;
    tracker.dataset.kept = kept;
    // The handle is kept only for the file the workflow began with (a later file chosen is a step's, not this).
    if (handle && handleFile && kept === 'browser' && sameRefs(chosenRefs, wf.files[fileKey(recipeOf(wf) || { files: {} })])) await store.keepHandle?.(wf.id, handle);
  }

  // A run on the page is the current step's only if it is the step's operation, on the step's file.
  function began(run) {
    chain(async () => {
      // A run under way that is the step's stays the step's: another run beginning meanwhile (a lookup
      // sent while a finishing runs) is not, and must not make the first one's end go unheard.
      if (active || !wf || changed) return;
      const s = atStep();
      if (!s || runOf(s.op) !== run.op || OPERATIONS[s.op].kind !== 'automatic') return;
      let w = ['stopped', 'failed', 'cancelled'].includes(s.state) ? runner.invalidate(wf, s.id) : wf;
      const main = mainInput(w, s);
      const differ = main ? await refsDiffer(main, [...(run.files || [])]) : [];
      if (differ.length) { say(notTheFiles(s, main, differ), true); render(false); return; }
      // Finish counts as recording the regions only on a review that can be recorded so (PLATO #23, option B).
      if (s.op === 'relate.containment') {
        const r = page.review();
        let why;
        try { why = r ? relateProblem(JSON.parse(r.text)) : 'There is no review open.'; } catch { why = 'The review open cannot be read.'; }
        if (why) { say(`This run is not counted as the step “${s.title}”: ${why}`, true); render(false); return; }
      }
      w = w.status === 'waiting' && w.current === s.id ? runner.resume(w, s.id) : runner.next(w);
      if (w.current !== s.id) return;
      wf = w; active = { id: s.id, op: run.op };
      say(null); render(false);
    });
  }
  /** The run under way has ended: its outputs and report are the step's result; or it waits, found a problem, failed, or was stopped. */
  function ended(run) {
    chain(async () => {
      if (!active || active.op !== run.op || !wf || wf.current !== active.id) return;
      const { id } = active; active = null;
      const s = wf.steps.find((x) => x.id === id);
      const partial = run.partial ? { [Object.keys(OPERATIONS[s.op].gives)[0]]: await refsHeld([run.partial], Object.values(OPERATIONS[s.op].gives)[0]) } : undefined;
      if (run.cancelled) wf = runner.cancel(wf, id, partial);
      else if (run.waiting) wf = runner.waiting(wf, id, run.waiting);
      else if (run.error) wf = runner.fail(wf, id, run.error, partial);
      else {
        const problem = problemOf(run);
        if (problem) wf = runner.stop(wf, id, problem);
        else {
          try { wf = runner.complete(wf, id, await outputsOf(s.op, run)); } catch (e) { wf = runner.fail(wf, id, e); }
        }
      }
      say(null);
      await keep(); render(false);
    });
  }
  /**
   * `files` as references of `type`, each kept for the steps after it (the page's outputs folder is
   * emptied by the next run): in this browser's working storage, or for the tab (outputs.js). The
   * user's own files (`own`) are held for the tab as they are, never copied.
   */
  async function refsHeld(files, type, { own = false } = {}) {
    const refs = await refsOf(files, type);
    for (const [i, r] of refs.entries()) { if (own) outs.hold(r, files[i]); else await outs.put(r, files[i]); }
    showKept();
    return refs;
  }
  async function outputsOf(op, run) {
    const gives = Object.entries(OPERATIONS[op].gives);
    if (!gives.length) return {};
    const [[slot, type]] = gives;
    const files = run.work ? [run.work] : await Promise.all((run.outputs || []).map((o) => page.output(o.name)));
    return { [slot]: files.length ? await refsHeld(files, type) : [] };
  }
  const names = (refs) => refs.map((r) => r.name).join(', ');
  const fromWhere = (state, s, refs) => {
    const by = state.steps.find((x) => x.state === 'done' && Object.values(x.outputs || {}).flat().some((r) => refs.some((m) => m.sha256 === r.sha256)));
    return by ? ` (made by the step “${by.title}”)` : '';
  };
  const notTheFiles = (s, main, differ) => `These are not the files the step “${s.title}” takes: ${differ.join(', ')} ${differ.length === 1 ? 'differs' : 'differ'}. Choose ${names(main)}${fromWhere(wf, s, main)} in step 1, as ${main.length === 1 ? 'it was' : 'they were'}, and run it again; a run on other files is not counted.`;

  /** Files chosen in step 1: they begin a workflow that is pending, and are checked against the step's file in one under way. */
  function chosen(files) {
    chain(async () => {
      files = [...(files || [])];
      if (!files.length) return;
      if (handleFile && files[0] !== handleFile) { handle = null; handleFile = null; }
      chosenRefs = await refsOf(files, 'files');
      if (pending && !wf) {
        const recipe = RECIPES[pending.key];
        // Its Scope, if one was given before the file (src/engine/krisis/scope.js), goes into the record.
        wf = { ...runner.start(recipe, pending.answers, { [fileKey(recipe)]: chosenRefs }), id: pending.id };
        wfScope = pending.scope ?? null;
        pending = null;
        say(`Begun with ${names(chosenRefs)}.`);
        await keep(); await store.dropPending(wf.id); await keepOwn(files); render(false); return;
      }
      if (!wf || changed) return;
      await keepOwn(files);
      const s = atStep();
      if (!s) return;
      let main = null;
      try { main = s.op === 'read.columns' ? runner.inputsOf(wf, s.id).files : mainInput(wf, s); } catch { main = null; }
      if (!main) return;
      const differ = await refsDiffer(main, files);
      say(differ.length ? notTheFiles(s, main, differ) : `${names(main)}: the file${main.length === 1 ? '' : 's'} this step takes.`, !!differ.length);
      render(false);
    });
  }

  /**
   * The user's own file(s) the workflow began with, chosen now: kept in this browser for the workflow's
   * lifetime (outputs.js keepOwn; Stephen, 12 October 2026), where working data is kept, so that the main
   * page chooses them again by itself after a reload, in any browser.
   */
  async function keepOwn(files) {
    const start = startFiles(wf);
    if (!wf || !start.length || !sameRefs(start, chosenRefs)) return;
    // What could not be kept (no room, or the browser would not) is said in the tracker, by name.
    const missed = [];
    for (const r of start) {
      const i = chosenRefs.findIndex((x) => x.sha256 === r.sha256);
      if (i < 0) continue;
      const how = await outs.keepOwn(r, files[i]);
      if (how === 'short' || how === 'failed') missed.push({ name: r.name, why: how });
    }
    ownMissed = missed;
    showKept();
  }
  let ownMissed = [];   // the user's own files that could not be kept in this browser, and why

  /**
   * A workflow let go (Leave, or another followed): the user's own file it holds goes on being kept, as
   * the main page keeps the file chosen outside a workflow (page.letGo, src/lib/kept-file.js), once,
   * before the workflow's copy is let go: one copy at a time, never two.
   */
  async function handOver(state) {
    const held = startFiles(state).map((r) => outs.held(r));
    if (held.length && held.every(Boolean)) { try { await page.letGo?.(held); } catch { /* not kept: the user chooses it again */ } }
  }

  // ---- What only the user can say: an interactive step's result, taken from the page as it stands.
  async function resultOf(s) {
    if (s.op === 'read.columns') {
      const m = page.mapping();
      if (!m) throw new Error('Choose the table in step 1 and match its columns first: there is no matching of columns yet.');
      return { mapping: await refsHeld([new File([JSON.stringify(m, null, 2)], 'columns.json', { type: 'application/json' })], 'mapping') };
    }
    if (s.op === 'lookup.levels') {
      // The region review open on the page, of the dataset this step takes, with every region settled.
      const r = page.review();
      if (!r) throw new Error('There is no review open: begin the region review ("Review the regions level by level", in step 5) on the dataset, and settle every region first.');
      const work = JSON.parse(r.text);
      const other = notReviewed(work, runner.inputsOf(wf, s.id).subjects || []);
      if (other.length) throw new Error(`The review open was not made of ${other.join(', ')}, the dataset this step takes: choose it in step 1, and begin the region review on it.`);
      regionsSettled(work);
      return { work: await refsHeld([new File([r.text], r.name, { type: 'application/json' })], 'work.krisis') };
    }
    if (s.op === 'review') {
      const r = page.review();
      if (!r) throw new Error('There is no review open: look the places up, and decide on the candidates, first.');
      return { work: await refsHeld([new File([r.text], r.name, { type: 'application/json' })], 'work.krisis') };
    }
    if (s.op === 'place') {
      // By hand: the dataset saved in Chora, chosen in step 1 (as its save chooses it), or another.
      const files = page.files();
      if (!files.length) throw new Error('Choose the dataset you saved in Chora in step 1 first.');
      // The very dataset that went to Chora (still chosen in step 1, as Chora shows it) is not taken as the step's result
      // unasked: nothing drawn there is in it. Two plain ways on: the file saved there, or "Nothing to draw".
      const went = currentInput(wf, s), refs = await refsOf(files, 'dataset');
      if (went && sameRefs(went, refs)) {
        asIs = s.id;
        throw new Error(`${names(went)} is the dataset that went to Chora, as it was: nothing drawn there is in it. Save it in Chora once you have drawn, or choose the file you saved there in “Choose your data”; or, if there was nothing to draw, say so (“Nothing to draw: go on with this dataset”).`);
      }
      return { dataset: await refsHeld(files, 'dataset', { own: true }) };
    }
    throw new Error(`The step “${s.title}” is done by the tools, when its run finishes.`);
  }
  async function finishInteractive(s, outputs) {
    let w = wf.status === 'idle' ? runner.next(wf) : wf;
    if (w.current !== s.id) throw new Error(`The workflow is not at the step “${s.title}”.`);
    wf = runner.complete(w, s.id, outputs);
    asIs = null;
    say(null); await keep(); render(false);
  }
  /**
   * The dataset a save in Chora wrote (`files`, as chosen in step 1 by the page), from the dataset Chora
   * had open (`base`): with the workflow at its step "place", and `base` the dataset that went to that
   * step, the step's result, and the step is done (kept like a run's output). Saved from another dataset,
   * the step is not done, and both here and under the save it is said why. Resolves with what to say of it
   * under Chora's save, in words, or null when the workflow is not at that step.
   */
  function placed(files, base) {
    return new Promise((resolve) => chain(async () => {
      const s = wf && !changed ? atStep() : null;
      if (!s || s.op !== 'place') { resolve(null); return; }
      const went = currentInput(wf, s);
      if (went && base && !sameRefs(went, await refsOf([...base], 'dataset'))) {
        const why = `It was saved from ${[...base].map((f) => f.name).join(', ')}, not from ${names(went)}, the dataset that went to the step “${s.title}”, so the step is not done with it.`;
        say(`${why} Open ${names(went)} in Chora and save there, or choose a file saved from it and say the step is done.`, true); render(false);
        resolve(why); return;
      }
      try { await finishInteractive(s, { dataset: await refsHeld([...files], 'dataset') }); } catch (e) { say(e.message, true); render(false); resolve(null); return; }
      const next = atStep();
      say(`${names(files)}, saved in Chora: the step “${s.title}” is done with it.`); render(false);
      resolve(`The workflow's step “${s.title}” is done with it${next ? `, and the workflow goes on to “${next.title}”: leave the map to carry on` : ''}.`);
    }).then(() => resolve(null)));
  }
  // "Nothing to draw: go on with this dataset": offered once "This step is done" found the dataset that
  // went to Chora unchanged; the step is done with it, as it went, said in words.
  let asIs = null;   // the step "place" whose "This step is done" found the dataset unchanged
  const asIsB = el('button', { type: 'button', id: 'methodos-as-is', hidden: true, textContent: 'Nothing to draw: go on with this dataset' });
  doneB.after(' ', asIsB);
  asIsB.addEventListener('click', () => chain(async () => {
    const s = atStep();
    if (!s || s.op !== 'place' || asIs !== s.id) return;
    const went = currentInput(wf, s);
    if (!went) return;
    await finishInteractive(s, { dataset: went });
    say(`Nothing drawn in Chora: the workflow goes on with ${names(went)}, as it went there.`); render(false);
  }));
  doneB.addEventListener('click', () => chain(async () => {
    const s = atStep();
    if (!s || OPERATIONS[s.op].kind !== 'interactive') return;
    try { await finishInteractive(s, await resultOf(s)); } catch (e) { say(e.message, true); render(false); return; }
    if (!atStep()) q(tracker, '#methodos-leave').focus();
  }));
  const leaveB = q(tracker, '#methodos-leave'), keptEl = q(tracker, '#methodos-kept'), clearB = q(tracker, '#methodos-clear-kept');
  /** What of the workflow's files this browser keeps (the user's own and the steps'), said beside a way to clear it; or that nothing is kept. */
  let keptAsked = 0;
  function showKept() {
    const n = ++keptAsked;
    outs.kept().then(({ files }) => {
      if (n !== keptAsked) return;
      const keeping = outs.keeping ? outs.keeping() : true;
      const words = keptWords({ files, own: startFiles(wf || changed?.record), keeping, workflow: !!(wf || changed || pending), missed: wf ? ownMissed : [] });
      keptEl.hidden = !words || tracker.hidden || !!viewing;
      keptEl.firstChild.textContent = words;
      clearB.hidden = !keeping;
      tracker.dataset.keptOwn = String(keeping && files.some((f) => startFiles(wf || changed?.record).some((r) => r.sha256 === f.sha256)));
    }).catch(() => { keptEl.hidden = true; });
  }
  clearB.addEventListener('click', () => chain(async () => {
    await outs.clear(); await page.forgetKept?.(); showKept();   // the file kept from the main page (src/lib/kept-file.js) goes too
    say('Your file and the files the steps made are cleared from this browser: a step that takes one now asks for it to be chosen.');
    render(false);
  }));
  // A step that writes its file in the format it already has: the file chosen, downloaded as it is, is the step's output.
  downloadB.addEventListener('click', () => chain(async () => {
    const s = atStep();
    const files = page.files();
    if (!wf || !s || !files.length || !writesItself(s, page.ownTarget?.())) return;
    const main = mainInput(wf, s);
    if (!main || !sameRefs(main, chosenRefs)) return;
    const url = URL.createObjectURL(files[0]);
    const a = el('a', { href: url, download: files[0].name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    let w = wf.status === 'idle' ? runner.next(wf) : wf;
    if (w.current !== s.id) throw new Error(`The workflow is not at the step “${s.title}”.`);
    wf = runner.complete(w, s.id, { dataset: await refsHeld(files, 'dataset', { own: true }) });
    say(`${names(main)}: downloaded as it is. The step is done.`);
    await keep(); render(false);
  }));
  backB.addEventListener('click', () => chain(async () => {
    const last = wf && [...wf.steps].reverse().find((s) => s.state === 'done');
    if (!last) return;
    wf = runner.invalidate(wf, last.id); active = null; asIs = null;
    say(null); await keep(); render(false);
    if (backB.disabled) doneB.focus();
  }));
  q(tracker, '#methodos-leave').addEventListener('click', () => chain(async () => {
    const id = wf?.id || changed?.record.id, was = pending?.id;
    if (wf || changed) await handOver(wf || changed.record);
    await outs.drop(keptBy(wf || changed?.record));
    wf = null; wfScope = null; pending = null; changed = null; active = null; note = null; handle = handleFile = keptHandle = null; asIs = null; ownMissed = [];
    whgLink = null; whgLinkFor = null; whgReset();
    if (id) await store.remove(id);
    if (was) await store.dropPending(was);
    render(false); backTo();
  }));
  restartB.addEventListener('click', () => chain(async () => {
    if (!changed || changed.action !== 'changed') return;
    wf = restartRemaining(changed.record, recipeOf(changed.record)); wfScope = wf.scope ?? null; changed = null;
    say(`Carried on under the recipe as it is now. Choose ${names(wf.files[fileKey(recipeOf(wf))] || [])} again in step 1.`);
    await keep(); render(false);
  }));
  // Choosing the workflow's file from the tracker keeps its handle where the browser gives one, so that
  // resuming is one click; elsewhere it is step 1's own picker.
  pickB.addEventListener('click', () => chain(async () => {
    if (keptHandle) {
      try {
        const ok = (await keptHandle.queryPermission?.({ mode: 'read' })) === 'granted' || (await keptHandle.requestPermission?.({ mode: 'read' })) === 'granted';
        if (ok) { const f = await keptHandle.getFile(); handle = keptHandle; handleFile = f; page.choose([f]); return; }
      } catch { /* moved, or refused: chosen again */ }
      keptHandle = null; render(false);
    }
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [h] = await window.showOpenFilePicker();
        const f = await h.getFile(); handle = h; handleFile = f; page.choose([f]);
      } catch (e) { if (e?.name !== 'AbortError') page.pick(); }
    } else page.pick();
  }));
  useB.addEventListener('click', () => {
    const s = atStep(), main = s && wf ? (() => { try { return mainInput(wf, s); } catch { return null; } })() : null;
    const files = main?.map(heldFor);
    if (files?.length && files.every(Boolean)) page.choose(files);
  });
  reopenB.addEventListener('click', () => {
    const s = atStep();
    const [ref] = s?.partial ? Object.values(s.partial).flat() : [];
    const f = ref && heldFor(ref);
    if (f) { page.openWork(f); say(`${f.name} is open again: the lookup done again begins from it, and asks only for the places not yet answered.`); render(false); }
    else page.pickWork();
  });

  /**
   * A file dropped in step 1, with the handle the browser gave for it (a promise, of null when it gave
   * none): kept as the picker's is, if it is a file's handle (a folder's, or anything else, is not).
   * Told before chosen(), so that the handle is settled when the file is.
   */
  function dropped(asked, file) {
    chain(async () => {
      let h = null;
      try { h = await asked; } catch { h = null; }
      if (h && h.kind === 'file' && typeof h.getFile === 'function' && h.name === file.name) { handle = h; handleFile = file; }
      else if (handleFile !== file) { handle = null; handleFile = null; }
    });
  }
  /** "Keep working data" changed in the Permissions panel: the record moves at once (turned off, nothing is left in IndexedDB). */
  function keepChanged(on) {
    chain(async () => {
      if (wf && atBoundary(wf)) await keep();
      else if (!on) await store.forgetKept();
      if (pending) await store.savePending(pending);
      // The link to WHG, held here, is kept again where the record now is (turned off, for the tab).
      const linked = wf || changed?.record;
      if (whg && linked && whgLinkFor === linked.id && whgLink) await whg.setLink(linked.id, whgLink);
      // Turned on: the user's own file, held for the tab, is kept from now as the steps' files are.
      if (on && wf) {
        const missed = [];
        for (const r of startFiles(wf)) { const f = outs.held(r); if (f) { const how = await outs.keepOwn(r, f); if (how === 'short' || how === 'failed') missed.push({ name: r.name, why: how }); } }
        ownMissed = missed;
      }
      if (!on) {
        await outs.forget();   // the workflow's files: for the tab only from now, and cleared from the browser at once
        // A kept file already chosen in step 1 is chosen again from the tab's copy, as the stored one is gone.
        const now = page.files(), refs = chosenRefs || [];
        if (now.length && refs.length === now.length && refs.every((x) => outs.held(x) && outs.held(x) !== now[refs.indexOf(x)])) page.choose(refs.map((x) => outs.held(x)));
      }
      showKept();
      render(false);
    });
  }

  const RUN_WORDS = {
    running: () => 'Running.',
    waiting: (s) => `Waiting: ${s.why}`,
    stopped: (s) => `Stopped: ${s.problem.words}${s.problem.errors ? ` (${s.problem.errors} ${s.problem.errors === 1 ? 'error' : 'errors'})` : ''} Put it right and run this step again.`,
    failed: (s) => `Failed: ${s.error}${/[.!?]$/.test(s.error) ? '' : '.'} Nothing is lost: run this step again.${s.partial ? ' What it had done is kept, to begin from.' : ''}`,
    cancelled: (s) => `Stopped by you: run this step again when you are ready.${s.partial ? ' What it had done is kept, to begin from.' : ''}`,
  };
  function render(focus) {
    bannerNow();
    onScope?.();   // the Scope shown in the rail is the workflow's, or none (src/scope-page.js)
    // A workflow shared from WHG (viewShared) is shown in place of this browser's own, read-only, until closed or copied.
    const shown = viewing ? viewing.read.record : wf || changed?.record;
    const own = viewing ? null : changed;   // what the version rule said of this browser's own workflow, if it is shown
    if (!pending && !shown) { tracker.hidden = true; delete tracker.dataset.status; closeStrip(); stripAt = null; onStep(null); sharedEl.hidden = true; return; }
    tracker.hidden = false;
    let steps, at, rows;
    if (!shown) {
      const p = plan(pending.key, pending.answers);
      tracker.dataset.recipe = p.key; tTitle.textContent = p.title;
      steps = runs(p); at = steps[0];
      rows = p.steps.map((s) => ({ ...s, st: s.available !== true ? 'unavailable' : s.id === at.id ? 'current' : 'todo' }));
      tracker.dataset.status = 'pending';
    } else {
      const recipe = recipeOf(shown);
      tracker.dataset.recipe = shown.recipe.key; tTitle.textContent = recipe?.title || shown.recipe.key;
      steps = followed(shown); at = own ? null : atStep(shown);
      rows = shown.steps.filter((s) => s.state !== 'skipped' || s.unavailable).map((s) => {
        const op = OPERATIONS[s.op];
        return { id: s.id, tool: op.tool, title: s.title, available: s.unavailable || true,
          st: s.unavailable ? 'unavailable' : s.state === 'done' ? 'done' : at && s.id === at.id ? 'current' : 'todo', run: at && s.id === at.id ? s : null };
      });
      tracker.dataset.status = viewing ? 'shared' : own ? 'changed' : shown.status;
    }
    trackList(tList, rows, pendingNotes(shown));
    // What the workflow cannot carry from its files, folded below the buttons; hidden for a recipe that names nothing.
    const cannot = (shown ? recipeOf(shown) : RECIPES[pending.key])?.cannot || [];
    cannotEl.hidden = !cannot.length;
    cannotEl.querySelector('ul').replaceChildren(...cannotItems(cannot));
    const i = at ? steps.findIndex((s) => s.id === at.id) : -1;
    const s = i >= 0 ? steps[i] : null;
    const title = s ? whereWords(i, steps.length, OPERATIONS[s.op].tool, s.title) : null;   // also the centre's title, and the strip's words
    const where = s ? `${title}.`
      : own ? own.words : `Every one of the ${steps.length} steps is done.${pendingNotes(shown).length ? ` ${pendingNotes(shown).join(' ')}` : ''}`;
    tWhere.textContent = where;
    strip.querySelector('.strip-where').textContent = title || where.replace(/\.$/, '');
    if ((s?.id ?? null) !== stripAt) { closeStrip(); stripAt = s?.id ?? null; }
    const run = s && RUN_WORDS[s.state] ? RUN_WORDS[s.state](s) : '';
    // The file: chosen through the tracker (its handle kept, where the browser gives one) before the
    // workflow starts, or after a reload when a step takes the file the workflow began with.
    let main = null;
    try { main = s && wf && !viewing ? mainInput(wf, s) || (s.op === 'read.columns' ? runner.inputsOf(wf, s.id).files : null) : null; } catch { main = null; }
    // Written out in the format it already has: ready to download as it is, and done once downloaded.
    const ready = !!(s && wf && !changed && !run && writesItself(s, page.ownTarget?.()) && main && sameRefs(main, chosenRefs));
    // What the tracker says now: what is to be done next, in words, then any word about the last thing done.
    const op = s && OPERATIONS[s.op];
    let next = '';
    if (viewing) next = '';
    else if (!shown) next = `Not started. Choose ${lower(RECIPES[pending.key].files[fileKey(RECIPES[pending.key])].words)} in step 1 to begin: Methodos starts when it is chosen. Or discard it.`;
    else if (s && op.kind === 'interactive') next = `This step is yours: it waits for ${op.waitsFor}. Say when it is done.`;
    else if (ready) next = `Ready to download: ${names(main)} is already in the format this workflow writes, so it is not converted into itself. Download it, and the step is done.`;
    else if (s && !run) next = `Run ${OPERATIONS[s.op].tool ? `${OPERATIONS[s.op].tool}'s` : 'its'} ${lower(OPERATIONS[s.op].title)}; the step is done when the run finishes.`;
    const message = [note?.words, next].filter(Boolean).join(' ');
    tMsg.textContent = message; tMsg.hidden = !message; tMsg.classList.toggle('warn', !!note?.warn);
    tSaid.textContent = [where, run, message].filter(Boolean).join(' ');
    doneB.hidden = !(s && op.kind === 'interactive' && !changed && wf);
    asIsB.hidden = !(s && s.op === 'place' && asIs === s.id && wf && !changed);
    backB.disabled = !wf || changed || !wf.steps.some((x) => x.state === 'done');
    restartB.hidden = changed?.action !== 'changed';
    leaveB.textContent = !shown ? 'Discard this workflow' : 'Leave the workflow';
    downloadB.hidden = !ready;
    choraB.hidden = !(s && s.op === 'place' && wf && !changed);
    if (ready) {
      downloadB.textContent = `Download ${names(main)}`;
      tList.querySelector('li.is-current .track-body')?.append(el('span', { className: 'track-run', textContent: 'Ready to download' }));
    }
    const begun = wf ? wf.files[fileKey(recipeOf(wf) || { files: {} })] : null;
    const needStart = !shown || (main && begun && main.every((r) => begun.some((x) => x.sha256 === r.sha256)) && !sameRefs(main, chosenRefs) && !main.every((r) => !!heldFor(r)));
    pickB.hidden = !needStart;
    pickB.textContent = keptHandle && wf ? `Open ${keptHandle.name} again` : 'Choose the file';
    const usable = main && !sameRefs(main, chosenRefs) && main.every((r) => !!heldFor(r)) ? main : null;
    useB.hidden = !usable || needStart; if (usable) useB.textContent = `Use ${names(usable)}${fromWhere(wf, s, usable)}`;
    const partial = (s?.state === 'failed' || s?.state === 'cancelled') && s.partial ? Object.values(s.partial).flat()[0] : null;
    reopenB.hidden = !partial;
    if (partial) reopenB.textContent = heldFor(partial) ? `Reopen ${partial.name}` : `Choose ${partial.name} again`;
    if (s && !changed && !viewing) {
      const p = wf ? { title: recipeOf(wf)?.title } : plan(pending.key, pending.answers);
      onStep({ id: s.id, n: i, title, tool: PAGE_TOOL[s.op] ?? null, text: `Methodos, ${p.title}.${op.kind === 'interactive' && op.waitsFor ? ` This step is yours: it waits for ${op.waitsFor}.` : ''}`,
        link: s.op === 'place' ? { href: '#chora', words: 'Open Chora' } : null });
    } else onStep(null);
    // The result of an earlier step's run, put away by the host as the workflow went on (src/app.js), is
    // summed up in that step's row, with a way to show it again.
    const parked = page.parked?.();
    const row = parked && tList.querySelector(`li[data-step="${CSS.escape(parked.step)}"][data-state="done"]`);
    if (row) row.append(el('span', { className: 'track-result' }, `${parked.words} `, el('button', { type: 'button', className: 'link track-reopen', textContent: 'Show its result' })));
    // Read-only: nothing of it can be done here; only copied, downloaded, or closed.
    sharedEl.hidden = !viewing;
    projectEl.hidden = !!viewing; backB.hidden = !!viewing; leaveB.hidden = !!viewing;
    if (viewing) {
      for (const b of [doneB, asIsB, pickB, useB, reopenB, restartB, downloadB, choraB]) b.hidden = true;
      q(sharedEl, '#methodos-shared-words').textContent = `Read-only: “${viewing.title || shown.name || tTitle.textContent}”, shared with you through the World Historical Gazetteer, as it was last saved there (version ${viewing.version}). Nothing in it can be changed or run here: make your own copy to carry on with it, or download it as a project file.`;
    }
    showKept();
    projectShow();
    // Focus on the tracker's heading, or, at a phone's width, where the heading is not shown, on its strip.
    if (focus) show(strip.offsetParent ? strip : q(tracker, 'h2'));
  }
  const sameRefs = (a, b) => !!a && !!b && a.length === b.length && a.every((r) => b.some((x) => x.sha256 === r.sha256 && x.size === r.size));
  const pendingNotes = (state) => (state ? (!RECIPES[state.recipe.key] ? [] : state.steps.filter((s) => s.unavailable).map((s) => plan(state.recipe.key, state.answers).notes[plan(state.recipe.key, state.answers).unavailable.indexOf(s.id)]).filter(Boolean))
    : plan(pending.key, pending.answers).notes);

  /** The tracker's list: each step with its checkbox and its state in words, and the step at hand with how its run went. */
  function trackList(list, rows, notes) {
    list.replaceChildren();
    for (const [n, s] of rows.entries()) {
      const words = s.run && RUN_WORDS[s.run.state] ? RUN_WORDS[s.run.state](s.run) : '';
      const li = stepRow(s.id, s.st,
        s.tool ? el('span', { className: 'track-tool', textContent: s.tool }) : null, s.tool ? ': ' : null,
        el('span', { className: 'track-act', textContent: s.title }),
        s.st === 'unavailable' ? el('span', { className: 'track-why', textContent: s.available }) : null,
        words ? el('span', { className: `track-run${['stopped', 'failed'].includes(s.run.state) ? ' warn' : ''}`, textContent: words }) : null,
        n === rows.length - 1 && notes.length ? el('span', { className: 'track-end', textContent: notes.join(' ') }) : null);
      if (s.run && s.run.state !== 'pending') li.dataset.run = s.run.state;
      list.append(li);
    }
  }

  // A workflow kept from before is taken up by the version rule (record.js, reconcile()), whose words the
  // tracker shows: the newest, begun or not.
  const takenUp = Promise.all([store.list(), store.pendings()]).then(([[r], [pd]]) => chain(async () => {
    if (wf || pending) return;
    if (pd && (!r || pd.saved > r.saved)) {
      if (!RECIPES[pd.key]) { await store.dropPending(pd.id); return; }
      try { plan(pd.key, pd.answers); } catch { await store.dropPending(pd.id); return; }
      pending = { id: pd.id, key: pd.key, answers: pd.answers, ...(pd.scope ? { scope: pd.scope } : {}) };
      say('Taken up where it was left: chosen before any file.');
      render(false); return;
    }
    if (!r) return;
    const v = reconcile(r, recipeOf(r));
    if (v.action === 'continue') { if (await takeUp(v, r)) return; } else changed = { action: v.action, record: r, words: v.words };
    render(false);
  })).catch(() => {});
  /**
   * Carry on with `v.state`, the version rule's 'continue' for the record `r` (kept from before, or read
   * from a project): the files kept in this browser are taken for the tab, and the file the step works
   * on, the user's own or a step's, is chosen again (seams.js currentInput): at Chora's step, the dataset
   * that went to the map, so that it is shown without choosing it. `opened` is said first (a project
   * opened, whose record is kept here from now). True once it has drawn the tracker and chosen the file.
   */
  async function takeUp(v, r, opened = '') {
    wf = v.state; wfScope = wf.scope ?? null;
    if (wf.status !== r.status || opened) await keep();   // a step the page was closed in is failed, and kept so
    keptHandle = await store.handleFor?.(wf.id) || null;
    for (const ref of keptBy(wf)) await outs.get(ref);   // the user's file and the steps' kept in this browser, for the tab
    const s = atStep();
    const main = currentInput(wf, s);
    const ready = main && main.every((x) => !!heldFor(x)) ? main.map(heldFor) : null;
    const chosenAgain = ready ? ` ${names(main)} is chosen again in “Choose your data”.` : '';
    const first = [opened, v.words].filter(Boolean).join(' ');
    if (s?.op === 'place') say([first, `At Chora's step:${chosenAgain} Open Chora to draw: its save does this step with the dataset it writes. Or choose a dataset you saved in Chora before, and say the step is done.`].filter(Boolean).join(' '));
    else if (ready) say([first, `Taken up where it was left, with ${names(main)}${fromWhere(wf, s, main)}, kept in this browser: it is chosen in step 1 for you.`].filter(Boolean).join(' '));
    else say([first, main ? `Taken up where it was left. Choose ${names(main)} again in step 1 to carry on: the file is checked to be the one the workflow recorded.` : 'Taken up where it was left.'].filter(Boolean).join(' '));
    if (!ready) return false;
    render(false);
    // Chosen for the step once the engine is ready, unless the user has chosen a file meanwhile.
    const ok = await page.ready?.();
    if (ok !== false && !chosenRefs && !page.files().length) page.choose(ready);
    return true;
  }
  // The files chosen are recognised (their format known): what the step at hand offers may change with it.
  const detected = () => chain(async () => { if (wf) render(false); });
  // following(): a workflow is followed, begun or about to begin with the files chosen (pending): what is
  // chosen is the workflow's, so the main page does not choose its kept file over it on a return (src/app.js, keptAtStart).
  // takenUp(): settled once a workflow kept from before is taken up (and its file chosen again), or found to be none.
  // Scope (Issue #33): the workflow's, kept in its record (or with it while it is pending), saved when it is
  // changed, and gone with the workflow. scope() is the record's as kept, to be read through scope.js's
  // normaliseScope, or null; setScope(s) keeps a new one, refused (false) when no workflow can take it.
  // The new Scope is the workflow's at once (what is drawn next reads it); only the writing waits its turn.
  // A record the version rule would not carry on (`changed`) has its Scope too, edited and kept with it.
  const scopeNow = () => (wf ? wfScope : pending ? pending.scope : changed ? changed.record.scope : null) ?? null;
  function setScope(s) {
    if (!wf && !pending && !changed) return false;
    if (wf) wfScope = s;
    else if (pending) pending = { ...pending, scope: s };
    else changed = { ...changed, record: { ...changed.record, scope: s } };
    const was = { wf: !!wf, pending, record: changed?.record };
    chain(async () => {
      if (was.wf) await keep();
      else if (was.pending) await store.savePending(was.pending);
      else if (was.record) await store.save(was.record);
      render(false);
    });
    return true;
  }
  // ---- The project file (src/engine/methodos/project.js; plan #34, item A2) --------------------------
  // "Save the project" writes the whole workflow into one .platoproj: its record (the Scope in it), the
  // user's own file (unless the box is unticked), the files its steps made, and the review open; never
  // the token (refused if a part holds it), a permission or this browser's
  // storage (the reviewer's name only where a review records who decided). "Open a project" reads one
  // back, checking every part's hash as it streams, writing the
  // files into this browser's outputs folder as they arrive, and takes the workflow up at its step as a
  // reload does; a workflow already open is let go only once the user has said so. Nothing read from it
  // runs or asks anything: the user carries on.
  let replacing = null;   // the project chosen while a workflow is open, until the user says whether to replace it
  let fromNewer = null;   // the id of a workflow opened from a project of a later minor: what newer tools added is not saved again
  const IN_MEMORY = 512 * 1024 * 1024;   // the most a project's files may come to, held in the tab's memory (working data not kept)
  /** Where the project's words go: the tracker's message while it is shown, else the line under the banner. */
  function tell(words, warn = false) {
    if (!tracker.hidden) { say(words, warn); render(false); return; }
    if (!projectSaid) return;
    projectSaid.textContent = words; projectSaid.hidden = !words; projectSaid.classList.toggle('warn', warn);
  }
  /** The workflow as a record to save: the runner's state with the page's Scope, as keep() writes it; or a record the version rule would not carry on. */
  const toSave = () => {
    if (wf) { const st = { ...wf }; delete st.scope; return recordOf(wfScope ? { ...st, scope: wfScope } : st, { name: wf.name || chosenRefs?.[0]?.name }); }
    return changed ? changed.record : null;
  };
  function projectShow() {
    const st = wf || changed?.record;
    if (projectSaid && !tracker.hidden) projectSaid.hidden = true;   // what was said under the banner is the tracker's to say now
    // A workflow chosen before any file has nothing to save yet; a project can be opened in its place.
    q(projectEl, '#methodos-project-save').hidden = !st; saveP.hidden = !st;
    whgShow();
    if (!st) return;
    const own = startFiles(st);
    ownBox.closest('label').hidden = !own.length;
    ownWords.textContent = own.length ? `Put my own file in it (${own.map((r) => `${r.name}, ${fmtBytes(r.size)}`).join('; ')})` : '';
    projectWhat.textContent = projectWords(st, { review: page.review?.()?.name || null, withOwn: ownBox.checked });
    saveP.disabled = !!wf && !atBoundary(wf);
  }
  projectEl.addEventListener('toggle', projectShow);
  ownBox.addEventListener('change', projectShow);
  saveP.addEventListener('click', () => {
    const record = toSave();
    if (!record) return;
    if (wf && !atBoundary(wf)) { say('A step is running: save the project once it has finished.', true); render(false); return; }
    const name = projectName(record);
    // Asked for at the click, where the browser's save dialogue may be opened; written once it is chosen.
    const target = page.saveTarget(name);
    chain(async () => {
      const out = await target;
      if (!out) return;   // the save dialogue was closed
      try {
        const parts = await projectParts(record);
        const { files, left } = parts, r = parts.review;
        const { size } = await writeProject(parts, (c) => out.write(c));
        await out.close();
        const missed = left.filter((x) => x.why === 'not-kept').map((x) => x.ref.name);
        tracker.dataset.project = name;
        say(`Saved ${name} (${fmtBytes(size)}): ${files.length} ${files.length === 1 ? 'file' : 'files'}${r ? `, the review open (${r.name})` : ''} and the workflow at its step. Keep it as you would your data.${fromNewer === record.id ? ' What newer PLATO tools had added to the project it was opened from is not in it.' : ''}${missed.length ? ` Not in it, as this browser no longer keeps ${missed.length === 1 ? 'it' : 'them'}: ${missed.join(', ')}; whoever opens it chooses ${missed.length === 1 ? 'it' : 'them'} again where a step needs ${missed.length === 1 ? 'it' : 'them'}.` : ''}`);
      } catch (e) {
        try { await out.abort(); } catch { /* nothing written */ }
        say(e.message || String(e), true);
      }
      render(false);
    });
  });
  /**
   * What a project of `record` holds, as writeProject() takes it: the files the workflow names that this
   * browser keeps (the user's own unless the box is unticked), those it does not as `left`, the review
   * open, these tools, the secrets no part may hold; and `own(ref)`, whether a file is the user's own.
   */
  async function projectParts(record) {
    const mine = new Set(startFiles(record).map((r) => r.sha256));
    const files = [], left = [];
    for (const ref of distinct(keptBy(record))) {
      if (!ownBox.checked && mine.has(ref.sha256)) { left.push({ ref, why: 'left-out' }); continue; }
      const f = await outs.get(ref);
      if (f) files.push({ ref, blob: f }); else left.push({ ref, why: 'not-kept' });
    }
    const r = page.review?.();
    return { record, files, left, review: r ? { name: r.name, text: r.text } : null, tools: build, refuse: page.secrets?.() || [], own: (ref) => mine.has(ref.sha256) };
  }
  const pickProject = () => { if (projectFile) { projectFile.value = ''; projectFile.click(); } };
  openP.addEventListener('click', pickProject);
  openBanner?.addEventListener('click', pickProject);
  projectFile?.addEventListener('change', () => {
    const [f] = projectFile.files || [];
    if (!f) return;
    openOrAsk(f, f.name);
  });
  /**
   * Open the project `blob` (a file chosen, or one from WHG: `opts`, as openProject takes them); while a
   * workflow is open, asked first, in words, with the safe choice focused. `opts.what` names it in the question.
   */
  function openOrAsk(blob, name, opts = {}) {
    if (wf || pending || changed) {
      replacing = { blob, name, opts };
      const now = wf || changed?.record;
      replaceWords.textContent = `“${now ? now.name || recipeOf(now)?.title : RECIPES[pending.key].title}” is open. Open ${opts.what || name} in its place? This workflow, and the files this browser keeps for it, are let go: save it as a project first to keep it.`;
      replaceEl.hidden = false; projectEl.open = true;
      render(false);
      q(replaceEl, '#methodos-replace-no').focus();
      return;
    }
    chain(() => openProject(blob, name, opts));
  }
  q(replaceEl, '#methodos-replace-yes').addEventListener('click', () => { const r = replacing; replacing = null; replaceEl.hidden = true; if (r) chain(() => openProject(r.blob, r.name, r.opts)); });
  q(replaceEl, '#methodos-replace-no').addEventListener('click', () => { replacing = null; replaceEl.hidden = true; say('The project was not opened: this workflow stays as it was.'); render(false); openP.focus(); });

  /**
   * Open the project `blob` (a File, or the project of a WHG project), called `name`: read and checked whole
   * before anything of the workflow open is let go. `whg`: it came from WHG (whg.js open(), or the copy a
   * conflict gave), and its link is kept once it is open. `copy`: it is the user's own copy of a workflow
   * shared from WHG ({ version, title }): it is given an id of its own, and not linked; only where it came
   * from is kept (never the share link).
   */
  async function openProject(blob, name, { whg: got = null, copy = null } = {}) {
    const file = { name };
    tell(`Reading ${name}…`);
    const old = wf || changed?.record || null;
    const ours = new Set([...(old ? keptBy(old) : []).map((r) => r.sha256), ...(await outs.kept()).files.map((f) => f.sha256)]);
    // What a refused project may have written into this browser (any file part it names, whole or begun), and was not kept before it, goes again.
    const undo = async (parts) => outs.drop((parts || []).filter((p) => !ours.has(p.sha256)).map((p) => ({ sha256: p.sha256 })));
    let read;
    try {
      read = await readProject(blobSource(blob), {
        name,
        // Room for its files before any is written: the browser's own estimate, with a margin (a tenth, and
        // a megabyte); held in memory (working data not kept), at most IN_MEMORY.
        room: async (bytes) => {
          if (!outs.keeping()) {
            if (bytes > IN_MEMORY) throw new ProjectError(`Its files come to ${fmtBytes(bytes)}, and with "Keep my working data" off they would be held in this tab's memory, which takes at most ${fmtBytes(IN_MEMORY)}: turn it on (Permissions) and open the project again.`);
            return;
          }
          let e = null;
          try { e = await navigator.storage?.estimate?.(); } catch { /* not said */ }
          if (e && typeof e.quota === 'number' && e.quota - (e.usage || 0) < bytes * 1.1 + 1e6)
            throw new ProjectError(`Its files come to ${fmtBytes(bytes)}, and this browser has room for ${fmtBytes(Math.max(0, e.quota - (e.usage || 0)))} (a private window has very little), so nothing of it was written.`);
        },
        sink: async (part) => {
          const w = await outs.writer({ type: 'files', name: part.name, size: part.size, sha256: part.sha256 }, { own: part.own });
          const kept = (e) => new ProjectError(`${part.name} could not be kept in this browser (${e?.name === 'QuotaExceededError' ? 'it has not room enough' : 'it would not keep it'}), so the project was not opened.`);
          return { write: async (c) => { try { await w.write(c); } catch (e) { throw kept(e); } }, close: async () => { try { return await w.close(); } catch (e) { throw kept(e); } }, abort: () => w.abort() };
        },
      });
    } catch (e) {
      await undo(e.fileParts);
      tell(`${file.name} was not opened. ${e.message || e}`, true);
      return;
    }
    const recipe = RECIPES[read.record.recipe.key];
    const origin = read.record.id;
    if (copy) read.record = { ...read.record, id: `${read.record.recipe.key}-${Date.now().toString(36)}` };
    const v = reconcile(read.record, recipe);
    if (v.action === 'refuse') { await undo(read.files.map((c) => c.part)); tell(`${file.name} was not opened. ${v.words}`, true); return; }
    // The new record is kept first, and only then the workflow open let go (its user's file handed over as
    // Leave does): a tab that dies between the two leaves two workflows, never none.
    await store.save(v.action === 'continue' ? v.state : read.record);
    const fresh = new Set(read.files.map((c) => c.part.sha256));
    if (old) { await handOver(old); await outs.drop(keptBy(old).filter((r) => !fresh.has(r.sha256))); if (old.id !== read.record.id) await store.remove(old.id); }
    if (pending) await store.dropPending(pending.id);
    fromNewer = read.newer ? read.record.id : null;
    wf = null; wfScope = null; pending = null; changed = null; active = null; note = null; handle = handleFile = keptHandle = null; asIs = null; ownMissed = [];
    chosenRefs = null;
    if (projectSaid) { projectSaid.hidden = true; projectSaid.textContent = ''; }
    const by = read.manifest.tools.version === build?.version ? '' : ` (saved by PLATO tools ${read.manifest.tools.version})`;
    const what = copy ? `Your own copy of “${copy.title || read.record.name}”, shared from WHG (version ${copy.version} there)${by}, every part checked: a new workflow of this browser's, not linked to the one shared.`
      : got ? `Opened “${got.title || read.record.name}” from WHG (version ${got.version})${by}, every part checked.` : `Opened the project ${file.name}${by}, every part checked.`;
    const opened = `${what}${read.newer ? ` ${newerWords(read.manifest)}` : ''}${(read.manifest.left || []).some((x) => x.why === 'too-large') ? ` Left out to fit WHG: ${read.manifest.left.filter((x) => x.why === 'too-large').map((x) => x.name).join(', ')}; choose ${read.manifest.left.filter((x) => x.why === 'too-large').length === 1 ? 'it' : 'them'} again where a step needs ${read.manifest.left.filter((x) => x.why === 'too-large').length === 1 ? 'it' : 'them'}.` : ''}`;
    // What is kept of WHG beside the workflow, once it is open: its link (opened from there), or where a copy came from.
    const linkUp = async () => {
      const st = wf || changed?.record;
      if (!whg || !st) return;
      if (got) { whgLink = await whg.opened(toSave(), got, page.review?.()?.text ?? null); whgLinkFor = st.id; }
      else if (copy) { whgLink = { origin: { workflowId: origin, version: copy.version, title: String(copy.title || '').slice(0, 300) } }; whgLinkFor = st.id; await whg.setLink(st.id, whgLink); }
      projectShow();
    };
    // The base address the workflow was begun under, into Options if it has none (said; nothing is run with it).
    const base = typeof read.record.answers?.base === 'string' ? read.record.answers.base : '';
    const baseSet = base && !page.base?.() ? (page.setBase?.(base), ` The base address in Options is set to ${base}, the workflow's.`) : '';
    // A hand-back from Chora's page of before (projects saved until 13 October 2026), at Chora's step: the
    // file it names is said, to be chosen by hand; nothing waits for it now.
    const atPlace = v.action === 'continue' && stepAt(v.state)?.op === 'place';
    const hb = atPlace && read.handback ? ` Chora had saved ${names(read.handback.files)}: choose it in step 1, and say the step is done.` : '';
    if (v.action !== 'continue') {
      changed = { action: v.action, record: read.record, words: v.words };
      await store.save(read.record);
      say(`${opened}${baseSet} ${v.words}`);
      render(true); await linkUp(); return;
    }
    const took = await takeUp(v, read.record, `${opened}${baseSet}${hb}`);
    if (!took) render(true); else show(strip.offsetParent ? strip : q(tracker, 'h2'));
    // The review open when it was saved is opened again, on the dataset it was made of, as "Resume a review" opens one.
    if (read.review) {
      const subjects = read.review.work.subjects?.files || [];
      const held = subjects.map((r) => outs.held(r)).filter(Boolean);
      await page.openReview?.(new File([read.review.text], read.review.name, { type: 'application/json' }), held.length === subjects.length ? held : []);
      projectShow();
    }
    await linkUp();
  }
  // ---- The project in WHG's Workbench (src/methodos/whg.js; plan #34, item A1) ----------------------
  // "Save to WHG" keeps the project there as the project file holds it (in its envelope: src/engine/
  // workbench.js), only when asked and at a step boundary (D3), in the personal team (D4); one too large
  // for WHG's cap goes without its largest files, which are said before saving (D1). A newer save in WHG is
  // never saved over (D2): the copy there is offered, or this one as a new project. "Open from WHG" lists
  // your projects there, opens one as a file is opened, and deletes one, asked in the page. "Share a
  // read-only link" makes a link anyone can read the project with, said so beside it. Every request goes
  // through permissions.fetch under collaborate:whg with the token in its header only; a refusal is said in
  // words (workbench.js WORDS), and nothing kept in this browser is lost by one.
  const whgEl = q(tracker, '#whg-project'), whgNeeds = q(tracker, '#whg-needs'), whgState = q(tracker, '#whg-state'), whgLeaves = q(tracker, '#whg-leaves');
  const whgSaveB = q(tracker, '#whg-save'), whgOpenB = q(tracker, '#whg-open'), whgShareB = q(tracker, '#whg-share'), whgUnshareB = q(tracker, '#whg-unshare');
  const whgChoice = q(tracker, '#whg-choice'), whgLinkEl = q(tracker, '#whg-link'), whgSaid = q(tracker, '#whg-said'), whgTokenBox = q(tracker, '#whgp-token-box');
  const listBox = document.getElementById('whg-projects'), listUl = document.getElementById('whg-projects-list'), listSaidEl = document.getElementById('whg-projects-said');
  const sharedEl = q(tracker, '#methodos-shared');
  const SHARE_WARNING = 'Anyone with this link can read this workflow as it is kept in WHG: the names in it, your decisions, the reviewer’s name and any files it holds. It always shows your newest save to WHG, not the workflow as it is here now. Stop sharing, and the link opens nothing.';
  const whenWords = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? 'before' : `on ${d.toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`; };
  const ROLE_WORDS = { owner: 'Yours', editor: 'You can edit it', viewer: 'You can read it' };
  let whgLink = null, whgLinkFor = null;   // the link of the workflow shown to its project in WHG (store.js), and that workflow's id
  let planned = null;                      // what a save to WHG would leave out, for the workflow as it was measured: { key, words }
  let askedToken = false;                  // WHG refused the token, or none was held: the section's token field is shown
  const shareTokens = new Set();           // the share links' tokens seen in this tab: secrets that a project file refuses (page.secrets)
  let viewing = null;                      // a workflow shared from WHG, shown read-only: { read, blob, name, title, version }
  /** Say `words` in `where` (a warning if `warn`), with `extra` (a link) after them; nothing hides it. */
  const sayIn = (where) => (words, warn = false, extra = null) => {
    where.replaceChildren(); where.hidden = !words; where.classList.toggle('warn', !!warn);
    if (words) where.append(words);
    if (extra) where.append(' ', extra);
  };
  const whgSay = sayIn(whgSaid), listSay = sayIn(listSaidEl);
  /** While WHG asks for a pause (429): the seconds counted down where the request was asked, then it is made once more. */
  const pause = (sayIt) => async (secs) => {
    for (let i = secs; i > 0; i--) { sayIt(`WHG asks for a pause: trying again in ${i} ${i === 1 ? 'second' : 'seconds'}…`); await new Promise((r) => setTimeout(r, 1000)); }
  };
  /** A refusal, in words, where it was asked: the token field opened for a token refused or missing, WHG's page named for its beta. */
  function whgFailed(e, action, sayIt = whgSay) {
    if (e?.kind === 'token' || e?.kind === 'unauthenticated') {
      askedToken = true;
      // The field where the request was asked: the list of your projects, shown with no workflow open, or the tracker's part.
      if (sayIt === listSay && tracker.hidden) listSaidEl.after(whgTokenBox); else { whgNeeds.after(whgTokenBox); projectEl.open = true; }
      whgTokenBox.hidden = false; page.askToken?.();
    }
    const link = e?.kind === 'beta' ? el('a', { href: ENROL, target: '_blank', rel: 'noopener noreferrer', textContent: 'WHG’s development page (opens in a new tab)' }) : null;
    sayIt(whyWords(e, action), true, link);
  }
  function whgReset() { whgChoice.hidden = true; whgLinkEl.hidden = true; whgSay(null); planned = null; }
  /** The WHG part of the folded "Save, open or share the project", drawn with it (projectShow). */
  function whgShow() {
    whgEl.hidden = !whg;
    if (!whg) return;
    const st = viewing ? null : wf || changed?.record;
    page.collaborate?.(whgNeeds);
    if (!tracker.hidden && whgTokenBox.parentElement !== whgEl) whgNeeds.after(whgTokenBox);
    whgTokenBox.hidden = !askedToken && !!page.hasToken?.();
    whgSaveB.hidden = !st; whgShareB.hidden = !st;
    whgSaveB.disabled = !!wf && !atBoundary(wf);
    if (!st) { whgState.textContent = 'Open a project kept in WHG, or save a workflow there once one is begun.'; whgLeaves.hidden = true; whgUnshareB.hidden = true; return; }
    if (whgLinkFor !== st.id) {
      whgLinkFor = st.id; whgLink = null; whgReset();
      whg.linkFor(st.id).then((l) => { if (whgLinkFor === st.id) { whgLink = l; whgShow(); } }).catch(() => {});
    }
    const l = whgLink?.projectId ? whgLink : null;
    whgUnshareB.hidden = !l?.shared;
    whgShareB.textContent = l?.shared ? 'Show the read-only link' : 'Share a read-only link';
    if (!projectEl.open) return;   // what follows is measured only while it is shown
    const review = page.review?.() || null;   // serialised once here, for the digest and the plan
    const now = stateOf(toSave(), review?.text ?? null);
    whgState.textContent = !l
      ? `Not saved to WHG.${whgLink?.origin ? ` This is your own copy of “${whgLink.origin.title || 'a workflow'}”, shared from WHG (version ${whgLink.origin.version} there), and is not linked to it.` : ''} Saved there, it is kept in your own workbench, as the project file holds it.`
      : `${l.state === now ? `Saved to WHG ${whenWords(l.savedAt)}, as version ${l.version}.` : `Not saved to WHG since ${whenWords(l.savedAt)}: the workflow has changed since (WHG has version ${l.version}).`}${l.shared ? ' Shared: anyone with its link can read it.' : ''}`;
    planLeaves(st, review);
  }
  /** What a save to WHG would leave out now, measured as it would be sent (whg.js fit()), said before saving; once for each state of the workflow. */
  function planLeaves(st, review) {
    if (wf && !atBoundary(wf)) return;
    const key = `${st.id}|${st.saved}|${ownBox.checked}|${review?.name || ''}|${review?.text?.length || 0}`;
    if (planned?.key === key) { whgLeaves.textContent = planned.words || ''; whgLeaves.hidden = !planned.words; return; }
    planned = { key, words: null };
    const record = toSave();
    projectParts(record).then((parts) => whg.fit(parts, whgLink?.projectId ? whgLink : null)).then((f) => {
      const n = f.tooLarge.length;
      return n ? `Too large for WHG with every file: ${f.tooLarge.map((r) => r.name).join(', ')} will not go to WHG (it takes at most 2 MB a project). The workflow${review ? ' and the review' : ''} will, and ${n === 1 ? 'the file left out is' : 'each file left out is'} listed in it, to be chosen again where a step needs ${n === 1 ? 'it' : 'them'}.` : '';
    }, (e) => (e instanceof WorkbenchError || e instanceof ProjectError ? e.message : '')).then((words) => {
      if (planned?.key !== key) return;
      planned.words = words; whgLeaves.textContent = words; whgLeaves.hidden = !words;
    });
  }
  /** A choice in words, with its buttons ([words, fn], the first focused); each done in its turn. */
  function whgAsk(words, buttons) {
    q(whgChoice, '#whg-choice-words').textContent = words;
    const row = q(whgChoice, '.whg-choice-buttons');
    row.replaceChildren(...buttons.map(([w, fn], i) => { const b = el('button', { type: 'button', textContent: w }); b.dataset.choice = String(i); b.onclick = () => { whgChoice.hidden = true; chain(fn); }; return b; }));
    whgChoice.hidden = false; projectEl.open = true;
    row.querySelector('button')?.focus();
  }
  whgSaveB.addEventListener('click', () => {
    const record = toSave();
    if (!record || !whg || viewing) return;
    if (wf && !atBoundary(wf)) { whgSay('A step is running: save to WHG once it has finished.', true); return; }
    whgChoice.hidden = true;
    chain(async () => {
      const link = await whg.linkFor(record.id);
      if (link?.projectId) { await whgSave(record, link); return; }
      // No link here: a project in WHG may hold this workflow already (saved from another browser), to save to rather than beside.
      whgSay('Looking in your projects in WHG for this workflow…');
      let found;
      try { found = await whg.matches(record, pause(whgSay)); } catch (e) { whgFailed(e, 'save'); return; }
      if (!found.length) { await whgSave(record, null); return; }
      const [m] = found;
      whgSay(null);
      whgAsk(`Your projects in WHG hold this workflow already: “${m.title}”, version ${m.version}, saved ${whenWords(m.updated)}. Save to it, or as a new WHG project?`,
        [['Save to it', () => whgSave(record, { projectId: m.id, version: m.version, title: m.title })], ['Save as a new WHG project', () => whgSave(record, null)]]);
    });
  });
  /** Save `record` to WHG: to `to` (its link, or a match), or as a new project. A newer save in WHG is offered, never saved over. */
  async function whgSave(record, to) {
    whgSay(to ? 'Saving to WHG…' : 'Saving to WHG, as a new project in your workbench…');
    let res;
    try {
      const parts = await projectParts(record);
      res = await whg.save({ project: parts, to, review: parts.review?.text ?? null, shared: !!(to && whgLink?.projectId === to.projectId && whgLink.shared), wait: pause(whgSay) });
    } catch (e) {
      if (e instanceof WorkbenchError && e.kind === 'conflict') {
        whgSay(null);
        whgAsk(`WHG has a newer save of this workflow (version ${e.version}), perhaps your own from another browser, so this one was not saved over it: nothing was changed, here or there.`, [
          ['Open the copy on WHG', async () => {
            let got;
            try { got = { ...fromSnapshot(e.snapshot, to.title || whgLink?.title || record.name), projectId: to.projectId, version: e.version, shared: !!whgLink?.shared }; } catch (x) { whgFailed(x, 'open'); return; }
            openOrAsk(got.blob, got.name, { whg: got, what: `WHG's copy (version ${e.version})` });
          }],
          ['Save mine as a new WHG project', () => whgSave(record, null)],
        ]);
        return;
      }
      if (e?.kind === 'gone') { whgLink = await whg.linkFor(record.id); whgLinkFor = record.id; }
      whgFailed(e, 'save'); render(false); return;
    }
    whgLink = res.link; whgLinkFor = record.id; askedToken = false;
    const left = res.tooLarge.map((r) => r.name), one = left.length === 1;
    whgSay(`Saved to WHG${res.created ? ', as a new project in your workbench' : ''} (version ${res.link.version}, ${fmtBytes(res.size)}).${left.length ? ` Not in it, as too large for WHG: ${left.join(', ')}; whoever opens it chooses ${one ? 'it' : 'them'} again where a step needs ${one ? 'it' : 'them'}.` : ''}`);
    render(false);
  }

  // "Open from WHG": your projects there, each to open or (yours) delete; shown below the tracker, or alone.
  function openFromWhg() {
    if (!whg) return;
    listBox.hidden = false; listUl.replaceChildren(); listSay('Asking WHG for your projects…');
    page.collaborate?.(document.getElementById('whg-projects-needs'));
    show(document.getElementById('whg-projects-h'));
    chain(async () => {
      let list;
      try { list = await whg.list(pause(listSay)); } catch (e) { whgFailed(e, 'list', listSay); return; }
      listSay(list.length ? `${list.length} ${list.length === 1 ? 'project' : 'projects'} of PLATO tools in your WHG workbench, the newest first.`
        : 'You have no PLATO tools projects in WHG yet. “Save to WHG”, under a workflow’s “Save, open or share the project”, keeps one there.');
      listUl.replaceChildren(...list.map(projectItem));
    });
  }
  function projectItem(p) {
    const li = el('li');
    li.dataset.project = p.id; li.dataset.role = p.role;
    const openB = el('button', { type: 'button', className: 'whg-open-one', textContent: 'Open' });
    openB.addEventListener('click', () => chain(async () => {
      listSay(`Opening “${p.title}” from WHG…`);
      let got;
      try { got = await whg.open(p.id, pause(listSay)); } catch (e) { whgFailed(e, 'open', listSay); return; }
      listSay(null); listBox.hidden = true;
      if (viewing) { viewing = null; render(false); }
      openOrAsk(got.blob, got.name, { whg: got, what: `“${p.title}” from WHG` });
    }));
    li.append(el('span', { className: 'whg-title', textContent: p.title || 'Untitled' }),
      el('span', { className: 'whg-about', textContent: `${ROLE_WORDS[p.role] || 'In a team of yours'}; saved ${whenWords(p.updated)}, version ${p.version}${p.shared ? '; shared' : ''}.` }), openB);
    if (p.role === 'owner') {
      const delB = el('button', { type: 'button', className: 'whg-delete', textContent: 'Delete' });
      delB.addEventListener('click', () => confirmDelete(li, p, delB));
      li.append(' ', delB);
    }
    return li;
  }
  /** Delete a project from WHG, asked first in the page (never in a browser's dialogue), "Keep it" focused. */
  function confirmDelete(li, p, delB) {
    li.querySelector('.whg-confirm')?.remove();
    const yes = el('button', { type: 'button', className: 'whg-delete-yes', textContent: 'Delete it' }), no = el('button', { type: 'button', className: 'whg-delete-no', textContent: 'Keep it' });
    const box = el('span', { className: 'whg-confirm' }, `Delete “${p.title}” from WHG? This cannot be undone${p.shared ? ', and its share link stops working' : ''}; a workflow open in a browser stays there. `, yes, ' ', no);
    li.append(box); delB.disabled = true; no.focus();
    no.addEventListener('click', () => { box.remove(); delB.disabled = false; delB.focus(); });
    yes.addEventListener('click', () => chain(async () => {
      try { await whg.remove(p.id, pause(listSay)); } catch (e) { whgFailed(e, 'delete', listSay); return; }
      // A workflow here linked to it is linked no longer.
      const st = wf || changed?.record;
      if (st && whgLink?.projectId === p.id) { await whg.forget(st.id); whgLink = await whg.linkFor(st.id); }
      li.remove();
      listSay(`Deleted “${p.title}” from WHG.`);
      if (!listUl.children.length) listSay(`Deleted “${p.title}” from WHG. You have no other PLATO tools projects there.`);
      document.getElementById('whg-projects-close').focus();
      render(false);
    }));
  }
  whgOpenB.addEventListener('click', openFromWhg);
  document.getElementById('whg-open-banner')?.addEventListener('click', openFromWhg);
  document.getElementById('whg-projects-close').addEventListener('click', () => { listBox.hidden = true; listSay(null); (tracker.hidden ? backTo() : whgOpenB.focus()); });

  // "Share a read-only link": the project as last saved to WHG, readable by anyone with the link.
  whgShareB.addEventListener('click', () => chain(async () => {
    const st = wf || changed?.record;
    if (!st || !whg) return;
    whgSay('Asking WHG for a read-only link…');
    let token;
    try { token = await whg.share(st.id, pause(whgSay)); } catch (e) { whgLink = await whg.linkFor(st.id); whgFailed(e, 'share'); render(false); return; }
    shareTokens.add(token);
    whgLink = await whg.linkFor(st.id);
    const url = q(whgLinkEl, '#whg-link-url');
    url.value = shareLink(page.shareBase?.() || location.href, token);
    q(whgLinkEl, '#whg-link-words').textContent = SHARE_WARNING;
    whgLinkEl.hidden = false; whgSay(null);
    render(false);
    url.focus(); url.select();
  }));
  q(whgLinkEl, '#whg-copy').addEventListener('click', () => {
    const url = q(whgLinkEl, '#whg-link-url');
    const done = () => whgSay('The link is copied.');
    const by = () => { url.focus(); url.select(); whgSay('Copy it from the box: it is selected.'); };
    try { navigator.clipboard.writeText(url.value).then(done, by); } catch { by(); }
  });
  whgUnshareB.addEventListener('click', () => chain(async () => {
    const st = wf || changed?.record;
    if (!st || !whg) return;
    try { await whg.unshare(st.id, pause(whgSay)); } catch (e) { whgFailed(e, 'share'); return; }
    whgLink = await whg.linkFor(st.id);
    whgLinkEl.hidden = true; q(whgLinkEl, '#whg-link-url').value = '';
    whgSay('Sharing stopped: its link opens nothing now. Sharing it again makes a new link.');
    render(false); whgShareB.focus();
  }));
  // The token given (or forgotten) in the section's field, or anywhere: the field is drawn again.
  const tokenGiven = () => { if (page.hasToken?.()) askedToken = false; projectShow(); };

  /**
   * A share link (#whg-shared=<token>, read and removed from the address by the host): the workflow it
   * opens, read from WHG with no token, checked as a project file is (readProject, nothing written), and
   * shown read-only in the tracker, every action off but "Make my own copy", "Download .platoproj" and
   * "Close". Opened again, it shows WHG's newest save, never a second copy.
   */
  function viewShared(token) {
    if (!whg) return;
    shareTokens.add(token);
    // After a workflow kept from before is taken up, so that what is said of the shared one is not said over.
    const go = () => chain(async () => {
      if (viewing) { viewing = null; render(false); }   // another link: the one shown before is closed, whatever this one opens
      tell('Reading the shared workflow from WHG…');
      let got;
      try { got = await whg.shared(token, pause((w) => tell(w))); } catch (e) { tell(whyWords(e, 'shared'), true); return; }
      let read;
      try { read = await readProject(blobSource(got.blob), { name: got.name }); } catch (e) { tell(`The shared workflow was not opened. ${e.message || e}`, true); return; }
      viewing = { read, blob: got.blob, name: got.name, title: got.title, version: got.version };
      if (projectSaid) { projectSaid.hidden = true; projectSaid.textContent = ''; }
      say(null); render(true);
      q(sharedEl, '#methodos-shared-copy').focus();
    });
    takenUp.then(go, go);
  }
  q(sharedEl, '#methodos-shared-copy').addEventListener('click', () => {
    const v = viewing;
    if (!v) return;
    viewing = null; render(false);
    openOrAsk(v.blob, v.name, { copy: { version: v.version, title: v.title }, what: `your own copy of “${v.title || v.read.record.name}”` });
  });
  q(sharedEl, '#methodos-shared-download').addEventListener('click', () => {
    if (!viewing) return;
    const a = el('a', { href: URL.createObjectURL(viewing.blob), download: viewing.name, rel: 'noopener' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  });
  q(sharedEl, '#methodos-shared-close').addEventListener('click', () => { viewing = null; say(null); render(false); if (tracker.hidden) backTo(); else show(q(tracker, 'h2')); });

  return { open, chosen, placed, began, ended, dropped, keepChanged, detected, baseChanged, id: () => wf?.id || null, following: () => !!(wf || pending || changed), takenUp: () => takenUp,
    scope: scopeNow, setScope, scoped: () => !!(wf || pending || changed), viewShared, openFromWhg, shareTokens: () => [...shareTokens], tokenGiven };
}
