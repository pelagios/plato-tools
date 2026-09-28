// RDF Data Cube (PLATO issue #14). A figure from a statistical table is a PropertyValue that
// is also a qb:Observation: it has qb:dataSet (its table), one direct statement per coordinate and
// per attribute, and plato:universe for its denominator. PLATO does not write anything twice, so a
// PLATO document is not Data Cube as it stands: the measure is PLATO's pair (plato:property_type,
// plato:value_literal), and the area and date are the attestation's. The cube export (convert --to
// ntriples --cube) adds what Data Cube expects, and nothing else:
//   - rdf:type qb:Observation on each figure, qb:DataSet on each table, and
//     qb:DataStructureDefinition on each table's structure;
//   - the direct measure statement, figure <property_type> <value>, except for a figure with no
//     value whose attributes give sdmx-attribute:obsStatus (a printed dash: a declared absence);
//   - sdmx-dimension:refArea, the attestation's SpatialEntity;
//   - sdmx-dimension:refPeriod, from the attestation's timespan: an xsd:gYear where its earliest start
//     and latest end fall in one year, an xsd:date where they fall on one day. Any other figure is
//     reported as not placeable on the time axis; its period is never guessed.
import { RDF, XSD, PLATO } from '../lib/context.js';
import { iri, literal, bnode } from '../lib/ntriples.js';

export const QB = 'http://purl.org/linked-data/cube#';
export const SDMX_DIMENSION = 'http://purl.org/linked-data/sdmx/2009/dimension#';
export const SDMX_ATTRIBUTE = 'http://purl.org/linked-data/sdmx/2009/attribute#';
export const OBS_STATUS = SDMX_ATTRIBUTE + 'obsStatus';
export const REF_AREA = SDMX_DIMENSION + 'refArea', REF_PERIOD = SDMX_DIMENSION + 'refPeriod';
const TYPE = RDF + 'type';
const P = (x) => PLATO + x;
const HAS_PART = 'http://purl.org/dc/terms/hasPart';

const DAY = /^(-?\d{4,})-(\d{2})-(\d{2})(?:T.*)?$/, MONTH = /^(-?\d{4,})-(\d{2})$/, YEAR = /^(-?\d{4,})$/;
function when(s) {
  let m = DAY.exec(s); if (m) return { year: m[1], day: `${m[1]}-${m[2]}-${m[3]}` };
  m = MONTH.exec(s) || YEAR.exec(s); if (m) return { year: m[1], day: null };
  return null;
}
/**
 * The refPeriod of a figure from its timespan's earliest start and latest end (lexical values):
 * { value, datatype } for one day (xsd:date) or one year (xsd:gYear), or null when the span is open,
 * longer, or not written as a date, which is then reported rather than guessed.
 */
export function refPeriod(startEarliest, endLatest) {
  if (typeof startEarliest !== 'string' || typeof endLatest !== 'string') return null;
  const a = when(startEarliest.trim()), b = when(endLatest.trim());
  if (!a || !b) return null;
  if (a.day && a.day === b.day) return { value: a.day, datatype: XSD + 'date' };
  if (a.year === b.year) return { value: a.year, datatype: XSD + 'gYear' };
  return null;
}

const key = (t) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value);
const term = (k) => (k.startsWith('_:') ? { termType: 'BlankNode', value: k.slice(2) } : iri(k));
const sameTerm = (a, b) => a.termType === b.termType && a.value === b.value && (a.termType !== 'Literal' || ((a.datatype || XSD + 'string') === (b.datatype || XSD + 'string') && (a.language || '') === (b.language || '')));

/**
 * What the cube export derives for one figure, read through a graph with out(id) and in(p, id):
 * { area, period, measure, problems }, each derived statement as { p, o } or null, and problems as
 * report kinds. Used by the export, and by RDF -> JSON to recognise an exported cube's own
 * statements when one is read back, so that they are not taken for the source's coordinates.
 */
