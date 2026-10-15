// Krisis: the shape of a work file's `mint` section (wikidata.js, Issue #36), and its check, kept apart from
// wikidata.js so that work.js can read a work file without importing the lookup (wikidata.js imports lookup.js
// and regions.js, which import work.js: a cycle that stops match.js loading). Nothing here needs anything.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;   // work.js's, repeated here, not imported
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const QID = /^Q[1-9]\d*$/;
/** The statement the user makes for a dataset under a licence that asks credit or share-alike (D3). */
export const CONSENT = 'I hold the rights in this dataset, or have the holder\'s permission, and release these statements under CC0.';
/** The statements an item may carry, in the order the batch writes them, each on by default. */
export const STATEMENTS = Object.freeze(['labels', 'aliases', 'description', 'p31', 'p625', 'p17', 'p131']);
export const DEFAULT_STATEMENTS = Object.freeze(Object.fromEntries(STATEMENTS.map((k) => [k, true])));
// ---- the language of a label ------------------------------------------------------------------------------
/** A name's language tag as Wikidata's language code: its primary subtag, in lower case; null for none, or a tag that names no language (und, mis, mul, zxx). */
export function wdLang(tag) {
  const p = typeof tag === 'string' ? tag.trim().toLowerCase().split('-')[0] : '';
  return /^[a-z]{2,3}$/.test(p) && !['und', 'mis', 'mul', 'zxx'].includes(p) ? p : null;
}

export const MINT_VERSION = 1;
const BATCH_ID = /^q[1-9]\d*$/;
/** The mint section checked when present (readWork calls it): each part of a shape it can be read as, or `bad` is called in words. */
export function checkMint(w, bad) {
  const m = w.mint;
  if (m === undefined || m === null) return;
  if (!isObject(m) || m.version !== MINT_VERSION) bad(`its Wikidata items (mint) are not of version ${MINT_VERSION}, the one these tools read.`);
  if (m.consent !== null && m.consent !== undefined && !(isObject(m.consent) && m.consent.statement === CONSENT && isObject(m.consent.by) && typeof m.consent.by.name === 'string' && typeof m.consent.at === 'string' && DATE_TIME.test(m.consent.at)))
    bad('its consent to Wikidata items (mint.consent) is not the statement, who made it and when.');
  if (m.consent && /@/.test(m.consent.by.name)) bad('its consent to Wikidata items names an address with @ in it, which is never written.');
  if (m.options !== undefined && !(isObject(m.options) && (m.options.statements === undefined || (isObject(m.options.statements) && Object.keys(m.options.statements).every((k) => STATEMENTS.includes(k) && typeof m.options.statements[k] === 'boolean'))) && (m.options.lang === undefined || m.options.lang === null || wdLang(m.options.lang) === m.options.lang)))
    bad('its options for Wikidata items (mint.options) are not the statements, each on or off, and a language code.');
  if (m.items !== undefined && !(isObject(m.items) && Object.entries(m.items).every(([iri, it]) => Object.hasOwn(w.places, iri) && isObject(it) && (it.description === undefined || typeof it.description === 'string') && (it.kind === undefined || QID.test(it.kind)) && (it.excluded === undefined || it.excluded === true))))
    bad('its Wikidata items as edited (mint.items) are not each a listed place\'s description, kind (a Q-id) or exclusion.');
  if (m.batches !== undefined && !(Array.isArray(m.batches) && m.batches.every((b) => isObject(b) && BATCH_ID.test(b.id) && typeof b.at === 'string' && DATE_TIME.test(b.at) && Array.isArray(b.places) && b.places.every((p) => Object.hasOwn(w.places, p)) && /^[0-9a-f]{64}$/.test(b.sha256) && typeof b.name === 'string')))
    bad('its QuickStatements batches (mint.batches) are not each an id (q1, q2, …), when, the places, the file\'s name and SHA-256.');
  if (m.qids !== undefined && !(isObject(m.qids) && Object.entries(m.qids).every(([iri, r]) => Object.hasOwn(w.places, iri) && isObject(r) && QID.test(r.qid) && ['pasted', 'contribs'].includes(r.how) && typeof r.at === 'string' && DATE_TIME.test(r.at))))
    bad('the Wikidata items it records (mint.qids) are not each a listed place\'s Q-id, how it came, and when.');
  if (m.user !== undefined && m.user !== null && (typeof m.user !== 'string' || /@/.test(m.user))) bad('the Wikidata user name it records (mint.user) is not a name.');
}
