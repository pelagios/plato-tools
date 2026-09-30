// The site's data files: each place and source as a JSON-LD document of its own, in Turtle when
// asked, the dataset's description, and the schema.org Dataset the landing page carries for search
// engines. Each is made from the record the dataset holds, not rewritten, so that what a machine
// fetches from a place's address is exactly what the dataset says of it.
import { Writer, DataFactory } from 'n3';
import { Json2Rdf } from '../../../formats/json2rdf.js';
import { PLATO, RDF, XSD } from '../../../lib/context.js';

// Where PLATO JSON documents find their context (PLATO's docs/json.md): a JSON-LD processor that
// fetches it turns the document into RDF in the PLATO ontology.
export const CONTEXT_URL = 'https://w3id.org/plato/schemas/plato.context.jsonld';
export const PLACE_CENTRIC_SCHEMA = 'https://w3id.org/plato/schemas/place-centric.schema.json';

// What a place's own document says of the dataset it belongs to: enough to name it and its
// version, and so that the place is the dataset's (plato:contains_entity), as it is in the whole.
// The rest of the description is the dataset's own document (index.jsonld), not repeated per place.
const GAZETTEER_KEYS = ['@id', 'title', 'version'];
const gazetteerStub = (g) => Object.fromEntries(GAZETTEER_KEYS.filter((k) => g[k] !== undefined && g[k] !== null).map((k) => [k, g[k]]));

/**
 * A place as a JSON-LD document: a PLATO place-centric document holding that one place, with the
 * PLATO context. A place record means what it means only under the context scoped to
 * spatialEntities (its `label`, its `attestations` as the reverse of plato:attests_about), so it
 * cannot stand at the top of a document by itself; wrapped, jsonld.js expands it to the triples
 * the dataset gives it, and it is still valid PLATO JSON, which the tools read like any dataset.
 */
export function placeDocument(record, gazetteer) {
  return { '@context': CONTEXT_URL, $schema: PLACE_CENTRIC_SCHEMA, profile: 'place-centric', gazetteer: { title: 'Untitled', ...gazetteerStub(gazetteer) }, spatialEntities: [record] };
}

/**
 * A source as a JSON-LD document. A source has no array of its own in a PLATO document: it is read
 * under the context an attestation's `sources` scope, which is given here in full after the PLATO
 * context, so that the source's keys mean at the top of the document what they mean in the dataset.
 */
export function sourceDocument(source, iri, contextDoc) {
  const scoped = sourceContext(contextDoc);
  const body = source && typeof source === 'object' ? source : {};
  return { '@context': [CONTEXT_URL, { '@version': 1.1, ...scoped }], ...body, '@id': iri };
}
let cachedScope = null;
function sourceContext(contextDoc) {
  if (cachedScope && cachedScope.doc === contextDoc) return cachedScope.ctx;
  const c = contextDoc['@context'] ?? contextDoc;
  const ctx = c?.spatialEntities?.['@context']?.attestations?.['@context']?.sources?.['@context'] || {};
  cachedScope = { doc: contextDoc, ctx };
  return ctx;
}

/** The dataset's description as JSON-LD: its header, as a PLATO document has it, with the context. */
export function descriptionDocument(head) {
  const { spatialEntities, newSpatialEntities, attestations, identityRelations, ...rest } = head || {};
  return { '@context': CONTEXT_URL, $schema: PLACE_CENTRIC_SCHEMA, ...rest, profile: 'place-centric' };
}

// ---- Turtle ----------------------------------------------------------------------------------------
const PREFIXES = {
  plato: PLATO, rdf: RDF, rdfs: 'http://www.w3.org/2000/01/rdf-schema#', xsd: XSD, dcterms: 'http://purl.org/dc/terms/', skos: 'http://www.w3.org/2004/02/skos/core#',
  geo: 'http://www.opengis.net/ont/geosparql#', prov: 'http://www.w3.org/ns/prov#', cito: 'http://purl.org/spar/cito/', dcat: 'http://www.w3.org/ns/dcat#', void: 'http://rdfs.org/ns/void#',
};
const { namedNode, blankNode, literal, quad } = DataFactory;
const toN3 = (t) => (t.termType === 'NamedNode' ? namedNode(t.value) : t.termType === 'BlankNode' ? blankNode(t.value) : literal(t.value, t.language || namedNode(t.datatype)));

/**
 * Turtle for the site: the same graph as the JSON-LD documents, written by Json2Rdf, the converter
 * the N-Triples output uses. One converter serves the whole site, but its memory of the sources it
 * has written (which keeps a shared source from being written once per record in one file) is
 * forgotten before each document: every file must describe its sources in full.
 */
export class Turtle {
  constructor(contextDoc, base) {
    this.triples = [];
    this.j2r = new Json2Rdf(contextDoc, (s, p, o) => this.triples.push(quad(toN3(s), toN3(p), toN3(o))), { onIssue: () => {} });
    this.prefixes = { ...PREFIXES, place: base + 'place/', source: base + 'source/' };
  }
  _fresh() { this.triples = []; this.j2r.shared = new Set(); this.j2r.typedNamed = new Map(); }
  _write() {
    const w = new Writer({ prefixes: this.prefixes });
    w.addQuads(this.triples);
    this.triples = [];
    let out = '';
    w.end((err, text) => { if (err) throw err; out = text; });
    return out;
  }
  /** A place document (placeDocument's) in Turtle. */
  place(doc) {
    this._fresh();
    this.j2r.header({ gazetteer: doc.gazetteer });
    this.j2r.record('spatialEntities', doc.spatialEntities[0]);
    return this._write();
  }
  /** The dataset's description in Turtle. */
  description(head) { this._fresh(); this.j2r.header(head); return this._write(); }
  /**
   * A source in Turtle: it is written as the dataset writes it, cited by an attestation, and only
   * the source's own statements are kept (not the stand-in attestation's).
   */
  source(src, iri) {
    this._fresh();
    this.j2r.header({ gazetteer: {} });
    const doc = this.j2r.doc;
    const tmp = [];
    const emit = this.j2r.emit;
    this.j2r.emit = (s, p, o) => tmp.push([s, p, o]);
    this.j2r.record('attestations', { sources: [{ ...(src && typeof src === 'object' ? src : {}), '@id': iri }] });
    this.j2r.emit = emit;
    const drop = new Set([doc.value]);
    for (const [s, , o] of tmp) if (o.termType === 'NamedNode' && o.value === iri && s.termType === 'BlankNode') drop.add(s.value);
    this.triples = [];
    for (const [s, p, o] of tmp) if (!drop.has(s.value)) this.triples.push(quad(toN3(s), toN3(p), toN3(o)));
    return this._write();
  }
}
