// Compile PLATO's JSON-LD context into an explicit mapping that is used in both directions:
// JSON records to triples (src/formats/json2rdf.js) and triples back to records
// (src/formats/rdf2json.js). jsonld.js is the reference: test/json2rdf.test.js checks that the
// compiled mapping yields the same canonical graph as jsonld.js for every example.
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const PLATO = 'https://w3id.org/plato#';

// The rule jsonld.js applies before emitting an IRI: a scheme, and no whitespace anywhere.
const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/;
export const isAbsoluteIri = (s) => ABSOLUTE.test(s);

export function expandIri(v, prefixes) {
  const i = v.indexOf(':');
  if (i > 0) {
    const p = v.slice(0, i);
    if (Object.prototype.hasOwnProperty.call(prefixes, p) && !v.startsWith(p + '://')) return prefixes[p] + v.slice(i + 1);
  }
  return v;
}

function defineTerm(key, v, prefixes) {
  if (v === null) return { key, drop: true };
  if (v === '@nest') return { key, nest: true };
  if (typeof v === 'string') return { key, iri: expandIri(v, prefixes) };
  const t = { key };
  if (v['@reverse']) { t.reverse = true; t.iri = expandIri(v['@reverse'], prefixes); }
  else if (v['@id']) t.iri = v['@id'] === '@type' ? RDF + 'type' : expandIri(v['@id'], prefixes);
  if (v['@type']) t.type = v['@type'].startsWith('@') ? v['@type'] : expandIri(v['@type'], prefixes);
  if (v['@container']) t.container = v['@container'];
  if (v['@context']) t.scoped = v['@context'];
  return t;
}

export function extend(active, raw) {
  const prefixes = { ...active.prefixes };
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('@') && typeof v === 'string' && /^[a-z][a-z0-9+.-]*:\/\/.*[#/]$/i.test(v)) prefixes[k] = v;
  }
  const terms = new Map(active.terms);
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('@') || prefixes[k] === v) continue;
    terms.set(k, defineTerm(k, v, prefixes));
  }
  return { prefixes, terms, cache: new Map() };
}

export function compileContext(doc) {
  return extend({ prefixes: {}, terms: new Map(), cache: new Map() }, doc['@context'] ?? doc);
}

/** The active context for the value of `term`: its scoped context, which propagates. */
export function child(active, term) {
  if (!term.scoped) return active;
  let c = active.cache.get(term.scoped);
  if (!c) { c = extend(active, term.scoped); active.cache.set(term.scoped, c); }
  return c;
}
