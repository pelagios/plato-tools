// The WHG token's field (src/lib/token-field.js), shared by the main page's lookup panel and Chora's adopt
// panel, against a fake keeper with permissions.token's calls. The token must never be in what is drawn:
// each such check has, beside it, a control that the token was given to the keeper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenView, giveToken, rememberToken, forgetToken, tokenFieldHtml } from '../src/lib/token-field.js';
import { TOKEN_FIELD as TF } from '../src/engine/words.js';

const SECRET = 'unit-SECRET-token-5b1e';
function keeper() {
  let t = null, kept = false;
  return { get: () => t, set: (v) => { t = v.trim() || null; }, forget: () => { t = null; }, remembered: () => kept, remember: (on) => { kept = on; } };
}
const field = (value = '') => ({ value });
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

test('Forget: the token and the choice to remember it, the field emptied, and the lookup told', () => {
  const k = keeper(), f = field(SECRET);
  rememberToken(k, f);
  let cleared = 0;
  f.value = 'half typed';
  forgetToken(k, { clearToken: () => { cleared++; } }, f);
  assert.equal(k.get(), null); assert.equal(k.remembered(), false); assert.equal(f.value, ''); assert.equal(cleared, 1);
  assert.deepEqual(tokenView(k), tokenView(keeper()));
});

test('the HTML: masked once given, never the token; Remember and Forget hidden by state', () => {
  const k = keeper();
  const empty = tokenFieldHtml(k, 'x-token', esc);
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
