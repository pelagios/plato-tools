// Saving Chora's drawings (decision D2): the whole dataset as a PLATO JSON document, place-centric,
// with each drawing appended to its place's attestations as a new attestation. Nothing that was
// there is changed: each record is written as it was read, and its attestations with it, with the
// new ones after them. Then the version check (Mneme, src/engine/compare.js) reads the input and the
// file just written, in the same run, and must find every earlier attestation unchanged and exactly
// the drawings added: the save is shown to have kept PLATO's append-only rule, not assumed to.
//
// Additions are checked against the pinned JSON Schema here, before anything is read: the pipeline
// checks what it reads, not what options.augment adds to it.
import { run, explainSchema } from '../pipeline.js';
import { compare } from '../compare.js';
import { detect } from '../input.js';
import { Report } from '../report.js';
import { CHORA_TEXT } from '../words.js';
import { checkGeoJSON, DrawError } from './draw.js';
import { keyer } from './store.js';

/**
 * Whether an addition may go into a place-centric dataset: null when it may, else why not, in words.
 * `validators` are the prepared ones (resources.validators, from prepare() in pipeline.js).
 */
export function checkAddition(attestation, validators) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) return 'An addition is not an attestation.';
  for (const g of attestation.geometries || []) {
    if (!g || typeof g !== 'object' || g.geojson === undefined) continue;
    try { checkGeoJSON(g.geojson); } catch (e) { if (e instanceof DrawError) return e.message; throw e; }
  }
  // The place-centric schema has no attestation of its own, only one nested under a place, with the
  // rules that apply there (no `about`): so the addition is checked under a place of its own.
  const v = validators['place-centric'].entity;
  return v({ label: 'a place', attestations: [attestation] }) ? null : explainSchema(v.errors, false);
}

/** The name of the saved file: the input's, without its extension, then .chora.json. */
export const savedName = (name) => String(name).replace(/\.gz$/i, '').replace(/\.[^./]+$/, '') + '.chora.json';

/**
 * A record with its additions after its own attestations; the record read is not changed. `key` is
 * keyer()'s: null for a record that is not a place, which is passed through as it is. A place the
 * dataset gives twice under one @id gets its additions once, at the first, as Chora's store shows it.
 */
function appendTo(rec, key, byPlace, placed) {
  const adds = key === null || placed.has(key) ? null : byPlace.get(key);
  if (!adds) return rec;
  placed.add(key);
  return { ...rec, attestations: [...(Array.isArray(rec.attestations) ? rec.attestations : []), ...adds] };
}

/**
 * Write the dataset with its additions (byPlace: place key -> [attestation]) to `name`: a conversion
 * to PLATO JSON by run(), whose options.augment is given each place-centric record, in the order a
 * sink is given them, and puts its additions after its own attestations. The places are counted as
 * Chora's store counts them (keyer, in store.js), so a place without an @id is found by its position
 * here as there. makeWriter names the file from options.name, so the output is `name`. Returns run()'s
 * result.
 */
function writeWithAdditions(input, byPlace, placed, env, name) {
  const keyOf = keyer();
  return run({ input, action: 'convert', target: 'plato-json', options: { name, augment: (rec) => appendTo(rec, keyOf(rec), byPlace, placed) } }, env);
}

// What the version check must find for the save to stand: nothing of the earlier version lost or
// changed, whatever the dataset's status (an unpublished dataset gets these as warnings, and a save
// must keep them all the same), and exactly the additions added. Chora adds attestations and nothing
// else, so what identifies or describes a place (always warnings, since either may be corrected in a
// new version) must not change either.
const BREACHES = new Set(['attestation-removed', 'attestation-changed', 'attestation-gone', 'facet-changed', 'facet-removed',
  'identity-removed', 'identity-changed', 'identity-gone', 'description-changed', 'description-removed', 'version-not-read', 'unreadable']);
/**
 * Mneme's verdict on a save: `later` (a File: the saved document) against `input`, with `added`
 * attestations expected new. Returns { passed, report, reasons }.
 */
