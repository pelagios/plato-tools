// A place's address as a reader finds it, put into the form PLATO's `about` should carry.
//
// Only World Historical Gazetteer forms are rewritten so far. The facts come from WHG's own code
// and live probes (branch production at d6bda6fb8, checked 30 September 2026):
//   - The persistent address of one source record is https://w3id.org/whg/id/place:<ns>:<id>.
//     Reconciliation's ids ("place:gn:2988507") and the entity pages
//     (https://whgazetteer.org/entity/place:gn:2988507/api) name the same record.
//   - https://whgazetteer.org/places/<whg_id>/portal/ names a legacy union cluster, not a record.
//     whg_ids run from 12,345,678; there is no ns:id form for them, so they are kept as they are.
//   - The same path with a number below that range is a dataset record's database key in a
//     whg_id's place: Recogito Studio writes these for some search hits, and WHG answers them with
//     the wrong place or an error. Such an address is not carried over.
//   - dev.whgazetteer.org is a staging copy with its own database, not a citation target.
//   - "whg:<n>" is ambiguous (Recogito's display code for a cluster, reconciliation's database
//     key) and is not an address at all; callers already refuse it as not a web address.

const W3ID = 'https://w3id.org/whg/id/';
const FIRST_WHG_ID = 12345678;
const CURIE = /^place:[a-z][a-z0-9_]*:\S+$/i;
const ENTITY = /^https?:\/\/(?:www\.)?whgazetteer\.org\/entity\/(place:[a-z][a-z0-9_]*:[^/?#\s]+)(?:\/(?:api\/?)?)?$/i;
const PORTAL = /^https?:\/\/(?:www\.)?whgazetteer\.org\/places\/(\d+)\/portal\/?$/i;
const STAGING = /^https?:\/\/dev\.whgazetteer\.org\//i;

/**
 * The address to carry for a place identifier, as { iri } when it is usable as it stands or once
 * rewritten, { iri, from } when it was rewritten (`from` is what the source wrote), or { lost, value }
 * when it must not be carried over, `lost` naming why ('whg-portal-record' | 'whg-staging').
 * Anything else passes through unchanged as { iri: value }, for the caller's own checks.
 */
export function placeAddress(value) {
  if (typeof value !== 'string') return { iri: value };
  const v = value.trim();
  if (CURIE.test(v)) return { iri: W3ID + v, from: v };
  const e = ENTITY.exec(v);
  if (e) return { iri: W3ID + e[1], from: v };
  const p = PORTAL.exec(v);
  if (p && Number(p[1]) < FIRST_WHG_ID) return { lost: 'whg-portal-record', value: v };
  if (STAGING.test(v)) return { lost: 'whg-staging', value: v };
  return { iri: v };
}
