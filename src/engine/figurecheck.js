// Elenchos on a table's figures (plan #34, item 11, branch B0). PLATO's JSON Schema allows what these rules
// refuse: a string for a value, a coordinate its table does not declare, a table that is not described, a
// universe that is no figure. Each is a semantic fault the schema cannot see (measured on PLATO's statistics
// example, October 2026), and each is an error, which stops a workflow (Q9): the arithmetic of a universe's
// parts, which only warns, is the Data Cube check's (src/lib/datacube.js, P-2).
//
// A FigureCheck is given the header (its dataSets: the tables, and the coordinates each structure declares),
// then the attestations of each record, as they are read; it keeps one entry for each figure, so that a
// universe can be found wherever in the document its figure is, and reports what it found at finish().
// Nothing is reported twice if a record is given twice, since what is kept is by the figure's @id.
import { isFigure, list, membershipCycles } from '../formats/shared.js';
import { FIGURE_TEXT } from './report.js';

/** The report kinds a FigureCheck raises (the Data Cube check leaves these out of a conversion's report, and says the same itself). */
export const FIGURE_KINDS = ['figure-table-undeclared', 'figure-coordinate-undeclared', 'figure-universe-missing', 'figure-universe-other-table', 'figure-universe-cycle', 'figure-value-not-number'];

// The area and the date of a figure are the attestation's, and the cube export declares them in every structure.
const SDMX_DIMENSION = 'http://purl.org/linked-data/sdmx/2009/dimension#';
const EXPORTED = new Set([SDMX_DIMENSION + 'refArea', SDMX_DIMENSION + 'refPeriod']);

export class FigureCheck {
  /** `context` is PLATO's JSON-LD context: its prefixes expand a coordinate written as a compact IRI. */
  constructor(rep, context) {
    this.rep = rep;
    this.prefixes = Object.fromEntries(Object.entries(context?.['@context'] || {}).filter(([, v]) => typeof v === 'string' && /[/#]$/.test(v)));
    this.tables = new Map();      // table -> the coordinates its structure declares (a Set), or null where the structure is not given in the document
    this.figures = new Map();     // @id -> its table
    this.links = [];              // each universe: { from (an @id or null), to, table }
  }
  expand(iri) {
    const m = typeof iri === 'string' ? /^([A-Za-z][\w-]*):(?!\/\/)(.*)$/.exec(iri) : null;
    return m && this.prefixes[m[1]] ? this.prefixes[m[1]] + m[2] : iri;
  }
  /** The tables the document describes: each dataSet of its header, with the dimensions its structure lists. */
  header(h) {
    for (const t of list(h?.dataSets)) {
      if (!t || typeof t['@id'] !== 'string') continue;
      const comps = t.structure && typeof t.structure === 'object' && Array.isArray(t.structure.components) ? t.structure.components : null;
      this.tables.set(t['@id'], comps ? new Set(comps.map((c) => this.expand(c?.dimension)).filter(Boolean)) : null);
    }
  }
  /** The figures among the properties of these attestations. */
  attestations(atts) {
    for (const a of list(atts)) {
      for (const pv of list(a?.properties)) {
        if (!isFigure(pv)) continue;
        const id = typeof pv['@id'] === 'string' ? pv['@id'] : null;
        // Seen already (the same record given again): the figure is kept once, and what it says is not counted twice.
        if (id && this.figures.has(id)) continue;
        const table = typeof pv.dataSet === 'string' ? pv.dataSet : null;
        if (id) this.figures.set(id, table);
        const named = id || 'a figure with no @id';
        if (table && !this.tables.has(table)) this.rep.error('figure-table-undeclared', FIGURE_TEXT['figure-table-undeclared'], `${named}: ${table}`);
        const declared = table ? this.tables.get(table) : null;
        if (declared && pv.dimensions && typeof pv.dimensions === 'object') {
          for (const key of Object.keys(pv.dimensions)) {
            const d = this.expand(key);
            if (!declared.has(d) && !EXPORTED.has(d)) this.rep.error('figure-coordinate-undeclared', FIGURE_TEXT['figure-coordinate-undeclared'], `${named}: ${key} (${table})`);
          }
        }
        // A printed dash has no value, and a status that says why: no number is asked for. Any value there is is a number.
        if (pv.value !== undefined && pv.value !== null && !(typeof pv.value === 'number' && Number.isFinite(pv.value)))
          this.rep.error('figure-value-not-number', FIGURE_TEXT['figure-value-not-number'], `${named}: ${JSON.stringify(pv.value)}`);
        if (typeof pv.universe === 'string') this.links.push({ from: id, to: pv.universe, table });
      }
    }
  }
  /** The universes, once every figure is known: each must be a figure of the same table, and none its own whole, however far round. */
  finish() {
    const edges = new Map();
    for (const { from, to, table } of this.links) {
      const named = `${from || 'a figure with no @id'}: ${to}`;
      // A figure that is its own universe is a cycle of one, said below with the others.
      if (from !== to && !this.figures.has(to)) this.rep.error('figure-universe-missing', FIGURE_TEXT['figure-universe-missing'], named);
      else if (from !== to && this.figures.get(to) !== table) this.rep.error('figure-universe-other-table', FIGURE_TEXT['figure-universe-other-table'], named);
      if (from) (edges.get(from) || edges.set(from, new Set()).get(from)).add(to);
    }
    for (const c of membershipCycles(edges)) this.rep.error('figure-universe-cycle', FIGURE_TEXT['figure-universe-cycle'], c);
  }
}
