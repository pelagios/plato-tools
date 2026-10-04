// Publish a dataset (docs/plans/methodos.md, section 6): check it, then Agora's four parts. Minting
// comes before the FAIR report, not after it as the plan lists them: the report refuses a published
// dataset whose attestations have no addresses yet, and minting is what gives them.
export default {
  key: 'publish-a-dataset',
  title: 'Publish a dataset',
  version: 2,
  files: {
    files: { words: 'The dataset to publish', types: ['files'] },
  },
  asks: {
    base: { question: 'Under what base address will your places have web addresses of their own (for example https://example.org/places/)?', kind: 'text', optional: true },
    release: { question: 'What is this release called (for example 2026-10 or v1)?', kind: 'text', optional: true },
    repo: { question: 'Which GitHub repository will the site be published from (owner/name)?', kind: 'text', optional: true },
    maintainers: { question: 'Who maintains the permanent addresses on w3id.org (GitHub user names)?', kind: 'list', optional: true },
  },
  steps: [
    { id: 'check', op: 'check', title: 'Check the dataset', from: { files: '$files' } },
    { id: 'mint', op: 'publish.mint', title: 'Give every place and source a permanent address', from: { dataset: '$files' }, options: { release: '$release', base: '$base' } },
    { id: 'report', op: 'publish.report', title: 'Write the FAIR report', from: { dataset: 'mint.dataset' }, options: { release: '$release' } },
    { id: 'site', op: 'publish.site', title: 'Build the web site', from: { dataset: 'mint.dataset' }, options: { release: '$release', repo: '$repo' } },
    { id: 'w3id', op: 'publish.w3id', title: 'Write the permanent-address rules', from: { dataset: 'mint.dataset' }, options: { repo: '$repo', maintainers: '$maintainers' } },
  ],
};
