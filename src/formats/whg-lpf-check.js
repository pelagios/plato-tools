// What the World Historical Gazetteer would say of Linked Places Format v2, before anything is uploaded.
//
// WHG validates an uploaded file one feature at a time, each alone in a FeatureCollection, against its
// JSON Schema (draft-07), copied here as src/vendor/whg-lpf_v2.0.json (see the NOTICE beside it). This
// module does the same with the same schema, so the verdict is the schema's and never a paraphrase of
// it, and then says each failure in plain words: a place with no kind and no date fails some sixteen
// of the schema's rules, which are two things to tell its maker.
//
// It checks, and changes nothing: a place that has no kind of place or no date is reported, never given
// one. What it does not do is what WHG does besides its schema: WHG also tests each geometry's shape
// (a polygon that crosses itself) and mends what it can (a number where a string belongs, an id with no
// namespace), so a place refused here for one of those might be mended there.
//
// validateForWhg(collection or features) is the whole of it for a caller; whgChecker() is the same rules
// fed one feature at a time, for a file too large to hold (the pipeline's writer, and check --whg).
import Ajv from 'ajv';
import SCHEMA from '../vendor/whg-lpf_v2.0.json' with { type: 'json' };

let compiled = null;
function validator() {
  if (compiled) return compiled;
  // As WHG's own page compiles it (whg3, recon-validate.js): the schema's patterns are not written for
  // the u flag, and its notes to itself (comment, notes, required-NOT-IN-LPF-TSV-SPEC) are not keywords.
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, unicodeRegExp: false });
  // A collection's own citation (CSL), which no feature has: anything is accepted in its place.
  ajv.addSchema({ $id: 'https://whgazetteer.org/schema/csl-citation.json' });
  return (compiled = ajv.compile(SCHEMA));
}

/**
 * Each thing WHG's schema can refuse a place for: `each` completes "This place …" (and is what
 * `problems` holds); `many` completes "N places …" for a summary.
 */
