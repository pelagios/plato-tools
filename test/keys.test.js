// No writer drops a key silently. For every key the JSON Schema allows, at every level (enumerated
// from the schema itself by test/keys.js, so a key PLATO adds is covered as soon as the tools are
// re-pinned), each writer must either carry the value into its output or report that it is lost.
//
// Each key is set, with a value of its own, on an object that the writer can write (a name with a
// spelling, a location with coordinates, a dated timespan and an undated one), and the document is
// converted with and without it. The key is carried when the output changes and, for a text value,
// contains it; it is reported when a loss appears that was not there without it. A key whose whole
// object a writer leaves out (a comment on another attestation, in LPF) is covered by that object's
// own loss, and the test checks that the loss is there. Anything else fails, naming the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { keyPaths, CORE, PROFILES } from './keys.js';
import { go, textFile, outText } from './engine.js';

const E = 'https://example.org/', P = 'https://w3id.org/plato#';
const slugOf = (path) => path.filter((x) => x !== 0).join('-').replace(/[{}@$]/g, '').toLowerCase();

// ---- the document every key is set in -----------------------------------------------------------
const baseDoc = () => ({
  profile: 'place-centric', gazetteer: { title: 'Keys gazetteer' },
  spatialEntities: [{ '@id': E + 'place/base', label: 'Base place',
    attestations: [{ names: [{ toponym: 'Basename' }], sources: [{ '@id': E + 'source/base', title: 'Base source', authorityType: 'source' }] }] }],
});
/** A writable object of each kind, so that a key is tested where the writer would write it. */
function hostBase(host, slug) {
  switch (host) {
    case 'dataSet': return { '@id': E + 'table/' + slug };
    case 'structure': return { '@id': E + 'structure/' + slug, components: [{ dimension: E + 'dim/base' }] };
    case 'component': return { dimension: E + 'dim/base' };
    case 'name': return { toponym: 'Basename' };
    case 'geometry': return { reprPoint: [-1.1, 51.1] };
    case 'timespan': return { startEarliest: '1300', endLatest: '1300' };
    case 'type': return { label: 'Basetype', identifier: E + 'type/base' };
    case 'propertyValue': return { property: E + 'prop/base', value: 'basevalue' };
    case 'source': return { '@id': E + 'source/' + slug, title: 'Source ' + slug, authorityType: 'source' };
    case 'citation': return { source: E + 'source/base' };
    case 'relation': return { relatesTo: E + 'place/other', relationType: P + 'ContainedIn' };
    case 'metaAttestation': return { targetAttestation: E + 'att/other', metaType: P + 'Supports' };
    case 'identityRelation': return { subject: E + 'place/base', object: E + 'place/same-' + slug, identityType: 'closeMatch' };
    case 'qualification': return {};
    case 'contributorObject': return { name: 'Base contributor' };
    case 'organization': return { name: 'Base organisation' };
    default: throw new Error(`no host object for ${host}`);
  }
}

// ---- a value of its own for each key --------------------------------------------------------------
const BY_KEY = {
  geojson: (n) => ({ type: 'Point', coordinates: [-2.5 - n / 1000, 53.5] }),
  reprPoint: (n) => [-3 - n / 1000, 54.25], bbox: (n) => [-4, 50, -3.5, 50.5 + n / 1000], precisionKm: (n) => [1.5 + n / 1000],
  wkt: (n) => `POINT(${-5 - n / 1000} 55.5)`, hull: (n) => `POLYGON((0 0, 1 0, 1 ${1 + n / 1000}, 0 0))`,
  value: (n, slug) => 'value-' + slug,
  dimensions: (n, slug) => ({ [E + 'dim/' + slug]: { '@id': E + 'code/' + slug } }),
  attributes: (n, slug) => ({ [E + 'attr/' + slug]: 'attr-' + slug }),
  orcid: () => 'https://orcid.org/0000-0002-1825-0097', email: (n, slug) => `k-${slug}@example.org`,
  metaType: () => P + 'Contradicts', identityType: () => 'exactMatch', authorityType: () => 'dataset',
  certaintyLevel: () => P + 'LessCertain', language: (n) => 'cy-k' + n,
  assertedAt: (n) => `2026-01-01T${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00Z`,
  created: (n) => `2025-01-01T${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00Z`,
  modified: (n) => `2025-06-01T${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00Z`,
  negated: () => true,
};
// A nested identity relation's subject, if given, must be its place (PLATO eb8065a).
const SAME_AS_NESTING = new Set(['spatialEntities.0.identityRelations.0.subject']);
function sample(entry, n) {
  const slug = slugOf(entry.path);
  if (SAME_AS_NESTING.has(entry.path.join('.'))) return E + 'place/base';
  if (entry.container) return hostBase(entry.childHost, slug);
  if (BY_KEY[entry.key]) return BY_KEY[entry.key](n, slug);
  const one = (s) => {
    if (s.enum) return s.enum.find((v) => v !== s.default && v !== 'source' && v !== 'closeMatch') ?? s.enum[0];
    if (s.format === 'iri' || s.format === 'uri' || s.format === 'iri-reference') return E + 'k/' + slug;
    if (s.pattern && s.pattern.startsWith('^-?\\d{4,}')) return String(1000 + (n % 900));
    if (s.type === 'integer') return 700 + n;
    if (s.type === 'number') return (s.maximum === 1 ? 0.3 + n / 10000 : 7.5 + n);
    if (s.type === 'boolean') return true;
    if (s.type === 'string' || !s.type) return 'k-' + slug;
    throw new Error(`no sample for ${entry.path.join('.')}`);
  };
  if (entry.schema.type === 'array') return [one(entry.item)];
  return one(entry.schema);
}
// The value to look for in the output: text of its own. A vocabulary word (an enum value) is written
// as the term it stands for, so only a change in the output is looked for.
// A certainty level is written as a format's own word (LPF's less-certain, the tables' LessCertain).
const marker = (v, entry) => (typeof v === 'string' && v.length > 5 && !(entry.schema.enum || entry.item?.enum) && entry.key !== 'certaintyLevel' ? v : null);

