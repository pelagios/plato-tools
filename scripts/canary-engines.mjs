// An opt-in check of the canary (src/lib/csp.js) in Chromium, Firefox and WebKit: the real module, on a
// page served by Playwright's router (no server, no network), under four policies. It must find the
// policy the permissions write enforced, and no policy, a policy that lists data:, and a policy widened
// to every site NOT enforced, in every engine, with the <meta> in the page as served and as a script
// writes it (as csp-head.js does).
//
//   node scripts/canary-engines.mjs            Playwright from PLAYWRIGHT_MODULE, else `playwright`
//
// Playwright is not a dependency of the tools: point PLAYWRIGHT_MODULE at an install of it (its
// index.js, or a directory). Without it, or without an engine's browser, that is said and skipped,
// and the exit status is 0 only if every engine that ran gave every expected answer.
// From the review of 1 October 2026 (Fable), which found the canary blind to a widened policy.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { policyFor } from '../src/lib/permissions-core.js';

const SRC = new URL('../src/lib/', import.meta.url);
const files = { '/csp.js': fs.readFileSync(new URL('csp.js', SRC), 'utf8'), '/permissions-core.js': fs.readFileSync(new URL('permissions-core.js', SRC), 'utf8') };
const POLICY = policyFor([]);
const VARIANTS = {
  written: { policy: POLICY, expect: true },
  none: { policy: null, expect: false },
  'data-allowed': { policy: POLICY.replace("connect-src 'self' blob:", "connect-src 'self' blob: data:"), expect: false },
  wildcard: { policy: POLICY.replace("connect-src 'self' blob:", "connect-src 'self' blob: *"), expect: false },
};

async function loadPlaywright() {
  const where = process.env.PLAYWRIGHT_MODULE;
  try {
    if (!where) return (await import('playwright')).default;
    const p = fs.statSync(where).isDirectory() ? path.join(where, 'index.js') : where;
    const m = await import(pathToFileURL(p).href);
    return m.default || m;
  } catch (e) { return null; }
}

const html = (policy, byScript) => `<!doctype html><html><head>${byScript ? '<script src="/head.js"></script>' : (policy === null ? '' : `<meta http-equiv="Content-Security-Policy" content="${policy}">`)}<script type="module" src="/main.js"></script></head><body>canary</body></html>`;

async function run(engine, variant, byScript) {
  const { policy } = VARIANTS[variant];
  const browser = await engine.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route('https://canary.test/**', (route) => {
      const p = new URL(route.request().url()).pathname;
      if (files[p]) return route.fulfill({ contentType: 'text/javascript', body: files[p] });
      if (p === '/head.js') return route.fulfill({ contentType: 'text/javascript', body: policy === null ? '' : `var m=document.createElement('meta');m.setAttribute('http-equiv','Content-Security-Policy');m.setAttribute('content',${JSON.stringify(policy)});document.head.prepend(m);` });
      if (p === '/main.js') return route.fulfill({ contentType: 'text/javascript', body: `import { canary } from './csp.js'; ${policy === null ? '' : `window.__platoCsp = { policy: ${JSON.stringify(policy)}, origins: [] };`} canary().then((r) => { window.__result = r; });` });
      if (p === '/page') return route.fulfill({ contentType: 'text/html', body: html(policy, byScript) });
      return route.abort();
    });
    await page.goto('https://canary.test/page');
    await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 15000 });
    return await page.evaluate(() => window.__result);
  } finally { await browser.close(); }
}

const pw = await loadPlaywright();
if (!pw) { console.log('SKIPPED: Playwright not found (set PLAYWRIGHT_MODULE to an install of it). It is not a dependency of the tools.'); process.exit(0); }
let wrong = 0, ran = 0;
for (const name of ['chromium', 'firefox', 'webkit']) {
  try { const b = await pw[name].launch(); console.log(`${name} ${b.version()}`); await b.close(); } catch (e) {
    console.log(`SKIPPED ${name}: its browser is not installed here (${String(e.message).split('\n')[0].slice(0, 120)})`); continue;
  }
  ran++;
  for (const byScript of [false, true]) {
    for (const [variant, { expect }] of Object.entries(VARIANTS)) {
      let r;
      try { r = await run(pw[name], variant, byScript); } catch (e) { r = { enforced: null, why: `harness: ${String(e.message).split('\n')[0]}` }; }
      const ok = r.enforced === expect;
      if (!ok) wrong++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${byScript ? 'meta by script' : 'meta as served'}  ${variant.padEnd(13)} enforced=${r.enforced}${r.why ? ` (${r.why})` : ''}`);
    }
  }
}
console.log(ran ? (wrong ? `${wrong} WRONG` : `ALL AS EXPECTED in ${ran} engine${ran === 1 ? '' : 's'}`) : 'NOTHING RAN');
process.exit(wrong ? 1 : 0);
