// The reading options on the command line (bin/plato-tools.mjs): --list-places, --header-places,
// --commentary-places, --key-pattern, --same-id, run as a user runs them, a separate process with
// files on disk. Each flag is shown to change what is read (with the run without it as the control),
// and each refusal to come before anything is read, with exit status 2 and nothing on stdout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITORIAL_IRI } from '../src/engine/hermes/tei.js';

const CLI = fileURLToPath(new URL('../bin/plato-tools.mjs', import.meta.url));
const FX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const cli = (...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const jsonLines = (out) => out.trim().split('\n').map((l) => JSON.parse(l));
const made = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'plato-tools-cli-reading-')); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const TEI_KEYS = join(FX, 'tei/keys-constructed.xml');
const TEI_LIST = join(FX, 'tei/pointers-constructed.xml');
const ISICILY = join(FX, 'tei/isicily-ISic000934.xml');
const DUPLICATES = join(FX, 'generic/duplicate-ids.csv');
const NO_IDS = join(FX, 'generic/no-ids.csv');
const GAZ_IDS = join(FX, 'generic/gazetteer-ids.csv');
const TGN = 'http://vocab.getty.edu/tgn/{id}';
const PLEIADES = 'https://pleiades.stoa.org/places/{id}';

/** Convert to a PLATO JSON document in a scratch directory: the run's result (--json) and the document written. */
function convert(...args) {
  const out = scratch();
  const r = cli('convert', '--to', 'plato-json', '--out', out, '--json', ...args);
  const files = readdirSync(out);
  return { ...r, result: r.out ? jsonLines(r.out)[0] : null, doc: files.length ? JSON.parse(readFileSync(join(out, files[0]), 'utf8')) : null };
}
const atts = (doc) => (doc?.spatialEntities || []).flatMap((p) => p.attestations.map((a) => ({ ...a, about: p['@id'] })));
/** A refusal: exit 2, the message on stderr, nothing on stdout. */
function refused(r, pattern) {
  assert.equal(r.code, 2, r.out + r.err);
  assert.equal(r.out, '');
  assert.match(r.err, pattern);
}

// ---- --list-places ---------------------------------------------------------------------------------
test('--list-places: a listed place becomes a Headword attestation; without it, its names are reported, not converted', () => {
  const off = convert(TEI_LIST), on = convert('--list-places', TEI_LIST);
  assert.equal(off.code, 0, off.err); assert.equal(on.code, 0, on.err);
  const headwords = (d) => atts(d).filter((a) => a.formStatus === 'https://w3id.org/plato#Headword');
  assert.equal(headwords(off.doc).length, 0, 'control: no headword without the flag');
  assert.ok(off.result.items.some((i) => i.kind === 'tei-listplace-names'), 'control: without it, the names are reported');
  assert.ok(atts(off.doc).length > 0, 'control: the text\'s own place names are converted either way');
  assert.deepEqual(headwords(on.doc).map((a) => [a.about, a.names[0].toponym, a.citations[0].locator]).sort(),
    [['https://pleiades.stoa.org/places/570685', 'Lacedaemon', 'list of places, place sparta'], ['https://pleiades.stoa.org/places/579885', 'Athenae', 'list of places, place athens']]);
});

// ---- --header-places and --commentary-places ------------------------------------------------------
const EDITORIAL = EDITORIAL_IRI;   // tei.js's; test/tei-editorial-iri.test.js checks it against the vendored ontology
test('--commentary-places: the commentary\'s place name becomes an attestation with formStatus plato:Editorial; without it, it is reported, not converted', () => {
  const off = convert(ISICILY), on = convert('--commentary-places', ISICILY);
  assert.equal(off.code, 0, off.err); assert.equal(on.code, 0, on.err);
  assert.deepEqual(atts(off.doc).map((a) => [a.names[0].toponym, a.formStatus]), [['Μάκρης κώμης', 'https://w3id.org/plato#Attested']], 'control: the inscription\'s name alone, Attested');
  assert.ok(off.result.items.some((i) => i.kind === 'tei-place-editorial'), 'control: without the flag, the commentary\'s name is reported');
  assert.deepEqual(atts(on.doc).map((a) => [a.names[0].toponym, a.formStatus, a.citations[0].locator]), [
    ['Μάκρης κώμης', 'https://w3id.org/plato#Attested', 'edition, lines 2 to 4'],
    ['Sarepta', EDITORIAL, 'commentary'],
  ]);
  assert.ok(!on.result.items.some((i) => i.kind === 'tei-place-editorial'));
});
test('--header-places: the findspot and places of origin in the header become attestations with formStatus plato:Editorial; without it, they are reported', () => {
  const off = convert(ISICILY), on = convert('--header-places', ISICILY);
  assert.equal(on.code, 0, on.err);
  assert.ok(off.result.items.some((i) => i.kind === 'tei-place-outside-text'), 'control: without the flag, the header\'s names are reported');
  const header = atts(on.doc).filter((a) => a.citations[0].locator.startsWith('teiHeader'));
  assert.deepEqual(header.map((a) => [a.names[0].toponym, a.formStatus]).sort(), [['Siracusa', EDITORIAL], ['Syracusae', EDITORIAL], ['catacomb of S. Giovanni', EDITORIAL]]);
  assert.deepEqual(header.find((a) => a.names[0].toponym === 'catacomb of S. Giovanni').relations.map((r) => r.relationType), ['https://w3id.org/plato#FindspotOf']);
  assert.ok(atts(on.doc).some((a) => a.names[0].toponym === 'Μάκρης κώμης' && a.formStatus === 'https://w3id.org/plato#Attested'), 'control: the inscription\'s name, Attested');
});

