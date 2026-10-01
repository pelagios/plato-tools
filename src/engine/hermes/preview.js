// The preview (Hermes): the first records of an input, read by the reader a run uses (pipeline.js,
// sourceFor), each checked against PLATO's schema as it is read, and nothing written. It is for
// seeing what a table of places, a TEI edition or a Recogito export becomes before checking or
// converting all of it, so it is made only of those (a CSV file, plain GeoJSON, a sheet of a
// workbook, TEI, W3C Web Annotations); any other format is refused, plainly.
//
// What a preview shows is the reader's own stream of events: its first `limit` records, or
// attestations. An attestation-centric input (annotations, TEI, a table of places whose rows are
// about web addresses or share ids) is regrouped by place through the store at the end of a run, so
// the preview's items are the events the run's reader gives, before that, not the places a run
// writes. Reading stops at the first record past the limit (so that whether there is more is known,
// and said), and the reader is closed there: its generators' finally blocks let go of the file's
// stream. The report is as it stood at the last record shown (`read` counts what was read, that one
// record more included). A preview that stops early says why its records may not be all there are (`why`), and the
// report says so too (preview-partial, a warning: the report has no notice severity). The total is
// given only where the whole input was read; an input is never read to its end to count it.
import { sourceFor, explainSchema } from '../pipeline.js';
import { DataError } from '../input.js';
import { Report, LOSS_TEXT } from '../report.js';
import { PREVIEW_WORDS, formatName } from '../words.js';
import { genericProfile, withSheet } from './generic.js';

/** The formats a preview is made of. */
export const PREVIEWED = new Set(['csv', 'geojson', 'tei', 'w3c-annotations']);
/** How many records a preview shows unless told otherwise. */
export const PREVIEW_LIMIT = 10;
/** Why an input cannot be previewed, in words, or null. */
export const previewRefusal = (input) => (PREVIEWED.has(input?.format) ? null : PREVIEW_WORDS.refused(input?.format ? formatName(input) : 'not data these tools read'));

/**
 * Preview an input: { header, profile, items, report, complete, read, total, why }. `items` are the
 * reader's first `limit` record and attestation events, as it gives them ({ type, value, n,
 * newEntity? }); `header` the document header it gave; `complete` whether the whole input was read;
 * `read` what was read of it, by the reader's own counts (rows, features, annotations, place
 * names); `total` the number of records, where the whole input was read, else null; `why`, when not
 * complete, why the items may not be all there are, in words. `options` are a run's (the matching
 * of columns, the sheet, the reading options). env.resources gives the schemas; nothing of env is
 * written to: env.output is never called, and no database is opened. A format no preview is made
 * of, or a limit that is not a whole number of at least 1, is a DataError.
 */
export async function preview({ input, options = {}, limit = PREVIEW_LIMIT }, env) {
  const refusal = previewRefusal(input);
  if (refusal) throw new DataError(refusal);
  if (!Number.isInteger(limit) || limit < 1) throw new DataError(PREVIEW_WORDS.limit(limit));
  const chosen = typeof options.sheet === 'string' && input.container === 'workbook' ? withSheet(input, options.sheet) : input;
  const rep = new Report();
  const generic = chosen.format === 'csv' || chosen.format === 'geojson' ? await genericProfile(chosen, options) : null;
  const profile = generic || 'attestation-centric';
  const V = env.resources.validators[profile];
  // What a TEI reader holds back, asked when the preview stops (tei.js, teiSource).
  let held = null;
  // The reader is given no output and no database: a preview's readers need neither (the tables, which
  // load a database, are refused above).
  const source = sourceFor(chosen, { resources: env.resources, xlsx: env.xlsx }, rep, options, 'check', { watch: (f) => { held = f; } });
  const items = [];
  // The report as it stood when the last record shown was read: the record read past the limit, to
  // know there is more, is not shown, and nor is what was lost from it.
  let shown = null;
  let header = null, complete = true, unreadable = null;
  try {
    for await (const ev of source) {
      if (ev.type === 'header') {
        header = ev.value;
        if (profile === 'attestation-centric' && !V.header(header)) rep.error('schema', `The document header does not match the PLATO JSON Schema: ${explainSchema(V.header.errors, false)}`);
        continue;
      }
      if (ev.type !== 'record' && ev.type !== 'attestation' && ev.type !== 'idr') continue;
      // One past the limit: there is more, and the reading stops here (the loop's break closes the reader).
      if (items.length >= limit) { complete = false; break; }
      check(ev, V, rep);
      items.push(ev);
      if (items.length === limit) shown = JSON.parse(JSON.stringify(rep.toJSON()));
    }
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    complete = false; unreadable = e.message;
    rep.error('unreadable', 'The file could not be read to the end, so only the part before the problem was read', e.message);
  }
  // Stopped at the record past the limit: the losses so far are those of the records shown.
  const out = !complete && !unreadable && shown ? restored(shown) : rep;
  let why = null;
  if (!complete) {
    const W = PREVIEW_WORDS, parts = [];
    if (unreadable) parts.push(W.unreadable(unreadable));
    else parts.push(W.stopped(items.length));
    if (profile === 'attestation-centric') parts.push(W.regrouped);
    if (generic === 'attestation-centric' && options.sameId === true && !items.some((ev) => ev.newEntity)) parts.push(W.sameId);
    const back = held ? held() : null;
    if (back?.pending) parts.push(W.teiPending(back.pending));
    if (back?.held) parts.push(W.teiHeld(back.held));
    why = parts.join(' ');
    out.add('warning', 'preview-partial', LOSS_TEXT['preview-partial'], why);
  }
  return { header, profile, items, report: out.toJSON(), complete, read: { ...rep.counts }, total: complete ? items.length : null, why };
}

/** A Report holding what a report's JSON holds. */
function restored({ items, counts }) {
  const r = new Report();
  for (const i of items) {
    r.add(i.severity, i.kind, i.message, undefined, i.count);
    r.kinds.get(i.severity + '\u0001' + i.kind + '\u0001' + i.message).examples.push(...i.examples);
  }
  r.counts = { ...counts };
  return r;
}

/** Check one event against the schema, as a run does (pipeline.js, checkRecord), reporting what fails. */
function check(ev, V, rep) {
  const f = ev.newEntity ? V.newEntity : ev.type === 'record' ? V.entity : ev.type === 'attestation' ? V.attestation : V.identity;
  if (f && !f(ev.value)) rep.error('schema', explainSchema(f.errors, false), ev.value?.['@id'] || ev.value?.about || `item ${ev.n}`);
}

/** The line above a preview, in words: "first 10 of 12 records; nothing checked or written". */
export const previewLine = (result) => PREVIEW_WORDS.line({ count: result.items.length, total: result.total });
