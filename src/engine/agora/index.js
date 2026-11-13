// Agora: from a checked dataset to one that can be cited and found. Four parts, all from one address
// scheme (address.js), so that what the data says, what the site holds and what the redirects send
// people to cannot drift apart:
//   report  what the dataset's description lacks for FAIR publishing, and the deposit metadata
//           (.zenodo.json, CITATION.cff, DataCite JSON) made from it;
//   mint    a copy of the dataset in which every attestation has a permanent address (@id);
//   site    a static website for GitHub Pages: a page and data files for every place;
//   w3id    the folder of redirect rules for a w3id.org namespace, with the addresses to test.
//
// Each part reads the dataset through the engine that checks it (run() in pipeline.js), as the
// version check does, receiving the gazetteer's description and then one place-centric record at a
// time, so that it works at any size. The check's own findings count: a part that writes something
// to be published does not write it from a dataset that has problems.
import { run, Aborted, stoppable } from '../pipeline.js';
import { Report } from '../report.js';
import { noBaseKind, scheme, normaliseBase, isStandIn, standInIn, rewriteStandIn, STAND_IN_BASE, OLD_STAND_IN_BASE } from './address.js';
import { openTree, put } from './tree.js';
import * as fair from './fair.js';
import * as mint from './mint.js';
import * as site from './site.js';
import * as w3id from './w3id.js';

export const PUBLISH_PARTS = { report: fair, mint, site, w3id };

// Findings shared by the parts. A part's own wording lives in its own module, as the version
// check's does in compare.js.
export const TEXT = {
  'dataset-has-problems': 'The dataset has problems of its own, which are not listed here; check it to see them. Nothing is written for publishing until they are fixed.',
  'dataset-not-read': 'The dataset could not be read to the end, so nothing was written.',
  'bad-doi': "The concept DOI (--concept-doi) is not a DOI: give it as 10.<digits>/<suffix>, or as its https://doi.org/ address, as Zenodo shows it. Nothing that would carry it is written.",
  'base-is-fragment': "The base address ends in '#', so every place's address would be a fragment of one document (<base>#place/<id>). PLATO allows that, but a web server never sees what follows '#', so a static site cannot give each place a page of its own, nor w3id a rule of its own: nothing is published from it. Give a base that ends in '/' instead (the about sheet's base_uri, or uriSpace in PLATO JSON, or one for this run), while the dataset is a draft.",
  // Said by the report and the site of every dataset not published (Issue #26, WHG place#310).
  'draft-is-public': "A draft is public once its site is uploaded: anyone with the address can read its pages and download its data, though each page says DRAFT and asks search engines not to list it (noindex), and an address is easily passed on. GitHub Pages serves a site from a private repository to everyone too (only an Enterprise organisation can restrict it). Until the dataset is ready to be seen, keep the site on your own computer.",
  // The stand-in base (address.js; Stephen, 13 November 2026): nothing temporary is ever published. Said by every
  // part, of the base and of any address in the dataset; `-mint` where minting itself is refused, for want of a real base.
  'stand-in-address': "The dataset still has temporary web addresses (the example gives the first found), which were used so that work could start before you had a web address of your own. Nothing temporary is ever published, so nothing was written. First do the step that gives every place a permanent address (mint), with the web address your places will live under as the base address (in Options on the page, or --base): it moves every temporary address to yours. Then do this step again, with the dataset that step writes.",
  'stand-in-address-mint': "The dataset's web addresses are temporary ones (the example gives the first found), which were used so that work could start before you had a web address of your own. Nothing temporary is ever published, so nothing was written. Give the web address your places will live under (the base address: in Options on the page, or --base), then do this step again: every temporary address is then moved to yours.",
  'stand-in-rewritten': "The dataset's web addresses were temporary ones. Every one of them (each place and region, what each relation and identity points at, each candidate and the candidate set's own address) has been moved to the base address given, and nothing temporary is left in the copy written. The example gives the base, and the count how many addresses were moved. Use the copy from here on: the files written before it still hold the temporary addresses, and are not for publishing.",
  'no-base': "The dataset does not say under what address its places are published: give its base address (the about sheet's base_uri, or uriSpace in PLATO JSON), or give one for this run.",
};

/**
 * One run of one part. `input` is the dataset as detect() describes it; `previous` is an earlier
 * release, when one is given (minting inherits its addresses, and it is checked that nothing
 * published was lost). `options`:
 *   base         the base address for this run, instead of the dataset's uriSpace;
 *   release      the name of the release being made (its address is <base>release/<name>);
 *   conceptDoi   the DOI that names every version of the dataset, once Zenodo has given one;
 *   maintainers  GitHub user names of those who maintain the w3id namespace;
 *   repo         the GitHub repository ('owner/name') the site is published from;
 *   siteUrl      where the site is served, if not at the base address or the repository's Pages address;
 *   turtle       the site also holds Turtle for each place;
 *   only         the site holds only these places (the keys of their addresses); the rest are in its downloads;
 *   datasetPath  where the dataset is in the user's repository, for the site's workflow;
 *   toolsRef     the commit or tag of PLATO tools the site's workflow runs;
 * Returns { report, outputs, incomplete? }, as run() does.
 */
