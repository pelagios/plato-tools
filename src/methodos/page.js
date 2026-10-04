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
import { atBoundary, reconcile, restartRemaining } from '../engine/methodos/record.js';
import { take as takeHandback, isWorkflowId } from '../chora/handback.js';
import { outputStore } from './outputs.js';
import { fmtBytes } from '../engine/words.js';
import { regionsSettled, notReviewed, relateProblem, writesItself } from '../engine/methodos/containment.js';

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
// step is done elsewhere (Hermes's columns, at the drop zone; Chora, on its own page).
const PAGE_TOOL = {
  check: 'check', convert: 'convert', compare: 'versions', match: 'match', lookup: 'match', 'lookup.levels': 'match', review: 'match', apply: 'match',
  'relate.containment': 'match', 'publish.report': 'publish', 'publish.mint': 'publish', 'publish.site': 'publish', 'publish.w3id': 'publish',
};
// The tools that the interview names when no workflow fits: their names, and where each is chosen.
const TOOL_LINKS = {
  read: ['Hermes', '#files', 'bring your file into PLATO'], check: ['Elenchos', '#tool=check', 'check it'], convert: ['Metaphrasis', '#tool=convert', 'convert it'],
  figures: ['Arithmos', '#tool=figures', 'figures as RDF Data Cube'], versions: ['Mneme', '#tool=versions', 'compare two versions'],
  publish: ['Agora', '#tool=publish', 'prepare it for publishing'], match: ['Krisis', '#tool=match', 'match it with another dataset, or a gazetteer'],
  chora: ['Chora', './chora.html', 'see it on the map, and draw places'],
};
const STATE_WORDS = { done: 'Done', current: 'Now', todo: 'To come', unavailable: 'Not yet available' };
const MARKS = { done: '✓', current: '●', todo: '○', unavailable: '–' };
const mark = (t) => { const m = el('span', { className: 'track-mark', textContent: t }); m.setAttribute('aria-hidden', 'true'); return m; };
// A title within a sentence: its first letter in lower case, unless the first word is all capitals (FAIR, PLATO).
const lower = (t) => (/^[A-Z]{2,}\b/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));
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
    const li = el('li', { className: `track-step is-${st}` });
    li.dataset.step = s.id; li.dataset.state = st;
    if (st === 'current') li.setAttribute('aria-current', 'step');
    li.append(mark(MARKS[st]),
      el('span', { className: 'track-body' },
        el('span', { className: 'track-state', textContent: STATE_WORDS[st] }), ' ',
        s.tool ? el('span', { className: 'track-tool', textContent: s.tool }) : null, s.tool ? ': ' : null,
        el('span', { className: 'track-act', textContent: s.title }),
        st === 'unavailable' ? el('span', { className: 'track-why', textContent: s.available }) : null,
        n === steps.length - 1 && notes.length ? el('span', { className: 'track-end', textContent: notes.join(' ') }) : null));
    list.append(li);
  }
}

/**
 * Mount Methodos: `banner` is the one line that opens the interview, hidden while the interview is
 * open or a workflow is followed; `interview` and `tracker` are the two components' elements
 * (index.html); `store` is phase 2's store (src/methodos/store.js, workflowStore()); `onStep(step)` is
 * told each step the workflow comes to, as { tool, text, link } (tool: a #tool= key or null), and null
 * when it is left. `page` is what the host gives of itself:
 *   files()          the files chosen in step 1;          choose(files)  choose these in step 1;
 *   pick()           open step 1's file picker;           output(name)   a File the last run wrote;
 *   ready()          a promise, settled when the engine is ready for a file;
 *   mapping()        the matching of columns shown, or null;
 *   review()         the review open, as { text, name }, or null;
 *   openWork(file)   open a Krisis work file, as "Resume a review" does;  pickWork()  choose one;
 *   ownTarget()      the format of the files chosen, as a conversion's target key, or null;
 *   base()           the base address in Options;  setBase(v)  write one there (the one store of it).
 * `workflow` is the id the page's address named (#workflow=<id>, Chora's way back), or null: that
 * workflow is the one taken up, and its step "place" offers Chora's hand-back.
 * Returns { open(), chosen(files), began(run), ended(run), keepChanged(on), id() }: the host
 * tells it the files chosen, and each run of a tool as it begins ({ op, files }) and ends ({ op,
 * report, outputs, incomplete } or { op, error, partial } or { op, waiting } or { op, cancelled }).
 */
