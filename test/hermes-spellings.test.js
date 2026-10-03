// "Group similar spellings…" on the page (src/hermes-spellings.js), its logic run in Node against a
// stand-in for the panel's element: what a "Find groups" keeps of the groups already ticked, that an
// answer for a column or way of grouping no longer chosen is set aside, and that keyboard focus
// survives the panel being drawn again. Each absence is asserted beside a presence it could have missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spellingsPanel } from '../src/hermes-spellings.js';

/**
 * A stand-in for the panel's element and its document: innerHTML is kept as text; querySelector('#id')
 * gives an element for an id the HTML has (made afresh each time the HTML is replaced, as a browser
 * does), with `disabled`, focus() and, for the message, its text. Focus is lost when the HTML is replaced.
 */
function fakePage() {
  const document = { activeElement: null, body: { id: '' } };
  let html = '', made = new Map();
  const handlers = {};
  const box = {
    hidden: false, ownerDocument: document,
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v; made = new Map();
      if (document.activeElement?.box === box) document.activeElement = document.body;   // the focused control is gone
    },
    contains: (el) => el?.box === box,
    addEventListener: (type, f) => { (handlers[type] ||= []).push(f); },
    querySelector(sel) {
      const id = /^#([\w-]+)$/.exec(sel)?.[1];
      if (!id) return null;
      if (made.has(id)) return made.get(id);
      const tag = new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>`).exec(html);
      if (!tag) return null;
      const inner = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</${tag[1]}>`).exec(html)?.[1] ?? '';
      const el = { id, box, disabled: /\sdisabled(\s|>|$)/.test(tag[0]), textContent: unescape(inner.replace(/<[^>]+>/g, '')), focus() { document.activeElement = el; } };
      made.set(id, el);
      return el;
    },
  };
  const fire = (type, target) => { for (const f of handlers[type] || []) f({ target: { matches: () => false, dataset: {}, ...target } }); };
  return { document, box, fire };
}

const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

/** A panel on a fake page, with what it asks the worker and what it publishes recorded. */
function panel() {
  const page = fakePage(), asked = [], published = [];
  const p = spellingsPanel({ box: page.box, ask: (m) => asked.push(m), publish: (s) => published.push(s) });
  p.reset(true);
  p.columns(['id', 'name', 'parish'], 'name');
  return { ...page, p, asked, last: () => published[published.length - 1] };
}
const cluster = (...values) => ({ key: values[0].toLowerCase(), members: values.map((value) => ({ value, count: 1 })), suggested: values[0] });
const SAVED = {
  name: { method: 'fingerprint', groups: [{ chosen: 'Rotherhithe', members: ['Rotherhithe', 'Rotherhith'] }, { chosen: 'Bermondsey', members: ['Bermondsey', 'Barmondsey'] }] },
};

test('"Find groups" keeps a loaded ticked group it does not find again: still ticked, marked, and counted in the message', () => {
  const { p, fire, asked, last, box } = panel();
  p.load(SAVED);
  fire('click', { id: 'spellings-open' });
  fire('click', { id: 'spellings-find' });
  const q = asked[asked.length - 1];
  assert.equal(q.column, 'name');
  // Found again: Rotherhithe's group exactly; Bermondsey's not (another way of grouping would not join them); a new one.
  p.answer({ id: q.id, column: 'name', method: 'fingerprint', distinct: 9, clusters: [cluster('Rotherhithe', 'Rotherhith'), cluster('Newington', 'NEWINGTON')] });
  const s = last();
  assert.deepEqual(s.rows.map((r) => [r.members.map((m) => m.value).join('|'), r.ticked, !!r.notFound]), [
    ['Rotherhithe|Rotherhith', true, false],    // found again: ticked, as loaded
    ['Newington|NEWINGTON', false, false],      // new: unticked
    ['Bermondsey|Barmondsey', true, true],      // not found this way: kept, still ticked, marked
  ]);
  assert.equal(s.rows[2].saved, true);
  assert.equal(s.rows[2].chosen, 'Bermondsey');
  assert.equal(s.ticked, 2);
  assert.match(s.message, /^2 groups of similar spellings in "name".* 1 ticked group not found this way is kept at the end of the list, still ticked\.$/);
  assert.match(box.innerHTML, /From the saved matching, not found this way\./);
  // Both ticked groups are what a run is given, the kept one included.
  assert.deepEqual(p.options().clusters.name.groups.map((g) => g.chosen), ['Rotherhithe', 'Bermondsey']);
  // The control: every ticked group found again, nothing is kept apart and the message says nothing of it.
  fire('click', { id: 'spellings-find' });
  p.answer({ id: asked[asked.length - 1].id, column: 'name', method: 'fingerprint', distinct: 9, clusters: [cluster('Rotherhithe', 'Rotherhith'), cluster('Bermondsey', 'Barmondsey')] });
  assert.deepEqual(last().rows.map((r) => [r.ticked, !!r.notFound]), [[true, false], [true, false]]);
  assert.doesNotMatch(last().message, /not found this way/);
  assert.doesNotMatch(box.innerHTML, /not found this way/);
});

test('an answer for a column or way of grouping no longer chosen is set aside; the answer for the one chosen is shown', () => {
  const { p, fire, asked, last } = panel();
  fire('click', { id: 'spellings-open' });
  fire('click', { id: 'spellings-find' });
  const old = asked[asked.length - 1];
  assert.equal(old.column, 'name');
  assert.equal(last().waiting, true);
  fire('change', { id: 'spellings-column', value: 'parish' });
  assert.equal(last().waiting, false);   // the Find button can be used again
  p.answer({ id: old.id, column: 'name', method: 'fingerprint', distinct: 5, clusters: [cluster('Rotherhithe', 'Rotherhith')] });
  assert.equal(last().column, 'parish');
  assert.deepEqual(last().rows, []);
  assert.equal(last().message, '');
  // A change of the way of grouping sets an answer aside too.
  fire('click', { id: 'spellings-find' });
  const before = asked[asked.length - 1];
  fire('change', { id: 'spellings-method', value: 'phonetic' });
  p.answer({ id: before.id, column: 'parish', method: 'fingerprint', distinct: 3, clusters: [cluster('St Mary', 'St. Mary')] });
  assert.deepEqual(last().rows, []);
  // The control: asked again, the answer for the column and way chosen is shown.
  fire('click', { id: 'spellings-find' });
  const now = asked[asked.length - 1];
  assert.deepEqual([now.column, now.method], ['parish', 'phonetic']);
  p.answer({ id: now.id, column: 'parish', method: 'phonetic', distinct: 3, clusters: [cluster('St Mary', 'St. Mary')] });
  assert.deepEqual(last().rows.map((r) => r.members.map((m) => m.value)), [['St Mary', 'St. Mary']]);
  assert.match(last().message, /^1 group of similar spellings in "parish"/);
});
