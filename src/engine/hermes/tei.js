// TEI XML editions -> PLATO attestation-centric attestations (Hermes, issue #5).
//
// A TEI edition that marks a place name in its text and points it at a gazetteer (<placeName
// ref="https://pleiades.stoa.org/places/579885">Athenae</placeName>) says that the edition, at that
// point, names that place: the place's address is what the attestation is about, the words marked
// are the name as written, and the edition, with where in it the words stand, is the citation. One
// attestation is made for each pair of a place name and a place address it points to, as the
// Recogito reader (src/formats/annotations.js) makes one for each link from a passage to a place.
// Everything else is either carried (a key, several addresses, where the words came from, in the
// notes) or reported by kind. Nothing is dropped silently, except the parts of the teiHeader that
// describe the file rather than cite it (who encoded it, its revision history, its taxonomies).
//
// The file is parsed as a stream with saxes (no DOM: a Web Worker has no DOMParser, and an edition
// can be large). Nothing holds the whole document. The one thing kept until the end is a place name
// whose ref points to a <place> later in the file (a list of places at the end of the text, or in
// <back>), which cannot be resolved until that place has been read: a few strings per place name.
//
// Where TEI allows more than one reading, the reading here is the conservative one, and each choice
// is stated where it is made.
import { SaxesParser } from 'saxes';
import { PLATO, isAbsoluteIri } from '../../lib/context.js';
import { DataError, textStream } from '../input.js';
import { LOSS_TEXT } from '../report.js';
import { placeAddress, addressNote, addressFromPattern, patternFault, GAZETTEER_PATTERNS } from './addresses.js';

export const TEI_NS = 'http://www.tei-c.org/ns/1.0';
const ATTESTED = PLATO + 'Attested';
const HEADWORD = PLATO + 'Headword';
const FINDSPOT_OF = PLATO + 'FindspotOf';
// Coordinates in a <geo>: a latitude and a longitude in degrees, between them a comma, spaces, or both
// (TEI's default "37.97 23.72"; I.Sicily writes "37.08415, 15.27628").
const GEO = /^([-+]?\d+(?:\.\d+)?)\s*(?:,\s*|\s+)([-+]?\d+(?:\.\d+)?)$/;
// Or each with a comma for its decimal point, and only whitespace between them (Schnitzler's
// "48,177598 16,329723"): two numbers, each with exactly one comma, which nothing else can mean.
// Anything else with commas ("48,1,16,3", "48,1 16") is ambiguous, and stays invalid.
const GEO_COMMA_DECIMALS = /^([-+]?\d+),(\d+)\s+([-+]?\d+),(\d+)$/;
/** A <geo>'s "lat long" as { lat, lon } in degrees, or null when it cannot be read as one, or is off the earth. */
export function parseGeo(text) {
  const s = norm(text || '');
  let m = GEO.exec(s), lat, lon;
  if (m) { lat = Number(m[1]); lon = Number(m[2]); }
  else if ((m = GEO_COMMA_DECIMALS.exec(s))) { lat = Number(`${m[1]}.${m[2]}`); lon = Number(`${m[3]}.${m[4]}`); }
  else return null;
  return Math.abs(lat) > 90 || Math.abs(lon) > 180 ? null : { lat, lon };
}

/**
 * The form status of words that are the editors' own, not the source's: a place name in an
 * edition's commentary, translation, apparatus or a note, or in its teiHeader. PLATO has no such
 * status pinned yet, so it is null, and the reading options that would convert the editors' words
 * (commentaryPlaces, headerPlaces) are refused until it is set: such a record must never go out
 * with no formStatus, which PLATO would read as Attested. Enabling them is this one constant
 * (https://w3id.org/plato#Editorial, once PLATO pins it).
 */
export const EDITORIAL_IRI = null;
let editorialIri = EDITORIAL_IRI;
/** For tests only: the form status the editors' words are given, as if EDITORIAL_IRI were set; returns the one it replaces. */
export function setEditorialIriForTests(iri) { const was = editorialIri; editorialIri = iri; return was; }
export const EDITORIAL_HELD = "available once PLATO's Editorial form status is pinned";
const HELD_OPTIONS = { commentaryPlaces: 'commentary places', headerPlaces: 'header places' };

/**
 * Why a run's reading options cannot be used, in words a page or the command line can show, or
 * null. Checked again by TeiReader, which refuses them with a DataError.
 */
export function teiReadingRefusal(reading = {}) {
  for (const [k, words] of Object.entries(HELD_OPTIONS)) if (reading[k] && !editorialIri) return `Converting ${words}, marked as the editors' words, is ${EDITORIAL_HELD}.`;
  const kp = reading.keyPatterns;
  if (kp !== undefined && (typeof kp !== 'object' || kp === null || Array.isArray(kp))) return 'Key patterns are given as a prefix and a pattern for each.';
  for (const [prefix, pattern] of Object.entries(kp || {})) {
    // "whg:<n>" is WHG's ambiguous code (a cluster to Recogito, a database key to reconciliation), never an id to make an address from.
    const why = prefix.toLowerCase() === 'whg' ? 'whg' : patternFault(pattern);
    if (why) return `The key pattern ${prefix ? `for the prefix "${prefix}"` : 'for keys with no prefix'} (${pattern}) ${PATTERN_WHY[why]}`;
  }
  return null;
}
const PATTERN_WHY = {
  placeholder: 'must hold the place of the key, {id}, exactly once, such as https://pleiades.stoa.org/places/{id}.',
  'not-web': "must make a web address (http:// or https://), with no spaces, and the id must come after the address's host.",
  whg: "makes a World Historical Gazetteer address, which is never made from a key: WHG's codes are not its records' addresses. Give each place's https://w3id.org/whg/id/place:… address in its ref instead.",
};

// ---- keys --------------------------------------------------------------------------------------
// A place name with no ref may give a key (key="pleiades:579885", Perseus's key="tgn,7011179"). A key
// is not an address, so it is converted only with a pattern the user confirms for its prefix (the
// reading option keyPatterns, {prefix: pattern}): the prefix is what comes before the key's first ':'
// or ','; a key with neither has the prefix "". The rest of the key is made into an address by
// addressFromPattern (./addresses.js). A key beside a ref is never used: the ref says which place.
/** A key's prefix and the rest. */
export function splitKey(key) {
  const k = norm(key), i = k.search(/[:,]/);
  // Spaces around the ':' or ',' (key=" tgn , 7011179") are not part of the prefix or the id.
  return i < 0 ? { prefix: '', rest: k } : { prefix: k.slice(0, i).trim(), rest: k.slice(i + 1).trim() };
}
// The patterns suggested for a prefix, by the gazetteer it names, where most of its keys fit (the
// user still confirms each). Getty's TGN is Perseus's; its ids are digits.
const KEY_GAZETTEERS = [
  { prefixes: ['pleiades', 'pl', 'pleiad'], ...GAZETTEER_PATTERNS.pleiades },
  { prefixes: ['geonames', 'gn'], ...GAZETTEER_PATTERNS.geonames },
  { prefixes: ['wikidata', 'wd', ''], ...GAZETTEER_PATTERNS.wikidata },
  { prefixes: ['tgn', 'getty'], pattern: 'http://vocab.getty.edu/tgn/{id}', shape: /^\d+$/ },
];
/** The pattern to suggest for a prefix, given some of its keys' rests, or undefined. */
export function suggestKeyPattern(prefix, rests) {
  const g = KEY_GAZETTEERS.find((x) => x.prefixes.includes(prefix.toLowerCase()));
  if (!g || !rests.length) return undefined;
  return rests.filter((r) => g.shape.test(r)).length * 2 >= rests.length ? g.pattern : undefined;
}
const SAMPLES = 50;
// A language tag: stricter than plato.schema.json's languageTag, which would take xml:lang="Latin"
// (five letters): a primary language subtag in use has two or three letters (BCP 47).
const LANGUAGE_TAG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;
const WEB = /^https?:\/\/\S+$/i;
// URI schemes that are not a TEI prefix waiting for a <prefixDef>: a pointer in one of these is an
// address, just not a web address, and PLATO's `about` takes only web addresses of places.
const SCHEMES = new Set(['urn', 'doi', 'info', 'tag', 'mailto', 'file', 'ftp', 'data', 'geo', 'ark', 'uuid']);

/**
 * Each kind the reader reports, and how it is reported: 'loss' (not carried into PLATO), 'warning'
 * (carried, but worth a look) or 'error'. The words for each are in src/engine/report.js
 * (LOSS_TEXT), under the same kind.
 */
