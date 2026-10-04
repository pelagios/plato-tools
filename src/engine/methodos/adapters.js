// Methodos: one thin adapter per automatic operation that has landed, over the engine's own calls
// (the same ones src/engine/worker.js makes), and the driver that runs a workflow's automatic steps
// through them. Interactive operations are the user's: the page does them, and gives the runner their
// result (complete()), checked where the engine can check it (regionsSettled). One of them, the region
// review, also has an adapter here (REVIEWS), which runs it level by level with a reviewer the host
// gives (a person's decisions on the page; a test's in Node): review() does the step it waits at.
// Operations not yet available have no adapter.
//
// An adapter is async ({ inputs, options, host, signal }) => { outputs, report, problem?, partial? }:
//   inputs   the step's hand-offs, references (runner.inputsOf);
//   partial  what the step kept when it was last cancelled or failed, to begin from (its operation
//            keeps partial results), or undefined;
//   host     what the front end provides, the page's worker or Node:
//              open(ref)   -> the File the reference names (the adapter checks it is that file);
//              env()       -> { env, finish(failed) }: one run's environment, as NodeHost.env gives
//                             (and runEnv in the worker), finish() taking back a failed run's outputs;
//              file(o)     -> the File of an output the run wrote ({ name, size, path? });
//              lookup      the gazetteer lookup (createLookup), made on the page thread through the
//                          permissions module: only the lookup operation needs it;
//   outputs  references to what the step wrote, of the types its operation gives.
// An adapter that fails after doing part of its work throws an error with `partial` (references, of
// the types its operation gives), which the runner keeps only if the operation keeps partial results.
import { detect, readable, DataError } from '../input.js';
import { run } from '../pipeline.js';
import { compare } from '../compare.js';
import { publish } from '../agora/index.js';
import { match, gather } from '../krisis/match.js';
import { apply } from '../krisis/apply.js';
import { runLookup, runLevel, runPlaces, newWork } from '../krisis/lookup.js';
import { readWork, serialiseWork } from '../krisis/work.js';
import { seedRegions, levelsOf, regionNodes, regionProgress } from '../krisis/regions.js';
import { exportCandidates, serialiseCandidateSet } from '../krisis/candidates.js';
import { relateProblem, datasetAddress, containment } from './containment.js';
import { OPERATIONS } from './operations.js';
import { HandoffError, refsOf, refsDiffer } from './handoffs.js';
import * as runner from './runner.js';

/** The files a hand-off names, each checked to be the file named (by size and SHA-256), or refused in words. */
export async function filesFor(refs, host) {
  const files = await Promise.all(refs.map((r) => host.open(r)));
  const differ = [...new Set(await refsDiffer(refs, files))];
  if (differ.length) throw new HandoffError(`${differ.join(', ')}: not the file${differ.length === 1 ? '' : 's'} the workflow recorded (the size or SHA-256 differs), so nothing was run. Choose the file the workflow made, or do the step that made it again.`);
  return files;
}

/** The files a hand-off names, as the engine's description of them (detect()); a file it does not read is a data problem. */
async function inputOf(refs, host, what) {
  const input = await detect(await filesFor(refs, host));
  if (!readable(input)) throw new DataError(`The ${what} was not recognised as data these tools read: ${input.reason}`);
  return input;
}

/** The saved column mapping (a JSON file), for the run's `columns` option. */
async function columnsOf(refs, host) {
  if (!refs) return undefined;
  const [f] = await filesFor(refs, host);
  try { return JSON.parse(await f.text()); } catch (e) { throw new DataError(`${f.name} is not a column mapping: ${e.message}`); }
}

/** One engine call in one run environment: the outputs it wrote, as references of `type`, or the problem it found. */
async function engine(host, type, call) {
  const { env, finish } = host.env();
  let r;
  try { r = await call(env); } catch (e) { finish(true); throw e; }
  const problem = problemOf(r);
  // As the page and the command line do: a run that did not finish leaves nothing; one that finished
  // with errors in its report keeps what it wrote, but the step stops, and its outputs are not handed on.
  finish(!!r?.incomplete);
  if (problem) return { report: r.report, problem };
  const outputs = type ? await refsOf(await Promise.all(r.outputs.map((o) => host.file(o))), type) : [];
  return { report: r.report, outputs, result: r };
}

