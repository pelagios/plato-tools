// Methodos on the page: the interview, and the tracker that keeps the user's place in the workflow
// it chooses (docs/plans/methodos.md, sections 3 and 4.4, and phase 3 of section 9). Two
// self-contained components, each mounted on an element the host gives it, so that where they sit on
// the page can change without changing them; the host (src/app.js) is told the step the workflow is
// at through onStep, and narrows step 2 to that step's tool (#tool=) and says the step in #for-tool.
// A visitor who never opens Methodos sees the page as it was: nothing here runs until they do, bar
// reading the store for a workflow kept from before.
import { HAVE, WANT, choose, questionsFor, answersFor, answered, plan, feedbackUrl } from '../engine/methodos/interview.js';
import { OPERATIONS } from '../engine/methodos/operations.js';
import { RECIPES } from '../engine/methodos/recipes/index.js';

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
 * open or a workflow is followed; `interview` and `tracker` are the two components' elements (index.html); `store`
 * is the save-and-resume interface (src/methodos/page-store.js); `onStep(step)` is told each step the
 * workflow comes to, as { tool, text, link } (tool: a #tool= key or null), and null when it is left.
 * Returns { open() }, which opens the interview.
 */
export function mountMethodos({ banner, interview, tracker, store, onStep, tools }) {
  const q = (root, sel) => root.querySelector(sel);
  const have = q(interview, '#mq-have'), want = q(interview, '#mq-want'), more = q(interview, '#mq-more');
  const verdict = q(interview, '#methodos-verdict'), planEl = q(interview, '#methodos-plan');
  const startB = q(interview, '#methodos-start'), gridB = q(interview, '#methodos-grid'), heading = q(interview, 'h2');
  const yesNo = {};
  let choice = null, record = null;

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
    if (!answered(choice, yesNo)) { verdict.textContent = `This leads to the workflow “${recipe.title}”. Answer the questions under 3 to see its steps.`; return; }
    const p = plan(choice.recipe, answersFor(choice, yesNo));
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
    if (t.name?.startsWith('methodos-ask-')) yesNo[t.name.slice(13)] = t.value === 'yes';
    else {
      const was = choice && choice.kind === 'recipe' ? choice.recipe : null;
      choice = choose(picked('methodos-have'), picked('methodos-want'));
      if (choice?.kind === 'recipe' && choice.recipe !== was) for (const k of Object.keys(yesNo)) if (!choice.ask.includes(k)) delete yesNo[k];
      askMore();
    }
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
    const p = plan(recipe.key, answersFor(choice, yesNo));
    record = { id: `${recipe.key}-${Date.now().toString(36)}`, methodos: 1, recipe: { key: recipe.key, version: recipe.version, digest: recipe.digest }, answers: answersFor(choice, yesNo), at: runs(p)[0].id, done: [] };
    await store.save(record);
    close(false);
    track(true);
  });

  const bannerNow = () => { banner.hidden = !interview.hidden || !!record; };
  const backTo = () => (banner.hidden ? document.querySelector('#methodos-card') : banner.querySelector('a'))?.focus();
  let opener = null;
  function open() {
    opener = document.activeElement !== document.body ? document.activeElement : null;
    interview.hidden = false; bannerNow();
    if (!choice) verdictNow();
    show(heading);
  }
  function close(refocus) {
    interview.hidden = true; bannerNow();
    if (refocus) { if (opener?.isConnected && opener.offsetParent && !interview.contains(opener)) opener.focus(); else backTo(); }
  }

  // ---- The tracker: the workflow's steps, done, now, and to come, above step 1.
  const tList = q(tracker, '#methodos-track'), tTitle = q(tracker, '#methodos-tracker-title'), tWhere = q(tracker, '#methodos-tracker-where');
  const tSaid = q(tracker, '#methodos-said'), doneB = q(tracker, '#methodos-done'), backB = q(tracker, '#methodos-back');
  const planOf = (r) => plan(r.recipe.key, r.answers);

  function track(focus) {
    bannerNow();
    if (!record) { tracker.hidden = true; onStep(null); return; }
    const p = planOf(record);
    tracker.hidden = false;
    tracker.dataset.recipe = p.key;
    tTitle.textContent = p.title;
    stepList(tList, p.steps, record.at, record.done, p.notes);
    const steps = runs(p);
    const i = steps.findIndex((s) => s.id === record.at);
    const s = steps[i];
    const where = s ? `Step ${i + 1} of ${steps.length}: ${s.tool ? `${s.tool}, ` : ''}${lower(s.title)}.` : `Every one of the ${steps.length} steps is done.${p.notes.length ? ` ${p.notes.join(' ')}` : ''}`;
    tWhere.textContent = where;
    tSaid.textContent = where;
    doneB.hidden = !s; backB.disabled = !record.done.length;
    if (s) {
      const op = OPERATIONS[s.op];
      const how = op.kind === 'interactive' && op.waitsFor ? ` This step is yours: it waits for ${op.waitsFor}.` : '';
      onStep({ tool: PAGE_TOOL[s.op] ?? null, text: `Methodos, ${p.title}, step ${i + 1} of ${steps.length}: ${s.tool ? `${s.tool}, ` : ''}${lower(s.title)}.${how}`,
        link: s.op === 'place' ? { href: './chora.html', words: 'Open Chora' } : null });
    } else onStep(null);
    if (focus) show(q(tracker, 'h2'));
  }
  doneB.addEventListener('click', async () => {
    const steps = runs(planOf(record));
    const i = steps.findIndex((s) => s.id === record.at);
    record = { ...record, done: [...record.done, record.at], at: steps[i + 1]?.id ?? null };
    await store.save(record); track(false);
    if (!record.at) q(tracker, '#methodos-leave').focus();
  });
  backB.addEventListener('click', async () => {
    if (!record.done.length) return;
    const done = record.done.slice(0, -1);
    record = { ...record, done, at: record.done.at(-1) };
    await store.save(record); track(false);
    if (backB.disabled) doneB.focus();
  });
  q(tracker, '#methodos-leave').addEventListener('click', async () => {
    const id = record.id; record = null; await store.remove(id); track(false);
    backTo();
  });

  // A workflow kept from before is taken up where it was left, if its recipe is still the one shipped.
  store.list().then(([r]) => {
    const recipe = r && RECIPES[r.recipe?.key];
    if (recipe && recipe.digest === r.recipe.digest) { record = r; track(false); }
  }).catch(() => {});
  return { open };
}
