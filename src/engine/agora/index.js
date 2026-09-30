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
import { run } from '../pipeline.js';
import { Report } from '../report.js';
import { scheme } from './address.js';
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
 * Returns { report, outputs, incomplete? }, as run() does.
 */
export async function publish({ part, input, previous, options = {} }, env) {
  const impl = PUBLISH_PARTS[part];
  if (!impl) throw new Error(`no such part of publishing: ${part}`);
  const rep = new Report();
  const outputs = [];
  const ctx = {
    rep, env, options, previous, input, outputs,
    gazetteer: {}, head: null, scheme: null, checkErrors: 0,
    /** Read the dataset (or another input) once more, handing its description and records to `sink`. */
    read: (sink, what = input) => run({ input: what, action: 'check', options: { base: options.base, sink } }, env),
    tree: (name) => openTree(env, name),
    put,
    /** Record an output that is finished. */
    done: (o) => { outputs.push(o); return o; },
    /** For the parts that write something to publish: stop, and say why, if the dataset cannot be published from. */
    blocked() {
      if (ctx.checkErrors) { rep.add('error', 'dataset-has-problems', TEXT['dataset-has-problems'], undefined, ctx.checkErrors); return true; }
      if (!ctx.scheme) { rep.error('no-base', TEXT['no-base']); return true; }
      return false;
    },
  };
  const p = impl.create(ctx);
  if (p.prepare) { const r = await p.prepare(); if (r && r.incomplete) return { report: rep.toJSON(), outputs, incomplete: true }; }
  const sink = {
    header(head) {
      ctx.head = head || {};
      ctx.gazetteer = (head && typeof head.gazetteer === 'object' && head.gazetteer) || {};
      ctx.scheme = scheme(options.base || ctx.gazetteer.uriSpace);
      if (p.header) p.header(ctx.head);
    },
    event(ev) { if (p.event) p.event(ev); },
    async close() { if (p.close) await p.close(); },
  };
  const r = await ctx.read(sink);
  if (r.incomplete) {
    rep.error('dataset-not-read', TEXT['dataset-not-read'], r.report.items.find((i) => i.kind === 'unreadable')?.examples[0]);
    return { report: rep.toJSON(), outputs, incomplete: true };
  }
  ctx.checkErrors = r.report.errors;
  ctx.checked = r.report;
  await p.finish();
  return { report: rep.toJSON(), outputs };
}
