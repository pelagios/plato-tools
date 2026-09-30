// PLATO JSON (place-centric or attestation-centric) to RDF triples, one record at a time,
// through the compiled JSON-LD context. Memory is per record: a document's header is read
// once, then each SpatialEntity (or attestation, or identity relation) is converted and
// forgotten. Blank nodes are labelled per record so that labels never collide.
import { RDF, XSD, PLATO, child, expandIri, isAbsoluteIri, compileContext } from '../lib/context.js';
import { iri, bnode, literal } from '../lib/ntriples.js';

const XSD_INTEGER = XSD + 'integer', XSD_DOUBLE = XSD + 'double', XSD_BOOLEAN = XSD + 'boolean';
const RDF_TYPE = iri(RDF + 'type'), RDF_FIRST = iri(RDF + 'first'), RDF_REST = iri(RDF + 'rest'), RDF_NIL = iri(RDF + 'nil');
const RDF_JSON = RDF + 'JSON';
const BOUNDS = new Set(['start_earliest', 'start_latest', 'end_earliest', 'end_latest'].map((x) => PLATO + x));
const REPR_POINT = PLATO + 'repr_point';
const VALUE_LITERAL = PLATO + 'value_literal', VALUE_JSON = PLATO + 'value_json';
const WKT = 'http://www.opengis.net/ont/geosparql#wktLiteral';
// Keys the context deliberately leaves out of the RDF: a conversion to RDF loses their values.
// (Since PLATO 2e32d7e there are none: relationLabel maps to plato:source_label, and
// metaTypeLabel is gone from the schema, so a document using it fails validation instead.)
const NOT_IN_RDF = new Set([]);
// Terms whose values are shared authority nodes (sources), described in full wherever cited.
const SHARED_TERMS = new Set(['sources', 'source', 'derivedFrom']);
const SHARED_CAP = 2_000_000;

/** RFC 8785 JSON canonicalisation, as jsonld.js uses for @json literals. */
export function jcs(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
}
/** The canonical lexical form of an xsd:double, as jsonld.js writes it: 1.06820411E2. */
const canonicalDouble = (n) => n.toExponential(15).replace(/(\d)0*e\+?/, '$1E');
/**
 * A JSON number as a literal: a whole number below 10^21 an xsd:integer, any other an xsd:double.
 * jsonld.js tells a double by a '.' in the number's text, so it writes 1e-7 as "0"^^xsd:integer;
 * here it is "1.0E-7"^^xsd:double, a deliberate departure (DEVELOPERS.md, Numbers). Such a number
 * has one significant digit, so its canonical form is exact.
 */
export function numberLiteral(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return literal(n.toFixed(0), XSD_INTEGER);
  return literal(canonicalDouble(n), XSD_DOUBLE);
}
export function boundDatatype(s) {
  if (/^-?\d{4,}$/.test(s)) return XSD + 'gYear';
  if (/^-?\d{4,}-\d{2}-\d{2}$/.test(s)) return XSD + 'date';
  if (/^-?\d{4,}-\d{2}-\d{2}T/.test(s)) return XSD + 'dateTime';
  return null;
}

/**
 * options.types: { domain: Map<iri, classIri>, range: Map<iri, classIri> } adds rdf:type from the
 *   ontology's declared domains and ranges (the DEEP triplifier's rule).
 * options.typedBounds: timespan bounds typed xsd:gYear / xsd:date / xsd:dateTime by their shape.
 * options.wktPoints: reprPoint written as a geo:wktLiteral POINT, as the ontology declares,
 *   rather than as the RDF list the context produces.
 */
