// Hermes, place names in a text: what a run may cost and whether the user agreed to it
// (src/engine/hermes/text/consent.js). Pure: no page, no network, no permissions module. The run itself is
// the engine's own (runExtraction), given a provider that can only send what the user agreed to.
//
// Each check that nothing was sent has beside it a send that was: the same provider, agreed to, is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/engine/hermes/text/index.js';

globalThis.fetch = () => { throw new Error('network guard: a test tried to reach the network'); };

const ANTHROPIC = 'https://api.anthropic.com';
const LOCAL = 'http://localhost:11434';
const NOW = new Date('2026-10-20T12:00:00Z');
const parts = (n, size = 8000) => Array.from({ length: n }, (_, i) => ({ index: i, text: 'x'.repeat(size) }));
const SOURCE = { title: 'A test itinerary' };

test('the ceiling is $2 unless changed, and a changed one must be a sum of money: positive, finite, not absurd', () => {
  assert.equal(T.DEFAULT_CEILING_USD, 2);
  assert.deepEqual(T.parseCeiling(3), { ok: true, usd: 3 });
  assert.deepEqual(T.parseCeiling(' $3.50 '), { ok: true, usd: 3.5 });
  assert.deepEqual(T.parseCeiling('0.255'), { ok: true, usd: 0.26 }, 'to the cent');
  for (const bad of [0, -1, '', ' ', 'abc', '1,5', NaN, Infinity, null, undefined, {}, [], '1e9', 100000, '$']) assert.equal(T.parseCeiling(bad).ok, false, String(bad));
  assert.match(T.parseCeiling('abc').why, /sum of money/);
});

test('a run is assessed against the ceiling before anything is sent: over it is blocked, and raising the ceiling lets it through', () => {
  const run = (n, o = {}) => T.assessRun({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: T.estimateRun(parts(n), { effort: 'low' }), now: NOW, ...o });
  const small = run(2), big = run(40);
  assert.equal(small.blocked, null, 'control: a small run is not blocked');
  assert.ok(small.cost.usd.high < T.DEFAULT_CEILING_USD);
  assert.equal(big.blocked, 'over-ceiling');
  assert.ok(big.cost.usd.high > T.DEFAULT_CEILING_USD);
  assert.equal(big.ceilingUsd, 2, 'the default');
  assert.equal(run(40, { ceilingUsd: 100 }).blocked, null, 'raised: not blocked');
  assert.equal(run(40, { ceilingUsd: 100 }).ceilingUsd, 100);
  assert.equal(run(2, { ceilingUsd: 0.01 }).blocked, 'over-ceiling', 'lowered: blocked');
  assert.throws(() => run(2, { ceilingUsd: -1 }), /ceiling/);
});

test('a ceiling that cannot be checked against a price blocks a service elsewhere, and does not bind this computer\'s own', () => {
  const est = T.estimateRun(parts(2));
  const remote = T.assessRun({ provider: 'openai-compatible', model: 'llama3.3:70b', origin: 'https://llm.example.org', estimate: est, now: NOW });
  assert.equal(remote.blocked, 'no-price');
  assert.match(remote.words.join(' '), /ceiling cannot be kept/);
  assert.equal(T.assessRun({ provider: 'anthropic', model: 'claude-sonnet-9-9', origin: ANTHROPIC, estimate: est, now: NOW }).blocked, 'no-price', 'a model the table does not have');
  const stale = T.assessRun({ provider: 'anthropic', model: 'claude-sonnet-5-5', origin: ANTHROPIC, estimate: est, now: new Date('2027-06-01T00:00:00Z') });
  assert.equal(stale.blocked, 'no-price');
  assert.match(stale.words.join(' '), /more than 90 days old/);
  assert.equal(T.assessRun({ provider: 'anthropic', model: 'claude-sonnet-5-5', origin: ANTHROPIC, estimate: est, now: NOW }).blocked, null, 'control: priced and fresh');
  const local = T.assessRun({ provider: 'openai-compatible', model: 'qwen3:0.6b', origin: LOCAL, estimate: est, now: NOW });
  assert.equal(local.blocked, null);
  assert.equal(local.local, true);
});

