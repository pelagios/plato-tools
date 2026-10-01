#!/usr/bin/env node
// The command line: check and convert PLATO data in batch, and compare two versions of a dataset,
// with the engine the browser uses (src/engine/pipeline.js, src/engine/compare.js), hosted in Node
// by src/node/host.js. Exit status: 0 when no input has problems, 1 when any has, 2 when the command
// is wrong or an input cannot be read or written.

// Node's built-in SQLite announces itself as experimental on every run; that says nothing about
// the data, so it is left out. Every other warning is still shown.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite is an experimental feature/.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};

const { parseArgs } = await import('node:util');
const { readFileSync, statSync } = await import('node:fs');
const { run, TARGETS, DEFAULT_TABLE_BASE } = await import('../src/engine/pipeline.js');
const { compare } = await import('../src/engine/compare.js');
const { publish, PUBLISH_PARTS } = await import('../src/engine/agora/index.js');
const { match } = await import('../src/engine/krisis/match.js');
const { apply, OUTPUTS: REVIEW_OUTPUTS } = await import('../src/engine/krisis/apply.js');
const { checkReviewer, isColumns } = await import('../src/engine/krisis/work.js');
const { exportCandidates, serialiseCandidateSet } = await import('../src/engine/krisis/candidates.js');
const { detect, readable, DataError } = await import('../src/engine/input.js');
const { nodeResources, gatherInputs, openFiles, isSystemError, NodeHost } = await import('../src/node/host.js');
const { toolsCommit } = await import('../src/node/build-info.js');
const { fmtBytes, fmtTime, formatName, progressText, summary, groups, draftNote, explainedLines, gazetteerWarnings, LOOKUP_WORDS } = await import('../src/engine/words.js');
const { mappingOf, withSheet } = await import('../src/engine/hermes/generic.js');
const { FIELDS, mappingToSave } = await import('../src/engine/hermes/columns.js');
const { teiReadingRefusal } = await import('../src/engine/hermes/tei.js');
const { preview, previewRefusal, previewLine, PREVIEW_LIMIT } = await import('../src/engine/hermes/preview.js');
const { PREVIEW_WORDS } = await import('../src/engine/words.js');
const { clusterCounter, clustersInFile, checkClusters, splitMatching, CLUSTER_METHODS, DEFAULT_METHOD } = await import('../src/engine/hermes/cluster.js');
const { columnValues } = await import('../src/engine/hermes/generic.js');

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `plato-tools: check and convert PLATO data, and compare versions of it, from the command line.

Usage:
  plato-tools check [options] INPUT...
  plato-tools convert --to TARGET [--out DIR] [options] INPUT...
  plato-tools preview [--limit N] [--columns FILE] [--split …] [--sheet NAME] [reading options] INPUT
                                            show the first N records (default ${PREVIEW_LIMIT}) of a table of
                                            places (CSV, plain GeoJSON, a sheet of a workbook), a
                                            TEI edition or W3C Web Annotations, as they would be
                                            read: the records as JSON Lines to stdout, what was
                                            lost from them so far to stderr (both, as one JSON
                                            object, with --json). Nothing is checked as a whole,
                                            and nothing is written.
  plato-tools cluster --column NAME [--method M] [--sheet NAME] INPUT
                                            propose groups of similar spellings in one column of
                                            a table of places, as JSON, for review: nothing is
                                            applied (give the groups you keep with --clusters)
  plato-tools compare [options] EARLIER LATER
                                            check that a published dataset was only added to:
                                            every attestation of the EARLIER version must be in
                                            the LATER one, unchanged (PLATO's append-only rule)
  plato-tools publish PART [options] INPUT
                                            prepare a dataset for publishing (Agora); PART is
                                            report: what its description lacks, and deposit
                                                    metadata (.zenodo.json, CITATION.cff, DataCite)
                                            mint:   a copy in which every attestation has an @id
                                            site:   a static website for GitHub Pages
                                            w3id:   redirect rules for a w3id.org namespace
  plato-tools match [options] SUBJECTS --with OTHERS
                                            suggest places of SUBJECTS that may be the same as
                                            places of OTHERS, for review, in a work file
                                            (matching two local files sends nothing anywhere)
  plato-tools apply [options] SUBJECTS --review WORKFILE
                                            make the decisions of a finished review into PLATO
                                            attestations, added to SUBJECTS (or on their own)
  plato-tools lookup [options] SUBJECTS [--review WORKFILE]
                                            look the places of SUBJECTS up in a gazetteer (the
                                            World Historical Gazetteer by default), and add what
                                            it finds to a work file for review (this sends each
                                            place's name to the gazetteer; nothing else unless asked)
  plato-tools candidates [options] WORKFILE
                                            publish a review's suggestions as a PLATO candidate
                                            set, for its attestations to point at (promotedFrom);
                                            each candidate's address is stored in WORKFILE
  plato-tools datacube [--json] FILE...     check a cube export (convert --to ntriples --cube)
                                            against the RDF Data Cube integrity constraints IC-1,
                                            IC-2, IC-11, IC-12 and IC-14

Each INPUT is one file, or one set of spreadsheet tables:
  - the sheets of the tables (places.csv, names.csv...) are one set of tables per directory,
    whether the directory is given or its CSV files are named one by one;
  - every other CSV file, in a directory given or named, is an input of its own, and so is a
    lone sheet whose header does not begin as that sheet's does (a places.csv of one's own);
  - a zip of the CSV files, or a workbook (.xlsx, .ods) whose sheets are named after the
    tables' (two or more, or one that begins as that sheet does), is one set of tables.
A CSV (or TSV) file that is not one of the tables' sheets, a sheet of any other workbook, and
plain GeoJSON that is not Linked Places Format, are read as a table of places: which column
holds what (name, latitude, longitude, id, the place's web address…) is guessed from the
column names, and printed; see --columns. Of a workbook, the first sheet that is not hidden is
read, and the others are named in the report; see --sheet.
Everything else is read as the format it turns out to be: PLATO JSON or JSON Lines, RDF
(N-Triples, N-Quads, Turtle), Linked Places Format v1, W3C Web Annotations as Recogito exports
them, or a TEI XML edition (annotations and TEI are read, not written). Gzipped files are read
directly.

Targets for --to:
${Object.entries(TARGETS).map(([k, v]) => `  ${k.padEnd(12)} ${v.label}`).join('\n')}

Options:
  --to TARGET       convert: the format to write (required).
  --out DIR         convert, match, apply: where to write the outputs (default: the current directory).
                    Each output is named after its input; an existing file is never replaced
                    unless --overwrite is given.
  --overwrite       convert, match, apply: replace outputs that already exist.
  --base URL        spreadsheet tables: the web address under which the identifiers of the
                    places and sources are made (default: the about sheet's base_uri, or
                    ${DEFAULT_TABLE_BASE} without one). Given, it is used instead of
                    base_uri, with a warning if they differ. For a table of places (CSV or
                    GeoJSON), the base under which each place's address is made from its id.
  --columns FILE    a table of places (CSV or GeoJSON): which column holds what, as a JSON
                    object {"column name": "field"}, instead of the guess. The guess is
                    printed with each such input, as JSON to save, edit and give back here.
                    match: for the dataset matched (not --with's), kept in the work file;
                    apply: in place of the work file's, which is used when none is given.
                    The fields: ${Object.keys(FIELDS).slice(0, 6).join(', ')},
                    ${Object.keys(FIELDS).slice(6).join(', ')};
                    or "note" (kept in the notes as "column: value") or "skip" (not carried
                    over, and reported). A column of a gazetteer's ids is made into web
                    addresses with {"field": "address", "pattern": "https://pleiades.stoa.org/places/{id}"},
                    the id replacing {id}; a pattern is suggested for such a column, never
                    used until it is given here. A region the place lies in (a parish, a
                    county, a country…) is {"field": "within", "level": N}, 1 the widest:
                    such columns are guessed from their headings, widest first.
  --split COLUMN=SEP[:LEVELS]
                    check, convert, preview: a table of places' column of several regions in
                    one cell, narrowest first ("Rotherhithe, Surrey, England"), split on SEP
                    into levels: LEVELS are the levels its parts go to, narrowest first (1 is
                    the widest), and "name" first if the first part is the place's own name:
                    --split 'Place=, :name,3,2,1'. Without LEVELS, as many as the most parts
                    in the first rows. Repeatable; it changes the guess, or --columns, for that
                    column only, and is printed in the mapping as {"field": "split", …}.
                    Parts beyond the levels given are named in the report. (A pasted list of
                    names is the page's; here, save the list as a CSV file headed "name".)
  --clusters FILE   a table of places (check, convert, preview): groups of similar spellings
                    to look places up by, as saved on the page (a matching saved with groups
                    ticked), or as {"<column>": {"method": "fingerprint", "groups":
                    [{"chosen": "Rotherhithe", "members": ["Rotherhith", "ROTHERHITHE"]}]}}.
                    Each row whose value is a member keeps the source's spelling in PLATO; its
                    attestation gets a note naming the group and the spelling chosen, which
                    the lookup can use. Groups are never applied without this option.
                    Any other input is read without them, and a line on stderr says so.
  --column NAME     cluster: the column whose spellings to group.
  --method M        cluster: how values are grouped: ${CLUSTER_METHODS.join(', ')}
                    (default ${DEFAULT_METHOD}).
  --limit N         preview: how many records to show (default ${PREVIEW_LIMIT}). Reading stops at the
                    first record past them; a file is never read to its end to count it.
  --sheet NAME      check, convert, preview: the sheet of a workbook to read as a table of places,
                    instead of its first sheet that is not hidden. A name the workbook does
                    not have is refused, naming the sheets it has.
  --georef FILE     a Recogito export (W3C Web Annotations): the IIIF Georeference Annotation
                    (from Allmaps) of a map its regions are drawn on. Each region on that map,
                    inside the georeferenced part, becomes a point, with a radius that holds the
                    whole region, citing the map and the georeference. Give it once for each
                    georeference file. Nothing is fetched.
  --manifest FILE   with --georef: the IIIF manifest of a georeferenced map, which gives the
                    size of its canvas. Give it once for each manifest file.

Reading options (check, convert and preview; each is off unless given, and is refused for an input it
does not apply to):
  --same-id         a table of places: rows with the same id are evidence about one place, each
                    row an attestation about it, rather than a repeated id being a problem.
                    Needs a column read as the place id.
  --list-places     TEI: also read each <place> of a <listPlace> that has a web address, as an
                    attestation with its first name as the edition's headword, and its
                    coordinates where the address is on the edition's own site.
  --key-pattern [PREFIX=]PATTERN
                    TEI: make the web address of a place name that has a key and no ref from
                    the key, for keys with PREFIX (what comes before the key's first ":" or ","),
                    the rest of the key replacing {id}: --key-pattern tgn=http://vocab.getty.edu/tgn/{id}.
                    With no PREFIX=, for keys with no prefix. Repeatable. The report suggests a
                    pattern for each prefix that has none.
  --header-places   TEI: convert place names in the header (where the object was found or made),
                    marked as the editors' words.
  --commentary-places
                    TEI: convert place names in an edition's commentary, translation and notes,
                    marked as the editors' words.
                    These two give the place names they convert the form status plato:Editorial.
  --no-typing       N-Triples output: leave out the node types and typed dates that the DEEP RDF
                    export adds (they are added by default, as in the browser).
  --cube            N-Triples output: also write what the RDF Data Cube vocabulary expects of
                    each figure from a statistical table: its qb:Observation type,
                    the measure as a direct statement, sdmx-dimension:refArea and refPeriod,
                    and the types of its table and structure. Without it, the plain PLATO graph.
  --candidates SET  convert --to lpf or lpf-seq: a candidate set (PLATO JSON or JSON Lines, profile
                    candidate-set) whose suggestions the dataset's region matches answer
                    (promotedFrom); repeatable. Each gvp:broaderPartitive then carries the
                    suggestion's score as whg_match_score. Without it, no score is written,
                    and each missing one is reported.
  --release NAME    publish: the name of the release being made (its address is
                    <base>release/NAME).
  --previous FILE   publish: the previous release: minting keeps its attestations' addresses,
                    and nothing it published may be missing.
  --concept-doi DOI publish: the DOI Zenodo gave to every version of the dataset.
  --maintainer NAME publish w3id: a GitHub user who maintains the namespace (repeatable).
  --repo OWNER/NAME publish: the GitHub repository the site is published from.
  --site-url URL    publish: where the site is served, if not at the base address or at the
                    repository's GitHub Pages address.
  --turtle          publish site: also write Turtle for each place and source.
  --only FILE       publish site: only the places whose keys (the last part of their addresses)
                    FILE lists, one a line; the rest are left to the downloads.
  --dataset-path P  publish site: where the dataset is in the repository, for the workflow
                    (default: its file name).
  --tools-ref REF   publish site: the commit or tag of PLATO tools the workflow runs.
  --site-dir NAME   publish site: the name of the site's folder under --out (default: the
                    dataset's name, then -site). The workflow gives one, so that it knows
                    which folder to publish.
  --work-dir DIR    where the working database for RDF, attestation-centric input and
                    spreadsheet tables is kept while it is in use (default: the system's
                    temporary directory). It needs room for about 1.2 to 1.5 times the
                    uncompressed size of the input and, with --previous, of the previous release
                    as well (twice the text, for spreadsheet tables); it is removed afterwards.
  --with INPUT      match: the other dataset, whose places are suggested.
  --threshold N     match: the lowest name score suggested, above 0 and at most 1 (default 0.85).
  --max-distance KM match: the greatest distance apart, in kilometres, of two places with
                    coordinates that may be suggested (default 50).
  --top K           match: the most suggestions for one place (default 5).
  --review FILE     apply: the work file of the review (made by match, and saved by the page).
  --candidates SET  apply: a candidate set exported from the review (by candidates, or on the
                    page), or an earlier set holding a candidate left out of it; repeatable.
                    Each answer points at its candidate (promotedFrom), and the dataset lists
                    the sets (candidateSets). An address the work file stores that is under
                    neither the set last exported from it nor a set given is refused.
  --previous-candidates SET
                    candidates: an earlier candidate set, already published; repeatable. A
                    candidate it holds is left out of the new set, and counted; the others'
                    addresses are made to differ from its. Give every earlier set the review
                    was last exported against.
  --set-iri IRI     candidates: the candidate set's address, instead of the one proposed,
                    <base>candidates/<date>-<8 hex digits of what it holds>.
                    For candidates, --base is that base (default: the folder of the address of
                    the dataset matched), and --out where the set is written.
  --output KIND     apply: what to write: dataset (the default), the dataset as a PLATO JSON
                    document with the new attestations added to its places, checked with the
                    version check; or attestations, a PLATO file of only the new attestations.
  --reviewer NAME   match, apply, lookup: who reviews, recorded as each attestation's contributor
                    (apply: default, the name in the work file; lookup: written into the work file).
  --orcid URL       match, apply, lookup: the reviewer's ORCID, as https://orcid.org/0000-0000-0000-0000.
  --others-title TEXT
                    match, apply: the other dataset's title, which each attestation cites as its
                    source (default: the title the other dataset gives; if it gives none, its
                    file's name, which is warned of). Given to match, it is kept in the work file.
  --review FILE     lookup: add to this work file (from match, or an earlier lookup) instead of
                    beginning one.
  --gazetteer G     lookup: whg (the default), or the https:// address of another W3C
                    reconciliation service. WHG's token is read from WHG_TOKEN in the
                    environment, never from the command line.
  --token-env NAME  lookup, another service: the environment variable that holds its token.
                    A token is never sent over http://, nor WHG's to another service.
  --gazetteer-iri T lookup, another service: how to make a candidate's address from its id,
                    such as https://www.wikidata.org/entity/{{id}}; without it, the service's
                    own (its manifest's view.url), and without either, a candidate whose id
                    is not an address is not suggested.
  --places WHICH    lookup: unmatched (the default: places without candidates from the other
                    dataset), all, pending (the default with --review after a lookup: not yet
                    answered), or unlinked (not yet linked to the gazetteer).
  --all-names       lookup: also send each place's other names, one query each (the label only
                    by default).
  --countries       lookup: send each place's own countries as a filter. A filter leaves out
                    every candidate outside it, the right one too if the data is wrong.
  --near KM         lookup: send each place's point and a radius of KM kilometres as a filter
                    (this sends its coordinates). The edge is approximate, and WHG then answers
                    from its upstream sources only.
  --limit N         lookup: the most candidates asked for, for each query (default 10).
  --batch N         lookup: queries in one request, 1 to 50 (default 25).
  --dry-run         lookup: say what would be sent, and the first queries exactly; send nothing.
  --json            print one JSON object per input, one per line, then one for the total.
                    Its "columns", for a table of places, is a list of {column, field, reason},
                    with pattern, level, or separator, levels and firstIsName where the field
                    has them; --columns takes the
                    object printed without --json instead. For a TEI edition, "keyPatterns"
                    holds the --key-pattern patterns, {prefix: pattern}.
  --brief           print one line per input and the total, without the details.
  -h, --help        show this help.
  -V, --version     show the version, and the PLATO commit the checks follow.

Exit status: 0 if no input has problems, 1 if any has, 2 if the command is wrong or an input
cannot be read or written. Warnings, and what a conversion cannot carry over, do not count
as problems. For preview: 0 if the records read have no problems, 1 if they have, 2 if no
preview could be made (the command is wrong, the input cannot be read, or its format is not
one a preview is made of). For compare: 0 if nothing was deleted or changed, 1 if something was, 2 if the
versions could not be compared. For match and apply: 0 if nothing stopped it, 1 if something
did (a place without an address), 2 if it could not be done. For lookup: 0 if every place
was answered, 1 if some were not or the lookup stopped (the work file still holds what was
found, to resume from), 2 if it could not be done. For candidates: 0 if the set was
written, or nothing was new to write; 2 if it could not be made.
`;