export const TEI_KINDS = {
  'tei-place-no-ref': 'loss',
  'tei-place-outside-text': 'loss',
  'tei-place-in-record': 'loss',
  'tei-place-empty': 'loss',
  'tei-place-ethnic': 'loss',
  'tei-ref-prefix': 'loss',
  'tei-ref-local': 'loss',
  'tei-ref-ambiguous': 'loss',
  'tei-ref-relative': 'loss',
  'tei-ref-not-web': 'loss',
  'tei-listplace-names': 'loss',
  'tei-listplace-geo': 'loss',
  'tei-listplace-variant': 'loss',
  'tei-listplace-no-address': 'loss',
  'tei-listplace-ambiguous': 'loss',
  'tei-listplace-geo-gazetteer': 'loss',
  'tei-listplace-geo-datum': 'loss',
  'tei-listplace-geo-invalid': 'loss',
  'tei-listplace-geo-other-place': 'loss',
  'tei-lang-not-tag': 'loss',
  'tei-licence-not-address': 'loss',
  'tei-sourcedesc-several': 'loss',
  'tei-whg-record': 'loss',
  'tei-whg-staging': 'loss',
  'tei-attribute': 'loss',
  'tei-place-content': 'loss',
  'tei-variant': 'loss',
  'tei-place-editorial': 'loss',
  'tei-header-origin': 'loss',
  'tei-key-no-pattern': 'loss',
  'tei-key-shape': 'loss',
  'tei-findspot-no-object': 'loss',
  'address-not-a-place': 'loss',
  'tei-ref-several': 'warning',
  'address-pleiades-part': 'warning',
  'address-web-page': 'warning',
  'tei-source-no-address': 'warning',
  'tei-none-linked': 'warning',
  'tei-editorial-undecided': 'warning',
  'tei-editorial-late-edition': 'loss',
};

// The elements read as place names. <placeName> is TEI's place name; <settlement>, <region>,
// <country>, <bloc>, <district> and <geogName> are TEI place names too (the "names.dates" module
// makes each a place name of a kind), so each is read the same way when it has a ref. <rs
// type="place"> and <name type="place"> are a place named by a general element, and are read the
// same way too.
const PLACE_ELEMENTS = new Set(['placeName', 'settlement', 'region', 'country', 'bloc', 'district', 'geogName']);
const GENERAL_NAMES = new Set(['rs', 'name']);
// In a <choice>, the edited form is the name (<reg> over <orig>, <expan> over <abbr>, <corr> over
// <sic>), and the form as the source prints it, where it differs, is kept as the name's sourceLabel.
// In an <app>, the lemma is taken and the variant readings are not. This holds both for a <choice>
// or <app> inside a place name, and for place names inside the parts of one: a place name wholly
// inside an <rdg>, or inside the part of a <choice> that is not taken (an <orig>, <abbr> or <sic>
// beside a <reg>, <expan> or <corr>), is not an attestation, and is reported (tei-variant); where
// the part taken has a place name with the same ref, the one not taken is its sourceLabel instead.
// A <choice> with one part only (an <orig> with no <reg>) takes that part.
const PREFERRED = ['reg', 'expan', 'corr', 'lem'];
const PRINTED = ['orig', 'abbr', 'sic', 'lem'];
// Where a <div> labels itself: its type ("book 2"), or for EpiDoc's type="textpart" its subtype
// ("face a"); a <div> with neither type nor n says nothing a reader could find it by.
const DIVS = /^div[1-7]?$/;
const BREAKS = new Set(['lb', 'pb', 'cb']);
// The most place names held while it is not known whether the <text> has an edition div (below,
// "Whose words"): past it, the text is read as having none, and that is reported.
export const HOLD_CAP = 10000;
// What placeAddress (./addresses.js) says of an address that must not be carried, as a kind here.
const WHG_LOST = { 'whg-portal-record': 'tei-whg-record', 'whg-staging': 'tei-whg-staging', 'address-not-a-place': 'address-not-a-place' };
// The attributes of a place name that are read (xml:lang for the name's language; type only where it
// makes <rs> or <name> a place). Every other attribute is reported, once for each attribute and
// value. @cert is among them: TEI's high, medium and low do not say what they are certain of (the
// reading, the identification, the ref), and PLATO's certaintyLevel (Certain, LessCertain,
// Uncertain) is a statement about the whole attestation, so the fit is not exact and nothing is
// mapped. A namespace declaration or xml:space says nothing about the place.
const READ_ATTRIBUTES = new Set(['ref', 'key', 'xml:id', 'xml:lang', 'xml:space']);
// The children of a <place> in a list of places that are read (idno) or reported by a kind of their
// own (its names, its location); a nested <place> is read as a place. Any other child is reported.
const PLACE_CHILDREN = new Set(['idno', 'location', 'place', ...PLACE_ELEMENTS]);
// A <location> type that says the location is another place's (the place this one is in), not this place's own.
const OTHER_PLACE_LOCATION = /located[_ -]?in|parent|part[_ -]?of|within|in[_ -]?place|broader/i;
// A description of a person, an organisation, an event or a book (in <back>, say), whose place names
// (a birthplace in a <listPerson>) describe it, not a passage of the text that names the place.
const RECORDS = new Set(['listPerson', 'listOrg', 'listEvent', 'listBibl', 'person', 'personGrp', 'org', 'event', 'bibl', 'biblStruct']);
// A <g> (a glyph) whose ref or type names a mark of punctuation, such as an interpunct
// (<g ref="#interpunct">·</g>), a middle dot or a hedera: in a name it is a word divider, so it is
// read as one space ("colonia·Augusta" is "colonia Augusta"). Any other <g> is read as its text.
const PUNCTUATION_GLYPH = /punct|middot|hedera|divider|separator/i;

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const isWeb = (s) => typeof s === 'string' && WEB.test(s) && isAbsoluteIri(s);
const hostOf = (iri) => { try { return new URL(iri).hostname.toLowerCase(); } catch { return undefined; } };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * The text of one element as it is read: the edited form and the form as printed, with notes left
 * out and <choice> and <app> resolved as above. A capture is opened at an element's start tag and
 * read at its end tag; every text event in between is given to every open capture.
 */
class Capture {
  constructor(depth) { this.depth = depth; this.pref = ''; this.printed = ''; this.stack = []; this.join = false; }
  get top() { return this.stack[this.stack.length - 1]; }
  text(t) {
    if (this.join) { t = t.replace(/^\s+/, ''); if (t) this.join = false; }
    const c = this.top;
    if (!c) { this.pref += t; this.printed += t; return; }
    if (c.part) { c.part.pref += t; c.part.printed += t; }
    // text between the parts of a <choice> (whitespace) belongs to none of them
  }
  /** A line, page or column break: a space between words, or nothing within a word (break="no"). */
  brk(noBreak) {
    const c = this.top, into = !c ? this : c.part;
    if (!into) return;
    if (noBreak) { into.pref = into.pref.replace(/\s+$/, ''); into.printed = into.printed.replace(/\s+$/, ''); this.join = true; }
    else { into.pref += ' '; into.printed += ' '; }
  }
  choiceOpen(depth) { this.stack.push({ depth, parts: [], part: null }); }
  partOpen(name, depth) { const c = this.top; if (c && c.depth === depth - 1) { c.part = { name, pref: '', printed: '' }; c.parts.push(c.part); } }
  partClose(depth) { const c = this.top; if (c && c.part && c.depth === depth - 1) c.part = null; }
  choiceClose(depth) {
    const c = this.top;
    if (!c || c.depth !== depth) return;
    this.stack.pop();
    const pick = (order) => order.map((n) => c.parts.find((p) => p.name === n)).find(Boolean) || c.parts[0];
    const pref = pick(PREFERRED), printed = pick(PRINTED);
    const into = this.top ? this.top.part : this;
    if (into) { into.pref += pref ? pref.pref : ''; into.printed += printed ? printed.printed : ''; }
  }
}

/**
 * Reads a TEI document from text chunks. `report(kind, example)` receives every kind in TEI_KINDS.
 * write(chunk) and close() return the events read so far, in order: { type: 'header', value } once,
 * first, then { type: 'attestation', value } for each attestation.
 *
 * Options: fileName, for the header and the notes; count(), called once for each place name read in
 * the text (the report's count). Any other option is a reading option, kept in `this.reading`
 * (none changes what is read yet).
 */
