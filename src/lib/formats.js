// JSON Schema formats for PLATO's schemas, on top of ajv-formats.
//
// Since PLATO cf87b78 the shared `uri` definition has format "iri", so that identifiers with
// non-ASCII characters (Pleiades' #André-1980) are valid as written. ajv-formats knows "uri" but
// not "iri", and with `strict: false` ajv ignores a format it does not know: it would accept any
// string at all where PLATO requires a web address. So "iri" (and "iri-reference", for
// completeness) are defined here, and ajv is told to refuse, not ignore, any other format it
// does not know, so that a schema change of this kind stops the tools instead of switching a
// check off in silence.
//
// An IRI (RFC 3987) is a URI whose unreserved characters may also be the non-ASCII `ucschar`
// ranges, and whose query may also hold `iprivate` characters. Its URI mapping (RFC 3987, 3.1)
// percent-encodes exactly those characters; the IRI is valid when that mapping is a valid URI.
// So each is checked with ajv-formats' own URI rule after the mapping, and anything else outside
// ASCII (controls, surrogates, non-characters) is left in place for that rule to reject.
import addFormats from 'ajv-formats';

const UCSCHAR = /[\u{A0}-\u{D7FF}\u{F900}-\u{FDCF}\u{FDF0}-\u{FFEF}\u{10000}-\u{EFFFD}]/gu;   // non-characters and tags are excluded below
const IPRIVATE = /[\u{E000}-\u{F8FF}\u{F0000}-\u{10FFFD}]/gu;   // allowed in a query only
// Not allowed anywhere: U+xFFFE and U+xFFFF in every plane, and the tag block U+E0000-E0FFF.
const excluded = (cp) => (cp & 0xFFFE) === 0xFFFE || (cp >= 0xE0000 && cp <= 0xE0FFF);
const encode = (ch) => (excluded(ch.codePointAt(0)) ? ch
  : [...new TextEncoder().encode(ch)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''));
/** The URI an IRI maps to (RFC 3987, 3.1): allowed non-ASCII characters percent-encoded as UTF-8. */
export function iriToUri(s) {
  // The fragment starts at the first '#'; the query at the first '?' before it.
  const f = s.indexOf('#');
  const beforeFrag = f < 0 ? s : s.slice(0, f), frag = f < 0 ? '' : s.slice(f);
  const q = beforeFrag.indexOf('?');
  const head = q < 0 ? beforeFrag : beforeFrag.slice(0, q), query = q < 0 ? '' : beforeFrag.slice(q);
  return head.replace(UCSCHAR, encode) + query.replace(UCSCHAR, encode).replace(IPRIVATE, encode) + frag.replace(UCSCHAR, encode);
}

/** ajv with ajv-formats and PLATO's "iri" formats; an unknown format stops compilation. */
export function addPlatoFormats(ajv) {
  addFormats(ajv);
  // ajv-formats defines each format as a function, a regular expression or { validate }.
  const rule = (name) => {
    const f = ajv.formats[name], v = f && !(f instanceof RegExp) && typeof f === 'object' ? f.validate : f;
    if (typeof v === 'function') return v;
    if (v instanceof RegExp) return (s) => v.test(s);
    throw new Error(`ajv-formats does not define "${name}"`);
  };
  const uri = rule('uri'), uriRef = rule('uri-reference');
  ajv.addFormat('iri', (s) => uri(iriToUri(s)));
  ajv.addFormat('iri-reference', (s) => uriRef(iriToUri(s)));
  return ajv;
}

/** An ajv logger that turns "unknown format" into an error: such a format would otherwise check nothing. */
export const strictFormatLogger = {
  log: console.log.bind(console),
  warn(...args) {
    const msg = args.join(' ');
    if (/unknown format/.test(msg)) throw new Error(`The PLATO schemas use a format these tools do not know, so it could not be checked: ${msg}`);
    console.warn(...args);
  },
  error: console.error.bind(console),
};
