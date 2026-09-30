// The w3id folder's human parts: the namespace's README (which w3id asks for beside the rules), the
// pull request's title and body, the steps to take, and the shell script that runs tests.tsv. Agora
// never opens the pull request itself: w3id's maintainers expect it from a maintainer's own account,
// and nothing leaves the user's computer.
import { SITE_FILES } from './rules.js';

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const md = (s) => oneLine(s).replace(/([|\\`*_<>])/g, '\\$1');

// Local Apache, as w3id.org runs it: httpd 2.4 with mod_rewrite loaded (the image leaves it out) and
// .htaccess files allowed. mod_headers is loaded by the image already. The same command is what the
// test suite runs (test/agora-w3id.test.js), so the steps are tested as written.
export const APACHE_IMAGE = 'httpd:2.4';
export const APACHE_SETUP = "sed -i -e 's/^#LoadModule rewrite_module/LoadModule rewrite_module/' -e 's/AllowOverride [Nn]one/AllowOverride All/' conf/httpd.conf && exec httpd-foreground";
/** The arguments to `docker` that serve the folder `ids` (an absolute path) on `port`. */
export const apacheArgs = ({ ids, port = 8080, name = 'w3id-local', bind = '127.0.0.1' }) =>
  ['run', '--rm', '-d', '--name', name, '-p', `${bind}:${port}:80`, '-v', `${ids}:/usr/local/apache2/htdocs:ro`, APACHE_IMAGE, 'sh', '-c', APACHE_SETUP];
// The same, as STEPS.md shows it. APACHE_SETUP holds single quotes and no '"', '$' or '`', so it is
// safe inside double quotes.
const apacheCommand = (ids, name) => `docker run --rm -d --name ${name} -p 127.0.0.1:8080:80 \\\n    -v "${ids}:/usr/local/apache2/htdocs:ro" \\\n    ${APACHE_IMAGE} sh -c "${APACHE_SETUP}"`;
export const APACHE_COMMAND = apacheCommand('$PWD/ids', 'w3id-local');

const people = (c) => c.maintainers.map((m) => `[${m}](https://github.com/${m})`).join(', ');
const creators = (g) => (Array.isArray(g.creator) ? g.creator : g.creator ? [g.creator] : [])
  .map((x) => (typeof x === 'string' ? x : x && (x.name ? (x['@id'] ? `${x.name} (${x['@id']})` : x.name) : x['@id']))).filter(Boolean);

/** The README.md beside the rules: what the namespace is, what each address does, who keeps it. */
export function readme(c) {
  const g = c.gazetteer, S = c.site, T = c.turtle;
  const L = [];
  L.push(`# /${c.w3idPath}/`, '', `Persistent addresses for **${md(g.title)}**, a gazetteer published as PLATO data (the Place Attestation Ontology, https://w3id.org/plato).`, '');
  if (g.description) L.push(md(g.description), '');
  const by = creators(g);
  if (by.length) L.push(`Made by ${by.map(md).join('; ')}.`, '');
  L.push(`Every address redirects to the dataset's static site, ${S}, which cannot negotiate content: the rules here do it, and each branch lands on a file the site holds.`, '',
    '## Behaviour', '',
    '| Path | Behaviour |', '|---|---|',
    `| \`/\` | 303. \`text/html\` → the landing page, ${S}; \`application/ld+json\`, \`application/json\`, \`*/*\` or no \`Accept\` → the dataset's description in JSON-LD, \`${SITE_FILES.description}\`${T ? `; \`text/turtle\` → \`${SITE_FILES.descriptionTtl}\`` : ''}. |`);
  for (const part of ['place', 'source']) {
    L.push(`| \`/${part}/{key}\` | A ${part}, 303. \`text/html\` or \`application/xhtml+xml\` → its page, \`${SITE_FILES.page(part, '{key}')}\`; \`application/ld+json\`, \`application/json\`, \`*/*\` or no \`Accept\` → \`${SITE_FILES.jsonld(part, '{key}')}\`${T ? `; \`text/turtle\` → \`${SITE_FILES.ttl(part, '{key}')}\`` : ''}. A closing slash is allowed. |`,
      `| \`/${part}/{key}.jsonld\`, ${T ? '`.ttl`, ' : ''}\`.html\` | 302 to that file, whatever the \`Accept\` header. |`);
  }
  L.push(`| \`/download/{file}\` | 302 to the latest dataset, whole, on the site. |`);
  if (c.repo) L.push(`| \`/release/{name}\` | 303 to that release's page, \`https://github.com/${c.repo}/releases/tag/{name}\`: a frozen version of the dataset. |`,
    `| \`/release/{name}/{file}\` | 302 to one file of that release, which never changes. |`);
  L.push('| anything else | 404. Nothing falls through to the site. |', '',
    "`{key}` is letters, digits and `. _ ~ -`, not starting with `.`: the dataset's addresses are checked to be of that form before these rules are written. A key that is not in the dataset still redirects (the rules cannot know every key) and the site answers 404.", '',
    'Apache ignores q-values in `Accept`, so the rules are in order of preference: a browser sends `text/html` and `*/*` together, and the `text/html` rule comes first. `*/*` or no `Accept` (curl, scripts) gets JSON-LD rather than 404.', '');
  if (g.licence) L.push('## Licence of what resolves', '', `The data: ${g.licence}`, '');
  L.push('## Contact', '', ...c.maintainers.map((m) => `GitHub: [${m}](https://github.com/${m})<br/>`), '');
  return L.join('\n');
}

