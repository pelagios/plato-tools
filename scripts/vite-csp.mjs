// A Vite plugin that puts the hard block into index.html and chora.html, inline, where each page marks
// it: the first script in its <head>, so that the Content Security Policy it writes is in force before
// the page requests anything. In the dev server and in the build alike. The script is the pure core of
// the permissions (src/lib/permissions-core.js) with its `export`s removed, then src/lib/csp-head.js,
// in a function of their own: one source for what a permission allows, in the page and in the policy.
// A page without the mark is an error, never a page served without the block.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HEAD_MARK = '<!-- plato:csp -->';
const CORE = fileURLToPath(new URL('../src/lib/permissions-core.js', import.meta.url));
const HEAD = fileURLToPath(new URL('../src/lib/csp-head.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Every page the site serves: the two pages of the tools, and the spike's page, which is no part of the
// tools but shares their address, and so their storage. A page left out would be a page of this site
// without the block.
const PAGES = ['index.html', 'chora.html', 'spike/index.html'].map((p) => ROOT + p);

/** The inline script: the core, as a classic script, and the head's own code, in one function. */
export function headScript() {
  const core = readFileSync(CORE, 'utf8');
  if (/^\s*(import\b|export\s*\{|export\s+default\b)/m.test(core)) throw new Error('src/lib/permissions-core.js must have no imports, no export lists and no default export: it is put into each page as a classic script');
  const plain = core.replace(/^export\s+(const|function|class|let)\s/gm, '$1 ');
  if (/^\s*export\b/m.test(plain)) throw new Error('src/lib/permissions-core.js has an export the build cannot remove');
  return `(function () {\n'use strict';\n${plain.trim()}\n${readFileSync(HEAD, 'utf8').trim()}\n})();`;
}

export function cspPlugin() {
  return {
    name: 'plato-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const file = ctx?.filename || '';
        if (!PAGES.includes(file.replace(/\\/g, '/'))) return html;
        if (!html.includes(HEAD_MARK)) throw new Error(`${file} has no ${HEAD_MARK} in its <head>, so its Content Security Policy would not be written`);
        return html.replace(HEAD_MARK, `<script>\n${headScript()}\n</script>`);
      },
    },
  };
}
