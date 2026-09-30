// RDF Data Cube integrity constraints (W3C RDF Data Cube, section 11), written as checks in JS over
// N-Triples, for the cube export of PLATO's statistics design (issue #14). The constraints
// are read after the spec's normalisation, which the checks apply as they go: a component's
// property is its qb:dimension, qb:measure or qb:attribute.
//
// Each check returns { ic, status, evaluated, violations }. status is 'pass', 'fail' or
// 'not-tested': a constraint that had nothing to evaluate (no observations, or no dimension or
// measure to look for) is not tested, and is never reported as passed.
//
//   IC-1   every qb:Observation has exactly one qb:dataSet
//   IC-2   every qb:DataSet has exactly one qb:structure
//   IC-11  every observation has a value for every dimension of its structure
//   IC-12  no two observations of one data set have the same value for every dimension
//   IC-14  every observation has a value for every measure of its structure (no qb:measureType
//          dimension), except, by PLATO's decision 7, a declared absence: one with an
//          sdmx-attribute:obsStatus and no plato:value_literal (a printed dash). One with a status
//          and a value, such as an approximate amount, is checked like any other
//
// IC-12 as the spec writes it compares every pair of observations (3×10¹⁰ pairs for Vision of
// Ireland). Here observations are grouped instead, in linear time. The spec's query takes, for each
// pair, the minimum of "value1 = value2" over the dimensions both have a value for, so an
// observation missing a dimension collides with any that agrees on the rest (and a pair with no
// dimension in common has nothing to compare, so does not). The grouping reproduces that by
// comparing each pair of "which dimensions are present" patterns on the dimensions both have. There
// are few such patterns (one, where IC-11 holds), so the cost stays linear in the observations.
// Values are compared as RDF terms, where SPARQL's != compares literal values ("01" and "1" as
// xsd:integer are equal to SPARQL, different here); the cube export writes canonical forms.
import { Parser } from 'n3';
import { lineChunks } from '../engine/input.js';

const QB = 'http://purl.org/linked-data/cube#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OBS_STATUS = 'http://purl.org/linked-data/sdmx/2009/attribute#obsStatus';
const PLATO_VALUE = 'https://w3id.org/plato#value_literal';
const k = (t) => (t.termType === 'BlankNode' ? '_:' + t.value : t.termType === 'Literal' ? JSON.stringify([t.value, t.datatype?.value || '', t.language || '']) : t.value);

/** The graph from N-Triples text held in memory; for a file, graphOfFile() reads it as a stream (the graph is still held in memory). */
export function graph(nt) {
  const out = new Map();
  addQuads(out, new Parser({ format: 'N-Triples' }).parse(nt));
  return finishGraph(out);
}
/**
 * The graph from an N-Triples file (a File or Blob, gzipped or not), read as a stream of whole
 * lines: an export can exceed the longest string JavaScript allows (Vision of Ireland's cube export
 * is 957 MB), which graph() cannot take.
 */
export async function graphOfFile(file) {
  const out = new Map();
  for await (const chunk of lineChunks(file)) addQuads(out, new Parser({ format: 'N-Triples', blankNodePrefix: '' }).parse(chunk));
  return finishGraph(out);
}
function addQuads(out, quads) {
  for (const q of quads) {
    const s = k(q.subject);
    const m = out.get(s) || out.set(s, new Map()).get(s);
    (m.get(q.predicate.value) || m.set(q.predicate.value, []).get(q.predicate.value)).push(k(q.object));
  }
}
function finishGraph(out) {
  const objs = (s, p) => [...new Set(out.get(s)?.get(p) || [])];
  // The spec's normalisation, phase 1: whatever has a qb:dataSet is a qb:Observation, and what it
  // points at a qb:DataSet, whether or not the data says so.
  const obs = new Set(), sets = new Set();
  for (const [s, m] of out) {
    if (objs(s, RDF_TYPE).includes(QB + 'Observation')) obs.add(s);
    if (objs(s, RDF_TYPE).includes(QB + 'DataSet')) sets.add(s);
    for (const d of m.get(QB + 'dataSet') || []) { obs.add(s); sets.add(d); }
  }
  const typed = (cls) => [...(cls === QB + 'Observation' ? obs : cls === QB + 'DataSet' ? sets : [])];
  return { out, objs, typed };
}

