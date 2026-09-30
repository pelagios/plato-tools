// Agora, part 'report': what the dataset's description lacks for FAIR publishing, and the deposit
// metadata made from it (.zenodo.json, CITATION.cff and DataCite JSON, decision D5), in a folder
// named <name>-deposit. Nothing is sent anywhere: the files are for the depositor to upload.
//
// The checks are those of F-UJI (v0.5) that can be judged from the metadata alone, with no request
// to the web: F2-01M, the core elements (title, description, keywords, coverage, landing page);
// F1, a persistent identifier (here, the base address every other address is made under, graded by
// how long it can be trusted to last, decision E2, and the dataset's own address in harmony with it,
// decision D3); R1.1, a licence given as an address a machine can recognise; R1.2, provenance (who
// made it, identified, and which version it is); R1.3, a community standard (PLATO, passed when the
// check finds nothing wrong); I3, links to related things (what a release is a version of, and the
// one before it); and A1, that every place's address will lead to it. Google Dataset Search's limits
// on the description (50 to 5,000 characters) are among them, since a description it ignores might
// as well be missing.
//
// What stops publishing is a problem; what only makes the dataset harder to find, cite or reuse is a
// warning. Some things are warnings while the dataset is a draft and problems once it says it is
// published: an address on a stand-in or temporary host is fine to try things out with, but not to
// be cited by.
//
// The report runs on a dataset the check found problems in (it is a report), and says so; the
// deposit files are then not written, since they would describe something not fit to deposit.
import { baseKind, normaliseBase, releaseProblem, keyProblem, caseGuard } from './address.js';
import { TEXT as SHARED } from './index.js';

export const TEXT = {
  'no-title': 'The dataset has no title: give it one (title), or nobody can cite it.',
  'no-description': 'The dataset has no description: say in a few sentences what it holds, where and when it covers, and where it comes from (description). Search engines show it, and Google Dataset Search ignores a dataset without one.',
  'short-description': 'The description is shorter than 50 characters, which Google Dataset Search ignores: say what the dataset holds, where and when it covers, and where it comes from.',
  'long-description': 'The description is longer than 5,000 characters, which Google Dataset Search cuts: put the detail in documentation and keep the description to a summary.',
  'no-creator': 'The dataset does not say who made it (creator): name each author, by ORCID for a person or ROR for an organisation.',
  'creator-without-orcid': 'An author is named without an address (ORCID for a person, ROR for an organisation): give one, so that the work is credited to the right person, whose name may be shared or spelt in other ways.',
  'creator-id-unrecognised': 'An author is identified by an address that is neither an ORCID (https://orcid.org/…) nor a ROR (https://ror.org/…): repositories and citation indexes recognise only those, so give the ORCID or ROR if there is one.',
  'orcid-malformed': 'An ORCID is not written as one: write it as the full address, https://orcid.org/ and four groups of four digits (the last may be X), such as https://orcid.org/0000-0002-1825-0097.',
  'orcid-checksum': "An ORCID's last digit does not match the others (its check digit, ISO 7064 11,2), so it is mistyped and names nobody, or somebody else: copy it again from the author's ORCID record.",
  'ror-malformed': 'A ROR is not written as one: write it as the full address, https://ror.org/ and the nine characters of the identifier, such as https://ror.org/02mhbdp94.',
  'creator-without-name': "An author is given by ORCID only, so the deposit files cannot give their name, which Zenodo and CITATION.cff need: the ORCID stands in for it in .zenodo.json and datacite.json, and CITATION.cff says to fill it in. Replace it with the author's name before depositing. In PLATO JSON give the name beside the ORCID; the about sheet holds one or the other.",
  'no-licence': "The dataset does not say under what licence it may be reused (licence): give the licence's address, such as https://creativecommons.org/licenses/by/4.0/. It is required once status is 'published'.",
  'licence-not-uri': 'The licence is not given as a web address, so no machine can tell what it allows: give the address of the licence, such as https://creativecommons.org/licenses/by/4.0/.',
  'licence-unrecognised': "The licence's address is not one of the common open licences these tools recognise (Creative Commons 4.0, CC0, ODbL, ODC-By, PDDL), so the deposit files leave it for you to choose on the repository's form. Check that it is right, and that it is open enough for others to reuse the data.",
  'no-keywords': 'The dataset has no keywords: give a few words or phrases a person might search for it by (keywords).',
  'no-spatial': 'The dataset does not say what part of the world it covers (spatial): give the addresses of the regions or places, from Wikidata or GeoNames, such as http://www.wikidata.org/entity/Q21.',
  'no-temporal': 'The dataset does not say what period it covers (temporal): give the first and last years (startDate, endDate).',
  'no-version': 'The dataset has no version: give one (version), so that a citation says which state of the data was used.',
  'no-status': "The dataset does not say whether it is a draft or published (status): say 'draft' until it is published, then 'published', after which its attestations are only ever added to.",
  'landing-page-not-uri': 'The landing page is not a web address: give the address of the page people should land on, or leave it out and the site made here will be the landing page.',
  'base-not-in-data': "The dataset does not record its base address (uriSpace, the about sheet's base_uri); the one given for this run is used. Record it in the dataset, or the addresses made from it depend on its being given every time.",
  'base-no-slash': "The base address does not end in '/': write it with the '/', as every address is made by adding to it.",
  'base-custom': 'The base address is on your own domain: the addresses of places and sources last only as long as you keep that domain and its site. You are the persistence guarantee. A w3id.org address, which these tools can make the redirect rules for, can be pointed somewhere else if the site moves.',
  'base-temporary': "The base address is on a stand-in or temporary host (the example gives its kind), so the addresses made from it will not last: a GitHub Pages address changes with the repository's owner or name, a local one reaches nobody else, and an example one is not yours. Choose a permanent base, such as a w3id.org address, before publishing.",
  'no-dataset-id': "The dataset has no address of its own (@id): give its base address (the about sheet's dataset_uri), or, for a release, <base>release/<name>.",
  'dataset-id-mismatch': "The dataset's own address (@id) is neither its base address nor the address of one of its releases (<base>release/<name>), so the address it is cited by is not the one its site serves. The example gives the address and the base.",
  'release-name': "The release name cannot be used in an address: use letters, digits and . _ ~ -, not starting with '.'.",
  'release-id': "For this release, the dataset's own address (@id) should be the release's, and isVersionOf the base address, so that a citation of the release names the release and says what it is a version of. The example says what to set.",
  'previous-version-outside': "The previous version (previousVersion) is not one of this dataset's releases (<base>release/<name>): name the release this one follows.",
  'places-outside-base': "Places have addresses outside the dataset's base address, so the site made from it cannot serve them and their addresses will not lead to them: make their addresses under the base. It is a problem once the dataset is published.",
  'places-not-served': "Places have addresses under the dataset's base address but not of the form <base>place/<id>. Their attestations are given addresses (publish mint), but the site has no page for them and the w3id rules do not reach them, so their addresses will not lead to them; the downloads hold them. To serve them, give them addresses of that form before the dataset is published.",
  'keys-not-servable': "Places or sources have addresses a static site cannot serve: the last part has characters other than letters, digits and . _ ~ -, starts with '.', or differs from another's only in capital letters (one file on macOS and Windows). The site has no page for them and the w3id rules do not reach them. While the dataset is a draft, give them identifiers of those characters that differ in more than case (in the spreadsheets, place_id or source_id); once it is published its addresses are frozen, and the site lists them as held only in the downloads. The example names each and says what is wrong.",
  'sources-outside-base': "Sources described in full have addresses outside the dataset's base address (under <base>source/), so the site made from it will not serve them: if they are the dataset's own, make their addresses under the base; if another dataset's, cite them by address alone.",
  'no-publisher': "Nothing says who publishes the dataset, which DataCite requires: give a contributor by name, or an author's name, or fill in the publisher in datacite.json.",
};

