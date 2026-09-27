// Independent check of a PLATO JSON Lines output: every line valid against the PLATO JSON Schema,
// the counts as expected, and sample places the same graph as in a reference file.
//   node e2e/verify_jsonl.mjs OUT.jsonl ENTITIES IDRS [REFERENCE.jsonl.gz ID ...]
import { createReadStream, readFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { loadResources } from '../src/engine/resources.js';
import { prepare } from '../src/engine/pipeline.js';
import { Json2Rdf } from '../src/formats/json2rdf.js';
import { tripleNT } from '../src/lib/ntriples.js';

const [out, nE, nI, ref, ...ids] = process.argv.slice(2);
const res = prepare(await loadResources(async (f) => readFileSync(`public/plato/${f}`, 'utf8')));
const V = res.validators['place-centric'];
const rl = (f) => createInterface({ input: f.endsWith('.gz') ? createReadStream(f).pipe(createGunzip()) : createReadStream(f), crlfDelay: Infinity });
let head = null, ents = 0, idrs = 0, bad = 0; const firstBad = []; const ours = new Map();
for await (const l of rl(out)) {
  if (!l) continue;
  const v = JSON.parse(l);
  if (!head) { head = v; if (!V.header(v)) { bad++; firstBad.push(['header', V.header.errors[0]]); } continue; }
  const isIdr = v.subject && v.object;
  const f = isIdr ? V.identity : V.entity;
  if (isIdr) idrs++; else { ents++; if (ids.includes(v['@id'])) ours.set(v['@id'], v); }
  if (!f(v)) { bad++; if (firstBad.length < 5) firstBad.push([v['@id'] || v.subject, f.errors[0]]); }
}
const checks = [];
const check = (name, ok, detail = '') => { checks.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
check('every line is valid PLATO JSON', bad === 0, bad ? JSON.stringify(firstBad).slice(0, 600) : `${ents + idrs + 1} lines`);
check('places', ents === Number(nE), `${ents}, expected ${nE}`);
check('identity relations', idrs === Number(nI), `${idrs}, expected ${nI}`);
if (ref) {
  const theirs = new Map(); let refHead = null;
  for await (const l of rl(ref)) { if (!l) continue; const v = JSON.parse(l); if (!refHead) { refHead = v; continue; } if (ids.includes(v['@id'])) theirs.set(v['@id'], v); if (theirs.size === ids.length) break; }
  const lean = (rec) => {
    const lines = []; const w = new Json2Rdf(res.context, (s, p, o) => lines.push(tripleNT(s, p, o)), {}); w.header({ gazetteer: { '@id': 'urn:doc' } }); w.record('spatialEntities', rec);
    const ts = [...new Set(lines)].map((l) => l.match(/^(\S+) (\S+) (.*) \.\n?$/).slice(1));
    const outg = new Map(); for (const t of ts) if (t[0].startsWith('_:')) (outg.get(t[0]) || outg.set(t[0], []).get(t[0])).push(t);
    const memo = new Map();
    const lab = (b) => { if (memo.has(b)) return memo.get(b); const s = (outg.get(b) || []).map(([, p, o]) => p + ' ' + (o.startsWith('_:') ? lab(o) : o)).sort().join('|'); memo.set(b, '_:' + s.length + '_' + [...s].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)); return memo.get(b); };
    return [...new Set(ts.map(([s, p, o]) => (s.startsWith('_:') ? lab(s) : s) + ' ' + p + ' ' + (o.startsWith('_:') ? lab(o) : o)))].sort().join('\n');
  };
  const any = [...theirs.values()][0];
  check('control: the comparison says SAME for a place against itself', any && lean(any) === lean(structuredClone(any)));
  if (any) { const cut = structuredClone(any); cut.attestations.pop(); check('control: the comparison says DIFFERENT when an attestation is removed', lean(cut) !== lean(any)); }
  for (const id of ids) {
    const a = ours.get(id), b = theirs.get(id);
    check(`${id}: the same graph as in the reference`, a && b && lean(a) === lean(b), !a ? 'missing from output' : !b ? 'missing from reference' : `${a.attestations.length} attestations`);
  }
}
console.log('VERIFY', checks.every(Boolean) ? 'ALL PASS' : 'FAILED'); process.exit(checks.every(Boolean) ? 0 : 1);