test('the consent names the service, shows the estimate and the ceiling, and says the provider\'s terms apply to the text', () => {
  const est = T.estimateRun(parts(3), { effort: 'low' });
  const a = T.assessRun({ provider: 'anthropic', model: 'claude-sonnet-5-5', origin: ANTHROPIC, estimate: est, now: NOW });
  const w = T.consentWords({ name: 'Anthropic', origin: ANTHROPIC, estimate: est, assessment: a });
  const text = w.join('\n');
  assert.match(w[0], /Send this text \(24,000 characters, 3 parts\) to Anthropic \(api\.anthropic\.com\)\?/);
  assert.match(text, /About [\d,]+ tokens in and [\d,]+ to [\d,]+ out/, 'the estimate');
  assert.match(text, /about \$0\.\d\d to \$0\.\d\d/, 'in money');
  assert.match(text, /prices as of 2026-10-10/);
  assert.match(text, /most this run may cost is \$2\.00/);
  assert.match(text, /Anthropic’s terms apply to the text/);
  assert.match(text, /these tools do not know/);
  // On this computer it is said not to leave it, and no money is shown.
  const la = T.assessRun({ provider: 'openai-compatible', model: 'm', origin: LOCAL, estimate: est, now: NOW });
  const lt = T.consentWords({ name: 'localhost:11434', origin: LOCAL, estimate: est, assessment: la }).join('\n');
  assert.match(lt, /on this computer/);
  assert.ok(!/\$/.test(lt), 'no money for a server that is this computer\'s');
  // A blocked run says why, and is not asked for.
  const big = T.assessRun({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: T.estimateRun(parts(40), { effort: 'low' }), now: NOW });
  assert.match(T.consentWords({ name: 'Anthropic', origin: ANTHROPIC, estimate: T.estimateRun(parts(40)), assessment: big }).join('\n'), /over the ceiling of \$2\.00/);
});

test('a consent is given only for a run that is not blocked, and records what it was given for', () => {
  const est = T.estimateRun(parts(2), { effort: 'low' });
  const a = T.assessRun({ provider: 'anthropic', model: 'claude-sonnet-5-5', origin: ANTHROPIC, estimate: est, now: NOW });
  const c = T.giveConsent({ provider: 'anthropic', model: 'claude-sonnet-5-5', origin: ANTHROPIC, estimate: est, assessment: a, now: () => '2026-10-20T12:00:00Z' });
  assert.deepEqual({ ...c }, { provider: 'anthropic', model: 'claude-sonnet-5-5', origin: ANTHROPIC, parts: 2, characters: 16000, ceilingUsd: 2, at: '2026-10-20T12:00:00Z' });
  assert.ok(Object.isFrozen(c));
  const big = T.assessRun({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: T.estimateRun(parts(40), { effort: 'low' }), now: NOW });
  assert.throws(() => T.giveConsent({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: est, assessment: big }), { name: 'ConsentError', kind: 'over-ceiling' });
  assert.throws(() => T.giveConsent({ provider: 'anthropic', model: 'claude-sonnet-5-5', origin: ANTHROPIC, estimate: est, assessment: { ...a, blocked: null, origin: LOCAL } }), { name: 'ConsentError', kind: 'mismatch' }, 'an assessment of another service');
});

// A provider that does what an adapter does, with a call count: the presence beside every absence.
function fake({ origin = ANTHROPIC, id = 'anthropic', usage = { input: 2500, output: 300 } } = {}) {
  const p = { id, name: id, origins: [origin], sent: [], estimate: (c) => T.estimateChunk(c, { effort: 'low' }),
    async listModels() { return [{ id: 'claude-fable-5' }]; },
    async extract(chunk) { p.sent.push(chunk.text); return { reply: JSON.stringify({ mentions: [] }), truncated: false, usage, model: 'claude-fable-5', settings: { s: 1 } }; } };
  return p;
}
const consentFor = (n, model, o = {}) => {
  const est = T.estimateRun(parts(n), { effort: 'low' });
  const a = T.assessRun({ provider: 'anthropic', model, origin: ANTHROPIC, estimate: est, now: NOW, ...o });
  return T.giveConsent({ provider: 'anthropic', model, origin: ANTHROPIC, estimate: est, assessment: a });
};