export async function publish({ part, input, previous, options = {} }, env) {
  // options.signal stops a part at the next record of any reading (run()'s, the site's downloads', a
  // comparison's): it ends as a run stopped does, incomplete and aborted, with no outputs, and what it
  // had opened closed for the host to remove, never as a part that finished with something missing.
  return stoppable(options.signal, env, (e) => publishing({ part, input, previous, options }, e));
}
async function publishing({ part, input, previous, options }, env) {
  const impl = PUBLISH_PARTS[part];
  if (!impl) throw new Error(`no such part of publishing: ${part}`);
  const rep = new Report();
  const outputs = [];
  const ctx = {
    rep, env, options, previous, input, outputs,
    gazetteer: {}, head: null, scheme: null, checkErrors: 0,
    /** Read the dataset (or another input) once more, handing its description and records to `sink`. */
    read: async (sink, what = input) => {
      const r = await run({ input: what, action: 'check', options: { base: options.base, sink, signal: options.signal } }, env);
      if (r.aborted) throw new Aborted();
      return r;
    },
    tree: (name) => openTree(env, name),
    put,
    /** Record an output that is finished. */
    done: (o) => { outputs.push(o); return o; },
    /** Say why there is no scheme: no base at all, or one that ends in '#' (noBaseKind). */
    noBase() {
      const base = options.base || ctx.gazetteer.uriSpace;
      const kind = noBaseKind(base);
      rep.error(kind, TEXT[kind], kind === 'no-base' ? undefined : base);
    },
    /** For the parts that write something to publish: stop, and say why, if the dataset cannot be published from. */
    blocked() {
      if (ctx.standIn) return true;   // said already (the guard below), once
      if (ctx.checkErrors) { rep.add('error', 'dataset-has-problems', TEXT['dataset-has-problems'], undefined, ctx.checkErrors); return true; }
      if (!ctx.scheme) { ctx.noBase(); return true; }
      return false;
    },
  };
  const p = impl.create(ctx);
  if (p.prepare) { const r = await p.prepare(); if (r && r.incomplete) return { report: rep.toJSON(), outputs, incomplete: true }; }
  // The guard on the stand-in base (address.js): no part writes anything from a dataset whose base, or any
  // address in it, is temporary. Minting under a real base is where they are replaced: every address under
  // the stand-in is rewritten to the base before the part sees it (the header and each record), so that what
  // it mints, checks against a previous release and writes is the dataset as it will be published. What is
  // still temporary after that (or, in any other part, at all) is counted, and refused below.
  const temporary = { found: 0, example: null, moved: { n: 0 } };
  let rewrite = null;
  const seen = (value) => { const f = standInIn(value); if (f) { temporary.found++; temporary.example ??= f; } };
  const sink = {
    header(head) {
      head = head || {};
      const g0 = (typeof head.gazetteer === 'object' && head.gazetteer) || {};
      ctx.scheme = scheme(options.base || g0.uriSpace);
      if (part === 'mint' && ctx.scheme && !isStandIn(ctx.scheme.base)) {
        // The stand-in bases, and the dataset's own base or address where that is temporary too.
        const own = [g0.uriSpace, g0['@id']].map((x) => normaliseBase(typeof x === 'string' ? x.split('#')[0] : x)).filter(isStandIn);
        const from = [...new Set([STAND_IN_BASE, OLD_STAND_IN_BASE, ...own])].sort((a, b) => b.length - a.length);
        rewrite = (v) => rewriteStandIn(v, ctx.scheme.base, from, temporary.moved);
        head = rewrite(head);
      }
      ctx.head = head;
      ctx.gazetteer = (typeof head.gazetteer === 'object' && head.gazetteer) || {};
      if (ctx.scheme && isStandIn(ctx.scheme.base)) { temporary.found++; temporary.example ??= ctx.scheme.base; }
      seen(head);
      if (p.header) p.header(ctx.head);
    },
    event(ev) {
      if (rewrite && ev && ev.value && typeof ev.value === 'object') ev = { ...ev, value: rewrite(ev.value) };
      if (ev) seen(ev.value);
      if (p.event) p.event(ev);
    },
    async close() { if (p.close) await p.close(); },
  };
  const r = await ctx.read(sink);
  if (r.incomplete) {
    rep.error('dataset-not-read', TEXT['dataset-not-read'], r.report.items.find((i) => i.kind === 'unreadable')?.examples[0]);
    return { report: rep.toJSON(), outputs, incomplete: true };
  }
  ctx.checkErrors = r.report.errors;
  ctx.checked = r.report;
  if (temporary.found) {
    ctx.standIn = true;
    const kind = part === 'mint' ? 'stand-in-address-mint' : 'stand-in-address';
    rep.add('error', 'stand-in-address', TEXT[kind], temporary.example, temporary.found);
  } else if (temporary.moved.n) {
    rep.add('warning', 'stand-in-rewritten', TEXT['stand-in-rewritten'], ctx.scheme.base, temporary.moved.n);
    rep.counts.standInMoved = temporary.moved.n;
  }
  // A part that could not finish what it began (a second reading that stopped) says so, and the
  // host then removes what it wrote, as after a failure.
  const f = await p.finish();
  if (f && f.incomplete) return { report: rep.toJSON(), outputs, incomplete: true };
  return { report: rep.toJSON(), outputs };
}
