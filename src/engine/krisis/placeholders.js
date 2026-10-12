// Krisis: gazetteer records whose only name is a cataloguing placeholder (Issue #21; WHG place#216), such
// as "Oknoname 037068 Dam" (GNIS's "OK no name", carried into GeoNames, OpenStreetMap and Wikidata), which
// WHG once returned as the top name match for "Barony Lanach, Scotland". There is no query for which such a
// record is the right answer by name.
//
// The patterns are WHG's own "exclude" list, live on its gateway since 9 October 2026 (indexing 1b635de,
// gateway/data/placeholder_names.json, as recorded on place#216), whole-name and case-insensitive, with the
// two misspellings WHG saw come top after its deploy ("unamed", "unkown"). WHG's "demote" list (No Name, a
// bare number, a Q-number, N/A, NN, Nimetön) is NOT used: each is also a real place's name somewhere (No
// Name, Colorado; Na; Mannheim's Q1 to Q7), and WHG only ranks them lower.
//
// A record is left out only when EVERY name it has is a placeholder: WHG matches the name, not the record,
// and a record titled "Unknown" with a real name beside it (kain_par:11771, Halton Holegate) is a real
// place found by its real name. Left out and counted: never shown, never accepted.
export const PLACEHOLDER_PATTERNS = [
  'oknoname.*', 'unnamed( .*)?', 'unknown', '[-_*.?]+', 'x+', 'fixme|tbd|tba', 'sin nombre', '名称不明\\s*', 'без названия',
  'desconocid[oa]', 'unbekannt', 'senza nome', 'ohne namen', 'sans nom', 'sem nome', 'onbekend', 'naamloos', 'bezimienn[ay]',
  'unamed( .*)?', 'unkown',
];
const WHOLE = new RegExp(`^(?:${PLACEHOLDER_PATTERNS.join('|')})$`, 'iu');
/** Is this name a cataloguing placeholder (trimmed, whole, any case)? A blank name is not a name at all, and is not counted as one. */
export const isPlaceholder = (name) => typeof name === 'string' && !!name.trim() && WHOLE.test(name.trim());
/**
 * Is this candidate (the gazetteer module's, { name, altNames }) a placeholder record: its name a
 * placeholder, and none of its other names anything else?
 */
export function placeholderRecord(c) {
  if (!isPlaceholder(c?.name)) return false;
  return (Array.isArray(c?.altNames) ? c.altNames : []).every((n) => typeof n !== 'string' || !n.trim() || isPlaceholder(n));
}
