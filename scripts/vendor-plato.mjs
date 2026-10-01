// Copy PLATO's normative files, at the commit pinned in package.json, into public/plato/,
// so the tool always checks against a stated version of the ontology, schemas, context
// and table definitions. Fetched from GitHub, so a build is reproducible anywhere.
//   node scripts/vendor-plato.mjs              use the pinned commit
//   node scripts/vendor-plato.mjs --latest     re-pin to the current head of main
//   node scripts/vendor-plato.mjs --ref NAME   re-pin to a named branch's head, or a commit: a draft
//                                              pin, which VERSION.json, the page footer and --version
//                                              mark as not a release, so a branch cannot pass for one
//                                              (test/pin.test.js)
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const REPO = 'pelagios/place-attestation-ontology';
const FILES = ['ontology.ttl', 'schemas/plato.schema.json', 'schemas/place-centric.schema.json',
  'schemas/attestation-centric.schema.json', 'schemas/candidate-set.schema.json', 'schemas/plato.context.jsonld',
  'schemas/tables/csv-metadata.json'];
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const argv = process.argv.slice(2);
const refAt = argv.indexOf('--ref');
const ref = refAt >= 0 ? argv[refAt + 1] : null;
if (refAt >= 0 && (!ref || ref.startsWith('--'))) throw new Error('--ref needs a branch name or a commit');
if (ref && argv.includes('--latest')) throw new Error('choose --latest (main) or --ref NAME, not both');

async function resolve(name) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(name)}`, { headers: { Accept: 'application/vnd.github.sha' } });
  if (!r.ok) throw new Error(`could not resolve ${name} in ${REPO}: ${r.status}`);
  return (await r.text()).trim();
}
let commit = pkg.plato?.commit;
if (argv.includes('--latest') || ref || !commit) {
  const name = ref || 'main';
  commit = await resolve(name);
  // A pin to anything but main is a draft: the ref it came from is kept beside the commit, so that the
  // prebuild vendoring (no flags) writes the same draft marking again.
  pkg.plato = { repository: `https://github.com/${REPO}`, commit, ...(ref && ref !== 'main' ? { ref, draft: true } : {}) };
  await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
}
for (const f of FILES) {
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${f}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const out = `public/plato/${f.split('/').pop()}`;
  await mkdir('public/plato', { recursive: true });
  await writeFile(out, await r.text());
}
const ttl = await readFile('public/plato/ontology.ttl', 'utf8');
const versionInfo = (ttl.match(/owl:versionInfo\s+"([^"]+)"/) || [])[1];
const draft = pkg.plato.draft ? { ref: pkg.plato.ref, draft: true, note: `A draft: PLATO's ${pkg.plato.ref} branch, not a release of PLATO.` } : {};
await writeFile('public/plato/VERSION.json', JSON.stringify({ repository: `https://github.com/${REPO}`, commit, versionInfo, ...draft }, null, 2) + '\n');
console.log(`vendored PLATO ${versionInfo} at ${commit.slice(0, 7)}${draft.draft ? ` (DRAFT: branch ${draft.ref})` : ''} into public/plato/`);
