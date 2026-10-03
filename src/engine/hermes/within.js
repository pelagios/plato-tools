// The regions a place lies in, as a table of places gives them (Hermes, for Methodos's stage 1 and
// Krisis's top-down reconciliation): a column read as "within" (a parish, a county, a country…), or
// a column split into levels ("Rotherhithe, Surrey, England"), gives each row a chain of region names.
//
// Levels are positional, by mapping: the "within" columns are numbered widest first, 1 to n (the
// guess orders them by the kind of region their headings name; the page and the saved mapping can
// reorder them). The chain rides on the reader's event objects (`event.within`, beside
// `event.value`), never as a key of PLATO JSON. What PLATO says of it is written by generic.js: with
// a base address of the user's own, each distinct container is minted as a place of its own,
// ContainedIn its parent, and each row's place is plato:ContainedIn its narrowest region; without
// one, a written attestation carries the chain only as a note (withinNote).
//
//   event.within = [{ level, value, column }, …]   widest first (ascending level); empty cells
//                                                   skipped; values trimmed; no key when empty.

/** PLATO's relation type for a place lying within another (plato:ContainedIn, aligned with gvp:broaderPartitive). */
export const CONTAINED_IN = 'https://w3id.org/plato#ContainedIn';

/**
 * A row's chain of containing regions, widest first, or [] when it has none: the event's own
 * `within`, else what its PLATO says, read back by following its plato:ContainedIn attestation (a
 * record's, or an attestation's own) up through the regions generic.js mints, given as `regions`
 * (regionIndex(events), or any Map of a region's address to its record): each region's level and value
 * are its entityIdentifier's (containerKey), so that the two agree on levels and values (only the
 * event knows the column), each { level, value, iri }. With no `regions`, or a container not in them,
 * nothing is read back for it. A region's own record reads back its parents.
 */
export function withinOf(event, regions) {
  if (!event) return [];
  if (Array.isArray(event.within)) return event.within;
  const v = event.value;
  if (!v || typeof v !== 'object' || !regions) return [];
  const up = (atts) => {
    for (const a of Array.isArray(atts) ? atts : []) {
      if (!a || a.negated) continue;
      for (const r of Array.isArray(a.relations) ? a.relations : []) if (r && r.relationType === CONTAINED_IN && typeof r.relatesTo === 'string') return r.relatesTo;
    }
    return undefined;
  };
  const out = [], seen = new Set();
  let iri = up(event.type === 'record' ? v.attestations : event.type === 'attestation' ? [v] : []);
  while (iri !== undefined && !seen.has(iri) && regions.has(iri)) {
    seen.add(iri);
    const region = regions.get(iri);
    let key;
    try { key = JSON.parse(region.entityIdentifier); } catch { break; }
    if (!Array.isArray(key) || key.length < 2) break;
    out.unshift({ level: key[0], value: key[key.length - 1], iri });
    iri = up(region.attestations);
  }
  return out;
}

/**
 * The regions generic.js minted, from a run's events: Map(address -> the region's record value),
 * for withinOf to read a chain back from PLATO. A region read back from the store (an attestation-
 * centric run) has its attestations regrouped under it, as a sink receives it.
 */
export function regionIndex(events) {
  const out = new Map();
  for (const ev of events) if (ev && ev.region && ev.type === 'record' && ev.value && typeof ev.value['@id'] === 'string') out.set(ev.value['@id'], ev.value);
  return out;
}

/**
 * The key of a container: its level, the values of the containers above it in the row's chain
 * (widest first), and its own value. Labels may hold any character ("/", ","), so the key is JSON:
 * JSON.stringify([level, ...parentValues, value]). The one definition every grouping uses: two rows'
 * containers are the same container when they are the same value under the same parents, so
 * "Newport" in Monmouthshire and "Newport" on the Isle of Wight are two.
 */
export function containerKey(level, value, parentValues = []) {
  return JSON.stringify([level, ...parentValues, value]);
}

/** The name a record or attestation event gives its place: a record's label, else its first name. */
function nameOf(event) {
  const v = event?.value;
  if (!v || typeof v !== 'object') return undefined;
  if (typeof v.label === 'string' && v.label) return v.label;
  const first = Array.isArray(v.names) ? v.names[0]?.toponym : Array.isArray(v.attestations) ? v.attestations[0]?.names?.[0]?.toponym : undefined;
  return typeof first === 'string' ? first : undefined;
}
// A row's event: a record or an attestation, not a region's own (generic.js tags those `region`).
const placeEvent = (ev) => ev && (ev.type === 'record' || ev.type === 'attestation') && ev.value && !ev.region;
/** A reference to the row an event came from: its number in the stream (`n`), and its place's address, if any. */
function rowRef(ev, i) {
  const iri = ev.value['@id'] ?? ev.value.about;
  return { n: ev.n ?? i + 1, ...(typeof iri === 'string' ? { iri } : {}), ...(nameOf(ev) !== undefined ? { name: nameOf(ev) } : {}) };
}

/**
 * Each place's name and chain, one for each record or attestation event of a row (not a region's
 * own, `event.region`), in order:
 * [{ name, chain, n, iri? }], `chain` being withinOf(event) ([] for a row with none).
 */
export function withinChains(events) {
  const out = [];
  let i = 0;
  for (const ev of events) {
    if (!placeEvent(ev)) continue;
    out.push({ ...rowRef(ev, i++), name: nameOf(ev), chain: withinOf(ev) });
  }
  return out;
}

/**
 * The distinct containers at each level, from the rows' events (not the regions' own):
 * Map(level -> Map(containerKey -> { level, value, parents, rows })), levels in ascending order (widest first). `parents` are the values above it in the chain,
 * widest first; `rows` the rows that name it, each { n, iri?, name? } (rowRef). Identical containers
 * (the same value under the same parents) are one entry.
 */
export function withinLevels(events) {
  const levels = new Map();
  let i = 0;
  for (const ev of events) {
    if (!placeEvent(ev)) continue;
    const ref = rowRef(ev, i++);
    const chain = withinOf(ev), parents = [];
    for (const c of chain) {
      if (!levels.has(c.level)) levels.set(c.level, new Map());
      const at = levels.get(c.level), key = containerKey(c.level, c.value, parents);
      if (!at.has(key)) at.set(key, { level: c.level, value: c.value, parents: [...parents], rows: [] });
      at.get(key).rows.push(ref);
      parents.push(c.value);
    }
  }
  return new Map([...levels].sort((a, b) => a[0] - b[0]));
}

/** The note a written attestation carries for its chain: "Within (as the source gives it): England > Surrey > Rotherhithe". */
export function withinNote(chain, name) {
  return `Within (as the source gives it): ${[...chain.map((c) => c.value), ...(name ? [name] : [])].join(' > ')}`;
}