const READING_FLAGS = ['same-id', 'list-places', 'key-pattern', 'header-places', 'commentary-places'];
/**
 * The TEI reading options the flags give ({ listPlaces, headerPlaces, commentaryPlaces, keyPatterns },
 * only those given), or why they cannot be used, in words. --key-pattern is [PREFIX=]PATTERN: a
 * prefix has no ":", "," or "/" (a pattern's "https:" has), so a pattern with an "=" of its own is
 * still read whole; with no prefix, the keys with none.
 */
function readingOf(o) {
  const t = {};
  if (o['list-places']) t.listPlaces = true;
  if (o['header-places']) t.headerPlaces = true;
  if (o['commentary-places']) t.commentaryPlaces = true;
  if (o['key-pattern'].length) {
    t.keyPatterns = Object.create(null);
    for (const given of o['key-pattern']) {
      const m = /^([^=:,/]*)=(.*)$/s.exec(given);
      const [prefix, pattern] = m ? [m[1].trim(), m[2].trim()] : ['', given.trim()];
      if (Object.hasOwn(t.keyPatterns, prefix)) return `--key-pattern is given twice for ${prefix ? `the prefix "${prefix}"` : 'keys with no prefix'}; give one pattern for each.`;
      t.keyPatterns[prefix] = pattern;
    }
  }
  const refusal = teiReadingRefusal(t);
  return refusal || { tei: t, sameId: o['same-id'] };
}

/**
 * One --split, COLUMN=SEP[:LEVELS], as { column, separator, levels?, firstIsName }, or why it cannot
 * be used, in words. The column is what comes before the first "="; LEVELS, after the last ":",
 * are whole numbers separated by commas, narrowest first, with "name" first if the first part is
 * the place's own name; a SEP with a ":" of its own is read whole when what follows is not levels.
 */
function splitOf(given) {
  const m = /^([^=]+)=(.*)$/s.exec(given);
  if (!m) return `--split ${given}: give the column, an "=", and what separates its parts, such as --split 'Place=, :3,2,1'.`;
  const column = m[1];
  let separator = m[2], items;
  const at = separator.lastIndexOf(':');
  if (at >= 0 && /^\s*(name|\d+)(\s*,\s*(name|\d+))*\s*$/.test(separator.slice(at + 1))) { items = separator.slice(at + 1).split(',').map((x) => x.trim()); separator = separator.slice(0, at); }
  if (separator === '') return `--split ${given}: give what separates the parts of "${column}", such as a comma: --split '${column}=, :3,2,1'.`;
  const firstIsName = items?.[0] === 'name';
  const nums = (items || []).slice(firstIsName ? 1 : 0);
  if (nums.includes('name')) return `--split ${given}: "name" can only come first, for a first part that is the place's own name.`;
  const levels = nums.map(Number);
  if (!levels.every((l) => Number.isInteger(l) && l >= 1)) return `--split ${given}: the levels are whole numbers of 1 or more (1 is the widest).`;
  if (new Set(levels).size !== levels.length) return `--split ${given}: a level is given twice; each part goes to a level of its own.`;
  return { column, separator, ...(levels.length ? { levels } : {}), firstIsName };
}
/** The mapping a table of places is read by: --columns, with --split's columns put in (o.columnsByItem). */
const columnsFor = (item, o) => (o.columnsByItem?.has(item) ? o.columnsByItem.get(item) : o.savedColumns);

