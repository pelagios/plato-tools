// RDF Data Cube integrity constraints (W3C RDF Data Cube, section 11), written as checks in JS over
// N-Triples, for the cube export of PLATO's statistics design (issue #14). The constraints
// are read after the spec's normalisation, which the checks apply as they go: a component's
// property is its qb:dimension, qb:measure or qb:attribute.
//
// Each check returns { ic, status, evaluated, violations, blocks }. `blocks` is whether a failure stops a
// workflow (all do, but P-2, below, which warns). status is 'pass', 'fail' or
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
//   IC-19  (only with a code file) every value of a coordinate that has a qb:codeList is in that code list
//
// Then the checks on the figures themselves, named P-1 to P-4 so that they are not taken for the W3C's
// numbering (plan #34, item 11). The integrity constraints cannot see these faults: measured on PLATO's
// statistics example with one planted each, four of seven passed all five.
//
//   P-1    every plato:universe is a figure of the same table, and not the figure itself
//   P-2    a universe's parts sum to it: the figures that name it as their universe and differ from it in
//          one coordinate only are a partition, and their values must add up to its value. It WARNS, and
//          does not fail: a sum that fails is sometimes the source's own arithmetic. Not summed (counted
//          as `skipped`): a lone part ("of which": a total with one occupation listed is not a
//          partition), parts that differ from the whole in two coordinates, and a family with a part that
//          has no number (a dash)
//   P-3    every coordinate and measure a figure has (and every attribute of its own, though not SDMX's, whose
//          obsStatus PLATO's own example does not declare) is declared in its table's structure
//   P-4    every measure's value is a number
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
const PLATO_NS = 'https://w3id.org/plato#';
const PLATO_UNIVERSE = PLATO_NS + 'universe';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const SDMX_ATTRIBUTE = 'http://purl.org/linked-data/sdmx/2009/attribute#';
const XSD_NUMBERS = new Set(['integer', 'decimal', 'double', 'float', 'int', 'long', 'short', 'byte', 'nonNegativeInteger', 'nonPositiveInteger', 'positiveInteger', 'negativeInteger',
  'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte'].map((n) => 'http://www.w3.org/2001/XMLSchema#' + n));
const k = (t) => (t.termType === 'BlankNode' ? '_:' + t.value : t.termType === 'Literal' ? JSON.stringify([t.value, t.datatype?.value || '', t.language || '']) : t.value);

/**
 * The graph from N-Triples text held in memory; for a file, graphOfFile() reads it as a stream (the graph is still held in memory).
 * `codes` is the code file, N-Triples text of the code lists and the coordinates' declarations, read into the same
 * graph, so that IC-19 is checked.
 */
export function graph(nt, { codes } = {}) {
  const out = new Map();
  addQuads(out, new Parser({ format: 'N-Triples' }).parse(nt));
  if (codes !== undefined) addQuads(out, new Parser({ format: 'N-Triples', blankNodePrefix: 'codes_' }).parse(codes));
  return finishGraph(out, codes !== undefined);
}
/**
 * The graph from an N-Triples file (a File or Blob, gzipped or not), read as a stream of whole
 * lines: an export can exceed the longest string JavaScript allows (Vision of Ireland's cube export
 * is 957 MB), which graph() cannot take.
 */
export async function graphOfFile(file, { codes } = {}) {
  const out = new Map();
  for await (const chunk of lineChunks(file)) addQuads(out, new Parser({ format: 'N-Triples', blankNodePrefix: '' }).parse(chunk));
  if (codes) for await (const chunk of lineChunks(codes)) addQuads(out, new Parser({ format: 'N-Triples', blankNodePrefix: 'codes_' }).parse(chunk));
  return finishGraph(out, !!codes);
}
/**
 * A graph built from N-Triples written in pieces that need not end on a line (the cube export as the
 * converter writes it, in memory, when the Data Cube check is given a PLATO dataset): whole lines are
 * read as they complete, so the text is never held as one string. finish() takes the code file's text, if any.
 */
