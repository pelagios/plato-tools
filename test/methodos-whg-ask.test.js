// Methodos: the World Historical Gazetteer asked for as a workflow is begun (src/methodos/whg-ask.js), so that the
// reload its permission needs comes before any work and not at the lookup. What is asked, of which workflows and when;
// its words; and that the policy written at the next load holds the gazetteer exactly when the permission is recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { whgAsk, WHG_ASK, WHG_OPS } from '../src/methodos/whg-ask.js';
import { RECIPES } from '../src/engine/methodos/recipes/index.js';
import { OPERATIONS } from '../src/engine/methodos/operations.js';
import { plan } from '../src/engine/methodos/interview.js';
import { allowedOrigins, normalise, policyFor, originsFor } from '../src/lib/permissions-core.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const HTML = read('../index.html'), APP = read('../src/app.js'), PAGE = read('../src/methodos/page.js'), HEAD = read('../src/lib/csp-head.js');
/** A workflow's steps as the page hands them over: those that run, the first the one it is at. */
const stepsOf = (key, answers, at = 0) => plan(key, answers).steps.filter((s) => s.available === true).map((s, i) => ({ op: s.op, title: s.title, st: i < at ? 'done' : i === at ? 'current' : 'todo' }));
const MYD = { 'has-regions': false, 'will-draw': false, 'will-publish': false, 'will-mint': false, target: 'table-flat' };

test('a workflow with a lookup to come asks at its start, naming the step; one with none asks nothing', () => {
  const steps = stepsOf('map-your-data', MYD);
  assert.deepEqual(whgAsk({ steps, state: 'undecided', inPolicy: false }), { kind: 'allow', n: 4, title: 'Find your places in WHG' });
  // With the regions looked up first, that is the first step that asks the gazetteer.
  const regions = whgAsk({ steps: stepsOf('map-your-data', { ...MYD, 'has-regions': true }), state: 'undecided', inPolicy: false });
  assert.equal(regions.kind, 'allow'); assert.equal(regions.title, 'Find the regions your places are in, the widest first');
  assert.deepEqual([...WHG_OPS], ['lookup', 'lookup.levels']);
  for (const op of WHG_OPS) assert.ok(OPERATIONS[op], op);
  // Of every workflow: asked exactly when one of its steps asks the gazetteer. Both kinds exist (so neither half is empty).
  const asks = [], silent = [];
  for (const r of Object.values(RECIPES)) (r.steps.some((s) => WHG_OPS.has(s.op)) ? asks : silent).push(r.key);
  assert.ok(asks.includes('map-your-data')); assert.ok(silent.length >= 1, 'no workflow without a lookup: the absence is not tested');
  for (const key of silent) {
    const steps0 = RECIPES[key].steps.map((s, i) => ({ op: s.op, title: s.title, st: i ? 'todo' : 'current' }));
    assert.equal(whgAsk({ steps: steps0, state: 'undecided', inPolicy: false }), null, key);
  }
});

test('what is asked follows the permission: undecided, allow; allowed since the page loaded, the reload; in this load\'s policy, nothing; Never, nothing', () => {
  const steps = stepsOf('map-your-data', MYD);
  const kind = (o) => whgAsk({ steps, ...o })?.kind ?? null;
  assert.equal(kind({ state: 'undecided', inPolicy: false }), 'allow');
  assert.equal(kind({ state: 'allowed', inPolicy: false }), 'reload');
  assert.equal(kind({ state: 'allowed', inPolicy: true }), null);
  assert.equal(kind({ state: 'never', inPolicy: false }), null, 'the user has answered: not asked again');
  // Loaded again for this, a moment ago: said once, with the step it serves.
  assert.deepEqual(whgAsk({ steps, state: 'allowed', inPolicy: true, justAllowed: true }), { kind: 'allowed', n: 4, title: 'Find your places in WHG' });
  assert.equal(kind({ state: 'undecided', inPolicy: false, justAllowed: true }), 'allow', 'not allowed after all (forgotten in Permissions): asked');
  // "Decide later" silences the question and the offer of a reload, for this workflow.
  assert.equal(kind({ state: 'undecided', inPolicy: false, later: true }), null);
  assert.equal(kind({ state: 'allowed', inPolicy: false, later: true }), null);
  // A page whose protection was not shown to work asks no site at all: nothing to ask for.
  assert.equal(kind({ state: 'undecided', inPolicy: false, enforced: false }), null);
  // Only while the lookup is still to come: at the step itself, and after it, the lookup's own panel says what is needed.
  assert.equal(whgAsk({ steps: stepsOf('map-your-data', MYD, 2), state: 'undecided', inPolicy: false }).kind, 'allow', 'control: one step before it');
  assert.equal(whgAsk({ steps: stepsOf('map-your-data', MYD, 3), state: 'undecided', inPolicy: false }), null, 'at the lookup');
  assert.equal(whgAsk({ steps: stepsOf('map-your-data', MYD, 5), state: 'undecided', inPolicy: false }), null, 'after it');
  assert.equal(whgAsk({ steps: [], state: 'undecided' }), null);
  assert.equal(whgAsk(), null);
});

