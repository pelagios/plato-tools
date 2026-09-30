// Agora, part 'site': a static website for GitHub Pages, made from a checked dataset. Every place
// and source whose address is under the dataset's base gets a page for people and a JSON-LD
// document for machines, at the paths the address scheme gives (address.js), so that the w3id rules
// (or a custom domain) send each address to its own files; each attestation with an address that
// is a fragment of its place's is an element of that page with that id, so its address lands on it.
// Around them: a landing page with the schema.org description search engines read, the dataset's
// description as JSON-LD, the lists of places, the downloads, and the page Pages shows for a miss.
// Beside the site, a second small folder holds what goes into the user's repository: the workflow
// that builds and deploys the site on every push, and a note on how to set it up (D4).
//
// Size decides first (D1, D7). While the dataset is checked, each place's record is measured and
// the site's size estimated from it; GitHub Pages serves at most 1 GB. Over that, the page (which
// writes one zip) refuses and says what to do; the command line writes the site anyway, with a
// warning, as it may be served from somewhere else. A subset (options.only, the keys of the places
// to include) keeps a site within bounds: the places left out have no files, and their addresses
// reach the 404 page, which points to the downloads, where every place is.
//
// Then the dataset is read again and each place is written as it passes, so the site is made at
// any size with one record in hand; the sources, the lists of places and the pages at the root are
// written from what the passes gathered. (RDF and attestation-centric input are the exception: the
// engine hands their records over from its working database without pausing, so their pages queue
// in memory until written. At scale, give the site PLATO JSON Lines, as publish mint writes.)
import { SITE, PARTS, keyProblem, caseGuard } from './address.js';
import { collectWithdrawn, resolveWithdrawn } from '../../formats/shared.js';
import { placeDocument, sourceDocument, descriptionDocument, Turtle } from './site/linked.js';
import { schemaOrgDataset } from './fair.js';
import { siteTarget, TEXT as W3ID_TEXT } from './w3id.js';
import { placePage, sourcePage, landingPage, placesPage, notFoundPage, citation, PAGE, CSS, CSS_FILE } from './site/html.js';
import { workflow, readme } from './site/repo.js';
import { DOWNLOADS, writeDownload } from './site/downloads.js';
import { fmtBytes } from '../words.js';
import PKG from '../../../package.json' with { type: 'json' };

// GitHub Pages: "Published GitHub Pages sites may be no larger than 1 GB", and a deployment that
// takes more than 10 minutes fails. Counted in decimal gigabytes, the lower reading.
export const PAGES_LIMIT = 1e9;

// What the site's files weigh beside a place's record as PLATO JSON (JSON.stringify's length),
// measured on PLATO's examples, JSON and spreadsheet tables (test/agora-site.test.js measures again,
// and fails if the estimate falls short of what is written). The JSON-LD document is the record in
// a small wrapper; the page says what the record says in HTML, 0.5 to 1.7 times as long, and about
// 1 KB of its own (page); Turtle is 0.7 to 1.7 times. The downloads are the whole dataset,
// compressed. The larger measurement is taken each time: an estimate that errs should err towards
// refusing too early, not towards a deployment GitHub refuses after ten minutes.
export const FACTORS = { jsonld: 1.02, html: 1.8, turtle: 1.8, perFile: 400, page: 1400, downloads: 0.4 };
// The spreadsheet tables are made in memory, whole (tablesWriter in pipeline.js): past this much
// PLATO JSON they are left out of the downloads rather than risk running out of memory.
export const TABLES_MAX_JSON = 100e6;
// A source's page lists the places that cite it up to this many, then says how many more.
export const CITED_SHOWN = 200;
// Identity matches listed apart from their places (DEEP's shape) are kept for the places' pages up
// to this many; past it the pages show only those given with the place, and the report says so.
export const IDRS_KEPT = 500_000;
// The places the site cannot serve are listed by address on its home page and 404 page up to this many.
export const UNSERVABLE_SHOWN = 500;