// ---- identifiers of people and organisations -----------------------------------------------------

const ORCID = /^https:\/\/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/;
// ROR ids: '0', six characters of Crockford's base 32 (no i, l, o, u), two check digits.
const ROR = /^https:\/\/ror\.org\/0[a-hj-km-np-tv-z0-9]{6}\d{2}$/;
const looksOrcid = (s) => typeof s === 'string' && /orcid\.org/i.test(s);
const looksRor = (s) => typeof s === 'string' && /ror\.org/i.test(s);

/** An ORCID's check digit is right: ISO 7064 MOD 11-2 over its first fifteen digits, 10 written as X. */
export function orcidChecksumOk(id) {
  const digits = id.replace(/-/g, '');
  let total = 0;
  for (const c of digits.slice(0, 15)) total = (total + Number(c)) * 2;
  const r = (12 - (total % 11)) % 11;
  return digits[15] === (r === 10 ? 'X' : String(r));
}
/** Why an ORCID address is not a good one ('orcid-malformed', 'orcid-checksum'), or null. */
export function orcidProblem(iri) {
  const m = ORCID.exec(iri);
  if (!m) return 'orcid-malformed';
  return orcidChecksumOk(m[1]) ? null : 'orcid-checksum';
}
const orcidId = (iri) => ORCID.exec(iri)?.[1] || null;

// ---- licences ----------------------------------------------------------------------------------