test('the card\'s words: plain, say that nothing is sent by allowing, what the gazetteer will see, and where to change it', () => {
  const at = { n: 4, title: 'Find your places in WHG' };
  for (const kind of ['allow', 'reload', 'allowed']) {
    const w = WHG_ASK[kind];
    for (const s of [w.heading, w.why(at), w.what, w.yes, w.later || '']) {
      assert.doesNotMatch(s, /Methodos|Krisis|Chora|Content Security|CSP|\bpolic|\borigin|connect-src|\btoken\b/i, `${kind}: ${s}`);
    }
    assert.match(w.why(at), /“Find your places in WHG”/, kind);
    assert.match(w.what, /in Permissions\.$/, kind);
  }
  assert.equal(WHG_ASK.allow.heading, 'Allow the World Historical Gazetteer now?');
  assert.match(WHG_ASK.allow.why(at), /^Step 4 of this workflow, .* say yes, and the page loads again once, with your workflow kept\.$/);
  assert.match(WHG_ASK.allow.what, /^Nothing is sent by allowing it\. .* you send it yourself; the gazetteer then sees the names you look up/);
  assert.deepEqual([WHG_ASK.allow.yes, WHG_ASK.allow.later], ['Allow, and load the page again', 'Decide later']);
  assert.equal(WHG_ASK.allowed.later, undefined, 'a confirmation has one button');
  assert.match(WHG_ASK.laterSaid, /^You will be asked at the step that looks your places up\./);
});

test('nothing is allowed without the click: the page records the permission in one place, the card\'s own button, and the card is on the page', () => {
  // The only place the page itself allows the gazetteer is the host function the card's button calls.
  const sets = APP.match(/permissions\.set\('gazetteer', 'whg', 'allowed'\)/g) || [];
  assert.equal(sets.length, 1);
  assert.ok(APP.includes("allowWhg: () => { permissions.set('gazetteer', 'whg', 'allowed'); return permissions.reload(); },"));
  assert.equal((PAGE.match(/page\.allowWhg\(\)/g) || []).length, 1);
  assert.match(PAGE, /askEl\?\.querySelector\('#whg-ask-yes'\)\.addEventListener\('click', async \(\) => \{[^]*?asked\.kind === 'allow' \? page\.allowWhg\(\) : page\.reloadPage\(\)/);
  for (const id of ['whg-ask', 'whg-ask-h', 'whg-ask-why', 'whg-ask-what', 'whg-ask-yes', 'whg-ask-later', 'whg-ask-said']) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.ok(/<aside id="whg-ask" class="offer-card whg-ask" aria-labelledby="whg-ask-h" hidden>/.test(HTML), 'hidden until asked');
});

test('the policy written as the page loads holds the gazetteer\'s sites exactly when the permission is recorded: allowed before the reload, it needs no other', () => {
  const sites = originsFor('gazetteer', 'whg');
  assert.deepEqual(sites, ['https://whgazetteer.org', 'https://www.whgazetteer.org']);
  const recorded = normalise({ 'gazetteer:whg': { state: 'allowed', at: '2026-11-19T10:00:00.000Z' } });
  const allowed = allowedOrigins(recorded, []);
  for (const s of sites) { assert.ok(allowed.includes(s), s); assert.match(policyFor(allowed), new RegExp(`connect-src [^;]*${s.replace(/\./g, '\\.')}`)); }
  // The control: nothing recorded, or Never, and the policy holds no other site.
  for (const grants of [{}, { 'gazetteer:whg': { state: 'never', at: '2026-11-19T10:00:00.000Z' } }]) {
    const none = allowedOrigins(normalise(grants), []);
    assert.deepEqual(none, []);
    assert.doesNotMatch(policyFor(none), /whgazetteer/);
  }
  // The first script of the page is as it was: it reads what is recorded, and nothing of the card's.
  assert.doesNotMatch(HEAD, /whg-ask|methodos/);
  assert.match(HEAD, /origins = allowedOrigins\(grants, /);
});