/** PULL_REQUEST.md: the title on the first line, then the body to paste (everything after the '---' line). */
export function pullRequest(c) {
  const g = c.gazetteer;
  const title = c.w3idPath.includes('/') ? `${c.w3idPath}: add persistent addresses for ${oneLine(g.title)}` : `New namespace: ${c.w3idPath} (${oneLine(g.title)})`;
  const L = [title, '', '---', '',
    `**${c.w3idPath.includes('/') ? 'New sub-namespace' : 'New namespace'}: \`${c.w3idPath}\`**: persistent addresses for ${md(g.title)}, a gazetteer published as PLATO data (https://w3id.org/plato).`, ''];
  if (g.description) L.push(md(g.description), '');
  L.push(`**What resolves.** The dataset (\`/${c.w3idPath}/\`), each of its ${c.counts.places.toLocaleString('en-GB')} places (\`/${c.w3idPath}/place/{key}\`) and ${c.counts.sources.toLocaleString('en-GB')} sources (\`/${c.w3idPath}/source/{key}\`)${c.repo ? `, each release (\`/${c.w3idPath}/release/{name}\`, from the GitHub repository ${c.repo})` : ''} and the downloads. Everything goes to static files on ${c.site}, which cannot negotiate content, so the \`.htaccess\` does: \`text/html\` to a page; JSON-LD, JSON, \`*/*\` or no \`Accept\` to the JSON-LD file${c.turtle ? '; `text/turtle` to Turtle' : ''}; explicit suffixes win over \`Accept\`. The text/html rule comes before the \`*/*\` fallback because Apache ignores q-values. Anything else is 404. The README says what each address does.`, '',
    `**Maintainers.** ${people(c)} (GitHub user names in the \`.htaccess\` and the README).`, '',
    '**Checks.** The rules were tested in a local Apache (httpd 2.4, mod_rewrite, AllowOverride All) with the addresses in the output below, real addresses of the dataset, with and without each `Accept` header and suffix, and malformed paths that must answer 404:', '',
    '```', '<!-- paste the output of: sh test-w3id.sh http://localhost:8080 -->', '```', '',
    '## General Checklist',
    '- [x] Changes have been tested.',
    '- [x] The number of commits is minimal. Squash if needed.',
    '- [x] Commits only include redirects and basic information. Serving content and full documentation is not supported on this service.', '');
  if (c.w3idPath.includes('/')) L.push('## Update ID Directory Checklist',
    '- [x] GitHub username ids are listed in the changed maintainer details.',
    `- [ ] The GitHub account submitting this PR is listed as a maintainer of \`${c.w3idPath.split('/')[0]}\`, or one of its maintainers is tagged to approve these changes.`, '');
  else L.push('## New ID Directory Checklist',
    '- [x] Maintainer details are in `.htaccess` or `README.md`.',
    '- [x] GitHub username ids are listed in the maintainer details.', '');
  return L.join('\n');
}

