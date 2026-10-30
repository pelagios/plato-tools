// Hermes, place names in a text: the PLATO attestations a finished review makes.
//
// One attestation for each mention a named reviewer has confirmed AND linked to a place; nothing for
// a suggestion not reviewed, rejected, or confirmed with no place (a mention with no place linked is
// evidence about nothing: it is listed in `unlinked`, for the CSV the page offers, and counted).
//   about        the place linked
//   names        [{ toponym: the words of the text at that span, language: the text's, if given }]
//   formStatus   plato:Attested: the form is read in the source cited
//   citations    [{ source: the text, locator: "characters N to M" }], counted in code points of the
//                decoded text from 0, M the position after the last character, as W3C's
//                TextPositionSelector counts and as the annotations reader words it
//   types        [{ label }] only when the reviewer confirmed or changed the kind of place; the
//                model's guess alone is never a type, and is said in the notes instead
//   contributor  the reviewer; created: when the decision was made
//   notes        the model, provider, prompt and date of the suggestion (words.js, hermesTextNote)
// No @id: whatever saves it mints one.
// This is the file of attestations about places that already have addresses. The names with no place linked
// become places of a dataset of their own in dataset.js (`text.dataset`), which uses the pieces here
// (confirmedMentions, mentionAttestation).
import { PLATO } from '../../../lib/context.js';
import { checkReviewer, isIri } from '../../krisis/work.js';
import { hermesTextNote } from '../../words.js';
import { sliceCodePoints } from './chunk.js';
import { checkText, suggestions } from './work.js';

const ATTESTED = PLATO + 'Attested';
const AC = 'https://w3id.org/plato/schemas/attestation-centric.schema.json';

/** The text, as a PLATO source. */
export function sourceOf(work) {
  // The rights statement is a licence, in PLATO's sense, only when it is a web address (source.licence is one).
  const licence = work.source.rights && /^https?:\/\/\S+$/i.test(work.source.rights) && isIri(work.source.rights) ? work.source.rights : null;
  return { ...(work.source.uri ? { '@id': work.source.uri } : {}), title: work.source.title, authorityType: 'source', ...(licence ? { licence } : {}) };
}

/** The locator of a span. */
export const locatorOf = (start, end) => `characters ${start} to ${end}`;

/** The contributor a reviewer is, as an attestation names one. */
export const contributorOf = (reviewer) => ({ name: reviewer.name.trim(), ...(reviewer.orcid ? { orcid: reviewer.orcid } : {}) });

/**
 * The names a reviewer confirmed, in the order of the text: [{ s (the suggestion), d (the decision),
 * start, end, toponym (the words of the text at that span, as given), locator }], with the number
 * rejected and the number not yet decided. Throws if the text is not the work file's, or a span
 * is not what was suggested there.
 */
export function confirmedMentions(work, text) {
  checkText(work, text);
  const confirmed = [];
  let rejected = 0, undecided = 0;
  for (const s of suggestions(work)) {
    const d = work.review.decisions[s.id];
    if (!d) { undecided++; continue; }
    if (d.status !== 'confirmed') { rejected++; continue; }
    const start = d.start ?? s.start, end = d.end ?? s.end;
    const toponym = sliceCodePoints(text, start, end);
    if (toponym === null) throw new Error(`attestationsFrom: characters ${start} to ${end} are not in the text.`);
    if (d.start === undefined && toponym !== s.text) throw new Error(`attestationsFrom: characters ${start} to ${end} of the text are not the name suggested there.`);
    confirmed.push({ s, d, start, end, toponym, locator: locatorOf(start, end) });
  }
  return { confirmed, rejected, undecided };
}

/**
 * The attestation of one confirmed name (a `confirmedMentions` item) about `about`: the words of the text
 * there, the text cited at the span, the contributor, and a note saying how it came about; `linked`
 * says whether the reviewer linked the place (the note says so). A type only when the reviewer
 * confirmed one. No @id: whatever saves it mints one.
 */
export function mentionAttestation(work, m, { about, contributor, source, linked }) {
  const { s, d, toponym, locator } = m;
  const a = {
    about,
    names: [{ toponym, ...(work.language ? { language: work.language } : {}) }],
    formStatus: ATTESTED,
    citations: [{ source, locator }],
    contributor,
    created: d.decided_at,
    notes: hermesTextNote({
      model: s.model_returned || s.model, provider: s.provider, prompt: s.prompt_version, date: s.generated_at.slice(0, 10),
      kindGuess: d.type || s.added ? null : s.kind, adjustedFrom: d.start !== undefined ? [s.start, s.end] : null, addedBy: !!s.added, linked,
    }),
  };
  if (d.type) a.types = [{ label: d.type }];
  return a;
}

/**
 * The attestations of a review, from its work file and the text it was made from:
 * { attestations, unlinked: [{ id, text, start, end, locator, kind }], counts: { confirmed, linked, unlinked, rejected } },
 * in the order of the text. Throws if the text is not the work file's, or there is no reviewer.
 */
export function attestationsFrom(work, text, { reviewer = work.review.reviewer } = {}) {
  checkText(work, text);
  if (!reviewer) throw new Error('attestationsFrom: the review has no reviewer.');
  checkReviewer(reviewer, 'attestationsFrom: the reviewer');
  const contributor = contributorOf(reviewer);
  const source = sourceOf(work);
  const attestations = [], unlinked = [];
  const { confirmed, rejected } = confirmedMentions(work, text);
  for (const m of confirmed) {
    if (!m.d.place) { unlinked.push({ id: m.s.id, text: m.toponym, start: m.start, end: m.end, locator: m.locator, kind: m.d.type ?? m.s.kind }); continue; }
    attestations.push(mentionAttestation(work, m, { about: m.d.place, contributor, source, linked: true }));
  }
  return { attestations, unlinked, counts: { confirmed: attestations.length + unlinked.length, linked: attestations.length, unlinked: unlinked.length, rejected } };
}

/** The attestations as an attestation-centric PLATO document. */
export function attestationsDocument(attestations) {
  return { $schema: AC, profile: 'attestation-centric', attestations };
}

const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${(/^[=+\-@\t]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
/**
 * The confirmed mentions with no place linked, as CSV (name, start, end, locator, kind, source), for a
 * table of places the user can complete and read in again. A cell a spreadsheet would take for a
 * formula is written with a leading apostrophe.
 */
export function unlinkedCsv(work, unlinked) {
  const rows = [['name', 'start', 'end', 'locator', 'kind', 'source']];
  for (const u of unlinked) rows.push([u.text, u.start, u.end, u.locator, u.kind, work.source.title]);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
