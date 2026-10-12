// The WHG token's field (src/lib/token-field.js), shared by the main page's lookup panel and Chora's adopt
// panel, against a fake keeper with permissions.token's calls. The token must never be in what is drawn:
// each such check has, beside it, a control that the token was given to the keeper. A value the browser
// filled in (not typed or pasted) is never given: each such check has, beside it, the same value typed,
// which is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenView, giveToken, rememberToken, forgetToken, tokenFieldHtml, noteInput } from '../src/lib/token-field.js';
import { TOKEN_FIELD as TF } from '../src/engine/words.js';

const SECRET = 'unit-SECRET-token-5b1e';
function keeper() {
  let t = null, kept = false;
  return { get: () => t, set: (v) => { t = v.trim() || null; }, forget: () => { t = null; }, remembered: () => kept, remember: (on) => { kept = on; },
    scope: () => (t === null ? null : kept ? 'browser' : 'tab') };
}
/** A field as the page has it, given a value the way the browser would: typed or pasted (an input event with that inputType), or filled in. */
const field = (value = '', how = 'insertText') => {
  const f = { value: '', dataset: {} };
  if (value) { f.value = value; noteInput({ target: f, inputType: how }); }
  return f;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

test('no token: an empty field saying where to get one, Remember, no Forget, nothing beside it', () => {
  const v = tokenView(keeper());
  assert.deepEqual(v, { has: false, kept: false, placeholder: TF.placeholder, state: '', remember: true, forget: false });
});

test('Enter: kept for the tab, the field emptied, masked, Remember still offered, Forget offered', () => {
  const k = keeper(), f = field(` ${SECRET} `);
  giveToken(k, f);
  assert.equal(k.get(), SECRET);   // the control: it was given
  assert.equal(f.value, '');
  const v = tokenView(k);
  assert.deepEqual(v, { has: true, kept: false, placeholder: TF.mask, state: TF.forTab, remember: true, forget: true });
  assert.ok(!JSON.stringify(v).includes(SECRET));
});

test('a value the browser filled in is emptied and never given; the same pasted, or typed then edited, is', () => {
  for (const how of [null, '', 'insertReplacementText']) {   // null: a plain Event, which has no inputType
    const k = keeper(), f = field(SECRET, how);
    assert.equal(f.value, '', `filled in (${how}): emptied at once`);
    // Filled in without any event at all (the field's value set, no input heard): still not taken.
    f.value = SECRET;
    giveToken(k, f);
    assert.equal(k.get(), null, `filled in (${how}): not given`);
    assert.equal(f.value, '');
    assert.equal(rememberToken(k, Object.assign(field(), { value: SECRET })), false);
    assert.equal(k.get(), null); assert.equal(k.remembered(), false);
  }
  const pasted = keeper(); giveToken(pasted, field(SECRET, 'insertFromPaste'));
  assert.equal(pasted.get(), SECRET, 'the control: pasted, it is given');
  // Typed, then a character deleted: still typed. Emptied by deleting: untyped again.
  const f = field(SECRET + 'x');
  f.value = SECRET; noteInput({ target: f, inputType: 'deleteContentBackward' });
  const edited = keeper(); giveToken(edited, f);
  assert.equal(edited.get(), SECRET);
  const g = field('a'); g.value = ''; noteInput({ target: g, inputType: 'deleteContentBackward' });
  assert.equal(g.dataset.typed, undefined);
  // Typed, and then a browser fills the field over it: what the browser put is emptied, and nothing is given.
  const h = field('typed'); h.value = SECRET; noteInput({ target: h, inputType: 'insertReplacementText' });
  const over = keeper(); giveToken(over, h);
  assert.equal(over.get(), null); assert.equal(h.value, '');
});

test('Remember: kept in this browser, Remember no longer offered; with nothing typed and no token, nothing happens', () => {
  const k = keeper(), f = field(SECRET);
  assert.equal(rememberToken(k, f), true);
  assert.equal(k.get(), SECRET); assert.equal(k.remembered(), true); assert.equal(f.value, '');
  assert.equal(tokenView(k).state, TF.remembered); assert.equal(tokenView(k).remember, false);
  const none = keeper();
  assert.equal(rememberToken(none, field('  ')), false);
  assert.equal(none.remembered(), false);
  // A token kept for the tab is remembered as it is.
  const tab = keeper(); giveToken(tab, field(SECRET));
  assert.equal(rememberToken(tab, field('')), true);
  assert.equal(tab.get(), SECRET); assert.equal(tab.remembered(), true);
});

test('the line says where the keeper says the token is: a tab\'s own, though another tab chose to remember one, is for this tab', () => {
  const k = keeper(); giveToken(k, field(SECRET));
  const other = { ...k, remembered: () => true, scope: () => 'tab' };
  assert.equal(tokenView(other).state, TF.forTab);
  assert.equal(tokenView(other).remember, true);
  assert.equal(tokenView({ ...k, scope: () => 'browser' }).state, TF.remembered);   // the control
});

test('Forget: the token and the choice to remember it, the field emptied, and the lookup told', () => {
  const k = keeper(), f = field(SECRET);
  rememberToken(k, f);
  let cleared = 0;
  const g = field('half typed');
  forgetToken(k, { clearToken: () => { cleared++; } }, g);
  assert.equal(k.get(), null); assert.equal(k.remembered(), false); assert.equal(g.value, ''); assert.equal(cleared, 1);
  assert.deepEqual(tokenView(k), tokenView(keeper()));
});

test('the HTML: a new password (never a saved one offered), masked once given, never the token; Remember and Forget hidden by state', () => {
  const k = keeper();
  const empty = tokenFieldHtml(k, 'x-token', esc);
  assert.match(empty, /autocomplete="new-password"/);
  assert.doesNotMatch(empty, /<form/);
  assert.match(empty, /id="x-token-forget" hidden/);
  assert.doesNotMatch(empty, /id="x-token-remember" hidden/);
  assert.ok(empty.includes(esc(TF.placeholder)));
  giveToken(k, field(SECRET));
  const given = tokenFieldHtml(k, 'x-token', esc);
  assert.equal(k.get(), SECRET);   // the control: it was given
  assert.ok(!given.includes(SECRET));
  assert.ok(given.includes(TF.mask) && given.includes(TF.forTab));
  assert.doesNotMatch(given, /id="x-token-forget" hidden/);
  assert.match(given, /type="password"/);
});
