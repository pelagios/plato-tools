// Hermes, place names in a text: `text.dataset`, the names a reviewer confirmed made into a dataset of
// places (Stephen, 30 October 2026, Q1 A and Q2 A; Methodos's "Places from a text").
//
// attestationsFrom (attest.js) writes an attestation only for a name the reviewer also linked to a place,
// because an unlinked name "is evidence about nothing". That is right for a file of attestations about
// places that already have addresses. A text's names arrive with no address, as a table's do, and the steps
// that follow (the batched WHG lookup, the candidate review, Chora, publishing, Wikidata) start from a
// dataset of places not yet identified. So here a name the reviewer confirmed is evidence that the text
// names a place called so, and every one is given a place to be identified:
//   - ONE PLACE FOR EACH SPELLING: NFC, case-sensitive, so "Londinium" thirty times is one place, and
//     "londinium" another. Each mention is still its own attestation, citing the exact characters of the
//     text ("characters N to M", as locatorOf writes it). A decision with `separate: true` makes that
//     occurrence a place of its own (a second Newton); spellings that are variants of one another are
//     grouped for lookup, unticked, by the clustering the tail already has (cluster.js), not here.
//   - A PASTED ADDRESS IS KEPT: a name the reviewer linked to an address (decision.place) is an attestation
//     about that address, which is not made a new place and never replaced, as for a TEI @ref. The other
//     occurrences of its spelling, not linked, belong to the spelling's new place.
//   - THE ADDRESS OF A PLACE is made under the base address as a table's ids are (tableIds): from a hash of the
//     text and the spelling, so that it does not change with the order of decisions, and a second text with
//     the same name under the same base is not the same place. Nothing is made from a row number or a name.
// The output is an attestation-centric PLATO document (newSpatialEntities with the attestations given on
// their own, about them), as a table read with its rows grouped by id gives, and the standard tail takes it
// from there. A text with no confirmed name gives a message, not a file.
import { DataError } from '../../input.js';
import { checkReviewer } from '../../krisis/work.js';
import { normaliseBase } from '../../agora/address.js';
import { TEXT_WORDS } from '../../words.js';
import { sha256 } from '../../../lib/sha256.js';
import { checkText, suggestions } from './work.js';
import { sourceOf, confirmedMentions, mentionAttestation, contributorOf } from './attest.js';

const AC = 'https://w3id.org/plato/schemas/attestation-centric.schema.json';

/**
 * The id of a place made of a spelling of a text (the SHA-256 of the work file's text, `textSha256`):
 * "text-" and 16 hex digits of the hash of the two. `span` ("start-end") only for an occurrence the
 * reviewer separated from the others of its spelling.
 */
export const placeIdOf = (textSha256, spelling, span) => `text-${sha256(`${textSha256}\n${spelling.normalize('NFC')}${span ? `\n${span}` : ''}`).slice(0, 16)}`;

/**
 * The dataset of a review: { document, counts, places }, or a DataError in words.
 *   document  the attestation-centric PLATO document: `attestations` (one for each confirmed mention, in the
 *             order of the text) and `newSpatialEntities` (one place for each spelling, in the order it is
 *             first met);
 *   counts    { confirmed (mentions), linked (given an address by the reviewer), places (new), separate
 *             (places the reviewer separated), rejected, undecided };
 *   places    [{ '@id', label, mentions }] the new places.
 * `base` is the base address the places' addresses are made under (required: a text's names have none of
 * their own); the reviewer is the work file's, or `reviewer`. Throws a DataError if the text is not the
 * work file's, there is no reviewer or base address, or no name has been confirmed.
 */
export function datasetFrom(work, text, { base, reviewer = work.review.reviewer } = {}) {
  checkText(work, text);
  if (!reviewer) throw new DataError(TEXT_WORDS.dataset.noReviewer);
  checkReviewer(reviewer, 'datasetFrom: the reviewer');
  const b = normaliseBase(base);
  if (!b) throw new DataError(TEXT_WORDS.dataset.noBase);
  const { confirmed, rejected, undecided } = confirmedMentions(work, text);
  if (!confirmed.length) throw new DataError(TEXT_WORDS.dataset.nothingConfirmed({ suggested: suggestions(work).length, rejected, undecided }));
  const contributor = contributorOf(reviewer), source = sourceOf(work);
  const made = new Map();   // spelling (or the separated occurrence) -> the new place
  const attestations = [];
  let linked = 0, separate = 0;
  for (const m of confirmed) {
    let about = m.d.place;
    if (about) linked++;
    else {
      const spelling = m.toponym.normalize('NFC');
      const alone = m.d.separate === true;
      const key = alone ? `${m.start}-${m.end}` : `s:${spelling}`;
      let p = made.get(key);
      if (!p) {
        const id = placeIdOf(work.text.sha256, spelling, alone ? key : undefined);
        // As tableIds(base).place(id) makes it: the id is only hex digits and a prefix, which need no escaping.
        made.set(key, (p = { '@id': `${b}place/${id}`, label: spelling, entityIdentifier: id, attestations: [], mentions: 0 }));
        if (alone) separate++;
      }
      p.mentions++;
      about = p['@id'];
    }
    attestations.push(mentionAttestation(work, m, { about, contributor, source, linked: !!m.d.place }));
  }
  const places = [...made.values()];
  return {
    document: {
      $schema: AC, profile: 'attestation-centric',
      gazetteer: { title: TEXT_WORDS.dataset.title(work.source.title), description: TEXT_WORDS.dataset.description(work.source.title, contributor.name) },
      attestations,
      newSpatialEntities: places.map(({ mentions, ...place }) => place),
    },
    counts: { confirmed: confirmed.length, linked, places: places.length, separate, rejected, undecided },
    places: places.map((p) => ({ '@id': p['@id'], label: p.label, mentions: p.mentions })),
  };
}
