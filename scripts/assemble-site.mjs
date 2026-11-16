// What https://plato.pelagios.org/ serves, put together (.github/workflows/pages.yml):
//
//   /          the published PLATO site, as it is on the gh-pages branch of pelagios/place-attestation-ontology,
//              every path as it is there (guide/, index-en.html, ontology.ttl, schemas/, releases/ and the rest),
//              so that PLATO's w3id addresses need only another host;
//   /tools/    this repository's built tools (dist), with spike/ and basemap/.
//
// And two small pages for the tools' former addresses. Until November 2026 the tools were at
// https://pelagios.org/plato-tools/, which GitHub now answers with a 301 to this host, the path kept: a link
// to the tools made before then arrives at the root, or at a path that is not there. Neither address is
// published anywhere any more; these pages only keep the old links working.
//
//   /index.html   PLATO's own root page as published, with one script put first in it: an address with a
//                 query, or with a fragment that is the tools' (#chora, #tool=check, #methodos,
//                 #whg-shared=<token>), goes to /tools/ with the same query and fragment. Anything else is
//                 PLATO's page's to decide. While PLATO's page is still the plain refresh to index-en.html
//                 (or there is none), the page is written here instead: no fragment, to guide/; a fragment
//                 (a term's anchor), to index-en.html with it.
//   /404.html     a path that is not there but is under /tools/ (spike/, basemap/relief.pmtiles) goes there.
//
//   node scripts/assemble-site.mjs <PLATO's published site> <dist> <out>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The fragments that are the tools' (src/app.js: toolFromHash, choraInHash, sharedToken, #methodos). PLATO's
// specification has no anchor of these names (its terms' anchors are the terms' names).
const TOOLS_FRAGMENT = `var s=location.search,h=location.hash,k;try{k=new URLSearchParams(h.slice(1))}catch(e){k=null}
var tools=!!s||!!k&&(k.has('chora')||k.has('tool')||k.has('methodos')||k.has('whg-shared'));`;

// Put first in PLATO's page. After sending the address to the tools it has the rest of the page read as
// text (<plaintext>), so that no refresh or script further down sends it anywhere else afterwards.
export const FORWARD_SCRIPT = `<script>(function(){${TOOLS_FRAGMENT}
if(tools){location.replace('tools/'+s+h);document.write('<plaintext style="display:none">')}})()</script>`;

export const ROOT_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>PLATO: Place Attestation Ontology</title>
<script>(function(){${TOOLS_FRAGMENT}
location.replace(tools?'tools/'+s+h:h.length>1?'index-en.html'+h:'guide/')})()</script>
</head><body>
<p>PLATO, the Place Attestation Ontology: <a href="guide/">the guide</a>, <a href="index-en.html">the specification</a>, <a href="tools/">the tools</a>.</p>
</body></html>
`;

export const NOT_FOUND_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found: PLATO</title>
<script>(function(){var p=location.pathname;if(/^\\/tools(\\/|$)/.test(p))return;var t='/tools'+p;
fetch(t,{method:'HEAD'}).then(function(r){if(r.ok)location.replace(t+location.search+location.hash)}).catch(function(){})})()</script>
</head><body>
<h1>Not found</h1>
<p>Nothing is published at this address. See <a href="/">PLATO, the Place Attestation Ontology</a>, or <a href="/tools/">the PLATO tools</a>.</p>
</body></html>
`;

/** PLATO's root page as it was until November 2026: a plain refresh to index-en.html, and no word of the guide. */
export const goesToTheSpecification = (html) => /http-equiv=["']?refresh["']?[^>]*url=index-en\.html/i.test(html) && !/guide\//.test(html);

/** The root page served: PLATO's with the forwarding first in it, or the page written here (above). */
export function rootPage(platoIndex) {
  if (platoIndex == null || goesToTheSpecification(platoIndex)) return ROOT_PAGE;
  const doctype = platoIndex.match(/^\s*(<!DOCTYPE[^>]*>)?/i)[0];
  return doctype + FORWARD_SCRIPT + platoIndex.slice(doctype.length);
}

export function assemble(plato, dist, out) {
  for (const [dir, file] of [[plato, 'index-en.html'], [plato, 'guide/index.html'], [plato, 'ontology.ttl'], [dist, 'index.html']]) {
    if (!existsSync(join(dir, file))) throw new Error(`${dir} has no ${file}: not the site expected`);
  }
  // A path of PLATO's that the site's own would take the place of: stop, rather than serve one for the other.
  for (const mine of ['tools', '404.html']) if (existsSync(join(plato, mine))) throw new Error(`PLATO's published site has a ${mine} of its own, which this site's would replace`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(plato, out, { recursive: true, filter: (src) => !/(^|[\\/])\.git$/.test(src) });
  cpSync(dist, join(out, 'tools'), { recursive: true });
  const index = join(plato, 'index.html');
  const theirs = existsSync(index) ? readFileSync(index, 'utf8') : null;
  writeFileSync(join(out, 'index.html'), rootPage(theirs));
  writeFileSync(join(out, '404.html'), NOT_FOUND_PAGE);
  return { root: theirs == null || goesToTheSpecification(theirs) ? 'written here (PLATO\'s still goes to index-en.html, or is absent)' : 'PLATO\'s own, with the forwarding to the tools first in it' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plato, dist, out] = process.argv.slice(2);
  if (!plato || !dist || !out) { console.error('usage: node scripts/assemble-site.mjs <PLATO\'s published site> <dist> <out>'); process.exit(2); }
  const { root } = assemble(plato, dist, out);
  console.log(`The site is in ${out}: PLATO's published site at its root, the tools under tools/. The root page: ${root}.`);
}