/** The document with the key's host objects in place, with the key set to `value` (or left out). */
export function build(entry, value, variant) {
  const doc = baseDoc();
  let cur = doc;
  const segs = entry.path;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (seg === 0) continue;
    const key = String(seg).replace('{}', '');
    const arr = segs[i + 1] === 0;
    const childHost = hostAt(entry, i);
    // A key whose value may be an address or an object (a citation's source) is given the object.
    if (cur[key] === undefined || (String(seg).endsWith('{}') && typeof cur[key] !== 'object')) cur[key] = arr ? [hostBase(childHost, slugOf(segs.slice(0, i + 1)))] : hostBase(childHost, slugOf(segs.slice(0, i + 1)));
    cur = arr ? cur[key][0] : cur[key];
    if (variant === 'undated' && childHost === 'timespan' && key === 'timespans') { delete cur.startEarliest; delete cur.endLatest; }
    // A property LPF has a place for: a description, rather than a property it leaves out whole.
    if (variant === 'description' && childHost === 'propertyValue') Object.assign(cur, { property: 'http://purl.org/dc/terms/description', value: 'Base description' });
  }
  const leaf = String(segs[segs.length - 1]).replace('{}', '');
  // A citation that describes its source in full is the attestation's source: the base one goes.
  if (segs[2] === 'attestations' && segs[4] === 'citations' && segs[6] === 'source{}') delete doc.spatialEntities[0].attestations[0].sources;
  if (value === undefined) { if (!REQUIRED_BASE(cur, leaf)) delete cur[leaf]; }
  else cur[leaf] = value;
  // The header first, as documents are written: dataSets after the records is a late header, which
  // the readers report as such.
  const { $schema, profile, gazetteer, dataSets, ...rest } = doc;
  return JSON.parse(JSON.stringify({ $schema, profile, gazetteer, dataSets, ...rest }));
}
/** The host of the object reached at path segment i: the n-th object segment's host in entry.hosts. */
function hostAt(entry, i) {
  const objSegs = entry.path.slice(0, i + 1).filter((x) => x !== 0).length;
  return entry.hosts[objSegs];
}
// A key without which its object would not be written at all (a name's spelling, a location's only
// coordinates) keeps its base value in the document without the key, so that "without" differs from
// "with" only in that value. Any other key is left out.
const NEEDED = new Set(['toponym', 'reprPoint', 'relatesTo', 'relationType', 'object', 'identityType', 'targetAttestation', 'metaType', 'source', 'property', 'dimension']);
const REQUIRED_BASE = (host, key) => host[key] !== undefined && NEEDED.has(key);

// ---- the writers ------------------------------------------------------------------------------------
// Each loss by kind and words, with its count and its examples: a loss already there without the key
// is new when it happens more often or names something new (a different address).
const lossesOf = (reports) => {
  const m = new Map();
  for (const r of reports) for (const i of r.items) if (i.severity === 'loss') {
    const k = i.kind + '\u0001' + i.message, e = m.get(k) || { count: 0, examples: new Set() };
    e.count += i.count; for (const x of i.examples) e.examples.add(JSON.stringify(x)); m.set(k, e);
  }
  return m;
};
export async function convert(writer, doc) {
  const json = JSON.stringify(doc);
  if (writer === 'rdf-json') {
    const a = await go([textFile(json, 'k.json')], 'convert', 'ntriples');
    const b = await go([textFile(outText(a.e, 'k.nt'), 'k.nt')], 'convert', 'plato-json');
    return { out: outText(b.e, 'k.json'), losses: lossesOf([a.report, b.report]) };
  }
  const r = await go([textFile(json, 'k.json')], 'convert', writer === 'rdf-json' ? 'plato-json' : writer);
  let out;
  if (writer === 'tables') { const z = unzipSync(r.e.outs['k-tables.zip'][0]); out = Object.keys(z).sort().map((k) => k + '\n' + strFromU8(z[k])).join('\n'); }
  else out = outText(r.e, { lpf: 'k.geojson', 'lpf-seq': 'k.geojsonl', ntriples: 'k.nt' }[writer]);
  return { out, losses: lossesOf([r.report]) };
}
export const WRITERS = ['lpf', 'lpf-seq', 'tables', 'ntriples', 'rdf-json'];

