// Methodos: one thin adapter per automatic operation that has landed, over the engine's own calls
// (the same ones src/engine/worker.js makes), and the driver that runs a workflow's automatic steps
// through them. Interactive operations have no adapter: the page does them, and gives the runner
// their result (complete()). Operations not yet available have none either.
//
// An adapter is async ({ inputs, options, host, signal }) => { outputs, report, problem?, partial? }:
//   inputs   the step's hand-offs, references (runner.inputsOf);
//   host     what the front end provides, the page's worker or Node:
//              open(ref)   -> the File the reference names (the adapter checks it is that file);
//              env()       -> { env, finish(failed) }: one run's environment, as NodeHost.env gives
//                             (and runEnv in the worker), finish() taking back a failed run's outputs;
//              file(o)     -> the File of an output the run wrote ({ name, size, path? });
//              lookup      the gazetteer lookup (createLookup), made on the page thread through the
//                          permissions module: only the lookup operation needs it;
//   outputs  references to what the step wrote, of the types its operation gives.
import { detect, readable, DataError } from '../input.js';
import { run } from '../pipeline.js';
import { compare } from '../compare.js';
import { publish } from '../agora/index.js';
import { match, gather } from '../krisis/match.js';
import { apply } from '../krisis/apply.js';
import { runLookup } from '../krisis/lookup.js';
import { serialiseWork } from '../krisis/work.js';
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
  finish(!!problem);
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
  // cancelled keeps what it had (its operation keeps partial results).
  async lookup({ inputs, options, host, signal }) {
    if (!host.lookup) throw new Error('No gazetteer lookup was given: the lookup is made on the page thread, through the permissions module.');
    const subjects = await inputOf(inputs.subjects, host, 'dataset');
    const work = inputs.work ? JSON.parse(await (await filesFor(inputs.work, host))[0].text()) : null;
    const g = await engine(host, null, (env) => gather({ subjects, options: {} }, env));
    if (g.problem) return g;
    const r = await runLookup({ lookup: host.lookup, work, subjects: g.result.subjects, places: g.result.places, options, signal });
    const w = await engine(host, 'work.krisis', async (env) => {
      const o = await env.output(subjects.files[0].name.replace(/\.[^.]+$/, '') + '.krisis.json');
      o.write(serialiseWork(r.work));
      return { report: { counts: {}, errors: 0, items: [] }, outputs: [await o.close()] };
    });
    return { report: g.report, outputs: { work: w.outputs } };
  },
};

/** Which of the three ways of stopping an error is: waiting for the user, a data problem, or an execution failure. */
export function stoppingKind(e) {
  if (e?.name === 'PermissionError') return 'waiting';
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
    r = await adapter({ inputs: runner.inputsOf(state, id), options: step.options, host, signal });
  } catch (e) {
    if (signal?.aborted) return { state: runner.cancel(state, id), report: null };
    const kind = stoppingKind(e);
    if (kind === 'waiting') return { state: runner.waiting(state, id, e.message), report: null };
    if (kind === 'stopped') return { state: runner.stop(state, id, { words: e.message }), report: null };
    return { state: runner.fail(state, id, e), report: null };
  }
  if (signal?.aborted) return { state: runner.cancel(state, id, r.outputs), report: r.report };
  if (r.problem) return { state: runner.stop(state, id, r.problem), report: r.report };
  return { state: runner.complete(state, id, r.outputs), report: r.report };
}

/**
 * Take and run steps until the workflow is no longer between automatic steps: it waits for the
 * user, stops, fails, is cancelled or is completed. Returns the state and each step's report.
 */
export async function drive(state, host, opts = {}) {
  const reports = {};
  let s = state;
  for (;;) {
    if (s.status === 'idle') s = runner.next(s);
    if (s.status !== 'running') return { state: s, reports };
    const id = s.current;
    const r = await runStep(s, host, opts);
    s = r.state;
    if (r.report) reports[id] = r.report;
  }
}
