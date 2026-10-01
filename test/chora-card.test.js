// Chora's place card as text (src/chora/card.js): what the card writes for a relation and for the
// timeline, from the view (src/engine/chora/view.js). Pure: no page, no map. Each absence asserted
// here has its presence beside it, so that none of these checks could pass by writing nothing.
import { PLATO_REPO } from './paths.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relationItem, timeline, esc, relativeItem, locations, nameItem } from '../src/chora/card.js';
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

test('#21, #22: a name is written with its language, its romanised form and system, and what it denotes where that is not a toponym alone', () => {
  const name = (o) => nameItem({ toponym: 'x', language: null, script: null, romanized: null, transliterationSystem: null, nameType: null, status: 'asserted', ...o });
  assert.equal(name({}), 'x', 'the control: nothing is added where nothing is given');
  assert.equal(name({ language: 'grc', script: 'Grek' }), 'x <span class="muted">(grc)</span>', 'the language tag, which already says the script');
  assert.equal(name({ script: 'Grek' }), 'x <span class="muted">(Grek)</span>', 'the script where there is no language');
  assert.equal(name({ language: 'egy-Latn-t-egy-egyd', transliterationSystem: 'Egyptological transliteration' }), 'x <span class="muted">(egy-Latn-t-egy-egyd)</span> <span class="muted">in Egyptological transliteration</span>');
  assert.equal(name({ romanized: 'Athenai', transliterationSystem: 'ISO 843' }), 'x <span class="muted">Athenai (ISO 843)</span>', 'with a romanised form, the system is that form\'s');
  assert.equal(name({ romanized: 'Athenai' }), 'x <span class="muted">Athenai</span>');
  assert.equal(name({ nameType: ['toponym'] }), 'x', 'a toponym alone is what a name is taken to be');
  assert.equal(name({ nameType: ['toponym', 'ethnonym'] }), 'x <span class="muted">toponym, ethnonym</span>');
  assert.equal(name({ nameType: ['demonym'], status: 'doubted' }), 'x <span class="muted">demonym</span> <span class="status status-doubted" data-tip="The source reports this, and doubts it.">doubted</span>');
  // Each is the dataset's text, never markup.
  assert.equal(name({ toponym: '<b>', language: '<i>', romanized: '<u>', transliterationSystem: '<s>', nameType: ['<em>'] }), '&lt;b&gt; <span class="muted">(&lt;i&gt;)</span> <span class="muted">&lt;u&gt; (&lt;s&gt;)</span> <span class="muted">&lt;em&gt;</span>');
});

// ---- PLATO's own example of #18 to #22, schemas/examples/place-centric-trismegistos.json at the pinned
// commit, through the view and then each card function, with the expected words taken from the example
// and named here. The lookup knows the example's own places, as the store's does. ------------------
const TM = `${PLATO_REPO}/schemas/examples/place-centric-trismegistos.json`;
const example = () => JSON.parse(readFileSync(TM, 'utf8'));
const lookupOf = (ex) => (x) => { const e = ex.spatialEntities.find((p) => p['@id'] === x); return e ? { id: e['@id'], label: e.label, reprPoint: null, bbox: null } : null; };
const place = (ex, label) => { const e = ex.spatialEntities.find((x) => x.label === label); assert.ok(e, `${label} is in the example`); return viewPlace(e, { lookup: lookupOf(ex) }); };
const facet = (ex, label, frag) => { const e = ex.spatialEntities.find((x) => x.label === label); const a = e.attestations.find((x) => x['@id'] === `${e['@id']}#${frag}`); assert.ok(a, `${label}#${frag} is in the example`); return a; };

test('Trismegistos #18: the card writes "the Delta" as text, and Aegyptus, a place of the dataset, as a link to it', () => {
  const ex = example();
  assert.equal(facet(ex, 'Agathos Daimon', 'delta').relations[0].relatedLabel, 'the Delta');
  assert.deepEqual(place(ex, 'Agathos Daimon').relations.map(relationItem), ['ContainedIn: the Delta']);
  const aegyptus = facet(ex, 'Setis', 'province').relations[0].relatesTo;
  assert.equal(aegyptus, 'https://example.org/plato-examples/trismegistos/province/Aegyptus');
  assert.deepEqual(place(ex, 'Setis').relations.map(relationItem), [`ContainedIn: <a href="#" data-place="${aegyptus}">Aegyptus</a>`]);
  assert.deepEqual(place(ex, 'Agrianes').relations.map(relationItem), ['ContainedIn: <a href="#" data-place="https://example.org/plato-examples/trismegistos/province/Thracia">Thracia</a>']);
});

