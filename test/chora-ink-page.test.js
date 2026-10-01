// Tracing with assistance, the page's side (src/chora/inkkeys.js, src/chora/inkjobs.js): which keys accept
// or let go of a proposal, and the worker's jobs (cancelled, failed, replaced, asked how many tiles it holds).
// No browser: elements and the worker are stand-ins with only what the modules read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyAction } from '../src/chora/inkkeys.js';
import { createJobs, WORKER_FAILED } from '../src/chora/inkjobs.js';
import { inkProposedText } from '../src/engine/words.js';

// ---- Keys ----------------------------------------------------------------------------------------

/** A stand-in element: tagName, attributes, a parent, an input's type, contenteditable. */
function el(tag, { parent = null, attrs = {}, type, editable = false } = {}) {
  return {
    nodeType: 1, tagName: tag.toUpperCase(), parentElement: parent, type, isContentEditable: editable,
    getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs,
  };
}
const html = el('html'), body = el('body', { parent: html });
const mapContainer = el('div', { parent: body, attrs: { id: 'map' } });
const canvas = el('canvas', { parent: el('div', { parent: mapContainer }), attrs: { tabindex: '0' } });
const panel = el('div', { parent: body, attrs: { id: 'ink-panel' } });
const panelText = el('p', { parent: panel });
const acceptButton = el('button', { parent: el('p', { parent: panel }) });
const slider = el('input', { parent: el('label', { parent: panel }), type: 'range' });
const saveButton = el('button', { parent: body, attrs: { id: 'save' } });
const link = el('a', { parent: body, attrs: { href: '#' } });
const select = el('select', { parent: body });
const summary = el('summary', { parent: el('details', { parent: body }) });
const dialog = el('dialog', { parent: body, attrs: { open: '' } });
const inDialog = el('input', { parent: el('fieldset', { parent: dialog }), type: 'radio' });
const dialogHeading = el('h2', { parent: dialog, attrs: { tabindex: '-1' } });
const ariaDialog = el('div', { parent: body, attrs: { role: 'dialog' } });
const inAriaDialog = el('span', { parent: ariaDialog });
const elsewhere = el('div', { parent: body, attrs: { tabindex: '0', id: 'card' } });
const textBox = el('input', { parent: body, type: 'text' });
const editable = el('div', { parent: body, attrs: { contenteditable: 'true' }, editable: true });

const live = { panel, mapContainer, mode: 'area', proposal: true, proposed: true };
const key = (k, target, opts = live) => keyAction({ key: k, target }, opts);
const ACCEPT = { action: 'accept', prevent: true };
const NONE = { action: null, prevent: false };

test('ink keys: Enter accepts a proposal from the map, the page itself, and the panel\'s own text (the positive control)', () => {
  for (const [name, t] of [['canvas', canvas], ['map container', mapContainer], ['body', body], ['html', html], ['panel text', panelText], ['the document', { nodeType: 9 }], ['no target', null]]) {
    assert.deepEqual(key('Enter', t), ACCEPT, name);
  }
});

test('ink keys: Enter on any control, anywhere (the panel\'s own included), or inside a dialog, is the control\'s and accepts nothing', () => {
  for (const [name, t] of [['Save', saveButton], ['a link', link], ['a select', select], ['a summary', summary], ['the Accept button', acceptButton],
    ['a slider', slider], ['a radio in the Permissions dialog', inDialog], ['the dialog\'s heading', dialogHeading], ['the dialog', dialog],
    ['inside a role=dialog', inAriaDialog], ['a text box', textBox], ['contenteditable', editable], ['a focusable card elsewhere', elsewhere]]) {
    assert.deepEqual(key('Enter', t), NONE, name);
  }
  // A modal dialog open, the focus on the page: still not the proposal's.
  assert.deepEqual(key('Enter', body, { ...live, dialogOpen: true }), NONE);
});

