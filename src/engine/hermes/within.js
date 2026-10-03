// The regions a place lies in, as a table of places gives them (Hermes, for Methodos's stage 1 and
// Krisis's top-down reconciliation): a column read as "within" (a parish, a county, a country…), or
// a column split into levels ("Rotherhithe, Surrey, England"), gives each row a chain of region names.
//
// Levels are positional, by mapping: the "within" columns are numbered widest first, 1 to n (the
// guess orders them by the kind of region their headings name; the page and the saved mapping can
// reorder them). The chain rides on the reader's event objects (`event.within`, beside
// `event.value`), never as a key of PLATO JSON. What PLATO says of it is written by generic.js: with
// a base address of the user's own, each distinct container is minted as a place of its own, and
// each row's place gets one plato:ContainedIn attestation for each level, with `sequence` the
// level; without one, a written attestation carries the chain only as a note (withinNote).
//
//   event.within = [{ level, value, column }, …]   widest first (ascending level); empty cells
//                                                   skipped; values trimmed; no key when empty.

/** PLATO's relation type for a place lying within another (plato:ContainedIn, aligned with gvp:broaderPartitive). */
export const CONTAINED_IN = 'https://w3id.org/plato#ContainedIn';

/**
 * A row's chain of containing regions, widest first, or [] when it has none: the event's own
 * `within`, else what its PLATO says, read back from its plato:ContainedIn attestations (a record's,
 * or an attestation's own) ordered by `sequence`, each { level: sequence, value: relatedLabel, iri:
 * relatesTo }, so that the two agree on the levels and values (only the event knows the column). A
 * region's own record (generic.js) has one such attestation, to its parent; its event's `within` is
 * its whole chain of parents.
 */
export function withinOf(event) {
  if (!event) return [];
  if (Array.isArray(event.within)) return event.within;
  const v = event.value;
  if (!v || typeof v !== 'object') return [];
  const atts = event.type === 'record' ? (Array.isArray(v.attestations) ? v.attestations : []) : event.type === 'attestation' ? [v] : [];
  const out = [];
  for (const a of atts) {
    if (!a || a.negated || !Number.isInteger(a.sequence)) continue;
    for (const r of Array.isArray(a.relations) ? a.relations : []) {
      if (r && r.relationType === CONTAINED_IN && typeof r.relatedLabel === 'string') out.push({ level: a.sequence, value: r.relatedLabel, ...(typeof r.relatesTo === 'string' ? { iri: r.relatesTo } : {}) });
    }
  }
  return out.sort((a, b) => a.level - b.level);
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
