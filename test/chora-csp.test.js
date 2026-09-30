// Chora's hard block (src/chora/csp-head.js): a Content Security Policy in a <meta> tag, written by
// the first script in chora.html's <head> from the sites the user has agreed to, so that nothing on
// the page, a map's tile workers included, can ask any other site for anything. These tests run the
// head script as the browser does (a classic script, no imports) against a stand-in document and
// storage; the browser checks (e2e/app_test.py) show the policy holding in Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { choraCspPlugin, HEAD_MARK } from '../scripts/vite-chora-csp.mjs';

const SOURCE = readFileSync('src/chora/csp-head.js', 'utf8');

function storage(items = {}) {
  const m = new Map(Object.entries(items).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
/** Run the head script in a stand-in page; returns what it put in <head>, and what it published. */
function runHead(items, { throwing = false } = {}) {
  const inserted = [];
  const head = { prepend: (el) => inserted.unshift(el), firstChild: null };
  const document = { head, createElement: (tag) => ({ tagName: tag.toUpperCase(), setAttribute(k, v) { this[k] = v; } }) };
  const window = {};
  const localStorage = throwing ? { getItem() { throw new Error('storage refused'); } } : storage(items);
  vm.runInNewContext(SOURCE, { window, document, localStorage });
  // Copied out of the other realm, so that deepEqual compares values, not realms.
  return { meta: inserted[0], inserted, published: JSON.parse(JSON.stringify(window.__choraCsp)) };
}
/** The policy as {directive: [values]}. */
const parse = (p) => Object.fromEntries(p.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

test('with nothing agreed to, the policy lets the page reach this site alone, and its workers run only from here or from blob:', () => {
  const { meta, inserted, published } = runHead({});
  assert.equal(inserted.length, 1);
  assert.equal(meta.tagName, 'META');
  assert.equal(meta['http-equiv'], 'Content-Security-Policy');
  const p = parse(meta.content);
  assert.deepEqual(p['default-src'], ["'self'"]);
  assert.deepEqual(p['connect-src'], ["'self'", 'data:', 'blob:']);
  assert.deepEqual(p['img-src'], ["'self'", 'data:', 'blob:']);
  assert.deepEqual(p['worker-src'], ["'self'", 'blob:']);
  assert.deepEqual(p['object-src'], ["'none'"]);
  // No site but this one anywhere in it: nothing that looks like an address.
  assert.doesNotMatch(meta.content, /https?:/);
  assert.deepEqual(published.origins, []);
  assert.equal(published.policy, meta.content);
});

test('each site agreed to, of any kind, may be connected to and give images; an old basemap consent counts too', () => {
  const { meta, published } = runHead({
    'chora-consent': [{ origin: 'https://iiif.example.org', kind: 'iiif' }, { origin: 'https://annotations.allmaps.org', kind: 'allmaps' }, { origin: 'http://127.0.0.1:47941', kind: 'iiif' }],
    'chora-basemap-consent': ['https://tiles.openfreemap.org'],
  });
  const p = parse(meta.content);
  for (const o of ['https://iiif.example.org', 'https://annotations.allmaps.org', 'http://127.0.0.1:47941', 'https://tiles.openfreemap.org']) {
    assert.ok(p['connect-src'].includes(o), `${o} in connect-src`);
    assert.ok(p['img-src'].includes(o), `${o} in img-src`);
    assert.ok(!p['worker-src'].includes(o), `${o} not in worker-src`);
    assert.ok(!(p['script-src'] || []).includes(o), `${o} not in script-src`);
  }
  assert.equal(published.origins.length, 4);
});

test('anything that is not a plain origin is left out of the policy, so a stored value cannot write a directive', () => {
  const hostile = ["https://a.example.org; script-src *", 'https://b.example.org/path', '*', "'unsafe-eval'", 'javascript:alert(1)', 'https://c.example.org ', 'https://*.example.org', 'ftp://d.example.org', 'https://E.example.org', 42, null];
  const { meta, published } = runHead({ 'chora-consent': [...hostile.map((origin) => ({ origin, kind: 'iiif' })), { origin: 'https://ok.example.org', kind: 'iiif' }] });
  const p = parse(meta.content);
  // The control: the one plain origin is in, so the filter is not simply refusing everything.
  assert.ok(p['connect-src'].includes('https://ok.example.org'));
  assert.deepEqual(published.origins, ['https://ok.example.org']);
  assert.deepEqual(Object.keys(p).filter((k) => k === 'script-src').length, 1);
  assert.doesNotMatch(meta.content, /\*|unsafe-eval|javascript|path|ftp|E\.example/);
});

test('storage that cannot be read gives the policy of nothing agreed to, not no policy (it fails closed)', () => {
  const { meta, published } = runHead({}, { throwing: true });
  assert.ok(meta, 'a policy is still written');
  assert.deepEqual(parse(meta.content)['connect-src'], ["'self'", 'data:', 'blob:']);
  assert.deepEqual(published.origins, []);
  // Garbage in storage, the same.
  const g = runHead({ 'chora-consent': '{not json', 'chora-basemap-consent': '"a string"' });
  assert.deepEqual(g.published.origins, []);
});

test('the Vite plugin puts the head script inline, first in <head> of chora.html, and leaves other pages alone', () => {
  const html = readFileSync('chora.html', 'utf8');
  assert.ok(html.includes(HEAD_MARK), 'chora.html marks where the policy goes');
  const plugin = choraCspPlugin();
  const out = plugin.transformIndexHtml.handler(html, { filename: '/x/chora.html' });
  assert.ok(!out.includes(HEAD_MARK));
  const head = out.slice(out.indexOf('<head>'), out.indexOf('</head>'));
  // Nothing that fetches comes before it: only the charset and viewport metas.
  const before = head.slice(0, head.indexOf('<script'));
  assert.doesNotMatch(before, /<link|<script|<style|<img|<base/i);
  const script = head.slice(head.indexOf('<script>') + 8, head.indexOf('</script>'));
  assert.equal(script.trim(), SOURCE.trim());
  // Classic, not a module: a module script would run only after the page is parsed.
  assert.match(head, /<script>/);
  // Another page is untouched; and a chora.html without the mark is an error, not a page without the block.
  assert.equal(plugin.transformIndexHtml.handler('<head></head>', { filename: '/x/index.html' }), '<head></head>');
  assert.throws(() => plugin.transformIndexHtml.handler('<head></head>', { filename: '/x/chora.html' }), /chora\.html/);
});