export const WHG_PROBLEMS = {
  'no-kind': { each: 'has no kind of place; WHG needs one (a type, or a feature class)', many: ['has no kind of place; WHG needs one', 'have no kind of place; WHG needs one'] },
  'no-date': { each: 'has no date; WHG needs one (a year or a span of years, for the place or for one of its names, types, locations or relations)', many: ['has no date; WHG needs one', 'have no date; WHG needs one'] },
  'no-names': { each: 'has no name; WHG needs at least one', many: ['has no name; WHG needs at least one', 'have no name; WHG needs at least one'] },
  'no-title': { each: 'has no title (the name it is listed under)', many: ['has no title', 'have no title'] },
  'no-id': { each: 'has no id (@id)', many: ['has no id', 'have no id'] },
  'bad-id': { each: 'has an id (@id) that is neither a web address nor a prefixed name (such as wd:Q84)', many: ['has an id WHG cannot read', 'have an id WHG cannot read'] },
  'name-at': { each: 'has a name that ends with "@" and no language', many: ['has a name that ends with "@" and no language', 'have a name that ends with "@" and no language'] },
  'name-language': { each: 'has a name written as name@language whose language WHG does not read as one', many: ['has a name whose language WHG does not read', 'have a name whose language WHG does not read'] },
  name: { each: 'has a name with no toponym', many: ['has a name with no toponym', 'have a name with no toponym'] },
  language: { each: 'gives a language WHG does not read as one (it reads tags such as en, fr or ar-Latn)', many: ['gives a language WHG does not read', 'give a language WHG does not read'] },
  'geometry-missing': { each: 'has no geometry member (it must be there; null says there is no location)', many: ['has no geometry member', 'have no geometry member'] },
  geometry: { each: 'has a location WHG cannot read', many: ['has a location WHG cannot read', 'have a location WHG cannot read'] },
  'when-no-years': { each: 'has a date with no years in it (a period or a label alone); WHG needs years', many: ['has a date with no years in it', 'have a date with no years in it'] },
  date: { each: 'has a date WHG cannot read (it reads a year of up to four digits, with a month and a day if given, or a year before -9999)', many: ['has a date WHG cannot read', 'have a date WHG cannot read'] },
  certainty: { each: 'gives a certainty that is not one of certain, less-certain and uncertain', many: ['gives a certainty WHG does not know', 'give a certainty WHG does not know'] },
  link: { each: 'has a link WHG cannot read (its address must be a web address or one of the prefixes WHG knows, such as wd:Q84, and its type closeMatch, exactMatch, primaryTopicOf, subjectOf or seeAlso)', many: ['has a link WHG cannot read', 'have a link WHG cannot read'] },
  relation: { each: 'has a relation whose type or target is neither a web address nor a prefixed name', many: ['has a relation WHG cannot read', 'have a relation WHG cannot read'] },
  'type-id': { each: 'has a type whose identifier is neither a web address nor a prefixed name (such as aat:300008347)', many: ['has a type WHG cannot read', 'have a type WHG cannot read'] },
  'kind-code': { each: 'has a feature class that is not one of A, H, L, P, R, S, T, U, V and X', many: ['has a feature class WHG does not know', 'have a feature class WHG does not know'] },
  country: { each: 'has a country code that is not an ISO 3166-1 two-letter code', many: ['has a country code WHG does not know', 'have a country code WHG does not know'] },
  citation: { each: 'has a citation WHG cannot read (it needs a label or an @id, and its year in digits)', many: ['has a citation WHG cannot read', 'have a citation WHG cannot read'] },
  depiction: { each: 'has an image with no @id, title or licence; WHG needs all three', many: ['has an image with no @id, title or licence', 'have an image with no @id, title or licence'] },
  description: { each: 'has a description with no text, or whose source is not a web address', many: ['has a description WHG cannot read', 'have a description WHG cannot read'] },
  other: { each: "does not match WHG's schema", many: ["does not match WHG's schema in another way", "do not match WHG's schema in another way"] },
};

const P = '/features/0';
const TYPES = new Set(['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection']);
/** What is wrong with a geometry's own shape, in words, or null when its type and positions are as the schema asks. */
function geometryFault(g) {
  if (g === null) return null;
  if (typeof g !== 'object' || Array.isArray(g)) return 'it is not a GeoJSON geometry';
  if (!TYPES.has(g.type)) return g.type === undefined ? 'it has no type' : `its type is ${JSON.stringify(g.type)}`;
  if (g.type === 'GeometryCollection') {
    if (!Array.isArray(g.geometries)) return 'a GeometryCollection with no geometries';
    for (const x of g.geometries) { const fault = geometryFault(x); if (fault) return fault; }
    return null;
  }
  if (!Array.isArray(g.coordinates)) return 'it has no coordinates';
  let fault = null;
  const position = (c) => {
    if (fault) return;
    if (!Array.isArray(c) || c.length < 2 || c.some((v) => typeof v !== 'number')) fault = 'a position is not a longitude and a latitude';
    else if (c.length > 2) fault = 'a position has more than a longitude and a latitude (a height, perhaps); WHG reads two numbers';
    else if (c[0] < -180 || c[0] > 180 || c[1] < -90 || c[1] > 90) fault = `a position is not on the earth (${c[0]}, ${c[1]})`;
  };
  const depth = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 }[g.type];
  const walk = (c, d) => { if (fault) return; if (d === 0) return position(c); if (!Array.isArray(c)) { fault = 'its coordinates are not nested as its type needs'; return; } for (const x of c) walk(x, d - 1); };
  walk(g.coordinates, depth);
  return fault;
}
const at = (f, path) => path.split('/').slice(1).reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), f);
const shown = (v) => (typeof v === 'string' ? JSON.stringify(v) : v === undefined ? undefined : JSON.stringify(v));