test('a limited provider sends nothing without a consent for this service and model, and sends with one', async () => {
  const chunk = parts(1)[0];
  const p = fake();
  const ok = T.limitProvider(p, consentFor(2, 'claude-fable-5'), { now: NOW });
  assert.deepEqual([ok.id, ok.name, ok.origins, typeof ok.estimate, typeof ok.listModels], ['anthropic', 'anthropic', [ANTHROPIC], 'function', 'function'], 'it is the same provider to the engine');
  await ok.extract(chunk, { model: 'claude-fable-5' });
  assert.equal(p.sent.length, 1, 'control: agreed to, it is sent');
  // No consent, another model, another service: nothing more is sent.
  assert.throws(() => T.limitProvider(p, null, { now: NOW }), { name: 'ConsentError', kind: 'no-consent' });
  await assert.rejects(ok.extract(chunk, { model: 'claude-opus-5' }), { name: 'ConsentError', kind: 'mismatch' });
  const elsewhere = T.limitProvider(fake({ origin: 'https://other.example.org' }), consentFor(2, 'claude-fable-5'), { now: NOW });
  await assert.rejects(elsewhere.extract(chunk, { model: 'claude-fable-5' }), { name: 'ConsentError', kind: 'mismatch' });
  assert.equal(p.sent.length, 1);
});

test('a withdrawn consent, or a permission no longer given, sends nothing more, even in the middle of a run', async () => {
  const p = fake();
  let given = true;
  const lim = T.limitProvider(p, consentFor(2, 'claude-fable-5'), { now: NOW, permitted: () => given });
  await lim.extract(parts(1)[0], { model: 'claude-fable-5' });
  assert.equal(p.sent.length, 1);
  given = false;   // the permission is withdrawn, or the key forgotten
  await assert.rejects(lim.extract(parts(1)[0], { model: 'claude-fable-5' }), { name: 'ConsentError', kind: 'withdrawn' });
  given = true;
  await lim.extract(parts(1)[0], { model: 'claude-fable-5' });
  assert.equal(p.sent.length, 2, 'control: given again, it goes');
  lim.withdraw();
  await assert.rejects(lim.extract(parts(1)[0], { model: 'claude-fable-5' }), { name: 'ConsentError', kind: 'withdrawn' });
  assert.equal(p.sent.length, 2);
});

test('the ceiling is hard: a part that could take the run over it is not sent, and what was spent is counted from what the provider reports', async () => {
  const p = fake({ usage: { input: 3000, output: 40000 } });   // 40,000 tokens out at $50 a million is $2: the whole ceiling, at once
  const est = T.estimateRun(parts(1), { effort: 'low' });
  const c = T.giveConsent({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: est, assessment: T.assessRun({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: est, now: NOW, ceilingUsd: 2.1 }) });
  const lim = T.limitProvider(p, c, { now: NOW });
  assert.equal(lim.spent(), 0);
  await lim.extract(parts(1)[0], { model: 'claude-fable-5' });
  assert.equal(p.sent.length, 1);
  assert.equal(lim.spent().toFixed(2), '2.03', '3,000 in at $10 and 40,000 out at $50 a million');
  await assert.rejects(lim.extract(parts(1)[0], { model: 'claude-fable-5' }), { name: 'CeilingError', kind: 'ceiling' });
  assert.equal(p.sent.length, 1, 'nothing more was sent');
  assert.equal(lim.ceilingUsd, 2.1);
});