export const TEXT = {
  'too-big-for-pages': 'The site would be larger than GitHub Pages serves (1 GB a site). Leave out Turtle if it was asked for, publish a subset of the places (--only, a file of the keys of the places to include; the rest are still in the downloads), or build the site with the command line and host it elsewhere.',
  'too-big-for-pages-cli': 'The site is larger than GitHub Pages serves (1 GB a site), so GitHub will refuse to deploy it. It is written all the same, to serve from somewhere else; for GitHub Pages, leave out Turtle, or publish a subset of the places (--only).',
  'stopped-at-limit': 'The site grew past what GitHub Pages serves (1 GB) while it was written, beyond its estimate, so no site was made. Publish a subset of the places (--only), or build it with the command line.',
  'key-not-servable': 'A place or source address ends in something a static site cannot serve as a file name, so the address would not lead to its page: it has no page or data file. Give it an identifier of letters, digits and . _ ~ - only (in the spreadsheets, its place_id or source_id).',
  'keys-differ-in-case': 'Two place or source addresses differ only in the case of their letters. On macOS and Windows, and in many zips, they would be one file, so neither has a page: give them identifiers that differ in more than case.',
  // Published, the addresses are frozen (Round 3, A3): the rest of the site is made, the places are
  // listed on its home page and its 404 page as held in the downloads, and the workflow deploys it.
  'key-not-servable-published': 'A place or source address ends in something a static site cannot serve as a file name, so it has no page or data file. The dataset is published, so its addresses cannot change: the site lists these places on its home page and its 404 page, as held in the downloads, and is deployed without them.',
  'keys-differ-in-case-published': 'Two place or source addresses differ only in the case of their letters, which is one file on macOS and Windows and in many zips, so neither has a page. The dataset is published, so its addresses cannot change: the site lists these places on its home page and its 404 page, as held in the downloads, and is deployed without them.',
  'attestations-without-ids': 'Attestations have no address of their own (@id), so nothing can link to them, retract them or replace them, and no site is made. Give them addresses first: plato-tools publish mint writes a copy of the dataset in which every attestation has one; commit that copy. The site never makes addresses itself.',
  'attestations-without-ids-draft': 'Attestations have no address of their own (@id). That will do for a draft, but before publishing give them addresses (plato-tools publish mint), so that each can be linked to, retracted or replaced.',
  'place-not-under-base': "A place's address is not under the dataset's base address (its place/ part), so this site cannot serve it and it has no page. Its record is still in the downloads.",
  'attestation-address-elsewhere': "An attestation's address is not a fragment of its place's address (<place>#…), so it does not lead to the place's page. The attestation is shown there, but its address will not find it.",
  'places-left-out': "Places are left out of the site (it holds only those in the --only list). Their addresses still redirect to where their pages would be, where GitHub Pages shows the site's 404 page: it explains, and points to the downloads, which hold every place.",
  'only-unknown': 'Keys in the --only list match no place of the dataset, so they select nothing.',
  'duplicate-place': "Two records are the same place: their addresses are the same, or differ only after '#', which a web server never sees. Only the first has a page and a JSON-LD document; what the others say is in the downloads, but not on the site. Make them one record, or give them addresses of their own. The example names the address.",
  'bad-site-url': W3ID_TEXT['bad-site-url'],
  'bad-site-dir': "The site's folder (--site-dir) must be one name of letters, digits and . _ -, not starting with '.'.",
  'unsafe-workflow-value': "A value that goes into the site's workflow could change what the workflow does: it holds a line break, or '${{', which GitHub reads as an expression of its own; or, for the ref of PLATO tools, characters other than letters, digits and . _ / -. Nothing is written: give the value without them. The example names the option.",
  'dataset-path-guessed': "Where the spreadsheet tables are in your repository is not known (the page cannot tell which folder the files were chosen from), so the workflow reads them from the folder the example names. Change the path in .github/workflows/pages.yml (twice) if they are somewhere else, or make the site with the command line, which knows.",
  'custom-domain-path': "The base address is on a domain of its own but not at its root. GitHub Pages serves a custom domain from the root of one site, so no CNAME file is written: the pages will be at the base address only if this repository is a project site named after the path, under an account whose own Pages site has this domain. Otherwise use a base at the domain's root, or a w3id.org address.",
  'site-address-unknown': "Where the site will be served is not known (give --repo, or --site-url), so the 404 page's links start from the root of the site's domain, which is right for a custom domain but not for a project's address on github.io.",
  'tools-ref-unpinned': "Which commit of PLATO tools made this is not known, so the workflow runs the tag of its version number, which may not exist yet. Give the commit or tag to run (--tools-ref) instead.",
  'tables-download-skipped': 'The dataset is too large for its spreadsheet tables to be made in memory, so they are not among the downloads. Convert it to tables with the command line if they are wanted.',
  'download-failed': 'A download could not be made in full; it is left out of the site.',
  'site-not-finished': 'The dataset could not be read to the end the second time, as the site was written, so the site was not finished and what was written of it is removed. The example says where it was.',
  'identity-matches-not-shown': "The dataset lists more identity matches apart from their places than the places' pages can gather, so the later ones are not on the pages; all are in the downloads.",
};

