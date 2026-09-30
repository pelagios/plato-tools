// Which commit of PLATO tools is running, so that the site's workflow can run exactly the same one
// (npx github:pelagios/plato-tools#<commit>) and the site it builds on GitHub is the site built here.
// A version number will not do: it changes only at a release, and its tag may not exist.
//
// Asked in this order, the first that knows wins:
//   1. git itself, when the tools run from a clone of their own repository (a developer's checkout,
//      or the page's build on GitHub): the commit checked out now, not the one of the last install;
//   2. the lockfile of the project the tools are installed in (npx's own cache is one): npm records
//      there the full commit a git dependency resolved to (resolved: git+ssh://…#<sha>), whether it
//      cloned it or fetched its tarball, which has no .git to ask;
//   3. src/build-info.json, which scripts/build-info.mjs writes before the page is built (and which
//      the page reads, having no git and no lockfile of its own). It is in .gitignore, so npm leaves
//      it out of a git install's package: the lockfile is what serves there.
// Null when none knows; the site then says so, and pins the version's tag.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const INFO_FILE = join(ROOT, 'src', 'build-info.json');
const SHA = /^[0-9a-f]{40}$/;

/**
 * The commit git says `root` is at, only if `root` is the top of its own repository: installed
 * inside someone else's repository (node_modules/plato-tools), git would answer for theirs.
 */
export function commitFromGit(root = ROOT) {
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (resolve(git('rev-parse', '--show-toplevel')) !== resolve(root)) return null;
    const sha = git('rev-parse', 'HEAD');
    return SHA.test(sha) ? sha : null;
  } catch { return null; }   // no git, or not a repository
}

/** The commit npm resolved plato-tools to, from the lockfile of the project it is installed in. */
export function commitFromLockfile(root = ROOT) {
  const at = root.lastIndexOf(sep + 'node_modules' + sep);
  if (at < 0) return null;
  const project = root.slice(0, at);
  const entry = 'node_modules/' + root.slice(at + '/node_modules/'.length).split(sep).join('/');
  // npm keeps a lockfile inside node_modules too (.package-lock.json), npx's cache included.
  for (const lock of [join(project, 'node_modules', '.package-lock.json'), join(project, 'package-lock.json')]) {
    try {
      const resolved = JSON.parse(readFileSync(lock, 'utf8')).packages?.[entry]?.resolved;
      const m = typeof resolved === 'string' && /#([0-9a-f]{40})$/.exec(resolved);
      if (m) return m[1];
    } catch { /* not there, or not a lockfile */ }
  }
  return null;
}

/** What src/build-info.json records, if it was written and names a commit. */
export function commitFromInfo(file = INFO_FILE) {
  try { const c = JSON.parse(readFileSync(file, 'utf8')).commit; return typeof c === 'string' && SHA.test(c) ? c : null; } catch { return null; }
}

/** The commit of PLATO tools that is running, and how it is known; or null. */
export function toolsCommit({ root = ROOT, infoFile = INFO_FILE } = {}) {
  for (const [from, find] of [['git', () => commitFromGit(root)], ['lockfile', () => commitFromLockfile(root)], ['build-info', () => commitFromInfo(infoFile)]]) {
    const commit = find();
    if (commit) return { commit, from };
  }
  return null;
}

/**
 * Write src/build-info.json (scripts/build-info.mjs). PLATO_TOOLS_COMMIT, if set, is the commit (a
 * build that knows it some other way); else git. When neither knows, a file already written is kept
 * rather than emptied; with none, one saying null is written, so the page can be built all the same.
 */
export function writeBuildInfo({ root = ROOT, file = INFO_FILE, env = process.env, write = writeFileSync } = {}) {
  const given = env.PLATO_TOOLS_COMMIT && SHA.test(env.PLATO_TOOLS_COMMIT) ? env.PLATO_TOOLS_COMMIT : null;
  const commit = given || commitFromGit(root);
  if (!commit && existsSync(file) && commitFromInfo(file)) return { commit: commitFromInfo(file), kept: true };
  const info = { commit: commit || null, from: given ? 'PLATO_TOOLS_COMMIT' : commit ? 'git' : null };
  write(file, JSON.stringify(info, null, 2) + '\n');
  return info;
}
