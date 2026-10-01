// RDF triples back to PLATO JSON records, one SpatialEntity at a time.
//
// The JSON-LD context says which predicate a key maps to, but not where the key lives in the
// JSON: the context maps a name's certainty straight onto the Name, while the schema nests it
// under `qualification`. So the reverse mapping is built from both the compiled context and the
// JSON Schema. It reads the graph through two questions only, a node's outgoing triples and the
// subjects that point at a node, so the same code runs on an in-memory graph (tests, small files)
// and on the on-disk SQLite store (any size). Whatever it cannot place is reported as a loss.
import { RDF, PLATO, compileContext, child } from '../lib/context.js';
import { numberLiteral, boundDatatype } from './json2rdf.js';
import { QB, SDMX_ATTRIBUTE, SDMX_DIMENSION, isDerived } from './cube.js';

const RDF_TYPE = RDF + 'type', RDF_FIRST = RDF + 'first', RDF_REST = RDF + 'rest', RDF_NIL = RDF + 'nil', RDF_JSON = RDF + 'JSON';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NUMERIC = new Set(['integer', 'int', 'long', 'short', 'nonNegativeInteger', 'positiveInteger', 'decimal', 'double', 'float'].map((x) => XSD + x));
const WGS84 = 'http://www.w3.org/2003/01/geo/wgs84_pos#';
const NEST_DEF = { qualification: 'qualification', relations: 'relation', meta: 'metaAttestation' };
const DOC_LINKS = new Set(['contains_entity', 'contains_attestation', 'contains_identity_relation'].map((x) => PLATO + x));
const XSD_STRING = XSD + 'string', XSD_BOOLEAN = XSD + 'boolean';
const BOUNDS = new Set(['start_earliest', 'start_latest', 'end_earliest', 'end_latest'].map((x) => PLATO + x));
// A name's text keys, whose language tags are weighed against its language key (_nameTags), in the
// order they are weighed; the toponym and the source's form may give the key its value.
const NAME_TEXT_ORDER = ['toponym', 'sourceLabel', 'romanized', 'ipa'];
const NAME_TEXT = new Set(NAME_TEXT_ORDER), NAME_FILLS = new Set(['toponym', 'sourceLabel']);
const COMPONENT = { [QB + 'dimension']: 'dimension', [QB + 'measure']: 'measure', [QB + 'attribute']: 'attribute' };

/** Resolve a schema fragment's $ref / oneOf into { kind: 'object'|'uri'|'scalar'|'either', def, array }. */
function shape(schema, core, profile) {
  const deref = (s) => {
    if (!s || !s.$ref) return s;
    const [file, frag] = s.$ref.split('#');
    const root = file ? core : (profile && s.$ref.startsWith('#') && profile.$defs ? profile : core);
    return frag.split('/').filter(Boolean).reduce((o, k) => o[k], file ? core : root);
  };
  const defName = (s) => (s && s.$ref && s.$ref.includes('/$defs/') ? s.$ref.split('/$defs/')[1] : null);
  let array = false, s = schema;
  if (s && s.type === 'array') { array = true; s = s.items; }
  // A definition narrowed in place (an attestation's bundled identities: an identityRelation that
  // must give its subject) is that definition: allOf's part with a $ref names it.
  if (s && !s.$ref && Array.isArray(s.allOf)) s = s.allOf.find((x) => x && x.$ref) || s;
  if (s && s.oneOf) {
    const obj = s.oneOf.find((x) => defName(x) && defName(x) !== 'uri');
    return { kind: obj ? 'either' : 'uri', def: obj ? defName(obj) : null, array };
  }
  const name = defName(s);
  if (name === 'uri') return { kind: 'uri', array };
  if (name && deref(s).type === 'object') return { kind: 'object', def: name, array };
  const r = deref(s) || {};
  return { kind: 'scalar', type: r.type, array };
}

/**
 * The exact value of a numeric literal, as a canonical decimal string ("-12.25", "1", "0"), or null
 * when the lexical form is not a number. xsd:decimal and the integer types are exact as written;
 * xsd:double is the nearest double, and xsd:float the nearest single (taken via the double, which
 * differs from rounding straight to a single only when the double falls exactly halfway between
 * two singles), each expanded to all its digits: every binary fraction is a finite decimal.
 */
