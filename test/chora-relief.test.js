// The shaded relief over Natural Earth (#37): toned so that flat ground keeps the basemap's own colour, a shadow
// darkens and a lit slope lightens; its tiles let through MapLibre's guard by their own protocol alone; its file
// named by a committed sha256, and its rebuild scripts kept beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { toneOf, toneRelief, FLAT, TOLERANCE, RELIEF } from '../src/engine/chora/relief.js';
import { licenceTerms } from '../src/engine/agora/licence.js';
import * as permissions from '../src/lib/permissions.js';

test('flat ground is transparent (grey 181, and 182 as WebP decodes it); a shadow is dark and a lit slope white, more so the further from flat', () => {
  for (const g of [FLAT - TOLERANCE, FLAT, FLAT + 1, FLAT + TOLERANCE]) assert.equal(toneOf(g)[3], 0, `grey ${g}`);
  const dark = toneOf(60), darker = toneOf(10), light = toneOf(230), lighter = toneOf(255);
  assert.ok(dark[3] > 0 && darker[3] > dark[3], `${dark} ${darker}`);
  assert.ok(dark[0] < 100 && dark[1] < 100 && dark[2] < 100, 'a shadow is dark');
  assert.deepEqual(light.slice(0, 3), [255, 255, 255]); assert.ok(light[3] > 0 && lighter[3] > light[3]);
  assert.ok(lighter[3] < darker[3], 'light is gentler than shade');
  // A tile's pixels toned in place, by their grey; one already transparent stays so.
  const px = Uint8ClampedArray.from([182, 182, 182, 255, 40, 40, 40, 255, 250, 250, 250, 255, 40, 40, 40, 0]);
  toneRelief(px);
  assert.equal(px[3], 0); assert.ok(px[7] > 100); assert.equal(px[8], 255); assert.ok(px[11] > 50); assert.equal(px[15], 0);
});

test('the relief is the public domain\'s, and says so for Commons; its file is named by the sha256 committed beside it', () => {
  assert.equal(licenceTerms(RELIEF.licence.iri).pd, true);
  assert.deepEqual(RELIEF.templates, ['{{PD-USGov-NASA-SRTM}}', '{{PD-USGov-USGS}}']);
  assert.equal(RELIEF.attribution, 'Shaded relief from NASA SRTM (public domain); USGS GMTED2010 (public domain)');
  assert.match(readFileSync('public/basemap/relief.pmtiles.sha256', 'utf8'), /^[0-9a-f]{64} {2}relief\.pmtiles\n$/);
  for (const f of ['build.sh', 'fetch_sources.sh', 'tile.py', 'scale_dem.py', 'grid.py', 'metadata.py', 'MANIFEST.tsv']) assert.ok(existsSync(`scripts/relief/${f}`), f);
  // Not in the repository: ignored, and the Pages workflow puts it in the site, checked.
  assert.match(readFileSync('.gitignore', 'utf8'), /^public\/basemap\/relief\.pmtiles$/m);
  const pages = readFileSync('.github/workflows/pages.yml', 'utf8');
  assert.match(pages, /releases\/download\/relief-v1\/relief\.pmtiles/);
  assert.match(pages, /relief\.pmtiles\.sha256/); assert.match(pages, /dist\/basemap\/relief\.pmtiles/);
});

test('the browser checks\' stand-in for the relief file is a PMTiles file pmtiles 4.3.0 reads: WebP tiles, zooms 0 to 7 over the Aegean, none elsewhere', async () => {
  const { PMTiles } = await import('pmtiles');
  const buf = readFileSync('test/fixtures/chora/relief/relief-fixture.pmtiles');
  const p = new PMTiles({ getKey: () => 'fixture', getBytes: async (o, n) => ({ data: buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + n) }) });
  const h = await p.getHeader();
  assert.deepEqual([h.tileType, h.minZoom, h.maxZoom, h.minLon, h.maxLat], [4, 0, 7, 19, 42]);
  const t = await p.getZxy(7, 72, 49);
  assert.ok(t && Buffer.from(t.data.slice(0, 4)).toString() === 'RIFF' && Buffer.from(t.data.slice(8, 12)).toString() === 'WEBP');
  assert.equal(await p.getZxy(7, 10, 10), undefined, 'none outside the Aegean');
  assert.equal((await p.getMetadata()).attribution, RELIEF.attribution);
});

test('MapLibre\'s guard lets the relief\'s own protocol through, a tile address of it only; the control: another site is refused', () => {
  globalThis.location ??= { href: 'https://pelagios.org/plato-tools/', origin: 'https://pelagios.org' };
  const blocked = [];
  const tr = permissions.transformRequest(() => [], { onBlocked: (o) => blocked.push(o) });
  assert.deepEqual(tr('plato-relief://7/72/49'), { url: 'plato-relief://7/72/49' });
  for (const bad of ['plato-relief://evil.example.org/7/72/49', 'plato-relief://7/72/49?x=https://evil.example.org', 'https://tiles.example.org/7/72/49.png']) assert.throws(() => tr(bad), /Refused a request/, bad);
  assert.equal(blocked.length, 3);
});