// ---- --key-pattern ---------------------------------------------------------------------------------
test('--key-pattern PREFIX=PATTERN: keys with that prefix become addresses; without it, none does, and a pattern is suggested', () => {
  const off = convert(TEI_KEYS), on = convert('--key-pattern', `tgn=${TGN}`, TEI_KEYS);
  const tgn = (d) => atts(d).filter((a) => a.about.startsWith('http://vocab.getty.edu/tgn/')).map((a) => a.about).sort();
  assert.deepEqual(tgn(off.doc), [], 'control: no TGN place without the pattern');
  assert.ok(off.result.items.find((i) => i.kind === 'tei-key-no-pattern').examples.some((e) => e.includes(`--key-pattern tgn=${TGN}`)));
  assert.deepEqual(tgn(on.doc), ['http://vocab.getty.edu/tgn/7001393', 'http://vocab.getty.edu/tgn/7010720', 'http://vocab.getty.edu/tgn/7011179']);
  assert.deepEqual(on.result.keyPatterns, { tgn: TGN }, '--json shows the pattern given');
  assert.ok(atts(on.doc).some((a) => a.notes?.includes(`Place address made from the key tgn,7011179 with the pattern ${TGN}`)));
});
test('--key-pattern PATTERN with no prefix applies to keys with no prefix; the printed report names each pattern', () => {
  const r = convert('--key-pattern', 'http://www.wikidata.org/entity/{id}', '--key-pattern', `pleiades=${PLEIADES}`, TEI_KEYS);
  const about = atts(r.doc).map((a) => a.about);
  assert.ok(about.includes('http://www.wikidata.org/entity/Q1524'), 'the key Q1524, which has no prefix');
  assert.ok(about.includes('https://pleiades.stoa.org/places/579885'));
  assert.ok(!about.some((a) => a.includes('athens')), 'pleiades:athens is out of shape: no address');
  assert.ok(r.result.items.some((i) => i.kind === 'tei-key-shape'), 'and it is reported');
  assert.deepEqual(r.result.keyPatterns, { '': 'http://www.wikidata.org/entity/{id}', pleiades: PLEIADES });
  const printed = cli('check', '--key-pattern', `tgn=${TGN}`, TEI_KEYS);
  assert.equal(printed.code, 0, printed.err);
  assert.match(printed.out, /\n {2}Keys made into web addresses with the patterns given:\n {4}"tgn" {2}http:\/\/vocab\.getty\.edu\/tgn\/\{id\}\n/);
});
test('--key-pattern: a WHG pattern, one with no {id}, one for the prefix whg, and a prefix given twice are refused', () => {
  refused(cli('check', '--key-pattern', 'whg=https://example.org/{id}', TEI_KEYS), /The key pattern for the prefix "whg" .* World Historical Gazetteer/);
  refused(cli('check', '--key-pattern', 'tgn=https://whgazetteer.org/places/{id}/portal/', TEI_KEYS), /World Historical Gazetteer/);
  refused(cli('check', '--key-pattern', 'tgn=http://vocab.getty.edu/tgn/', TEI_KEYS), /must hold the place of the key, \{id\}, exactly once/);
  refused(cli('check', '--key-pattern', `tgn=${TGN}`, '--key-pattern', 'tgn=https://example.org/{id}', TEI_KEYS), /--key-pattern is given twice for the prefix "tgn"/);
  assert.equal(cli('check', '--key-pattern', `tgn=${TGN}`, TEI_KEYS).code, 0, 'control: a good pattern is taken');
});