/** What to put right, from a report with errors or a run that did not finish; none if it is clean. */
export function problemOf(r) {
  const errors = r?.report?.errors || 0;
  if (!errors && !r?.incomplete) return null;
  const items = (r.report?.items || []).filter((i) => i.severity === 'error');
  const words = items.slice(0, 3).map((i) => i.message).join(' ') || 'The data could not be read to the end, so nothing was written.';
  return { words, errors };
}

const without = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
/** One of Agora's parts: its one output, of the type the operation gives. */
const part = (name) => async ({ inputs, options, host }) => {
  const [[slot, type]] = Object.entries(OPERATIONS[`publish.${name}`].gives);
  const input = await inputOf(inputs.dataset, host, 'dataset');
  const previous = inputs.previous ? await inputOf(inputs.previous, host, 'previous release') : undefined;
  const r = await engine(host, type, (env) => publish({ part: name, input, previous, options }, env));
  return r.problem ? r : { report: r.report, outputs: { [slot]: r.outputs } };
};

// ---- the region review (Krisis, level by level), and what records it (PLATO #23, option B) ----------
/** The work file as a file of the run: `<subjects' stem>.krisis.json`, its reference of type work.krisis. */
async function workFile(host, subjects, work) {
  const w = await engine(host, 'work.krisis', async (env) => {
    const o = await env.output(subjects.files[0].name.replace(/\.[^.]+$/, '') + '.krisis.json');
    o.write(serialiseWork(work));
    return { report: { counts: {}, errors: 0, items: [] }, outputs: [await o.close()] };
  });
  return w.outputs;
}
/** A lookup that stopped short of the end other than by the user: a permission waits for the user; anything else is a fault, kept as `partial`. */
async function stoppedShort(st, host, subjects, work) {
  if (st.kind === 'permission') throw Object.assign(new Error(`The gazetteer was not asked: ${st.refused === 'never' ? 'it is set to Never' : 'it is not allowed yet'} in the Permissions panel.`), { name: 'PermissionError', kind: st.refused });
  const partial = await workFile(host, subjects, work);
  throw Object.assign(new Error(`The lookup stopped part-way: ${st.message || `the gazetteer's answers could not be used (${st.kind})`}.`), partial ? { partial: { work: partial } } : {});
}

/**
 * The interactive steps that can be run here too, given a reviewer: the region review, level by level.
 * `reviewer({ work, level, nodes, again })` is awaited once for each level, widest first, once that
 * level has been looked up (each region within the match of the region above it, lookup.js runLevel):
 * it decides on the regions' candidates (regions.js decideRegion, settleRegion), and may look a level
 * up again (`again({ relax, only })`). A level left with a region open stops the step, keeping the work
 * file so far as its partial result; the level below is never looked up before the one above is settled.
 */
export const REVIEWS = {
  async 'lookup.levels'({ inputs, options, host, signal, partial, reviewer }) {
    if (!host.lookup) throw new Error('No gazetteer lookup was given: the lookup is made on the page thread, through the permissions module.');
    if (typeof reviewer !== 'function') throw new Error('The region review is the reviewer\'s: no reviewer was given to decide on the regions.');
    const subjects = await inputOf(inputs.subjects, host, 'dataset');
    const g = await engine(host, null, (env) => gather({ subjects, options: {} }, env));
    if (g.problem) return g;
    if (!g.result.regions?.length) throw new DataError('The dataset gives no regions its places lie in: its table was converted without "within" columns, or without a base address, so there is nothing to identify level by level.');
    let work = partial?.work ? readWork(await (await filesFor(partial.work, host))[0].text()) : newWork(g.result.subjects, { reviewer: options.reviewer ?? null });
    seedRegions(work, g.result);
    const how = { lookup: host.lookup, signal, options: options.lookup || {}, reviewer: options.reviewer ?? null };
    for (const level of levelsOf(work)) {
      const r = await runLevel(work, level, how);
      if (r.stopped && r.stopped.kind !== 'stopped') await stoppedShort(r.stopped, host, subjects, work);
      // Cancelled: what was done is kept (the operation keeps partial results), and the step is not done.
      if (signal?.aborted) throw Object.assign(new Error('The region review was cancelled.'), { name: 'AbortError', partial: { work: await workFile(host, subjects, work) } });
      await reviewer({ work, level, nodes: regionNodes(work).filter((n) => n.level === level), again: (o = {}) => runLevel(work, level, { ...how, ...o }) });
      const open = regionNodes(work).filter((n) => n.level === level && n.state !== 'settled');
      if (open.length) {
        const kept = await workFile(host, subjects, work);
        throw Object.assign(new DataError(`${open.length} ${open.length === 1 ? 'region' : 'regions'} of level ${level} ${open.length === 1 ? 'is' : 'are'} not settled (${open.map((n) => n.label).join(', ')}): the regions below are looked up only within a settled level.`), { partial: { work: kept } });
      }
    }
    return { report: { counts: { regions: regionProgress(work).total }, errors: 0, items: [] }, outputs: { work: await workFile(host, subjects, work) } };
  },
};

/**
 * Do the interactive step the workflow waits at, through its entry in REVIEWS, with the reviewer
 * given, and complete it: returns { state, report }, and `error` when it was not done (the step then
 * failed or was cancelled, keeping its partial work). A step with no entry is the page's alone.
 */
export async function review(state, host, { reviewer, signal, reviews = REVIEWS } = {}) {
  const id = state.current;
  const step = state.steps.find((s) => s.id === id);
  if (state.status !== 'waiting' || !step || OPERATIONS[step.op].kind !== 'interactive') throw new runner.TransitionError(`No step is waiting for the user (the workflow is ${state.status}).`);
  const fn = reviews[step.op];
  if (!fn) throw new runner.TransitionError(`${OPERATIONS[step.op].title} is done on the page, not here.`);
  let r;
  // As runStep: cancelled, the step keeps what it had done; otherwise (a level left open, a permission not
  // given, a fault) it is not done, and keeps its partial work to begin from (an interactive step waits,
  // and the runner has no "stopped" from waiting: it fails, in the error's words). `error` is the error.
  try { r = await fn({ inputs: runner.inputsOf(state, id), options: step.options || {}, host, signal, reviewer, partial: step.partial }); }
  catch (e) {
    if (signal?.aborted) return { state: runner.cancel(state, id, e?.partial), report: null };
    return { state: runner.fail(state, id, e, e?.partial), report: null, error: e };
  }
  if (r.problem) return { state: runner.fail(state, id, new DataError(r.problem.words)), report: r.report, error: new DataError(r.problem.words) };
  return { state: runner.complete(state, id, r.outputs), report: r.report };
}

export const ADAPTERS = {
  async detect({ inputs, host }) {
    const input = await inputOf(inputs.files, host, 'file');
    return { outputs: {}, report: { counts: { format: input.format }, errors: 0, items: [] } };
  },
  async check({ inputs, host }) {
    const input = await inputOf(inputs.files, host, 'file');
    const columns = await columnsOf(inputs.mapping, host);
    const r = await engine(host, null, (env) => run({ input, action: 'check', options: { ...(columns ? { columns } : {}) } }, env));
    return r.problem ? r : { report: r.report, outputs: {} };
  },
  async convert({ inputs, options, host }) {
    const input = await inputOf(inputs.files, host, 'file');
    const columns = await columnsOf(inputs.mapping, host);
    const r = await engine(host, 'dataset', (env) => run({ input, action: 'convert', target: options.target, options: { ...without(options, 'target'), ...(columns ? { columns } : {}) } }, env));
    return r.problem ? r : { report: r.report, outputs: { dataset: r.outputs } };
  },
  async compare({ inputs, host }) {
    const earlier = await inputOf(inputs.earlier, host, 'earlier version'), later = await inputOf(inputs.later, host, 'later version');
    const r = await engine(host, null, (env) => compare({ earlier, later }, env));
    return r.problem ? r : { report: r.report, outputs: {} };
  },
  'publish.report': part('report'),
  'publish.mint': part('mint'),
  'publish.site': part('site'),
  'publish.w3id': part('w3id'),
  async match({ inputs, options, host }) {
    const subjects = await inputOf(inputs.subjects, host, 'dataset'), others = await inputOf(inputs.others, host, 'other dataset');
    const r = await engine(host, 'work.krisis', (env) => match({ subjects, others, options }, env));
    return r.problem ? r : { report: r.report, outputs: { work: r.outputs } };
  },
  async apply({ inputs, options, host }) {
    const subjects = await inputOf(inputs.subjects, host, 'dataset');
    const [work] = await filesFor(inputs.work, host);
    const r = await engine(host, 'dataset', async (env) => apply({ subjects, work: await work.text(), options: { ...options, output: 'dataset' } }, env));
    return r.problem ? r : { report: r.report, outputs: { dataset: r.outputs } };
  },
  // The lookup is made on the page thread, through the permissions module (host.lookup); the places
  // are gathered by the engine, as the worker's 'places' command gathers them. Its work file is written
  // however far it got: queries not answered are left pending in it, as on the page, and a lookup
  // cancelled keeps what it had (its operation keeps partial results). So does a lookup the service
  // stopped part-way (its quota spent, or a refusal): the answers received are kept as the step's
  // partial result, and the lookup done again begins from them and asks only for the places not yet
  // answered, so that no query is spent twice.
  async lookup({ inputs, options, host, signal, partial }) {
    if (!host.lookup) throw new Error('No gazetteer lookup was given: the lookup is made on the page thread, through the permissions module.');
    const subjects = await inputOf(inputs.subjects, host, 'dataset');
    const from = partial?.work || inputs.work;
    const work = from ? readWork(await (await filesFor(from, host))[0].text()) : null;
    const g = await engine(host, null, (env) => gather({ subjects, options: {} }, env));
    if (g.problem) return g;
    // After the region review (its work file handed on), the places are looked up within their regions,
    // each constrained by the nearest matched region above it (runPlaces), as the page's "Look up the
    // places" in the review does; else as any lookup.
    const within = !!work && Object.keys(work.regions || {}).length > 0;
    const r = within ? await runPlaces(work, { lookup: host.lookup, places: g.result.places, options: without(options, 'places'), signal })
      : await runLookup({ lookup: host.lookup, work, subjects: g.result.subjects, places: g.result.places, options: partial?.work ? { ...options, places: 'pending' } : options, signal });
    // Stopped short of the end other than by the user: a permission to decide is waiting for the
    // user; anything else (the service refusing, failing, or answering what cannot be right) is a fault.
    const st = r.stopped;
    if (st && st.kind !== 'stopped') await stoppedShort(st, host, subjects, r.work);
    return { report: g.report, outputs: { work: await workFile(host, subjects, r.work) } };
  },
  // PLATO #23, option B. The source's half, each place ContainedIn the region minted from its row, is
  // Hermes's, written when the table was converted; it is checked here, never written again. The
  // reviewer's half: the review's candidates are exported as a candidate set (written beside the
  // dataset), so that each identity, a place's and each matched region's IdentityRelation to the
  // authority's record, points at the candidate it answers (promotedFrom); then the decisions are
  // applied. A review whose regions have no address of their own is refused in words. The candidate
  // set is made for the dataset's own address, else the base address the table was converted under.
  async 'relate.containment'({ inputs, options, host }) {
    const subjects = await inputOf(inputs.subjects, host, 'dataset');
    const [wf] = await filesFor(inputs.work, host);
    let work = readWork(await wf.text());
    const problem = relateProblem(work, { exported: false });
    if (problem) throw new DataError(problem);
    if (!work.subjects.uri) {
      const uri = datasetAddress(options.base);
      if (!uri) throw new DataError('The dataset has no address of its own, and no base address was given, so its candidates cannot be exported for it: give the base address the table was converted under.');
      Object.assign(work.subjects, { uri, uriFrom: 'base' });
    }
    const x = exportCandidates(work, { ...(options.issued ? { issued: options.issued } : {}) });
    work = x.work;
    const after = relateProblem(work);
    if (after) throw new Error(`The candidates were exported and still: ${after}`);
    const stem = subjects.files[0].name.replace(/\.[^.]+$/, '');
    const r = await engine(host, 'dataset', async (env) => {
      const a = await apply({ subjects, work: serialiseWork(work), options: { ...without(options, 'issued'), output: 'dataset' } }, env);
      if (a.incomplete || a.report?.errors) return a;
      if (x.set) { const o = await env.output(`${stem}.candidates.json`); o.write(serialiseCandidateSet(x.set)); await o.close(); }
      return a;
    });
    if (r.problem) return r;
    const [doc] = await Promise.all(r.outputs.map(async (ref) => JSON.parse(await (await host.open(ref)).text())));
    const found = containment(doc, work);
    // Every place the review has within a region must still be ContainedIn one, and every matched region must have its identity, promotedFrom its candidate.
    const placesWithin = Object.values(work.places).filter((p) => typeof p.within === 'string').length;
    if (found.containedIn < placesWithin) throw new DataError(`${placesWithin - found.containedIn} of the ${placesWithin} places in regions are not ContainedIn their region in the dataset: the table was converted without the regions it gives (Hermes writes them under a base address).`);
    if (found.missing.length) throw new Error(`${found.missing.length} matched ${found.missing.length === 1 ? 'region has' : 'regions have'} no identity naming the candidate it answers, which is a fault in the tools.`);
    return { report: { ...r.report, counts: { ...(r.report?.counts || {}), containment: found, candidateSet: x.setIri } }, outputs: { dataset: r.outputs } };
  },
};

/** Which of the three ways of stopping an error is: waiting for the user, a data problem, or an execution failure. */
// A permission the user has still to decide, has set to Never (the step may be done without), or has
// allowed in a way that needs the page reloaded, waits for the user; any other refusal (an insecure or
// unknown address, a network failure, a redirect) is a fault.
export const WAITING_PERMISSIONS = ['undecided', 'never', 'reload'];
export function stoppingKind(e) {
  if (e?.name === 'PermissionError') return WAITING_PERMISSIONS.includes(e.kind) ? 'waiting' : 'failed';
  if (e instanceof DataError || e instanceof HandoffError) return 'stopped';
  return 'failed';
}

/**
 * Run the step the workflow is at (it must be running) through its adapter, and return the new state
 * and the step's report (for the page to show; it is not kept in the state). Cancelled through
 * `signal`: the step is cancelled, keeping what it had done only where its operation says so.
 */
export async function runStep(state, host, { signal, adapters = ADAPTERS } = {}) {
  const id = state.current;
  const step = state.steps.find((s) => s.id === id);
  if (state.status !== 'running' || !step) throw new runner.TransitionError(`No step is running (the workflow is ${state.status}).`);
  const adapter = adapters[step.op];
  if (!adapter) return { state: runner.fail(state, id, `${OPERATIONS[step.op].title} has no adapter: it is not run by the tools.`), report: null };
  let r;
  try {
    r = await adapter({ inputs: runner.inputsOf(state, id), options: step.options, host, signal, partial: step.partial });
  } catch (e) {
    if (signal?.aborted) return { state: runner.cancel(state, id), report: null };
    const kind = stoppingKind(e);
    if (kind === 'waiting') return { state: runner.waiting(state, id, e.message), report: null };
    if (kind === 'stopped') return { state: runner.stop(state, id, { words: e.message }), report: null };
    return { state: runner.fail(state, id, e, e?.partial), report: null };
  }
  if (signal?.aborted) return { state: runner.cancel(state, id, r.outputs), report: r.report };
  if (r.problem) return { state: runner.stop(state, id, r.problem), report: r.report };
  return { state: runner.complete(state, id, r.outputs), report: r.report };
}

/**
 * Take and run steps until the workflow is no longer between automatic steps: it waits for the
 * user, stops, fails, is cancelled or is completed. Returns the state and each step's report.
 * `opts.atBoundary(state)`, if given, is awaited at every step boundary (a step done, and where the
 * run ends), so that the workflow's record can be saved there (src/methodos/store.js).
 */
export async function drive(state, host, opts = {}) {
  const reports = {};
  let s = state;
  for (;;) {
    if (s.status === 'idle') s = runner.next(s);
    if (s.status !== 'running') { await opts.atBoundary?.(s); return { state: s, reports }; }
    const id = s.current;
    const r = await runStep(s, host, opts);
    s = r.state;
    if (r.report) reports[id] = r.report;
    if (s.status === 'idle') await opts.atBoundary?.(s);
  }
}