test('Trismegistos #19: under Locations, Setis has its point and a line "between 2207 and 1767", Agrianes "near 11828", the anchors as text since they are not places of the dataset', () => {
  const ex = example();
  const between = facet(ex, 'Setis', 'between').geometries[0].qualification;
  assert.deepEqual(between.relativeTo.map((x) => x.split('/').pop()), ['2207', '1767'], 'the anchors in the example');
  assert.equal(locations(place(ex, 'Setis')), '<ul><li>Point</li><li>between 2207 and 1767 <span class="muted">(relative; not drawn)</span></li></ul>');
  assert.equal(facet(ex, 'Agrianes', 'valley').geometries[0].qualification.relativeTo.split('/').pop(), '11828');
  assert.equal(locations(place(ex, 'Agrianes')), '<ul><li>near 11828 <span class="muted">(relative; not drawn)</span></li></ul>');
  // The control, with the same lookup: an anchor that IS a place of the dataset is a link, as Aegyptus is under Related places.
  const doctored = structuredClone(ex);
  facet(doctored, 'Agrianes', 'valley').geometries[0].qualification.relativeTo = 'https://example.org/plato-examples/trismegistos/province/Thracia';
  assert.equal(locations(place(doctored, 'Agrianes')), '<ul><li>near <a href="#" data-place="https://example.org/plato-examples/trismegistos/province/Thracia">Thracia</a> <span class="muted">(relative; not drawn)</span></li></ul>');
  assert.equal(locations(place(ex, 'Aegyptus')), '<p class="muted">None recorded.</p>');
});

test('Trismegistos #20: each window is a hatched mention on the timeline, "BC 144 - AD 99" in the tip, with the legend; a province has no dates', () => {
  const ex = example();
  const expected = { Setis: ['BC 144 - AD 99', '-144–99'], 'Agathos Daimon': ['AD 15 - AD 540', '15–540'], Agrianes: ['BC 236 - AD 75', '-236–75'] };
  for (const [label, [words, years]] of Object.entries(expected)) {
    assert.equal(facet(ex, label, 'window').timespans[0].sourceLabel, words, `${label}'s window in the example`);
    const tl = timeline(place(ex, label).timeline);
    assert.match(tl, new RegExp(`class="tl-text">mentioned in texts dated ${years}</text>`), label);
    assert.match(tl, new RegExp(`data-tip="Mentioned in texts dated ${esc(words)}"`), label);
    assert.equal((tl.match(/class="tl-evidence"/g) || []).length, 1, label);
    assert.equal((tl.match(/<rect /g) || []).length, 2, `${label}: the one bar and the legend's swatch`);
    assert.match(tl, /class="tl-legend"/, label);
  }
  assert.equal(timeline(place(ex, 'Thracia').timeline), '<p class="muted">No dates recorded.</p>');
  // The control: the same window with no role is a claim's bar, solid, not a mention.
  const doctored = structuredClone(ex);
  delete facet(doctored, 'Setis', 'window').timespanRole;
  const tl = timeline(place(doctored, 'Setis').timeline);
  assert.match(tl, /-144–99/);
  assert.doesNotMatch(tl, /mentioned|tl-evidence|tl-legend/);
  assert.equal((tl.match(/<rect /g) || []).length, 1);
});

test('Trismegistos #21, #22: the Demotic name is written as in Egyptological transliteration, and the names of the Agrianes with what they denote', () => {
  const ex = example();
  const stt = facet(ex, 'Setis', 'names').names.find((n) => n.transliterationSystem);
  assert.deepEqual([stt.toponym, stt.language, stt.transliterationSystem], ['Sṯt', 'egy-Latn-t-egy-egyd', 'Egyptological transliteration'], 'the Demotic name in the example');
  assert.deepEqual(place(ex, 'Setis').names.map(nameItem), [
    'Setis',
    'Σητις <span class="muted">(grc)</span>',
    'Διονύσου Νῆσος <span class="muted">(grc)</span>',
    'Κρόνου Ἐμπόριον <span class="muted">(grc)</span>',
    'Sṯt <span class="muted">(egy-Latn-t-egy-egyd)</span> <span class="muted">in Egyptological transliteration</span>',
  ]);
  assert.deepEqual(facet(ex, 'Agrianes', 'names').names.map((n) => n.nameType), [['toponym', 'ethnonym'], ['toponym', 'ethnonym'], ['demonym'], ['demonym']], 'what each name denotes, in the example');
  assert.deepEqual(place(ex, 'Agrianes').names.map(nameItem), [
    'Agrianes <span class="muted">toponym, ethnonym</span>',
    'Agriani <span class="muted">(la)</span> <span class="muted">toponym, ethnonym</span>',
    'Ἀγρίανες <span class="muted">(grc)</span> <span class="muted">toponym, ethnonym</span>',
    'Agrian <span class="muted">demonym</span>',
    'Agrianus <span class="muted">demonym</span>',
  ]);
  // A HomelandOf relation (#22) is written as any relation is, by its type's name.
  assert.equal(relationItem({ typeLabel: 'HomelandOf', type: P + 'HomelandOf', label: 'the Agrianes', relatesTo: 'https://example.org/people/agrianes', related: null, status: 'asserted' }), 'HomelandOf: the Agrianes');
});
