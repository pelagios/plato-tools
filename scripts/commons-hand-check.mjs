// Writes the two files to put on Wikimedia Commons by hand (#39), to check what no test here can: that Commons' own
// renderer draws polytonic Greek (librsvg 2.60; the local test runs 2.52) and that the {{Map}} template takes the
// fields as the tools fill them. From the golden map (test/fixtures/chora/export/golden.svg: Ἀθῆναι, Ἐλευσίς and the
// rest, in Noto Sans with DejaVu Sans after it, as Commons has them).
//   node scripts/commons-hand-check.mjs [outdir]       (default ./commons-hand-check/)
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { filePage } from '../src/engine/chora/export/commons.js';
import { composeLicence } from '../src/engine/chora/export/licence.js';

const out = process.argv[2] || 'commons-hand-check';
mkdirSync(out, { recursive: true });
const svg = readFileSync(new URL('../test/fixtures/chora/export/golden.svg', import.meta.url), 'utf8');
writeFileSync(`${out}/Attica-test-map.svg`, svg);
const NE = { name: 'Natural Earth', role: 'background', licence: { iri: 'https://creativecommons.org/publicdomain/mark/1.0/', credit: 'Natural Earth' }, templates: ['{{Natural Earth}}'] };
const page = filePage({
  title: 'Attica (test of the PLATO tools map)', description: 'A test file: places of ancient Attica with Greek labels, made with the PLATO tools. Please delete after checking.', lang: 'en',
  legend: 'Red dots: places; dotted circles: how far each may be from its point.', author: { name: 'Ada Lovelace' }, date: '2026-10-31', projection: 'mercator',
  bounds: [22.9, 37.5, 24.4, 38.7], scaleWords: 'scale bar, true at latitude 38° N', sources: ['Made with PLATO tools, https://pelagios.org/plato-tools/'],
  residuals: [], warp: null, licence: composeLicence({ parts: [NE] }), format: 'svg', rasterInSvg: false, otherVersions: [],
});
writeFileSync(`${out}/Attica-test-map.description.txt`, page);
console.log(`${out}/Attica-test-map.svg and ${out}/Attica-test-map.description.txt`);