// Keys that say what format a document is in, not what it holds: each output declares its own.
export const NOT_DATA = new Set(['$schema', 'profile']);

/**
 * Where a writer leaves out a whole object, and the loss it reports for it: the object's keys are
 * covered by that report. Keyed by the path to the object, without array indices.
 */
export const WHOLE_LOSS = {
  lpf: {}, 'lpf-seq': {}, tables: {}, ntriples: {}, 'rdf-json': {},
};
for (const w of ['lpf', 'lpf-seq', 'tables']) Object.assign(WHOLE_LOSS[w], { dataSets: 'statistical-tables', 'spatialEntities.attestations.meta': 'meta-attestation' });
WHOLE_LOSS.tables['spatialEntities.attestations.contributor'] = 'dropped:attestation.contributor';
for (const w of ['lpf', 'lpf-seq']) {
  Object.assign(WHOLE_LOSS[w], {
    'spatialEntities.attestations.contributor': 'dropped:attestation.contributor',
    'spatialEntities.attestations.properties': 'property-value',        // a property LPF has no place for (the description variant tests the rest)
    'spatialEntities.attestations.sources.derivedFrom': 'source-derivation',
    'spatialEntities.attestations.citations.source.derivedFrom': 'source-derivation',
    'spatialEntities.identityRelations.source': 'dropped:identityRelation.source',
    'identityRelations.source': 'dropped:identityRelation.source',
  });
}

const pattern = (path) => path.filter((x) => x !== 0).map((x) => String(x).replace('{}', '')).join('.');

/** For one writer and one key: 'carried', 'reported', 'reported-with:<kind>', or a failure message. */
export async function judge(writer, entry, n, variant) {
  const without = await convert(writer, build(entry, undefined, variant));
  const value = sample(entry, n);
  const withKey = await convert(writer, build(entry, value, variant));
  for (let i = entry.path.length - 1; i > 0; i--) {
    const kind = WHOLE_LOSS[writer][pattern(entry.path.slice(0, i))];
    if (kind && [...without.losses.keys()].some((k) => k.startsWith(kind + '\u0001'))) return `reported-with:${kind}`;
  }
  const newLoss = [...withKey.losses].filter(([k, c]) => { const w = without.losses.get(k); return !w || w.count < c.count || [...c.examples].some((x) => !w.examples.has(x)); }).map(([k]) => k.split('\u0001')[0]);
  // Given as its place, a nested subject adds nothing: the output must be the same, and nothing reported.
  if (SAME_AS_NESTING.has(entry.path.join('.'))) return withKey.out === without.out && !newLoss.length ? 'carried' : 'FAIL: a subject that is its own place changed the output';
  if (newLoss.length) return 'reported:' + [...new Set(newLoss)].join(',');
  const m = marker(value, entry);
  if (withKey.out !== without.out && (!m || withKey.out.includes(m) || withKey.out.includes(JSON.stringify(m).slice(1, -1)))) return 'carried';
  return withKey.out !== without.out ? `FAIL: output changed but the value ${JSON.stringify(m)} is not in it, and no loss is reported` : 'FAIL: neither carried nor reported';
}
export function cases() {
  const out = [];
  let n = 0;
  for (const e of keyPaths('place-centric')) {
    if (NOT_DATA.has(e.key) && e.path.length === 1) continue;
    n++;
    out.push({ e, n, variant: null });
    if (e.path.join('.').startsWith('spatialEntities.0.attestations.0.timespans.0.')) out.push({ e, n: n + 500, variant: 'undated' });
    if (e.path.join('.').startsWith('spatialEntities.0.attestations.0.properties.0.')) out.push({ e, n: n + 1000, variant: 'description' });
  }
  return out;
}