// The open licences a dataset is commonly given, by their address with the scheme, 'www.', a closing
// '/', 'legalcode' and 'deed.<lang>' taken off, with the SPDX id (CITATION.cff and DataCite name a
// licence by it) and the id in Zenodo's licence list (the SPDX id in lower case). Another licence is
// left for the depositor to choose, rather than guessed.
const CC4 = ['by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd'];
const CC_WORDS = { sa: '-ShareAlike', nd: '-NoDerivatives', nc: '-NonCommercial' };
const ODBL = { spdx: 'ODbL-1.0', name: 'Open Data Commons Open Database License v1.0' };
const ODCBY = { spdx: 'ODC-By-1.0', name: 'Open Data Commons Attribution License v1.0' };
const PDDL = { spdx: 'PDDL-1.0', name: 'Open Data Commons Public Domain Dedication & License 1.0' };
const LICENCES = new Map([
  ...CC4.map((k) => [`creativecommons.org/licenses/${k}/4.0`, { spdx: `CC-${k.toUpperCase()}-4.0`, name: `Creative Commons Attribution${k.split('-').slice(1).map((p) => CC_WORDS[p]).join('')} 4.0 International` }]),
  ['creativecommons.org/publicdomain/zero/1.0', { spdx: 'CC0-1.0', name: 'Creative Commons Zero v1.0 Universal' }],
  ['opendatacommons.org/licenses/odbl/1-0', ODBL], ['opendatacommons.org/licenses/odbl/1.0', ODBL],
  ['opendatacommons.org/licenses/by/1-0', ODCBY], ['opendatacommons.org/licenses/by/1.0', ODCBY],
  ['opendatacommons.org/licenses/pddl/1-0', PDDL], ['opendatacommons.org/licenses/pddl/1.0', PDDL],
]);
/** A licence address -> { spdx, zenodo, name, uri }, or null if it is not one recognised here. */
export function recogniseLicence(uri) {
  if (typeof uri !== 'string' || !/^https?:\/\//i.test(uri.trim())) return null;
  const key = uri.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '')
    .replace(/\/+$/, '').replace(/\/(legalcode(\.[a-z-]+)?|deed\.[a-z-]+)$/, '').replace(/\/+$/, '');
  const l = LICENCES.get(key);
  return l ? { ...l, zenodo: l.spdx.toLowerCase(), uri: uri.trim() } : null;
}

// ---- small helpers -----------------------------------------------------------------------------

const isUri = (s) => typeof s === 'string' && /^https?:\/\/[^\s/?#]+\S*$/.test(s);
const str = (s) => (typeof s === 'string' ? s.trim() : typeof s === 'number' ? String(s) : '');
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const creatorsOf = (g) => list(g.creator).filter((c) => c && typeof c === 'object').map((c) => ({ id: str(c['@id']), name: str(c.name) }));
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Plain text as HTML paragraphs, as Zenodo's description is HTML: a blank line parts paragraphs. */
const paragraphs = (s) => s.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
const doiOf = (d) => String(d).trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/i, '');
/** A name for a folder: letters and digits joined by '-', without accents. */
export function slug(s) {
  const t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return t || 'dataset';
}
/** Temporal coverage as ISO 8601 'start/end', open at an end with '..' (ISO 8601-2), or null. */
function coverage(g) {
  const t = g.temporal && typeof g.temporal === 'object' ? g.temporal : {};
  const a = str(t.startDate), b = str(t.endDate);
  return a || b ? `${a || '..'}/${b || '..'}` : null;
}
/**
 * A person's one name split into family and given names, which Zenodo, CITATION.cff and DataCite
 * want apart: at the comma if it has one ('Gadd, Stephen'), else before the last word. That is wrong
 * for some names ('van Gogh'), so the README says to check.
 */
function familyGiven(name) {
  if (name.includes(',')) { const [f, ...g] = name.split(','); return { family: f.trim(), given: g.join(',').trim() }; }
  const w = name.split(/\s+/);
  return w.length < 2 ? { family: name, given: '' } : { family: w.pop(), given: w.join(' ') };
}
const fmtFamilyGiven = (name) => { const { family, given } = familyGiven(name); return given ? `${family}, ${given}` : family; };

// ---- schema.org, for the landing page ----------------------------------------------------------

/**
 * The schema.org Dataset for the landing page (JSON-LD), which Google Dataset Search and others read.
 * The site generator embeds it; it is not written as a file here. `extras`: { distribution (a list
 * of schema.org DataDownload), conceptDoi, release (its name), dateModified }.
 */
