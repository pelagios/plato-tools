// Krisis: the lists of qualifiers, one per language (or group of languages), that matching may set
// aside when two names differ only by them (names.js, qualifierScore(): Chipping Ongar and Ongar).
//
// A qualifier here is a word or phrase that RARELY marks a separate place: Chipping Ongar is Ongar,
// Châtillon-sur-Seine is Châtillon. Words that often do (Old Windsor is not Windsor, Long Sutton is
// not Sutton, Great and Little Marlow are two places, and so in Dutch is Nieuw-Vennep not Vennep)
// are not qualifiers, and a list must not hold them: a pair the rule finds is suggested at 0.88,
// over the default threshold, whatever else it is.
//
// Each list is data: { id, language (its BCP 47 tags), label, description (one line, shown beside
// its checkbox), status, on (whether it is used when no lists are chosen), front (words in front of
// a name), behind (words behind it), phrases (regular expressions, as source text, for a phrase at
// the end), same (other spellings of a joining word: upon is on), evidence }.
//   - front and behind are written as people write them (Chipping, Regis); they are matched normalised
//     (names.js normalise(): lower case, no accents, punctuation as spaces).
//   - each phrase is matched against what is left of a normalised name once its words in front are
//     set aside, and must match it whole, with three named groups: `core`, the rest of the name;
//     `join`, the joining word (or words: German "an der") that weighs for the phrase; and `tail`,
//     what follows it (a river, a district or a short phrase: "on thames", "next the sea").
//   - status 'measured': tried on real data, with what was found in `evidence`; 'unmeasured': seeded
//     where the usage is well established, but not tried on data, and so not on unless chosen.
// A language a contributor adds starts 'unmeasured' and off (DEVELOPERS.md, Match review, says how).
//
// names.js makes the lists chosen ready for matching (compileQualifiers()).
//
// A list's id, and QUALIFIER_TABLE_VERSION, are recorded in the work file (match_parameters.qualifiers),
// so a review says how it was matched. Change the version whenever a list's words change.
import { DataError } from '../input.js';
import { KRISIS_TEXT } from '../words.js';

export const QUALIFIER_TABLE_VERSION = 'krisis-qualifiers 2';

// At most three words after a joining word ("next the sea", "sur l ain").
const TAIL = '(?<tail>[^ ]+(?: [^ ]+){0,2})';

export const QUALIFIER_LISTS = Object.freeze([
  {
    id: 'en-cy-la', language: ['en', 'cy', 'la'], label: 'English, Welsh and Latin', status: 'measured', on: true,
    description: 'Chipping and Market in front; Regis behind; "on", "upon", "under", "next", "juxta" or "super" and a river or short phrase at the end.',
    front: ['Chipping', 'Market'],
    behind: ['Regis'],
    phrases: [`^(?<core>.+?) (?<join>on|upon|under|next|juxta|super) ${TAIL}$`],
    same: { upon: 'on' },
    evidence: 'Market towns of England and Wales matched with CAMPOP\'s places (1 October 2026): of 1,048 market places with a CAMPOP place within 1.5 km, 956 were suggested before any qualifier rule; a list of 60 qualifiers added 10 suggestions, five the same place (Great Marlow, Chipping Ongar, Market Warsop, Great Weldon) and five not (Old Windsor and Windsor, Long Sutton and Sutton, High Ongar and Ongar). The maintainer kept only the qualifiers that rarely mark a separate place: those here. Magna, Parva, Fawr and Bach were dropped too, by the maintainer\'s ruling of 1 October 2026 (krisis-qualifiers 2): they mean or work like Great and Little, and often mark separate places. Any of them may be re-admitted only if the held-out Index Villaris check measures it separately and it does well; Mawr and Fach would go back with Fawr and Bach.',
  },
  {
    id: 'fr', language: ['fr'], label: 'French', status: 'unmeasured', on: false,
    description: '"sur" and a river ("Châtillon-sur-Seine"), or "en" and a district ("Châlons-en-Champagne"), at the end.',
    front: [], behind: [],
    // "en" takes one word that is not an article: Châlons-en-Champagne, not Chapel-en-le-Frith.
    phrases: [`^(?<core>.+?) (?<join>sur) ${TAIL}$`, `^(?<core>.+?) (?<join>en) (?!(?:le|la|les|l|de|du|des|d)$)(?<tail>[^ ]+)$`],
    same: {},
    evidence: 'Not measured: off by default. In French place names "-sur-<river>" and "-en-<pays>" are long-standing distinguishing suffixes of one commune (Châtillon-sur-Seine, Châlons-en-Champagne), and the name is often given without them. Names are compared lowercased, so a river cannot be told from an ordinary word: "en" is read only before one word that is not an article (so not Chapel-en-le-Frith, whose core would otherwise be "Chapel"), but "sur" and "en" before any other word are still read as a qualifier, wrongly where the phrase is part of the name. A known limit: Dutch "en" is "and", so with this list on Berg en Dal is read as Berg with a qualifier, and scored as Berg (the Fable review of 10 October 2026); a Dutch dataset should leave the list off.',
  },
  {
    id: 'de', language: ['de'], label: 'German', status: 'unmeasured', on: false,
    description: '"Bad" (a spa) in front ("Bad Ems"); "am" or "an der" and a river at the end ("Frankfurt am Main", "Frankfurt an der Oder").',
    front: ['Bad'], behind: [],
    phrases: [`^(?<core>.+?) (?<join>am|an der) ${TAIL}$`],
    same: {},
    evidence: 'Not measured: off by default. "Bad" is an official prefix granted to spa towns, often left out (Bad Ems, Ems), and "am"/"an der" and a river distinguish one town from another of its name (Frankfurt am Main, Frankfurt an der Oder). Names are compared lowercased, so a river cannot be told from an ordinary word, and ordinary phrases are read as qualifiers too: "Haus am See" and "Haus" score 0.88 with this list on.',
  },
]);

/** The ids of the lists used when none are chosen: the measured English, Welsh and Latin list. */
export const DEFAULT_QUALIFIER_LISTS = Object.freeze(QUALIFIER_LISTS.filter((l) => l.on).map((l) => l.id));

/**
 * The ids of the lists chosen: `given` as an array of ids, or as text, ids separated by commas
 * ("en-cy-la,fr"), or "none" (or an empty array) for none; undefined for the default. A DataError
 * naming the lists there are, for an id that is not one.
 */
export function qualifierIds(given) {
  if (given === undefined || given === null) return [...DEFAULT_QUALIFIER_LISTS];
  const ids = Array.isArray(given) ? given : String(given).split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 1 && ids[0] === 'none') return [];
  const known = QUALIFIER_LISTS.map((l) => l.id), out = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !known.includes(id)) throw new DataError(KRISIS_TEXT.noSuchQualifierList(id, known));
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The lists of `ids` as a work file records them (match_parameters.qualifiers.lists). */
export function qualifierRecord(ids) {
  return { table: QUALIFIER_TABLE_VERSION, lists: [...ids],
    definitions: ids.map((id) => { const l = QUALIFIER_LISTS.find((x) => x.id === id); return { id, language: l.language, status: l.status, front: l.front, behind: l.behind, phrases: l.phrases }; }) };
}