function usage(message) {
  process.stderr.write(`plato-tools: ${message}\nRun "plato-tools --help" for how to use it.\n`);
  return 2;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, allowNegative: true, strict: true,
      options: {
        to: { type: 'string' }, out: { type: 'string', default: '.' }, overwrite: { type: 'boolean', default: false },
        base: { type: 'string' }, typing: { type: 'boolean', default: true }, cube: { type: 'boolean', default: false },
        columns: { type: 'string' }, sheet: { type: 'string' }, limit: { type: 'string' }, split: { type: 'string', multiple: true, default: [] },
        clusters: { type: 'string' }, column: { type: 'string' }, method: { type: 'string' },
        'same-id': { type: 'boolean', default: false }, 'list-places': { type: 'boolean', default: false },
        'header-places': { type: 'boolean', default: false }, 'commentary-places': { type: 'boolean', default: false },
        'key-pattern': { type: 'string', multiple: true, default: [] },
        with: { type: 'string' }, threshold: { type: 'string' }, 'max-distance': { type: 'string' }, top: { type: 'string' },
        review: { type: 'string' }, output: { type: 'string' }, reviewer: { type: 'string' }, orcid: { type: 'string' },
        'others-title': { type: 'string' },
        candidates: { type: 'string', multiple: true }, 'previous-candidates': { type: 'string', multiple: true }, 'set-iri': { type: 'string' },
        georef: { type: 'string', multiple: true }, manifest: { type: 'string', multiple: true },
        gazetteer: { type: 'string' }, places: { type: 'string' }, 'all-names': { type: 'boolean', default: false }, countries: { type: 'boolean', default: false },
        near: { type: 'string' }, limit: { type: 'string' }, batch: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, token: { type: 'string' },
        'token-env': { type: 'string' }, 'gazetteer-iri': { type: 'string' },
        'work-dir': { type: 'string' }, json: { type: 'boolean', default: false }, brief: { type: 'boolean', default: false },
        release: { type: 'string' }, previous: { type: 'string' }, 'concept-doi': { type: 'string' }, maintainer: { type: 'string', multiple: true, default: [] },
        repo: { type: 'string' }, 'site-url': { type: 'string' }, turtle: { type: 'boolean', default: false },
        only: { type: 'string' }, 'dataset-path': { type: 'string' }, 'tools-ref': { type: 'string' }, 'site-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false }, version: { type: 'boolean', short: 'V', default: false },
      },
    });
  } catch (e) { return usage(e.message); }
  const { values: o, positionals } = parsed;
  if (o.token !== undefined) return usage(LOOKUP_WORDS.tokenOnCommandLine);
  if (o.help) { process.stdout.write(HELP); return 0; }
  const resources = await nodeResources();
  if (o.version) {
    const v = resources.version;
    process.stdout.write(`plato-tools ${PKG.version}, checking against PLATO ${v.versionInfo} at ${v.commit}${v.draft ? ` (${draftNote(v)})` : ''}\n`);
    return 0;
  }
  const [action, ...args] = positionals;
  if (!action) return usage('say what to do: check, convert, preview, compare, publish, match or apply.');
  // The reading options are the readers' (TEI, a table of places), for check, convert and preview only.
  const readingFlags = READING_FLAGS.filter((f) => f === 'key-pattern' ? o[f].length : o[f]);
  const reads = action === 'check' || action === 'convert' || action === 'preview';
  if (readingFlags.length && !reads) return usage(`${readingFlags.map((f) => `--${f}`).join(', ')} ${readingFlags.length === 1 ? 'is' : 'are'} for check, convert and preview.`);
  // --limit is preview's (how many records) and lookup's (how many candidates), each checked by its command.
  if (o.limit !== undefined && action !== 'preview' && action !== 'lookup') return usage('--limit is for preview and lookup.');
  if (o.limit !== undefined && action === 'preview' && !(/^\s*\d+\s*$/.test(o.limit) && Number(o.limit) >= 1)) return usage(`--limit ${o.limit}: ${PREVIEW_WORDS.limit(o.limit)}`);
  if (readingFlags.length) {
    const reading = readingOf(o);
    if (typeof reading === 'string') return usage(reading);
    o.reading = reading;
  }
  // --candidates is convert's (LPF's region matches) and apply's (what the answers point into).
  if (o.candidates && action !== 'apply' && (action !== 'convert' || (o.to !== 'lpf' && o.to !== 'lpf-seq'))) return usage('--candidates is for convert --to lpf or lpf-seq, and for apply.');
  if (action === 'cluster') return clusterCommand(args, o);
  if (o.column !== undefined || o.method !== undefined) return usage('--column and --method are for cluster.');
  if (o.clusters !== undefined && !reads) return usage('--clusters is for check, convert and preview.');
  if (action === 'datacube') return datacube(args, o);
  if (action === 'publish') return publishCommand(args, o, resources);
  if (o.sheet !== undefined && !reads) return usage('--sheet is for check, convert and preview.');
  if (o.split.length && !reads) return usage('--split is for check, convert and preview.');
  if (o.split.length) {
    o.splits = [];
    for (const given of o.split) { const sp = splitOf(given); if (typeof sp === 'string') return usage(sp); o.splits.push(sp); }
  }
  if (action === 'candidates') return candidatesCommand(args, o, resources);
  if (o['previous-candidates'] || o['set-iri']) return usage('--previous-candidates and --set-iri are for candidates.');
  if (action === 'match' || action === 'apply') return review(action, args, o, resources);
  if (action === 'lookup') return lookupCommand(args, o, resources);
  // (--limit, for lookup and preview, is refused above for any other command.)
  if (o.gazetteer || o.places || o['all-names'] || o.countries || o.near || o.batch || o['dry-run'] || o['token-env'] || o['gazetteer-iri']) return usage('--gazetteer, --token-env, --gazetteer-iri, --places, --all-names, --countries, --near, --batch and --dry-run are for lookup.');
  if (o.with || o.threshold || o['max-distance'] || o.top || o.review || o.output || o.reviewer || o.orcid || o['others-title'] !== undefined) return usage('--with, --threshold, --max-distance, --top, --review, --output, --reviewer, --orcid and --others-title are for match and apply.');
  if (!reads && action !== 'compare') return usage(`"${action}" is not a command; the commands are check, convert, preview, cluster, compare, publish, match, apply, lookup, candidates and datacube.`);
  if (!args.length) return usage(`name ${action === 'preview' ? 'the input' : 'at least one input'} to ${action}.`);
  if (action === 'preview' && o.brief) return usage('--brief is for check and convert; a preview prints its records, and --json prints them with the rest.');
  if (action === 'convert' && !o.to) return usage(`convert needs --to, one of: ${Object.keys(TARGETS).join(', ')}.`);
  if (action === 'convert' && !TARGETS[o.to]) return usage(`"${o.to}" is not a target; the targets are ${Object.keys(TARGETS).join(', ')}.`);
  if (action !== 'convert' && (o.to || o.overwrite)) return usage('--to and --overwrite are for convert.');
  if (o.json && o.brief) return usage('choose --json or --brief, not both.');
  if (o.cube && o.to !== 'ntriples') return usage('--cube is for convert --to ntriples.');
  // Candidate sets, for LPF's region matches (PLATO 1d2cf6e, #23): each must be one, or the command is wrong.
  if (o.candidates) {
    o.candidateInputs = [];
    for (const p of o.candidates) {
      try { if (!statSync(p).isFile()) return usage(`${p}, given with --candidates, is not a file.`); }
      catch (e) { if (!isSystemError(e)) throw e; return usage(`${p}, given with --candidates, cannot be read: ${e.code === 'ENOENT' ? 'there is no such file' : e.message}.`); }
      const { input, message } = await readInput({ label: p, paths: [p] });
      if (!input) return usage(`${p}, given with --candidates, is not a candidate set: ${message}`);
      if (input.profile !== 'candidate-set') return usage(`${p}, given with --candidates, is ${formatName(input)}, not a candidate set (PLATO JSON or JSON Lines with the profile candidate-set).`);
      o.candidateInputs.push(input);
    }
  }
  if (o.columns) {
    try { o.savedColumns = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(o.columns))); }
    catch (e) { return usage(`--columns ${o.columns} cannot be read as JSON: ${e.message}`); }
    if (!o.savedColumns || typeof o.savedColumns !== 'object' || Array.isArray(o.savedColumns)) return usage(`--columns ${o.columns} must hold one JSON object, {"column name": "field"}.`);
    // A matching saved with groups of spellings ({ columns, clusters }): the mapping is its columns;
    // the groups are used only when given with --clusters, never because they are in the file.
    const { columns, clusters } = splitMatching(o.savedColumns);
    o.savedColumns = columns;
    if (clusters && o.clusters === undefined) process.stderr.write(`plato-tools: ${o.columns} also holds groups of spellings; they are used only when the file is given with --clusters too.\n`);
  }
  if (o.clusters !== undefined) {
    let json;
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(o.clusters))); }
    catch (e) { return usage(`--clusters ${o.clusters} cannot be read as JSON: ${e.message}`); }
    try { o.savedClusters = checkClusters(clustersInFile(json)); } catch (e) { if (e?.name !== 'DataError') throw e; return usage(`--clusters ${o.clusters}: ${e.message}`); }
  }
  // Georeferenced regions: the files are opened once and given to each input, which must be a
  // Recogito export; anything else is a mistake in the command, not in the data.
  if (o.georef || o.manifest) {
    if (action === 'compare') return usage('--georef and --manifest are for check and convert.');
    if (!o.georef) return usage('--manifest is for the manifest of a map given with --georef; give the georeference too.');
    for (const p of [...o.georef, ...(o.manifest || [])]) {
      try { if (!statSync(p).isFile()) return usage(`${p}, given with --georef or --manifest, is not a file.`); }
      catch (e) { if (!isSystemError(e)) throw e; return usage(`${p}, given with --georef or --manifest, cannot be read: ${e.code === 'ENOENT' ? 'there is no such file' : e.message}.`); }
    }
    o.georefFiles = await openFiles(o.georef); o.manifestFiles = await openFiles(o.manifest || []);
    for (const item of await gatherInputs(args)) {
      const { input } = await readInput(item);
      if (input && input.format !== 'w3c-annotations') return usage(`--georef and --manifest are for a Recogito export (W3C Web Annotations), and ${item.label} is ${formatName(input)}.`);
    }
  }

  const host = new NodeHost({ workDir: o['work-dir'], outDir: o.out, overwrite: o.overwrite });
  const stop = (signal) => {
    const removed = host.abandon();
    process.stderr.write(`\nplato-tools: stopped (${signal}); the working files${removed.length ? `, and the incomplete ${removed.join(', ')},` : ''} are removed.\n`);
    process.exit(130);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  // Output piped into something that stops reading (head, say): stop too, and tidy up.
  process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; host.cleanup(); process.exit(process.exitCode ?? 0); });
  const out = (s) => process.stdout.write(s);
  const live = process.stderr.isTTY && !o.json;
  const results = [];
  if (action === 'compare') {
    const items = await gatherInputs(args);
    if (items.length !== 2) return usage(`compare takes two inputs, the earlier version and then the later one; ${items.length} ${items.length === 1 ? 'was' : 'were'} given.`);
    let r;
    try { r = await compareTwo(items, o, resources, host, live); } finally { host.cleanup(); }
    r.exitCode = r.status === 'failed' ? 2 : r.status === 'problems' ? 1 : 0;
    out(o.json ? JSON.stringify(r) + '\n' : describeComparison(r, o.brief));
    return r.exitCode;
  }
  const items = await gatherInputs(args);
  // A reading option that applies to none of the inputs, or that one cannot take, is a mistake in
  // the command: each input is looked at first (and not again).
  const seen = new Map();
  // --sheet: for a workbook read as a table of places, and a sheet it has; anything else is a mistake in the command.
  if (o.sheet !== undefined) {
    for (const item of items) if (!seen.has(item)) seen.set(item, await readInput(item));
    const books = [...seen].filter(([, x]) => x.input?.format === 'csv' && x.input.container === 'workbook');
    if (!books.length) return usage('--sheet is for a workbook (.xlsx or .ods) read as a table of places, and no input is one.');
    for (const [item, { input }] of books) {
      try { withSheet(input, o.sheet); } catch (e) { if (e?.name !== 'DataError') throw e; return usage(`${item.label}: ${e.message}`); }
    }
  }
  // --split: for a table of places with that column; the mapping each such input is then read by.
  if (o.splits) {
    for (const item of items) if (!seen.has(item)) seen.set(item, await readInput(item));
    o.columnsByItem = new Map();
    for (const [item, { input }] of seen) {
      if (input?.format !== 'csv' && input?.format !== 'geojson') continue;
      let m;
      try { m = await mappingOf(input, o.savedColumns, input.container === 'workbook' ? o.sheet : undefined); } catch (e) { if (e?.name !== 'DataError') throw e; continue; /* the run reports what stops the reader */ }
      const given = o.savedColumns ? { ...o.savedColumns } : mappingToSave(m.mapping, m.patterns, m.levels, m.splits);
      for (const sp of o.splits) {
        if (!m.headers.includes(sp.column)) return usage(`--split names the column "${sp.column}", which ${item.label} does not have; its columns are ${m.headers.map((h) => `"${h}"`).join(', ')}.`);
        given[sp.column] = { field: 'split', separator: sp.separator, ...(sp.levels ? { levels: sp.levels } : {}), firstIsName: sp.firstIsName };
      }
      o.columnsByItem.set(item, given);
    }
    if (!o.columnsByItem.size) return usage('--split is for a table of places (CSV, GeoJSON or a sheet of a workbook), and no input is one.');
  }
  if (readingFlags.length) {
    for (const item of items) if (!seen.has(item)) seen.set(item, await readInput(item));
    const formats = new Set([...seen.values()].map((x) => x.input?.format).filter(Boolean));
    const tables = formats.has('csv') || formats.has('geojson');
    for (const f of readingFlags) {
      if (f === 'same-id' && !tables) return usage('--same-id is for a table of places (CSV or GeoJSON), and no input is one.');
      if (f !== 'same-id' && !formats.has('tei')) return usage(`--${f} is for TEI, and no input is a TEI edition.`);
    }
    if (o['same-id']) {
      for (const [item, { input }] of seen) {
        if (input?.format !== 'csv' && input?.format !== 'geojson') continue;
        let m;
        try { m = await mappingOf(input, columnsFor(item, o), input.container === 'workbook' ? o.sheet : undefined); } catch (e) { if (e?.name !== 'DataError') throw e; continue; /* the run reports what stops the reader */ }
        if (!Object.values(m.mapping).includes('id')) return usage(`--same-id reads rows with the same id as one place, but no column of ${item.label} is read as the place id; map one to "id" with --columns.`);
      }
    }
  }
  // A preview writes nothing, and needs no working files: it is made here, on its own.
  if (action === 'preview') return previewCommand(items, o, resources, seen);
  try {
    for (const item of items) {
      const r = await runOne(item, action, o, resources, host, live, seen.get(item));
      results.push(r);
      out(o.json ? JSON.stringify(r) + '\n' : describe(r, action, o.brief));
    }
  } finally { host.cleanup(); }

  const total = {
    type: 'total', action, target: action === 'convert' ? o.to : null, inputs: results.length,
    ok: results.filter((r) => r.status === 'ok').length, problems: results.filter((r) => r.status === 'problems').length,
    failed: results.filter((r) => r.status === 'failed').length, errors: results.reduce((n, r) => n + (r.errors || 0), 0),
    outputs: results.reduce((n, r) => n + r.outputs.length, 0), outputBytes: results.reduce((n, r) => n + r.outputs.reduce((m, x) => m + x.size, 0), 0),
  };
  total.exitCode = total.failed ? 2 : total.problems ? 1 : 0;
  out(o.json ? JSON.stringify(total) + '\n' : describeTotal(total));
  return total.exitCode;
}

