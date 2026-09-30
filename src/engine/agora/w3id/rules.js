// The w3id folder's two machine parts: the redirect rules (.htaccess) and the addresses that test
// them (tests.tsv). Both are made from one description of the namespace, so a rule and the rows
// that test it cannot disagree about where an address goes.
//
// w3id.org runs Apache: each namespace is a folder ids/<name>/ whose .htaccess rewrites the path
// under it (without the leading '<name>/') to a redirect. The dataset's site is static (GitHub
// Pages), which cannot negotiate content, so all the negotiating is done here and every branch must
// land on a file the site holds. Apache matches the Accept header as text and ignores q-values, so
// the ORDER of the rules is the preference: a browser's Accept also contains */*, and the rule for
// text/html must come before the fallback for */* or every browser is sent JSON-LD (decision D6).
import { SITE } from '../address.js';

// A key as a rule may capture it: the characters address.js allows (SAFE), not starting with '.'
// (keyProblem refuses those), so a rule for place/ cannot capture a hidden file, '..', a deeper
// path or anything encoded. test/agora-w3id.test.js holds this to keyProblem's verdict.
export const KEY = '[A-Za-z0-9_~-][A-Za-z0-9._~-]*';
// A release name (releaseProblem) and a file name in a release or download/ are the same shape: one
// path segment, so release/<name>/<file> cannot reach further.
export const SEGMENT = KEY;
// The suffixes that name one representation of a place or source. A key that itself ends in one
// is read by the suffix rule as another key's file, so such keys are refused (w3id.js).
export const SUFFIXES = ['jsonld', 'ttl', 'html'];

// What a browser sends (Firefox's and Chrome's, less their image types): text/html first, and
// */* at the end, which is why the order of the rules matters.
export const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
// No Accept header at all, in tests.tsv (a tab-separated file cannot hold an empty field that the
// shell's read keeps).
export const NO_ACCEPT = '-';

/**
 * The files of the site the rules send people to, by what they are (relative to the site's root).
 * The site part must write exactly these: every redirect lands on one of them.
 */
export const SITE_FILES = {
  landing: '',                                  // the landing page (SITE.landing, served for the directory)
  description: SITE.description,                // the dataset's description as JSON-LD
  descriptionTtl: SITE.descriptionTtl,          // the same in Turtle, only with --turtle
  page: (part, key) => `${part}/${key}/`,       // a place's or source's page (its index.html)
  jsonld: (part, key) => `${part}/${key}.jsonld`,
  ttl: (part, key) => `${part}/${key}.ttl`,
  download: (file) => `download/${file}`,
};

// Accept is matched as a regular expression: '+', '.' and '*' are escaped (w3id's own examples escape '+').
const esc = (mime) => mime.replace(/[+.*]/g, (c) => '\\' + c);
const accepts = (types) => types.map((t, i) => `RewriteCond %{HTTP_ACCEPT} ${t === '' ? '^$' : esc(t)}${i < types.length - 1 ? ' [OR]' : ''}`).join('\n');
const HTML = ['text/html', 'application/xhtml+xml'], JSONLD = ['application/ld+json', 'application/json'], TURTLE = ['text/turtle'], ANY = ['*/*', ''];

/** The GitHub user names as w3id asks for them, one comment line each. */
const maintainerLines = (names) => names.map((n) => `# GitHub username: ${n}`).join('\n');

/**
 * The .htaccess for a namespace. `c`: { w3idPath, base, site, repo, turtle, maintainers, title }.
 * `site` ends in '/'; `repo` ('owner/name') or null. Every value put into a rule has been checked
 * (w3id.js) to hold none of the characters Apache would read as syntax.
 */