export function exactValue(lex, dt) {
  const s = lex.trim();
  if (dt === XSD + 'double' || dt === XSD + 'float') {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    let n = Number(s); if (dt === XSD + 'float') n = Math.fround(n);
    return Number.isFinite(n) ? doubleDecimal(n) : null;
  }
  const m = s.match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
  if (!m || (m[2] + (m[3] || '')) === '') return null;
  return canonicalDecimal(m[1] === '-', m[2] + (m[3] || ''), (m[3] || '').length);
}
/** Sign, digits and the number of them after the point, as "-0.125", "40", "0". */
function canonicalDecimal(neg, digits, scale) {
  digits = digits.padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale).replace(/^0+/, '');
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  if (!int && !frac) return '0';
  return (neg ? '-' : '') + (int || '0') + (frac ? '.' + frac : '');
}
/** Every digit of a finite double: mantissa * 2^exp, and 2^-k = 5^k / 10^k. */
function doubleDecimal(n) {
  if (n === 0) return '0';
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, n);
  const bits = view.getBigUint64(0);
  const neg = bits >> 63n === 1n, e = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & 0xfffffffffffffn, exp;
  if (e === 0) exp = -1074; else { mant |= 1n << 52n; exp = e - 1075; }
  if (exp >= 0) return canonicalDecimal(neg, (mant << BigInt(exp)).toString(), 0);
  return canonicalDecimal(neg, (mant * 5n ** BigInt(-exp)).toString(), -exp);
}