/** STEPS.md: what the user does, from testing the rules here to the pull request and after. */
export function steps(c) {
  const P = c.w3idPath, branch = P.replace(/\//g, '-');
  const top = P.split('/')[0];
  return [
    `# Registering https://w3id.org/${P}/`, '',
    'PLATO tools wrote this folder; it does not open the pull request. w3id.org expects it from a maintainer\'s own GitHub account, and once it is merged these addresses are public and meant to be cited for good.', '',
    '## 1. Before you start', '',
    `- The site must be live at ${c.site}: the rules only send people there. Check that ${c.site}${SITE_FILES.description} answers 200.`,
    `- The name must be free: https://github.com/perma-id/w3id.org/tree/master/ids/${P} should not exist${P.includes('/') ? `. \`${top}\` is someone's namespace already, or will be: a sub-namespace needs the agreement of its maintainers` : ''}. w3id's folders are compared ignoring case on some systems, so a name that differs only in case is taken too.`,
    `- Every maintainer (${c.maintainers.join(', ')}) should agree to be named.`, '',
    '## 2. Test the rules here, in a local Apache', '',
    'With Docker installed, from this folder:', '',
    '```sh',
    'chmod -R a+rX ids',
    APACHE_COMMAND,
    'sh test-w3id.sh http://localhost:8080',
    'docker rm -f w3id-local',
    '```', '',
    'Every line should say PASS. The container serves `ids/` as w3id.org does (Apache 2.4, mod_rewrite, `AllowOverride All`); the script asks for each address in `tests.tsv` with the `Accept` header given there and compares the status and `Location` with what is expected. Save the output: it goes in the pull request.', '',
    '## 3. The pull request', '',
    '```sh',
    'gh repo fork perma-id/w3id.org --clone && cd w3id.org   # or fork on github.com and clone your fork',
    'git fetch upstream && git switch -c ' + branch + ' upstream/master',
    `mkdir -p ids/${P} && cp -p "<this folder>/ids/${P}/.htaccess" "<this folder>/ids/${P}/README.md" ids/${P}/`,
    `git add ids/${P} && git commit -m "${P}: persistent addresses for ${oneLine(c.gazetteer.title).replace(/["`$\\]/g, '')}"`,
    '```', '',
    'Test once more in the fork, where w3id\'s own rules (ids/.htaccess) apply too: run the same `docker run` from the fork\'s top folder, with `-v "$PWD/ids:…"` as above, and `sh "<this folder>/test-w3id.sh" http://localhost:8080`.', '',
    'Keep it to ONE commit (w3id asks for that): if you changed anything, `git commit --amend`, or squash with `git reset --soft upstream/master && git commit`. Then:', '',
    '```sh',
    `git push -u origin ${branch}`,
    `sed '1,/^---$/d' "<this folder>/PULL_REQUEST.md" > /tmp/w3id-pr.md   # the body; paste the test output into it`,
    `gh pr create --repo perma-id/w3id.org --title "$(head -n 1 "<this folder>/PULL_REQUEST.md")" --body-file /tmp/w3id-pr.md`,
    '```', '',
    'Or open it on github.com: the title is the first line of PULL_REQUEST.md, the body everything after the `---` line.', '',
    '## 4. After it is merged', '',
    '```sh',
    'sh test-w3id.sh https://w3id.org',
    '```', '',
    'Every line should say PASS against the live service too. From then on the addresses are public: a place or source that is published keeps its address; withdraw it in the data, never delete it.', '',
  ].join('\n');
}

/** test-w3id.sh: POSIX sh and curl, so it runs wherever the user has a shell. */
export function script(c) {
  return `#!/bin/sh
# Test the w3id rules for https://w3id.org/${c.w3idPath}/ : ask for every address in tests.tsv, with
# its Accept header, and compare the status, the Location and the CORS header with what is expected.
#
#   sh test-w3id.sh http://localhost:8080     the rules in a local Apache (see STEPS.md)
#   sh test-w3id.sh                           the live service, https://w3id.org
#
# Exit status: 0 if every address passes, 1 if any fails, 2 if curl is missing.
BASE=\${1:-https://w3id.org}
BASE=\${BASE%/}
TSV=\${2:-$(dirname "$0")/tests.tsv}
command -v curl >/dev/null 2>&1 || { echo "test-w3id.sh: curl is needed" >&2; exit 2; }
tab=$(printf '\\t')
cr=$(printf '\\r')
pass=0
fail=0
while IFS="$tab" read -r path accept status location note; do
  case "$path" in path|'#'*|'') continue ;; esac
  if [ "$accept" = "-" ]; then h='Accept:'; else h="Accept: $accept"; fi
  head=$(curl -s -o /dev/null -D - -H "$h" "$BASE/$path" | tr -d "$cr")
  code=$(printf '%s\\n' "$head" | sed -n '1s/^HTTP\\/[0-9.]* \\([0-9][0-9]*\\).*/\\1/p')
  loc=$(printf '%s\\n' "$head" | sed -n 's/^[Ll][Oo][Cc][Aa][Tt][Ii][Oo][Nn]: *//p')
  cors=$(printf '%s\\n' "$head" | grep -ci '^access-control-allow-origin: *\\*$')
  want=$(printf '%s' "$location" | sed "s#{base}#$BASE#")
  [ "$want" = "-" ] && want=""
  if [ "$code" = "$status" ] && [ "$loc" = "$want" ] && [ "$cors" -ge 1 ]; then
    pass=$((pass + 1)); echo "PASS  $status  /$path  [$accept]"
  else
    fail=$((fail + 1)); echo "FAIL  /$path  [$accept]  ($note)"
    echo "      expected $status \${want:-(no Location)}"
    echo "      got      \${code:-(no answer)} \${loc:-(no Location)}$([ "$cors" -ge 1 ] || echo ', and no Access-Control-Allow-Origin: *')"
  fi
done < "$TSV"
echo "$pass passed, $fail failed, against $BASE"
[ "$fail" -eq 0 ]
`;
}