export function htaccess(c) {
  const S = c.site, T = c.turtle;
  const out = [];
  const add = (...lines) => out.push(...lines);
  add(`# ${c.w3idPath}: persistent addresses for ${oneLine(c.title)}`,
    `# ${c.base}`,
    '#',
    '# Written by PLATO tools (Agora) from the dataset\'s own addresses. Every address redirects to the',
    '# dataset\'s static site, which cannot negotiate content, so each negotiated branch below lands on',
    `# a file the site holds. The site: ${S}`,
    '# Apache ignores q-values in Accept, so the order of the rules is the preference: a browser sends',
    '# text/html AND */*, and the text/html rule comes before the fallback.',
    '# The README beside this file says what each address does.',
    '#',
    '# Maintainers:',
    maintainerLines(c.maintainers),
    '',
    'Options +FollowSymLinks',
    'RewriteEngine on',
    '',
    '# Cross-origin requests, so a web page can read the data. "always", because Apache\'s plain',
    '# "Header set" adds the header only to 2xx answers, and a browser checks it on the redirect too.',
    'Header always set Access-Control-Allow-Origin *',
    '');
  // The dataset itself: the namespace's root.
  add('# ---------------------------------------------------------------------------------------------------',
    `# The dataset: its landing page for people, its description (JSON-LD${T ? ' or Turtle' : ''}) for machines.`,
    accepts(HTML), `RewriteRule ^$ ${S}${SITE_FILES.landing} [R=303,L]`, '',
    accepts(JSONLD), `RewriteRule ^$ ${S}${SITE_FILES.description} [R=303,L]`, '');
  if (T) add(accepts(TURTLE), `RewriteRule ^$ ${S}${SITE_FILES.descriptionTtl} [R=303,L]`, '');
  add('# No stated preference (*/* or no Accept, what curl and most scripts send): JSON-LD, not 404.',
    accepts(ANY), `RewriteRule ^$ ${S}${SITE_FILES.description} [R=303,L]`, '');
  for (const part of ['place', 'source']) add(...partRules(part, S, T));
  add('# ---------------------------------------------------------------------------------------------------',
    '# The latest dataset whole, as files on the site.',
    `RewriteRule ^download/(${SEGMENT})$ ${S}download/$1 [R=302,L]`, '');
  if (c.repo) add('# ---------------------------------------------------------------------------------------------------',
    '# Releases: each a frozen version of the dataset, published on GitHub. release/<name> is the version',
    '# (its page); release/<name>/<file> is one of its files, which never changes.',
    `RewriteRule ^release/(${SEGMENT})/?$ https://github.com/${c.repo}/releases/tag/$1 [R=303,L]`,
    `RewriteRule ^release/(${SEGMENT})/(${SEGMENT})$ https://github.com/${c.repo}/releases/download/$1/$2 [R=302,L]`, '');
  add('# Nothing else is an address in this namespace, and nothing falls through to the site.',
    'RewriteRule ^.*$ - [R=404,L]', '');
  return out.join('\n');
}