// ---- --same-id ---------------------------------------------------------------------------------------
test('--same-id: rows sharing an id are one place with an attestation each; without it, the repeated id is refused, naming --same-id', () => {
  const off = cli('check', '--json', DUPLICATES);
  assert.equal(off.code, 1, 'control: without the flag, a problem');
  assert.ok(jsonLines(off.out)[0].items.some((i) => i.severity === 'error' && i.examples.some((e) => /read rows with the same id as one place \(Reading options, or --same-id\)/.test(e))));
  const on = convert('--same-id', DUPLICATES);
  assert.equal(on.code, 0, on.err);
  assert.equal(on.result.profile, 'attestation-centric', 'the printed profile accounts for --same-id');
  const a = on.doc.spatialEntities.find((p) => p['@id'].endsWith('/a'));
  assert.equal(a.attestations.length, 2);
  assert.ok(on.result.items.some((i) => i.kind === 'generic-same-id-label'));
});
test('--same-id with no id column, or with no table of places, is refused before anything is read', () => {
  refused(cli('check', '--same-id', NO_IDS), /--same-id reads rows with the same id as one place, but no column of .*no-ids\.csv is read as the place id; map one to "id" with --columns\./);
  refused(cli('check', '--same-id', TEI_KEYS), /^plato-tools: --same-id is for a table of places \(CSV or GeoJSON\), and no input is one\.\n/);
  assert.equal(cli('check', NO_IDS).code, 0, 'control: the same file without the flag is checked');
});

// ---- a flag for none of the inputs, and for other commands ------------------------------------------
test('a TEI flag with no TEI input is refused with a usage message; given beside a TEI input, it is taken', () => {
  refused(cli('check', '--commentary-places', DUPLICATES), /^plato-tools: --commentary-places is for TEI, and no input is a TEI edition\.\n/);
  refused(cli('check', '--header-places', DUPLICATES), /^plato-tools: --header-places is for TEI, and no input is a TEI edition\.\n/);
  refused(cli('check', '--list-places', DUPLICATES), /^plato-tools: --list-places is for TEI, and no input is a TEI edition\.\n/);
  refused(cli('check', '--key-pattern', `tgn=${TGN}`, DUPLICATES), /^plato-tools: --key-pattern is for TEI/);
  const both = cli('check', '--json', '--list-places', DUPLICATES, TEI_LIST);
  assert.equal(both.code, 1, 'control: with a TEI input as well, both are read (the CSV has its repeated id)');
  assert.deepEqual(jsonLines(both.out).slice(0, 2).map((r) => r.format), ['csv', 'tei']);
});
test('the reading flags are for check, convert and preview only', () => {
  refused(cli('compare', '--list-places', TEI_LIST, TEI_LIST), /^plato-tools: --list-places is for check, convert and preview\.\n/);
  refused(cli('publish', 'report', '--same-id', DUPLICATES), /^plato-tools: --same-id is for check, convert and preview\.\n/);
  refused(cli('match', '--key-pattern', `tgn=${TGN}`, TEI_KEYS, '--with', TEI_KEYS), /^plato-tools: --key-pattern is for check, convert and preview\.\n/);
});

// ---- confirmed patterns for a column of ids ----------------------------------------------------------
test('a column of gazetteer ids: suggested, not used, until given in --columns in its object form, which the printout and --json show', () => {
  const guessed = cli('check', GAZ_IDS);
  assert.equal(guessed.code, 0, guessed.err);
  assert.match(guessed.out, /\n {4}\{"id":"id","name":"name","pleiades_id":"note"\}\n/);
  assert.match(guessed.out, /Note: The column “pleiades_id” seems to hold a gazetteer's ids, .* give it as \{"field": "address", "pattern": "https:\/\/pleiades\.stoa\.org\/places\/\{id\}"\} in the mapping given with --columns\./);
  const mapping = join(scratch(), 'm.json');
  writeFileSync(mapping, JSON.stringify({ id: 'id', name: 'name', pleiades_id: { field: 'address', pattern: PLEIADES } }));
  const given = cli('check', '--columns', mapping, GAZ_IDS);
  assert.match(given.out, /\n {4}\{"id":"id","name":"name","pleiades_id":\{"field":"address","pattern":"https:\/\/pleiades\.stoa\.org\/places\/\{id\}"\}\}\n/);
  assert.doesNotMatch(given.out, /seems to hold a gazetteer's ids/, 'the suggestion is gone once the pattern is given');
  const json = jsonLines(cli('check', '--json', '--columns', mapping, GAZ_IDS).out)[0];
  assert.deepEqual(json.columns.find((c) => c.column === 'pleiades_id'), { column: 'pleiades_id', field: 'address', pattern: PLEIADES, reason: json.columns.find((c) => c.column === 'pleiades_id').reason });
  assert.equal(json.profile, 'attestation-centric');
  const r = convert('--columns', mapping, GAZ_IDS);
  assert.ok(atts(r.doc).some((a) => a.about === 'https://pleiades.stoa.org/places/579885'));
});

test('--help documents every reading option', () => {
  const r = cli('--help');
  for (const flag of ['--same-id', '--list-places', '--key-pattern [PREFIX=]PATTERN', '--header-places', '--commentary-places']) assert.ok(r.out.includes(flag), flag);
  assert.match(r.out, /These two give the place names they convert the form status plato:Editorial\./);
  assert.doesNotMatch(r.out, /refused until PLATO pins/);
  assert.match(r.out, /"keyPatterns"/);
});
