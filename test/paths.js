// Where the tests find the PLATO repository (examples) and the DEEP exports (optional, large).
// CI checks PLATO out at the pinned commit and sets PLATO_REPO; DEEP tests skip without the data.
export const PLATO_REPO = process.env.PLATO_REPO || '../place-attestation-ontology';
export const DEEP_EXPORT = process.env.DEEP_EXPORT || '../deep/data/export';

// A PLATO_REPO ahead of or behind the pin fails tests for reasons that are not the tools' (or passes
// them for the wrong ones), so the tests stop unless it holds the pinned commit's schemas and examples.
// PLATO_REPO_ANY=1 runs anyway. e2e/app_test.py does the same.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const PIN = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).plato.commit;
if (!process.env.PLATO_REPO_ANY && existsSync(`${PLATO_REPO}/.git`)) {
  const git = (...a) => { try { execFileSync('git', ['-C', PLATO_REPO, ...a], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (!git('cat-file', '-e', `${PIN}^{commit}`))
    throw new Error(`PLATO_REPO (${PLATO_REPO}) does not have the pinned commit ${PIN.slice(0, 7)}: fetch it, or set PLATO_REPO to a checkout of it`);
  if (!git('diff', '--quiet', PIN, '--', 'ontology.ttl', 'schemas', 'examples'))
    throw new Error(`PLATO_REPO (${PLATO_REPO}) has schemas or examples that differ from the pinned ${PIN.slice(0, 7)}: set PLATO_REPO to a checkout of it (or PLATO_REPO_ANY=1 to run anyway)`);
}
