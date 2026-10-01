// The site's tooltips (src/lib/tooltip.js): where one is placed, and that no page or page script
// still gives the browser's own `title` tooltip. The behaviour in a browser (hover, focus, Esc, the
// window's edge) is checked in e2e/app_test.py. Each absence asserted here has a presence beside it:
// the tooltips' texts are found where the titles were, so a file that was not read cannot pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { place } from '../src/lib/tooltip.js';

const view = { width: 1000, height: 800 };
const box = (left, top, w = 40, h = 20) => ({ left, top, right: left + w, bottom: top + h });

test('a tooltip goes below its element, centred on it, when it fits', () => {
  assert.deepEqual(place(box(480, 100), { width: 200, height: 50 }, view), { left: 400, top: 128, side: 'below' });
});

test('a tooltip near the right edge is moved left to stay within the window, and near the left, right', () => {
  const right = place(box(950, 100), { width: 300, height: 50 }, view);
  assert.equal(right.left, 1000 - 8 - 300);
  assert.ok(right.left + 300 <= view.width - 8);
  const left = place(box(0, 100), { width: 300, height: 50 }, view);
  assert.equal(left.left, 8);
  // The control: one with room either side is not moved.
  assert.equal(place(box(480, 100), { width: 300, height: 50 }, view).left, 350);
});

test('a tooltip goes above its element when there is no room below and more above', () => {
  const p = place(box(480, 740), { width: 200, height: 80 }, view);
  assert.equal(p.side, 'above');
  assert.equal(p.top, 740 - 8 - 80);
  // Taller than the room on either side: kept within the window, on the side with more room.
  const tall = place(box(480, 300), { width: 200, height: 900 }, view);
  assert.ok(tall.top >= 8 && tall.side === 'below');
});

test('a tooltip asked to go beside its element goes there when it fits, and below when it does not', () => {
  // A zoom button at the right edge: to its left, centred on it from top to bottom.
  assert.deepEqual(place(box(950, 100, 30, 30), { width: 80, height: 30 }, view, 'left'), { left: 950 - 8 - 80, top: 100, side: 'left' });
  assert.deepEqual(place(box(10, 100, 30, 30), { width: 80, height: 30 }, view, 'right'), { left: 48, top: 100, side: 'right' });
  // No room to the left: below, as any other.
  assert.equal(place(box(20, 100, 30, 30), { width: 80, height: 30 }, view, 'left').side, 'below');
});

const tipsIn = (s) => [...s.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1]);
const titles = (s) => [...s.matchAll(/<[a-z][^>]*\stitle=/gi), ...s.matchAll(/<title>/g)];

test('the pages give no element a title attribute, and their tooltips are there instead', () => {
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const chora = readFileSync(new URL('../chora.html', import.meta.url), 'utf8');
  // Only the document's own <title> in each.
  assert.deepEqual(titles(index).map((m) => m[0]), ['<title>']);
  assert.deepEqual(titles(chora).map((m) => m[0]), ['<title>']);
  assert.equal(tipsIn(index).length, 9);   // the nine tools' names, Peripleo's (planned) included
  assert.ok(tipsIn(index).some((t) => t.startsWith('περιπλέω')));
  assert.ok(tipsIn(index).some((t) => t.startsWith('ἔλεγχος')));
  assert.deepEqual(tipsIn(chora).slice(0, 1), ['Draw a point']);
  for (const page of [index, chora]) {
    assert.match(page, /<a class="dev-badge" href="https:\/\/github.com\/pelagios\/plato-tools\/issues" data-tip-template="dev-tip">Under development<\/a>/);
    assert.match(page, /<template id="dev-tip">.*being built in the open/);
    assert.match(page, /<script type="module" src=".\/src\/lib\/tooltip.js"><\/script>/);
  }
});

test('the page scripts write no title attribute or SVG title, and say their tooltips with data-tip', () => {
  const dir = new URL('../src/chora/', import.meta.url);
  const files = [new URL('../src/app.js', import.meta.url), ...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => new URL(f, dir))];
  const all = files.map((f) => readFileSync(f, 'utf8'));
  for (const [i, s] of all.entries()) assert.deepEqual(titles(s).map((m) => m[0]), [], files[i].pathname);
  const chora = all[files.findIndex((f) => f.pathname.endsWith('/chora/app.js'))];
  assert.match(chora, /class="status status-\$\{s\}" data-tip="\$\{esc\(STATUS_TITLES\[s\]\)\}"/);
  assert.match(chora, /<g data-tip="/);
});