export class Json2Rdf {
  constructor(contextDoc, emit, options = {}) {
    this.root = compileContext(contextDoc);
    this.emit = emit;
    this.opt = options;
    this.issues = options.onIssue || (() => {});
    this.n = 0;
    this.shared = new Set(); this.inShared = false; this.typedNamed = new Map();
  }
  _emit(s, p, o) {
    // A node that appears several times in one record (a shared source or name with an @id) is
    // one node: emit each of its triples once, as jsonld.js does by merging node objects.
    const k = s.termType[0] + s.value + '\u0001' + p.value + '\u0001' + o.termType[0] + o.value + '\u0001' + (o.datatype || '') + (o.language || '');
    if (this.seen.has(k)) return;
    this.seen.add(k);
    // A source with its own IRI is described again in every record that cites it. Across records
    // its triples are emitted once: the set grows with the number of distinct sources, not with the
    // data, and is capped, past which repeats are simply written again (still the same graph).
    if (this.inShared && s.termType === 'NamedNode') {
      if (this.shared.has(k)) return;
      if (this.shared.size < SHARED_CAP) this.shared.add(k);
    }
    this.emit(s, p, o);
  }
  _out(s, p, o) {
    this._emit(s, p, o);
    const t = this.opt.types;
    if (!t) return;
    const d = t.domain.get(p.value);
    if (d) this._type(s, d);
    const r = o.termType !== 'Literal' && t.range.get(p.value);
    if (r) this._type(o, r);
  }
  _type(node, cls) {
    const k = node.termType + node.value + ' ' + cls;
    if (this.typed.has(k)) return;
    this.typed.add(k);
    // A named node (a source, the gazetteer, a relation type, a place another record refers to)
    // is typed once per file rather than once per record that mentions it: N-Triples output must
    // not repeat a line, and DEEP's export is 2.5 million lines shorter for it. The memory is one
    // Set of IRIs per class, so it grows with the distinct named nodes typed, not with the data.
    // (It was once two generations of a 200,000-entry set, which kept memory flat but typed a node
    // again whenever it had aged out of both: 202 repeated lines in DEEP's export, each counted.)
    if (node.termType === 'NamedNode') {
      let done = this.typedNamed.get(cls);
      if (!done) this.typedNamed.set(cls, (done = new Set()));
      if (done.has(node.value)) return;
      done.add(node.value);
    }
    this._emit(node, RDF_TYPE, iri(cls));
  }
  _begin() { this.n++; this.b = 0; this.bmap = new Map(); this.typed = new Set(); this.seen = new Set(); }
  _blank(label) {
    if (label) { let v = this.bmap.get(label); if (!v) { v = `r${this.n}b${this.b++}`; this.bmap.set(label, v); } return bnode(v); }
    return bnode(`r${this.n}b${this.b++}`);
  }
  _id(s, where) {
    if (typeof s !== 'string') { this.issues({ kind: 'unconvertible', value: JSON.stringify(s), where }); return null; }
    if (s.startsWith('_:')) return this._blank(s);
    const v = expandIri(s, this.root.prefixes);
    if (!isAbsoluteIri(v)) { this.issues({ kind: 'relative-iri', value: s, where }); return null; }
    return iri(v);
  }
  _nodeId(obj) {
    if (obj['@id'] === null) { this._null('@id'); return this._blank(); }   // described, but with no address
    return obj['@id'] !== undefined ? this._id(obj['@id'], '@id') : this._blank();
  }
  _null(where) { this.issues({ kind: 'null-value', where }); }

