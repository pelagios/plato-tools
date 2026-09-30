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
import { placeAddress } from './addresses.js';

export const TEI_NS = 'http://www.tei-c.org/ns/1.0';
const ATTESTED = PLATO + 'Attested';
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
  'tei-ref-prefix': 'loss',
  'tei-ref-local': 'loss',
  'tei-ref-ambiguous': 'loss',
  'tei-ref-relative': 'loss',
  'tei-ref-not-web': 'loss',
  'tei-listplace-names': 'loss',
  'tei-listplace-geo': 'loss',
  'tei-lang-not-tag': 'loss',
  'tei-licence-not-address': 'loss',
  'tei-sourcedesc-several': 'loss',
  'tei-whg-record': 'loss',
  'tei-whg-staging': 'loss',
  'tei-attribute': 'loss',
  'tei-place-content': 'loss',
  'tei-variant': 'loss',
  'tei-ref-several': 'warning',
  'tei-source-no-address': 'warning',
  'tei-none-linked': 'warning',
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
// What placeAddress (./addresses.js) says of an address that must not be carried, as a kind here.
const WHG_LOST = { 'whg-portal-record': 'tei-whg-record', 'whg-staging': 'tei-whg-staging' };
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

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const isWeb = (s) => typeof s === 'string' && WEB.test(s) && isAbsoluteIri(s);
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
 * the text (the report's count).
 */
export class TeiReader {
  constructor(report, { fileName = 'the TEI file', count = () => {} } = {}) {
    this.report = report; this.fileName = fileName; this.countOne = count;
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
    const p = this.parser = new SaxesParser({ xmlns: true, position: true });
    p.on('error', (e) => {
      const why = String(e.message).split('\n')[0];
      if (/undefined entity/.test(why)) throw new DataError(`The XML uses an entity (such as &nbsp;) that the file does not declare, so it cannot be read past that point (${why}). Only entities declared with their text in the file's own DOCTYPE, such as <!ENTITY nbsp "&#160;">, are read; an external DTD is never fetched. Declare the entity, or write the character itself.`);
      throw new DataError(`The XML is not well formed, so the file cannot be read past that point (${why}).`);
    });
    p.on('doctype', (d) => this.doctype(d));
    p.on('xmldecl', (d) => {
      // The file is decoded as UTF-8 (as TextDecoderStream does by default); a file that says it is
      // in another encoding would be read with its letters wrong, silently, so it is refused.
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
    // What is still waiting was pointing at a <place> that never came.
    for (const m of this.pending) this.emit(m, true);
    this.pending.clear(); this.waitingFor.clear();
    this.header();
    if (!this.attestations) this.report('tei-none-linked', `${plural(this.mentions, 'place name')} in the text`);
    return this.take();
  }
  take() { const o = this.out; this.out = []; return o; }

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
    else if (/fileDesc\/sourceDesc\/msDesc\/msIdentifier\/[^/]+$/.test(path) && h.msParts && t.local !== 'altIdentifier') cap((c) => { const s = norm(c.pref); if (s) h.msParts.push(s); });
    else if (/\/prefixDef$/.test(path)) { h.prefixDefs.push({ ident: attr('ident'), match: attr('matchPattern'), replace: attr('replacementPattern') }); this.prefixCache = null; }
  }

  // ---- the events --------------------------------------------------------------------------------
  capture(onDone, extra = {}) { const c = new Capture(this.stack.length); c.onDone = onDone; c.inNoteFrom = this.inNote + 1; Object.assign(c, extra); this.captures.push(c); return c; }
  text(t) { for (const c of this.captures) if (this.inNote < c.inNoteFrom) c.text(t); }
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
    this.stack.push(el);
    const depth = this.stack.length;
    // A <choice> or <app>, and its parts, for every capture open around it.
    if (parent?.choice) { el.part = true; parent.parts.push(local); for (const c of this.captures) c.partOpen(local, depth); }
    if (tei && (local === 'choice' || local === 'app')) { el.choice = true; el.parts = []; el.deferred = []; for (const c of this.captures) c.choiceOpen(depth); }
    if (tei && local === 'note') { this.inNote++; el.note = true; }
    if (tei && BREAKS.has(local)) for (const c of this.captures) c.brk(attr('break') === 'no');
    if (!tei) return;

    if (local === 'TEI' || local === 'teiCorpus') {
      this.scopes.push({ hdr: { titles: [], authors: [], editors: [], idnos: [], licences: [], sourceDescs: [], prefixDefs: [] } });
      this.prefixCache = null;
      this.page = undefined; this.line = undefined; this.divs = []; this.milestones = new Map();
      return;
    }
    if (local === 'teiHeader') { this.inHeader++; el.header = true; el.hpath = 'teiHeader'; return; }
    if (this.inHeader) { el.hpath = `${parent.hpath}/${local}`; this.headerField(el.hpath, t); }
    if (local === 'text' && !this.inHeader) { this.inText++; el.textRoot = true; }

    // Where in the text: divisions, pages, lines, milestones.
    if (this.inText) {
      if (DIVS.test(local)) {
        const type = attr('type'), label = [type === 'textpart' ? attr('subtype') || type : type, attr('n')].filter(Boolean).join(' ');
        this.divs.push(label); el.div = true; this.line = undefined; this.milestones = new Map();
      } else if (local === 'pb') { this.page = attr('n'); this.line = undefined; }
      else if (local === 'lb') { if (attr('n') !== undefined) this.line = attr('n'); }
      else if (local === 'l') el.verse = attr('n');
      else if (local === 'milestone' && attr('unit') && attr('n') !== undefined) this.milestones.set(attr('unit'), attr('n'));
    }

    // A list of places: a <place>, its id, its web address, and what is not read from it.
    if (local === 'place') {
      const pl = { id: attr('xml:id'), uris: [], names: [], geo: [] }; this.placeStack.push(pl); el.place = pl;
      this.attributes(t, new Set(['xml:id', 'xml:lang', 'xml:space']));
      return;
    }
    const pl = this.placeStack[this.placeStack.length - 1];
    if (pl && parent?.place === pl) {
      if (local === 'idno') {
        this.capture((c) => {
          const s = norm(c.pref), r = placeAddress(s);
          if (r.lost) { this.report(WHG_LOST[r.lost], `#${pl.id ?? ''}: ${r.value}`); return; }
          if (isWeb(r.iri)) { if (!pl.uris.some((u) => u.iri === r.iri)) pl.uris.push(r.from ? { iri: r.iri, from: r.from } : { iri: r.iri }); }
          else this.report('tei-place-content', `${pl.id !== undefined ? `#${pl.id}` : 'a place with no xml:id'}: <idno${t.attributes.type ? ` type="${t.attributes.type.value}"` : ''}> ${s}`);
        });
        return;
      }
      if (local === 'location') { el.location = pl; this.capture((c) => { pl.geo.push(norm(c.pref) || 'a location'); }); return; }
      if (!PLACE_CHILDREN.has(local)) this.once('tei-place-content', `${pl.id !== undefined ? `#${pl.id}` : 'a place with no xml:id'}: <${local}>`);
    }

    if (!this.isPlace(t)) return;
    const ref = attr('ref');
    // A place name in a list of places describes the place listed, not a passage that names it.
    if (pl) { this.capture((c) => { const s = norm(c.pref); if (s) pl.names.push(s); }); return; }
    // A place name outside the text (in the teiHeader, where EpiDoc says where an inscription was
    // found; in a <standOff>, a <facsimile>) is the edition's description of the document, not a
    // name the text attests. It is reported where it points to a place; without a ref (a
    // <settlement> in a manuscript's identifier, where it is kept) it is only part of the header.
    if (!this.inText) {
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
    this.capture((c) => this.mention(t, c, { where, startLine, nested, fileLine }), { hasRef: false });
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
    if (el.mention) this.inPlaceMention--;
    if (el.div) { this.divs.pop(); this.line = undefined; this.milestones = new Map(); }
    if (el.textRoot) this.inText--;
    if (el.msIdentifier) { const h = this.scopes[this.scopes.length - 1].hdr; if (h.msParts.length) h.sourceDescs.push(h.msParts.join(', ')); h.msParts = undefined; }
    if (el.place) this.placeDone(el.place);
    if (el.header) {
      this.inHeader--;
      const scope = this.scopes[this.scopes.length - 1];
      scope.hdr.read = true;
      this.firstHdr ||= scope.hdr;
      this.header();
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
  outsideWhere() { const e = [...this.stack].reverse().find((x) => x.tei && ['standOff', 'facsimile', 'sourceDoc', 'back', 'front'].includes(x.local)); return e ? e.local : this.stack[1]?.local || 'TEI'; }
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
    if (pl.names.length) this.report('tei-listplace-names', `${which}: ${pl.names.join(', ')}`);
    if (pl.geo.length) this.report('tei-listplace-geo', `${which}: ${pl.geo.join('; ')}`);
    // Place names waiting for this place can be resolved now.
    const waiting = pl.id !== undefined && this.waitingFor.get(pl.id);
    if (waiting) {
      this.waitingFor.delete(pl.id);
      for (const m of waiting) if (--m.waiting === 0) { this.pending.delete(m); this.emit(m, false); }
    }
  }

  // ---- one place name ------------------------------------------------------------------------------
  mention(t, c, { where, startLine, nested, fileLine }) {
    const attr = (n) => t.attributes[n]?.value;
    const ref = attr('ref'), key = attr('key'), xmlId = attr('xml:id');
    const toponym = norm(c.pref), printed = norm(c.printed);
    const el = this.stack[this.stack.length - 1];
    let d;
    if (ref === undefined || !norm(ref)) {
      // A place name with no ref points to no place. One inside another place name is part of that
      // name ("<placeName><settlement>Roma</settlement></placeName>"), and one around a place name
      // that has a ref is only its wrapping: neither is reported.
      if (nested || c.hasRef) return;
      d = { noRef: true, words: `${toponym || `<${t.name}>`}${key ? ` (key ${key})` : ''}` };
    } else {
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
        fileLine, source: this.source(), pointers: norm(ref).split(' '), prefixes: this.prefixes(),
      } };
    }
    d.element = t.name; d.fileLine = fileLine; d.toponym = toponym;
    this.route(d, this.stack.length - 1);
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
    const kept = el.deferred.filter((x) => x.part === taken && !x.d.noRef);
    for (const x of el.deferred) {
      if (x.part === taken) continue;
      // The form as printed of a place name the part taken also names, with the same ref.
      const same = x.part === printed && !x.d.noRef && kept.find((k) => !k.labelled && k.d.m.pointers.join(' ') === x.d.m.pointers.join(' '));
      if (same) { same.labelled = true; if (x.d.toponym && x.d.toponym !== same.d.m.toponym) same.d.m.printed = x.d.toponym; continue; }
      this.variant(x.d, x.part);
    }
    const at = this.stack.length - 2;   // the <choice> is still the innermost element
    for (const x of el.deferred) if (x.part === taken) this.route(x.d, at);
  }
  variant(d, part) {
    this.mentions++; this.countOne();
    this.once('tei-variant', `${part}: ${d.toponym || `<${d.element}>`} (<${d.element}>${d.m ? ` ref="${d.m.pointers.join(' ')}"` : ''} on line ${d.fileLine})`);
  }
  deliver(d) {
    this.mentions++; this.countOne();
    if (d.noRef) { this.report('tei-place-no-ref', d.words); return; }
    const m = d.m;
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
    // Every address about to be carried passes through placeAddress, which rewrites WHG's forms to
    // their persistent address and refuses the ones that name the wrong thing.
    const address = (v, via) => {
      const r = placeAddress(v);
      if (r.lost) { this.report(WHG_LOST[r.lost], `${r.value}${words}`); return null; }
      return { iri: r.iri, ...(r.from ? { from: r.from } : {}), ...(via ? { via } : {}) };
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
    if (!resolved.length) return;
    if (!this.headed) this.header();
    const where = `<${m.element}> on line ${m.fileLine}`;
    if (resolved.length > 1) this.report('tei-ref-several', `${where}: ${resolved.map((r) => r.iri).join(', ')}`);
    const name = m.toponym ? { toponym: m.toponym } : undefined;
    if (name && m.language) name.language = m.language;
    if (name && m.printed && m.printed !== m.toponym) name.sourceLabel = m.printed;
    for (const r of resolved) {
      const att = { about: r.iri };
      if (name) { att.names = [{ ...name }]; att.formStatus = ATTESTED; }
      att.citations = [{ source: m.source, ...(m.locator ? { locator: m.locator } : {}) }];
      const notes = [];
      if (m.key) notes.push(`Key: ${m.key}`);
      if (resolved.length > 1) notes.push(`The ref of this place name gives ${resolved.length} addresses, each an attestation of its own: ${resolved.map((x) => x.iri).join(', ')}.`);
      // Where the attestation came from, as the Recogito reader says "From annotation …". The
      // element's xml:id is not taken for the attestation's @id: the edition can be revised under
      // the same ids, and a published attestation must never change.
      if (r.from) notes.push(`Place address given as ${r.from}`);
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
      catch (e) { throw new DataError(`The file stops, or is damaged, part-way through, so it cannot be read to the end (${String(e && (e.message || e.name) || e).split('\n')[0]}).`); }
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
 * words of LOSS_TEXT.
 */
export async function* teiSource(input, rep) {
  const file = input.files[0];
  const reader = new TeiReader((kind, example) => rep.add(TEI_KINDS[kind] || 'loss', kind, LOSS_TEXT[kind] || kind, example),
    { fileName: file.name, count: () => rep.count('place names') });
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

/** Every attestation of a TEI document given as text, and the document: for tests and small inputs. */
export function teiToDocument(text, fileName = 'test.xml', report = () => {}) {
  const r = new TeiReader(report, { fileName });
  const evs = [...r.write(text), ...r.close()];
  return { ...evs.find((e) => e.type === 'header').value, attestations: evs.filter((e) => e.type === 'attestation').map((e) => e.value) };
}
