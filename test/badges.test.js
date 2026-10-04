// The README's badges are static SVG files made from CITATION.cff by scripts/badges.mjs, run at
// each release. The committed files must be what the script makes now, so that a release that
// changes the version or the DOI cannot leave the badges behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { badges, citation } from '../scripts/badges.mjs';

const root = (p) => new URL(`../${p}`, import.meta.url);
const cff = readFileSync(root('CITATION.cff'), 'utf8');

test('the committed badges are what scripts/badges.mjs makes from CITATION.cff', () => {
  const made = badges(cff);
  assert.deepEqual(Object.keys(made).sort(), ['doi.svg', 'status.svg', 'version.svg']);
  for (const [f, svg] of Object.entries(made)) assert.equal(readFileSync(root(`badges/${f}`), 'utf8'), svg, `badges/${f} is out of date: run node scripts/badges.mjs`);
});

test('the badges carry the version and the concept DOI from CITATION.cff, and the README shows them', () => {
  const { version, doi } = citation(cff);
  assert.equal(version, JSON.parse(readFileSync(root('package.json'), 'utf8')).version);
  assert.equal(doi, '10.5281/zenodo.23133141');
  const made = badges(cff);
  assert.match(made['version.svg'], new RegExp(`>${version.replace(/\./g, '\\.')}</text>`));
  assert.match(made['doi.svg'], new RegExp(`>${doi.replace(/\./g, '\\.')}</text>`));
  assert.match(made['status.svg'], />experimental<\/text>/);
  // A different version makes a different badge, so the first test can fail.
  assert.notEqual(badges(cff.replace(/^version: .*$/m, 'version: 9.9.9'))['version.svg'], made['version.svg']);
  const readme = readFileSync(root('README.md'), 'utf8');
  for (const f of ['doi', 'status', 'version']) assert.ok(readme.includes(`](badges/${f}.svg)`), f);
  assert.ok(readme.includes(`(https://doi.org/${doi})`));
  assert.match(readme, /<a id="status"><\/a>\*\*Status: experimental — under development; not yet in beta testing\.\*\*/);
});