test('ink keys: Enter accepts only a proposal that has been proposed; nothing at all without a mode or a proposal', () => {
  assert.deepEqual(key('Enter', canvas), ACCEPT);   // the control
  assert.deepEqual(key('Enter', canvas, { ...live, proposed: false }), NONE);
  assert.deepEqual(key('Enter', canvas, { ...live, mode: null, proposal: false, proposed: false }), NONE);
  assert.deepEqual(key('Escape', canvas, { ...live, mode: null, proposal: false, proposed: false }), NONE);
  assert.deepEqual(key('a', canvas), NONE);
});

test('ink keys: Esc lets the proposal go (its default prevented) except inside a dialog, where it is the dialog\'s to close', () => {
  assert.deepEqual(key('Escape', canvas), { action: 'discard', prevent: true });
  assert.deepEqual(key('Escape', saveButton), { action: 'discard', prevent: true });
  for (const [name, t] of [['a radio in the Permissions dialog', inDialog], ['the dialog\'s heading', dialogHeading], ['the dialog', dialog], ['inside a role=dialog', inAriaDialog]]) {
    assert.deepEqual(key('Escape', t), NONE, name);
  }
  assert.deepEqual(key('Escape', body, { ...live, dialogOpen: true }), NONE);
  // No proposal (a mode alone): let go of whatever is under way, its default left alone.
  assert.deepEqual(key('Escape', canvas, { ...live, proposal: false, proposed: false }), { action: 'discard', prevent: false });
  // Typing: not ours.
  assert.deepEqual(key('Escape', textBox), NONE);
});

// ---- The worker's jobs -------------------------------------------------------------------------

/** A stand-in Worker: records what it is sent; `reply(m)` answers as the worker would, `fail()` errors. */
function fakeWorkers() {
  const made = [];
  const makeWorker = () => {
    const w = { sent: [], terminated: false, onmessage: null, onerror: null };
    w.postMessage = (m, transfer) => w.sent.push({ m, transfer });
    w.terminate = () => { w.terminated = true; };
    w.reply = (m) => w.onmessage({ data: m });
    w.fail = (message = 'Uncaught TypeError: x is undefined') => w.onerror({ message, preventDefault() {} });
    made.push(w);
    return w;
  };
  return { made, makeWorker };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const ENTRY = { key: 'k1' };

test('ink jobs: a step is sent to one worker and resolved by its result; a need is fetched and its tiles handed over', async () => {
  const { made, makeWorker } = fakeWorkers();
  const needs = [];
  const jobs = createJobs({ makeWorker, onNeed: async (m, entry) => { needs.push([m.urls, entry]); return [{ url: m.urls[0], bitmap: 'B' }]; } });
  const gen = jobs.newGen('trace');
  const p = jobs.step('trace', gen, ENTRY)({ frame: 1 });
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].sent.at(-1).m, { type: 'trace', channel: 'trace', gen, frame: 1 });
  made[0].reply({ type: 'need', channel: 'trace', gen, urls: ['u1'] });
  await flush();
  assert.deepEqual(needs, [[['u1'], ENTRY]]);
  assert.deepEqual(made[0].sent.at(-1), { m: { type: 'tiles', channel: 'trace', gen, tiles: [{ url: 'u1', bitmap: 'B' }] }, transfer: ['B'] });
  made[0].reply({ type: 'result', channel: 'trace', gen, result: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 });
  // A second job goes to the same worker.
  const g2 = jobs.newGen('trace'); jobs.step('trace', g2, ENTRY)({});
  assert.equal(made.length, 1);
});

test('ink jobs: a new generation on one channel cancels that channel\'s job alone (a snap build let go while it is being made)', async () => {
  const { made, makeWorker } = fakeWorkers();
  const jobs = createJobs({ makeWorker, onNeed: async () => [] });
  const s = jobs.newGen('snap'), t = jobs.newGen('trace');
  const snap = jobs.step('snap', s, ENTRY)({}), trace = jobs.step('trace', t, ENTRY)({});
  const s2 = jobs.newGen('snap');
  await assert.rejects(snap, (e) => e.kind === 'cancelled');
  assert.ok(!jobs.current('snap', s) && jobs.current('snap', s2) && jobs.current('trace', t));
  assert.deepEqual(made[0].sent.at(-1).m, { type: 'cancel', channel: 'snap', gen: s2 });
  made[0].reply({ type: 'result', channel: 'trace', gen: t, result: 'still here' });
  assert.equal(await trace, 'still here');
  // A step asked for an old generation is refused without being sent.
  const before = made[0].sent.length;
  await assert.rejects(jobs.step('snap', s, ENTRY)({}), (e) => e.kind === 'cancelled');
  assert.equal(made[0].sent.length, before);
});