export function schemaOrgDataset(gazetteer, scheme, extras = {}) {
  const g = gazetteer || {};
  const base = scheme?.base || normaliseBase(g.uriSpace);
  const lic = recogniseLicence(g.licence);
  const id = extras.release && scheme && !releaseProblem(extras.release) ? scheme.release(extras.release) : str(g['@id']) || base;
  const identifier = [id, extras.conceptDoi ? `https://doi.org/${doiOf(extras.conceptDoi)}` : null].filter(Boolean);
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));
  return clean({
    '@context': 'https://schema.org/',
    '@type': 'Dataset',
    '@id': id || undefined,
    name: str(g.title),
    description: str(g.description),
    url: str(g.landingPage) || base,
    identifier: identifier.length === 1 ? identifier[0] : identifier,
    creator: creatorsOf(g).map((c) => clean({
      '@type': looksRor(c.id) ? 'Organization' : 'Person',
      '@id': c.id || undefined, name: c.name || undefined,
      identifier: c.id || undefined,
    })),
    license: lic ? lic.uri : isUri(g.licence) ? g.licence : undefined,
    keywords: list(g.keywords).map(str).filter(Boolean),
    version: str(g.version),
    isAccessibleForFree: true,
    creativeWorkStatus: str(g.status),
    // Wikidata or GeoNames addresses with no names or coordinates here: a Place that is the same as
    // the one at the address, since a bare string would be read as a place's name.
    spatialCoverage: list(g.spatial).filter(isUri).map((u) => ({ '@type': 'Place', sameAs: u })),
    temporalCoverage: coverage(g),
    // A release is a version of the dataset at the base, and follows the release before it.
    isPartOf: extras.release && base ? base : undefined,
    isBasedOn: isUri(g.previousVersion) ? g.previousVersion : undefined,
    dateModified: extras.dateModified,
    distribution: extras.distribution,
  });
}

// ---- the report ----------------------------------------------------------------------------------

export function create(ctx) {
  const { rep, options } = ctx;
  // Places and sources the records give addresses outside the base: counted, a few kept.
  // Also places under the base but not at <base>place/<id> (given attestation addresses, but no page
  // or rule), and the places and sources whose key the site cannot serve (as site.js finds them).
  const outside = { place: { n: 0, eg: [] }, source: { n: 0, eg: [] }, notServed: { n: 0, eg: [] }, keys: { n: 0, eg: [] } };
  const seenSource = new Set();
  const note = (k, iri) => { const o = outside[k]; o.n++; if (o.eg.length < 5) o.eg.push(iri); };
  const guard = caseGuard(), keyed = new Set();
  const key = (part, iri) => {
    const k = part === 'place' ? ctx.scheme.placeKey(iri) : ctx.scheme.sourceKey(iri);
    if (!k || keyed.has(part + '/' + k)) return;
    keyed.add(part + '/' + k);
    const why = keyProblem(k);
    if (why) { note('keys', `${iri}: its last part ${why}`); return; }
    const other = guard.add(part, k);
    if (other) note('keys', `${ctx.scheme.base}${part}/${other} and ${iri}: they differ only in capital letters`);
  };
  // A source described here (an object with an address, so something the dataset says about it), in
  // an attestation's sources, its citations, or what another source derives from. A source cited
  // by its address alone may be another dataset's, and is not the site's to serve.
  const source = (s, depth = 0) => {
    if (!s || typeof s !== 'object' || depth > 20) return;
    const id = s['@id'];
    if (typeof id === 'string' && !seenSource.has(id)) {
      seenSource.add(id);   // each once, however often it is cited
      if (ctx.scheme.sourceKey(id) === null) note('source', id);
      else key('source', id);
    }
    source(s.derivedFrom, depth + 1);
  };
  const attestation = (a) => {
    if (!a || typeof a !== 'object') return;
    // A source cited by its address alone gets a page on the site too, when it is under the base.
    const cited = (s) => { if (typeof s === 'string') key('source', s); else source(s); };
    for (const s of list(a.sources)) cited(s);
    for (const c of list(a.citations)) if (c && typeof c === 'object') cited(c.source);
  };
  return {
    event(ev) {
      // Counted whatever else: what the report was given to read, which a test can hold it to.
      if (ev.type === 'record') rep.count('places');
      if (!ctx.scheme) return;
      if (ev.type === 'record' && ev.value) {
        const id = ev.value['@id'];
        if (typeof id === 'string') {
          if (!id.startsWith(ctx.scheme.base)) note('place', id);
          else if (ctx.scheme.placeKey(id) === null) note('notServed', id);
          else key('place', id);
        }
        for (const a of list(ev.value.attestations)) attestation(a);
      } else if (ev.type === 'attestation') attestation(ev.value);
      // An attestation-centric dataset's attestations are about places that may be other
      // gazetteers' (its own new places come as records), so what they are about is not checked.
    },
    async finish() {
      const g = ctx.gazetteer || {};
      const checks = assess(ctx, g, outside);
      const passed = checks.filter((c) => c.passed).length;
      rep.counts.fair = { passed, of: checks.length };
      rep.counts.fairChecks = checks;
      const said = [`${passed} of ${checks.length} FAIR checks pass.`];
      if (ctx.scheme && !str(g.landingPage)) said.push(`The site will be the landing page, at ${ctx.scheme.base}.`);
      if (ctx.checkErrors) {
        rep.add('error', 'dataset-has-problems', SHARED['dataset-has-problems'], undefined, ctx.checkErrors);
        said.push('The deposit files are not written while the dataset has problems.');
      } else if (!ctx.scheme) {
        said.push('The deposit files are not written without a base address.');
      } else {
        const name = `${options.name ? slug(String(options.name).replace(/\.[A-Za-z0-9]{1,8}$/, '')) : slug(g.title)}-deposit`;
        const files = deposit(g, ctx.scheme, options, rep);
        const tree = await ctx.tree(name);
        for (const [path, text] of Object.entries(files)) await ctx.put(tree, path, text);
        ctx.done(await tree.close());
        said.push(`The deposit files are in ${name}; its README.txt says which goes where.`);
      }
      rep.counts.said = said;
    },
  };
}

