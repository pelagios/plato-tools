// The precision of the qualifier rule (Krisis, src/engine/krisis/qualifiers.js), on a pair of
// gazetteers NOT used to choose the lists, for judging by hand. Runs `plato-tools match` on the pair
// twice, as a user would, with the lists given and with none, and lists the suggestions the rule
// adds (and any it costs: a pair crowded out of a place's best five), one to a line, as tab-separated
// text with an empty column, "same place?", to fill in: the share of those judged the same place is
// the rule's precision on that pair. It decides nothing itself.
//
// The English, Welsh and Latin list was chosen on market towns matched with CAMPOP's places (DEVELOPERS.md,
// Match review), so that pair cannot test it. The held-out pair proposed: the Gazetteer of Markets and Fairs
// to 1516 against DEEP (the English Place-Name Society's survey, 539,372 places), whose rule-added pairs
// no one has seen; DEEP in full needs a machine with several GB free. For a small run, give one
// county's volumes of DEEP and the market places within them.
//   node e2e/qualifier_precision.mjs SUBJECTS OTHERS [--qualifiers en-cy-la] [--threshold 0.85]
//        [--max-distance 50] [--out FILE.tsv] [--work-dir DIR]
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const flags = new Set(['--qualifiers', '--threshold', '--max-distance', '--out', '--work-dir']);
const [subjects, others] = args.filter((a, i) => !a.startsWith('--') && !flags.has(args[i - 1]));
if (!subjects || !others) { console.error('usage: node e2e/qualifier_precision.mjs SUBJECTS OTHERS [--qualifiers en-cy-la] [--threshold 0.85] [--max-distance 50] [--out FILE.tsv] [--work-dir DIR]'); process.exit(2); }
const lists = flag('--qualifiers', 'en-cy-la');
if (lists === 'none') { console.error('--qualifiers none would compare the matching without the rule with itself.'); process.exit(2); }
const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const dir = mkdtempSync(join(flag('--work-dir', tmpdir()), 'plato-qualifier-precision-'));

/** One matching, with the lists given: its work file. */
function matchWith(q) {
  const out = join(dir, q.replace(/[^a-z-]/gi, '_'));
  const r = spawnSync(process.execPath, [CLI, 'match', subjects, '--with', others, '--qualifiers', q, '--threshold', flag('--threshold', '0.85'),
    '--max-distance', flag('--max-distance', '50'), '--out', out, '--work-dir', dir, '--json'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0 && r.status !== 1) { console.error(`plato-tools match --qualifiers ${q} failed (exit ${r.status}):\n${r.stderr}`); process.exit(1); }
  const report = JSON.parse(r.stdout);
  const name = readdirSync(out).find((f) => f.endsWith('.krisis.json'));
  return { work: JSON.parse(readFileSync(join(out, name), 'utf8')), report };
}

const t0 = Date.now();
const without = matchWith('none'), withRule = matchWith(lists);
const key = (c) => c.candidate_source + '\t' + c.candidate_candidate;
const before = new Map(without.work.candidates.map((c) => [key(c), c])), after = new Map(withRule.work.candidates.map((c) => [key(c), c]));
const added = [...after.values()].filter((c) => !before.has(key(c))), lost = [...before.values()].filter((c) => !after.has(key(c)));
const label = (iri, w) => w.places[iri]?.label ?? '';
const row = (c, w, what) => [what, label(c.candidate_source, w), c.other.label, c.similarity_score, c.distance_km ?? '', c.rule === 'qualifier' ? c.qualifier : '', c.candidate_source, c.candidate_candidate, ''].join('\t');
const lines = ['change\tsubject\tother\tscore\tkm\tqualifier rule\tsubject IRI\tother IRI\tsame place?',
  ...added.sort((a, b) => label(a.candidate_source, withRule.work).localeCompare(label(b.candidate_source, withRule.work))).map((c) => row(c, withRule.work, 'added')),
  ...lost.map((c) => row(c, without.work, 'lost'))];
const out = flag('--out', 'qualifier-precision.tsv');
writeFileSync(out, lines.join('\n') + '\n');
const byQualifier = new Map();
for (const c of added) if (c.rule === 'qualifier') byQualifier.set(c.qualifier, (byQualifier.get(c.qualifier) || 0) + 1);
console.log(`Subjects: ${subjects}\nOthers:   ${others}\nLists:    ${withRule.work.match_parameters.qualifiers.lists.join(', ')} (${withRule.work.match_parameters.qualifiers.table}; ${withRule.work.algorithm_version})`);
console.log(`Suggestions without the rule: ${before.size}; with it: ${after.size}; added: ${added.length} (${added.filter((c) => c.rule === 'qualifier').length} marked "qualifier rule"); lost: ${lost.length}.`);
console.log(`Added, by qualifier: ${[...byQualifier].sort((a, b) => b[1] - a[1]).map(([q, n]) => `${q} ${n}`).join(', ') || 'none'}.`);
console.log(`Comparisons: ${without.report.counts?.comparisons ?? '?'} without, ${withRule.report.counts?.comparisons ?? '?'} with. ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
console.log(`For judging by hand: ${out}`);
if (!flag('--work-dir')) rmSync(dir, { recursive: true, force: true });
