// An opt-in check of the TEI P4 reading (src/engine/hermes/tei.js) against a real Perseus P4 file,
// which is never committed: Perseus's texts are CC BY-SA, and only a constructed P4 fixture is kept
// (test/fixtures/tei/p4-constructed.xml). It reads the file as a run would (detect, then teiSource,
// with Getty TGN's pattern for Perseus's key="tgn,…"), and says what came out.
//
//   PERSEUS_P4_FILE=/path/to/a-perseus-p4.xml node scripts/check-perseus-p4.mjs
//
// Without PERSEUS_P4_FILE (or with one that is not a file), that is said and skipped, with exit
// status 0. Otherwise the exit status is 0 only if the file is detected as TEI P4, read to its end,
// and gives at least one attestation, each valid attestation-centric PLATO.
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { addPlatoFormats, strictFormatLogger } from '../src/lib/formats.js';
import { detect } from '../src/engine/input.js';
import { teiSource } from '../src/engine/hermes/tei.js';
import { Report } from '../src/engine/report.js';

const where = process.env.PERSEUS_P4_FILE;
if (!where || !fs.existsSync(where) || !fs.statSync(where).isFile()) {
  console.log(`skipped: set PERSEUS_P4_FILE to a local Perseus TEI P4 file${where ? ` (${where} is not a file)` : ''}`);
  process.exit(0);
}
const load = (f) => JSON.parse(fs.readFileSync(new URL(`../public/plato/${f}`, import.meta.url), 'utf8'));
const ajv = addPlatoFormats(new Ajv2020({ strict: false, allErrors: true, logger: strictFormatLogger }));
ajv.addSchema(load('plato.schema.json'), 'https://w3id.org/plato/schemas/plato.schema.json');
const validate = ajv.compile(load('attestation-centric.schema.json'));

const file = new File([fs.readFileSync(where)], path.basename(where));
const input = await detect([file]);
const problems = [];
if (input.format !== 'tei' || input.variant !== 'p4') problems.push(`detected as ${JSON.stringify({ format: input.format, variant: input.variant, reason: input.reason })}, not TEI P4`);
const rep = new Report({ examples: 3 });
let header, n = 0, named = 0, languages = new Map(), failed;
const attestations = [];
if (input.format === 'tei') {
  try {
    for await (const ev of teiSource(input, rep, { keyPatterns: { tgn: 'http://vocab.getty.edu/tgn/{id}' } })) {
      if (ev.type === 'header') { header = ev.value; continue; }
      n++;
      const a = ev.value;
      if (a.names) { named++; const l = a.names[0].language || '(none)'; languages.set(l, (languages.get(l) || 0) + 1); }
      attestations.push(a);
    }
  } catch (e) { failed = e; problems.push(`stopped: ${e.message}`); }
}
if (!n) problems.push('no attestation');
if (header) {
  const doc = { ...header, attestations };
  if (!validate(doc)) problems.push(`not valid PLATO: ${ajv.errorsText(validate.errors.slice(0, 3))}`);
}
console.log(`${where}: ${n} attestations (${named} with a name; languages ${[...languages].map(([l, c]) => `${l} ${c}`).join(', ') || 'none'})`);
for (const k of rep.kinds.values()) console.log(`  ${k.severity} ${k.kind} x${k.count}${k.examples.length ? `: ${k.examples.join(' | ')}` : ''}`);
for (const p of problems) console.log(`PROBLEM: ${p}`);
process.exit(problems.length || failed ? 1 : 0);