/**
 * Every FAIR check, each recorded as { check, metric, passed }, with a finding for each that fails
 * (except a published dataset's missing licence, which the PLATO check already reports). Returns
 * the list, which the page may show as a checklist.
 */
function assess(ctx, g, outside) {
  const { rep, options, scheme } = ctx;
  const published = g.status === 'published';
  const onPublish = published ? 'error' : 'warning';   // fine in a draft, a problem once published
  const checks = [];
  const record = (check, metric, passed) => { checks.push({ check, metric, passed: !!passed }); return !!passed; };
  const warn = (kind, example) => rep.warning(kind, TEXT[kind], example);
  const add = (sev, kind, example, n) => rep.add(sev, kind, TEXT[kind], example, n);

  // F2: the core elements.
  if (!record('title', 'F2-01M', str(g.title))) warn('no-title');
  const d = str(g.description);
  if (!record('description', 'F2-01M', d.length >= 50 && d.length <= 5000)) warn(!d ? 'no-description' : d.length < 50 ? 'short-description' : 'long-description', d ? `${d.length} characters` : undefined);
  if (!record('keywords', 'F2-01M', list(g.keywords).some(str))) warn('no-keywords');
  if (!record('spatial coverage', 'F2-01M', list(g.spatial).some(str))) warn('no-spatial');
  if (!record('temporal coverage', 'F2-01M', coverage(g))) warn('no-temporal');
  // The landing page: the site made from the dataset is one, at the base, unless another is named.
  const lp = g.landingPage;
  if (!record('landing page', 'F2-01M', lp === undefined || lp === null || lp === '' || isUri(lp))) warn('landing-page-not-uri', String(lp));

  // R1.2: provenance, who made it (identified) and which version it is.
  const creators = creatorsOf(g);
  if (!record('creator', 'R1.2-01M', creators.length)) warn('no-creator');
  let identified = creators.length > 0;
  for (const c of creators) {
    if (!c.id) { identified = false; warn('creator-without-orcid', c.name); continue; }
    if (looksOrcid(c.id)) {
      const p = orcidProblem(c.id);
      if (p) { identified = false; add('error', p, c.id); }
      else if (!c.name) warn('creator-without-name', c.id);
    } else if (looksRor(c.id)) {
      if (!ROR.test(c.id)) { identified = false; add('error', 'ror-malformed', c.id); }
    } else { identified = false; warn('creator-id-unrecognised', c.id); }
  }
  // A contributor given by ORCID is checked the same way; a name is allowed there.
  if (looksOrcid(g.contributor) && orcidProblem(g.contributor)) { identified = false; add('error', orcidProblem(g.contributor), g.contributor); }
  record('authors identified (ORCID, ROR)', 'R1.2-01M', identified);
  if (!record('version', 'R1.2-01M', str(g.version))) warn('no-version');
  if (!record('status', 'R1.2-01M', str(g.status))) warn('no-status');

  // R1.1: the licence. Published without one is already a problem the check reports.
  // Whether it is a licence these tools know (and can name in the deposit files) is a check of its
  // own, failed too when there is none.
  if (!str(g.licence)) { if (!published) warn('no-licence'); }
  else if (!isUri(g.licence)) add(onPublish, 'licence-not-uri', g.licence);
  else if (!recogniseLicence(g.licence)) warn('licence-unrecognised', g.licence);
  record('licence', 'R1.1-01M', isUri(g.licence));
  record('licence recognised', 'R1.1-01M', recogniseLicence(g.licence));

  // R1.3: a community standard. It is PLATO; passed when PLATO's check finds nothing wrong.
  record('follows PLATO without problems', 'R1.3-01M', !ctx.checkErrors);

  // F1: a persistent identifier. Without a base nothing else in publishing can be made.
  // The checks that need a base fail without one, so that the number of checks is always the same.
  if (!scheme) {
    for (const [check, metric] of AFTER_BASE) record(check, metric, false);
    rep.error('no-base', SHARED['no-base']);
    return checks;
  }
  const declared = str(g.uriSpace);
  if (!declared) warn('base-not-in-data', scheme.base);
  else if (!options.base && !declared.endsWith('/')) warn('base-no-slash', declared);
  const kind = baseKind(scheme.base);
  if (kind === 'custom') warn('base-custom', scheme.base);
  else if (kind !== 'w3id') add(onPublish, 'base-temporary', `${scheme.base} (${kind})`);
  record(...AFTER_BASE[0], kind === 'w3id');

  // The dataset's own address: the base, or one of its releases (decision D3).
  const releasePrefix = scheme.base + 'release/';
  const isRelease = (iri) => typeof iri === 'string' && iri.startsWith(releasePrefix) && !releaseProblem(iri.slice(releasePrefix.length));
  const id = str(g['@id']);
  let harmony = true;
  if (!id) { harmony = false; warn('no-dataset-id', `set @id to ${scheme.base}`); }
  else if (normaliseBase(id) !== scheme.base && !isRelease(id)) { harmony = false; add('error', 'dataset-id-mismatch', `@id ${id}; base ${scheme.base}`); }
  record(...AFTER_BASE[1], harmony);

  // I3: related versions. A release is a version of the base; the one before it, another release.
  let related = true;
  if (options.release !== undefined && options.release !== null) {
    if (releaseProblem(options.release)) { related = false; rep.error('release-name', TEXT['release-name'], String(options.release)); }
    else {
      const want = scheme.release(options.release);
      const vOf = normaliseBase(g.isVersionOf);
      if (id !== want || vOf !== scheme.base) {
        related = false;
        warn('release-id', [id !== want ? `set @id to ${want}` : '', vOf !== scheme.base ? `set isVersionOf to ${scheme.base}` : ''].filter(Boolean).join(' and '));
      }
    }
  }
  if (str(g.previousVersion) && !isRelease(g.previousVersion)) { related = false; warn('previous-version-outside', String(g.previousVersion)); }
  record(...AFTER_BASE[2], related);

  // A1: every place (and every source described) the site is to serve is under the base. The
  // count is carried by the first example, so the finding counts all and shows a few.
  const tell = (sev, kind, o) => o.eg.forEach((e, i) => add(sev, kind, e, i === 0 ? o.n - o.eg.length + 1 : 1));
  tell(onPublish, 'places-outside-base', outside.place);
  tell('warning', 'sources-outside-base', outside.source);
  record(...AFTER_BASE[3], !outside.place.n);
  // Under the base, but with no page on the site and no w3id rule: a warning (they are minted, and
  // in the downloads). Keys the site cannot serve: to fix while the dataset is a draft; once it is
  // published they are frozen (an address is for ever), so the site lists them instead (Round 3, A3).
  tell('warning', 'places-not-served', outside.notServed);
  tell(published ? 'warning' : 'error', 'keys-not-servable', outside.keys);
  record(...AFTER_BASE[4], !outside.notServed.n && !outside.keys.n);
  return checks;
}
// The checks made against the base address, in order.
const AFTER_BASE = [['persistent base address', 'F1-01M'], ['dataset address is the base or a release', 'F1-01M'], ['related versions', 'I3-01M'], ['places under the base', 'A1-01M'],
  ['every place and source address served by the site', 'A1-01M']];

