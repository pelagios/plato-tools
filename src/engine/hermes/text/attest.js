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
import { PLATO } from '../../../lib/context.js';
import { checkReviewer } from '../../krisis/work.js';
import { hermesTextNote } from '../../words.js';
import { sliceCodePoints } from './chunk.js';
import { checkText, suggestions } from './work.js';

const ATTESTED = PLATO + 'Attested';
const AC = 'https://w3id.org/plato/schemas/attestation-centric.schema.json';

/** The text, as a PLATO source. */
export function sourceOf(work) {
  return { ...(work.source.uri ? { '@id': work.source.uri } : {}), title: work.source.title, authorityType: 'source' };
}

/** The locator of a span. */
export const locatorOf = (start, end) => `characters ${start} to ${end}`;

/**
 * The attestations of a review, from its work file and the text it was made from:
 * { attestations, unlinked: [{ id, text, start, end, locator, kind }], counts: { confirmed, linked, unlinked, rejected } },
 * in the order of the text. Throws if the text is not the work file's, or there is no reviewer.
 */
export function attestationsFrom(work, text, { reviewer = work.review.reviewer } = {}) {
  checkText(work, text);
  if (!reviewer) throw new Error('attestationsFrom: the review has no reviewer.');
  checkReviewer(reviewer, 'attestationsFrom: the reviewer');
  const contributor = { name: reviewer.name.trim(), ...(reviewer.orcid ? { orcid: reviewer.orcid } : {}) };
  const source = sourceOf(work);
  const attestations = [], unlinked = [];
  let rejected = 0;
  for (const s of suggestions(work)) {
    const d = work.review.decisions[s.id];
    if (!d) continue;
    if (d.status !== 'confirmed') { rejected++; continue; }
    const start = d.start ?? s.start, end = d.end ?? s.end;
    const toponym = sliceCodePoints(text, start, end);
    if (toponym === null) throw new Error(`attestationsFrom: characters ${start} to ${end} are not in the text.`);
    if (d.start === undefined && toponym !== s.text) throw new Error(`attestationsFrom: characters ${start} to ${end} of the text are not the name suggested there.`);
    const locator = locatorOf(start, end);
    if (!d.place) { unlinked.push({ id: s.id, text: toponym, start, end, locator, kind: d.type ?? s.kind }); continue; }
    const a = {
      about: d.place,
      names: [{ toponym, ...(work.language ? { language: work.language } : {}) }],
      formStatus: ATTESTED,
      citations: [{ source, locator }],
      contributor,
      created: d.decided_at,
      notes: hermesTextNote({
        model: s.model_returned || s.model, provider: s.provider, prompt: s.prompt_version, date: s.generated_at.slice(0, 10),
        kindGuess: d.type ? null : s.kind, adjustedFrom: d.start !== undefined ? [s.start, s.end] : null,
      }),
    };
    if (d.type) a.types = [{ label: d.type }];
    attestations.push(a);
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
