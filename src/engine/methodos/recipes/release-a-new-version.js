// Release a new version (plan #34, item 10; Issue #23; Stephen's decisions of 17 October 2026): the new
// version of a published dataset, edited freely since its release, checked; then revised against the previous
// release by Mneme (src/engine/revise.js), so that nothing published is deleted or changed: what the new
// version deleted is put back and retracted, what it changed is put back and replaced (plato:Supersedes), a
// place dropped comes back with its attestations retracted, and the header is made a release's. The revised
// dataset is checked again, compared with the previous release (so that the tracker shows what was kept,
// withdrawn, replaced and added), written out in the format asked, and, if asked, published as Publish a
// dataset publishes: minted against the previous release (every published address kept), the FAIR report,
// the site, the w3id rules.
//
// The previous release is chosen at the revise step (a late file, as the other dataset of a match is), through
// Mneme's "Revise against the earlier version…" on the page: the copy with addresses the site was made from
// (<name>-with-ids.jsonl, which minting wrote), not the working copy before minting. The retractions are
// signed by the reviewer the page remembers (Krisis's name and ORCID), or --reviewer on the command line.
import publishADataset from './publish-a-dataset.js';
import { ASKS } from './downstream.js';
import { BASE } from './asks.js';

export default {
  key: 'release-a-new-version',
  title: 'Release a new version',
  version: 1,
  files: {
    files: { words: 'The new version of your dataset (in a PLATO format: JSON, JSON Lines, RDF, or the spreadsheet tables)', types: ['files'] },
    previous: { words: 'The previous release, as published (the copy with addresses)', types: ['files'], late: true },
  },
  // What the revision cannot do, said in words before the workflow is followed and while it is.
  cannot: [
    'Nothing published is deleted: an attestation the new version deleted is put back and retracted (plato:Retracts), one it changed is put back and the new form written beside it, replacing it (plato:Supersedes), and a place dropped whole comes back with every attestation retracted, so that its address keeps resolving. Each is named in the report.',
    'Where the new version has no addresses (the spreadsheet tables, minted afresh for every release), a deleted attestation is paired with an added one only when the pairing is sure: exactly one of each kind, citing the same source, in the place. Otherwise nothing is guessed: it is retracted, and the other added.',
    'A name, location, date, type, property or citation with a web address of its own that the new version changed, or no longer describes, is refused in words: put it back, and record the correction as a new one under a new address, in a new attestation that replaces the old one.',
    'A changed decision about a match is not for this workflow: Krisis\'s Finish withdraws the answer it changes. Nor is merging two places: an identity relation says that they are the same.',
  ],
  before: [
    { words: 'The previous release is the copy with addresses that the site was made from (<name>-with-ids.jsonl, which minting wrote), not your working copy before minting: a retraction or a replacement can only point at an attestation that has an address.' },
    { words: 'The retractions are made in the name of the reviewer this browser remembers (the name and ORCID under Krisis\'s review): give it before the revise step.' },
  ],
  asks: {
    'will-publish': ASKS['will-publish'],
    base: BASE,
    target: ASKS.target,
    release: publishADataset.asks.release,
    repo: publishADataset.asks.repo,
    maintainers: publishADataset.asks.maintainers,
  },
  steps: [
    { id: 'check', op: 'check', title: 'Check the new version', from: { files: '$files' } },
    { id: 'revise', op: 'revise', title: 'Revise it against the previous release: withdraw or replace what it changed, so nothing published is lost', from: { later: '$files', earlier: '$previous' }, options: { release: '$release', base: '$base' } },
    { id: 'again', op: 'check', title: 'Check the revised dataset', from: { files: 'revise.dataset' } },
    { id: 'compare', op: 'compare', title: 'Compare it with the previous release', from: { earlier: '$previous', later: 'revise.dataset' } },
    { id: 'out', op: 'convert', title: 'Write it out', from: { files: 'revise.dataset' }, options: { target: '$target' } },
    { id: 'mint', op: 'publish.mint', title: 'Give every place and source a permanent address, keeping those published', from: { dataset: 'revise.dataset', previous: '$previous' }, options: { release: '$release', base: '$base' }, when: 'will-publish' },
    { id: 'report', op: 'publish.report', title: 'Write the FAIR report', from: { dataset: 'mint.dataset', previous: '$previous' }, options: { release: '$release' }, when: 'will-publish' },
    { id: 'site', op: 'publish.site', title: 'Build the web site', from: { dataset: 'mint.dataset' }, options: { release: '$release', repo: '$repo' }, when: 'will-publish' },
    { id: 'w3id', op: 'publish.w3id', title: 'Write the permanent-address rules', from: { dataset: 'mint.dataset' }, options: { repo: '$repo', maintainers: '$maintainers' }, when: 'will-publish' },
  ],
};
