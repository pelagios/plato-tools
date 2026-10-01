// Chora's place card as text (src/chora/card.js): what the card writes for a relation and for the
// timeline, from the view (src/engine/chora/view.js). Pure: no page, no map. Each absence asserted
// here has its presence beside it, so that none of these checks could pass by writing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relationItem, timeline, esc, relativeItem, locations } from '../src/chora/card.js';
import { viewPlace } from '../src/engine/chora/view.js';

const P = 'https://w3id.org/plato#';
const row = (o) => ({ facet: 'name', text: 'Agathos Daimon', start: null, end: null, label: null, status: 'asserted', evidence: false, attestationIndex: 0, ...o });

test('#18: a relation named only is written as plain text, never a link; one to a place of the dataset is a link', () => {
  const named = relationItem({ typeLabel: 'ContainedIn', type: P + 'ContainedIn', label: 'the Delta', relatesTo: null, related: null, status: 'asserted' });
  assert.equal(named, 'ContainedIn: the Delta');
  const linked = relationItem({ typeLabel: 'ContainedIn', label: 'Bexley', relatesTo: 'https://example.org/p/b', related: { id: 'https://example.org/p/b', label: 'Bexley' }, status: 'doubted' });
  assert.match(linked, /^ContainedIn: <a href="#" data-place="https:\/\/example.org\/p\/b">Bexley<\/a> <span class="status status-doubted"/);
  // A name is the dataset's text, never markup.
  assert.equal(relationItem({ typeLabel: 'ContainedIn', label: '<img src=x onerror=alert(1)>', related: null, status: 'asserted' }), 'ContainedIn: &lt;img src=x onerror=alert(1)&gt;');
  // From the view: the Trismegistos shape, a name with no address.
  const v = viewPlace({ label: 'Agathos Daimon', attestations: [{ relations: [{ relationType: P + 'ContainedIn', relatedLabel: 'the Delta', relationLabel: 'in the Delta' }] }] });
  assert.deepEqual(v.relations.map(relationItem), ['ContainedIn: the Delta']);
});

test('#20: the timeline writes an evidence span as "mentioned in texts dated", hatched, with a legend only when one is there', () => {
  const claim = row({ start: '0100', end: '0200' });
  const ev = row({ facet: 'evidence', text: '', start: '0015', end: '0540', label: 'AD 15 - AD 540', evidence: true });
  const both = timeline([ev, claim]);
  assert.match(both, /mentioned in texts dated 15–540/);
  assert.match(both, /data-tip="Mentioned in texts dated AD 15 - AD 540"/);
  assert.match(both, /<rect [^>]*class="tl-evidence" style="fill: url\(#tl-hatch-asserted\); stroke: var\(--status-asserted\)"/);
  // In the theme's colours (--status-…, styles.css), never a fixed one, so that it follows Light and Dark.
  assert.match(both, /<rect [^>]*class="tl-bar tl-asserted"/);
  assert.match(both, /<line [^>]*style="stroke: var\(--status-asserted\)"/);
  assert.doesNotMatch(both, /#[0-9a-f]{6}/i);
  assert.match(both, /<pattern id="tl-hatch-asserted"/);
  assert.match(both, /class="tl-legend"/);
  assert.equal((both.match(/<rect /g) || []).length, 3, 'two bars and the legend\'s swatch');
  // The claim beside it is a solid bar, written with its own date, and not as a mention.
  assert.match(both, /Agathos Daimon · 100–200/);
  assert.doesNotMatch(both, /Agathos Daimon[^<]*mentioned/);
  // With no evidence span: no hatching, no legend, the bar still drawn.
  const alone = timeline([claim]);
  assert.match(alone, /class="tl-bar tl-asserted"/);
  const doubted = timeline([row({ start: '0100', end: '0200', status: 'doubted' }), row({ facet: 'evidence', text: '', start: '0015', end: '0540', status: 'doubted', evidence: true })]);
  assert.match(doubted, /class="tl-bar tl-doubted" fill-opacity=".45" stroke-dasharray="2 1"/);
  assert.match(doubted, /<pattern id="tl-hatch-doubted"[^]*?var\(--status-doubted\)/);
  assert.doesNotMatch(doubted, /#[0-9a-f]{6}/i);
  assert.equal((alone.match(/<rect /g) || []).length, 1);
  assert.doesNotMatch(alone, /tl-hatch|tl-legend|mentioned in texts/);
});

test('#20: an evidence span given only in words is written as a mention too, and a claim in words is not', () => {
  const out = timeline([row({ facet: 'evidence', text: '', label: 'Ptolemaic', evidence: true }), row({ label: 'undated' })]);
  assert.equal(out, `<p class="muted">Dated only in words: mentioned in texts dated “Ptolemaic”, “undated”.</p>`);
});

test('esc writes every character markup could use as text', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
});

test('#19: a location relative to other places is a line under Locations, its anchors linked when they are places of the dataset', () => {
  const between = { qualifierLabel: 'between', anchors: [{ id: 'https://example.org/p/assuan', label: 'Assuan', place: true }, { id: 'https://www.trismegistos.org/place/1767', label: '1767', place: false }], distance: null, bearing: null, status: 'asserted', timespan: null };
  assert.equal(relativeItem(between), 'between <a href="#" data-place="https://example.org/p/assuan">Assuan</a> and 1767 <span class="muted">(relative; not drawn)</span>');
  const near = { qualifierLabel: 'near', anchors: [{ id: 'x', label: '<i>X</i>', place: false }], distance: 1500, bearing: 45, status: 'denied', timespan: null };
  assert.match(relativeItem(near), /^near &lt;i&gt;X&lt;\/i&gt; <span class="muted">\(1\.5 km away; bearing 45°; relative; not drawn\)<\/span> <span class="status status-denied"/);
  assert.equal(relativeItem({ ...near, anchors: [{ id: 'x', label: 'A' }, { id: 'y', label: 'B' }, { id: 'z', label: 'C' }], distance: 500, bearing: null, status: 'asserted' }), 'near A, B and C <span class="muted">(500 m away; relative; not drawn)</span>');
  // The list: a drawn location and a relative one together; and with neither, none recorded.
  const v = { geometries: [{ geojson: { type: 'Point' }, role: null, precision: null, precisionKm: null, timespan: null, status: 'asserted' }], relative: [between] };
  const html = locations(v);
  assert.match(html, /^<ul><li>Point<\/li><li>between <a /);
  assert.equal(locations({ geometries: [], relative: [] }), '<p class="muted">None recorded.</p>');
  assert.equal(locations({ geometries: v.geometries, relative: [] }), '<ul><li>Point</li></ul>', 'the control: no relative line where there is none');
});