/** A thrown error that is not the data's: said to be the tools' fault, with where it happened. */
function toolsFault(e) {
  const where = String(e && e.stack || '').split('\n').find((l) => /\/src\//.test(l))?.trim().replace(/^at\s+/, '') || '';
  return `PLATO tools failed on this input, which is a fault in the tools, not in the data: ${e && e.message || e}${where ? ` (${where})` : ''}. Please report it at https://github.com/pelagios/plato-tools/issues.`;
}

/** Open one input and find what it is: { input }, or { message } saying why it cannot be read. */
async function readInput(item) {
  if (item.failure) return { message: item.failure };
  let input;
  try { input = await detect(await openFiles(item.paths)); }
  catch (e) {
    if (isSystemError(e)) return { message: e.message };
    // Detection turns what the data does wrong into a reason itself; anything thrown is the tools' own fault.
    return { message: toolsFault(e) };
  }
  return readable(input) ? { input } : { message: input.reason };
}

/** Compare two versions, and say how it went, as an object that --json prints as it is. */
async function compareTwo(items, o, resources, host, live) {
  const t0 = Date.now();
  const r = { type: 'comparison', earlier: null, later: null, status: 'failed', errors: 0, counts: {}, items: [], elapsedMs: 0 };
  const inputs = [];
  for (const [word, item] of [['earlier', items[0]], ['later', items[1]]]) {
    r[word] = { input: item.label, files: item.paths, format: null, profile: null };
    const { input, message } = await readInput(item);
    if (!input) { r.message = `${item.label}: ${message}`; r.elapsedMs = Date.now() - t0; return r; }
    Object.assign(r[word], { format: input.format, profile: input.profile || null });
    inputs.push(input);
  }
  const progress = live ? (p) => process.stderr.write(`\r\x1b[K${progressText(p)}`) : undefined;
  const xlsx = inputs.some((i) => i.container === 'workbook') ? await import('xlsx') : undefined;
  const { env, finish } = host.env(resources, { progress, xlsx });
  let result = null, failure = null;
  try { result = await compare({ earlier: inputs[0], later: inputs[1], options: { base: o.base } }, env); }
  catch (e) { failure = e; }
  if (live) process.stderr.write('\r\x1b[K');
  finish(true);
  r.elapsedMs = Date.now() - t0;
  if (failure) { r.message = isSystemError(failure) ? failure.message : toolsFault(failure); return r; }
  // A version that could not be read to the end was not compared: that is a failure to compare, not a
  // finding about the rule, though the report says what stopped the reader.
  Object.assign(r, { status: result.incomplete ? 'failed' : result.report.errors ? 'problems' : 'ok', errors: result.report.errors, counts: result.report.counts, items: result.report.items });
  return r;
}
function describeComparison(r, brief) {
  const side = (word, s) => `${word} ${s.input}${s.format ? `: ${formatName(s)}` : ''}\n`;
  const lines = [(side('Earlier:', r.earlier) + (r.later ? side('Later:  ', r.later) : '')).replace(/\n$/, '')];
  if (r.message) lines.push(`  Could not be compared: ${r.message}`);
  else {
    const { problems, counted } = summary({ errors: r.errors, counts: r.counts }, 'compare');
    lines.push(`  ${problems}${counted ? ' ' + counted : ''} (${fmtTime(r.elapsedMs)})`);
    if (!brief) lines.push(...itemLines(r.items, 'compare'));
  }
  return lines.join('\n') + '\n';
}
/** Agora: one part of publishing, for one dataset. Exit 0 with no problems, 1 with problems, 2 if it could not be done. */
async function publishCommand(args, o, resources) {
  const [part, ...rest] = args;
  if (!part || !PUBLISH_PARTS[part]) return usage(`publish needs a part: ${Object.keys(PUBLISH_PARTS).join(', ')}.`);
  if (o.to || o.cube) return usage('--to and --cube are for convert.');
  if (o.json && o.brief) return usage('choose --json or --brief, not both.');
  const items = await gatherInputs(rest);
  if (items.length !== 1) return usage(`publish ${part} takes one dataset; ${items.length} ${items.length === 1 ? 'was' : 'were'} given.`);
  const host = new NodeHost({ workDir: o['work-dir'], outDir: o.out, overwrite: o.overwrite });
  const stop = (signal) => { const removed = host.abandon(); process.stderr.write(`\nplato-tools: stopped (${signal})${removed.length ? `; the incomplete ${removed.length === 1 ? 'file is' : 'files are'} removed` : ''}.\n`); process.exit(130); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const live = process.stderr.isTTY && !o.json;
  const t0 = Date.now();
  const r = { type: 'publish', part, input: items[0].label, files: items[0].paths, format: null, status: 'failed', errors: 0, counts: {}, items: [], outputs: [], elapsedMs: 0 };
  try {
    const { input, message } = await readInput(items[0]);
    if (!input) { r.message = message; return finishPublish(r, o, t0); }
    r.format = input.format; r.profile = input.profile || null;
    let previous;
    if (o.previous) {
      const [p] = await gatherInputs([o.previous]);
      const got = await readInput(p);
      if (!got.input) { r.message = `${o.previous}: ${got.message}`; return finishPublish(r, o, t0); }
      previous = got.input;
    }
    const progress = live ? (p) => process.stderr.write(`\r\x1b[K${progressText(p)}`) : undefined;
    const xlsx = [input, previous].some((i) => i?.container === 'workbook') ? await import('xlsx') : undefined;
    const { env, finish } = host.env(resources, { progress, xlsx });
    let result = null, failure = null;
    let only;
    if (o.only) {
      try { only = readFileSync(o.only, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); }
      catch (e) { r.message = `--only ${o.only}: ${e.code === 'ENOENT' ? 'there is no such file.' : e.message}`; return finishPublish(r, o, t0); }
    }
    const options = { base: o.base, release: o.release, conceptDoi: o['concept-doi'], maintainers: o.maintainer, repo: o.repo, siteUrl: o['site-url'], turtle: o.turtle, name: items[0].name,
      only, datasetPath: o['dataset-path'], toolsRef: o['tools-ref'], siteDir: o['site-dir'],
      // The commit these tools are, for the site's workflow to run the same (--tools-ref overrides).
      toolsCommit: part === 'site' && !o['tools-ref'] ? toolsCommit()?.commit : undefined };
    try { result = await publish({ part, input, previous, options }, env); } catch (e) { failure = e; }
    if (live) process.stderr.write('\r\x1b[K');
    const done = finish(!!failure || !!result?.incomplete);
    if (failure) {
      r.message = isSystemError(failure) ? (failure.code === 'EEXIST' ? `${failure.path} already exists; give --overwrite to replace it, or --out for somewhere else.` : failure.message) : toolsFault(failure);
      if (done.removed.length) r.message += ` Nothing was written: the incomplete ${done.removed.length === 1 ? 'file was' : 'files were'} removed.`;
      return finishPublish(r, o, t0);
    }
    Object.assign(r, { status: result.incomplete ? 'failed' : result.report.errors ? 'problems' : 'ok', errors: result.report.errors, counts: result.report.counts, items: result.report.items,
      outputs: result.outputs.map(({ name, path, size, files }) => ({ path: path || name, size, files })) });
    // Stopped part-way (a dataset that could not be read to the end): what it had begun is removed.
    if (result.incomplete) {
      r.outputs = [];
      r.message = (result.report.items.find((i) => i.severity === 'error')?.message || 'It could not be finished.') + (done.removed.length ? ` Nothing was written: the incomplete ${done.removed.length === 1 ? 'file was' : 'files were'} removed.` : '');
    }
    return finishPublish(r, o, t0);
  } finally { host.cleanup(); }
}
function finishPublish(r, o, t0) {
  r.elapsedMs = Date.now() - t0;
  r.exitCode = r.status === 'failed' ? 2 : r.status === 'problems' ? 1 : 0;
  if (o.json) { process.stdout.write(JSON.stringify(r) + '\n'); return r.exitCode; }
  const lines = [`${r.input}${r.format ? `: ${formatName(r)}` : ''} (${fmtTime(r.elapsedMs)})`];
  if (r.status === 'failed' && r.message) lines.push(`  Could not be done: ${r.message}`);
  else {
    const { problems, counted } = summary({ errors: r.errors, counts: r.counts }, 'publish');
    lines.push(`  ${problems}${counted ? ' ' + counted : ''}`);
    if (!o.brief) lines.push(...itemLines(r.items, 'publish'));
    for (const x of r.outputs) lines.push(`  Wrote ${x.path}${x.files ? ` (${x.files.toLocaleString('en-GB')} files, ${fmtBytes(x.size)})` : ` (${fmtBytes(x.size)})`}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  return r.exitCode;
}

/** A report's findings, group by group, as the lines the terminal shows. */
function itemLines(all, action) {
  const lines = [];
  for (const g of groups(action)) {
    const items = all.filter((i) => i.severity === g.severity);
    if (!items.length) continue;
    lines.push(`  ${g.title}. ${g.intro}`);
    for (const i of items) {
      lines.push(`    × ${i.count.toLocaleString('en-GB')}  ${i.message}`);
      for (const e of i.examples) {
        lines.push(`        ${String(e)}`);
        // The version check says what changed in an example: the statements only one version makes.
        for (const x of (i.explained || []).filter((x) => x.example === e)) for (const l of explainedLines(x)) lines.push(`            ${l}`);
      }
    }
  }
  return lines;
}

/**
 * Hermes: the preview of one input's first records (src/engine/hermes/preview.js). The records go to
 * stdout as JSON Lines, and what the preview is, why it is partial, and the losses so far to stderr;
 * with --json, one object to stdout. Exit 0 when the records read have no problems, 1 when they have,
 * 2 when no preview could be made.
 */
async function previewCommand(items, o, resources, seen) {
  if (items.length !== 1) return usage(`preview takes one input; ${items.length} were given.`);
  const [item] = items;
  const limit = o.limit === undefined ? PREVIEW_LIMIT : Number(o.limit);
  const r = { type: 'preview', input: item.label, files: item.paths, format: null, profile: null, status: 'failed', errors: 0 };
  const failed = (message) => {
    r.message = message; r.exitCode = 2;
    if (o.json) process.stdout.write(JSON.stringify(r) + '\n');
    else process.stderr.write(`${item.label}: no preview could be made: ${message}\n`);
    return 2;
  };
  const { input, message } = seen.get(item) || await readInput(item);
  if (!input) return failed(message);
  r.format = input.format;
  const refusal = previewRefusal(input);
  if (refusal) return failed(refusal);
  const table = input.format === 'csv' || input.format === 'geojson';
  if (!table && o.savedClusters) process.stderr.write(clustersUnused(item.label, input));
  const reading = input.format === 'tei' ? { ...o.reading?.tei } : table && o.reading?.sameId ? { sameId: true } : {};
  if (input.container === 'workbook' && input.format === 'csv') { r.sheet = o.sheet ?? input.sheet ?? null; r.sheets = input.sheets.map((s) => s.name); }
  if (o.georefFiles) { input.georefs = o.georefFiles; input.manifests = o.manifestFiles; }
  const xlsx = input.container === 'workbook' ? await import('xlsx') : undefined;
  let result;
  try { result = await preview({ input, options: { base: o.base, columns: columnsFor(item, o), ...(table && o.savedClusters ? { clusters: o.savedClusters } : {}), ...(o.sheet !== undefined ? { sheet: o.sheet } : {}), ...reading }, limit }, { resources, xlsx }); }
  catch (e) {
    if (e?.name === 'DataError' || isSystemError(e)) return failed(e.message);
    return failed(toolsFault(e));
  }
  Object.assign(r, { profile: result.profile, status: result.report.errors ? 'problems' : 'ok', errors: result.report.errors, line: previewLine(result), complete: result.complete,
    total: result.total, read: result.read, why: result.why, header: result.header, items: result.items, report: result.report });
  r.exitCode = r.status === 'problems' ? 1 : 0;
  if (o.json) { process.stdout.write(JSON.stringify(r) + '\n'); return r.exitCode; }
  for (const ev of result.items) process.stdout.write(JSON.stringify(ev.value) + '\n');
  const lines = [`${item.label}: ${formatName({ ...input, profile: null })} (${result.profile}): ${r.line}`];
  if (r.why) lines.push(`  ${r.why}`);
  lines.push(`  ${PREVIEW_WORDS.losses}:`);
  // The notice that the preview is partial is the line above (its why): not said twice.
  const found = itemLines(result.report.items.filter((i) => i.kind !== 'preview-partial'), 'check');
  lines.push(...(found.length ? found : [`    ${PREVIEW_WORDS.noLosses}`]));
  process.stderr.write(lines.join('\n') + '\n');
  return r.exitCode;
}

/**
 * plato-tools cluster: the groups of similar spellings in one column of one table of places, as one
 * JSON object on stdout ({ input, column, method, values, distinct, clusters }), for review. Nothing
 * is applied, and nothing is written.
 */
async function clusterCommand(args, o) {
  if (!o.column) return usage('cluster needs --column, the column whose spellings to group.');
  const method = o.method ?? DEFAULT_METHOD;
  if (!CLUSTER_METHODS.includes(method)) return usage(`--method ${method}: the ways of grouping are ${CLUSTER_METHODS.join(', ')}.`);
  if (o.clusters !== undefined || o.to || o.columns) return usage('cluster takes --column, --method and --sheet only; it applies nothing.');
  const items = await gatherInputs(args);
  if (items.length !== 1) return usage(`cluster takes one table of places; ${items.length} ${items.length === 1 ? 'was' : 'were'} given.`);
  const { input, message } = await readInput(items[0]);
  if (!input) return usage(`${items[0].label}: ${message}`);
  if (input.format !== 'csv' && input.format !== 'geojson') return usage(`cluster is for a table of places (CSV, plain GeoJSON, a sheet of a workbook), and ${items[0].label} is ${formatName(input)}.`);
  let sheetInput = input;
  try { sheetInput = withSheet(input, o.sheet); } catch (e) { if (e?.name !== 'DataError') throw e; return usage(`${items[0].label}: ${e.message}`); }
  const counter = clusterCounter({ method });
  let values = 0;
  try { for await (const v of columnValues(sheetInput, o.column)) { values++; counter.add(v); } }
  catch (e) { if (e?.name !== 'DataError') throw e; return usage(`${items[0].label}: ${e.message}`); }
  const clusters = counter.clusters();
  process.stdout.write(JSON.stringify({ input: items[0].label, column: o.column, method, values, distinct: counter.distinct, clusters }, null, 2) + '\n');
  return 0;
}

/** The line said when groups of spellings (--clusters) are given for an input that is not a table of places, which they cannot apply to. */
const clustersUnused = (label, input) => `plato-tools: ${label} is ${formatName(input)}, not a table of places; the groups of spellings given with --clusters are not used for it.\n`;

/** Check or convert one input, and say how it went, as an object that --json prints as it is. */
async function runOne(item, action, o, resources, host, live, seen) {
  const t0 = Date.now();
  const r = { type: 'input', input: item.label, files: item.paths, format: null, profile: null, action, target: action === 'convert' ? o.to : null,
    status: 'failed', errors: 0, counts: {}, items: [], outputs: [], storeBytes: null, elapsedMs: 0 };
  const { input, message } = seen || await readInput(item);
  if (!input) { r.message = message; r.elapsedMs = Date.now() - t0; return r; }
  r.format = input.format; r.profile = input.profile || null;
  if (input.lpfVersion) r.lpfVersion = input.lpfVersion;
  // The reading options that apply to this input: a TEI edition's, or a table of places'.
  const table = input.format === 'csv' || input.format === 'geojson';
  if (!table && o.savedClusters) process.stderr.write(clustersUnused(item.label, input));
  const reading = input.format === 'tei' ? { ...o.reading?.tei } : table && o.reading?.sameId ? { sameId: true } : {};
  if (input.format === 'tei' && reading.keyPatterns) r.keyPatterns = { ...reading.keyPatterns };
  // A workbook read as a table of places: the sheet given, else the one detection chose, named with the columns.
  if (input.container === 'workbook' && input.format === 'csv') {
    if (o.sheet !== undefined) input.sheet = o.sheet;
    r.container = 'workbook'; r.sheet = input.sheet ?? null; r.sheets = input.sheets.map((s) => s.name);
  }
  if (o.georefFiles) { input.georefs = o.georefFiles; input.manifests = o.manifestFiles; r.georefs = o.georef; r.manifests = o.manifest || []; }
  // A table of places: the columns as they are read (the mapping given with --columns, else the
  // guess), printed with the report so that it can be saved, edited and given back.
  if (input.format === 'csv' || input.format === 'geojson') {
    try {
      const m = await mappingOf(input, columnsFor(item, o));
      // In the file's order: an object would put a column whose heading is a number first. A column
      // made into web addresses through a pattern has it beside its field; a region its level; a
      // split its separator, levels and firstIsName.
      const saved = mappingToSave(m.mapping, m.patterns, m.levels, m.splits);
      r.columns = m.headers.map((column) => ({ column, field: m.mapping[column], ...(typeof saved[column] === 'object' ? (({ field, ...rest }) => rest)(saved[column]) : {}), reason: m.reasons[column] }));
      r.columnWarnings = gazetteerWarnings(m.mapping, m.gazetteer, { cli: true, suggested: m.suggested, patterns: m.patterns });
      const fields = Object.values(m.mapping);
      r.profile = fields.includes('address') || (reading.sameId && fields.includes('id')) ? 'attestation-centric' : 'place-centric';
    } catch (e) { if (e?.name !== 'DataError') throw e; /* the run reports what stops the reader */ }
  }
  const progress = live ? (p) => process.stderr.write(`\r\x1b[K${item.label}: ${progressText(p)}`) : undefined;
  const xlsx = input.container === 'workbook' ? await import('xlsx') : undefined;
  const { env, finish } = host.env(resources, { progress, xlsx });
  let result = null, failure = null;
  try { result = await run({ input, action, target: r.target, options: { base: o.base, typing: o.typing, cube: o.cube, name: input.format === 'csv' ? undefined : item.name, columns: columnsFor(item, o), ...(table && o.savedClusters ? { clusters: o.savedClusters } : {}), candidates: o.candidateInputs, ...reading } }, env); }
  catch (e) { failure = e; }
  if (live) process.stderr.write('\r\x1b[K');
  // A file the engine could not read to the end comes back as a report marked incomplete; any
  // output it had begun is removed, as after a failure.
  const done = finish(!!failure || !!result?.incomplete);
  r.storeBytes = done.storeBytes;
  r.elapsedMs = Date.now() - t0;
  if (failure && isSystemError(failure)) {
    r.message = failure.code === 'EEXIST' ? `${failure.path} already exists; give --overwrite to replace it, or --out for somewhere else.` : failure.message;
    return r;
  }
  if (failure) {
    // The engine turns a file that stops its reader (a DataError) into a report of its own, so what
    // reaches here is a fault in the tools, not in the data: it must not be presented as a problem in
    // the file. The input has failed, the exit status says so, and the error is shown as it is.
    r.message = toolsFault(failure) + (done.removed.length ? ` Nothing was written: ${done.removed.join(', ')} was removed, being incomplete.` : '');
    return r;
  }
  Object.assign(r, { status: result.report.errors ? 'problems' : 'ok', errors: result.report.errors, counts: result.report.counts, items: result.report.items,
    outputs: result.outputs.map(({ path, size }) => ({ path, size })) });
  if (result.incomplete && done.removed.length) r.message = `Nothing was written: ${done.removed.join(', ')} was removed, being incomplete.`;
  return r;
}

function describe(r, action, brief) {
  const head = `${r.input}${r.format ? `: ${formatName(r)}` : ''}${r.status !== 'failed' ? ` (${fmtTime(r.elapsedMs)})` : ''}\n`;
  if (r.status === 'failed') return `${head}  Could not be ${action === 'check' ? 'checked' : 'converted'}: ${r.message}\n${brief ? '' : '\n'}`;
  const { problems, counted } = summary({ errors: r.errors, counts: r.counts });
  const lines = [head + `  ${problems}${counted ? ' ' + counted : ''}`];
  if (!brief && r.columns) lines.push(...columnLines(r));
  if (!brief && r.keyPatterns) lines.push('  Keys made into web addresses with the patterns given:', ...Object.entries(r.keyPatterns).map(([prefix, pattern]) => `    ${prefix ? `"${prefix}"` : '(no prefix)'}  ${pattern}`));
  if (!brief) lines.push(...itemLines(r.items, action));
  if (r.message) lines.push(`  ${r.message}`);
  for (const x of r.outputs) lines.push(`  Wrote ${x.path} (${fmtBytes(x.size)})`);
  return lines.join('\n') + (brief ? '\n' : '\n\n');
}
/** How a table of places' columns were read: one line each, with why, then the whole as JSON for --columns. */
function columnLines(r) {
  const w = Math.min(24, Math.max(...r.columns.map((c) => c.column.length)));
  return [
    `  Columns${r.sheet ? ` of the sheet ${JSON.stringify(r.sheet)}` : ''} read as (to change this, save the JSON below to a file, edit it, and give it with --columns FILE${r.sheets?.length > 1 ? '; another sheet with --sheet NAME' : ''}):`,
    ...r.columns.map((c) => `    ${c.column.padEnd(w)}  ${c.field.padEnd(16)}  ${c.reason || ''}`),
    // The mapping as --columns takes it, written in the file's order, a pattern column in its object form.
    `    {${r.columns.map((c) => { const { column, field, reason, ...rest } = c; return `${JSON.stringify(column)}:${JSON.stringify(Object.keys(rest).length ? { field, ...rest } : field)}`; }).join(',')}}`,
    ...(r.columnWarnings || []).map((w) => `  Note: ${w}`),
  ];
}
function describeTotal(t) {
  const n = (k, one, many = one + 's') => `${k.toLocaleString('en-GB')} ${k === 1 ? one : many}`;
  const parts = [`${n(t.ok, 'without problems', 'without problems')}`, `${t.problems.toLocaleString('en-GB')} with problems${t.errors ? ` (${n(t.errors, 'problem')} in all)` : ''}`];
  if (t.failed) parts.push(`${t.failed.toLocaleString('en-GB')} could not be ${t.action === 'check' ? 'checked' : 'converted'}`);
  const wrote = t.action === 'convert' ? ` Wrote ${n(t.outputs, 'file')} (${fmtBytes(t.outputBytes)}).` : '';
  return `${t.action === 'check' ? 'Checked' : 'Converted'} ${n(t.inputs, 'input')}: ${parts.join(', ')}.${wrote}\n`;
}

process.exitCode = await main(process.argv.slice(2));

/** --reviewer and --orcid as a PLATO contributor ({ reviewer }, null when not given), or the { problem } with them. */
function reviewerOption(o) {
  const reviewer = o.reviewer ? { name: o.reviewer, ...(o.orcid ? { orcid: o.orcid } : {}) } : null;
  if (o.orcid && !o.reviewer) return { problem: '--orcid needs --reviewer, the name it belongs to.' };
  if (o.orcid && !/^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/.test(o.orcid)) return { problem: 'give the ORCID in full, as https://orcid.org/0000-0000-0000-0000.' };
  // The reviewer is checked by the engine's own rule, so that what it would refuse is a mistake in the command, not a fault in the tools.
  if (reviewer) { try { checkReviewer(reviewer, '--reviewer'); } catch (e) { return { problem: e.message.replace(/^--reviewer must have a name\.$/, '--reviewer must give a name.') }; } }
  return { reviewer };
}

// Krisis: matching. `match` suggests places of one dataset that may be the same as places of another,
// and writes the suggestions to a work file for review (on the page); `apply` makes the decisions of
// a review into PLATO attestations (src/engine/krisis/).
async function review(action, args, o, resources) {
  if (o.to) return usage('--to is for convert.');
  if (o.json && o.brief) return usage('choose --json or --brief, not both.');
  const { reviewer, problem } = reviewerOption(o);
  if (problem) return usage(problem);
  if (o['others-title'] !== undefined && !o['others-title'].trim()) return usage('--others-title must give a title.');
  // A table of places to match is read by the mapping of its columns given, as check and convert read it; apply, else, by the review's.
  let columns;
  if (o.columns) {
    try { columns = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(o.columns))); }
    catch (e) { return usage(`--columns ${o.columns} cannot be read as JSON: ${e.message}`); }
    columns = splitMatching(columns).columns;   // a matching saved with groups of spellings: its mapping
    if (!isColumns(columns)) return usage(`--columns ${o.columns} must hold one JSON object, {"column name": "field"}, each column given the name of a field.`);
  }
  const items = await gatherInputs(args);
  if (items.length !== 1) return usage(`${action} takes one dataset of places to match; ${items.length} ${items.length === 1 ? 'was' : 'were'} given.`);
  let others = null, work = null, options;
  if (action === 'match') {
    if (o.review || o.output) return usage('--review and --output are for apply.');
    if (!o.with) return usage('match needs --with, the other dataset.');
    others = await gatherInputs([o.with]);
    if (others.length !== 1) return usage('--with takes one dataset.');
    options = { threshold: o.threshold, maxDistanceKm: o['max-distance'], topK: o.top, base: o.base, name: items[0].name, reviewer, othersTitle: o['others-title'], columns };
    for (const [flag, v, ok] of [['--threshold', o.threshold, (x) => x > 0 && x <= 1], ['--max-distance', o['max-distance'], (x) => x >= 0], ['--top', o.top, (x) => Number.isInteger(x) && x >= 1]])
      if (v !== undefined && !(/^\s*[\d.]+\s*$/.test(v) && ok(Number(v)))) return usage(`${flag} ${v} is not allowed; see --help.`);
  } else {
    if (o.with || o.threshold || o['max-distance'] || o.top) return usage('--with, --threshold, --max-distance and --top are for match.');
    if (!o.review) return usage('apply needs --review, the work file of the review.');
    if (o.output && !REVIEW_OUTPUTS.includes(o.output)) return usage(`"${o.output}" is not an output; the outputs are ${REVIEW_OUTPUTS.join(' and ')}.`);
    try { work = readFileSync(o.review, 'utf8'); }
    catch (e) { return usage(`the work file ${o.review} cannot be read: ${e.code === 'ENOENT' ? 'there is no such file.' : e.message}`); }
    options = { output: o.output || 'dataset', reviewer: reviewer || undefined, name: items[0].name, base: o.base, othersTitle: o['others-title'], columns };
    // Krisis: the candidate sets the answers point into (promotedFrom), read as text; apply checks them.
    if (o.candidates) {
      options.candidates = [];
      for (const f of o.candidates) {
        try { options.candidates.push(readFileSync(f, 'utf8')); }
        catch (e) { return usage(`the candidate set ${f} cannot be read: ${e.code === 'ENOENT' ? 'there is no such file.' : e.message}`); }
      }
    }
  }
  const host = new NodeHost({ workDir: o['work-dir'], outDir: o.out, overwrite: o.overwrite });
  process.once('SIGINT', () => { host.abandon(); process.exit(130); });
  const t0 = Date.now();
  const r = { type: action, subjects: { input: items[0].label, format: null, profile: null }, status: 'failed', errors: 0, counts: {}, items: [], outputs: [], elapsedMs: 0 };
  if (others) r.others = { input: others[0].label, format: null, profile: null };
  const inputs = {};
  for (const [key, item] of [['subjects', items[0]], ...(others ? [['others', others[0]]] : [])]) {
    const { input, message } = await readInput(item);
    if (!input) { r.message = `${item.label}: ${message}`; break; }
    Object.assign(r[key], { format: input.format, profile: input.profile || null });
    inputs[key] = input;
  }
  if (!r.message) {
    const live = process.stderr.isTTY && !o.json;
    const progress = live ? (p) => process.stderr.write(`\r\x1b[K${progressText(p)}`) : undefined;
    const xlsx = Object.values(inputs).some((i) => i.container === 'workbook') ? await import('xlsx') : undefined;
    const { env, finish } = host.env(resources, { progress, xlsx });
    let result = null, failure = null;
    try { result = action === 'match' ? await match({ subjects: inputs.subjects, others: inputs.others, options }, env) : await apply({ subjects: inputs.subjects, work, options }, env); }
    catch (e) { failure = e; }
    if (live) process.stderr.write('\r\x1b[K');
    finish(!!failure || !!result?.incomplete);
    if (failure) r.message = isSystemError(failure) ? (failure.code === 'EEXIST' ? `${failure.path} already exists; give --overwrite to replace it, or --out for somewhere else.` : failure.message) : failure instanceof DataError ? failure.message : toolsFault(failure);
    else Object.assign(r, { status: result.incomplete ? 'failed' : result.report.errors ? 'problems' : 'ok', errors: result.report.errors, counts: result.report.counts, items: result.report.items,
      outputs: result.outputs.map(({ path, size }) => ({ path, size })) });
  }
  host.cleanup();
  r.elapsedMs = Date.now() - t0;
  r.exitCode = r.status === 'failed' ? 2 : r.status === 'problems' ? 1 : 0;
  if (o.json) process.stdout.write(JSON.stringify(r) + '\n');
  else {
    const side = (word, s) => `${word} ${s.input}${s.format ? `: ${formatName(s)}` : ''}`;
    const lines = [side('Places to match:', r.subjects)];
    if (r.others) lines.push(side('Other dataset:  ', r.others));
    if (r.message && r.status === 'failed' && !r.items.length) lines.push(`  Could not be done: ${r.message}`);
    else {
      const { problems, counted } = summary({ errors: r.errors, counts: r.counts }, action);
      lines.push(`  ${problems}${counted ? ' ' + counted : ''} (${fmtTime(r.elapsedMs)})`);
      if (!o.brief) lines.push(...itemLines(r.items, action));
    }
    for (const x of r.outputs) lines.push(`  Wrote ${x.path} (${fmtBytes(x.size)})`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  return r.exitCode;
}

/**
 * Check cube exports against the Data Cube integrity constraints. Each file is read as a stream,
 * but its graph is held in memory to be checked, so a cube larger than memory cannot be. Exit 0 when every constraint passed, 1 when any failed or had nothing to
 * evaluate (a constraint over nothing is not tested, never passed), 2 when a file cannot be read.
 */
async function datacube(files, o) {
  if (!files.length) return usage('name at least one N-Triples cube export to check.');
  const { integrityOfFile } = await import('../src/lib/datacube.js');
  const { openFiles } = await import('../src/node/host.js');
  let code = 0;
  for (const path of files) {
    let results;
    try { const [f] = await openFiles([path]); results = await integrityOfFile(f); }
    catch (e) { process.stdout.write(o.json ? JSON.stringify({ input: path, status: 'failed', message: e.message }) + '\n' : `${path}: could not be checked: ${e.message}\n`); code = 2; continue; }
    const bad = results.filter((r) => r.status !== 'pass');
    if (bad.length && code < 1) code = 1;
    if (o.json) { process.stdout.write(JSON.stringify({ input: path, results: results.map(({ ic, status, evaluated, violations }) => ({ ic, status, evaluated, violations: violations.slice(0, 20), violationCount: violations.length })) }) + '\n'); continue; }
    process.stdout.write(`${path}:\n`);
    for (const r of results) {
      const word = r.status === 'pass' ? 'passes' : r.status === 'fail' ? `FAILS (${r.violations.length.toLocaleString('en-GB')})` : 'NOT TESTED: nothing to evaluate';
      process.stdout.write(`  ${r.ic.padEnd(6)} ${word}, ${r.evaluated.toLocaleString('en-GB')} evaluated\n`);
      for (const v of r.violations.slice(0, 5)) process.stdout.write(`         ${v}\n`);
    }
  }
  return code;
}

// Krisis: gazetteer lookup. `lookup` looks the places of a dataset up in a gazetteer's reconciliation
// service and adds what it finds to a work file (src/engine/krisis/lookup.js). The token comes from the
// environment only, and is never printed or written.
async function lookupCommand(args, o, resources) {
  const L = LOOKUP_WORDS;
  if (o.to) return usage('--to is for convert.');
  if (o.with || o.threshold || o.top || o.output) return usage('--with, --threshold, --top and --output are not for lookup.');
  if (o.json && o.brief) return usage('choose --json or --brief, not both.');
  // The reviewer, if given, is written into the work file (the page asks for the name; here it is given).
  const { reviewer, problem } = reviewerOption(o);
  if (problem) return usage(problem);
  const { createLookup, WHG_ENDPOINT, isWhg } = await import('../src/engine/gazetteer/index.js');
  const { runLookup, planLookup, serviceOf, iriFromTemplate, iriVia, manifestSettings, PLACE_CHOICES, WHG_REQUESTS_A_DAY } = await import('../src/engine/krisis/lookup.js');
  const { gather } = await import('../src/engine/krisis/match.js');
  const { readWork, serialiseWork, filesDiffer } = await import('../src/engine/krisis/work.js');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const endpoint = !o.gazetteer || o.gazetteer === 'whg' ? WHG_ENDPOINT : o.gazetteer;
  let service;
  try { service = serviceOf(endpoint); } catch { return usage(`--gazetteer ${o.gazetteer} is not whg or a web address.`); }
  if (o.places && !PLACE_CHOICES.includes(o.places)) return usage(`"${o.places}" is not a choice of places; they are ${PLACE_CHOICES.join(', ')}.`);
  const num = (flag, v, ok) => (v === undefined ? undefined : /^\s*\d+(\.\d+)?\s*$/.test(v) && ok(Number(v)) ? Number(v) : NaN);
  const near = num('--near', o.near, (x) => x > 0 && x <= 20015), limit = num('--limit', o.limit, (x) => Number.isInteger(x) && x >= 1 && x <= 50);
  const batch = num('--batch', o.batch, (x) => Number.isInteger(x) && x >= 1 && x <= 50), maxDistanceKm = num('--max-distance', o['max-distance'], (x) => x >= 0);
  for (const [flag, v, raw] of [['--near', near, o.near], ['--limit', limit, o.limit], ['--batch', batch, o.batch], ['--max-distance', maxDistanceKm, o['max-distance']]])
    if (Number.isNaN(v)) return usage(`${flag} ${raw} is not allowed; see --help.`);
  // WHG's token comes from WHG_TOKEN and goes only to WHG; another service's from the variable --token-env names, and only over https.
  const isWhgService = isWhg(endpoint);
  if (isWhgService && (o['token-env'] || o['gazetteer-iri'])) return usage("--token-env and --gazetteer-iri are for another service; WHG's token is read from WHG_TOKEN.");
  if (o['token-env'] && !process.env[o['token-env']]) return usage(L.tokenEnvMissing(o['token-env']));
  const token = (isWhgService ? process.env.WHG_TOKEN : o['token-env'] ? process.env[o['token-env']] : undefined) || undefined;
  if (token && new URL(endpoint).protocol !== 'https:') return usage(L.tokenOverHttp);
  if (!o['dry-run'] && isWhgService && !token) return usage(L.noToken('WHG_TOKEN'));
  // Another service's candidates' addresses: by --gazetteer-iri, else by its manifest's view.url (read below).
  const template = { template: null };
  if (o['gazetteer-iri']) { try { iriFromTemplate(o['gazetteer-iri']); template.template = o['gazetteer-iri']; } catch { return usage(`--gazetteer-iri ${o['gazetteer-iri']} is not an address with {{id}} in it.`); } }
  const items = await gatherInputs(args);
  if (items.length !== 1) return usage(`lookup takes one dataset of places; ${items.length} ${items.length === 1 ? 'was' : 'were'} given.`);
  let work = null;
  if (o.review) {
    try { work = readWork(readFileSync(o.review, 'utf8')); }
    catch (e) { return usage(`the work file ${o.review} cannot be used: ${e.code === 'ENOENT' ? 'there is no such file.' : e.message}`); }
  }
  const name = `${(items[0].name || items[0].paths[0].split(/[\\/]/).pop()).replace(/\.(gz)$/i, '').replace(/\.[^.]+$/, '')}.krisis.json`;
  if (!o['dry-run'] && !o.overwrite && existsSync(join(o.out, name))) return usage(`${join(o.out, name)} already exists; give --overwrite to replace it, or --out for somewhere else.`);

  const t0 = Date.now();
  const r = { type: 'lookup', subjects: { input: items[0].label, format: null, profile: null }, service: { endpoint: service.endpoint, title: service.title }, status: 'failed', dryRun: o['dry-run'], counts: {}, items: [], warnings: [], outputs: [], elapsedMs: 0 };
  const finishUp = () => {
    r.elapsedMs = Date.now() - t0;
    r.exitCode = r.status === 'failed' ? 2 : r.status === 'problems' ? 1 : 0;
    if (o.json) { process.stdout.write(JSON.stringify(r) + '\n'); return r.exitCode; }
    const lines = [`Places to look up: ${r.subjects.input}${r.subjects.format ? `: ${formatName(r.subjects)}` : ''}`];
    if (r.message) lines.push(`  Could not be done: ${r.message}`);
    if (r.preview) { lines.push(...L.preview(r.preview, { perDay: isWhgService ? WHG_REQUESTS_A_DAY : null }).map((l) => `  ${l}`)); for (const q of r.preview.first) lines.push(`    ${JSON.stringify(q)}`); }
    if (r.summary) lines.push(`  ${r.summary.problems} ${r.summary.counted} (${fmtTime(r.elapsedMs)})`);
    for (const w of r.warnings) lines.push(`  ${w}`);
    if (!o.brief) lines.push(...itemLines(r.items, 'match'));
    for (const x of r.outputs) lines.push(`  Wrote ${x.path} (${fmtBytes(x.size)})`);
    process.stdout.write(lines.join('\n') + '\n');
    return r.exitCode;
  };
  const { input, message } = await readInput(items[0]);
  if (!input) { r.message = message; return finishUp(); }
  Object.assign(r.subjects, { format: input.format, profile: input.profile || null });
  const host = new NodeHost({ workDir: o['work-dir'], outDir: o.out, overwrite: o.overwrite });
  const live = process.stderr.isTTY && !o.json;
  const xlsx = input.container === 'workbook' ? await import('xlsx') : undefined;
  const g = host.env(resources, { progress: live ? (p) => process.stderr.write(`\r\x1b[K${progressText(p)}`) : undefined, xlsx });
  let gathered;
  try { gathered = await gather({ subjects: input, options: { base: o.base } }, g.env); }
  catch (e) { g.finish(true); host.cleanup(); r.message = isSystemError(e) ? e.message : e instanceof DataError ? e.message : toolsFault(e); return finishUp(); }
  finally { if (live) process.stderr.write('\r\x1b[K'); }
  g.finish(false);
  r.items = gathered.report.items;
  if (gathered.incomplete) { host.cleanup(); r.message = gathered.report.items.find((i) => i.kind === 'unreadable')?.message; return finishUp(); }
  if (work) {
    const differ = await filesDiffer(work.subjects, input.files);
    if (differ.length) r.warnings.push(`The work file was made from other files than ${differ.join(', ')}: its places may no longer match the data.`);
  }
  const options = { service, places: o.places, allNames: o['all-names'], countries: o.countries, nearKm: near, limit, maxDistanceKm };
  if (o['dry-run']) {
    // Planned as the lookup would plan it: in requests of --batch, or the gazetteer module's 25.
    r.preview = planLookup({ lookup: { batchSize: batch ?? 25 }, work, places: gathered.places, options }).preview;
    r.status = 'ok';
    host.cleanup();
    return finishUp();
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const lookup = createLookup({ endpoint, token, ...(batch ? { batchSize: batch } : {}), ...(isWhgService ? {} : { iri: iriVia(template) }) });
  if (!isWhgService) {
    // Its type, and its address template unless one was given, from its manifest (sent without the token).
    let m;
    try { m = await manifestSettings(lookup, { signal: controller.signal }); } catch { host.cleanup(); r.warnings.push(L.stopped({ kind: 'stopped' })); return finishUp(); }
    if (!m.read) r.warnings.push(L.noManifest);
    if (m.type) options.type = m.type;
    if (!template.template && m.template) template.template = m.template;
  }
  const progress = live ? ({ done, total }) => process.stderr.write(`\r\x1b[K${done.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')} places looked up`) : undefined;
  let result;
  try { result = await runLookup({ lookup, work, subjects: gathered.subjects, places: gathered.places, options, reviewer, signal: controller.signal, onBatch: progress }); }
  catch (e) { host.cleanup(); r.message = toolsFault(e); return finishUp(); }
  finally { if (live) process.stderr.write('\r\x1b[K'); }
  const c = result.record.counts;
  r.counts = c;
  r.summary = L.summary(c, service.title);
  if (result.stopped) r.warnings.push(L.stopped(result.stopped));
  if (!c.places) r.warnings.push(L.noPlaces);
  const w = host.env(resources, {});
  try {
    const out = await w.env.output(name);
    out.write(serialiseWork(result.work));
    const x = await out.close();
    r.outputs.push({ path: x.path, size: x.size });
    w.finish(false);
  } catch (e) { w.finish(true); r.message = isSystemError(e) ? e.message : toolsFault(e); host.cleanup(); r.status = 'failed'; return finishUp(); }
  host.cleanup();
  r.status = result.stopped || c.unanswered || gathered.report.errors ? 'problems' : 'ok';
  return finishUp();
}

// Krisis: a review's suggestions published as a PLATO candidate set (src/engine/krisis/candidates.js).
// A command of its own, not an option of match: it is run on a work file alone, after the review (whose
// decisions the page saves in it), reads no dataset, and its --base is the candidate set's, where
// match's and apply's is the base of spreadsheet tables' places. It writes <subjects>.candidates.json
// to --out, and stores each candidate's address back in the work file, so that apply points at them.
async function candidatesCommand(args, o, resources) {
  if (o.json && o.brief) return usage('choose --json or --brief, not both.');
  if (o.to || o.with || o.review || o.output || o.candidates || o.threshold || o['max-distance'] || o.top || o.reviewer || o.orcid || o.columns)
    return usage('candidates takes a work file, and --base, --set-iri, --previous-candidates, --out, --overwrite, --json or --brief.');
  if (args.length !== 1) return usage(`candidates takes one work file (made by match, and saved by the page); ${args.length} ${args.length === 1 ? 'was' : 'were'} given.`);
  const { writeFileSync, renameSync, mkdirSync } = await import('node:fs');
  const { join, basename } = await import('node:path');
  const { readWork, serialiseWork } = await import('../src/engine/krisis/work.js');
  const t0 = Date.now();
  const path = args[0];
  const r = { type: 'candidates', work: path, status: 'failed', errors: 0, counts: {}, items: [], outputs: [], setIri: null, elapsedMs: 0 };
  const done = () => {
    r.elapsedMs = Date.now() - t0;
    r.exitCode = r.status === 'failed' ? 2 : 0;
    if (o.json) { process.stdout.write(JSON.stringify(r) + '\n'); return r.exitCode; }
    const lines = [`Work file: ${path}`];
    if (r.status === 'failed') lines.push(`  Could not be done: ${r.message}`);
    else {
      const { problems, counted } = summary({ errors: r.errors, counts: r.counts }, 'candidates');
      lines.push(`  ${problems}${counted ? ' ' + counted : ''}`);
      if (!o.brief) lines.push(...itemLines(r.items, 'candidates'));
      for (const x of r.outputs) lines.push(`  Wrote ${x.path} (${fmtBytes(x.size)})`);
      if (r.stored) lines.push(`  Stored each candidate's address in ${path}.`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    return r.exitCode;
  };
  let work;
  try { work = readWork(readFileSync(path, 'utf8')); }
  catch (e) { r.message = e.code === 'ENOENT' ? `there is no such file as ${path}.` : e.message; return done(); }
  const previousSets = [];
  for (const f of o['previous-candidates'] || []) {
    try { previousSets.push(readFileSync(f, 'utf8')); }
    catch (e) { return usage(`the earlier candidate set ${f} cannot be read: ${e.code === 'ENOENT' ? 'there is no such file.' : e.message}`); }
  }
  let x;
  try { x = exportCandidates(work, { base: o.base, setIri: o['set-iri'], previousSets }); }
  catch (e) { if (!(e instanceof DataError)) { r.message = toolsFault(e); return done(); } r.message = e.message; return done(); }
  // What is written is checked against the vendored candidate set profile first: anything it refuses is the tools' fault.
  if (x.set) {
    const V = resources.validators['candidate-set'];
    const { candidates, ...head } = x.set;
    const bad = !V.header(head) ? V.header.errors : candidates.map((c) => (V.candidate(c) ? null : V.candidate.errors)).find(Boolean);
    if (bad) { r.message = toolsFault(new Error(`the candidate set made does not match its schema: ${JSON.stringify(bad)}`)); return done(); }
    const stem = (work.subjects.files[0]?.name || basename(path).replace(/\.krisis\.json$/i, '')).replace(/\.(gz)$/i, '').replace(/\.[^.]+$/, '');
    const out = join(o.out, stem + '.candidates.json');
    const text = serialiseCandidateSet(x.set);
    try { mkdirSync(o.out, { recursive: true }); writeFileSync(out, text, { flag: o.overwrite ? 'w' : 'wx' }); }
    catch (e) { r.message = e.code === 'EEXIST' ? `${out} already exists; give --overwrite to replace it, or --out for somewhere else.` : e.message; return done(); }
    r.outputs.push({ path: out, size: Buffer.byteLength(text) });
  }
  // The addresses go back into the work file, replacing it whole (written beside it, then moved).
  try { writeFileSync(path + '.tmp', serialiseWork(x.work)); renameSync(path + '.tmp', path); r.stored = true; }
  catch (e) { r.message = `the work file ${path} could not be updated with the candidates' addresses: ${e.message}`; return done(); }
  Object.assign(r, { status: 'ok', errors: x.report.errors, counts: x.report.counts, items: x.report.items, setIri: x.setIri });
  return done();
}