// The ref of PLATO tools the workflow runs (a commit, a tag or a branch), and the name of the site's
// folder: nothing a shell or YAML would read as more than a word.
const TOOLS_REF = /^[A-Za-z0-9._/-]+$/;
const SITE_DIR = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
// An element id made from an address's fragment: what HTML allows, and what minted ones are.
const SAFE_ANCHOR = /^[A-Za-z][A-Za-z0-9._:~-]*$/;

/**
 * The address the site is served at, as far as it can be known: the one given for this run; the
 * base address itself, when the base is on GitHub Pages or on a domain of its own; the repository's
 * Pages address. Null when none of these says.
 */
export function siteAddress(scheme, options) {
  if (options.siteUrl) return options.siteUrl.endsWith('/') ? options.siteUrl : options.siteUrl + '/';
  if (scheme.kind === 'github.io' || scheme.kind === 'custom') return scheme.base;
  const m = typeof options.repo === 'string' && options.repo.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (m) {
    const owner = m[1].toLowerCase();
    return m[2].toLowerCase() === `${owner}.github.io` ? `https://${owner}.github.io/` : `https://${owner}.github.io/${m[2]}/`;
  }
  return null;
}

/** What a place's files will weigh, from its record's length as JSON. */
const placeCost = (size, turtle) => size * (FACTORS.jsonld + FACTORS.html + (turtle ? FACTORS.turtle : 0)) + FACTORS.page + (turtle ? 2 : 1) * FACTORS.perFile;