export class GraphBuilder {
  constructor() { this.out = new Map(); this.rest = ''; }
  write(piece) {
    this.rest += piece;
    const i = this.rest.lastIndexOf('\n');
    if (i < 0) return;
    addQuads(this.out, new Parser({ format: 'N-Triples', blankNodePrefix: '' }).parse(this.rest.slice(0, i + 1)));
    this.rest = this.rest.slice(i + 1);
  }
  finish({ codes } = {}) {
    if (this.rest.trim()) addQuads(this.out, new Parser({ format: 'N-Triples', blankNodePrefix: '' }).parse(this.rest + '\n'));
    this.rest = '';
    if (codes !== undefined) addQuads(this.out, new Parser({ format: 'N-Triples', blankNodePrefix: 'codes_' }).parse(codes));
    return finishGraph(this.out, codes !== undefined);
  }
}
function addQuads(out, quads) {
  for (const q of quads) {
    const s = k(q.subject);
    const m = out.get(s) || out.set(s, new Map()).get(s);
    (m.get(q.predicate.value) || m.set(q.predicate.value, []).get(q.predicate.value)).push(k(q.object));
  }
}
function finishGraph(out, codes = false) {
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
  return { out, objs, typed, codes };
}

/** A structure's components, normalised: { dimension: [...], measure: [...], attribute: [...] }. */
function components(g, dsd) {
  const c = { dimension: [], measure: [], attribute: [] };
  for (const comp of g.objs(dsd, QB + 'component')) for (const kind of Object.keys(c)) c[kind].push(...g.objs(comp, QB + kind));
  for (const kind of Object.keys(c)) c[kind] = [...new Set(c[kind])];
  return c;
}
/** One constraint's verdict. `blocks` is whether a failure stops the workflow (Q9): all do but P-2, the arithmetic, which warns. */
const result = (ic, evaluated, violations, extra = {}) => ({ ic, status: evaluated === 0 ? 'not-tested' : violations.length ? 'fail' : 'pass', evaluated, violations, blocks: true, ...extra });

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

// ---- IC-19, with a code file ---------------------------------------------------------------------------
/** IC-19: the value of a coordinate with a qb:codeList is a code in it (skos:inScheme, or listed by the scheme or collection). */
export function ic19(g) {
  let evaluated = 0; const violations = [];
  for (const { o, c } of placed(g)) {
    for (const d of c.dimension) {
      const lists = g.objs(d, QB + 'codeList');
      if (!lists.length) continue;
      for (const v of g.objs(o, d)) {
        evaluated++;
        if (!lists.some((l) => g.objs(v, SKOS + 'inScheme').includes(l) || g.objs(l, SKOS + 'hasTopConcept').includes(v) || g.objs(l, SKOS + 'member').includes(v)))
          violations.push(`${o} has ${d} ${v}, which is not in the code list ${lists.join(', ')}`);
      }
    }
  }
  return result('IC-19', evaluated, violations);
}