export function mountMethodos({ banner, interview, tracker, store, onStep, tools, page, workflow = null, outputs = null }) {
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
  // Chora's is a link to its own page, and goes there.
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
    if (wf || changed) { await outs.drop(madeBy(wf || changed.record)); await store.remove((wf || changed.record).id); }
    pending = { key: recipe.key, answers: answersFor(choice, yesNo, texts), id: `${recipe.key}-${Date.now().toString(36)}`, steps: p.steps.length };
    wf = null; changed = null; note = null; fromChora = null; arrived = null; active = null;
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

  // ---- The tracker: the workflow's steps, done, now, and to come, above step 1. -------------------
  // Before a file is chosen the workflow is `pending` (its recipe and answers, for this tab): the
  // runner starts when step 1's file is chosen (chosen()), and from then on the workflow is the
  // runner's state, kept as a record (src/engine/methodos/record.js) at every step boundary.
  const tList = q(tracker, '#methodos-track'), tTitle = q(tracker, '#methodos-tracker-title'), tWhere = q(tracker, '#methodos-tracker-where');
  const tSaid = q(tracker, '#methodos-said'), tMsg = q(tracker, '#methodos-message');
  const doneB = q(tracker, '#methodos-done'), backB = q(tracker, '#methodos-back'), pickB = q(tracker, '#methodos-pick');
  const backB2 = q(tracker, '#methodos-handback');
  const downloadB = q(tracker, '#methodos-download');
  const useB = q(tracker, '#methodos-use'), reopenB = q(tracker, '#methodos-reopen'), restartB = q(tracker, '#methodos-restart');
  let wf = null;            // the runner's state, as a record ({ id, name, created, saved, ...state })
  let changed = null;       // a record the version rule would not carry on: { record, words } (reconcile's 'changed' or 'refuse')
  let note = null;          // what the tracker says beside the steps: { words, warn }
  let active = null;        // the run under way that is the current step's: { id, op }
  let chosenRefs = null;    // the files chosen in step 1, as references
  let handle = null, handleFile = null;   // the FileSystemFileHandle the workflow's file was chosen through, if any (Chromium)
  let keptHandle = null;    // the handle kept for a resumed workflow
  let fromChora = null;     // Chora's hand-back, taken on the user's click: the references the file chosen next must match
  let arrived = isWorkflowId(workflow) ? workflow : null;   // the workflow the address named, whose "place" step offers the hand-back
  const outs = outputs || outputStore();   // the files the steps made, by SHA-256, to hand on to the next step (src/methodos/outputs.js)
  const heldFor = (r) => outs.held(r);
  let queue = Promise.resolve();
  const chain = (fn) => (queue = queue.then(fn).catch((e) => { say(e.message || String(e), true); render(false); }));
  const say = (words, warn = false) => { note = words ? { words, warn } : null; };
  const recipeOf = (r) => RECIPES[r.recipe?.key];
  const fileKey = (recipe) => Object.keys(recipe.files || {})[0];

  /** The step the workflow is at: the one running or waiting, else the one that stopped, failed or was cancelled, else the next to do. */
  function atStep(state = wf) {
    if (!state || state.status === 'completed') return null;
    if (state.current) return state.steps.find((s) => s.id === state.current);
    return state.steps.find((s) => ['stopped', 'failed', 'cancelled'].includes(s.state)) || state.steps.find((s) => s.state === 'pending') || null;
  }
  const followed = (state) => state.steps.filter((s) => s.state !== 'skipped');
  /** The references the step at hand takes from the files chosen in step 1 (its main input), or null; throws in words if an earlier step is not done. */
  function mainInput(state, s) {
    const slot = MAIN[s.op];
    if (!slot) return null;
    return runner.inputsOf(state, s.id)[slot] || null;
  }
  async function keep() {
    if (!wf || !atBoundary(wf)) return;
    const { record, kept } = await store.save(wf, { name: wf.name || (chosenRefs?.[0]?.name) });
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
  /** Every file the workflow's steps made, as references. */
  const madeBy = (state) => (state ? state.steps.flatMap((x) => [...Object.values(x.outputs || {}), ...Object.values(x.partial || {})].flat()) : []);
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
        wf = { ...runner.start(recipe, pending.answers, { [fileKey(recipe)]: chosenRefs }), id: pending.id };
        pending = null;
        say(`Begun with ${names(chosenRefs)}.`);
        await keep(); await store.dropPending(wf.id); render(false); return;
      }
      if (!wf || changed) return;
      const s = atStep();
      if (!s) return;
      if (s.op === 'place' && fromChora) {
        // Chora's hand-back names the file it saved and does not hold it: the file chosen completes
        // the step only if it is that file (by size and SHA-256).
        const differ = await refsDiffer(fromChora, files);
        if (differ.length) { say(`This is not the file Chora handed back: ${differ.join(', ')} ${differ.length === 1 ? 'differs' : 'differ'}. Choose ${names(fromChora)}, as it was saved in Chora.`, true); render(false); return; }
        const refs = fromChora;
        files.forEach((f) => outs.hold(refs.find((r) => r.name === f.name) || refs[0], f));
        await finishInteractive(s, { dataset: refs });
        fromChora = null;   // only once the step is done: the hand-back, taken, is not to be lost
        say(`${names(refs)}: the dataset Chora handed back, checked. The step is done.`); render(false);
        return;
      }
      let main = null;
      try { main = s.op === 'read.columns' ? runner.inputsOf(wf, s.id).files : mainInput(wf, s); } catch { main = null; }
      if (!main) return;
      const differ = await refsDiffer(main, files);
      say(differ.length ? notTheFiles(s, main, differ) : `${names(main)}: the file${main.length === 1 ? '' : 's'} this step takes.`, !!differ.length);
      render(false);
    });
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
      // By hand: the dataset saved in Chora, chosen again in step 1 (when no hand-back came, or none was taken).
      const files = page.files();
      if (!files.length) throw new Error('Choose the dataset you saved in Chora in step 1 first.');
      return { dataset: await refsHeld(files, 'dataset', { own: true }) };
    }
    throw new Error(`The step “${s.title}” is done by the tools, when its run finishes.`);
  }
  async function finishInteractive(s, outputs) {
    let w = wf.status === 'idle' ? runner.next(wf) : wf;
    if (w.current !== s.id) throw new Error(`The workflow is not at the step “${s.title}”.`);
    wf = runner.complete(w, s.id, outputs);
    if (s.op === 'place') fromChora = null;   // done (by the hand-back or by hand): a hand-back taken is not another step's
    say(null); await keep(); render(false);
  }
  doneB.addEventListener('click', () => chain(async () => {
    const s = atStep();
    if (!s || OPERATIONS[s.op].kind !== 'interactive') return;
    try { await finishInteractive(s, await resultOf(s)); } catch (e) { say(e.message, true); render(false); return; }
    if (!atStep()) q(tracker, '#methodos-leave').focus();
  }));
  // Chora's hand-back (src/chora/handback.js), taken only on this click: read once and let go. What it
  // names is asked for in step 1 and checked (chosen()); with none to take, the file is chosen by hand.
  const leaveB = q(tracker, '#methodos-leave'), keptEl = q(tracker, '#methodos-kept'), clearB = q(tracker, '#methodos-clear-kept');
  /** What of the steps' files this browser keeps, said beside a way to clear it. */
  let keptAsked = 0;
  function showKept() {
    const n = ++keptAsked;
    outs.kept().then(({ count, bytes }) => {
      if (n !== keptAsked) return;
      keptEl.hidden = !count || tracker.hidden;
      keptEl.firstChild.textContent = count ? `Kept in this browser for the next steps: ${count} ${count === 1 ? 'file' : 'files'} the steps made (${fmtBytes(bytes)}), never your own files. ` : '';
    }).catch(() => { keptEl.hidden = true; });
  }
  clearB.addEventListener('click', () => chain(async () => {
    await outs.clear(); showKept();
    say('The files the steps made are cleared from this browser: a step that takes one now asks for it to be chosen.');
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
  backB2.addEventListener('click', () => chain(async () => {
    const s = atStep();
    if (!wf || !s || s.op !== 'place') return;
    const r = await takeHandback(wf.id);
    if (r) {
      fromChora = r.files;
      say(`Chora handed back ${names(r.files)}. Choose it in step 1: it is checked to be the file Chora saved, and then the step is done.`);
      render(false); page.pick();
    } else {
      fromChora = null;
      say('Nothing usable came back from Chora (none was kept, it was more than thirty minutes old, or it was not for this workflow). Choose the dataset you saved in Chora in step 1, then say the step is done.', true);
      render(false);
    }
  }));
  backB.addEventListener('click', () => chain(async () => {
    const last = wf && [...wf.steps].reverse().find((s) => s.state === 'done');
    if (!last) return;
    wf = runner.invalidate(wf, last.id); active = null; fromChora = null;
    say(null); await keep(); render(false);
    if (backB.disabled) doneB.focus();
  }));
  q(tracker, '#methodos-leave').addEventListener('click', () => chain(async () => {
    const id = wf?.id || changed?.record.id, was = pending?.id;
    await outs.drop(madeBy(wf || changed?.record));
    wf = null; pending = null; changed = null; active = null; note = null; handle = handleFile = keptHandle = null; fromChora = null; arrived = null;
    if (id) await store.remove(id);
    if (was) await store.dropPending(was);
    render(false); backTo();
  }));
  restartB.addEventListener('click', () => chain(async () => {
    if (!changed || changed.action !== 'changed') return;
    wf = restartRemaining(changed.record, recipeOf(changed.record)); changed = null;
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
      if (!on) {
        await outs.forget();   // the steps' files: for the tab only from now, and cleared from the browser at once
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
    const shown = wf || changed?.record;
    if (!pending && !shown) { tracker.hidden = true; delete tracker.dataset.status; onStep(null); return; }
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
      steps = followed(shown); at = changed ? null : atStep(shown);
      rows = shown.steps.filter((s) => s.state !== 'skipped' || s.unavailable).map((s) => {
        const op = OPERATIONS[s.op];
        return { id: s.id, tool: op.tool, title: s.title, available: s.unavailable || true,
          st: s.unavailable ? 'unavailable' : s.state === 'done' ? 'done' : at && s.id === at.id ? 'current' : 'todo', run: at && s.id === at.id ? s : null };
      });
      tracker.dataset.status = changed ? 'changed' : shown.status;
    }
    trackList(tList, rows, pendingNotes(shown));
    const i = at ? steps.findIndex((s) => s.id === at.id) : -1;
    const s = i >= 0 ? steps[i] : null;
    const where = s ? `Step ${i + 1} of ${steps.length}: ${OPERATIONS[s.op].tool ? `${OPERATIONS[s.op].tool}, ` : ''}${lower(s.title)}.`
      : changed ? changed.words : `Every one of the ${steps.length} steps is done.${pendingNotes(shown).length ? ` ${pendingNotes(shown).join(' ')}` : ''}`;
    tWhere.textContent = where;
    const run = s && RUN_WORDS[s.state] ? RUN_WORDS[s.state](s) : '';
    // The file: chosen through the tracker (its handle kept, where the browser gives one) before the
    // workflow starts, or after a reload when a step takes the file the workflow began with.
    let main = null;
    try { main = s && wf ? mainInput(wf, s) || (s.op === 'read.columns' ? runner.inputsOf(wf, s.id).files : null) : null; } catch { main = null; }
    // Written out in the format it already has: ready to download as it is, and done once downloaded.
    const ready = !!(s && wf && !changed && !run && writesItself(s, page.ownTarget?.()) && main && sameRefs(main, chosenRefs));
    // What the tracker says now: what is to be done next, in words, then any word about the last thing done.
    const op = s && OPERATIONS[s.op];
    let next = '';
    if (!shown) next = `Not started. Choose ${RECIPES[pending.key].files[fileKey(RECIPES[pending.key])].words.toLowerCase()} in step 1 to begin: Methodos starts when it is chosen. Or discard it.`;
    else if (s && op.kind === 'interactive') next = `This step is yours: it waits for ${op.waitsFor}. Say when it is done.`;
    else if (ready) next = `Ready to download: ${names(main)} is already in the format this workflow writes, so it is not converted into itself. Download it, and the step is done.`;
    else if (s && !run) next = `Run ${OPERATIONS[s.op].tool ? `${OPERATIONS[s.op].tool}'s` : 'its'} ${lower(OPERATIONS[s.op].title)} below; the step is done when the run finishes.`;
    const message = [note?.words, next].filter(Boolean).join(' ');
    tMsg.textContent = message; tMsg.hidden = !message; tMsg.classList.toggle('warn', !!note?.warn);
    tSaid.textContent = [where, run, message].filter(Boolean).join(' ');
    doneB.hidden = !(s && op.kind === 'interactive' && !changed && wf);
    backB.disabled = !wf || changed || !wf.steps.some((x) => x.state === 'done');
    restartB.hidden = changed?.action !== 'changed';
    leaveB.textContent = !shown ? 'Discard this workflow' : 'Leave the workflow';
    downloadB.hidden = !ready;
    if (ready) {
      downloadB.textContent = `Download ${names(main)}`;
      tList.querySelector('li.is-current .track-body')?.append(el('span', { className: 'track-run', textContent: 'Ready to download' }));
    }
    const startFiles = wf ? wf.files[fileKey(recipeOf(wf) || { files: {} })] : null;
    const needStart = !shown || (main && startFiles && main.every((r) => startFiles.some((x) => x.sha256 === r.sha256)) && !sameRefs(main, chosenRefs));
    pickB.hidden = !needStart;
    pickB.textContent = keptHandle && wf ? `Open ${keptHandle.name} again` : 'Choose the file';
    const usable = main && !sameRefs(main, chosenRefs) && main.every((r) => !!heldFor(r)) ? main : null;
    useB.hidden = !usable || needStart; if (usable) useB.textContent = `Use ${names(usable)}${fromWhere(wf, s, usable)}`;
    const partial = (s?.state === 'failed' || s?.state === 'cancelled') && s.partial ? Object.values(s.partial).flat()[0] : null;
    reopenB.hidden = !partial;
    backB2.hidden = !(s && s.op === 'place' && wf && !changed && arrived === wf.id && !fromChora);
    if (partial) reopenB.textContent = heldFor(partial) ? `Reopen ${partial.name}` : `Choose ${partial.name} again`;
    if (s && !changed) {
      const p = wf ? { title: recipeOf(wf)?.title } : plan(pending.key, pending.answers);
      onStep({ tool: PAGE_TOOL[s.op] ?? null, text: `Methodos, ${p.title}, step ${i + 1} of ${steps.length}: ${op.tool ? `${op.tool}, ` : ''}${lower(s.title)}.${op.kind === 'interactive' && op.waitsFor ? ` This step is yours: it waits for ${op.waitsFor}.` : ''}`,
        link: s.op === 'place' ? { href: wf && isWorkflowId(wf.id) ? `./chora.html#workflow=${wf.id}` : './chora.html', words: 'Open Chora' } : null });
    } else onStep(null);
    showKept();
    if (focus) show(q(tracker, 'h2'));
  }
  const sameRefs = (a, b) => !!a && !!b && a.length === b.length && a.every((r) => b.some((x) => x.sha256 === r.sha256 && x.size === r.size));
  const pendingNotes = (state) => (state ? (!RECIPES[state.recipe.key] ? [] : state.steps.filter((s) => s.unavailable).map((s) => plan(state.recipe.key, state.answers).notes[plan(state.recipe.key, state.answers).unavailable.indexOf(s.id)]).filter(Boolean))
    : plan(pending.key, pending.answers).notes);

  /** The tracker's list: each step with its state in words, and the step at hand with how its run went. */
  function trackList(list, rows, notes) {
    list.replaceChildren();
    for (const [n, s] of rows.entries()) {
      const li = el('li', { className: `track-step is-${s.st}` });
      li.dataset.step = s.id; li.dataset.state = s.st;
      if (s.run && s.run.state !== 'pending') li.dataset.run = s.run.state;
      if (s.st === 'current') li.setAttribute('aria-current', 'step');
      const words = s.run && RUN_WORDS[s.run.state] ? RUN_WORDS[s.run.state](s.run) : '';
      li.append(mark(MARKS[s.st]),
        el('span', { className: 'track-body' },
          el('span', { className: 'track-state', textContent: STATE_WORDS[s.st] }), ' ',
          s.tool ? el('span', { className: 'track-tool', textContent: s.tool }) : null, s.tool ? ': ' : null,
          el('span', { className: 'track-act', textContent: s.title }),
          s.st === 'unavailable' ? el('span', { className: 'track-why', textContent: s.available }) : null,
          words ? el('span', { className: `track-run${['stopped', 'failed'].includes(s.run.state) ? ' warn' : ''}`, textContent: words }) : null,
          n === rows.length - 1 && notes.length ? el('span', { className: 'track-end', textContent: notes.join(' ') }) : null));
      list.append(li);
    }
  }

  // A workflow kept from before is taken up by the version rule (record.js, reconcile()), whose words the tracker shows.
  // Back from Chora (#workflow=<id>), the workflow it names is the one taken up; otherwise the newest,
  // begun or not.
  Promise.all([arrived ? store.load(arrived).then((r) => [r]) : store.list(), arrived ? [] : store.pendings()]).then(([[r], [pd]]) => chain(async () => {
    if (wf || pending) return;
    if (pd && (!r || pd.saved > r.saved)) {
      if (!RECIPES[pd.key]) { await store.dropPending(pd.id); return; }
      try { plan(pd.key, pd.answers); } catch { await store.dropPending(pd.id); return; }
      pending = { id: pd.id, key: pd.key, answers: pd.answers };
      say('Taken up where it was left: chosen before any file.');
      render(false); return;
    }
    if (!r) return;
    const v = reconcile(r, recipeOf(r));
    if (v.action === 'continue') {
      wf = v.state;
      if (wf.status !== r.status) await keep();   // a step the page was closed in is failed, and kept so
      keptHandle = await store.handleFor?.(wf.id) || null;
      for (const ref of madeBy(wf)) await outs.get(ref);   // the steps' files kept in this browser, for the tab
      const s = atStep();
      let main = null;
      try { main = s ? mainInput(wf, s) || (s.op === 'read.columns' ? runner.inputsOf(wf, s.id).files : null) : null; } catch { main = null; }
      const ready = main && main.every((x) => !!heldFor(x)) ? main.map(heldFor) : null;
      if (arrived === wf.id && s?.op === 'place') say([v.words, 'Back from Chora: take the dataset you saved there ("Take the dataset back from Chora"), or choose it in step 1 by hand and say the step is done.'].filter(Boolean).join(' '));
      else if (ready) say([v.words, `Taken up where it was left, with ${names(main)}${fromWhere(wf, s, main)}, kept in this browser: it is chosen in step 1 for you.`].filter(Boolean).join(' '));
      else say([v.words, main ? `Taken up where it was left. Choose ${names(main)} again in step 1 to carry on: the file is checked to be the one the workflow recorded.` : 'Taken up where it was left.'].filter(Boolean).join(' '));
      if (ready) {
        render(false);
        // Chosen for the step once the engine is ready, unless the user has chosen a file meanwhile.
        const ok = await page.ready?.();
        if (ok !== false && !chosenRefs) page.choose(ready);
        return;
      }
    } else changed = { action: v.action, record: r, words: v.words };
    render(false);
  })).catch(() => {});
  // The files chosen are recognised (their format known): what the step at hand offers may change with it.
  const detected = () => chain(async () => { if (wf) render(false); });
  return { open, chosen, began, ended, dropped, keepChanged, detected, baseChanged, id: () => wf?.id || null };
}