export function create(ctx) {
  const { rep, options } = ctx;
  const only = Array.isArray(options.only) ? new Set(options.only.map((k) => String(k).trim()).filter(Boolean)) : null;
  const guard = caseGuard();
  // What the check pass learns: which places and sources are served, and at what cost.
  const served = new Set(), bad = new Set(), onlySeen = new Set();
  // The key of every place met, so that a second record with it is not written over the first.
  const seenPlace = new Set();
  const sources = new Map();          // key -> { iri, obj, n, places: [{ key, label, served }], last }, or null when unservable
  const idrs = new Map();             // place address -> identity matches the dataset lists apart from it
  const withdrawals = new Map();
  let places = 0, leftOut = 0, notUnder = 0, unidentified = 0, elsewhere = 0, jsonAll = 0, keptIdrs = 0, idrsDropped = false;
  let estimate = 0;
  let sc = null;

  // The places the site cannot serve, by address, to list on its home page and 404 page (a few
  // hundred at most; the rest are counted).
  const unservable = { list: [], n: 0 };
  const unserved = (iri, label) => { unservable.n++; if (unservable.list.length < UNSERVABLE_SHOWN) unservable.list.push({ iri, label }); };
  const addKey = (part, key, iri, label) => {
    // A draft is to be fixed before it is published; a published dataset's addresses are frozen,
    // and a known, listed gap must not stop the workflow from deploying the rest.
    const published = ctx.gazetteer?.status === 'published';
    const say = (kind, example) => rep.add(published ? 'warning' : 'error', kind, TEXT[published ? kind + '-published' : kind], example);
    const problem = keyProblem(key);
    if (problem) {
      say('key-not-servable', `${iri}: its last part ${problem}`); bad.add(part + '/' + key);
      if (part === 'place') unserved(iri, label);
      return false;
    }
    const other = guard.add(part, key);
    if (other) {
      say('keys-differ-in-case', `${sc.base}${part}/${other} and ${iri}`);
      if (part === 'place') { if (!bad.has('place/' + other)) unserved(sc.base + 'place/' + other, null); if (!bad.has('place/' + key)) unserved(iri, label); }
      bad.add(part + '/' + key); bad.add(part + '/' + other);
      return false;
    }
    return !bad.has(part + '/' + key);
  };
  // Every source an attestation cites: directly, through a citation, or as what another is derived from.
  function* walkSource(s) {
    if (!s) return;
    yield s;
    if (typeof s === 'object') for (const d of [].concat(s.derivedFrom || [])) yield* walkSource(d);
  }
  function* eachSource(att) {
    for (const s of [].concat(att.sources || [])) yield* walkSource(s);
    for (const c of [].concat(att.citations || [])) if (c && typeof c === 'object') yield* walkSource(c.source);
  }
  const noteSources = (rec, placeKey, isServed) => {
    for (const att of [].concat(rec.attestations || [])) {
      if (!att || typeof att !== 'object') continue;
      for (const s of eachSource(att)) {
        const iri = typeof s === 'string' ? s : s && s['@id'];
        const key = sc.sourceKey(iri);
        if (!key) continue;
        let e = sources.get(key);
        if (e === null) continue;
        if (!e) {
          if (!addKey('source', key, iri)) { sources.set(key, null); continue; }
          e = { iri, obj: null, n: 0, places: [], last: null };
          sources.set(key, e);
          // A source's JSON-LD carries the context its keys are read under, some 2.5 KB (sourceDocument).
          estimate += 2 * FACTORS.page + 2500;
        }
        if (!e.obj && typeof s === 'object') { e.obj = s; estimate += JSON.stringify(s).length * (FACTORS.jsonld + FACTORS.html + (options.turtle ? FACTORS.turtle : 0)); }
        if (e.last !== rec['@id']) {
          e.last = rec['@id']; e.n++;
          if (e.places.length < CITED_SHOWN) e.places.push({ key: placeKey, label: rec.label, served: isServed });
        }
      }
    }
  };

  return {
    header() { sc = ctx.scheme; },
    // The check pass: measure, and learn which places and sources the site will serve.
    event(ev) {
      if (!sc) return;
      if (ev.type === 'idr') {
        const v = ev.value;
        if (!v || typeof v.subject !== 'string' || !sc.placeKey(v.subject)) return;
        if (keptIdrs >= IDRS_KEPT) { idrsDropped = true; return; }
        keptIdrs++;
        (idrs.get(v.subject) || idrs.set(v.subject, []).get(v.subject)).push({ object: v.object, identityType: v.identityType, certainty: v.certainty, basis: v.basis });
        return;
      }
      if (ev.type !== 'record' || !ev.value || typeof ev.value !== 'object') return;
      const rec = ev.value;
      const atts = Array.isArray(rec.attestations) ? rec.attestations.filter((x) => x && typeof x === 'object') : [];
      collectWithdrawn(atts, withdrawals);
      const size = JSON.stringify(rec).length;
      jsonAll += size;
      const key = sc.placeKey(rec['@id']);
      // A second record for a place's key (the same address, or one that differs after '#'): its
      // files would be written over the first's, or fail because they exist. It is in the downloads.
      if (key && seenPlace.has(key)) { rep.error('duplicate-place', TEXT['duplicate-place'], rec['@id']); return; }
      if (key) seenPlace.add(key);
      places++;
      for (const x of atts) {
        if (typeof x['@id'] !== 'string') unidentified++;
        else if (typeof rec['@id'] === 'string' && !x['@id'].startsWith(rec['@id'].split('#')[0] + '#')) elsewhere++;
      }
      if (!key) { notUnder++; noteSources(rec, null, false); return; }
      const ok = addKey('place', key, rec['@id'], rec.label);
      if (only && !only.has(key)) { leftOut++; noteSources(rec, key, false); return; }
      if (only) onlySeen.add(key);
      if (ok) { served.add(key); estimate += placeCost(size, options.turtle); }
      noteSources(rec, key, ok);
    },
    async finish() {
      if (ctx.blocked()) return;
      // The same test as the w3id rules' target: an http(s) address and nothing a page or a
      // workflow could read as more than an address (javascript:, a quote, a space).
      if (options.siteUrl && siteTarget({ siteUrl: options.siteUrl }).error) { rep.error('bad-site-url', TEXT['bad-site-url'], String(options.siteUrl)); return; }
      // A place that collided in case with a later one was counted as served before the collision was seen.
      for (const b of bad) if (b.startsWith('place/')) served.delete(b.slice(6));
      const g = ctx.gazetteer;
      const published = g.status === 'published';
      // D4: addresses are minted before the dataset is committed, never while the site is built.
      if (unidentified) {
        if (published) { rep.add('error', 'attestations-without-ids', TEXT['attestations-without-ids'], undefined, unidentified); return; }
        rep.add('warning', 'attestations-without-ids', TEXT['attestations-without-ids-draft'], undefined, unidentified);
      }
      if (notUnder) rep.add('warning', 'place-not-under-base', TEXT['place-not-under-base'], `not under ${sc.base}place/`, notUnder);
      if (elsewhere) rep.add('warning', 'attestation-address-elsewhere', TEXT['attestation-address-elsewhere'], undefined, elsewhere);
      if (only) {
        const unknown = [...only].filter((k) => !onlySeen.has(k));
        if (unknown.length) rep.add('warning', 'only-unknown', TEXT['only-unknown'], unknown.slice(0, 5).join(', '), unknown.length);
      }
      if (leftOut) rep.add('warning', 'places-left-out', TEXT['places-left-out'], `${leftOut.toLocaleString('en-GB')} of ${places.toLocaleString('en-GB')}`, leftOut);
      if (idrsDropped) rep.warning('identity-matches-not-shown', TEXT['identity-matches-not-shown']);

      // The estimate, with the downloads (compressed, of every place) and the pages that list the places.
      const withTables = jsonAll <= TABLES_MAX_JSON;
      for (const s of sources.values()) if (s) estimate += s.places.length * 90;
      estimate += jsonAll * FACTORS.downloads + Math.ceil(served.size / PAGE) * (PAGE * 90 + FACTORS.page) + 4 * FACTORS.page;
      const limit = options.limitBytes || PAGES_LIMIT;
      const said = `estimated ${fmtBytes(Math.round(estimate))}, against GitHub Pages' ${fmtBytes(limit)}`;
      if (estimate > limit) {
        // D7: the page writes one zip, and stops at what Pages would take; the command line writes a folder, uncapped.
        if (!ctx.env.folder) { rep.error('too-big-for-pages', TEXT['too-big-for-pages'], said); return; }
        rep.warning('too-big-for-pages', TEXT['too-big-for-pages-cli'], said);
      }

      const url = siteAddress(sc, options);
      let cname = null;
      // E2: a domain of the user's own is served by Pages from the root of a site that names it in CNAME.
      if (sc.kind === 'custom' && !options.siteUrl) {
        if (new URL(sc.base).pathname === '/') cname = new URL(sc.base).hostname;
        else rep.warning('custom-domain-path', TEXT['custom-domain-path'], sc.base);
      }
      if (!url) rep.warning('site-address-unknown', TEXT['site-address-unknown']);
      let toolsRef = options.toolsRef;
      if (!toolsRef) { toolsRef = `v${PKG.version}`; rep.warning('tools-ref-unpinned', TEXT['tools-ref-unpinned'], toolsRef); }

      const input = ctx.input;
      const fileName = input?.files?.[0]?.name || 'dataset';
      // Spreadsheet tables chosen one by one are named after their folder, which the command line
      // knows (options.name) and the page may not: then after the dataset's short name.
      const csvTables = input?.format === 'tables' && input.container === 'csv';
      // The site's folder is named after the dataset's file, as a conversion names its output.
      const stem = (options.name || (csvTables ? sc.stem : fileName)).replace(/\.(gz)$/i, '').replace(/\.[^.]+$/, '');
      // What the workflow reads: the file, or for spreadsheet tables, the folder they are in.
      const datasetPath = options.datasetPath || (csvTables ? stem + '/' : fileName);
      if (csvTables && !options.name && !options.datasetPath) rep.warning('dataset-path-guessed', TEXT['dataset-path-guessed'], datasetPath);
      const onlyPath = only ? '.github/plato-site-only.txt' : null;
      // Everything the workflow is made of, checked before anything is written (site/repo.js quotes
      // each for YAML and the shell, but a line break or '${{' would be read before any quoting).
      const unsafe = Object.entries({ '--repo': options.repo, '--site-url': options.siteUrl, '--tools-ref': toolsRef, '--dataset-path': datasetPath, '--base': options.base, '--concept-doi': options.conceptDoi, '--site-dir': options.siteDir })
        .find(([k, v]) => v !== undefined && v !== null && (/[\r\n]/.test(String(v)) || String(v).includes('${{') || (k === '--tools-ref' && !TOOLS_REF.test(String(v)))));
      if (unsafe) { rep.error('unsafe-workflow-value', TEXT['unsafe-workflow-value'], `${unsafe[0]} ${JSON.stringify(String(unsafe[1]))}`); return; }
      if (options.siteDir !== undefined && !SITE_DIR.test(String(options.siteDir))) { rep.error('bad-site-dir', TEXT['bad-site-dir'], String(options.siteDir)); return; }
      const withdrawn = resolveWithdrawn(withdrawals).status;
      const draft = !published;
      // The workflow names the folder (--site-dir site), so that it can say where to upload it from
      // whatever the dataset's file is called in the repository.
      const tree = await ctx.tree(options.siteDir || `${stem}-site`);
      let bytes = 0, files = 0, stopped = false;
      const put = async (path, text) => {
        if (stopped) return;
        bytes += text.length; files++;
        // The page writes one zip: past the limit it stops, rather than make one GitHub would refuse.
        if (!ctx.env.folder && bytes > limit) { stopped = true; return; }
        await ctx.put(tree, path, text);
      };

      // The downloads first: the pages give their sizes.
      const downloads = [];
      for (const d of DOWNLOADS) {
        if (d.target === 'tables' && !withTables) { rep.warning('tables-download-skipped', TEXT['tables-download-skipped'], fmtBytes(jsonAll)); continue; }
        // Named by the address scheme (download/<scheme.stem><suffix>), where the w3id rules send download/<file>.
        const r = await writeDownload(tree, d, { input, env: ctx.env, options, stem: sc.stem });
        files++; bytes += r.size;
        if (!r.ok) { rep.warning('download-failed', TEXT['download-failed'], r.file); continue; }
        downloads.push({ ...r, sizeText: fmtBytes(r.size) });
      }

      // The places, as the dataset is read again. The reader does not wait for its sink's event(),
      // so each place's files are queued behind the last's: a tree has one file open at a time.
      const turtle = options.turtle ? new Turtle(ctx.env.resources.context, sc.base) : null;
      const href = (from) => (iri) => {
        if (typeof iri !== 'string') return null;
        const [addr, frag] = iri.split('#');
        const pk = sc.placeKey(addr);
        if (pk && served.has(pk)) return `${from}place/${pk}/${frag !== undefined ? '#' + frag : ''}`;
        const sk = sc.sourceKey(addr);
        if (sk && sources.get(sk)) return `${from}source/${sk}/`;
        return null;
      };
      const pageCtx = { gazetteer: g, draft, turtle: !!turtle, withdrawn, by: withdrawals, href: href('../../') };
      const inline = served.size <= PAGE ? [] : null;
      const pages = Math.ceil(served.size / PAGE);
      let listed = [], pageNo = 0, written = 0;
      const flushList = async (last) => {
        if (inline || !listed.length || (!last && listed.length < PAGE)) return;
        pageNo++;
        await put(`places/${pageNo}.html`, placesPage(pageNo, pages, listed, { gazetteer: g, draft }));
        listed = [];
      };
      const writtenPlace = new Set();
      const writePlace = async (rec) => {
        const iri = rec['@id'];
        const key = sc.placeKey(iri);
        // The first record of a place only (duplicate-place): its files are written once.
        if (!key || !served.has(key) || writtenPlace.has(key)) return;
        writtenPlace.add(key);
        const f = sc.files(PARTS.place, key);
        const doc = placeDocument(rec, g);
        // Unindented: indentation adds a third to a record, and a machine reads it either way.
        await put(f.jsonld, JSON.stringify(doc) + '\n');
        // An attestation's address is <place>#…; a place's own address may carry a fragment of its
        // own, which is not part of what its attestations' addresses start with.
        const prefix = iri.split('#')[0] + '#';
        const anchor = (att) => {
          const id = att['@id'];
          if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
          const frag = id.slice(prefix.length);
          return SAFE_ANCHOR.test(frag) ? frag : null;
        };
        await put(f.html, placePage(rec, { ...pageCtx, iri, key, anchor, idrs: idrs.get(iri), cite: citation(rec.label, iri, g) }));
        if (turtle) await put(f.ttl, turtle.place(doc));
        written++;
        if (inline) inline.push({ key, label: rec.label });
        else { listed.push({ key, label: rec.label }); await flushList(false); }
      };
      let queue = Promise.resolve(), failure = null;
      const r = await ctx.read({
        header() {},
        event(ev) {
          if (ev.type !== 'record' || !ev.value || typeof ev.value !== 'object') return;
          const rec = ev.value;
          queue = queue.then(() => (failure || stopped ? null : writePlace(rec))).catch((e) => { failure = e; });
        },
        async close() { await queue; },
      });
      await queue;
      if (failure) throw failure;
      if (r.incomplete) {
        // Half a site is no site: say so, and let the host take back what was written (publish()
        // returns incomplete, as when the first reading fails).
        const partial = await tree.close();
        rep.error('dataset-not-read', TEXT['site-not-finished'], partial.path || partial.name);
        return { incomplete: true };
      }
      await flushList(true);

      // The sources, from what the check pass gathered.
      let sourcePages = 0;
      for (const [key, s] of sources) {
        if (!s) continue;
        const f = sc.files(PARTS.source, key);
        await put(f.jsonld, JSON.stringify(sourceDocument(s.obj, s.iri, ctx.env.resources.context), null, 1) + '\n');
        await put(f.html, sourcePage(s, { gazetteer: g, draft, turtle: !!turtle, key, iri: s.iri, href: href('../../') }));
        if (turtle) await put(f.ttl, turtle.source(s.obj, s.iri));
        sourcePages++;
      }

      // The root: the landing page, the description, the 404 page, and what Pages needs.
      // The same description the FAIR report checks and the deposit files carry, with the downloads.
      const jsonld = schemaOrgDataset(g, sc, { release: options.release, conceptDoi: options.conceptDoi,
        distribution: downloads.map((d) => ({ '@type': 'DataDownload', name: d.file, contentUrl: sc.download(d.file), encodingFormat: d.mime, contentSize: `${d.size} B` })) });
      await put(SITE.landing, landingPage({ gazetteer: g, scheme: sc, draft, conceptDoi: options.conceptDoi, downloads, jsonld, turtle: !!turtle,
        places: { inline, pages, total: places, served: served.size, leftOut: places - served.size }, unservable }));
      await put(SITE.description, JSON.stringify(descriptionDocument(ctx.head), null, 1) + '\n');
      if (turtle) await put(SITE.descriptionTtl, turtle.description(ctx.head));
      await put(CSS_FILE, CSS + '\n');
      await put(SITE.notFound, notFoundPage({ gazetteer: g, draft, root: url || '/', downloads, leftOut, unservable }));
      if (cname) await put('CNAME', cname + '\n');
      // Without Jekyll, Pages serves every file as it is (Jekyll would hide names starting with _ or .).
      await put('.nojekyll', '');
      const site = await tree.close();
      if (stopped) { rep.error('stopped-at-limit', TEXT['stopped-at-limit'], `${fmtBytes(bytes)} by then`); return; }
      ctx.done(site);

      // What goes into the repository.
      const repoOpts = { toolsRef, datasetPath, name: stem, base: options.base, repo: options.repo, siteUrl: options.siteUrl, conceptDoi: options.conceptDoi, turtle: !!turtle, onlyPath,
        title: g.title, cname, leftOut };
      const repo = await ctx.tree(`${stem}-repo`);
      await ctx.put(repo, '.github/workflows/pages.yml', workflow(repoOpts));
      if (onlyPath) await ctx.put(repo, onlyPath, [...only].join('\n') + '\n');
      await ctx.put(repo, 'README-agora.md', readme({ ...repoOpts, siteUrl: url }));
      ctx.done(await repo.close());

      const size = site.size || bytes;
      rep.counts = {
        ...rep.counts, places: served.size, sources: sourcePages, 'left out': places - served.size, unservable: unservable.n, files, estimate: Math.round(estimate), bytes: size, written,
        said: [
          `A site of ${served.size.toLocaleString('en-GB')} place${served.size === 1 ? '' : 's'}${places - served.size ? ` (of ${places.toLocaleString('en-GB')})` : ''} and ${sourcePages.toLocaleString('en-GB')} source${sourcePages === 1 ? '' : 's'}, ${fmtBytes(size)} (estimated ${fmtBytes(Math.round(estimate))}).`,
          unservable.n ? `${unservable.n.toLocaleString('en-GB')} place${unservable.n === 1 ? ' has an address' : 's have addresses'} it cannot serve, listed on its home page as held in the downloads.` : '',
          draft ? 'Marked as a draft: not to be cited, and kept out of search engines.' : '',
        ].filter(Boolean),
      };
    },
  };
}