/** The schema's errors for one feature, as the things to tell its maker: [{ code, detail? }], each once. */
function problemsOf(f, errors) {
  const out = new Map();
  const add = (code, detail) => { const k = code + '\u0001' + (detail ?? ''); if (!out.has(k)) out.set(k, detail === undefined ? { code } : { code, detail }); };
  // Each of the schema's two great rules is an anyOf over several places a kind or a date may be, and a
  // place with none fails every branch: they are one statement each, as WHG's own page says them.
  const undated = errors.some((e) => e.instancePath === P && e.schemaPath === '#/allOf/1/anyOf');
  const unkinded = errors.some((e) => e.instancePath === P && e.schemaPath === '#/allOf/0/anyOf');
  if (unkinded) add('no-kind');
  if (undated) add('no-date');
  let geometry = false, insideGeometry = false;
  for (const e of errors) {
    if ((undated && e.schemaPath.startsWith('#/allOf/1/anyOf')) || (unkinded && e.schemaPath.startsWith('#/allOf/0/anyOf'))) continue;
    const path = e.instancePath.startsWith(P) ? e.instancePath.slice(P.length) : e.instancePath;
    const value = at(f, path), missing = e.keyword === 'required' ? e.params?.missingProperty : undefined;
    const inGeometry = path === '/geometry' || path.startsWith('/geometry/');
    if (path === '' && missing) add({ '@id': 'no-id', names: 'no-names', geometry: 'geometry-missing', properties: 'no-title' }[missing] || 'other', missing === 'type' ? 'it has no type' : undefined);
    else if (path === '/@id') add('bad-id', shown(value));
    else if (path === '/properties' || path === '/properties/title') add('no-title');
    else if (path.startsWith('/properties/ccodes')) add('country', Array.isArray(value) ? undefined : shown(value));
    else if (path.startsWith('/properties/fclasses')) add('kind-code', Array.isArray(value) ? undefined : shown(value));
    else if (/\/certainty$/.test(path)) add('certainty', shown(value));
    else if (/\/lang$/.test(path)) add('language', shown(value));
    else if (/\/citations?(\/|$)/.test(path)) add('citation', typeof value === 'object' ? undefined : shown(value));
    else if (/\/when(\/|$)/.test(path)) {
      if (missing === 'timespans') add('when-no-years');
      else add('date', typeof value === 'object' ? undefined : shown(value));
    }
    else if (path === '/names') { if (!Array.isArray(f.names) || !f.names.length) add('no-names'); }   // else: a name that failed, said below
    else if (/^\/names\/\d+\/toponym$/.test(path)) add(typeof value === 'string' && /@\s*$/.test(value) ? 'name-at' : typeof value === 'string' && value.includes('@') ? 'name-language' : 'name', shown(value));
    else if (/^\/names\/\d+$/.test(path)) add('name');
    else if (inGeometry) { geometry = true; continue; }
    else if (path.startsWith('/links')) { if (e.keyword !== 'anyOf') add('link', typeof value === 'object' ? undefined : shown(value)); }
    else if (path.startsWith('/relations')) { if (e.keyword !== 'anyOf') add('relation', typeof value === 'object' ? undefined : shown(value)); }
    else if (path.startsWith('/types')) { if (e.keyword !== 'anyOf') add('type-id', typeof value === 'object' ? undefined : shown(value)); }
    else if (path.startsWith('/depictions')) add('depiction', shown(at(f, path.split('/').slice(0, 3).join('/'))?.['@id']));
    else if (path.startsWith('/descriptions')) add('description');
    else add('other', `${path.slice(1) || 'the feature'} ${e.message}`);
    if (inGeometry) insideGeometry = true;   // said by one of the rules above, not left to the geometry's own
  }
  // A geometry is one of seven shapes, and one that is none of them fails all seven: one statement, with
  // what is wrong with its shape where that can be seen; nothing more where the fault is a date or a
  // citation inside it, which has been said.
  if (geometry) { const fault = geometryFault(f?.geometry); if (fault) add('geometry', fault); else if (!insideGeometry) add('geometry'); }
  if (!out.size) add('other');
  return [...out.values()];
}

