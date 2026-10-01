// The IIIF helpers that index.js re-exports from iiif.js as public API: each is the same function,
// and each behaves as documented (with a control beside every check of an absence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as index from '../src/engine/georef/index.js';
import * as iiif from '../src/engine/georef/iiif.js';

const fixture = (f) => JSON.parse(readFileSync('test/fixtures/georef/' + f, 'utf8'));
const NAMES = ['normaliseId', 'manifestCanvases', 'partOfCanvases', 'labelText', 'parseImageRequest'];

test('index.js exports each IIIF helper, and it is the very function iiif.js defines', () => {
  for (const n of NAMES) {
    assert.equal(typeof index[n], 'function', `${n} is exported by index.js`);
    assert.equal(index[n], iiif[n], `${n} is iiif.js's own`);
  }
  // Control: the identity check tells two different functions apart, and an internal helper of
  // iiif.js that is not public is not exported.
  assert.notEqual(index.normaliseId, iiif.labelText);
  assert.equal(typeof iiif.imageRequestFrameChange, 'function');
  assert.equal(index.imageRequestFrameChange, undefined);
});

test('normaliseId takes off a trailing info.json and slash; another id stays different', () => {
  const id = 'https://iiif.digitalcommonwealth.org/iiif/2/commonwealth:8623qf00m';
  assert.equal(index.normaliseId(` ${id}/info.json `), id);
  assert.equal(index.normaliseId(`${id}/`), id);
  assert.equal(index.normaliseId(42), undefined);
  assert.notEqual(index.normaliseId(`${id}x/info.json`), id); // control
});

test('manifestCanvases lists the Rocque canvas with its size and image service; an empty manifest has none', () => {
  const all = index.manifestCanvases(fixture('bpl-rocque-manifest.json'));
  const c = all.find((x) => x.id === 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/8623qf00m');
  assert.ok(c, `found among ${all.map((x) => x.id)}`);
  assert.deepEqual([c.width, c.height], [11436, 6268]);
  assert.deepEqual(c.services, ['https://iiif.digitalcommonwealth.org/iiif/2/commonwealth:8623qf00m']);
  assert.deepEqual(index.manifestCanvases({ type: 'Manifest', items: [] }), []); // control: none where there are none
});

test("partOfCanvases reads the Rocque annotation's canvas and manifest; a source with no partOf gives none", () => {
  const source = fixture('bpl-rocque-annotation.json').target.source;
  const [p] = index.partOfCanvases(source);
  assert.equal(p.id, 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/canvas/8623qf00m');
  assert.equal(p.manifestId, 'https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/manifest');
  assert.deepEqual(index.partOfCanvases({ ...source, partOf: undefined }), []); // control
});

test('labelText prefers English in a language map; an empty label is undefined', () => {
  assert.equal(index.labelText({ fr: ['Carte'], en: ['Map'] }), 'Map');
  assert.equal(index.labelText([{ '@value': 'Plate 7' }]), 'Plate 7');
  assert.equal(index.labelText({ en: [''] }), undefined);
  assert.equal(index.labelText({ none: ['x'] }), 'x'); // control: a non-empty map does give text
});

test('parseImageRequest takes an image request apart; a service id alone is not one', () => {
  const service = 'https://iiif.example.org/iiif/2/abc';
  assert.deepEqual(index.parseImageRequest(`${service}/full/max/0/default.jpg`),
    { service, region: 'full', size: 'max', rotation: '0', quality: 'default', format: 'jpg' });
  assert.equal(index.parseImageRequest(service), undefined);
  assert.equal(index.parseImageRequest(`${service}/full/max/0/default.bmp`), undefined); // not a format
});