function partRules(part, S, T) {
  const k = `^${part}/(${KEY})`;
  const page = SITE_FILES.page(part, '$1'), jsonld = SITE_FILES.jsonld(part, '$1'), ttl = SITE_FILES.ttl(part, '$1');
  const lines = [
    '# ---------------------------------------------------------------------------------------------------',
    `# ${part === 'place' ? 'Places' : 'Sources'}: ${part}/<key>, with or without a closing slash.`,
    '# An explicit suffix is what a person pastes and a footnote cites: it wins over any Accept header.',
    `RewriteRule ${k}\\.jsonld$ ${S}${jsonld} [R=302,L]`,
    T ? `RewriteRule ${k}\\.ttl$ ${S}${ttl} [R=302,L]` : `RewriteRule ${k}\\.ttl$ - [R=404,L]`,
    `RewriteRule ${k}\\.html$ ${S}${page} [R=302,L]`,
    '',
    accepts(HTML), `RewriteRule ${k}/?$ ${S}${page} [R=303,L]`, '',
    accepts(JSONLD), `RewriteRule ${k}/?$ ${S}${jsonld} [R=303,L]`, '',
  ];
  if (T) lines.push(accepts(TURTLE), `RewriteRule ${k}/?$ ${S}${ttl} [R=303,L]`, '');
  lines.push(accepts(ANY), `RewriteRule ${k}/?$ ${S}${jsonld} [R=303,L]`, '');
  return lines;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The addresses that test the rules: one row per request, with what must come back. `c` as for
 * htaccess(), plus `examples` ({ place: [keys], source: [keys] }, real keys of the dataset),
 * `release` (a release name, tested only with a repository) and `stem` (the downloads' short name).
 * A location of '{base}…' is relative to wherever the rules are served (local Apache or w3id.org);
 * '-' means none.
 */
export function testRows(c) {
  const rows = [], S = c.site, T = c.turtle, P = c.w3idPath;
  const row = (path, acc, status, location, note) => rows.push({ path: path === null ? P : `${P}/${path}`, accept: acc, status, location: location ?? '-', note });
  const json = S + SITE_FILES.description;
  row('', BROWSER, 303, S + SITE_FILES.landing, 'the dataset, from a browser: its landing page');
  row('', 'application/ld+json', 303, json, 'the dataset, as JSON-LD: its description');
  row('', 'application/json', 303, json, 'the dataset, as JSON: its description in JSON-LD');
  row('', 'text/turtle', T ? 303 : 404, T ? S + SITE_FILES.descriptionTtl : null, T ? 'the dataset, as Turtle' : 'Turtle, which this site does not hold');
  row('', '*/*', 303, json, 'the dataset, with no preference (*/*): JSON-LD');
  row('', NO_ACCEPT, 303, json, 'the dataset, with no Accept header: JSON-LD');
  row(null, '*/*', 301, `{base}/${P}/`, 'the namespace without its closing slash: Apache adds it');
  for (const part of ['place', 'source']) {
    for (const key of c.examples[part] || []) {
      const page = S + SITE_FILES.page(part, key), jl = S + SITE_FILES.jsonld(part, key), tt = S + SITE_FILES.ttl(part, key);
      const at = `${part}/${key}`;
      row(at, BROWSER, 303, page, `a ${part}, from a browser: its page`);
      row(at, 'application/xhtml+xml', 303, page, `a ${part}, as XHTML: its page`);
      row(at, 'application/ld+json', 303, jl, `a ${part}, as JSON-LD`);
      row(at, 'application/json', 303, jl, `a ${part}, as JSON: JSON-LD`);
      row(at, 'text/turtle', T ? 303 : 404, T ? tt : null, T ? `a ${part}, as Turtle` : 'Turtle, which this site does not hold');
      row(at, '*/*', 303, jl, `a ${part}, with no preference (*/*): JSON-LD`);
      row(at, NO_ACCEPT, 303, jl, `a ${part}, with no Accept header: JSON-LD`);
      row(at, 'image/png', 404, null, 'a format nobody serves: 404, not a wrong file');
      row(at + '/', BROWSER, 303, page, 'with a closing slash, from a browser');
      row(at + '/', NO_ACCEPT, 303, jl, 'with a closing slash, no Accept header');
      row(at + '.jsonld', BROWSER, 302, jl, 'the .jsonld suffix wins over a browser\'s Accept');
      row(at + '.html', 'application/ld+json', 302, page, 'the .html suffix wins over Accept: JSON-LD');
      row(at + '.ttl', '*/*', T ? 302 : 404, T ? tt : null, T ? 'the .ttl suffix' : 'the .ttl suffix, with no Turtle on the site');
    }
    const none = `this-${part}-is-not-in-the-dataset`;
    row(`${part}/${none}`, NO_ACCEPT, 303, S + SITE_FILES.jsonld(part, none), `a ${part} that does not exist: w3id cannot know, so it redirects, and the site answers 404`);
    row(`${part}/`, BROWSER, 404, null, `${part}/ with no key`);
    row(`${part}/a/b`, NO_ACCEPT, 404, null, `a deeper path under ${part}/`);
    row(`${part}/a%20b`, NO_ACCEPT, 404, null, 'a key with a space, which no key has');
    row(`${part}/.hidden`, NO_ACCEPT, 404, null, 'a key starting with a dot');
  }
  const file = `${c.stem}${SITE.downloads.jsonl}`;
  row(`download/${file}`, NO_ACCEPT, 302, S + SITE_FILES.download(file), 'a download: the latest dataset whole');
  row('download/', NO_ACCEPT, 404, null, 'download/ with no file');
  if (c.repo && c.release) {
    const tag = `https://github.com/${c.repo}/releases/tag/${c.release}`;
    row(`release/${c.release}`, BROWSER, 303, tag, 'the release, from a browser: its page on GitHub');
    row(`release/${c.release}/`, NO_ACCEPT, 303, tag, 'the release, with a closing slash');
    row(`release/${c.release}/${file}`, NO_ACCEPT, 302, `https://github.com/${c.repo}/releases/download/${c.release}/${file}`, 'a file of the release');
    row('release/.hidden', NO_ACCEPT, 404, null, 'a release name starting with a dot');
    row(`release/${c.release}/a/b`, NO_ACCEPT, 404, null, 'a deeper path under a release');
  }
  row('no/such/thing', NO_ACCEPT, 404, null, 'a path that is not an address');
  row('index.html', BROWSER, 404, null, 'a site file under the namespace: nothing falls through to the site');
  return rows;
}

export const TSV_HEADER = ['path', 'accept', 'status', 'location', 'note'];
/** tests.tsv: a header line, then a row per request; every field is filled ('-' for none). */
export const toTsv = (rows) => [TSV_HEADER.join('\t'), ...rows.map((r) => [r.path, r.accept, r.status, r.location, r.note].join('\t'))].join('\n') + '\n';
/** tests.tsv read back (the test harness reads the file the user runs, not the rows in memory). */
export function fromTsv(text) {
  const [head, ...lines] = text.split('\n').filter((l) => l && !l.startsWith('#'));
  if (head !== TSV_HEADER.join('\t')) throw new Error('not a tests.tsv: its first line is not the header');
  return lines.map((l) => { const [path, accept, status, location, note] = l.split('\t'); return { path, accept, status: Number(status), location, note }; });
}