test('ink jobs: a worker that errors is terminated and replaced; what it had pending is refused in plain words', async () => {
  const { made, makeWorker } = fakeWorkers();
  const jobs = createJobs({ makeWorker, onNeed: async () => [] });
  const g = jobs.newGen('trace');
  const p = jobs.step('trace', g, ENTRY)({});
  made[0].fail();
  await assert.rejects(p, (e) => e.message === WORKER_FAILED && !/TypeError/.test(e.message));
  assert.equal(made[0].terminated, true);
  // The next job starts a fresh worker, which works.
  const g2 = jobs.newGen('trace');
  const q = jobs.step('trace', g2, ENTRY)({});
  assert.equal(made.length, 2);
  made[1].reply({ type: 'result', channel: 'trace', gen: g2, result: 'fresh' });
  assert.equal(await q, 'fresh');
  // The old worker, should it speak again, is not listened to.
  const g3 = jobs.newGen('trace'); const r = jobs.step('trace', g3, ENTRY)({});
  made[0].reply({ type: 'result', channel: 'trace', gen: g3, result: 'stale' });
  made[1].reply({ type: 'result', channel: 'trace', gen: g3, result: 'right' });
  assert.equal(await r, 'right');
});

test('ink jobs: forget is passed to the worker, and the worker is asked how many tiles it holds (none without a worker)', async () => {
  const { made, makeWorker } = fakeWorkers();
  const jobs = createJobs({ makeWorker, onNeed: async () => [] });
  assert.equal(await jobs.workerTiles(), 0);
  assert.equal(made.length, 0, 'asking does not start a worker');
  jobs.step('trace', jobs.newGen('trace'), ENTRY)({});
  const c = jobs.workerTiles();
  const ask = made[0].sent.at(-1).m;
  assert.equal(ask.type, 'count');
  made[0].reply({ type: 'count', id: ask.id, tiles: 7 });
  assert.equal(await c, 7);
  jobs.forget('https://a.example');
  assert.deepEqual(made[0].sent.at(-1).m, { type: 'forget', origin: 'https://a.example' });
});

// ---- What a proposal is said to be --------------------------------------------------------------

test('ink status: a line stopped at a fork it could not judge says so, and how to carry it on; one that ran to its ends does not', () => {
  const plain = inkProposedText({ mode: 'line', scale: 2, gaps: 1, ends: ['end', 'turn'] });
  assert.equal(plain, 'A line proposed (dashed orange), read at 1/2 of full resolution, 1 gap jumped (dotted). Enter accepts it, Esc lets it go; Shift-click carries the line on.');
  const one = inkProposedText({ mode: 'line', scale: 1, ends: ['end', 'fork'] });
  assert.equal(one, 'A line proposed (dashed orange), read at 1/1 of full resolution. It stopped short of a fork it could not judge (two ways on, alike): Shift-click the way the line goes to carry it on. Enter accepts it, Esc lets it go.');
  assert.match(inkProposedText({ mode: 'line', scale: 1, ends: ['fork', 'fork'] }), /stopped short of two forks it could not judge/);
  // An area has no ends; and no ends known (an older worker's result) says nothing of forks.
  assert.equal(inkProposedText({ mode: 'area', scale: 4, holes: 2, ends: ['fork', 'fork'] }), 'An area proposed (dashed orange), read at 1/4 of full resolution, with 2 holes. Enter accepts it, Esc lets it go.');
  assert.doesNotMatch(inkProposedText({ mode: 'line', scale: 1, ends: null }), /fork/);
});