  /** Start a document from its header (everything except the record arrays); returns the document node. */
  header(head) {
    this._begin();
    const gz = head && typeof head.gazetteer === 'object' && head.gazetteer || {};
    if (gz['@id'] === null) this._null('gazetteer.@id');
    const doc = (gz['@id'] !== undefined && gz['@id'] !== null && this._id(gz['@id'], 'gazetteer.@id')) || this._blank();
    this.doc = doc;
    // Whatever a document holds, conversion goes on and says what it could not use: a check must
    // always end with a report, never with an exception.
    try { if (head && typeof head === 'object') this._walk(head, this.root, doc); }
    catch (e) { this.issues({ kind: 'record-failed', value: 'the document header', error: String(e && e.message || e) }); }
    return doc;
  }
  /** One record from a top-level array: 'spatialEntities', 'newSpatialEntities', 'attestations' or 'identityRelations'. */
  record(arrayKey, obj) {
    this._begin();
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      if (obj === null || obj === undefined) this._null(arrayKey); else this.issues({ kind: 'unconvertible', value: JSON.stringify(obj).slice(0, 80), where: arrayKey });
      return;
    }
    try {
      const term = this.root.terms.get(arrayKey);
      const id = this._nodeId(obj);
      if (!id) return;
      this._out(this.doc, iri(term.iri), id);
      this._walk(obj, child(this.root, term), id);
    } catch (e) {
      this.issues({ kind: 'record-failed', value: obj['@id'] || obj.about || obj.subject || arrayKey, error: String(e && e.message || e) });
    }
  }
  _walk(obj, active, subj) {
    for (const [key, val] of Object.entries(obj)) {
      if (key === '@id' || key === '@context') continue;
      if (key === 'spatialEntities' || key === 'newSpatialEntities' || ((key === 'attestations' || key === 'identityRelations') && active === this.root)) {
        if (val === null) this._null(key);
        continue;
      }
      const term = active.terms.get(key);
      // A JSON literal holds its whole value, null and arrays included, exactly as jsonld.js writes it.
      if (term && term.type === '@json' && val !== undefined) { this._out(subj, iri(term.iri), literal(jcs(val), RDF_JSON)); continue; }
      // A structured value (an object, its shape declared by valueType) cannot be a value_literal: the
      // context maps value to plato:value_literal, which would make the object a node and drop its
      // keys. The context's limit (4) leaves it to the triplifier to serialise it into
      // plato:value_json, as the ontology defines: the JSON text, canonical so that it compares.
      if (term && term.iri === VALUE_LITERAL && val && typeof val === 'object' && !Array.isArray(val)) { this._out(subj, iri(VALUE_JSON), literal(jcs(val))); continue; }
      if (val === null || val === undefined) { if (key !== '$schema') this._null(key); continue; }
      if (!term) {
        // A key the context does not name, but which is itself an IRI (or a compact IRI with one of
        // the context's prefixes), is a predicate as it stands, as JSON-LD reads it. PLATO's
        // statistics design (issue #14) relies on this: under a propertyValue's `dimensions` and
        // `attributes`, both nesting keys, each key is a Data Cube dimension or attribute property.
        const pred = key.startsWith('@') ? null : expandIri(key, active.prefixes);
        if (pred && isAbsoluteIri(pred) && !pred.startsWith('_:')) { this._iriKey(iri(pred), key, val, active, subj); continue; }
        this.issues({ kind: 'unmapped-key', value: key }); continue;
      }
      if (term.drop) { if (NOT_IN_RDF.has(key) && val !== null && val !== undefined) this.issues({ kind: 'not-in-rdf', key }); continue; }
      if (term.nest) {
        for (const v of [].concat(val)) {
          if (v && typeof v === 'object') this._walk(v, active, subj);
          else if (v === null || v === undefined) this._null(key);
          else this.issues({ kind: 'unconvertible', value: JSON.stringify(v), where: key });
        }
        continue;
      }
      const c = child(active, term);
      const p = iri(term.iri);
      if (term.container === '@list') {
        if (this.opt.wktPoints && term.iri === REPR_POINT && Array.isArray(val) && val.length === 2) {
          this._out(subj, p, literal(`POINT(${val[0]} ${val[1]})`, WKT)); continue;
        }
        this._out(subj, p, this._list([].concat(val), term, c)); continue;
      }
      for (const v of [].concat(val)) {
        if (v === null || v === undefined) { this._null(key); continue; }
        if (term.reverse) {
          if (typeof v !== 'object') { this.issues({ kind: 'unconvertible', value: JSON.stringify(v), where: key }); continue; }
          const n = this._nodeId(v); if (!n) continue;
          this._out(n, p, subj); this._walk(v, c, n); continue;
        }
        const o = this._value(v, term, c);
        if (!o) continue;
        this._out(subj, p, o);
        if (o.termType !== 'Literal' && typeof v === 'object') {
          const was = this.inShared;
          if (SHARED_TERMS.has(key) && o.termType === 'NamedNode') this.inShared = true;
          this._walk(v, c, o);
          this.inShared = was;
        }
      }
    }
  }
  /** The values of a key that is an IRI, which has no term definition, so no coercion: as jsonld.js writes them. */
  _iriKey(p, key, val, active, subj) {
    for (const v of [].concat(val)) {
      if (v === null || v === undefined) { this._null(key); continue; }
      if (Array.isArray(v)) { this.issues({ kind: 'unconvertible', value: JSON.stringify(v).slice(0, 80), where: key }); continue; }
      if (typeof v !== 'object') { const o = this._value(v, { key }, active); if (o) this._out(subj, p, o); continue; }
      if ('@value' in v) { const o = this._valueObject(v, key, active); if (o) this._out(subj, p, o); continue; }
      if ('@list' in v || '@set' in v) { this.issues({ kind: 'unconvertible', value: JSON.stringify(v).slice(0, 80), where: key }); continue; }
      // A node: a reference ({"@id": IRI}, a code in a code list) or a node with properties of its own.
      const n = this._nodeId(v);
      if (!n) continue;
      this._out(subj, p, n);
      this._walk(v, active, n);
    }
  }
  /** A JSON-LD value object: {"@value": v} with an optional "@type" or "@language". */
  _valueObject(v, key, active) {
    const x = v['@value'];
    if (x === null || x === undefined) { this._null(key); return null; }
    const extra = Object.keys(v).filter((k) => !['@value', '@type', '@language', '@direction', '@index'].includes(k));
    if (extra.length || typeof x === 'object') { this.issues({ kind: 'unconvertible', value: JSON.stringify(v).slice(0, 80), where: key }); return null; }
    if (typeof v['@language'] === 'string' && typeof x === 'string' && v['@type'] === undefined) return literal(x, RDF + 'langString', v['@language'].toLowerCase());
    let dt = typeof v['@type'] === 'string' ? expandIri(v['@type'], active.prefixes) : null;
    if (dt !== null && !isAbsoluteIri(dt)) { this.issues({ kind: 'relative-iri', value: v['@type'], where: key }); return null; }
    if (typeof x === 'number') {
      // jsonld.js: a number with a fraction, or typed xsd:double, is a canonical double; otherwise an integer.
      if (!Number.isInteger(x) || dt === XSD_DOUBLE) return literal(canonicalDouble(x), dt || XSD_DOUBLE);
      return literal(x.toFixed(0), dt || XSD_INTEGER);
    }
    if (typeof x === 'boolean') return literal(String(x), dt || XSD_BOOLEAN);
    return literal(x, dt || undefined);
  }
  _list(items, term, c) {
    let head = RDF_NIL;
    for (let i = items.length - 1; i >= 0; i--) {
      // A null in a list is dropped, as JSON-LD drops it, and reported: a coordinate pair with a
      // null in it is a position that cannot be placed.
      if (items[i] === null || items[i] === undefined) { this._null(`${term.key}[${i}]`); continue; }
      const o = this._value(items[i], term, c);
      if (!o) { this.issues({ kind: 'unconvertible', value: JSON.stringify(items[i]).slice(0, 80), where: `${term.key}[${i}]` }); continue; }
      const node = this._blank();
      this._emit(node, RDF_FIRST, o);
      this._emit(node, RDF_REST, head);
      head = node;
    }
    return head;
  }
  _value(v, term, c) {
    if (v === null || v === undefined) { this._null(term.key); return null; }
    if (term.type === '@json') return literal(jcs(v), RDF_JSON);
    if (typeof v === 'object') return this._nodeId(v);
    if (typeof v === 'string') {
      if (term.type === '@id') return this._id(v, term.key);
      if (term.type === '@vocab') {
        const t = c.terms.get(v);
        const x = t && t.iri ? t.iri : expandIri(v, c.prefixes);
        if (!isAbsoluteIri(x)) { this.issues({ kind: 'relative-iri', value: v, where: term.key }); return null; }
        return iri(x);
      }
      if (term.type) return literal(v, term.type);
      if (this.opt.typedBounds && BOUNDS.has(term.iri)) { const dt = boundDatatype(v); if (dt) return literal(v, dt); }
      return literal(v);
    }
    if (typeof v === 'number') return term.type && !term.type.startsWith('@') ? literal(String(v), term.type) : numberLiteral(v);
    if (typeof v === 'boolean') return literal(String(v), XSD_BOOLEAN);
    return null;
  }
}
