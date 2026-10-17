// Mneme's revision at full scale, against an answer known in advance. From a published export in PLATO
// JSON Lines (DEEP's), write a new version in which one attestation in a hundred is deleted, one in a
// hundred changed and one in a hundred added (as e2e/compare_scale.mjs plants them), counting each; then
// run `plato-tools revise` on the two and require exactly those counts back: so many retracted, so many
// replaced, so many added, the version check of the output clean; and record the time and the memory.
//   node e2e/revise_scale.mjs EXPORT.jsonl.gz [--work-dir DIR] [--keep]
// Run it through ~/.config/plato-tools/heavy.sh: it reads the export several times over.
import { createReadStream, createWriteStream, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const [input, ...rest] = process.argv.slice(2);
if (!input) { console.error('usage: node e2e/revise_scale.mjs EXPORT.jsonl.gz [--work-dir DIR] [--keep]'); process.exit(2); }
const at = rest.indexOf('--work-dir');
const work = mkdtempSync(join(at >= 0 ? rest[at + 1] : tmpdir(), 'plato-revise-scale-'));
const later = join(work, 'later.jsonl.gz');

// ---- the new version, and what the revision should be found to do ---------------------------------------
const want = { earlier: 0, deleted: 0, changed: 0, added: 0, places: 0 };
const gz = createGzip(); const out = gz.pipe(createWriteStream(later));
const write = async (s) => { if (!gz.write(s + '\n')) await once(gz, 'drain'); };
let first = true, n = 0;
for await (const line of createInterface({ input: createReadStream(input).pipe(createGunzip()), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const v = JSON.parse(line);
  if (first) {
    first = false;
    if (v.gazetteer?.status !== 'published') throw new Error('the export does not say it is published, so the rule would not bind');
    // The working copy: no release of its own yet (the revision names it), and a draft until the revision says published.
    const { version: _v, previousVersion: _p, ...g } = v.gazetteer; void _v; void _p;
    v.gazetteer = { ...g, '@id': g.uriSpace || g['@id'], status: 'draft' };
    await write(JSON.stringify(v)); continue;
  }
  if (Array.isArray(v.attestations)) {
    want.places++;
    const kept = [];
    for (const a of v.attestations) {
      want.earlier++;
      const i = n++;
      if (typeof a['@id'] !== 'string') { kept.push(a); continue; }
      if (i % 100 === 0) { want.deleted++; continue; }
      if (i % 100 === 37) { want.changed++; kept.push({ ...a, notes: `${a.notes ?? ''} [changed in the synthetic version]` }); continue; }
      kept.push(a);
      // Added without an address or a date: the revision gives it both.
      if (i % 100 === 71) { want.added++; kept.push({ names: [{ toponym: 'Added in the synthetic version' }], citations: a.citations, sources: a.sources }); }
    }
    v.attestations = kept;
  }
  await write(JSON.stringify(v));
}
gz.end(); await once(out, 'finish');
console.log(`wrote ${later}: of ${want.earlier.toLocaleString('en-GB')} attestations, ${want.deleted} deleted, ${want.changed} changed, ${want.added} added`);

// ---- the revision ------------------------------------------------------------------------------------------
const cli = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const t0 = Date.now();
// GNU time, where it is, for the peak memory of the whole run (the child's maximum resident set, in kB).
const timed = existsSync('/usr/bin/time');
const args = [cli, 'revise', '--json', '--work-dir', work, '--out', work, '--reviewer', 'Scale test', '--release', 'synthetic', later, '--previous', input];
const r = timed ? spawnSync('/usr/bin/time', ['-f', 'MAXRSS_KB=%M', process.execPath, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
  : spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const seconds = Math.round((Date.now() - t0) / 1000);
const rss = /MAXRSS_KB=(\d+)/.exec(r.stderr || '')?.[1];
let got;
try { got = JSON.parse(r.stdout); } catch { console.error(r.stdout.slice(0, 2000), r.stderr.slice(0, 2000)); process.exit(1); }
const kind = (k) => got.items.find((i) => i.kind === k);
const c = got.counts, v = c.versionCheck || {};
// The export carries addresses, so the pairing of the tables case (D2) does not apply and nothing is paired; the
// checks still add the pairs in, so that a run on an export without addresses adds up exactly too.
const checks = [
  ['exit status 0', r.status === 0],
  ['previous attestations', c.previous === want.earlier],
  ['deleted, each retracted or paired', c.removed + c.paired === want.deleted && c.retracted === want.deleted - c.paired && kind('retracted')?.count === c.removed],
  ['changed, each replaced (and the pairs)', c.changed === want.changed && c.superseded === want.changed + c.paired && kind('superseded')?.count === want.changed],
  ['added, each addressed', c.added === want.added && c.unaddressed === 0],
  ['no place dropped, nothing readdressed or inherited', c.tombstones === 0 && c.readdressed === 0 && c.inherited === 0],
  ['the version check: nothing lost or changed, the withdrawals and the additions counted', v.lost === 0 && v.changed === 0 && v.retracted === c.retracted && v.superseded === c.superseded && v.added === c.addedAll && c.addedAll === want.added + want.changed + c.retracted],
  ['no other problem', got.errors === 0],
  ['the output and the release report written', got.outputs.length === 2 && got.outputs.every((o) => existsSync(o.path))],
];
for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
for (const i of got.items) console.log(`    ${i.severity} ${i.kind} ×${i.count}  ${i.examples.slice(0, 2).join('  ')}`);
console.log(`revised in ${seconds} s${rss ? `, ${Math.round(rss / 1024)} MB at peak` : ''}; counts ${JSON.stringify({ ...c, said: undefined })}`);
if (!rest.includes('--keep')) rmSync(work, { recursive: true, force: true });
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