export class Rdf2Json {
  /** graph: { out(id) -> [{p, o}], in(p, id) -> [id] }; terms are {termType, value, datatype?, language?}. */
  /**
   * withdrawn: node key -> 'retracted' | 'superseded', for a target that shows only the current
   * state (LPF, the tables). Those attestations are not read into their place, and each is reported
   * as a loss. A blank-node attestation has no @id in JSON, so this is the one place it can be
   * recognised. Left null for PLATO JSON, which keeps everything.
   */
  constructor({ context, core, profile, types = null }, graph, { onLoss = () => {}, onIssue = () => {}, withdrawn = null } = {}) {
    this.withdrawn = withdrawn && withdrawn.size ? withdrawn : null;
    this.types = types;   // the ontology's domains and ranges, to recognise a node's other roles
    this.root = compileContext(context);
    this.core = core; this.profile = profile;
    this.g = graph; this.loss = onLoss; this.issue = onIssue;
    this.inv = new Map();
    this.inlined = new Set();   // shared nodes with blank-node children already written in full
    // PLATO issue #14: a document's statistical tables, and what each table's structure
    // says its components are, read once per table.
    const ds = this.root.terms.get('dataSets');
    this.dataSetsIri = ds && ds.iri ? ds.iri : null;
    const rt = this.root.terms.get('relationTypes');
    this.relationTypesIri = rt && rt.iri ? rt.iri : null;
    this.tables = new Map(); this.derived = new Map();
    // Types an input graph asserts that PLATO JSON cannot carry (see _type): reported once each.
    this.typeSeen = new Set();
    this.rangeProps = new Map();   // class -> the properties whose range it is
    if (types) for (const [prop, cls] of types.range) (this.rangeProps.get(cls) || this.rangeProps.set(cls, []).get(cls)).push(prop);
  }
  /**
   * An rdf:type the input asserts for node `id`. PLATO JSON carries no types for most nodes: the
   * tools derive them from structure (a property's domain or range, or the cube export's rules), so
   * a type that would be derived again is not lost, and passes in silence; every round trip of the
   * tools' own output asserts hundreds of thousands of them. A type they would not derive (a
   * foreign class, or a PLATO class that disagrees with the node's own statements) is read and
   * discarded, which changes what the graph says: that is reported, once per node and type.
   */
  _type(id, out, cls) {
    if (this._derivable(id, out, cls)) return;
    const k = id + '\u0001' + cls;
    if (this.typeSeen.has(k)) return;
    if (this.typeSeen.size < 2_000_000) this.typeSeen.add(k);
    this.loss({ kind: 'type-not-carried', value: `${id}: ${cls}` });
  }
  _derivable(id, out, cls) {
    if (cls === QB + 'Observation') return out.some((t) => t.p === QB + 'dataSet');
    if (cls === QB + 'DataSet') return out.some((t) => t.p === QB + 'structure') || this.g.in(QB + 'dataSet', id).length > 0;
    if (cls === QB + 'DataStructureDefinition') return out.some((t) => t.p === QB + 'component') || this.g.in(QB + 'structure', id).length > 0;
    const t = this.types; if (!t) return false;
    if (out.some((x) => x.p !== RDF_TYPE && t.domain.get(x.p) === cls)) return true;
    for (const prop of this.rangeProps.get(cls) || []) if (this.g.in(prop, id).length) return true;
    return false;
  }
  _defSchema(def) {
    if (def === '$gazetteer') return this.profile.properties.gazetteer;
    // An object the gazetteer header defines in place, not in $defs (a creator, the years covered):
    // '$gazetteer.creator' is the schema of one creator.
    if (def.startsWith('$gazetteer.')) { const s = this.profile.properties.gazetteer.properties[def.slice(11)]; return s.type === 'array' ? s.items : s; }
    return this.core.$defs[def];
  }
  /** The reverse mapping for one JSON object type in one active context, built once. */
  _inverse(def, active) {
    let byCtx = this.inv.get(def);
    if (!byCtx) { byCtx = new Map(); this.inv.set(def, byCtx); }
    let m = byCtx.get(active);
    if (m) return m;
    m = { fwd: new Map(), rev: new Map() };
    const add = (key, schema, path) => {
      const term = active.terms.get(key);
      if (!term || term.drop) return;
      if (term.nest) {
        // dimensions and attributes (PLATO issue #14) nest keys that are IRIs, not a schema
        // definition's keys: they are read by _figure, not by this mapping.
        if (!NEST_DEF[key]) return;
        const nd = this.core.$defs[NEST_DEF[key]];
        for (const [k2, s2] of Object.entries(nd.properties)) add(k2, s2, { nest: key, nestArray: schema.type === 'array', key: k2 });
        return;
      }
      if (!term.iri) return;
      let sh = shape(schema, this.core, this.profile);
      // The gazetteer's creators and its temporal coverage are objects defined in place in the header's
      // schema: each is read as a node of its own (a creator's foaf:name, a period's dcat:startDate).
      const inner = schema && schema.type === 'array' ? schema.items : schema;
      if (def === '$gazetteer' && inner && !inner.$ref && inner.type === 'object' && inner.properties) sh = { kind: 'object', def: `$gazetteer.${key}`, array: schema.type === 'array' };
      const entry = { key, term, shape: sh, path, ctx: child(active, term) };
      const table = term.reverse ? m.rev : m.fwd;
      if (!table.has(term.iri)) table.set(term.iri, entry);
    };
    for (const [key, schema] of Object.entries(this._defSchema(def).properties || {})) {
      if (key === '@id') continue;
      add(key, schema, null);
    }
    byCtx.set(active, m);
    return m;
  }
  _describes(id) { return this.g.out(id).some((t) => t.p !== RDF_TYPE); }
  /** True when predicate p belongs to a class this node also plays, by being the object of a property with that range. */
  _otherRole(id, p) {
    const t = this.types; if (!t) return false;
    const cls = t.domain.get(p); if (!cls) return false;
    for (const [prop, range] of t.range) if (range === cls && this.g.in(prop, id).length) return true;
    return false;
  }
  _hasBlankChildren(id) { return this.g.out(id).some((t) => t.o.termType === 'BlankNode'); }
  _list(head, depth = 0) {
    const items = [];
    let cur = head;
    for (let guard = 0; cur && cur.value !== RDF_NIL && guard < 100000; guard++) {
      const out = this.g.out(cur.termType === 'BlankNode' ? '_:' + cur.value : cur.value);
      const first = out.find((t) => t.p === RDF_FIRST), rest = out.find((t) => t.p === RDF_REST);
      if (!first) break;
      items.push(this._scalar(first.o, { kind: 'scalar' }));
      cur = rest && rest.o;
    }
    return items;
  }
  _scalar(o, sh) {
    if (o.termType !== 'Literal') return o.value;
    if (o.datatype === RDF_JSON) { try { return JSON.parse(o.value); } catch { return o.value; } }
    // xsd:boolean is written 'true', 'false', '1' or '0'. Read wrongly, plato:negated "1" would turn a
    // source's denial into an assertion; a value outside the four is kept as it is, for the schema to
    // report, and the writers treat anything but false as a denial.
    if (o.datatype === XSD + 'boolean' || (sh.type === 'boolean' && o.datatype === XSD + 'string')) {
      const v = o.value.trim();
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      return o.value;
    }
    if (NUMERIC.has(o.datatype) || (sh.type === 'number' || sh.type === 'integer')) {
      const n = Number(o.value); if (Number.isFinite(n) && o.value.trim() !== '') return n;
    }
    return o.value;
  }
  _key(o) { return o.termType === 'BlankNode' ? '_:' + o.value : o.value; }
  /**
   * What PLATO JSON cannot hold of a literal read into value v: a language tag, or a datatype other
   * than the one the key's value is written back with (the context's type for the key, else the
   * one its JSON value gives). The value is kept; the tag or datatype is reported lost. A tag on a
   * name's text is not decided here but by _nameTags, once the name's own language key is known:
   * it is collected into `tags` instead.
   */
  _literalLoss(id, p, o, v, term, tags = null, key = null) {
    if (o.language) {
      if (tags && NAME_TEXT.has(key)) { tags.push({ key, p, o }); return; }
      this.loss({ kind: 'literal-language', value: `${id} ${p} "${o.value}"@${o.language}` }); return;
    }
    const dt = o.datatype || XSD_STRING;
    const again = term.type && !term.type.startsWith('@') ? term.type
      : typeof v === 'number' ? numberLiteral(v).datatype : typeof v === 'boolean' ? XSD_BOOLEAN : XSD_STRING;
    if (dt === again) return;
    // A bound typed by its shape (xsd:gYear, xsd:date) is what a typed export writes, and writes again.
    if (BOUNDS.has(p) && typeof v === 'string' && boundDatatype(v) === dt) return;
    // A number written back in another numeric datatype loses nothing when it is exactly the same
    // number ("1.0"^^xsd:decimal read as 1, written "1"^^xsd:integer). It is compared exactly, as
    // decimals: "0.1"^^xsd:decimal is not the double 0.1, which is 0.1000000000000000055511151231257827....
    if (typeof v === 'number' && NUMERIC.has(dt) && NUMERIC.has(again)) {
      const back = term.type && !term.type.startsWith('@') ? String(v) : numberLiteral(v).value;
      const a = exactValue(o.value, dt), b = exactValue(back, again);
      if (a !== null && a === b) return;
    }
    this.loss({ kind: 'literal-datatype', value: `${id} ${p} "${o.value}"^^<${dt}>` });
  }
  /**
   * The language tags on a name's text (toponym, sourceLabel, romanized, ipa), against the name's
   * language key. A tag that the key already says (BCP 47 tags ignore case) loses nothing. With no
   * key, a tag on the toponym or the source's form (which are in the name's language) becomes the
   * key when PLATO's languageTag pattern admits it, and is then no loss either. Anything else, a
   * tag that differs from the key, one the key cannot hold, one on a romanised or phonetic form
   * (whose tag, grc-Latn or en-fonipa, says more than the name's language), is reported.
   */
  _nameTags(id, obj, tags) {
    tags.sort((x, y) => NAME_TEXT_ORDER.indexOf(x.key) - NAME_TEXT_ORDER.indexOf(y.key));
    for (const { key, p, o } of tags) {
      const tag = o.language;
      if (obj.language === undefined && NAME_FILLS.has(key) && this._languageFits(tag)) obj.language = tag;
      if (typeof obj.language === 'string' && obj.language.toLowerCase() === tag.toLowerCase()) continue;
      this.loss({ kind: 'literal-language', value: `${id} ${p} "${o.value}"@${tag}` });
    }
  }
  _languageFits(tag) {
    if (this.languagePattern === undefined) {
      let s = this.core.$defs.name && this.core.$defs.name.properties.language;
      if (s && s.$ref) s = this.core.$defs[s.$ref.split('/').pop()];
      this.languagePattern = s && s.type === 'string' ? (s.pattern ? new RegExp(s.pattern, 'u') : /^/) : null;
    }
    return !!this.languagePattern && this.languagePattern.test(tag);
  }

