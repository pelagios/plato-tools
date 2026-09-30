// The version check at full scale, against an answer known in advance. From a published export in
// PLATO JSON Lines (DEEP's), write a later version in which one attestation in a hundred is deleted,
// one in a hundred changed and one in a hundred added, counting each; then run `plato-tools compare`
// on the two and require exactly those counts back, and one example of each explained.
//
// Comparing an export with itself only ever takes the path on which everything matches. This takes
// the others, at a size where a lookup that reads the whole of the other version shows as time.
//   node e2e/compare_scale.mjs EXPORT.jsonl.gz [--work-dir DIR]
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const [input, ...rest] = process.argv.slice(2);
if (!input) { console.error('usage: node e2e/compare_scale.mjs EXPORT.jsonl.gz [--work-dir DIR]'); process.exit(2); }
const at = rest.indexOf('--work-dir');
const work = mkdtempSync(join(at >= 0 ? rest[at + 1] : tmpdir(), 'plato-compare-scale-'));
const later = join(work, 'later.jsonl.gz');

// ---- the later version, and what it should be found to hold -------------------------------------------
const want = { earlier: 0, deleted: 0, changed: 0, added: 0 };
const examples = { deleted: null, changed: null };
const gz = createGzip(); const out = gz.pipe(createWriteStream(later));
const write = async (s) => { if (!gz.write(s + '\n')) await once(gz, 'drain'); };
let first = true, n = 0;
for await (const line of createInterface({ input: createReadStream(input).pipe(createGunzip()), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const v = JSON.parse(line);
  if (first) {
    first = false;
    if (v.gazetteer?.status !== 'published') throw new Error('the export does not say it is published, so the rule would not bind');
    const earlierId = v.gazetteer['@id'];
    v.gazetteer = { ...v.gazetteer, '@id': earlierId + '-synthetic', version: 'synthetic', previousVersion: earlierId };
    await write(JSON.stringify(v)); continue;
  }
  if (Array.isArray(v.attestations)) {
    const kept = [];
    for (const a of v.attestations) {
      want.earlier++;
      const i = n++;
      if (typeof a['@id'] !== 'string') { kept.push(a); continue; }
      if (i % 100 === 0) { want.deleted++; examples.deleted ??= a['@id']; continue; }
      if (i % 100 === 37) { want.changed++; examples.changed ??= a['@id']; kept.push({ ...a, notes: `${a.notes ?? ''} [changed in the synthetic version]` }); continue; }
      kept.push(a);
      if (i % 100 === 71) { want.added++; kept.push({ '@id': a['@id'] + '-added', names: [{ toponym: 'Added in the synthetic version' }], created: '2026-10-01T00:00:00Z' }); }
    }
    v.attestations = kept;
  }
  await write(JSON.stringify(v));
}
gz.end(); await once(out, 'finish');
console.log(`wrote ${later}: of ${want.earlier.toLocaleString('en-GB')} attestations, ${want.deleted} deleted, ${want.changed} changed, ${want.added} added`);

// ---- the comparison --------------------------------------------------------------------------------------
const cli = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const t0 = Date.now();
const r = spawnSync(process.execPath, [cli, 'compare', '--json', '--work-dir', work, input, later], { encoding: 'utf8', maxBuffer: 1 << 28 });
const seconds = Math.round((Date.now() - t0) / 1000);
let got;
try { got = JSON.parse(r.stdout); } catch { console.error(r.stdout.slice(0, 2000), r.stderr.slice(0, 2000)); process.exit(1); }
const kind = (k) => got.items.find((i) => i.kind === k);
const checks = [
  ['exit status 1', r.status === 1],
  ['earlier attestations', got.counts.earlier === want.earlier],
  ['deleted, as no longer there', got.counts.lost === want.deleted && kind('attestation-removed')?.count === want.deleted],
  ['changed', got.counts.changed === want.changed && kind('attestation-changed')?.count === want.changed],
  ['added', got.counts.added === want.added],
  ['unchanged', got.counts.unchanged === want.earlier - want.deleted - want.changed],
  ['no other problem', got.errors === want.deleted + want.changed],
  ['the first deletion named', kind('attestation-removed')?.examples[0] === examples.deleted],
  ['the first change named, and explained', kind('attestation-changed')?.examples[0] === examples.changed
    && kind('attestation-changed').explained?.[0]?.later.some((l) => l.includes('[changed in the synthetic version]'))],
];
for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
// Everything the report found, so that a failure can be read without running it again.
for (const i of got.items) console.log(`    ${i.severity} ${i.kind} ×${i.count}  ${i.examples.slice(0, 2).join('  ')}`);
console.log(`compared in ${seconds} s; counts ${JSON.stringify(got.counts)}`);
rmSync(work, { recursive: true, force: true });
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