const words = (p) => WHG_PROBLEMS[p.code].each + (p.detail !== undefined ? `: ${p.detail}` : '');
/**
 * WHG's verdict on one feature: { valid, problems: [plain words], found: [{ code, detail? }] }.
 * As WHG does it: the feature alone in a FeatureCollection, against the schema.
 */
export function checkFeatureForWhg(feature) {
  const validate = validator();
  if (validate({ type: 'FeatureCollection', features: [feature] })) return { valid: true, problems: [], found: [] };
  const found = problemsOf(feature, validate.errors || []);
  return { valid: false, problems: found.map(words), found };
}

/**
 * The same rules fed one feature at a time: feature(f, n) returns checkFeatureForWhg's verdict and
 * counts it; result() is { total, valid, refused, summary, invalid }. `summary` is one entry for each
 * kind of problem, most places first: { code, count, text ("12 places have no kind of place; WHG needs
 * one"), examples: up to `examples` of { id, label, detail? } }. `invalid` lists every refused place
 * ({ id, label, problems, codes }) only with keep: true, as it grows with the data.
 */
export function whgChecker({ examples = 5, keep = false } = {}) {
  let total = 0, valid = 0;
  const invalid = [], groups = new Map();
  return {
    feature(f, n = total + 1) {
      total++;
      const verdict = checkFeatureForWhg(f);
      if (verdict.valid) { valid++; return verdict; }
      const id = (f && typeof f === 'object' && typeof f['@id'] === 'string' && f['@id']) || `feature ${n}`;
      const label = typeof f?.properties?.title === 'string' ? f.properties.title : undefined;
      const seen = new Set();
      for (const p of verdict.found) {
        const g = groups.get(p.code) || groups.set(p.code, { code: p.code, count: 0, examples: [] }).get(p.code);
        if (seen.has(p.code)) continue;   // a place counts once for each kind of problem, however many of its names have it
        seen.add(p.code);
        g.count++;
        if (g.examples.length < examples) g.examples.push(p.detail === undefined ? { id, label } : { id, label, detail: p.detail });
      }
      if (keep) invalid.push({ id, label, problems: verdict.problems, codes: [...seen] });
      return verdict;
    },
    result() {
      const summary = [...groups.values()].sort((a, b) => b.count - a.count).map((g) => ({ ...g, text: `${g.count.toLocaleString('en-GB')} ${g.count === 1 ? 'place' : 'places'} ${WHG_PROBLEMS[g.code].many[g.count === 1 ? 0 : 1]}` }));
      return { total, valid, refused: total - valid, summary, invalid };
    },
  };
}

/**
 * What WHG's schema would say of a Linked Places Format v2 collection: a FeatureCollection, a list of
 * features, or a GeoJSON sequence as text (one feature a line; a collection's own first line is passed
 * over). Returns { total, valid, refused, invalid: [{ id, label, problems: [plain words], codes }], summary }:
 * `valid` is how many places WHG would accept, of `total`.
 */
export function validateForWhg(input, options = {}) {
  let features;
  if (typeof input === 'string') features = input.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((v, i) => !(i === 0 && v && v.type === 'FeatureCollection' && !Array.isArray(v.features)));
  else if (Array.isArray(input)) features = input;
  else features = Array.isArray(input?.features) ? input.features : [];
  const checker = whgChecker({ keep: true, ...options });
  features.forEach((f, i) => checker.feature(f, i + 1));
  return checker.result();
}

/** An example for a report: the place by its title and id, then what was found where that is known. */
export const whgExample = (x) => `${x.label ? `${x.label} (${x.id})` : x.id}${x.detail !== undefined ? `: ${x.detail}` : ''}`;