test('a run over a text stops at the ceiling with every finished part kept, and a run within it finishes (through the engine\'s own runExtraction)', async () => {
  const text = Array.from({ length: 12 }, (_, i) => `Day ${i}: we came to Gades and went on to Ostia. `.repeat(25)).join('\n');
  const mk = () => T.newWork({ text, source: SOURCE, chunking: { target: 1000, overlap: 100 }, now: '2026-10-20T12:00:00Z' });
  const chunks = T.chunkText(text, { target: 1000, overlap: 100 });
  assert.ok(chunks.length >= 10, `${chunks.length} parts`);
  const est = T.estimateRun(chunks, { effort: 'low' });
  const oneCost = T.costOf(T.estimateChunk(chunks[0], { effort: 'low' }), 'anthropic', 'claude-fable-5', { now: NOW }).usd.high;
  // A ceiling that fits three parts' worst case, and so not twelve: the estimate for the run blocks it, so the user is shown that first.
  const ceilingUsd = Math.round((oneCost * 3.5) * 100) / 100;
  const blocked = T.assessRun({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: est, now: NOW, ceilingUsd });
  assert.equal(blocked.blocked, 'over-ceiling', 'shown before sending');
  // Had the user agreed to a smaller estimate (the first three parts), the engine is still held to the ceiling.
  const first = T.estimateRun(chunks.slice(0, 3), { effort: 'low' });
  const c = T.giveConsent({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: first, assessment: T.assessRun({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: first, now: NOW, ceilingUsd }) });
  const p = fake({ usage: { input: 1000, output: 3000 } });
  const work = mk();
  const r = await T.runExtraction({ work, text, provider: T.limitProvider(p, c, { now: NOW }), model: 'claude-fable-5' });
  assert.ok(r.stopped && r.stopped.name === 'CeilingError', String(r.stopped));
  assert.ok(r.done >= 1 && r.done < chunks.length, `${r.done} of ${chunks.length} parts done`);
  assert.equal(work.results.length, r.done, 'every finished part is in the work file');
  assert.equal(p.sent.length, r.done, 'and no part beyond it was sent');
  // Within the ceiling, the same engine finishes (the presence beside the stop).
  const generous = T.giveConsent({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: est, assessment: T.assessRun({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: est, now: NOW, ceilingUsd: 50 }) });
  const q = fake({ usage: { input: 1000, output: 3000 } });
  const all = await T.runExtraction({ work: mk(), text, provider: T.limitProvider(q, generous, { now: NOW }), model: 'claude-fable-5' });
  assert.equal(all.stopped, null);
  assert.equal(all.done, chunks.length);
});

test('a server on this computer is not charged, so its parts are not stopped by money', async () => {
  const p = fake({ origin: LOCAL, id: 'openai-compatible', usage: { input: 1e6, output: 1e6 } });
  const est = T.estimateRun(parts(2));
  const a = T.assessRun({ provider: 'openai-compatible', model: 'qwen3:0.6b', origin: LOCAL, estimate: est, now: NOW });
  const c = T.giveConsent({ provider: 'openai-compatible', model: 'qwen3:0.6b', origin: LOCAL, estimate: est, assessment: a });
  const lim = T.limitProvider(p, c, { now: NOW });
  for (let i = 0; i < 3; i++) await lim.extract(parts(1)[0], { model: 'qwen3:0.6b' });
  assert.equal(p.sent.length, 3);
  assert.equal(lim.spent(), 0);
});

test('a run is asked a second time over 200 parts or $5, as before, and the assessment says so', () => {
  const big = T.assessRun({ provider: 'anthropic', model: 'claude-fable-5', origin: ANTHROPIC, estimate: T.estimateRun(parts(60), { effort: 'low' }), now: NOW, ceilingUsd: 100 });
  assert.equal(big.second, true, 'over $5 at the ceiling raised');
  assert.equal(T.assessRun({ provider: 'anthropic', model: 'claude-sonnet-5-5', origin: ANTHROPIC, estimate: T.estimateRun(parts(2), { effort: 'low' }), now: NOW }).second, false);
});