/** A structure's components, normalised: { dimension: [...], measure: [...], attribute: [...] }. */
function components(g, dsd) {
  const c = { dimension: [], measure: [], attribute: [] };
  for (const comp of g.objs(dsd, QB + 'component')) for (const kind of Object.keys(c)) c[kind].push(...g.objs(comp, QB + kind));
  for (const kind of Object.keys(c)) c[kind] = [...new Set(c[kind])];
  return c;
}
const result = (ic, evaluated, violations) => ({ ic, status: evaluated === 0 ? 'not-tested' : violations.length ? 'fail' : 'pass', evaluated, violations });

export function ic1(g) {
  const obs = g.typed(QB + 'Observation');
  return result('IC-1', obs.length, obs.filter((o) => g.objs(o, QB + 'dataSet').length !== 1));
}
export function ic2(g) {
  const ds = g.typed(QB + 'DataSet');
  return result('IC-2', ds.length, ds.filter((d) => g.objs(d, QB + 'structure').length !== 1));
}
/** Each observation with its data set and that data set's (normalised) structure. */
function placed(g) {
  const r = [];
  for (const o of g.typed(QB + 'Observation')) for (const ds of g.objs(o, QB + 'dataSet')) for (const dsd of g.objs(ds, QB + 'structure')) r.push({ o, ds, c: components(g, dsd) });
  return r;
}
export function ic11(g) {
  let evaluated = 0; const violations = [];
  for (const { o, c } of placed(g)) for (const d of c.dimension) { evaluated++; if (!g.objs(o, d).length) violations.push(`${o} has no ${d}`); }
  return result('IC-11', evaluated, violations);
}
export function ic14(g) {
  let evaluated = 0; const violations = [];
  for (const { o, c } of placed(g)) {
    if (c.dimension.includes(QB + 'measureType')) continue;
    // A declared absence (PLATO decision 7) is a status and no value: a printed dash. A status alone is
    // not enough, since obsStatus is a general attribute ("approximate" is not an absence), and a
    // figure with a value must have its measure whatever its status says. PLATO's schema allows a
    // figure without a value only when it has a status, so the check never reads the status code.
    if (g.objs(o, OBS_STATUS).length && !g.objs(o, PLATO_VALUE).length) continue;
    for (const m of c.measure) { evaluated++; if (!g.objs(o, m).length) violations.push(`${o} has no ${m}`); }
  }
  return result('IC-14', evaluated, violations);
}
export function ic12(g) {
  const byDs = new Map();
  for (const { o, ds, c } of placed(g)) {
    if (!c.dimension.length) continue;
    const vals = c.dimension.map((d) => g.objs(o, d));
    // One value: that value. Several: this observation differs from every other on that dimension.
    const key = vals.map((v, i) => (v.length === 1 ? v[0] : v.length ? `\u0000many:${o}:${i}` : null));
    const present = key.map((v) => (v === null ? '0' : '1')).join('');
    const e = byDs.get(ds) || byDs.set(ds, { patterns: new Map() }).get(ds);  // per data set, by which dimensions are present
    (e.patterns.get(present) || e.patterns.set(present, []).get(present)).push({ o, key });
  }
  let evaluated = 0; const violations = [];
  const project = (x, on) => x.key.filter((_, n) => on[n]).join('\u0001');
  for (const [ds, { patterns }] of byDs) {
    const pats = [...patterns.keys()];
    for (const obs of patterns.values()) evaluated += obs.length;
    for (let i = 0; i < pats.length; i++) {
      for (let j = i; j < pats.length; j++) {
        // Compared on the dimensions both patterns have: agreeing there, two observations differ nowhere.
        // With none in common the spec's query has no row for the pair to group, so no duplicate.
        const on = [...pats[i]].map((ch, n) => ch === '1' && pats[j][n] === '1');
        if (!on.some(Boolean)) continue;
        const first = new Map();
        for (const x of patterns.get(pats[i])) {
          const g2 = project(x, on);
          if (i === j && first.has(g2)) violations.push(`${ds}: ${first.get(g2)} and ${x.o} have the same dimension values`);
          else if (!first.has(g2)) first.set(g2, x.o);
        }
        if (i !== j) for (const x of patterns.get(pats[j])) {
          const g2 = project(x, on);
          if (first.has(g2)) violations.push(`${ds}: ${first.get(g2)} and ${x.o} have the same dimension values`);
        }
      }
    }
  }
  return result('IC-12', evaluated, [...new Set(violations)]);
}
export const checks = (g) => [ic1(g), ic2(g), ic11(g), ic12(g), ic14(g)];
export const integrity = (nt) => checks(graph(nt));
export const integrityOfFile = async (file) => checks(await graphOfFile(file));