// ---- attestation-centric: the keys only that profile has ------------------------------------------
// Everything under its attestations and newSpatialEntities is a definition the place-centric cases
// already cover; what is its own is an attestation's `about` and the new places themselves.
const acDoc = () => ({
  profile: 'attestation-centric', gazetteer: { title: 'Keys gazetteer' },
  attestations: [{ about: E + 'place/base', names: [{ toponym: 'Basename' }], sources: [{ '@id': E + 'source/base', title: 'Base source', authorityType: 'source' }] }],
  newSpatialEntities: [{ '@id': E + 'place/base', label: 'Base place', attestations: [{ names: [{ toponym: 'Newname' }] }] }],
});
export function acCases() {
  const out = [];
  let n = 2000;
  for (const e of keyPaths('attestation-centric')) {
    const p = e.path.join('.');
    const own = p === 'attestations.0.about' || (e.path[0] === 'newSpatialEntities' && e.path.length === 3 && !e.container && e.key !== 'attestations');
    if (own) out.push({ e, n: n++, ac: true });
  }
  return out;
}
function buildAc(entry, value) {
  const doc = acDoc();
  const [top, , key] = entry.path;
  const host = doc[top][0];
  if (value === undefined) { if (!['about', '@id', 'label'].includes(key)) delete host[key]; } else host[key] = value;
  return doc;
}
async function judgeAc(writer, entry, n) {
  const without = await convert(writer, buildAc(entry, undefined));
  const value = sample(entry, n);
  const withKey = await convert(writer, buildAc(entry, value));
  const newLoss = [...withKey.losses].filter(([k, c]) => { const w = without.losses.get(k); return !w || w.count < c.count || [...c.examples].some((x) => !w.examples.has(x)); });
  if (newLoss.length) return 'reported';
  const m = marker(value, entry);
  if (withKey.out !== without.out && (!m || withKey.out.includes(m))) return 'carried';
  return 'FAIL: neither carried nor reported';
}

// ---- the tests ---------------------------------------------------------------------------------------
test('the enumeration reaches every object PLATO defines, and every key of each', () => {
  const paths = keyPaths('place-centric');
  // Every key along every path, with the object it is a key of: containers (a name's qualification)
  // are entered rather than tested as values, so they appear only on the way to their own keys.
  const pairs = new Set();
  for (const e of paths) e.path.filter((x) => x !== 0).forEach((k, i) => pairs.add(`${[...e.hosts, e.childHost][i]}\u0001${String(k).replace('{}', '')}`));
  for (const [name, def] of Object.entries(CORE.$defs)) {
    if (def.type !== 'object' || !def.properties) continue;
    const seen = new Set([...pairs].filter((x) => x.startsWith(name + '\u0001')).map((x) => x.split('\u0001')[1]));
    assert.ok(seen.size, `no key of ${name} is enumerated`);
    for (const k of Object.keys(def.properties)) assert.ok(seen.has(k) || (name === 'attestation' && k === 'about'), `${name}.${k} is not enumerated`);
  }
  // `about` is forbidden on a nested attestation, and is the attestation-centric profile's own.
  assert.ok(acCases().some(({ e }) => e.path.join('.') === 'attestations.0.about'));
  assert.ok(paths.length > 400, `${paths.length} paths`);
});
test('only the keys that name a document\'s format are left out of the audit, and they are constants', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    const top = Object.keys(p.properties);
    for (const k of NOT_DATA) assert.ok(p.properties[k].const !== undefined, `${name}.${k}`);
    assert.deepEqual(top.filter((k) => p.properties[k].const !== undefined).sort(), [...NOT_DATA].sort(), name);
  }
});
for (const writer of WRITERS) {
  test(`${writer}: every key the schema allows is carried or reported as a loss, never dropped silently`, async () => {
    const failures = [];
    for (const { e, n, variant } of cases()) {
      const r = await judge(writer, e, n, variant);
      if (r.startsWith('FAIL')) failures.push(`${e.path.join('.')}${variant ? ` (${variant})` : ''}: ${r}`);
    }
    for (const { e, n } of acCases()) {
      const r = await judgeAc(writer, e, n);
      if (r.startsWith('FAIL')) failures.push(`attestation-centric ${e.path.join('.')}: ${r}`);
    }
    assert.deepEqual(failures, [], `${failures.length} keys dropped silently:\n${failures.join('\n')}`);
  });
}

// KEYS_REPORT=lpf,tables node test/keys.test.js prints each key's verdict (KEYS_ALL=1: every one).
if (process.env.KEYS_REPORT) {
  for (const w of process.env.KEYS_REPORT.split(',')) {
    for (const { e, n, variant } of cases()) {
      const r = await judge(w, e, n, variant);
      if (r.startsWith('FAIL') || process.env.KEYS_ALL) console.log(w, e.path.join('.') + (variant ? ` (${variant})` : ''), r);
    }
    for (const { e, n } of acCases()) {
      const r = await judgeAc(w, e, n);
      if (r.startsWith('FAIL') || process.env.KEYS_ALL) console.log(w, 'attestation-centric', e.path.join('.'), r);
    }
  }
}
