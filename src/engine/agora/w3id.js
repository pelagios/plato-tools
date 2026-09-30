// Agora, part 'w3id': the folder of redirect rules that gives a published dataset permanent
// addresses at w3id.org, with what is needed to have them accepted there. Into a tree named
// w3id-<namespace, '/' as '-'>:
//   ids/<namespace>/.htaccess    the rules (w3id/rules.js), to copy into a fork of perma-id/w3id.org
//   ids/<namespace>/README.md    what the namespace is and what each address does, for people
//   tests.tsv                    real addresses of the dataset, each with an Accept header and what
//                                must come back; test-w3id.sh runs them against local Apache or w3id
//   test-w3id.sh                 POSIX sh and curl
//   PULL_REQUEST.md, STEPS.md    the pull request, and how to test and open it (Agora never opens it)
//
// The rules are the same for every key, so they do not grow with the dataset: the dataset is read
// to check that every place's and source's address is one the rules can reach (keyProblem, no key
// read as a suffix, no two keys the same but for case), and for a few real keys to test with.
//
// Only for a dataset that is published (E1): once w3id's maintainers merge the rules, the addresses
// are public and meant to be cited for good. Only for a w3id base (E2): any other base IS the site's
// address, and needs no redirects.
import { keyProblem, releaseProblem, caseGuard, normaliseBase } from './address.js';
import { htaccess, testRows, toTsv, SUFFIXES, SITE_FILES } from './w3id/rules.js';
import { readme, pullRequest, steps, script } from './w3id/texts.js';

export { SITE_FILES };
// How many places and how many sources are tested by name.
export const EXAMPLES = 3;

// Why there are no w3id rules for a base of each other kind (address.js baseKind), and what to do.
const NOT_W3ID = {
  custom: "The dataset's base address is not at w3id.org, so there are no w3id rules to write: its own domain is its address. Publish the site there (the site part writes the CNAME file GitHub Pages needs) and keep the domain for good; or give a w3id.org base address instead (--base https://w3id.org/<name>/).",
  'github.io': "The dataset's base address is a GitHub Pages address, which changes if the repository is renamed or moves, so it is not a permanent address and there are no w3id rules for it. Choose a w3id.org base address (--base https://w3id.org/<name>/): it redirects to the Pages site, and can be pointed elsewhere later.",
  local: "The dataset's base address is on this computer or a private network, which nobody else can reach, so there are no w3id rules for it. Choose a w3id.org base address (--base https://w3id.org/<name>/) for publishing.",
  example: "The dataset's base address is a stand-in (example.org, or PLATO's examples), not the dataset's own, so there are no w3id rules for it. Choose a w3id.org base address (--base https://w3id.org/<name>/) for publishing.",
};

export const TEXT = {
  'not-w3id': NOT_W3ID.custom,
  'not-published': "The dataset does not say that it is published (its status is not 'published'). The w3id pull request makes its addresses public and citable for good, so the rules are written only for a published dataset: set its status to published when it is ready.",
  'no-maintainers': 'w3id.org needs the GitHub user names of those who maintain the namespace: give at least one (--maintainer NAME, once for each).',
  'bad-maintainer': 'A maintainer is not a GitHub user name (letters, digits and single hyphens, at most 39 characters, not starting or ending with a hyphen).',
  'no-site-url': "The rules redirect to the dataset's site, and where that is is not known: give the GitHub repository it is published from (--repo OWNER/NAME), or its address (--site-url).",
  'bad-repo': 'The repository is not of the form OWNER/NAME (a GitHub user or organisation, then letters, digits and . _ -).',
  'bad-site-url': "The site's address is not one the rules can hold: an http(s) address of letters, digits and . _ ~ - / only, with no query or fragment.",
  'site-is-base': "The site's address is the base address itself: the rules would redirect to themselves. Give the site's own address (--site-url, or --repo for GitHub Pages).",
  'site-not-https': "The site's address is not https: browsers warn about, or refuse, a redirect from a secure address to it.",
  'bad-w3id-path': "The w3id name (the base address's path) has characters other than letters, digits and . _ ~ -, or a part starting with '.', which w3id's folders cannot hold.",
  'w3id-path-case': "The w3id name has capital letters. w3id's folders are compared ignoring case on some systems, and addresses are mostly typed in lower case: a lower-case name is safer.",
  'bad-release': "The release name is not one the rules can reach: letters, digits and . _ ~ -, not starting with '.'.",
  'release-without-repo': 'A release is named, but not the GitHub repository it is published in (--repo), so there are no rules for releases and its address would answer 404.',
  'key-unreachable': "The address of a place or source cannot be served by the rules or the site: its last part is empty or more than one part, has characters other than letters, digits and . _ ~ -, or starts with '.'. Give it an address of those characters only; the example names it and says what is wrong.",
  'key-suffix': "The address of a place or source ends in .jsonld, .ttl or .html, which the rules read as a request for another key's file in that format, so its own address would go to the wrong place. Give it an address without that ending.",
  'key-case': 'Two places or two sources have addresses that differ only in capital letters. On macOS and Windows these are one file, so the site would serve one for both. Give one of them another address; the example names both.',
  'place-outside-base': "A place's address is not under the dataset's base address, so these rules do not reach it: it resolves only if someone else's rules send it somewhere.",
  'place-without-address': 'A place has no address (@id), so there is nothing to redirect for it.',
};