// ---- the deposit files -----------------------------------------------------------------------

/** The deposit files for a dataset, as { path: text }. */
export function deposit(g, scheme, options = {}, rep = null) {
  const lic = recogniseLicence(g.licence);
  const release = options.release && !releaseProblem(options.release) ? scheme.release(options.release) : null;
  const conceptDoi = options.conceptDoi ? doiOf(options.conceptDoi) : null;
  const publisher = publisherOf(g);
  if (!publisher && rep) rep.warning('no-publisher', TEXT['no-publisher']);
  return {
    '.zenodo.json': JSON.stringify(zenodo(g, scheme, lic, release), null, 2) + '\n',
    'CITATION.cff': citation(g, scheme, lic, release, conceptDoi),
    'datacite.json': JSON.stringify(datacite(g, scheme, lic, release, conceptDoi, publisher, options), null, 2) + '\n',
    'README.txt': readme(g, scheme, lic, release, conceptDoi, publisher),
  };
}

/** Who publishes it, by name: a contributor given by name, else the first author with a name. */
function publisherOf(g) {
  if (str(g.contributor) && !isUri(g.contributor)) return str(g.contributor);
  return creatorsOf(g).find((c) => c.name)?.name || null;
}

// Zenodo's legacy deposit format (the .zenodo.json its GitHub integration reads, and the body of
// its deposit API). Its related_identifiers relations (developers.zenodo.org, read 2026-09-30) have
// no isVersionOf: the concept DOI Zenodo keeps across versions says that instead. So a release
// isIdenticalTo its own address (the same frozen files under another address), and isNewVersionOf
// the previous release. The base is left out (Round 3, A4): no relation Zenodo offers says what a
// deposit is to the living dataset truly, and datacite.json names the base only where its relation
// is exact, IsVersionOf for a release; so both files name the release, and the one before it, alike. Its dates must be Collected, Valid or
// Withdrawn, none of which is the period a dataset covers, and its locations need a place's name,
// which the spatial addresses do not carry: both kinds of coverage go in notes, as text.
function zenodo(g, scheme, lic, release) {
  const z = { upload_type: 'dataset', title: str(g.title) };
  if (str(g.description)) z.description = paragraphs(str(g.description));
  // An author with no name: the bare ORCID stands in, where a missing name would be refused
  // (creator-without-name says to replace it).
  z.creators = creatorsOf(g).map((c) => {
    const orcid = orcidId(c.id);
    const person = { name: c.name ? (looksRor(c.id) ? c.name : fmtFamilyGiven(c.name)) : orcid || c.id };
    if (orcid) person.orcid = orcid;
    return person;
  });
  z.access_right = 'open';
  if (lic) z.license = lic.zenodo;
  const kw = list(g.keywords).map(str).filter(Boolean);
  if (kw.length) z.keywords = kw;
  if (str(g.version)) z.version = str(g.version);
  const rel = [];
  if (release) rel.push({ identifier: release, relation: 'isIdenticalTo', resource_type: 'dataset' });
  if (isUri(g.previousVersion)) rel.push({ identifier: g.previousVersion, relation: 'isNewVersionOf', resource_type: 'dataset' });
  if (rel.length) z.related_identifiers = rel;
  const notes = [];
  const cov = coverage(g);
  if (cov) notes.push(`Temporal coverage: ${escapeHtml(cov)} (ISO 8601).`);
  const sp = list(g.spatial).filter(isUri);
  if (sp.length) notes.push(`Spatial coverage: ${sp.map((u) => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`).join(', ')}.`);
  if (notes.length) z.notes = notes.map((n) => `<p>${n}</p>`).join('');
  return z;
}

// CITATION.cff 1.2.0. Every string is written as a JSON string, which is a YAML double-quoted
// scalar, so no value can break the file whatever it holds.
function citation(g, scheme, lic, release, conceptDoi) {
  const q = (s) => JSON.stringify(String(s));
  const lines = [
    '# Citation metadata for the dataset (https://citation-file-format.github.io/).',
    "# Check each author's family and given names: they were split from one name.",
    'cff-version: 1.2.0',
    'message: "If you use this dataset, please cite it using the metadata from this file."',
    'type: dataset',
    `title: ${q(str(g.title) || 'Untitled dataset')}`,
  ];
  if (str(g.description)) lines.push(`abstract: ${q(str(g.description))}`);
  lines.push('authors:');
  const creators = creatorsOf(g);
  if (!creators.length) lines.push('  - name: "FILL IN: the authors"');
  for (const c of creators) {
    if (looksRor(c.id)) { lines.push(`  - name: ${q(c.name || c.id)}`); continue; }
    if (c.name) {
      const { family, given } = familyGiven(c.name);
      lines.push(`  - family-names: ${q(family)}`);
      if (given) lines.push(`    given-names: ${q(given)}`);
    } else lines.push(`  - family-names: ${q(`FILL IN: the name for ${c.id}`)}`);
    if (looksOrcid(c.id)) lines.push(`    orcid: ${q(c.id)}`);
  }
  if (str(g.version)) lines.push(`version: ${q(str(g.version))}`);
  if (lic) lines.push(`license: ${q(lic.spdx)}`);
  lines.push(`url: ${q(scheme.base)}`);
  const ids = [];
  if (conceptDoi) ids.push(['doi', conceptDoi, 'The DOI of every version of the dataset (the concept DOI).']);
  if (release) ids.push(['url', release, 'The address of this release.']);
  ids.push(['url', scheme.base, 'The address of the dataset.']);
  lines.push('identifiers:');
  for (const [type, value, description] of ids) lines.push(`  - type: ${type}`, `    value: ${q(value)}`, `    description: ${q(description)}`);
  const kw = list(g.keywords).map(str).filter(Boolean);
  if (kw.length) { lines.push('keywords:'); for (const k of kw) lines.push(`  - ${q(k)}`); }
  return lines.join('\n') + '\n';
}

// DataCite Metadata Schema 4.7, as the attributes of a DataCite REST API (JSON:API) request. No doi
// or prefix unless a concept DOI is given: the DOI is the depositor's to have made. The temporal
// coverage is a date of type Coverage (in the schema since 4.6); the spatial addresses are subjects
// with the address as valueUri, since geoLocations need a place's name or coordinates, which are not
// given here.
function datacite(g, scheme, lic, release, conceptDoi, publisher, options) {
  const a = {};
  if (conceptDoi) a.doi = conceptDoi;
  a.creators = creatorsOf(g).map((c) => {
    const org = looksRor(c.id);
    const o = { name: c.name ? (org ? c.name : fmtFamilyGiven(c.name)) : orcidId(c.id) || c.id, nameType: org ? 'Organizational' : 'Personal' };
    if (c.name && !org) { const { family, given } = familyGiven(c.name); o.familyName = family; if (given) o.givenName = given; }
    if (looksOrcid(c.id)) o.nameIdentifiers = [{ nameIdentifier: c.id, nameIdentifierScheme: 'ORCID', schemeUri: 'https://orcid.org' }];
    else if (org) o.nameIdentifiers = [{ nameIdentifier: c.id, nameIdentifierScheme: 'ROR', schemeUri: 'https://ror.org' }];
    return o;
  });
  a.titles = [{ title: str(g.title) }];
  a.publisher = { name: publisher || '' };
  a.publicationYear = Number(options.publicationYear) || new Date().getFullYear();
  a.types = { resourceTypeGeneral: 'Dataset', resourceType: 'Gazetteer' };
  const subjects = list(g.keywords).map(str).filter(Boolean).map((subject) => ({ subject }));
  for (const u of list(g.spatial).filter(isUri)) {
    const s = /wikidata\.org/.test(u) ? { subjectScheme: 'Wikidata', schemeUri: 'https://www.wikidata.org/' } : /geonames\.org/.test(u) ? { subjectScheme: 'GeoNames', schemeUri: 'https://www.geonames.org/' } : {};
    subjects.push({ subject: u, valueUri: u, ...s });
  }
  if (subjects.length) a.subjects = subjects;
  if (str(g.description)) a.descriptions = [{ description: str(g.description), descriptionType: 'Abstract' }];
  if (lic) a.rightsList = [{ rights: lic.name, rightsUri: lic.uri, rightsIdentifier: lic.spdx, rightsIdentifierScheme: 'SPDX', schemeUri: 'https://spdx.org/licenses/' }];
  else if (isUri(g.licence)) a.rightsList = [{ rightsUri: g.licence }];
  const cov = coverage(g);
  if (cov) a.dates = [{ date: cov, dateType: 'Coverage' }];
  const rel = [];
  if (release) rel.push({ relatedIdentifier: release, relatedIdentifierType: 'URL', relationType: 'IsIdenticalTo' }, { relatedIdentifier: scheme.base, relatedIdentifierType: 'URL', relationType: 'IsVersionOf' });
  if (isUri(g.previousVersion)) rel.push({ relatedIdentifier: g.previousVersion, relatedIdentifierType: 'URL', relationType: 'IsNewVersionOf' });
  if (rel.length) a.relatedIdentifiers = rel;
  if (str(g.version)) a.version = str(g.version);
  a.url = release || scheme.base;
  return { data: { type: 'dois', attributes: a } };
}

function readme(g, scheme, lic, release, conceptDoi, publisher) {
  const unnamed = creatorsOf(g).filter((c) => !c.name).length;
  const fill = [
    !lic && 'the licence (not one recognised here, so it is left out of .zenodo.json and CITATION.cff)',
    unnamed && `the names of ${unnamed} author${unnamed === 1 ? '' : 's'} given by ORCID only (the ORCID stands in for the name)`,
    !publisher && 'the publisher in datacite.json',
    !conceptDoi && 'the DOI, once the repository has given one: make these files again with the concept DOI (--concept-doi) to put it in CITATION.cff and datacite.json',
  ].filter(Boolean);
  return [
    `Deposit metadata for ${str(g.title) || 'the dataset'}`,
    '',
    "Made from the dataset's own description by PLATO tools (publish report). Nothing has been",
    'sent anywhere: these files are for you to deposit with the dataset.',
    '',
    '.zenodo.json   For Zenodo. Put it at the top of the GitHub repository the dataset is released',
    "               from, and Zenodo's GitHub integration reads it with each release; or give it to",
    "               Zenodo's deposit API as the metadata. Zenodo makes the DOI.",
    'CITATION.cff   For GitHub and citation managers: put it at the top of the repository, and',
    '               GitHub shows "Cite this repository" from it.',
    'datacite.json  For a repository or DataCite member that registers DOIs directly (the',
    '               attributes of a DataCite REST API request). Add the DOI (doi, or prefix to have',
    '               one made) and check the publisher before sending it.',
    '',
    `The dataset's address is ${scheme.base}${release ? `; this release's is ${release}` : ''}.`,
    'The period and the part of the world it covers are in the notes of .zenodo.json, as Zenodo',
    'has no field for either that fits.',
    '',
    "Check each author's family and given names, which were split from one name.",
    ...(fill.length ? ['', 'To fill in before depositing:', ...fill.map((f) => `  - ${f}`)] : []),
    '',
  ].join('\n');
}
