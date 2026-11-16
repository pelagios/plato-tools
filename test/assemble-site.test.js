// The site put together for plato.pelagios.org (scripts/assemble-site.mjs): PLATO's published site at the
// root with every path kept, the tools under tools/, and the two pages for the tools' former addresses.
// What those pages do in a browser is checked in e2e/app_test.py (site_layout_checks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, rootPage, goesToTheSpecification, ROOT_PAGE, FORWARD_SCRIPT, NOT_FOUND_PAGE } from '../scripts/assemble-site.mjs';

const OLD = '<!DOCTYPE html>\n<html><head>\n<meta http-equiv="refresh" content="0; url=index-en.html">\n</head><body>\n<p>Redirecting to <a href="index-en.html">documentation</a>...</p>\n</body></html>';
const NEW = '<!DOCTYPE html>\n<html><head><script>location.replace(location.hash ? "index-en.html" + location.hash : "guide/")</script></head><body><a href="guide/">guide</a></body></html>';

function fixture(index) {
  const dir = mkdtempSync(join(tmpdir(), 'plato-site-'));
  const plato = join(dir, 'plato'), dist = join(dir, 'dist'), out = join(dir, 'out');
  mkdirSync(join(plato, 'guide'), { recursive: true }); mkdirSync(join(plato, '.git')); mkdirSync(join(dist, 'spike'), { recursive: true });
  writeFileSync(join(plato, '.git', 'HEAD'), 'ref');
  writeFileSync(join(plato, 'guide', 'index.html'), 'GUIDE'); writeFileSync(join(plato, 'index-en.html'), 'SPEC'); writeFileSync(join(plato, 'ontology.ttl'), 'TTL');
  if (index != null) writeFileSync(join(plato, 'index.html'), index);
  writeFileSync(join(dist, 'index.html'), 'TOOLS'); writeFileSync(join(dist, 'spike', 'index.html'), 'SPIKE');
  return { dir, plato, dist, out };
}

test('the root page: PLATO\'s own with the forwarding first in it, or written here while PLATO\'s still goes to index-en.html', () => {
  assert.equal(goesToTheSpecification(OLD), true);
  assert.equal(goesToTheSpecification(NEW), false);
  assert.equal(rootPage(OLD), ROOT_PAGE);
  assert.equal(rootPage(null), ROOT_PAGE);
  assert.equal(rootPage(NEW), '<!DOCTYPE html>' + FORWARD_SCRIPT + NEW.slice('<!DOCTYPE html>'.length));
  for (const page of [ROOT_PAGE, FORWARD_SCRIPT]) for (const k of ['chora', 'tool', 'methodos', 'whg-shared']) assert.ok(page.includes(`k.has('${k}')`), k);
  assert.match(ROOT_PAGE, /'index-en\.html'\+h:'guide\/'/);
  for (const page of [ROOT_PAGE, FORWARD_SCRIPT, NOT_FOUND_PAGE]) assert.doesNotMatch(page, /pelagios\.org/, 'no address is written into the pages: they work wherever the site is');
});

test('the site: every path of PLATO\'s as it is, the tools under tools/, a 404 page, and nothing of the checkout\'s .git', () => {
  const f = fixture(NEW);
  try {
    assemble(f.plato, f.dist, f.out);
    const read = (p) => readFileSync(join(f.out, p), 'utf8');
    assert.equal(read('guide/index.html'), 'GUIDE'); assert.equal(read('index-en.html'), 'SPEC'); assert.equal(read('ontology.ttl'), 'TTL');
    assert.equal(read('tools/index.html'), 'TOOLS'); assert.equal(read('tools/spike/index.html'), 'SPIKE');
    assert.equal(read('404.html'), NOT_FOUND_PAGE); assert.equal(read('index.html'), rootPage(NEW));
    assert.equal(existsSync(join(f.out, '.git')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('the site is refused when PLATO\'s has a path this site\'s own would replace, or is not the site expected', () => {
  const f = fixture(OLD);
  try {
    mkdirSync(join(f.plato, 'tools'));
    assert.throws(() => assemble(f.plato, f.dist, f.out), /has a tools of its own/);
    rmSync(join(f.plato, 'tools'), { recursive: true }); rmSync(join(f.plato, 'ontology.ttl'));
    assert.throws(() => assemble(f.plato, f.dist, f.out), /has no ontology\.ttl/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