  /** Build the JSON object for node `id` as JSON type `def` in context `active`. */
  node(id, def, active, seen = new Set(), back = null) {
    const obj = {};
    // A node met again on its own path (DEEP gives some names the IRI of their own place) is read
    // for its own values, but not followed further: that is what stops a cycle.
    const shallow = seen.has(id);
    seen = new Set(seen).add(id);
    const m = this._inverse(def, active);
    const put = (entry, value) => {
      const tgt = entry.path ? (() => {
        const { nest, nestArray } = entry.path;
        if (nestArray) { const arr = (obj[nest] ||= []); if (!arr.length || arr[arr.length - 1][entry.key] !== undefined) arr.push({}); return arr[arr.length - 1]; }
        return (obj[nest] ||= {});
      })() : obj;
      const k = entry.path ? entry.path.key : entry.key;
      if (entry.shape.array) (tgt[k] ||= []).push(value);
      else if (tgt[k] === undefined) tgt[k] = value;
      // Identical repeats are copies of one value (DEEP writes a source's date out once per record
      // that cites it, so the source gathers many identical date nodes); only differences matter.
      else if (JSON.stringify(tgt[k]) !== JSON.stringify(value)) this.issue({ kind: 'multiple-values', key: k, node: id, value: JSON.stringify(value) });
    };
    let lat, long;
    const nameTags = def === 'name' ? [] : null;
    for (const { p, o } of this.g.out(id)) {
      // Nested under its parent through a reverse property (an attestation under its entity):
      // the link back to the parent is what the nesting says, so it is not repeated.
      if (back && p === back.p && this._key(o) === back.id) continue;
      const e = m.fwd.get(p);
      if (!e) {
        if (shallow) continue;                              // its other triples belong to its other role
        // A structured value, serialised as JSON text on plato:value_json (json2rdf.js): read back
        // into the object it was, so that the round trip gives what went in.
        if (def === 'propertyValue' && p === PLATO + 'value_json' && o.termType === 'Literal') {
          let v; try { v = JSON.parse(o.value); } catch { v = undefined; }
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (obj.value === undefined) obj.value = v;
            else if (JSON.stringify(obj.value) !== JSON.stringify(v)) this.issue({ kind: 'multiple-values', key: 'value', node: id, value: o.value });
          } else this.loss({ kind: 'value-json-invalid', value: `${id}: ${o.value.slice(0, 80)}` });
          continue;
        }
        if (p === WGS84 + 'lat') { lat = Number(o.value); continue; }
        if (p === WGS84 + 'long') { long = Number(o.value); continue; }
        if (p === PLATO + 'repr_point' && o.termType === 'Literal') { const xy = o.value.match(/POINT\s*\(\s*(\S+)\s+(\S+)\s*\)/i); if (xy) { obj.reprPoint = [Number(xy[1]), Number(xy[2])]; continue; } }
        if (p === RDF_TYPE) { if (o.termType === 'NamedNode') this._type(id, this.g.out(id), o.value); continue; }   // structure implies the PLATO types; any other is reported
        if (this._otherRole(id, p)) continue;               // e.g. a toponym on a place that is also a name
        if (def === '$gazetteer' && DOC_LINKS.has(p)) continue;   // the records, read by the driver
        if (def === '$gazetteer' && (p === this.dataSetsIri || p === this.relationTypesIri)) continue;   // tables and relation types, read by header()
        if (def === 'propertyValue') {
          const where = this._figure(id, p, o);
          if (where === 'derived') continue;
          if (where) { this._figureValue(obj, where, p, o, id); continue; }
        }
        this.loss({ kind: 'unmapped-predicate', predicate: p, as: def });
        continue;
      }
      const t = e.term;
      if (def === 'dataSet' && e.key === 'structure' && o.termType !== 'Literal') { put(e, this._structure(o)); continue; }
      if (t.type === '@vocab') { const key = [...e.ctx.terms.entries()].find(([, v]) => v.iri === o.value); if (key) put(e, key[0]); else if (!o.value.startsWith(PLATO)) this.loss({ kind: 'unmapped-type', value: o.value }); continue; }
      if (t.container === '@list') { if (o.termType === 'Literal') { const xy = o.value.match(/POINT\s*\(\s*(\S+)\s+(\S+)\s*\)/i); if (xy) put({ ...e, shape: { ...e.shape, array: false } }, [Number(xy[1]), Number(xy[2])]); } else put({ ...e, shape: { ...e.shape, array: false } }, this._list(o)); continue; }
      if (t.type === '@json') { put(e, this._scalar(o, e.shape)); continue; }
      if (o.termType === 'Literal') { const v = this._scalar(o, e.shape); this._literalLoss(id, p, o, v, t, nameTags, e.path ? null : e.key); put(e, v); continue; }
      const oid = this._key(o);
      const sh = e.shape;
      // A shared node with its own IRI (a source cited by many places) is written out in full
      // wherever it is used, so that every record stands alone, as a JSON Lines line should. If it
      // has blank-node children (a source's date), each copy mints its own when the JSON is read
      // again: redundant nodes that RDF treats as the same information (a lean-equivalent graph).
      const inline = sh.kind === 'object' || (sh.kind === 'either' && (o.termType === 'BlankNode' || this._describes(oid)));
      if (shallow && inline) continue;
      if (inline) {
        const sub = this.node(oid, sh.def, e.ctx, seen);
        put(e, o.termType === 'BlankNode' ? sub : { '@id': o.value, ...sub });
      } else if (o.termType === 'BlankNode') {
        // A blank node where a value belongs (value_literal pointing at a node, as a structured value
        // written without value_json leaves it): its label is not a value, and writing it as one
        // ("r2b6") invents data. Reported, and left out.
        this.loss({ kind: 'value-is-node', value: `${id} ${p}` });
      } else put(e, o.value);
    }
    if (nameTags && nameTags.length) this._nameTags(id, obj, nameTags);
    if (def === 'geometry' && lat !== undefined && long !== undefined) {
      if (!obj.reprPoint) obj.reprPoint = [long, lat];
      if (!obj.geojson && !obj.wkt) obj.geojson = { type: 'Point', coordinates: [long, lat] };
    }
    if (shallow) return obj;
    for (const [p, e] of m.rev) {
      for (const sid of this.g.in(p, id)) {
        // An identity relation the document holds at its top level stays there.
        if (e.key === 'identityRelations' && this.g.in(PLATO + 'contains_identity_relation', sid).length) continue;
        // So does one an attestation bundles (plato:attests_identity): it is read there, under the
        // attestation whose provenance it shares, and never as a relation of its own. Nested here,
        // it would lose that provenance, and a denied identity (the attestation negated) would read
        // as a match.
        if (e.key === 'identityRelations' && this.g.in(PLATO + 'attests_identity', sid).length) continue;
        if (e.key === 'attestations' && this.withdrawn) { const kind = this.withdrawn.get(sid); if (kind) { this.loss({ kind, value: sid }); continue; } }
        // The place-centric profile forbids repeating `about` on a nested attestation; identity
        // relations keep their `subject`, which the schema requires even when nested.
        const back = p === PLATO + 'attests_about' ? { p, id } : null;
        const sub = this.node(sid, e.shape.def, e.ctx, seen, back);
        const v = sid.startsWith('_:') ? sub : { '@id': sid, ...sub };
        (obj[e.key] ||= []).push(v);
        if (e.key === 'attestations') this._metaWithoutSubject(sid, e, seen, obj[e.key]);
      }
    }
    if (def === 'name' && obj.toponym === undefined) this.issue({ kind: 'name-without-toponym', node: id });
    return obj;
  }

  /**
   * The meta-attestations on attestation `target` that do not say what they are about themselves
   * (PLATO 238d15f: a meta-attestation need not; its target does). PLATO JSON nests every attestation
   * under a place, so each is nested beside its target, under the place the target is about, and
   * followed on to comments on it. One with its own plato:attests_about is read under that place.
   */
  _metaWithoutSubject(target, e, seen, into, depth = 0) {
    if (depth > 50) return;
    for (const mid of this.g.in(PLATO + 'meta_attestation_about', target)) {
      if (this.g.out(mid).some((t) => t.p === PLATO + 'attests_about') || seen.has(mid) || this.metaPlaced?.has(mid)) continue;
      (this.metaPlaced ||= new Set()).add(mid);
      if (this.withdrawn) { const kind = this.withdrawn.get(mid); if (kind) { this.loss({ kind, value: mid }); continue; } }
      const sub = this.node(mid, 'attestation', e.ctx, seen);
      into.push(mid.startsWith('_:') ? sub : { '@id': mid, ...sub });
      this._metaWithoutSubject(mid, e, seen, into, depth + 1);
    }
  }

  /** The document node and its header, or null when the graph has no Gazetteer node. */
  header(docId) {
    const g = this.node(docId, '$gazetteer', this.root);
    const head = { profile: 'place-centric', gazetteer: docId.startsWith('_:') ? g : { '@id': docId, ...g } };
    // The document's statistical tables (PLATO issue #14), dcterms:hasPart of the gazetteer.
    if (this.dataSetsIri) {
      const ctx = child(this.root, this.root.terms.get('dataSets'));
      const parts = this.g.out(docId).filter((t) => t.p === this.dataSetsIri && t.o.termType !== 'Literal');
      if (parts.length) head.dataSets = parts.map((t) => {
        const d = this.node(this._key(t.o), 'dataSet', ctx);
        if (t.o.termType === 'BlankNode') { this.issue({ kind: 'table-without-address', node: this._key(t.o) }); return d; }
        return { '@id': t.o.value, ...d };
      });
    }
    // The relation types it declares for its own use (PLATO 0.6.0), plato:declares_relation_type.
    if (this.relationTypesIri) {
      const ctx = child(this.root, this.root.terms.get('relationTypes'));
      const rts = this.g.out(docId).filter((t) => t.p === this.relationTypesIri && t.o.termType === 'NamedNode');
      if (rts.length) head.relationTypes = rts.map((t) => ({ '@id': t.o.value, ...this.node(this._key(t.o), 'relationType', ctx) }));
    }
    return head;
  }

  // ---- statistical figures (PLATO issue #14) -----------------------------------------------------
  /** What a table's structure, where the graph describes it, says its components are. */
  _table(ds) {
    let t = this.tables.get(ds);
    if (t) return t;
    t = { dimension: new Set(), measure: new Set(), attribute: new Set() };
    for (const st of this.g.out(ds)) {
      if (st.p !== QB + 'structure' || st.o.termType === 'Literal') continue;
      for (const c of this.g.out(this._key(st.o))) {
        if (c.p !== QB + 'component' || c.o.termType === 'Literal') continue;
        for (const x of this.g.out(this._key(c.o))) if (COMPONENT[x.p] && x.o.termType === 'NamedNode') t[COMPONENT[x.p]].add(x.o.value);
      }
    }
    this.tables.set(ds, t);
    return t;
  }
  /**
   * Where a statement on a PropertyValue that no PLATO key names belongs: 'dimensions',
   * 'attributes', 'derived' (the cube export's own, left out), or null (not a figure's: a loss).
   *
   * The rule, in order. A PLATO term never goes here. On a figure (a PropertyValue with qb:dataSet):
   *   1. where the figure is typed qb:Observation, which only a cube export or other Data Cube data
   *      writes, a measure, refArea or refPeriod statement equal to what the export derives is its
   *      own, and is left out, since --cube writes it again;
   *   2. its table's structure, where the graph has it: a qb:attribute is an attribute and a
   *      qb:dimension a dimension (a qb:measure not derived is a loss: PLATO JSON has one measure);
   *   3. otherwise the property's own type in the graph, qb:AttributeProperty or qb:DimensionProperty;
   *   4. otherwise its namespace: SDMX's attribute namespace is an attribute, its dimension namespace
   *      a dimension;
   *   5. otherwise a dimension, with a warning naming it. JSON-LD writes `dimensions` and
   *      `attributes` identically, so either key gives the same graph and the round trip is
   *      lossless either way; a dimension is the default because an address is what a figure is for,
   *      and obsStatus, which the schema needs under `attributes`, is decided by step 4.
   * On a PropertyValue that is not a figure, only steps 3 and 4 apply; anything else stays a loss.
   */
  _figure(id, p, o) {
    if (p.startsWith(PLATO)) return null;
    const out = this.g.out(id);
    const tables = out.filter((t) => t.p === QB + 'dataSet' && t.o.termType !== 'Literal').map((t) => this._key(t.o));
    if (tables.length) {
      if (out.some((t) => t.p === RDF_TYPE && t.o.value === QB + 'Observation') && isDerived(this.g, id, p, o, this.derived)) return 'derived';
      for (const ds of tables) {
        const t = this._table(ds);
        if (t.attribute.has(p)) return 'attributes';
        if (t.dimension.has(p)) return 'dimensions';
        if (t.measure.has(p)) return null;
      }
    }
    const types = this.g.out(p).filter((t) => t.p === RDF_TYPE).map((t) => t.o.value);
    if (types.includes(QB + 'AttributeProperty')) return 'attributes';
    if (types.includes(QB + 'DimensionProperty')) return 'dimensions';
    if (p.startsWith(SDMX_ATTRIBUTE)) return 'attributes';
    if (p.startsWith(SDMX_DIMENSION)) return 'dimensions';
    if (!tables.length) return null;
    this.issue({ kind: 'figure-undeclared', key: p, node: id });
    return 'dimensions';
  }
  /** Put one coordinate or attribute into the figure's JSON, as a code ({"@id"}) or a literal. */
  _figureValue(obj, where, p, o, id) {
    let v;
    if (o.termType === 'NamedNode') v = { '@id': o.value };
    else if (o.termType === 'BlankNode') { this.loss({ kind: 'figure-blank-value', value: p }); return; }
    else {
      v = this._scalar(o, { kind: 'scalar' });
      // Only a literal PLATO JSON writes back the same way keeps its type; any other (a year typed
      // xsd:gYear, a language tag) keeps its text, and the loss is said.
      const again = typeof v === 'number' ? numberLiteral(v) : typeof v === 'boolean' ? { value: String(v), datatype: XSD_BOOLEAN } : { value: v, datatype: XSD_STRING };
      if (again.value !== o.value || again.datatype !== (o.datatype || XSD_STRING) || o.language) this.loss({ kind: 'figure-literal', value: `${p} ${o.value}` });
    }
    const box = (obj[where] ||= {});
    if (box[p] === undefined) box[p] = v;
    else if (JSON.stringify(box[p]) !== JSON.stringify(v)) this.issue({ kind: 'multiple-values', key: p, node: id, value: JSON.stringify(v) });
  }
  /** A table's structure: its components listed, where the graph describes them, or its IRI. */
  _structure(o) {
    const k = this._key(o);
    const out = this.g.out(k).filter((t) => t.p !== RDF_TYPE);
    const comps = out.filter((t) => t.p === QB + 'component' && t.o.termType !== 'Literal');
    if (!comps.length) { for (const t of out) this.loss({ kind: 'unmapped-predicate', predicate: t.p, as: 'dataStructure' }); return o.value; }
    for (const t of out) if (t.p !== QB + 'component') this.loss({ kind: 'unmapped-predicate', predicate: t.p, as: 'dataStructure' });
    if (o.termType === 'BlankNode') this.issue({ kind: 'structure-without-address', node: k });
    const components = [];
    for (const c of comps) {
      const co = this.g.out(this._key(c.o)).filter((t) => t.p !== RDF_TYPE);
      if (c.o.termType === 'NamedNode') this.loss({ kind: 'component-address', value: c.o.value });
      const kinds = co.filter((t) => COMPONENT[t.p] && t.o.termType === 'NamedNode');
      for (const t of co) if (!COMPONENT[t.p] || t.o.termType !== 'NamedNode') this.loss({ kind: 'unmapped-predicate', predicate: t.p, as: 'component' });
      if (kinds.length > 1) this.issue({ kind: 'component-several', node: this._key(c.o) });
      for (const t of kinds) components.push({ [COMPONENT[t.p]]: t.o.value });
    }
    return o.termType === 'BlankNode' ? { components } : { '@id': o.value, components };
  }
  /** One place-centric record. */
  entity(id) {
    const term = this.root.terms.get('spatialEntities');
    const rec = this.node(id, 'spatialEntity', child(this.root, term));
    return id.startsWith('_:') ? rec : { '@id': id, ...rec };
  }
  identityRelation(id) {
    const term = this.root.terms.get('identityRelations');
    const rec = this.node(id, 'identityRelation', child(this.root, term));
    return id.startsWith('_:') ? rec : { '@id': id, ...rec };
  }
  attestation(id) {
    const term = this.root.terms.get('attestations');
    const rec = this.node(id, 'attestation', child(this.root, term));
    return id.startsWith('_:') ? rec : { '@id': id, ...rec };
  }
}

/** A graph held in memory, for tests and small inputs. */
export class MemGraph {
  constructor() { this.o = new Map(); this.i = new Map(); }
  add(s, p, o) {
    const sk = s.termType === 'BlankNode' ? '_:' + s.value : s.value;
    (this.o.get(sk) || this.o.set(sk, []).get(sk)).push({ p: p.value, o });
    if (o.termType !== 'Literal') {
      const k = p.value + '\u0001' + (o.termType === 'BlankNode' ? '_:' + o.value : o.value);
      (this.i.get(k) || this.i.set(k, []).get(k)).push(sk);
    }
  }
  out(id) { return this.o.get(id) || []; }
  in(p, id) { return this.i.get(p + '\u0001' + id) || []; }
  subjects() { return this.o.keys(); }
}
