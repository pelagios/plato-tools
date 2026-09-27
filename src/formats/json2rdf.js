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
const WKT = 'http://www.opengis.net/ont/geosparql#wktLiteral';
// Keys the context deliberately leaves out of the RDF: a conversion to RDF loses their values.
const NOT_IN_RDF = new Set(['relationLabel', 'metaTypeLabel']);
// Terms whose values are shared authority nodes (sources), described in full wherever cited.
const SHARED_TERMS = new Set(['sources', 'source', 'derivedFrom']);
const SHARED_CAP = 2_000_000;

/** RFC 8785 JSON canonicalisation, as jsonld.js uses for @json literals. */
export function jcs(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
}
function numberLiteral(n) {
  if (String(n).includes('.') || Math.abs(n) >= 1e21 || !Number.isFinite(n)) return literal(n.toExponential(15).replace(/(\d)0*e\+?/, '$1E'), XSD_DOUBLE);
  return literal(n.toFixed(0), XSD_INTEGER);
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
    this.shared = new Set(); this.inShared = false;
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
    this._emit(node, RDF_TYPE, iri(cls));
  }
  _begin() { this.n++; this.b = 0; this.bmap = new Map(); this.typed = new Set(); this.seen = new Set(); }
  _blank(label) {
    if (label) { let v = this.bmap.get(label); if (!v) { v = `r${this.n}b${this.b++}`; this.bmap.set(label, v); } return bnode(v); }
    return bnode(`r${this.n}b${this.b++}`);
  }
  _id(s, where) {
    if (s.startsWith('_:')) return this._blank(s);
    const v = expandIri(s, this.root.prefixes);
    if (!isAbsoluteIri(v)) { this.issues({ kind: 'relative-iri', value: s, where }); return null; }
    return iri(v);
  }
  _nodeId(obj) { return obj['@id'] !== undefined ? this._id(obj['@id'], '@id') : this._blank(); }

  /** Start a document from its header (everything except the record arrays); returns the document node. */
  header(head) {
    this._begin();
    const gz = head.gazetteer || {};
    const doc = gz['@id'] !== undefined ? this._id(gz['@id'], 'gazetteer.@id') : this._blank();
    this.doc = doc;
    this._walk(head, this.root, doc);
    return doc;
  }
  /** One record from a top-level array: 'spatialEntities', 'newSpatialEntities', 'attestations' or 'identityRelations'. */
  record(arrayKey, obj) {
    this._begin();
    const term = this.root.terms.get(arrayKey);
    const id = this._nodeId(obj);
    if (!id) return;
    this._out(this.doc, iri(term.iri), id);
    this._walk(obj, child(this.root, term), id);
  }
  _walk(obj, active, subj) {
    for (const [key, val] of Object.entries(obj)) {
      if (key === '@id' || key === '@context') continue;
      if (key === 'spatialEntities' || key === 'newSpatialEntities' || ((key === 'attestations' || key === 'identityRelations') && active === this.root)) continue;
      const term = active.terms.get(key);
      if (!term) { this.issues({ kind: 'unmapped-key', value: key }); continue; }
      if (term.drop) { if (NOT_IN_RDF.has(key) && val !== null && val !== undefined) this.issues({ kind: 'not-in-rdf', key }); continue; }
      if (term.nest) { for (const v of [].concat(val)) if (v && typeof v === 'object') this._walk(v, active, subj); continue; }
      const c = child(active, term);
      const p = iri(term.iri);
      if (term.container === '@list') {
        if (this.opt.wktPoints && term.iri === REPR_POINT && Array.isArray(val) && val.length === 2) {
          this._out(subj, p, literal(`POINT(${val[0]} ${val[1]})`, WKT)); continue;
        }
        this._out(subj, p, this._list([].concat(val), term, c)); continue;
      }
      for (const v of [].concat(val)) {
        if (v === null || v === undefined) continue;
        if (term.reverse) {
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
  _list(items, term, c) {
    let head = RDF_NIL;
    for (let i = items.length - 1; i >= 0; i--) {
      const node = this._blank();
      this._emit(node, RDF_FIRST, this._value(items[i], term, c));
      this._emit(node, RDF_REST, head);
      head = node;
    }
    return head;
  }
  _value(v, term, c) {
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
