// Independent check of an N-Triples output: every line parses, and per-predicate counts compared
// with a reference file (DEEP's own N-Triples), so any systematic difference is visible.
//   node e2e/verify_nt.mjs OUT.nt [REFERENCE.nt.gz]
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Parser } from 'n3';
const [out, ref] = process.argv.slice(2);
async function census(f) {
  const rl = createInterface({ input: f.endsWith('.gz') ? createReadStream(f).pipe(createGunzip()) : createReadStream(f), crlfDelay: Infinity });
  const preds = new Map(); let n = 0, errors = 0, batch = [];
  const flush = () => { try { for (const q of new Parser({ format: 'N-Triples' }).parse(batch.join('\n') + '\n')) { n++; preds.set(q.predicate.value, (preds.get(q.predicate.value) || 0) + 1); } } catch { for (const l of batch) { try { new Parser({ format: 'N-Triples' }).parse(l + '\n'); } catch { errors++; } } } batch = []; };
  for await (const l of rl) { if (!l || l[0] === '#') continue; batch.push(l); if (batch.length >= 20000) flush(); }
  flush();
  return { n, errors, preds };
}
const a = await census(out);
console.log(`  ${a.errors === 0 ? 'PASS' : 'FAIL'}  every line parses as N-Triples  -- ${a.n} triples, ${a.errors} bad lines`);
if (ref) {
  const b = await census(ref);
  console.log(`  reference: ${b.n} triples`);
  const keys = [...new Set([...a.preds.keys(), ...b.preds.keys()])].sort();
  const diffs = keys.filter((k) => a.preds.get(k) !== b.preds.get(k));
  console.log(`  predicates with different counts: ${diffs.length} of ${keys.length}`);
  for (const k of diffs) console.log(`    ${k.replace('https://w3id.org/plato#', 'plato:')}: output ${a.preds.get(k) || 0}, reference ${b.preds.get(k) || 0}`);
}
process.exit(a.errors === 0 ? 0 : 1);