export function derive(g, obsKey) {
  const out = g.out(obsKey);
  const problems = [];
  const atts = g.in(P('attests_property'), obsKey);
  let area = null, period = null;
  // Each attestation of the figure must give the same area and the same period, or neither is given.
  const areas = new Set(), periods = new Map();
  let noArea = false, noPeriod = false;
  for (const a of atts) {
    const ao = g.out(a);
    const about = ao.filter((t) => t.p === P('attests_about') && t.o.termType !== 'Literal');
    if (about.length === 1) areas.add(key(about[0].o)); else noArea = true;
    const spans = ao.filter((t) => t.p === P('attests_timespan') && t.o.termType !== 'Literal');
    let rp = null;
    if (spans.length === 1) {
      const so = g.out(key(spans[0].o));
      const se = so.filter((t) => t.p === P('start_earliest')), el = so.filter((t) => t.p === P('end_latest'));
      if (se.length === 1 && el.length === 1) rp = refPeriod(se[0].o.value, el[0].o.value);
    }
    if (rp) periods.set(rp.value + '\u0001' + rp.datatype, rp); else noPeriod = true;
  }
  if (!atts.length) problems.push('cube-no-attestation');
  else {
    if (!noArea && areas.size === 1) area = { p: REF_AREA, o: term([...areas][0]) }; else problems.push('cube-no-area');
    if (!noPeriod && periods.size === 1) { const rp = [...periods.values()][0]; period = { p: REF_PERIOD, o: literal(rp.value, rp.datatype) }; } else problems.push('cube-no-period');
  }
  // The measure: PLATO's pair, made one direct statement.
  const types = out.filter((t) => t.p === P('property_type'));
  const values = out.filter((t) => t.p === P('value_literal')).map((t) => t.o);
  const status = out.some((t) => t.p === OBS_STATUS);
  let measure = [];
  if (types.length !== 1 || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(types[0].o.value)) { if (values.length) problems.push('cube-no-measure-property'); }
  else if (values.length) measure = values.map((o) => ({ p: types[0].o.value, o }));
  else if (!status) problems.push('cube-no-value');
  return { area, period, measure, problems };
}

/** True when `o`, a statement `p` on figure `obsKey`, is one the cube export itself would add. */
export function isDerived(g, obsKey, p, o, cache = new Map()) {
  let d = cache.get(obsKey);
  if (!d) { d = derive(g, obsKey); cache.set(obsKey, d); }
  if (d.area && p === d.area.p && sameTerm(o, d.area.o)) return true;
  if (d.period && p === d.period.p && sameTerm(o, d.period.o)) return true;
  return d.measure.some((m) => m.p === p && sameTerm(o, m.o));
}

/** A small graph over one record's triples, with the two questions derive() asks. */
class RecordGraph {
  constructor() { this.o = new Map(); this.i = new Map(); }
  add(s, p, o) {
    const sk = key(s);
    (this.o.get(sk) || this.o.set(sk, []).get(sk)).push({ p: p.value, o });
    if (o.termType !== 'Literal') { const k = p.value + '\u0001' + key(o); (this.i.get(k) || this.i.set(k, []).get(k)).push(sk); }
  }
  out(id) { return this.o.get(id) || []; }
  in(p, id) { return this.i.get(p + '\u0001' + id) || []; }
}

export const CUBE_TEXT = {
  'cube-no-period': "A figure whose date is not one year or one day (or whose attestation has no single timespan with an earliest start and a latest end) cannot be placed on the cube's time axis, so it has no sdmx-dimension:refPeriod. Its period is not guessed.",
  'cube-no-area': 'A figure whose attestation does not name one place it is about has no sdmx-dimension:refArea.',
  'cube-no-attestation': 'A figure that no attestation in its record carries has no area or period in the cube.',
  'cube-no-value': 'A figure with no value, and no obsStatus to say why, has no measure statement in the cube.',
  'cube-no-measure-property': 'A figure whose property is not one full web address cannot be given a measure statement in the cube.',
  'cube-period-partial': "Some figures of a table have a date on the cube's time axis and some do not, so sdmx-dimension:refPeriod is not declared in its structure: declared, every figure without one would fail the check that every dimension has a value.",
  'cube-no-structure': 'A table has no structure (qb:structure) in this file, so the area and date the export adds cannot be declared in it.',
};

