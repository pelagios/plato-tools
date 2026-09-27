// RDF terms as plain objects, and N-Triples serialisation.
import { XSD } from './context.js';
export const XSD_STRING = XSD + 'string';
export const iri = (value) => ({ termType: 'NamedNode', value });
export const bnode = (value) => ({ termType: 'BlankNode', value });
export const literal = (value, datatype = XSD_STRING, language = null) => ({ termType: 'Literal', value, datatype, language });

const escIri = (s) => s.replace(/[\u0000- <>"{}|^`\\]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
const escLit = (s) => s.replace(/[\\"\n\r]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r' })[c]);
export function termNT(t) {
  if (t.termType === 'NamedNode') return '<' + escIri(t.value) + '>';
  if (t.termType === 'BlankNode') return '_:' + t.value;
  const v = '"' + escLit(t.value) + '"';
  if (t.language) return v + '@' + t.language;
  return t.datatype && t.datatype !== XSD_STRING ? v + '^^<' + escIri(t.datatype) + '>' : v;
}
export const tripleNT = (s, p, o) => termNT(s) + ' ' + termNT(p) + ' ' + termNT(o) + ' .\n';
