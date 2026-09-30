// Every key the PLATO JSON Schema allows, at every level, as the paths the audit of the writers
// runs over (test/keys.test.js). Walks the two profiles through $ref, allOf and oneOf, so that a
// key PLATO adds is enumerated the moment the tools are re-pinned, with no list to keep up to date.
import { readFileSync } from 'node:fs';

const load = (f) => JSON.parse(readFileSync(new URL(`../public/plato/${f}`, import.meta.url), 'utf8'));
// The core's own references are written relative to it ('#/$defs/uri'); made absolute here, so that a
// definition merged into a profile's allOf still resolves against the core.
const absolute = (x) => (Array.isArray(x) ? x.map(absolute) : x && typeof x === 'object'
  ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === '$ref' && v.startsWith('#') ? 'plato.schema.json' + v : absolute(v)])) : x);
export const CORE = absolute(load('plato.schema.json'));
export const PROFILES = { 'place-centric': load('place-centric.schema.json'), 'attestation-centric': load('attestation-centric.schema.json') };

/** Resolve $ref and merge allOf: { s, def } where def names the $defs entry reached, if any. */
function resolve(s0, root) {
  let s = s0, def = null, r = root;
  while (s && s.$ref) {
    const [file, frag] = s.$ref.split('#');
    if (file) r = CORE;
    if (frag.includes('/$defs/')) def = frag.split('/$defs/')[1];
    s = frag.split('/').filter(Boolean).reduce((o, k) => o[k], r);
  }
  if (s && s.allOf) {
    const merged = { ...s, properties: { ...(s.properties || {}) }, required: [...(s.required || [])] };
    delete merged.allOf;
    for (const part of s.allOf) {
      const p = resolve(part, r);
      def = def || p.def;
      for (const [k, v] of Object.entries(p.s.properties || {})) merged.properties[k] = merged.properties[k] ? { allOf: [merged.properties[k], v] } : v;
      merged.required.push(...(p.s.required || []));
      // A key a profile forbids here (`not: {required: [k]}`: a nested attestation's `about`).
      merged.forbidden = [...(merged.forbidden || []), ...(p.s.forbidden || []), ...(p.s.not?.required || [])];
      if (p.s.items) merged.items = merged.items ? { allOf: [merged.items, p.s.items] } : p.s.items;
      if (p.s.type) merged.type = p.s.type;
      for (const k of ['enum', 'format', 'pattern', 'const', 'oneOf', 'minItems', 'maxItems']) if (p.s[k] !== undefined && merged[k] === undefined) merged[k] = p.s[k];
    }
    s = merged;
  }
  return { s, def, root: r };
}
const isObject = (s) => !!s && !!s.properties && Object.keys(s.properties).length > 0 && (s.type === undefined || s.type === 'object');

// Objects whose members are one value to a writer, not keys of PLATO's own: a GeoJSON geometry, the
// IRI-keyed coordinates and attributes of a statistical figure, a structured property value.
const WHOLE = new Set(['geojson', 'dimensions', 'attributes', 'value']);

/**
 * Every key path: [{ path: ['spatialEntities', 0, 'attestations', 0, 'names', 0, 'ipa'], key, schema,
 * host, hosts, variant }]. `host` names the object that holds the key ($defs name, or 'gazetteer',
 * 'structure', 'component'); `hosts` the chain of hosts from the document down. A key whose value may
 * be a URI or an object (oneOf) is enumerated both ways, the object's keys under `key{}`.
 */
export function keyPaths(profile = 'place-centric', { only } = {}) {
  const root = PROFILES[profile];
  const out = [];
  const walk = (s0, r0, path, host, hosts, seen) => {
    const { s, root: r } = resolve(s0, r0);
    for (const [key, ks0] of Object.entries(s.properties || {})) {
      if (only && path.length === 0 && !only.includes(key)) continue;
      if ((s.forbidden || []).includes(key)) continue;
      const { s: ks, def, root: kr } = resolve(ks0, r);
      const variants = ks.oneOf ? ks.oneOf.map((v) => resolve(v, kr)) : [{ s: ks, def, root: kr }];
      for (const v of variants) {
        const arr = v.s.type === 'array';
        const item = arr ? resolve(v.s.items, v.root) : v;
        // An object defined in place rather than in $defs is its own host: the gazetteer, a table's
        // structure and its components, and the gazetteer's creators and temporal coverage.
        const childHost = item.def || (key === 'gazetteer' ? 'gazetteer' : key === 'structure' ? 'structure' : key === 'components' ? 'component'
          : host === 'gazetteer' && (key === 'creator' || key === 'temporal') ? key : null);
        const objectVariant = isObject(item.s) && !WHOLE.has(key);
        const leaf = { path: [...path, key], key, schema: v.s, item: item.s, def: item.def, childHost, host, hosts, variant: ks.oneOf ? (objectVariant ? 'object' : 'value') : null };
        if (!objectVariant) { out.push(leaf); continue; }
        // A definition met again on its own path (a source derived from a source) is entered once more,
        // no deeper: the second time its keys are those of the same writer code.
        const n = seen.filter((x) => x === childHost).length;
        if (n >= 2) continue;
        // A container is tested through its members; a oneOf's object form also as a whole, since
        // a writer may take the URI form and drop the object, or the other way round.
        if (ks.oneOf) out.push({ ...leaf, container: true });
        walk(item.s, item.root, arr ? [...path, key, 0] : ks.oneOf ? [...path, key + '{}'] : [...path, key], childHost, [...hosts, childHost], [...seen, childHost]);
      }
    }
  };
  walk(root, root, [], '$doc', ['$doc'], []);
  return out;
}
