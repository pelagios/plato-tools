// A Vite plugin that puts Chora's hard block (src/chora/csp-head.js) into chora.html, inline, where
// the page marks it: the first script in its <head>, so that the Content Security Policy it writes is
// in force before the page requests anything. In the dev server and in the build alike. A chora.html
// without the mark is an error, never a page served without the block.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HEAD_MARK = '<!-- chora:csp -->';
const SOURCE = fileURLToPath(new URL('../src/chora/csp-head.js', import.meta.url));

export function choraCspPlugin() {
  return {
    name: 'chora-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!/(^|[\\/])chora\.html$/.test(ctx?.filename || ctx?.path || '')) return html;
        if (!html.includes(HEAD_MARK)) throw new Error(`chora.html has no ${HEAD_MARK} in its <head>, so its Content Security Policy would not be written`);
        return html.replace(HEAD_MARK, `<script>\n${readFileSync(SOURCE, 'utf8').trim()}\n</script>`);
      },
    },
  };
}
