// Chora's search folds a label or name, and a query, the same way: here on its own, so that the page
// can fold a query without loading the engine.
/**
 * A label or name as the search box compares it: lower case, without accents (Ἑρμῆς finds ερμης,
 * İstanbul finds istanbul), compatibility forms spelt out (ﬁ fi, ſ s, µ μ), letters that are no
 * accented letter spelt out as they are written in their place (œ oe, æ ae, þ and ð th, ß ss:
 * Brabœuf finds braboeuf, Þanet thanet), a final sigma as any other (ς σ), and without U+0000 (which
 * would end the text for LIKE) or U+0001 (which joins a place's names in the search table).
 * What it gives, FTS5's trigram tokenizer keeps as it is (it folds case by its own table, which takes
 * ς to σ and ſ to s where JavaScript does not, and SQLite reads the non-characters U+FFFE and U+FFFF
 * as U+FFFD, as it does a lone surrogate, which toWellFormed() makes U+FFFD first): so the index, the scan and the name shown agree. Checked over every code point.
 */
const SPELT = { 'œ': 'oe', 'æ': 'ae', 'þ': 'th', 'ð': 'th', 'ß': 'ss', 'ς': 'σ', '\uFFFE': '\uFFFD', '\uFFFF': '\uFFFD' };
export const fold = (s) => String(s ?? '').toWellFormed().normalize('NFKD').replace(/[\p{M}\u0000\u0001]/gu, '').toLowerCase().replace(/[œæþðßς\uFFFE\uFFFF]/g, (c) => SPELT[c]);