export class TeiReader {
  constructor(report, { fileName = 'the TEI file', count = () => {}, onKey, ...reading } = {}) {
    this.report = report; this.fileName = fileName; this.countOne = count; this.reading = reading;
    this.onKey = onKey;            // onKey(prefix, key, rest): each key of a place name with no ref (teiKeyPrefixes)
    this.keysWithout = new Map();  // prefix -> { count, examples, rests }: keys with no pattern, for tei-key-no-pattern
    const refused = teiReadingRefusal(reading);
    if (refused) throw new DataError(refused);
    this.editorialIri = editorialIri;
    this.out = [];
    this.stack = [];            // open elements: { local, tei, lang, ... }
    this.captures = [];         // open captures, each with the callback that reads it
    this.scopes = [];           // TEI and teiCorpus elements, innermost last, each with its header
    this.places = new Map();    // xml:id of a <place> -> { uris: [...] }
    // Place names waiting for a <place> not yet read: in the order met (for those still waiting at
    // the end), and by the id each waits for, so that a <place> finds its own in one look.
    this.pending = new Set();
    this.waitingFor = new Map();   // xml:id -> [place name]
    this.prefixCache = null;       // the prefixDefs in force, innermost first, shared by the place names read under them
    this.placeStack = [];       // open <place> elements
    this.divs = []; this.page = undefined; this.line = undefined; this.milestones = new Map();
    this.headed = false; this.mentions = 0; this.attestations = 0;
    this.inHeader = 0; this.inText = 0; this.inNote = 0; this.inPlaceMention = 0;
    this.seen = new Set();       // (kind, example) pairs reported with once()
    // The editors' parts of an edition (below, "Whose words"): whether the <text> being read has a
    // top-level div type="edition", and whether that is known yet; the top-level div open now.
    this.editionSeen = false; this.editionDecided = false; this.topDiv = null;
    this.held = [];              // place names whose words may be the editors', until that is known
    const p = this.parser = new SaxesParser({ xmlns: true, position: true });
    p.on('error', (e) => {
      const why = String(e.message).split('\n')[0];
      if (/undefined entity/.test(why)) throw new DataError(`The XML uses an entity (such as &nbsp;) that the file does not declare, so it cannot be read past that point (${why}). Only entities declared with their text in the file's own DOCTYPE, such as <!ENTITY nbsp "&#160;">, are read; an external DTD is never fetched. Declare the entity, or write the character itself.`);
      throw new DataError(`The XML is not well formed, so the file cannot be read past that point (${why}).`);
    });
    p.on('doctype', (d) => this.doctype(d));
    p.on('xmldecl', (d) => {
      // The file is decoded as UTF-8, strictly (input.js, textStream); a file that says it is in
      // another encoding is refused even when its bytes happen to be valid UTF-8, as they would be
      // read as letters other than those meant.
      if (d.encoding && !/^(utf-?8|us-ascii)$/i.test(d.encoding)) throw new DataError(`The file says it is encoded as ${d.encoding}; only UTF-8 can be read. Save it as UTF-8 and try again.`);
    });
    p.on('opentag', (t) => this.open(t));
    p.on('closetag', (t) => this.close_(t));
    p.on('text', (t) => this.text(t));
    p.on('cdata', (t) => this.text(t));
  }
  /**
   * The entities a DOCTYPE declares in the file itself (<!DOCTYPE TEI [<!ENTITY nbsp "&#160;">]>),
   * given to the parser, so that &nbsp; reads as the text declared. Only an entity whose text is in
   * the declaration is read, and only text: one whose text holds markup is refused where it is used.
   * An external entity (SYSTEM or PUBLIC) is never fetched or read, from the web or from the disk,
   * whatever it names: a file must not be able to make the tools read another file. Using one
   * stops the file, saying so; declaring one and not using it is harmless.
   */
  doctype(text) {
    const open = text.indexOf('['), close = text.lastIndexOf(']');
    if (open < 0 || close < open) return;
    const E = this.parser.ENTITIES;
    const refuse = (name, why) => Object.defineProperty(E, name, { configurable: true, get: () => { throw new DataError(`The file uses the entity &${name};, ${why}`); } });
    const DECL = /<!ENTITY\s+(%\s+)?([^\s%"'>]+)\s+(?:"([^"]*)"|'([^']*)'|((?:SYSTEM|PUBLIC)\b[^>]*))\s*>/g;
    for (const [, param, name, dq, sq, external] of text.slice(open + 1, close).matchAll(DECL)) {
      // A parameter entity is the DTD's own; the first declaration counts; XML's five are XML's.
      if (param || Object.hasOwn(E, name) || ['lt', 'gt', 'amp', 'apos', 'quot'].includes(name)) continue;
      if (external !== undefined) { refuse(name, `which the file's DOCTYPE declares as another file (${norm(external)}). An entity from another file is never read, for safety, so the file cannot be read past it: write the entity's text in its place.`); continue; }
      let bad = false;
      const value = (dq ?? sq).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[^\s&;]+);/g, (all, ref) => {
        if (ref[0] === '#') { const n = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10); try { return String.fromCodePoint(n); } catch { bad = true; return all; } }
        const v = Object.getOwnPropertyDescriptor(E, ref)?.value ?? { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' }[ref];
        if (typeof v !== 'string') { bad = true; return all; }
        return v;
      });
      // Markup in an entity's text (<hi>…</hi>), or an entity of an entity not declared, is not supported yet.
      if (bad || /</.test(dq ?? sq)) { refuse(name, 'whose text in the DOCTYPE holds markup or an entity that is not declared, which is not supported yet: write its text in its place.'); continue; }
      Object.defineProperty(E, name, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  write(chunk) { this.parser.write(chunk); return this.take(); }
  close() {
    this.parser.close();
    if (!this.stack.length && !this.scopes.length && !this.sawRoot) throw new DataError('The file holds no XML element, so there is nothing to read.');
    if (!this.editionDecided) this.decide(false);
    // What is still waiting was pointing at a <place> that never came.
    for (const m of this.pending) this.emit(m, true);
    this.pending.clear(); this.waitingFor.clear();
    this.header();
    for (const [prefix, k] of this.keysWithout) {
      const suggested = suggestKeyPattern(prefix, k.rests);
      const flag = `--key-pattern ${prefix ? `${prefix}=` : ''}${suggested || 'https://…/{id}'}`;
      this.report('tei-key-no-pattern', `${prefix ? `prefix "${prefix}"` : 'no prefix'}: ${plural(k.count, 'key')}, such as ${k.examples.join(', ')}; ${suggested ? 'try' : 'give a pattern, such as'} ${flag}`);
    }
    if (!this.attestations) this.report('tei-none-linked', `${plural(this.mentions, 'place name')} in the text`);
    return this.take();
  }
  take() { const o = this.out; this.out = []; return o; }

  // ---- whose words ---------------------------------------------------------------------------------
  // An edition that has a top-level div type="edition" (EpiDoc's, Perseus's) says that the source's
  // text is there, and that every other top-level div (a translation, a commentary, an apparatus, a
  // bibliography) and every <note>, wherever it is, is the editors'. A place name there is the
  // editors' words, not the source's: it is reported (tei-place-editorial, with the part), and is
  // converted only with the reading option commentaryPlaces, marked with the editors' form status
  // (EDITORIAL_IRI, which holds that option back until PLATO pins it). The divisions inside the
  // edition (textparts) are the edition. A file with no edition div is read as it always was:
  // its notes, commentary and translations are the edition's text.
  //
  // Where such a place name (in any top-level div that is not the edition, of whatever type, or in a
  // note) comes before any edition div has been read, whether the file has one is not known yet. It
  // is held (in `held`) until an edition div opens (it is the editors'), or a place name is read
  // outside every top-level div and note (the text has no edition div), or the <text> ends; then it
  // is read as before, emitted out of the file's order, as a name waiting for a <place> is. Held
  // names are at most HOLD_CAP: the next is read as if the text had no edition div, the names held
  // are emitted as ordinary, and that is reported once for each <text> (tei-editorial-undecided). An edition div that
  // opens after that shows those names, and the ones read after them in the editors' parts, to have
  // been the editors' words converted as the source's: a definite loss (tei-editorial-late-edition,
  // counted in `late`). Everything else is emitted at once.
  /** The editors' part a place name opened now would be in, if the file has an edition div: the top-level div's type, else 'note'. */
  editorialPart() {
    if (this.topDiv && this.topDiv.type !== 'edition') return this.topDiv.type || 'div';
    return this.inNote ? 'note' : undefined;
  }
  /** Whether the <text> has an edition div is now known: the place names held are placed, in the order read. */
  decide(hasEdition) {
    this.editionDecided = true;
    const held = this.held; this.held = [];
    for (const d of held) this.place(d, hasEdition ? d.editorial : undefined);
  }

  // ---- the header ------------------------------------------------------------------------------
  /** The document header for the attestations: the gazetteer, described from the first teiHeader. */
  header() {
    if (this.headed) return;
    this.headed = true;
    const h = this.scopes[0]?.hdr || this.firstHdr;
    const title = h && this.mainTitle(h);
    this.out.push({ type: 'header', value: {
      profile: 'attestation-centric',
      gazetteer: {
        title: title ? `Place names in ${title}` : `Place names in ${this.fileName}`,
        description: `Converted by PLATO tools from the TEI edition ${this.fileName}: one attestation for each place name in the text whose ref points to a place.`,
      },
    } });
  }
  mainTitle(h) { const t = h.titles.find((x) => x.type === 'main') || h.titles[0]; return t && t.text; }
  /**
   * The source the attestations cite: the TEI edition itself, as its teiHeader describes it. The
   * original text the edition transmits (its <sourceDesc>) is the source's derivedFrom, by title.
   * Built once per TEI element, from the innermost header that has been read (in a teiCorpus, a TEI
   * with no header of its own cites the corpus).
   */
  source() {
    const scope = [...this.scopes].reverse().find((s) => s.hdr.read) || this.scopes[this.scopes.length - 1];
    if (!scope) return { title: `The TEI edition ${this.fileName}`, authorityType: 'source' };
    if (scope.source) return scope.source;
    const h = scope.hdr, report = this.report;
    const title = this.mainTitle(h) || `The TEI edition ${this.fileName}`;
    // The edition's address: an <idno type="URI"> (or "URL") in the publicationStmt, else its DOI.
    // The URI comes first, because it is the edition as published, where a DOI is often a deposit
    // of one version of it.
    const idno = (types) => h.idnos.find((i) => types.includes((i.type || '').toLowerCase()) && i.text);
    const uri = idno(['uri', 'url']);
    const doi = idno(['doi']);
    let id = uri && isWeb(uri.text) ? uri.text : undefined;
    if (!id && doi) { const d = doi.text.replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, ''); if (/^10\.\S+$/.test(d)) id = `https://doi.org/${d}`; }
    const src = {};
    if (id) src['@id'] = id;
    src.title = title;
    // A citation string only from what the header states: its authors (else its editors), title,
    // publisher and date.
    const people = h.authors.length ? h.authors : h.editors.length ? [`${h.editors.join('; ')} (ed.)`] : [];
    if (people.length || h.publisher || h.date) src.citation = [people.join('; '), title, h.publisher, h.date].filter(Boolean).join('. ') + '.';
    const lic = h.licences.find((l) => isWeb(l.target));
    if (lic) src.licence = lic.target;
    else if (h.licences.length) report('tei-licence-not-address', h.licences[0].text || h.licences[0].target || 'a licence with no text');
    if (h.sourceDescs.length) {
      src.derivedFrom = { title: h.sourceDescs[0], authorityType: 'source' };
      for (const s of h.sourceDescs.slice(1)) report('tei-sourcedesc-several', s);
    }
    src.authorityType = 'source';
    if (!id) report('tei-source-no-address', title);
    scope.source = src;
    return src;
  }
  /** What one teiHeader element is, if it is one this reader keeps, by its path in the header. */
  headerField(path, t) {
    const h = this.scopes[this.scopes.length - 1]?.hdr;
    if (!h) return;
    const attr = (n) => t.attributes[n]?.value;
    const cap = (fn) => this.capture(fn);
    if (/fileDesc\/titleStmt\/title$/.test(path)) cap((c) => { const s = norm(c.pref); if (s) h.titles.push({ type: attr('type'), text: s }); });
    else if (/fileDesc\/titleStmt\/author$/.test(path)) cap((c) => { const s = norm(c.pref); if (s) h.authors.push(s); });
    else if (/fileDesc\/titleStmt\/editor$/.test(path)) cap((c) => { const s = norm(c.pref); if (s) h.editors.push(s); });
    else if (/fileDesc\/publicationStmt\/publisher$/.test(path)) cap((c) => { h.publisher ||= norm(c.pref) || undefined; });
    else if (/fileDesc\/publicationStmt\/date$/.test(path)) cap((c) => { h.date ||= norm(c.pref) || attr('when') || undefined; });
    else if (/fileDesc\/publicationStmt\/idno$/.test(path)) cap((c) => h.idnos.push({ type: attr('type'), text: norm(c.pref) }));
    else if (/fileDesc\/publicationStmt\/availability\/licence$/.test(path)) cap((c) => h.licences.push({ target: attr('target'), text: norm(c.pref) }));
    // The original the edition was made from: a bibliographic description, or a manuscript's (or an
    // inscribed object's) identifier: where it is kept and its number. A <p> ("born digital") is not
    // a source, and is not read.
    else if (/fileDesc\/sourceDesc\/(listBibl\/)?(bibl|biblStruct|biblFull)$/.test(path)) cap((c) => { const s = norm(c.pref); if (s) h.sourceDescs.push(s); });
    else if (/fileDesc\/sourceDesc\/msDesc\/msIdentifier$/.test(path)) { h.msParts = []; this.stack[this.stack.length - 1].msIdentifier = true; }
    else if (/fileDesc\/sourceDesc\/msDesc\/msIdentifier\/[^/]+$/.test(path) && h.msParts && t.local !== 'altIdentifier') cap((c) => {
      const s = norm(c.pref);
      if (s) h.msParts.push(s);
      // The object's own address (an idno of type URI), for a findspot's relation (headerPlace).
      if (t.local === 'idno' && ['uri', 'url'].includes((attr('type') || '').toLowerCase()) && isWeb(s)) h.msUri ||= s;
    });
    // The datum of the header's coordinates: TEI's default, where geoDecl gives none, is WGS84.
    else if (/encodingDesc\/geoDecl$/.test(path)) h.geoDecls.push(attr('datum') || 'WGS84');
    else if (/\/prefixDef$/.test(path)) { h.prefixDefs.push({ ident: attr('ident'), match: attr('matchPattern'), replace: attr('replacementPattern') }); this.prefixCache = null; }
  }

  // ---- the events --------------------------------------------------------------------------------
  capture(onDone, extra = {}) { const c = new Capture(this.stack.length); c.onDone = onDone; c.inNoteFrom = this.inNote + 1; Object.assign(c, extra); this.captures.push(c); return c; }
  text(t) {
    if (this.inPunctuation) t = ' ';
    for (const c of this.captures) if (this.inNote < c.inNoteFrom) c.text(t);
  }
  open(t) {
    const tei = t.uri === TEI_NS, local = t.local;
    const attr = (n) => t.attributes[n]?.value;
    const parent = this.stack[this.stack.length - 1];
    if (!parent) {
      this.sawRoot = true;
      if (!tei || (local !== 'TEI' && local !== 'teiCorpus')) throw new DataError(`This XML document is not TEI: its root element is <${t.name}>${t.uri ? ` in the namespace ${t.uri}` : ''}, not <TEI> or <teiCorpus> in the TEI namespace (${TEI_NS}).`);
    }
    const lang = attr('xml:lang') ?? parent?.lang;
    const el = { local, tei, lang, name: t.name };
    if (local === 'provenance') el.provenance = attr('type') || '';
    this.stack.push(el);
    const depth = this.stack.length;
    // A <choice> or <app>, and its parts, for every capture open around it.
    if (parent?.choice) { el.part = true; parent.parts.push(local); for (const c of this.captures) c.partOpen(local, depth); }
    if (tei && (local === 'choice' || local === 'app')) { el.choice = true; el.parts = []; el.deferred = []; for (const c of this.captures) c.choiceOpen(depth); }
    if (tei && local === 'note') { this.inNote++; el.note = true; }
    if (tei && local === 'g' && PUNCTUATION_GLYPH.test(`${(attr('ref') || '').split(/[#/]/).pop()} ${attr('type') || ''}`)) {
      this.inPunctuation = (this.inPunctuation || 0) + 1; el.punctuation = true;
      for (const c of this.captures) if (this.inNote < c.inNoteFrom) c.text(' ');
    }
    if (tei && BREAKS.has(local)) for (const c of this.captures) c.brk(attr('break') === 'no');
    if (!tei) return;

    if (local === 'TEI' || local === 'teiCorpus') {
      this.scopes.push({ hdr: { titles: [], authors: [], editors: [], idnos: [], licences: [], sourceDescs: [], prefixDefs: [], geoDecls: [], queue: [] } });
      this.prefixCache = null;
      this.page = undefined; this.line = undefined; this.divs = []; this.milestones = new Map();
      return;
    }
    if (local === 'teiHeader') { this.inHeader++; el.header = true; el.hpath = 'teiHeader'; return; }
    if (this.inHeader) { el.hpath = `${parent.hpath}/${local}`; this.headerField(el.hpath, t); }
    if (local === 'text' && !this.inHeader) {
      if (!this.inText) { this.editionSeen = false; this.editionDecided = false; this.topDiv = null; this.late = null; this.undecidedReported = false; this.textLine = this.parser.line; }
      this.inText++; el.textRoot = true;
    }

    // Where in the text: divisions, pages, lines, milestones.
    if (this.inText) {
      if (DIVS.test(local)) {
        const type = attr('type'), label = [type === 'textpart' ? attr('subtype') || type : type, attr('n')].filter(Boolean).join(' ');
        if (!this.divs.length) {
          el.topDiv = true; this.topDiv = { type };
          // Any other top-level div, of whatever type, may come before an edition div: its place
          // names wait for it (deliver).
          if (type === 'edition') {
            if (this.late && !this.editionSeen) this.report('tei-editorial-late-edition', `an edition part began on line ${this.parser.line}, after ${this.late.count.toLocaleString('en')} place names in other parts (${[...this.late.types].join(', ')}) had been converted as the source's words`);
            this.editionSeen = true; this.decide(true);
          }
        }
        this.divs.push(label); el.div = true; this.line = undefined; this.milestones = new Map();
      } else if (local === 'pb') { this.page = attr('n'); this.line = undefined; }
      else if (local === 'lb') { if (attr('n') !== undefined) this.line = attr('n'); }
      else if (local === 'l') el.verse = attr('n');
      else if (local === 'milestone' && attr('unit') && attr('n') !== undefined) this.milestones.set(attr('unit'), attr('n'));
    }

    // A list of places: a <place>, its id, its web address, and what is not read from it.
    if (local === 'place') {
      const pl = { id: attr('xml:id'), uris: [], names: [], geo: [], geos: [], fileLine: this.parser.line }; this.placeStack.push(pl); el.place = pl;
      this.attributes(t, new Set(['xml:id', 'xml:lang', 'xml:space']));
      return;
    }
    const pl = this.placeStack[this.placeStack.length - 1];
    if (pl && local === 'geo' && parent?.location === pl) { this.capture((c) => pl.geos.push(norm(c.pref))); return; }
    if (pl && local === 'geo' && parent?.otherLocation) { this.capture((c) => parent.otherLocation.geos.push(norm(c.pref))); return; }
    if (pl && parent?.place === pl) {
      if (local === 'idno') {
        this.capture((c) => {
          const s = norm(c.pref), r = placeAddress(s);
          if (r.lost) { this.report(WHG_LOST[r.lost], `#${pl.id ?? ''}: ${r.value}`); return; }
          if (r.part) this.report('address-pleiades-part', `#${pl.id ?? ''}: ${r.iri}`);
          if (r.page) this.report('address-web-page', `#${pl.id ?? ''}: ${r.iri}`);
          if (isWeb(r.iri)) { if (!pl.uris.some((u) => u.iri === r.iri)) pl.uris.push(r.from ? { iri: r.iri, from: r.from, rules: r.rules } : { iri: r.iri }); }
          else this.report('tei-place-content', `${pl.id !== undefined ? `#${pl.id}` : 'a place with no xml:id'}: <idno${t.attributes.type ? ` type="${t.attributes.type.value}"` : ''}> ${s}`);
        });
        return;
      }
      if (local === 'location') {
        // Only the place's own location: one whose type says it is another place's (Schnitzler's
        // type="located_in_place", the district or street the place is in) is that place's, and is
        // reported, not read as this place's coordinates or names.
        const type = attr('type');
        if (type !== undefined && OTHER_PLACE_LOCATION.test(type)) {
          const other = el.otherLocation = { names: [], geos: [] };
          this.capture((c) => {
            const words = [other.names.join(', '), other.geos.length ? `(${other.geos.join('; ')})` : ''].filter(Boolean).join(' ') || norm(c.pref) || 'empty';
            this.report('tei-listplace-geo-other-place', `${pl.id !== undefined ? `#${pl.id}` : 'a place with no xml:id'}: ${type}: ${words}`);
          });
          return;
        }
        el.location = pl; this.capture((c) => { pl.geo.push(norm(c.pref) || 'a location'); }); return;
      }
      if (!PLACE_CHILDREN.has(local)) this.once('tei-place-content', `${pl.id !== undefined ? `#${pl.id}` : 'a place with no xml:id'}: <${local}>`);
    }

    // With headerPlaces, an <origPlace> with a ref is a place name of the place of origin.
    if (!this.isPlace(t) && !(local === 'origPlace' && this.inHeader && this.reading.headerPlaces && attr('ref') !== undefined)) return;
    const ref = attr('ref');
    // An ethnic (<placeName type="ethnic">Σελινόντιοι</placeName>) names the people of a place, not
    // the place: it is not a toponym, and is not converted.
    if (attr('type') === 'ethnic' && this.inText) {
      this.capture((c) => this.report('tei-place-ethnic', `${norm(c.pref) || `<${t.name}>`}${ref !== undefined ? ` (${norm(ref)})` : ''} on line ${this.parser.line}`));
      return;
    }
    // A place name in a description of a person, an organisation, an event or a book describes it,
    // not a passage of the text: reported with where it stands, and not converted.
    const record = this.stack.findIndex((e) => e.tei && RECORDS.has(e.local));
    if (record >= 0 && this.inText) {
      const path = this.stack.slice(record).map((e) => e.local).join('/');
      if (ref !== undefined) this.capture((c) => this.report('tei-place-in-record', `${path}: ${norm(c.pref) || `<${t.name}>`} (${norm(ref)})`));
      return;
    }
    // A place name in a list of places describes the place listed, not a passage that names it.
    // Only a name that is the place's own child is its name: one in a <location> is part of that
    // location (its own, read as words, or another place's, reported above), not a name of this place.
    if (pl && parent?.otherLocation) { const o = parent.otherLocation; this.capture((c) => { const s = norm(c.pref); if (s) o.names.push(s); }); return; }
    if (pl) { if (parent?.place === pl) this.capture((c) => { const s = norm(c.pref); if (s) pl.names.push({ text: s, lang: this.stack[this.stack.length - 1].lang }); }); return; }
    // A place name outside the text (in the teiHeader, where EpiDoc says where an inscription was
    // found; in a <standOff>, a <facsimile>) is the edition's description of the document, not a
    // name the text attests. It is reported where it points to a place; without a ref (a
    // <settlement> in a manuscript's identifier, where it is kept) it is only part of the header.
    if (!this.inText) {
      if (this.inHeader && ref !== undefined && norm(ref) && this.reading.headerPlaces && this.headerPlaceKind()) { this.headerMention(t); return; }
      if (ref !== undefined) this.capture((c) => this.report('tei-place-outside-text', `${this.inHeader ? 'teiHeader' : `<${this.outsideWhere()}>`}: ${norm(c.pref) || `<${t.name}>`} (${norm(ref)})`));
      return;
    }
    // A place name in the text, notes and commentary included: the source is the edition, and the
    // locator says where in it the words stand.
    if (ref !== undefined) this.attributes(t, READ_ATTRIBUTES, GENERAL_NAMES.has(local) ? 'type' : undefined);
    const nested = this.inPlaceMention > 0;
    this.inPlaceMention++; el.mention = true;
    const where = this.where();
    const startLine = el.verse ?? this.verseLine() ?? this.line;
    const fileLine = this.parser.line;
    const editorial = this.editorialPart();
    // So too a place name in the text outside any top-level div and outside a note.
    if (editorial === undefined && !this.topDiv && !this.editionDecided) this.decide(false);
    this.capture((c) => this.mention(t, c, { where, startLine, nested, fileLine, editorial }), { hasRef: false });
  }
  close_(t) {
    const el = this.stack[this.stack.length - 1];
    const depth = this.stack.length;
    // The captures opened at this element are read now, innermost first.
    for (let i = this.captures.length - 1; i >= 0; i--) {
      const c = this.captures[i];
      if (c.depth === depth) { this.captures.splice(i, 1); c.onDone(c); }
    }
    if (el.choice) for (const c of this.captures) c.choiceClose(depth);
    if (el.choice && el.deferred.length) this.choiceDone(el);
    if (el.part) for (const c of this.captures) c.partClose(depth);
    if (el.note) this.inNote--;
    if (el.punctuation) this.inPunctuation--;
    if (el.mention) this.inPlaceMention--;
    if (el.div) { this.divs.pop(); this.line = undefined; this.milestones = new Map(); }
    if (el.topDiv) this.topDiv = null;
    if (el.textRoot && --this.inText === 0 && !this.editionDecided) this.decide(false);
    if (el.msIdentifier) { const h = this.scopes[this.scopes.length - 1].hdr; if (h.msParts.length) h.sourceDescs.push(h.msParts.join(', ')); h.msParts = undefined; }
    if (el.place) this.placeDone(el.place);
    if (el.header) {
      this.inHeader--;
      const scope = this.scopes[this.scopes.length - 1];
      scope.hdr.read = true;
      this.firstHdr ||= scope.hdr;
      this.header();
      // What waited for the whole header (a list of places, the places it describes), now that it is read.
      for (const q of scope.hdr.queue.splice(0)) q();
    }
    if (el.tei && (el.local === 'TEI' || el.local === 'teiCorpus')) { this.scopes.pop(); this.prefixCache = null; }
    this.stack.pop();
  }
  /** Report each attribute of an element that is not read, once for each attribute and value. */
  attributes(t, read, alsoRead) {
    for (const a of Object.values(t.attributes)) {
      if (read.has(a.name) || a.name === alsoRead || a.name === 'xmlns' || a.prefix === 'xmlns') continue;
      this.once('tei-attribute', `${t.local}@${a.name}="${a.value}"`);
    }
  }
  /** Report a kind with an example once only, however often the example recurs. */
  once(kind, example) {
    const k = kind + '\u0001' + example;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.report(kind, example);
  }
  isPlace(t) {
    if (PLACE_ELEMENTS.has(t.local)) return true;
    return GENERAL_NAMES.has(t.local) && t.attributes.type?.value === 'place';
  }
  outsideWhere() { const e = [...this.stack].reverse().find((x) => x.tei && ['standOff', 'facsimile', 'sourceDoc'].includes(x.local)); return e ? e.local : this.stack[1]?.local || 'TEI'; }
  verseLine() { for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i].verse !== undefined) return this.stack[i].verse; return undefined; }
  /** Where the element stands, apart from its line: divisions, milestones, page, note. */
  where() {
    const bits = this.divs.filter(Boolean);
    for (const [unit, n] of this.milestones) bits.push(`${unit} ${n}`);
    if (this.page !== undefined) bits.push(`page ${this.page}`);
    return bits;
  }
  placeDone(pl) {
    this.placeStack.pop();
    if (pl.id !== undefined) this.places.set(pl.id, { uris: pl.uris });
    const which = pl.id !== undefined ? `#${pl.id}` : 'a place with no xml:id';
    if (!this.reading.listPlaces) {
      if (pl.names.length) this.report('tei-listplace-names', `${which}: ${pl.names.map((n) => n.text).join(', ')}`);
      if (pl.geo.length) this.report('tei-listplace-geo', `${which}: ${pl.geo.join('; ')}`);
    } else if (this.inHeader) {
      // A list of places in the teiHeader (a settingDesc, a sourceDesc) waits for the end of the
      // header: the header's title, address and geoDecl may come after it, and the source is built
      // once, from the header as read.
      this.scopes[this.scopes.length - 1].hdr.queue.push(() => this.listPlace(pl));
    } else this.listPlace(pl);
    // Place names waiting for this place can be resolved now.
    const waiting = pl.id !== undefined && this.waitingFor.get(pl.id);
    if (waiting) {
      this.waitingFor.delete(pl.id);
      for (const m of waiting) if (--m.waiting === 0) { this.pending.delete(m); this.emit(m, false); }
    }
  }

  /**
   * A place in a list of places, read with the reading option listPlaces: one attestation for the
   * one web address its idnos give (several: ambiguous, reported, nothing converted), its first name the headword (formStatus Headword: the form the edition
   * files the place under), its other names reported. Its coordinates are carried only where they can
   * be the editors' own: the place's address is on the edition's own site (the host of the
   * publicationStmt's idno of type URI, never a DOI), and the header declares no datum but WGS84.
   */
  listPlace(pl) {
    const which = pl.id !== undefined ? `#${pl.id}` : 'a place with no xml:id';
    const words = pl.names.map((n) => n.text).join(', ') || 'no name';
    if (!pl.uris.length) { this.report('tei-listplace-no-address', `${which}: ${words}`); return; }
    // Several different addresses: which place is meant cannot be told, as for a ref to it (tei-ref-ambiguous).
    // Two forms of one address (http and https) were made one as the idnos were read.
    if (pl.uris.length > 1) { this.report('tei-listplace-ambiguous', `${which}: ${pl.uris.map((u) => u.iri).join(', ')}`); return; }
    if (!pl.names.length) { if (pl.geo.length) this.report('tei-listplace-geo', `${which}: ${pl.geo.join('; ')}`); return; }
    const [head, ...variants] = pl.names;
    if (variants.length) this.report('tei-listplace-variant', `${which}: ${variants.map((n) => n.text).join(', ')}`);
    const name = { toponym: head.text };
    if (head.lang !== undefined && head.lang !== '') {
      if (LANGUAGE_TAG.test(head.lang)) name.language = head.lang;
      else this.report('tei-lang-not-tag', head.lang);
    }
    const source = this.source();
    // The coordinates, if any can be carried: parsed, and in a datum PLATO's coordinates can take.
    let points = [];
    if (pl.geos.length) {
      const datum = this.scopes.flatMap((s) => s.hdr.geoDecls).find((d) => d.toUpperCase() !== 'WGS84');
      for (const g of pl.geos) {
        const p = parseGeo(g);
        if (!p) { this.report('tei-listplace-geo-invalid', `${which}: ${g || 'an empty geo'}`); continue; }
        const { lat, lon } = p;
        if (datum) { this.report('tei-listplace-geo-datum', `${which}: ${g} (datum ${datum})`); continue; }
        points.push({ lat, lon, label: g });
      }
    } else if (pl.geo.length) this.report('tei-listplace-geo', `${which}: ${pl.geo.join('; ')}`);
    const own = this.ownHost();
    const locator = `list of places${pl.id !== undefined ? `, place ${pl.id}` : ''}`;
    if (!this.headed) this.header();
    for (const u of pl.uris) {
      const att = { about: u.iri, names: [{ ...name }], formStatus: HEADWORD };
      if (points.length) {
        if (own && hostOf(u.iri) === own) att.geometries = points.map((p) => ({ reprPoint: [p.lon, p.lat], geojson: { type: 'Point', coordinates: [p.lon, p.lat] }, sourceLabel: p.label }));
        else this.report('tei-listplace-geo-gazetteer', `${which}: ${points.map((p) => p.label).join('; ')} (${u.iri})`);
      }
      att.citations = [{ source, locator }];
      const notes = [];
      if (u.from) notes.push(addressNote(u));
      notes.push(`From TEI element <place${pl.id !== undefined ? ` xml:id="${pl.id}"` : ''}> on line ${pl.fileLine} of ${this.fileName}`);
      att.notes = notes.join('\n');
      this.attestations++;
      this.out.push({ type: 'attestation', value: att });
    }
  }
  // ---- places in the teiHeader (headerPlaces) -----------------------------------------------------
  // EpiDoc's header says where the object was found (<provenance type="found">) and where it was made
  // (<origin>/<origPlace>), naming the places in the editors' words. With the reading option
  // headerPlaces (held, like commentaryPlaces, until PLATO pins its Editorial form status), such a
  // place name with a ref is converted, marked as the editors' form: a findspot with the relation
  // FindspotOf to the object, a place of origin as a plain attestation with a note, PLATO having no
  // relation for it. Each waits for the end of the header, and its ref is resolved then, with the
  // prefixDefs in force then (they are in the encodingDesc, after the sourceDesc).
  /** 'found' for a place name in a provenance of type found, 'origin' for one in an origin, else undefined. */
  headerPlaceKind() {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const e = this.stack[i];
      if (!e.tei) continue;
      if (e.provenance !== undefined) return e.provenance === 'found' ? 'found' : undefined;
      if (e.local === 'origin') return 'origin';
    }
    return undefined;
  }
  headerMention(t) {
    const attr = (n) => t.attributes[n]?.value;
    const kind = this.headerPlaceKind(), fileLine = this.parser.line;
    const hdr = this.scopes[this.scopes.length - 1].hdr;
    this.attributes(t, READ_ATTRIBUTES, GENERAL_NAMES.has(t.local) ? 'type' : undefined);
    this.capture((c) => {
      const toponym = norm(c.pref), printed = norm(c.printed), ref = norm(attr('ref'));
      if (!toponym) { this.report('tei-place-empty', `<${t.name} ref="${ref}"> on line ${fileLine}`); return; }
      const el = this.stack[this.stack.length - 1];
      let language;
      if (el.lang !== undefined && el.lang !== '') { if (LANGUAGE_TAG.test(el.lang)) language = el.lang; else this.report('tei-lang-not-tag', el.lang); }
      const m = {
        element: t.name, key: attr('key'), xmlId: attr('xml:id'), toponym, printed: printed !== toponym ? printed : undefined, language, fileLine,
        locator: kind === 'found' ? 'teiHeader, provenance (found)' : 'teiHeader, origin', pointers: ref.split(' '),
        editorial: 'teiHeader', editorialNote: "The name is the editors' form, in the edition's header, not words of the source.",
      };
      hdr.queue.push(() => this.headerPlace(m, kind));
    });
  }
  /** A header place name, at the end of the header: its source, prefixes and relation are those of the whole header. */
  headerPlace(m, kind) {
    m.source = this.source(); m.prefixes = this.prefixes();
    const words = `${m.toponym} (${m.pointers.join(' ')})`;
    if (kind === 'found') {
      const scope = [...this.scopes].reverse().find((s) => s.hdr.read);
      const h = scope.hdr;
      // The object: its own address in the msIdentifier, else the edition's address; never a DOI,
      // which is a deposit of the edition, not the object.
      const own = h.idnos.find((i) => ['uri', 'url'].includes((i.type || '').toLowerCase()) && isWeb(i.text));
      const object = h.msUri || own?.text;
      if (object) {
        // relationLabel would be the source's own words for the relation; the header's coded "found"
        // is not words, so it is left out.
        m.relation = { relatesTo: object, relationType: FINDSPOT_OF };
        const title = this.mainTitle(h);
        if (title) m.relation.relatedLabel = title;
      } else this.report('tei-findspot-no-object', words);
    } else {
      m.extraNotes = ["The edition's header gives this as the place of origin (where the object was made, or the text composed or inscribed); PLATO has no relation for a place of origin."];
      this.report('tei-header-origin', words);
    }
    // As a name in the text: one whose ref points to a <place> not read yet (in <back>, say) waits for it.
    this.place({ m }, undefined);
  }

  /** The host of the edition's own address (its publicationStmt idno of type URI or URL), or undefined: a DOI is a deposit, not the edition's site. */
  ownHost() {
    const scope = [...this.scopes].reverse().find((s) => s.hdr.read) || this.scopes[this.scopes.length - 1];
    const uri = scope?.hdr.idnos.find((i) => ['uri', 'url'].includes((i.type || '').toLowerCase()) && isWeb(i.text));
    return uri ? hostOf(uri.text) : undefined;
  }

  // ---- one place name ------------------------------------------------------------------------------
  mention(t, c, { where, startLine, nested, fileLine, editorial }) {
    const attr = (n) => t.attributes[n]?.value;
    const ref = attr('ref'), key = attr('key'), xmlId = attr('xml:id');
    const toponym = norm(c.pref), printed = norm(c.printed);
    const el = this.stack[this.stack.length - 1];
    let d, made;
    const hasRef = ref !== undefined && !!norm(ref);
    if (!hasRef) {
      // A place name with no ref points to no place. One inside another place name is part of that
      // name ("<placeName><settlement>Roma</settlement></placeName>"), and one around a place name
      // that has a ref is only its wrapping: neither is reported. Its key, with a pattern for the
      // key's prefix, can make its address.
      if (nested || c.hasRef) return;
      made = key !== undefined && norm(key) ? this.fromKey(key) : undefined;
      if (!made) d = { noRef: true, words: `${toponym || `<${t.name}>`}${key ? ` (key ${key})` : ''}` };
      else if (made.lost) d = { lost: true };
    }
    if (!d) {
      for (const o of this.captures) if (o.hasRef !== undefined) o.hasRef = true;
      const line = el.verse ?? this.verseLine() ?? this.line;
      const lineWords = el.verse !== undefined || this.verseLine() !== undefined ? `line ${line}`
        : startLine !== undefined && line !== undefined && startLine !== line ? `lines ${startLine} to ${line}` : line !== undefined ? `line ${line}` : undefined;
      const locator = [...where, lineWords, this.inNote ? 'in a note' : undefined, xmlId ? `xml:id ${xmlId}` : undefined].filter(Boolean).join(', ');
      let language;
      if (el.lang !== undefined && el.lang !== '') {
        if (LANGUAGE_TAG.test(el.lang)) language = el.lang;
        else this.report('tei-lang-not-tag', el.lang);
      }
      // Only what the attestation needs, and what is shared (the source, the prefixDefs) by
      // reference: a place name may wait until the end of the file for a <place>.
      d = { m: {
        element: t.name, key, xmlId, toponym, printed: printed !== toponym ? printed : undefined, language, locator,
        fileLine, source: this.source(), pointers: hasRef ? norm(ref).split(' ') : [], prefixes: this.prefixes(),
        ...(made ? { keyAddress: made.address, keyNote: made.note } : {}),
      } };
      d.m.pointerWords = hasRef ? norm(ref) : `key ${norm(key)}`;
    }
    d.element = t.name; d.fileLine = fileLine; d.toponym = toponym; d.editorial = editorial;
    this.route(d, this.stack.length - 1);
  }
  /**
   * The address a key makes, with the pattern given for its prefix: { address, note }, or { lost }
   * having reported why not, or undefined where no pattern is given for its prefix (counted, for
   * tei-key-no-pattern).
   */
  fromKey(key) {
    const k = norm(key), { prefix, rest } = splitKey(k);
    this.onKey?.(prefix, k, rest);
    // Only a pattern given for the prefix: never a member every object has ("constructor", "toString").
    const kp = this.reading.keyPatterns;
    const pattern = kp && Object.hasOwn(kp, prefix) ? kp[prefix] : undefined;
    if (pattern === undefined) {
      const w = this.keysWithout.get(prefix) || { count: 0, examples: [], rests: [] };
      w.count++;
      if (w.examples.length < 3 && !w.examples.includes(k)) w.examples.push(k);
      if (w.rests.length < SAMPLES) w.rests.push(rest);
      this.keysWithout.set(prefix, w);
      return undefined;
    }
    const r = addressFromPattern(rest, pattern);
    if (r.error || r.lost === 'shape' || (!r.lost && !isWeb(r.iri))) { this.report('tei-key-shape', `${k} (pattern ${pattern})`); return { lost: true }; }
    if (r.lost) { this.report(WHG_LOST[r.lost], `${r.value} (key ${k})`); return { lost: true }; }
    if (r.part) this.report('address-pleiades-part', `${r.iri} (key ${k})`);
    if (r.page) this.report('address-web-page', `${r.iri} (key ${k})`);
    return { address: { iri: r.iri, ...(r.from ? { from: r.from, rules: r.rules } : {}) }, note: `Place address made from the key ${k} with the pattern ${pattern}` };
  }
  /** The prefixDefs in force, innermost first: one array, made again only when a prefixDef or a TEI element comes or goes. */
  prefixes() {
    return (this.prefixCache ||= this.scopes.flatMap((s) => s.hdr.prefixDefs).reverse());
  }
  /**
   * Where a place name goes, looking outwards from the element at stack index `from`: inside an
   * <rdg>, it is a variant reading, reported and not converted; inside a part of a <choice>, it
   * waits until the <choice> closes, when which part is taken is known; else it is delivered.
   */
  route(d, from) {
    for (let i = from; i >= 0; i--) {
      const e = this.stack[i];
      if (!e.tei) continue;
      if (e.local === 'rdg') { this.variant(d, 'rdg'); return; }
      if (e.part && i > 0 && this.stack[i - 1].local === 'choice' && this.stack[i - 1].tei) { this.stack[i - 1].deferred.push({ part: e.local, d }); return; }
    }
    this.deliver(d);
  }
  /** A <choice> closes: its place names in the part taken go on; the others are variants, or the sourceLabel of one taken. */
  choiceDone(el) {
    const pick = (order) => order.find((n) => el.parts.includes(n));
    const taken = pick(PREFERRED) || el.parts[0];
    const printed = pick(PRINTED.filter((n) => n !== 'lem'));
    const kept = el.deferred.filter((x) => x.part === taken && x.d.m);
    for (const x of el.deferred) {
      if (x.part === taken) continue;
      // The form as printed of a place name the part taken also names, with the same ref.
      const same = x.part === printed && x.d.m && kept.find((k) => !k.labelled && k.d.m.pointerWords === x.d.m.pointerWords);
      if (same) { same.labelled = true; if (x.d.toponym && x.d.toponym !== same.d.m.toponym) same.d.m.printed = x.d.toponym; continue; }
      this.variant(x.d, x.part);
    }
    const at = this.stack.length - 2;   // the <choice> is still the innermost element
    for (const x of el.deferred) if (x.part === taken) this.route(x.d, at);
  }
  variant(d, part) {
    this.mentions++; this.countOne();
    this.once('tei-variant', `${part}: ${d.toponym || `<${d.element}>`} (<${d.element}>${d.m ? (d.m.pointers.length ? ` ref="${d.m.pointers.join(' ')}"` : ` ${d.m.pointerWords}`) : ''} on line ${d.fileLine})`);
  }
  deliver(d) {
    this.mentions++; this.countOne();
    if (d.noRef) { this.report('tei-place-no-ref', d.words); return; }
    if (d.lost) return;
    const m = d.m;
    // A place name with no words (<placeName ref="…"/>) gives no name to attest.
    if (!m.toponym) { this.report('tei-place-empty', `<${m.element}${m.pointers.length ? ` ref="${m.pointers.join(' ')}"` : ` ${m.pointerWords}`}> on line ${m.fileLine}`); return; }
    if (d.editorial && !this.editionSeen && !this.editionDecided) {
      if (this.held.length < HOLD_CAP) { this.held.push(d); return; }
      // Too many to hold: read as a text with no edition div, from here on.
      if (!this.undecidedReported) { this.undecidedReported = true; this.report('tei-editorial-undecided', `${HOLD_CAP.toLocaleString('en')} place names held, the next on line ${m.fileLine}, in the <text> beginning on line ${this.textLine}`); }
      this.late = { count: this.held.length, types: new Set(this.held.map((h) => h.editorial)) };
      this.decide(false);
    }
    // A name in a part that would be the editors' if an edition div came, read as the source's words since the cap.
    if (d.editorial && this.late && !this.editionSeen) { this.late.count++; this.late.types.add(d.editorial); }
    this.place(d, this.editionSeen ? d.editorial : undefined);
  }
  /** A place name with words and a ref, whose words are known to be the source's (editorial undefined) or the editors' (the part they are in). */
  place(d, editorial) {
    const m = d.m;
    if (editorial) {
      if (!this.reading.commentaryPlaces) { this.report('tei-place-editorial', `${editorial}: ${m.toponym} (${m.pointerWords}) on line ${m.fileLine}`); return; }
      m.editorial = editorial;
      // The locator names the part, where it does not already ("commentary", "edition, line 3, in a note").
      const named = editorial === 'note' ? /\bin a note\b/.test(m.locator) : m.locator === editorial || m.locator.startsWith(`${editorial} `) || m.locator.startsWith(`${editorial},`);
      if (!named) m.locator = [editorial, m.locator].filter(Boolean).join(', ');
    }
    // How many <place>s, not yet read, the place name waits for (each id once, however often it is given).
    const ids = new Set(m.pointers.filter((p) => p.startsWith('#') && !this.places.has(p.slice(1))).map((p) => p.slice(1)));
    if (!ids.size) { this.emit(m, false); return; }
    m.waiting = ids.size;
    this.pending.add(m);
    for (const id of ids) { const list = this.waitingFor.get(id); if (list) list.push(m); else this.waitingFor.set(id, [m]); }
  }
  /**
   * One pointer of a ref as { iri } or null, having reported why not. This is where a pointer is
   * resolved: a web address as it is, a prefixed pointer through the header's <prefixDef>s, a
   * local pointer (#x) through the <place xml:id="x"> of a list of places in the same file.
   */
  resolve(p, m, final) {
    const words = m.toponym ? ` (${m.toponym})` : '';
    // Every address about to be carried passes through placeAddress, which puts a gazetteer's forms
    // of an address into its one form, rewrites WHG's forms to their persistent address, and refuses
    // the ones that name the wrong thing.
    const address = (v, via) => {
      const r = placeAddress(v);
      if (r.lost) { this.report(WHG_LOST[r.lost], `${r.value}${words}`); return null; }
      if (r.part) this.report('address-pleiades-part', `${r.iri}${words}`);
      if (r.page) this.report('address-web-page', `${r.iri}${words}`);
      return { iri: r.iri, ...(r.from ? { from: r.from, rules: r.rules } : {}), ...(via ? { via } : {}) };
    };
    if (isWeb(p)) return address(p);
    if (p.startsWith('#')) {
      const id = p.slice(1), pl = this.places.get(id);
      if (!pl) { if (final) this.report('tei-ref-local', `${p} (no place with this id in the file)`); return null; }
      if (pl.uris.length === 1) return { ...pl.uris[0], via: p };
      if (pl.uris.length > 1) { this.report('tei-ref-ambiguous', `${p}: ${pl.uris.map((u) => u.iri).join(', ')}`); return null; }
      this.report('tei-ref-local', p);
      return null;
    }
    const colon = /^([A-Za-z][\w.+-]*):(.*)$/.exec(p);
    if (colon) {
      const [, ident, rest] = colon;
      const defs = m.prefixes.filter((d) => d.ident === ident && d.match !== undefined && d.replace !== undefined);
      for (const d of defs) {
        // TEI matches the pattern against everything after the prefix; it is anchored here, so a
        // pattern that matches only part of it does not expand it.
        let re;
        try { re = new RegExp(`^(?:${d.match})$`, 'u'); } catch { continue; }
        if (!re.test(rest)) continue;
        const iri = rest.replace(re, d.replace);
        if (isWeb(iri)) return address(iri, p);
        this.report('tei-ref-not-web', `${p}${words}: expands to ${iri}`);
        return null;
      }
      // A WHG reconciliation id (place:gn:2988507), where no prefixDef declares "place".
      if (!defs.length) { const r = placeAddress(p); if (r.lost || r.from) return address(p); }
      if (!defs.length && SCHEMES.has(ident.toLowerCase())) { this.report('tei-ref-not-web', `${p}${words}`); return null; }
      this.report('tei-ref-prefix', `${p}${words}`);
      return null;
    }
    this.report('tei-ref-relative', `${p}${words}`);
    return null;
  }
  emit(m, final) {
    const resolved = [];
    for (const p of m.pointers) { const r = this.resolve(p, m, final); if (r && !resolved.some((x) => x.iri === r.iri)) resolved.push(r); }
    if (m.keyAddress) resolved.push(m.keyAddress);
    if (!resolved.length) return;
    if (!this.headed) this.header();
    const where = `<${m.element}> on line ${m.fileLine}`;
    if (resolved.length > 1) this.report('tei-ref-several', `${where}: ${resolved.map((r) => r.iri).join(', ')}`);
    const name = m.toponym ? { toponym: m.toponym } : undefined;
    if (name && m.language) name.language = m.language;
    if (name && m.printed && m.printed !== m.toponym) name.sourceLabel = m.printed;
    for (const r of resolved) {
      const att = { about: r.iri };
      if (name) { att.names = [{ ...name }]; att.formStatus = m.editorial ? this.editorialIri : ATTESTED; }
      att.citations = [{ source: m.source, ...(m.locator ? { locator: m.locator } : {}) }];
      if (m.relation) att.relations = [{ ...m.relation }];
      const notes = [];
      if (m.editorial) notes.push(m.editorialNote || "The editors' words, not the source's.");
      if (m.extraNotes) notes.push(...m.extraNotes);
      if (m.keyNote) notes.push(m.keyNote);
      else if (m.key) notes.push(`Key: ${m.key}`);
      if (resolved.length > 1) notes.push(`The ref of this place name gives ${resolved.length} addresses, each an attestation of its own: ${resolved.map((x) => x.iri).join(', ')}.`);
      // Where the attestation came from, as the Recogito reader says "From annotation …". The
      // element's xml:id is not taken for the attestation's @id: the edition can be revised under
      // the same ids, and a published attestation must never change.
      if (r.from) notes.push(addressNote(r));
      notes.push(`From TEI element <${m.element}${m.xmlId ? ` xml:id="${m.xmlId}"` : ''}${r.via ? ` ref="${r.via}"` : ''}> on line ${m.fileLine} of ${this.fileName}`);
      att.notes = notes.join('\n');
      this.attestations++;
      this.out.push({ type: 'attestation', value: att });
    }
  }
}

/** Text chunks of a file, decompressed and decoded, with a break in the bytes as a DataError. */
async function* chunks(file) {
  const reader = (await textStream(file)).getReader();
  try {
    for (;;) {
      let r;
      try { r = await reader.read(); }
      catch (e) { throw e instanceof DataError ? e : new DataError(`The file stops, or is damaged, part-way through, so it cannot be read to the end (${String(e && (e.message || e.name) || e).split('\n')[0]}).`); }
      if (r.done) break;
      yield r.value;
    }
  } finally { reader.releaseLock?.(); }
}

/**
 * TEI (Hermes): each place name in the text whose ref points to a place becomes an
 * attestation-centric attestation about that place. Mirrors annotationSource in
 * src/engine/pipeline.js: yields { type: 'header', value } first, then { type: 'attestation', value, n };
 * every kind the reader reports goes to the report with the severity TEI_KINDS gives it, in the
 * words of LOSS_TEXT. `options` are the run's options, passed to TeiReader.
 */
export async function* teiSource(input, rep, options = {}) {
  const file = input.files[0];
  // The run's options are the reading options; the file's name and the count are the reader's own.
  const reader = new TeiReader((kind, example) => rep.add(TEI_KINDS[kind] || 'loss', kind, LOSS_TEXT[kind] || kind, example),
    { ...options, fileName: file.name, count: () => rep.count('place names') });
  let n = 0;
  const events = function* (evs) { for (const e of evs) yield e.type === 'attestation' ? { ...e, n: ++n } : e; };
  // What a chunk gave before a fault in it is yielded before the fault, so that the part of the file
  // before the problem is checked, as the report says it was.
  const step = function* (read) {
    let evs;
    try { evs = read(); } catch (e) { yield* events(reader.take()); throw e; }
    yield* events(evs);
  };
  for await (const chunk of chunks(file)) yield* step(() => reader.write(chunk));
  yield* step(() => reader.close());
}

/**
 * The prefixes of the keys of a TEI file's place names that have no ref, for a page to offer a
 * pattern for each before the run: [{ prefix, count, examples, suggested }], in the order first
 * met; `suggested` is a pattern where the prefix names a gazetteer most of whose keys fit, else
 * undefined. The file is read as a stream, as teiSource reads it; nothing is converted.
 */
export async function teiKeyPrefixes(input) {
  const file = input.files[0];
  const by = new Map();
  const onKey = (prefix, key, rest) => {
    const p = by.get(prefix) || { prefix, count: 0, examples: [], rests: [] };
    p.count++;
    if (p.examples.length < 3 && !p.examples.includes(key)) p.examples.push(key);
    if (p.rests.length < SAMPLES) p.rests.push(rest);
    by.set(prefix, p);
  };
  const reader = new TeiReader(() => {}, { fileName: file.name, onKey });
  for await (const chunk of chunks(file)) reader.write(chunk);
  reader.close();
  return [...by.values()].map(({ prefix, count, examples, rests }) => ({ prefix, count, examples, suggested: suggestKeyPattern(prefix, rests) }));
}

/** Every attestation of a TEI document given as text, and the document: for tests and small inputs. `options` are reading options. */
export function teiToDocument(text, fileName = 'test.xml', report = () => {}, options = {}) {
  const r = new TeiReader(report, { ...options, fileName });
  const evs = [...r.write(text), ...r.close()];
  return { ...evs.find((e) => e.type === 'header').value, attestations: evs.filter((e) => e.type === 'attestation').map((e) => e.value) };
}
