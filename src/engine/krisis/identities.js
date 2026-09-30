// Krisis: what a dataset currently says about which places are, and are not, the same: for each place,
// the places it is linked to by an identity relation and those it is said NOT to be. Shared by the
// gazetteer lookup (lookup.js: a candidate already linked or denied is not suggested) and by Chora.
//
// Pure: no page, no input or output. Records are place-centric, as the pipeline's sink receives them.
// - Identity relations are read from every attestation (`identities`, bundled or single) and from a
//   record's own `identityRelations`; a negated attestation's are denials.
// - Retractions and supersessions are honoured as the rest of the tools honour them (resolveWithdrawn,
//   formats/shared.js): a relation whose attestation is withdrawn in the current state no longer holds.
// - Addresses are kept in WHG's persistent form (normaliseWhgIri); a legacy WHG cluster address
//   (/places/<n>/portal/) is kept as found. Relations are symmetric: each place of a pair gets the other.
// - Comparing with a WHG candidate (linkState) also counts the authority's own address of the record
//   (authorityIris: GeoNames, Getty TGN, Wikidata, OpenStreetMap) as the candidate's.
import { collectWithdrawn, resolveWithdrawn } from '../../formats/shared.js';
import { normaliseWhgIri } from '../gazetteer/index.js';

const OSM_KIND = { r: 'relation', w: 'way', n: 'node' };
/**
 * The addresses the authority a WHG candidate comes from gives the same record: place:gn:2641673 is
 * GeoNames' https://sws.geonames.org/2641673/, place:wd:Q42 Wikidata's entity, place:tgn:… Getty's,
 * place:osm:r65606 OpenStreetMap's relation. Written as datasets write them (http or https, with or
 * without the last slash). For comparing with what a dataset links, never as the address an
 * attestation gives.
 */
export function authorityIris(id) {
  const m = /^place:([a-z]+):(.+)$/.exec(String(id ?? ''));
  if (!m) return [];
  const [, ns, local] = m;
  let bases = [];
  if (ns === 'gn' && /^\d+$/.test(local)) bases = [`sws.geonames.org/${local}`, `www.geonames.org/${local}`, `geonames.org/${local}`];
  else if (ns === 'tgn' && /^\d+$/.test(local)) bases = [`vocab.getty.edu/tgn/${local}`, `vocab.getty.edu/page/tgn/${local}`];
  else if (ns === 'wd' && /^Q\d+$/.test(local)) bases = [`www.wikidata.org/entity/${local}`, `www.wikidata.org/wiki/${local}`, `wikidata.org/entity/${local}`];
  else if (ns === 'osm') {
    const o = /^([rwn])(\d+)$/.exec(local) || /^(relation|way|node)\/(\d+)$/.exec(local);
    if (o) bases = [`www.openstreetmap.org/${OSM_KIND[o[1]] || o[1]}/${o[2]}`, `openstreetmap.org/${OSM_KIND[o[1]] || o[1]}/${o[2]}`];
  }
  return bases.flatMap((b) => [`https://${b}`, `http://${b}`]).flatMap((u) => [u, u + '/']);
}

/**
 * Collects identity relations record by record (for a sink that sees each record once), and gives the
 * current state when all are in. `add(record)` a place-centric record; `addRelation(subject, object,
 * negated?, attestationId?)` a relation met elsewhere (a top-level one); `result()` the Map below.
 */
export function createIdentityCollector() {
  const links = [], withdrawals = new Map();
  const addRelation = (a, b, negated = false, att = null) => {
    if (typeof a === 'string' && typeof b === 'string' && a && b && a !== b) links.push({ a, b, negated: !!negated, att: typeof att === 'string' ? att : null });
  };
  return {
    addRelation,
    add(rec) {
      const iri = rec?.['@id'];
      if (!rec || typeof rec !== 'object') return;
      for (const a of rec.attestations || []) {
        if (!a || typeof a !== 'object') continue;
        for (const r of [].concat(a.identities || [])) addRelation(r?.subject ?? iri, r?.object, !!a.negated, a['@id']);
      }
      collectWithdrawn(rec.attestations, withdrawals);
      for (const r of rec.identityRelations || []) addRelation(r?.subject ?? iri, r?.object, false, null);
    },
    /** Map<place IRI, { linked: Set<IRI>, denied: Set<IRI> }>, without what has been withdrawn. */
    result() {
      const withdrawn = resolveWithdrawn(withdrawals).status;
      const out = new Map();
      const put = (from, to, negated) => {
        const e = out.get(from) || out.set(from, { linked: new Set(), denied: new Set() }).get(from);
        (negated ? e.denied : e.linked).add(normaliseWhgIri(to));
      };
      for (const l of links) {
        if (l.att && withdrawn.has(l.att)) continue;
        put(l.a, l.b, l.negated); put(l.b, l.a, l.negated);
      }
      return out;
    },
  };
}

/** The current identity decisions of places: currentIdentities(records) → Map<place IRI, { linked, denied }>. */
export function currentIdentities(records) {
  const c = createIdentityCollector();
  for (const r of records || []) c.add(r);
  return c.result();
}

/** Every address a candidate ({ id, iri }) goes by: its own, and its authority's. */
export const addressesOf = (candidate) => new Set([candidate.iri, ...authorityIris(candidate.id)].filter(Boolean));
const has = (list, iri) => (list instanceof Set ? list.has(iri) : Array.isArray(list) && list.includes(iri));

/**
 * Whether a place's identities (one entry of the Map, or the same with arrays) already link it to a
 * candidate ({ id, iri }), or deny it: 'linked', 'denied', or null. A link wins over a denial.
 */
export function linkState(entry, candidate) {
  if (!entry) return null;
  const known = [...addressesOf(candidate)];
  const hit = (list) => known.some((iri) => has(list, iri) || has(list, normaliseWhgIri(iri)));
  return hit(entry.linked) ? 'linked' : hit(entry.denied) ? 'denied' : null;
}
