// Copy PLATO's normative files, at the commit pinned in package.json, into public/plato/,
// so the tool always checks against a stated version of the ontology, schemas, context
// and table definitions. Fetched from GitHub, so a build is reproducible anywhere.
//   node scripts/vendor-plato.mjs            use the pinned commit
//   node scripts/vendor-plato.mjs --latest   re-pin to the current head of main
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const REPO = 'pelagios/place-attestation-ontology';
const FILES = ['ontology.ttl', 'schemas/plato.schema.json', 'schemas/place-centric.schema.json',
  'schemas/attestation-centric.schema.json', 'schemas/plato.context.jsonld', 'schemas/tables/csv-metadata.json'];
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
let commit = pkg.plato?.commit;
if (process.argv.includes('--latest') || !commit) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, { headers: { Accept: 'application/vnd.github.sha' } });
  if (!r.ok) throw new Error(`could not read the head of ${REPO}: ${r.status}`);
  commit = (await r.text()).trim();
  pkg.plato = { repository: `https://github.com/${REPO}`, commit };
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
await writeFile('public/plato/VERSION.json', JSON.stringify({ repository: `https://github.com/${REPO}`, commit, versionInfo }, null, 2) + '\n');
console.log(`vendored PLATO ${versionInfo} at ${commit.slice(0, 7)} into public/plato/`);
