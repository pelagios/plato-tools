// The colour theme (public/theme.js, src/styles.css, the switch in both pages' headers). Each dark rule
// in the stylesheet is written twice, once for a device set to dark with Light not chosen, once for
// Dark chosen: these hold the two copies to the same words, so that a colour changed in one is not
// left behind in the other. The behaviour in a browser is checked in e2e/app_test.py. Each absence
// asserted here has a presence beside it, so a file that was not read cannot pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const AUTO = ':root:not([data-theme="light"])', DARK = ':root[data-theme="dark"]';

/** Each `@media (prefers-color-scheme: …) { … }` in the stylesheet: its query, its body, and where it ends. */
function schemeBlocks(text) {
  const out = [], re = /@media\s*\(prefers-color-scheme:\s*(\w+)\)\s*\{/g;
  for (let m; (m = re.exec(text));) {
    let depth = 1, i = re.lastIndex;
    for (; i < text.length && depth; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
    out.push({ scheme: m[1], body: text.slice(re.lastIndex, i - 1).trim(), end: i });
  }
  return out;
}
const selectors = (body) => [...body.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));

test('every dark rule applies only where Light is not chosen, and has a twin, word for word, for Dark chosen', () => {
  const blocks = schemeBlocks(css);
  assert.ok(blocks.length >= 5, `found ${blocks.length} prefers-color-scheme blocks`);
  assert.ok(blocks.some((b) => b.body.includes('--bg: #16191f')), 'the dark colour tokens are among them');
  assert.ok(blocks.some((b) => b.body.includes('.status-denied')) && blocks.some((b) => b.body.includes('.tip')) && blocks.some((b) => b.body.includes('.plato-mark')));
  for (const b of blocks) {
    assert.equal(b.scheme, 'dark');
    const sels = selectors(b.body);
    assert.ok(sels.length > 0, b.body);
    for (const s of sels) assert.ok(s.startsWith(AUTO) || s.startsWith(`:where(${AUTO})`), `a dark rule that would apply with Light chosen: ${s}`);
    const twin = b.body.split(AUTO).join(DARK);
    assert.notEqual(twin, b.body);
    // The twin follows the block directly, so that it overrides the same rules in the same order.
    assert.equal(css.slice(b.end).trimStart().slice(0, twin.length), twin, `no twin for Dark chosen after: ${b.body.slice(0, 80)}`);
  }
  // And a rule for Dark chosen that has no counterpart for the device's setting is caught too.
  const darkRules = css.split(DARK).length - 1, autoRules = css.split(AUTO).length - 1;
  assert.ok(autoRules >= 10);
  assert.equal(darkRules, autoRules);
});

test('the light scheme sets color-scheme light on the root, and the dark, dark, so that native controls follow', () => {
  assert.match(css, /^:root \{ color-scheme: light; --fg:/m);
  assert.match(css, new RegExp(`^${DARK.replace(/[[\]().*"]/g, '\\$&')} \\{ color-scheme: dark; --fg:`, 'm'));
});

for (const page of ['index.html', 'chora.html']) {
  test(`${page} loads public/theme.js in its head before the stylesheet, and has the three-way switch in its header`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const head = html.slice(0, html.indexOf('</head>')), script = head.indexOf('<script src="./theme.js"></script>');
    assert.ok(script > 0 && script < head.indexOf('src/styles.css'), 'theme.js before the stylesheet');
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(header, /<div id="theme-switch" class="theme-switch" role="radiogroup" aria-label="Colour theme">/);
    assert.deepEqual([...header.matchAll(/<input type="radio" name="plato-theme" value="(\w+)"[^>]*>/g)].map((m) => m[1]), ['auto', 'light', 'dark']);
    assert.ok(header.indexOf('theme-switch') < header.indexOf('permissions-button'));
  });
}

/** Runs public/theme.js against a stub of the document as it is while <head> is parsed. */
function run(storage) {
  const attrs = {}, src = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
  const documentElement = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } };
  const document = { documentElement, readyState: 'loading', addEventListener() {}, querySelectorAll: () => [], getElementById: () => null };
  const window = { addEventListener() {} };
  const context = { document, window };
  Object.defineProperty(context, 'localStorage', { get() { if (storage === 'refused') throw new Error('SecurityError'); return { getItem: (k) => (k === 'plato-tools.theme' ? storage : null) }; } });
  vm.runInNewContext(src, context);
  return attrs['data-theme'] ?? null;
}

test('before the page is painted: a remembered Light or Dark is set on <html>; Auto, nothing remembered, an unknown value or storage refused leave it unset', () => {
  assert.equal(run('light'), 'light');
  assert.equal(run('dark'), 'dark');
  assert.equal(run(null), null);
  assert.equal(run('auto'), null);
  assert.equal(run('purple'), null);
  assert.equal(run('refused'), null);
});