/**
 * The export, fed the triples of a converted file record by record. `emit(s, p, o)` receives the
 * added statements; `report(kind, example)` the figures that could not be fully placed.
 */
export class CubeExport {
  constructor(emit, report) {
    this.emit = emit; this.report = report;
    this.typed = new Set();     // tables and structures already typed: few, however large the file
    this.observations = 0;
    this.structureOf = new Map();  // table -> its structure, from the header or a record
    this.declared = new Map();     // structure -> the component properties the file declares
    this.tables = new Map();       // table -> { n, area, period }: how many figures got each
  }
  _type(k, cls) { const t = k + ' ' + cls; if (this.typed.has(t)) return; this.typed.add(t); this.emit(term(k), iri(TYPE), iri(cls)); }
  /** The triples of the document header, as [s, p, o]: the tables it describes, and their structures. */
  header(triples, doc) {
    const g = new RecordGraph();
    for (const [s, p, o] of triples) g.add(s, p, o);
    for (const t of g.out(key(doc))) if (t.p === HAS_PART && t.o.termType === 'NamedNode') this._table(g, key(t.o));
  }
  /** The triples of one record, as [s, p, o]. */
  record(triples) {
    const g = new RecordGraph();
    for (const [s, p, o] of triples) g.add(s, p, o);
    const done = new Set();
    for (const [s, p, o] of triples) {
      if (p.value !== QB + 'dataSet' || o.termType === 'Literal') continue;
      this._table(g, key(o));
      const obs = key(s);
      if (done.has(obs)) continue;
      done.add(obs);
      this.observations++;
      this.emit(s, iri(TYPE), iri(QB + 'Observation'));
      const d = derive(g, obs);
      for (const m of d.measure) this.emit(s, iri(m.p), m.o);
      if (d.area) this.emit(s, iri(d.area.p), d.area.o);
      if (d.period) this.emit(s, iri(d.period.p), d.period.o);
      for (const k of d.problems) this.report(k, obs);
      const n = this.tables.get(key(o)) || this.tables.set(key(o), { n: 0, area: 0, period: 0 }).get(key(o));
      n.n++; if (d.area) n.area++; if (d.period) n.period++;
    }
  }
  _table(g, ds) {
    this._type(ds, QB + 'DataSet');
    for (const t of g.out(ds)) {
      if (t.p !== QB + 'structure' || t.o.termType === 'Literal') continue;
      const dsd = key(t.o);
      this._type(dsd, QB + 'DataStructureDefinition');
      this.structureOf.set(ds, dsd);
      const have = this.declared.get(dsd) || this.declared.set(dsd, new Set()).get(dsd);
      for (const c of g.out(dsd)) if (c.p === QB + 'component') for (const x of g.out(key(c.o))) if (x.o.termType === 'NamedNode') have.add(x.o.value);
    }
  }
  /**
   * After the last record: declare in each table's structure what the export added to its figures,
   * or the integrity checks cannot use it (without refArea declared, the same row in 55 counties
   * reads as 55 duplicates). The area is on every figure by construction, so it is always declared.
   * The date is declared only where every figure of the table has one: a table of figures that each
   * cover several years has none, and declaring it would fail every one of them.
   */
  finish() {
    let c = 0;
    for (const [ds, n] of this.tables) {
      const dsd = this.structureOf.get(ds);
      if (!dsd) { this.report('cube-no-structure', ds); continue; }
      const have = this.declared.get(dsd) || new Set();
      const declare = (prop) => {
        if (have.has(prop)) return;
        const comp = bnode(`cube${++c}`);
        this.emit(term(dsd), iri(QB + 'component'), comp);
        this.emit(comp, iri(QB + 'dimension'), iri(prop));
        have.add(prop);
      };
      if (n.area) declare(REF_AREA);
      if (n.period === n.n && n.n) declare(REF_PERIOD);
      else if (n.period) this.report('cube-period-partial', ds);
    }
  }
}
