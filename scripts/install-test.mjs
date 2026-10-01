// Install the tools the way npx does, and run them: pack this checkout, install the tarball into an
// empty project (production dependencies only, with every install script run, as for a git
// dependency), then run the installed command. A broken install, such as a postinstall that needs a
// development dependency (which is what made `npx github:pelagios/plato-tools` exit 127 with nothing
// installed), fails here rather than on someone else's machine.
//   node scripts/install-test.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const dir = mkdtempSync(join(tmpdir(), 'plato-tools-install-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let failed = false;
const step = (what, fn) => {
  try { const out = fn(); console.log(`ok    ${what}${out ? `: ${out}` : ''}`); return out; }
  catch (e) { failed = true; console.log(`FAIL  ${what}\n${(e.stdout || '') + (e.stderr || '') || e.message}`); return null; }
};
try {
  const tgz = step('npm pack', () => { const t = JSON.parse(sh(npm, ['pack', '--json', '--pack-destination', dir], root))[0].filename; return join(dir, t); });
  const app = join(dir, 'app');
  step('an empty project', () => { execFileSync('mkdir', [app]); sh(npm, ['init', '-y'], app); return ''; });
  if (tgz) step('npm install of the tarball, with its install scripts', () => { sh(npm, ['install', '--foreground-scripts', '--no-audit', '--no-fund', tgz], app); return ''; });
  const bin = join(app, 'node_modules', '.bin', 'plato-tools');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  step('plato-tools --version names the pinned PLATO commit', () => {
    const v = sh(bin, ['--version'], app).trim();
    if (!v.includes(pkg.plato.commit)) throw new Error(`--version says "${v}", not the pinned commit ${pkg.plato.commit}`);
    return v;
  });
  // A document with a U+FEFF leading a name exercises the vendored JSON parser, as installed.
  const doc = { profile: 'place-centric', gazetteer: { '@id': 'https://example.org/g', title: 't' },
    spatialEntities: [{ '@id': 'https://example.org/p/1', label: 'P', attestations: [{ names: [{ toponym: '﻿Lead' }], sources: [{ title: 's' }] }] }] };
  writeFileSync(join(app, 'doc.json'), JSON.stringify(doc));
  step('plato-tools check on a PLATO JSON document', () => { const [r] = sh(bin, ['check', '--json', 'doc.json'], app).trim().split('\n').map((l) => JSON.parse(l)); if (r.status !== 'ok') throw new Error(JSON.stringify(r)); return r.status; });
  step('plato-tools convert to N-Triples keeps the U+FEFF', () => {
    sh(bin, ['convert', '--to', 'ntriples', '--out', app, 'doc.json'], app);
    const nt = readFileSync(join(app, 'doc.nt'), 'utf8');
    if (!nt.includes('"﻿Lead"')) throw new Error('the U+FEFF was lost');
    return `${nt.split('\n').filter(Boolean).length} triples`;
  });
  step('plato-tools compare finds the JSON and its own N-Triples the same', () => {
    const r = JSON.parse(sh(bin, ['compare', '--json', 'doc.json', 'doc.nt'], app));
    if (r.status !== 'ok' || r.counts.unchanged !== 1) throw new Error(JSON.stringify(r).slice(0, 400));
    return `${r.counts.unchanged} attestation unchanged`;
  });
  // Publishing (Agora), on PLATO's customs tables: from PLATO_REPO, else the checkout CI makes beside
  // the tools, else a PLATO clone beside this one. Not found is a failure, not a skip.
  const plato = [process.env.PLATO_REPO, join(root, 'plato-repo'), join(root, '..', 'place-attestation-ontology')]
    .filter(Boolean).map((d) => resolve(root, d, 'schemas/tables/examples/customs')).find((d) => existsSync(d));
  // A PLATO checkout ahead of or behind the pin fails this for reasons that are not the tools' (as
  // test/paths.js and e2e/app_test.py also refuse); PLATO_REPO_ANY=1 runs anyway.
  step("PLATO's customs tables, at the pinned PLATO", () => {
    if (!plato) throw new Error('no PLATO checkout: set PLATO_REPO');
    const repo = resolve(plato, '../../../..'), pin = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).plato.commit;
    if (!process.env.PLATO_REPO_ANY && existsSync(join(repo, '.git'))) {
      try { execFileSync('git', ['-C', repo, 'diff', '--quiet', pin, '--', 'schemas'], { stdio: 'ignore' }); }
      catch { throw new Error(`${repo} is not at the pinned PLATO ${pin.slice(0, 7)} (or lacks it): set PLATO_REPO to a checkout of it, or PLATO_REPO_ANY=1`); }
    }
    cpSync(plato, join(app, 'customs'), { recursive: true }); return plato;
  });
  step('plato-tools publish report writes the deposit files', () => {
    const r = JSON.parse(sh(bin, ['publish', 'report', '--json', '--out', 'out', 'customs'], app));
    const deposit = join(app, 'out', 'customs-deposit');
    const missing = ['.zenodo.json', 'CITATION.cff', 'datacite.json'].filter((f) => !existsSync(join(deposit, f)));
    if (r.status !== 'ok' || missing.length) throw new Error(`missing ${missing.join(', ') || 'nothing'}; ${JSON.stringify(r).slice(0, 400)}`);
    return `${r.counts.fair.passed} of ${r.counts.fair.of} FAIR checks pass`;
  });
  step('plato-tools publish mint gives every attestation an address', () => {
    const r = JSON.parse(sh(bin, ['publish', 'mint', '--json', '--out', 'out', 'customs'], app));
    const places = readFileSync(join(app, 'out', 'customs-with-ids.jsonl'), 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l));
    const ids = places.flatMap((p) => p.attestations.map((a) => [p['@id'], a['@id'] || '']));
    // The count is the presence control: with no attestations at all, "every one" would hold.
    if (r.status !== 'ok' || ids.length !== 4 || !ids.every(([p, a]) => a.startsWith(`${p}#a-`))) throw new Error(JSON.stringify(ids));
    return `${ids.length} attestations, each <place>#a-…`;
  });
  step('nothing is left of patch-package', () => { const m = readdirSync(join(app, 'node_modules')); if (m.includes('patch-package')) throw new Error('patch-package is installed'); return ''; });
} finally { rmSync(dir, { recursive: true, force: true }); }
if (failed) { console.log('INSTALL TEST FAILED'); process.exit(1); }
console.log('INSTALL TEST PASSED');
