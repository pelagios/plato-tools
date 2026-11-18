// A country's name as a table gives it ("Turkey", "United Kingdom", "USA"), resolved to its ISO 3166-1
// alpha-2 code, for a gazetteer lookup's country hint (hermes/columns.js reads it from a country column;
// krisis/lookup.js ranks by it). A hint, never a fact about the place: a table's "Country" column says
// what its maker wrote, often a present-day country for a historical place, so the code made of it is
// not written into PLATO (the column stays a region the place lies in) and is never sent as a filter.
//
// The names are those of src/vendor/iso-countries.json (each code's English label in Wikidata, CC0),
// which has one name a code and no aliases, so a short list of common English names is added here
// (ALIASES). A name is compared without case, accents, punctuation or a leading "the"; "St" is "Saint"
// and "&" is "and". Only what names ONE country resolves: a name two codes share is not used, and a
// name that is not one country's ("Congo", "Korea", "America") is deliberately not listed. A code in
// capitals (TR) is taken as itself. No other language's names and no historical states ("Persia",
// "Ottoman Empire"): those are not resolved, and the reader says so (generic-country-unresolved).
import ISO from '../vendor/iso-countries.json' with { type: 'json' };

/**
 * Common English names that are not the label in the table. The four nations of the United Kingdom are
 * its one code (GB): ISO has none for them, and a gazetteer's country code for a place in England is GB.
 */
const ALIASES = {
  GB: ['UK', 'U.K.', 'Great Britain', 'Britain', 'United Kingdom of Great Britain and Northern Ireland', 'England', 'Scotland', 'Wales', 'Northern Ireland'],
  US: ['USA', 'U.S.A.', 'U.S.', 'United States of America'],
  CN: ['China'],
  NL: ['Netherlands', 'Holland'],
  BS: ['Bahamas'],
  GM: ['Gambia'],
  CZ: ['Czechia'],
  TR: ['Türkiye', 'Republic of Turkey'],
  MM: ['Burma'],
  CI: ["Côte d'Ivoire"],
  RU: ['Russian Federation'],
  IE: ['Republic of Ireland', 'Eire'],
  SZ: ['Swaziland'],
  TL: ['East Timor'],
  CV: ['Cabo Verde'],
  CD: ['DR Congo', 'DRC', 'Congo-Kinshasa', 'Congo (Kinshasa)'],
  CG: ['Congo-Brazzaville', 'Congo (Brazzaville)'],
  KR: ['Republic of Korea'],
  KP: ["Democratic People's Republic of Korea"],
  VN: ['Viet Nam'],
  SY: ['Syrian Arab Republic'],
  IR: ['Islamic Republic of Iran'],
  LA: ["Lao People's Democratic Republic"],
  BN: ['Brunei Darussalam'],
  VA: ['Vatican', 'Holy See'],
  PS: ['State of Palestine'],
  FM: ['Micronesia'],
  MO: ['Macao'],
  AE: ['UAE', 'U.A.E.'],
  DE: ['Federal Republic of Germany'],
  MK: ['Republic of North Macedonia'],
  TZ: ['United Republic of Tanzania'],
};

/** A name reduced for comparing: no case, accents or punctuation, no leading "the"; "St" as "Saint", "&" as "and". */
export const countryKey = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '').replace(/\bst\b/g, 'saint');

// key -> code, or null where two codes share the key (never used).
const BY_NAME = new Map();
const put = (name, code) => {
  const k = countryKey(name);
  if (!k) return;
  BY_NAME.set(k, BY_NAME.has(k) && BY_NAME.get(k) !== code ? null : code);
};
for (const [code, c] of Object.entries(ISO)) put(c.name, code);
for (const [code, names] of Object.entries(ALIASES)) if (Object.hasOwn(ISO, code)) for (const n of names) put(n, code);

/**
 * The one country a value names: { code, name } (the code in capitals; `name` the table's English label
 * for it, not the value given), or null when it names none, or more than one. A two-letter code is read
 * only in capitals, as a code is written, so that a short word is not taken for one.
 */
export function countryOf(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^[A-Z]{2}$/.test(text) && Object.hasOwn(ISO, text)) return { code: text, name: ISO[text].name };
  const code = BY_NAME.get(countryKey(text));
  return code ? { code, name: ISO[code].name } : null;
}
/** The English name of a code (in either case), or null. */
export const countryName = (code) => { const c = String(code ?? '').trim().toUpperCase(); return Object.hasOwn(ISO, c) ? ISO[c].name : null; };
