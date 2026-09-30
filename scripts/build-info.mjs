// Record which commit of PLATO tools this is, in src/build-info.json, while git can still say it:
// the site's workflow runs that commit (src/node/build-info.js says how it is found, and why).
// Run before the page is built (npm's prebuild), so that the page, which has no git to ask, knows the
// commit it was built from. It never fails the build: without git it writes null, or keeps what an
// earlier run wrote.
//   node scripts/build-info.mjs
//   PLATO_TOOLS_COMMIT=<sha> node scripts/build-info.mjs     when the commit is known otherwise
import { writeBuildInfo, INFO_FILE } from '../src/node/build-info.js';

try {
  const info = writeBuildInfo();
  console.log(`build-info: ${info.commit ? `PLATO tools at ${info.commit}${info.kept ? ' (kept from an earlier run)' : ''}` : 'the commit is not known'} (${INFO_FILE})`);
} catch (e) {
  console.warn(`build-info: not written (${e.message}); the site's workflow will pin the version's tag instead`);
}