export async function verify(input, later, added, env) {
  const r = await compare({ earlier: input, later: await detect([later]) }, env);
  const rep = r.report, c = rep.counts || {};
  const reasons = [];
  if (r.incomplete) reasons.push('a version could not be read to the end');
  // A dataset with no attestations yet (a list of places to locate) leaves the version check nothing
  // to compare, which it reports as a problem. For a save that is the one problem allowed: the counts
  // below must still show exactly the drawings added, and nothing else.
  const errors = rep.items.filter((i) => i.severity === 'error' && !(i.kind === 'nothing-to-compare' && c.earlier === 0)).reduce((n, i) => n + i.count, 0);
  if (errors) reasons.push(`${errors} problem${errors === 1 ? '' : 's'}`);
  for (const i of rep.items) if (BREACHES.has(i.kind) && i.severity !== 'error') reasons.push(`${i.kind} (${i.count})`);
  if (c.earlier === undefined) reasons.push('nothing was compared');
  else {
    if (c.lost || c.changed) reasons.push(`${c.lost} lost, ${c.changed} changed`);
    if (c.added !== added || c.later !== c.earlier + added) reasons.push(`${c.added} added where ${added} were expected`);
  }
  return { passed: reasons.length === 0, report: rep, reasons };
}

/**
 * Save `additions` ([{ placeId, attestation }]) into the dataset `input` (as detect() describes it).
 * options:
 * - name: the input's name, for the saved file's (default: the first file's);
 * - contributor: given to each addition that does not say who made it;
 * - hasPlace(key): whether the dataset has the place, when the caller knows (Chora's store); without
 *   it the dataset is read once first to find out, so that nothing is written for a missing place;
 * - reopen(output): the written file as a File, for the version check (hosts differ).
 * Returns { report, outputs, mneme: { passed, report, reasons } | null, incomplete? }.
 */
export async function save(input, additions, env, options = {}) {
  const rep = new Report();
  const fail = () => ({ report: rep.toJSON(), outputs: [], mneme: null, incomplete: true });
  // Every addition is checked, and grouped by its place, before anything is read or written.
  const byPlace = new Map();
  for (const [i, add] of (additions || []).entries()) {
    const where = `drawing ${i + 1}${add && add.placeId ? ` (${add.placeId})` : ''}`;
    if (!add || typeof add.placeId !== 'string' || !add.placeId) { rep.error('chora-addition-invalid', CHORA_TEXT['chora-addition-invalid'], `${where}: it names no place`); continue; }
    let a = add.attestation;
    if (a && typeof a === 'object' && a.contributor === undefined && options.contributor) a = { ...a, contributor: options.contributor };
    const why = checkAddition(a, env.resources.validators);
    if (why) { rep.error('chora-addition-invalid', CHORA_TEXT['chora-addition-invalid'], `${where}: ${why}`); continue; }
    (byPlace.get(add.placeId) || byPlace.set(add.placeId, []).get(add.placeId)).push(a);
  }
  if (rep.toJSON().errors) return fail();
  // A place the dataset does not have: reported now, not found missing in the file afterwards.
  let missing;
  if (options.hasPlace) missing = [...byPlace.keys()].filter((k) => !options.hasPlace(k));
  else {
    const seen = new Set(), keyOf = keyer();
    const r = await run({ input, action: 'check', options: { sink: { header() {}, event(ev) { if (ev.type === 'record') { const k = keyOf(ev.value); if (k !== null && byPlace.has(k)) seen.add(k); } }, async close() {} } } }, env);
    if (r.incomplete) { rep.error('chora-unreadable', CHORA_TEXT['chora-unreadable'], r.report.items.find((i) => i.kind === 'unreadable')?.examples[0]); return fail(); }
    missing = [...byPlace.keys()].filter((k) => !seen.has(k));
  }
  for (const k of missing) rep.error('chora-no-such-place', CHORA_TEXT['chora-no-such-place'], k);
  if (missing.length) return fail();

  const name = savedName(options.name || input.name || input.files[0].name);
  const placed = new Set();
  const w = await writeWithAdditions(input, byPlace, placed, env, name);
  const report = w.report;
  const added = [...byPlace.values()].reduce((s, l) => s + l.length, 0);
  if (w.incomplete) return { report, outputs: [], mneme: null, incomplete: true };
  for (const k of byPlace.keys()) if (!placed.has(k)) { report.items.push({ severity: 'error', kind: 'chora-not-placed', message: CHORA_TEXT['chora-not-placed'], count: 1, examples: [k] }); report.errors++; }
  report.counts['attestations added'] = added;

  if (!options.reopen) throw new Error('save() needs options.reopen to read the saved file back for the version check');
  const mneme = await verify(input, await options.reopen(w.outputs[0]), added, env);
  return { report, outputs: w.outputs, mneme };
}