// ---- the figures: P-1 to P-4 ---------------------------------------------------------------------------
const isLiteral = (key) => key.startsWith('[');
/** A literal's number, or null when it is not one (the string "280" is not a number; xsd:integer 280 is). */
function numberOf(key) {
  if (!isLiteral(key)) return null;
  const [value, datatype] = JSON.parse(key);
  if (!XSD_NUMBERS.has(datatype)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const shown = (key) => (isLiteral(key) ? JSON.parse(key)[0] : key);
const local = (iri) => iri.replace(/^.*[/#]/, '');

/** P-1: every universe is a figure of the same table, and not the figure itself. */
export function p1(g) {
  const obs = new Set(g.typed(QB + 'Observation'));
  let evaluated = 0; const violations = [];
  for (const o of obs) {
    for (const u of g.objs(o, PLATO_UNIVERSE)) {
      evaluated++;
      if (u === o) violations.push(`${o} is its own universe`);
      else if (!obs.has(u)) violations.push(`${o} has the universe ${u}, which is no figure of the cube`);
      else if (!g.objs(u, QB + 'dataSet').some((d) => g.objs(o, QB + 'dataSet').includes(d))) violations.push(`${o} has the universe ${u}, which is a figure of another table`);
    }
  }
  return result('P-1', evaluated, violations);
}
/** P-2: the parts of a universe sum to it. A warning (Q9). `skipped` counts the families not summed. */
export function p2(g) {
  const dims = new Map();                       // each figure's table's components
  for (const { o, c } of placed(g)) if (!dims.has(o)) dims.set(o, c);
  const sig = (o, d) => g.objs(o, d).slice().sort().join('\u0001');
  const value = (o) => {
    const ns = dims.get(o).measure.flatMap((m) => g.objs(o, m)).map(numberOf);
    return ns.length === 1 && ns[0] !== null ? ns[0] : null;
  };
  const families = new Map();                   // universe -> the coordinate they differ from it in -> the parts
  let skipped = 0;
  for (const [o, c] of dims) {
    for (const u of g.objs(o, PLATO_UNIVERSE)) {
      if (u === o || !dims.has(u)) continue;
      const differ = c.dimension.filter((d) => sig(o, d) !== sig(u, d));
      if (differ.length !== 1) { skipped++; continue; }
      const byDim = families.get(u) || families.set(u, new Map()).get(u);
      (byDim.get(differ[0]) || byDim.set(differ[0], []).get(differ[0])).push(o);
    }
  }
  let evaluated = 0; const violations = [];
  for (const [u, byDim] of families) {
    for (const [d, parts] of byDim) {
      const numbers = [value(u), ...parts.map(value)];
      if (parts.length < 2 || numbers.some((n) => n === null)) { skipped++; continue; }
      evaluated++;
      const whole = numbers[0], sum = numbers.slice(1).reduce((a, b) => a + b, 0);
      if (Math.abs(whole - sum) > 1e-9 * Math.max(1, Math.abs(whole), Math.abs(sum))) violations.push(`${u} is ${whole}, and its parts (differing in ${local(d)}: ${parts.map(local).join(', ')}) sum to ${sum}`);
    }
  }
  return result('P-2', evaluated, violations, { blocks: false, skipped });
}
/**
 * P-3: every coordinate (and measure, and attribute of its own) a figure has is declared in its table's structure. SDMX's
 * own attributes (obsStatus: a printed dash) are not asked for: PLATO's example does not declare them.
 */
export function p3(g) {
  let evaluated = 0; const violations = [];
  for (const { o, ds, c } of placed(g)) {
    const declared = new Set([...c.dimension, ...c.measure, ...c.attribute]);
    for (const p of g.out.get(o).keys()) {
      if (p === RDF_TYPE || p === QB + 'dataSet' || p.startsWith(PLATO_NS) || p.startsWith(SDMX_ATTRIBUTE)) continue;
      evaluated += g.objs(o, p).length;
      if (!declared.has(p)) violations.push(`${o} has ${p}, which ${ds} does not declare`);
    }
  }
  return result('P-3', evaluated, violations);
}
/** P-4: every measure's value is a number. */
export function p4(g) {
  let evaluated = 0; const violations = [];
  for (const { o, c } of placed(g)) for (const m of c.measure) for (const v of g.objs(o, m)) {
    evaluated++;
    if (numberOf(v) === null) violations.push(`${o} has ${m} ${JSON.stringify(shown(v))}, which is not a number`);
  }
  return result('P-4', evaluated, violations);
}
export const figureChecks = (g) => [p1(g), p2(g), p3(g), p4(g)];
/** Everything the Data Cube check says: the five integrity constraints, IC-19 when a code file was read, then P-1 to P-4. */
export const cubeChecks = (g) => [...checks(g), ...(g.codes ? [ic19(g)] : []), ...figureChecks(g)];
export const cubeChecksOfFile = async (file, options) => cubeChecks(await graphOfFile(file, options));

/** What each constraint says, in a phrase (the report's and the command line's words). */
export const CHECK_WORDS = {
  'IC-1': 'every observation has one data set', 'IC-2': 'every data set has one structure', 'IC-11': 'every observation has every coordinate of its structure',
  'IC-12': 'no two observations of a data set have all the same coordinates', 'IC-14': 'every observation has every measure of its structure',
  'IC-19': 'every coordinate value is in its code list',
  'P-1': 'every universe is a figure of the same table', 'P-2': 'the parts of a universe sum to it', 'P-3': 'every coordinate is declared in its table\'s structure', 'P-4': 'every value is a number',
};
