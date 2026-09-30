// What goes into the user's own repository so that GitHub builds and serves the site (D4): a
// workflow that runs a pinned PLATO tools on the committed dataset and deploys what it writes to
// GitHub Pages, and a note saying how to set it up. The site itself is never committed: it is made
// from the dataset on every push, so the two cannot drift apart, and a large site does not fill the
// repository's history.
//
// The workflow only builds. Attestation addresses are minted before the dataset is committed
// (plato-tools publish mint): made in CI they would be made afresh on every run, and an address
// that changes is no address at all.

// A value inside a YAML double-quoted string and a shell single-quoted word at once.
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const yq = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/**
 * The command the workflow runs and the file it runs it in. `opts`: toolsRef, datasetPath, name
 * (the site's folder is <name>-site, as the command line names it from the dataset's file), base,
 * repo, siteUrl, conceptDoi, turtle, onlyPath.
 */
export function workflow(opts) {
  const args = [
    `npx --yes github:pelagios/plato-tools#${opts.toolsRef}`, 'publish site', shq(opts.datasetPath), '--out _build',
    opts.base ? `--base ${shq(opts.base)}` : '', opts.repo ? `--repo ${shq(opts.repo)}` : '', opts.siteUrl ? `--site-url ${shq(opts.siteUrl)}` : '',
    opts.conceptDoi ? `--concept-doi ${shq(opts.conceptDoi)}` : '', opts.turtle ? '--turtle' : '', opts.onlyPath ? `--only ${shq(opts.onlyPath)}` : '',
  ].filter(Boolean);
  // A folder of spreadsheet tables is watched for a change to any file in it.
  const paths = [opts.datasetPath.endsWith('/') ? opts.datasetPath + '**' : opts.datasetPath, '.github/workflows/pages.yml', opts.onlyPath].filter(Boolean);
  return `# Builds the gazetteer's website from the dataset committed here and publishes it on GitHub
# Pages. Written by PLATO tools (plato-tools publish site); see README-agora.md.
#
# PLATO tools is pinned to one version (${opts.toolsRef}), so the site is made the same way every
# time. To use a newer one, change the ref after the # below, then check the site it makes locally.
name: Publish the gazetteer site

on:
  push:
    branches: [main]   # your repository's default branch, if it is not main
    paths:
${paths.map((p) => `      - ${yq(p)}`).join('\n')}
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# One deployment at a time; one that has started is allowed to finish.
concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      # Checks the dataset and writes the site to _build/${opts.name}-site. It stops (and nothing is
      # published) if the dataset has problems, or if its attestations have no addresses yet.
      - name: Build the site
        run: |
          ${args.join(' ')}
      - uses: actions/upload-pages-artifact@v5
        with:
          path: _build/${opts.name}-site
          # The site holds files whose names start with a dot (.nojekyll), which are left out otherwise.
          include-hidden-files: true
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
`;
}

/** The note that goes with the workflow: what to commit, what to switch on, and what to check. */
export function readme(opts) {
  const b = opts.base;
  return `# Publishing ${opts.title || 'the gazetteer'} on GitHub Pages

Written by PLATO tools (\`plato-tools publish site\`). The site is made from the dataset by a
GitHub Actions workflow, every time the dataset changes; it is never committed itself.

## Once

1. Copy \`.github/workflows/pages.yml\` from here into your repository${opts.repo ? ` (${opts.repo})` : ''}${opts.onlyPath ? `, with \`${opts.onlyPath}\`` : ''}.
2. In the repository's Settings, under Pages, set Source to **GitHub Actions**.${opts.cname ? `
3. Under Pages, set the custom domain to **${opts.cname}**, and point the domain's DNS at GitHub
   Pages as GitHub's documentation says. The site also carries a CNAME file saying so.` : ''}

## Each release

1. Give the dataset's attestations their addresses **before** committing it:
   \`plato-tools publish mint ${opts.datasetPath}\` writes a copy in which every attestation has one.
   Commit that copy, as \`${opts.datasetPath}\`. The workflow never makes addresses itself: made
   there, they would be made again on every run, and would not stay the same.
2. Look at the site on your own computer first: \`plato-tools publish site ${opts.datasetPath}${b ? ` --base ${b}` : ''}\`
   writes it to \`${opts.name}-site/\`, to open in a browser (through a local web server, such as
   \`npx serve ${opts.name}-site\`, so that its links work as they will online).
3. Commit and push. The workflow checks the dataset, builds the site and publishes it; if the
   dataset has problems, it stops and nothing changes online.

## What the site holds

- \`index.html\`, the dataset's home page; \`index.jsonld\`, its description for machines.
- \`place/<id>/index.html\` and \`place/<id>.jsonld\` for each place${opts.turtle ? ', and `place/<id>.ttl`' : ''}; the same under \`source/\` for each source.
- \`download/\`: the whole dataset as PLATO JSON Lines, N-Triples and spreadsheet tables.
- \`404.html\`, which GitHub Pages shows for any address it has no file for.
${opts.leftOut ? `
This site leaves out ${opts.leftOut.toLocaleString('en-GB')} places (it holds those listed in \`${opts.onlyPath || 'the --only file'}\`),
to stay within what GitHub Pages will serve (1 GB). Their addresses lead to the 404 page, which
points to the downloads, where every place is.
` : ''}
The site is served at ${opts.siteUrl ? opts.siteUrl : 'the address GitHub Pages gives the repository'}${b && opts.siteUrl !== b ? `; the dataset's own addresses (${b}…) must redirect there (for a w3id.org address, \`plato-tools publish w3id\` writes the rules)` : ''}.
`;
}