const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})$/;
// What may go into a rule's target: nothing Apache would read as syntax (a space, '$', '%', a quote).
const SITE_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/;
const SEGMENT_OK = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
const SUFFIX = new RegExp(`\\.(${SUFFIXES.join('|')})$`, 'i');

/**
 * Where the rules send people: `siteUrl` if given, else the GitHub Pages address of `repo`
 * (https://<owner>.github.io/<name>/, the owner in lower case; a repository named <owner>.github.io
 * is served at the root). Returns { site } or { error: kind }.
 */
export function siteTarget({ siteUrl, repo } = {}) {
  if (siteUrl) {
    const s = normaliseBase(siteUrl);
    return s && SITE_URL.test(s) ? { site: s } : { error: 'bad-site-url' };
  }
  if (repo) {
    const m = REPO.exec(repo);
    if (!m) return { error: 'bad-repo' };
    const owner = m[1].toLowerCase();
    return { site: m[2].toLowerCase() === `${owner}.github.io` ? `https://${owner}.github.io/` : `https://${owner}.github.io/${m[2]}/` };
  }
  return { error: 'no-site-url' };
}

export function create(ctx) {
  const { rep, options } = ctx;
  const guard = caseGuard();
  const examples = { place: [], source: [] };
  const sources = new Set();
  const counts = { places: 0, sources: 0 };
  let sourcePrefix = null;

  // A key found in the data: can the rules and the site serve it?
  function key(part, k, iri) {
    const why = k === null ? 'is empty or more than one part' : keyProblem(k);
    if (why) { rep.add('error', 'key-unreachable', TEXT['key-unreachable'], `${iri}: its last part ${why}`); return; }
    if (SUFFIX.test(k)) { rep.add('error', 'key-suffix', TEXT['key-suffix'], iri); return; }
    const twin = guard.add(part, k);
    if (twin) { rep.add('error', 'key-case', TEXT['key-case'], `${part}/${twin} and ${part}/${k}`); return; }
    if (examples[part].length < EXAMPLES && !examples[part].includes(k)) examples[part].push(k);
  }
  // A source is cited wherever an attestation cites it (as a string, or an object's @id): every
  // string under <base>source/ in a record is one. Each is looked at once.
  function walk(v) {
    if (typeof v === 'string') {
      if (sourcePrefix && v.startsWith(sourcePrefix)) {
        const id = v.split('#')[0];
        if (!sources.has(id)) { sources.add(id); counts.sources++; key('source', ctx.scheme.sourceKey(id), id); }
      }
    } else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  }

  // The gates, then what the rules are made of, each checked before any of it goes into them.
  // Returns what the files are made from, or null when anything stops them being written.
  function settle() {
    rep.count('places', counts.places);
    rep.count('sources', counts.sources);
    if (ctx.blocked()) return null;
    const s = ctx.scheme, g = ctx.gazetteer;
    if (s.kind !== 'w3id') { rep.add('error', 'not-w3id', NOT_W3ID[s.kind] || NOT_W3ID.custom, s.base); return null; }
    if (g.status !== 'published') { rep.add('error', 'not-published', TEXT['not-published'], g.status === undefined ? '(no status)' : String(g.status)); return null; }
    if (s.w3idPath.split('/').some((p) => !SEGMENT_OK.test(p))) rep.add('error', 'bad-w3id-path', TEXT['bad-w3id-path'], s.w3idPath);
    else if (/[A-Z]/.test(s.w3idPath)) rep.add('warning', 'w3id-path-case', TEXT['w3id-path-case'], s.w3idPath);
    const maintainers = [...new Set((options.maintainers || []).map((m) => String(m).trim().replace(/^@/, '')).filter(Boolean))];
    if (!maintainers.length) rep.error('no-maintainers', TEXT['no-maintainers']);
    for (const m of maintainers) if (!GITHUB_USER.test(m)) rep.add('error', 'bad-maintainer', TEXT['bad-maintainer'], m);
    const t = siteTarget(options);
    if (t.error) rep.add('error', t.error, TEXT[t.error], t.error === 'bad-repo' ? options.repo : t.error === 'bad-site-url' ? options.siteUrl : undefined);
    else if (t.site === s.base) rep.add('error', 'site-is-base', TEXT['site-is-base'], t.site);
    else if (t.site.startsWith('http:')) rep.add('warning', 'site-not-https', TEXT['site-not-https'], t.site);
    // With --site-url the repository is only for releases, and is checked here.
    const repo = options.repo || null;
    if (repo && options.siteUrl && !REPO.test(repo)) rep.add('error', 'bad-repo', TEXT['bad-repo'], repo);
    let release = options.release || null;
    if (release && releaseProblem(release)) { rep.add('error', 'bad-release', TEXT['bad-release'], release); release = null; }
    if (release && !repo) rep.add('warning', 'release-without-repo', TEXT['release-without-repo'], release);
    if (rep.toJSON().errors) return null;
    return {
      w3idPath: s.w3idPath, base: s.base, site: t.site, repo, release, turtle: !!options.turtle, maintainers,
      title: g.title, gazetteer: g, examples, counts,
      // The downloads' short name, which the site puts before each download's suffix (SITE.downloads).
      stem: s.w3idPath.split('/').pop(),
    };
  }

  return {
    header() { sourcePrefix = ctx.scheme ? ctx.scheme.base + 'source/' : null; },
    event(ev) {
      if (!ctx.scheme || ev.type !== 'record' || !ev.value) return;
      const s = ctx.scheme, id = ev.value['@id'];
      counts.places++;
      if (typeof id !== 'string') rep.add('warning', 'place-without-address', TEXT['place-without-address'], ev.value.label);
      else if (!id.startsWith(s.base + 'place/')) rep.add('warning', 'place-outside-base', TEXT['place-outside-base'], id);
      else key('place', s.placeKey(id), id);
      walk(ev.value.attestations);
    },
    async finish() {
      const c = settle();
      if (!c) { (rep.counts.said ||= []).push('Nothing was written.'); return; }
      const rows = testRows(c);
      const tree = await ctx.tree('w3id-' + c.w3idPath.replace(/\//g, '-'));
      await ctx.put(tree, `ids/${c.w3idPath}/.htaccess`, htaccess(c));
      await ctx.put(tree, `ids/${c.w3idPath}/README.md`, readme(c));
      await ctx.put(tree, 'tests.tsv', toTsv(rows));
      await ctx.put(tree, 'test-w3id.sh', script(c));
      await ctx.put(tree, 'PULL_REQUEST.md', pullRequest(c));
      await ctx.put(tree, 'STEPS.md', steps(c));
      ctx.done(await tree.close());
      rep.count('addresses to test', rows.length);
      (rep.counts.said ||= []).push(`Redirect rules for ${c.base}, to the site at ${c.site}, for ${counts.places.toLocaleString('en-GB')} place${counts.places === 1 ? '' : 's'} and ${counts.sources.toLocaleString('en-GB')} source${counts.sources === 1 ? '' : 's'}, with ${rows.length} addresses to test (tests.tsv). STEPS.md says how to test them and open the pull request.`);
    },
  };
}
