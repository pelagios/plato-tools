// The places of a map made from Chora's view (#37): those in the view, all ticked to begin with, at most about
// PLACE_CAP of them (a map of more is not a plain map, and its labels could not be placed: the panel says so and
// offers the first), each as the export needs it: its label and the names attested for it (for the label's
// choice), its locations (not those its sources deny, nor those withdrawn), the point its label goes by, how
// it was identified (the gazetteer records, for the Commons page's sources), and what its sources' licences
// are (each attestation's sources and citations, as agora/licence.js attestationLicences reads them). Pure:
// the worker gives it a record (src/engine/worker.js, chora-export-places).
import { viewPlace } from '../view.js';
import { reprPointOf } from '../geo.js';

/** The most places a map is made with. */
export const PLACE_CAP = 200;

/**
 * The places of the overview (the store's overview(): a FeatureCollection of points with properties id and
 * label) inside `bounds` ([west, south, east, north]; west > east across 180°), in the dataset's order: { ids
 * (at most `cap`), total (all in the view), capped }.
 */
export function inView(overview, [w, s, e, n], cap = PLACE_CAP) {
  const inLon = (x) => (w <= e ? x >= w && x <= e : x >= w || x <= e);
  const all = (overview?.features || []).filter((f) => { const [x, y] = f.geometry?.coordinates || []; return Number.isFinite(x) && Number.isFinite(y) && inLon(x) && y >= s && y <= n; });
  return { ids: all.slice(0, cap).map((f) => f.properties.id), total: all.length, capped: all.length > cap };
}

const WATER = /\b(sea|ocean|gulf|bay|lake|lagoon|river|stream|strait|channel|sound|marsh|water|spring)s?\b/i;
const REGION = /\b(region|province|country|kingdom|land|territory|district|island group|archipelago|peninsula|mountains?|range|plain|desert|valley|people|tribe)s?\b/i;
/** The class a place's label begins with, from the kinds the dataset gives it: water, a region, else a settlement. */
export function labelClassOf(types = []) {
  const t = types.join(' ');
  return WATER.test(t) ? 'water' : REGION.test(t) ? 'region' : 'settlement';
}

/**
 * One place as the export needs it, from its record: { id, label, names: [{ toponym, language, script,
 * romanized }], geometries: [{ geojson, precision, precisionKm, role }], point: [lon, lat] (where its label
 * goes: the store's representative point, else that of its first location), cls (labelClassOf), records: the
 * addresses it is identified with (identities), licensing: [{ sources, citations, geometries }] (each
 * attestation's, for attestationLicences: what it takes its sources from, and whether it gives a location) }.
 * `ctx`: { id (its key in the store), withdrawn, brief (store.brief: its point), identities (store.identitiesOf) }.
 */
export function exportPlace(record, { id, withdrawn = null, brief = null, identities = null } = {}) {
  const v = viewPlace(record, withdrawn ? { withdrawn } : {});
  const geometries = v.geometries.filter((g) => g.status !== 'denied').map((g) => ({ geojson: g.geojson, precision: g.precision, precisionKm: g.precisionKm, role: g.role }));
  const names = v.names.filter((x) => x.status !== 'denied').map(({ toponym, language, script, romanized }) => ({ toponym, language, script, romanized }));
  const point = brief?.reprPoint || (geometries[0] ? reprPointOf(geometries[0].geojson) : null);
  const gone = withdrawn || new Map();
  const licensing = (Array.isArray(record?.attestations) ? record.attestations : [])
    .filter((a) => a && typeof a === 'object' && !(typeof a['@id'] === 'string' && gone.get(a['@id'])))
    .map((a) => ({ sources: a.sources, citations: a.citations, geometries: Array.isArray(a.geometries) && a.geometries.length ? [{}] : [] }));
  const records = identities ? [...new Set([...(identities.exact || []), ...(identities.linked || [])])] : [];
  return { id: id ?? v.id, label: v.label, names, geometries, point, cls: labelClassOf(v.types.map((t) => t.label || '')), records, licensing };
}

/** The sites the places were identified at, with how many each: [{ site, count }], most first: for the attribution. */
export function recordSites(places) {
  const c = new Map();
  for (const p of places) for (const r of p.records || []) { let h; try { h = new URL(r).hostname.replace(/^www\./, ''); } catch { continue; } c.set(h, (c.get(h) || 0) + 1); }
  return [...c].map(([site, count]) => ({ site, count })).sort((a, b) => b.count - a.count || a.site.localeCompare(b.site));
}
