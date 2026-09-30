// Saving Chora's drawings (decision D2): the whole dataset, place-centric, as PLATO JSON Lines if it
// was read from them (each line as it came), else as a PLATO JSON document, with each drawing appended
// to its place's attestations as a new attestation. Nothing that was
// there is changed: each record is written as it was read, and its attestations with it, with the
// new ones after them. Then the version check (Mneme, src/engine/compare.js) reads the input and the
// file just written, in the same run, and must find every earlier attestation unchanged and exactly
// the drawings added: the save is shown to have kept PLATO's append-only rule, not assumed to.
//
// Additions are checked against the pinned JSON Schema here, before anything is read: the pipeline
// checks what it reads, not what options.augment adds to it. And a file that cannot hold what was read
// (a line that could not be read, a record that could not be written, a place moved among the identity
// relations) is refused as soon as that is known, before the version check, which is ~90% of a save's
// time (14 minutes for DEEP) and could only fail.
import { run, explainSchema } from '../pipeline.js';
import { compare, NOT_READ } from '../compare.js';
import { detect } from '../input.js';
import { Report } from '../report.js';
import { CHORA_TEXT, choraSavedFormat } from '../words.js';
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

/** The name of the saved file: the input's, without its extension, then .chora.json, or .chora.jsonl for `target` 'plato-jsonl'. */
export const savedName = (name, target = 'plato-json') => String(name).replace(/\.gz$/i, '').replace(/\.[^./]+$/, '') + (target === 'plato-jsonl' ? '.chora.jsonl' : '.chora.json');

// What a run reports when the file it wrote cannot hold what was read: part of the input not read
// (the kinds the version check calls not read, and a file that stops part-way), or, from the writer,
// a place moved among the identity relations. Mneme would fail each; the save need not wait for it.
const NOT_KEPT = new Set([...NOT_READ, 'unreadable', 'order']);
/** The items of a run's report that mean its output does not hold its input: none, for a save to go on. */
export const refusalOf = (report) => (report?.items || []).filter((i) => NOT_KEPT.has(i.kind));
/** The refusal in the save's report: one problem, with what the run said as its examples. */
const refuseNotKept = (rep, items) => rep.add('error', 'chora-not-kept', CHORA_TEXT['chora-not-kept'], items.map((i) => `${i.message}${i.count > 1 ? ` (${i.count.toLocaleString('en-GB')} times)` : ''}${i.examples?.[0] ? `: ${i.examples[0]}` : ''}`).join(' | ') || undefined);

/**
 * A record with its additions after its own attestations; the record read is not changed. `key` is
 * keyer()'s: null for a record that is not a place, which is passed through as it is. A place the
 * dataset gives twice under one @id gets its additions once, at the first, as Chora's store shows it.
 */
function appendTo(rec, key, byPlace, placed, unlisted) {
  const adds = key === null || placed.has(key) ? null : byPlace.get(key);
  if (!adds) return rec;
  // Attestations that are not a list cannot have drawings put after them without replacing them: the
  // record is left as it was, and the save refused (save(), which looks for such a place first).
  if (!listed(rec)) { unlisted.set(key, rec); return rec; }
  placed.add(key);
  return { ...rec, attestations: [...(rec.attestations || []), ...adds] };
}
/** Whether a record's attestations are a list, or absent (a place with none yet). */
const listed = (rec) => rec.attestations === undefined || Array.isArray(rec.attestations);
/** A place refused for its attestations, as the report names it: its label and key. */
const refuse = (rep, key, rec) => rep.error('chora-attestations-not-a-list', CHORA_TEXT['chora-attestations-not-a-list'], typeof rec?.label === 'string' && rec.label ? `${rec.label} (${key})` : key);

/**
 * Write the dataset with its additions (byPlace: place key -> [attestation]) to `name`: a conversion
 * to `target` (PLATO JSON Lines or JSON) by run(), whose options.augment is given each place-centric record, in the order a
 * sink is given them, and puts its additions after its own attestations. The places are counted as
 * Chora's store counts them (keyer, in store.js), so a place without an @id is found by its position
 * here as there. makeWriter names the file from options.name, so the output is `name`. Returns run()'s
 * result.
 */
function writeWithAdditions(input, byPlace, placed, unlisted, env, name, target) {
  const keyOf = keyer();
  return run({ input, action: 'convert', target, options: { name, augment: (rec) => appendTo(rec, keyOf(rec), byPlace, placed, unlisted) } }, env);
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
 * - record(key): the place's record, when the caller has it (Chora's store), so that a place whose
 *   attestations are not a list is refused before anything is written, as the first reading does;
 * - reopen(output): the written file as a File, for the version check (hosts differ);
 * - discard(output): remove a file written and refused (hosts differ), so that it holds no storage;
 * - readReport: the report of the dataset's reading when the caller has it (Chora's store), so that one
 *   that could not all be read is refused before anything is written;
 * - attestations: how many the dataset has, when the caller knows, for the progress of the writing.
 * The file is PLATO JSON Lines for a dataset read from them, else PLATO JSON (choraSavedFormat).
 * Progress goes to env.progress, each event saying which step of the save it is (`save`: 'finding',
 * 'writing', 'checking') and, where known, how many attestations that step will read (`total`).
 * Returns { report, outputs, mneme: { passed, report, reasons } | null, incomplete? }.
 */
export async function save(input, additions, env, options = {}) {
  const rep = new Report();
  const t0 = Date.now(), progress = env.progress || (() => {});
  // Each step's progress, marked as the save's, with the time since the save began.
  const step = (save, total) => ({ ...env, progress: (p) => progress({ ...p, save, ...(total ? { total } : {}), elapsedMs: Date.now() - t0 }) });
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
  // And a place whose attestations are not a list (a dataset the schema would refuse, which Chora
  // still opens): its drawings could only replace them, so nothing is written. The first of a place
  // given twice is the one looked at, as it is the one the drawings go to.
  let missing;
  const unlisted = new Map();
  if (options.hasPlace) {
    missing = [...byPlace.keys()].filter((k) => !options.hasPlace(k));
    if (options.record) for (const k of byPlace.keys()) { const rec = missing.includes(k) ? null : options.record(k); if (rec && !listed(rec)) unlisted.set(k, rec); }
  } else {
    const seen = new Set(), keyOf = keyer();
    const r = await run({ input, action: 'check', options: { sink: { header() {}, event(ev) {
      if (ev.type !== 'record') return;
      const k = keyOf(ev.value);
      if (k !== null && byPlace.has(k) && !seen.has(k)) { seen.add(k); if (!listed(ev.value)) unlisted.set(k, ev.value); }
    }, async close() {} } } }, step('finding', options.attestations));
    if (r.incomplete) { rep.error('chora-unreadable', CHORA_TEXT['chora-unreadable'], r.report.items.find((i) => i.kind === 'unreadable')?.examples[0]); return fail(); }
    missing = [...byPlace.keys()].filter((k) => !seen.has(k));
    options = { ...options, readReport: r.report };
  }
  // A dataset that could not all be read cannot be saved whole: refused before anything is written.
  const unread = refusalOf(options.readReport);
  if (unread.length) { refuseNotKept(rep, unread); return fail(); }
  for (const k of missing) rep.error('chora-no-such-place', CHORA_TEXT['chora-no-such-place'], k);
  for (const [k, rec] of unlisted) refuse(rep, k, rec);
  if (missing.length || unlisted.size) return fail();

  const { target } = choraSavedFormat(input);
  const name = savedName(options.name || input.name || input.files[0].name, target);
  const placed = new Set();
  progress({ save: 'writing', attestations: 0, ...(options.attestations ? { total: options.attestations } : {}), elapsedMs: Date.now() - t0 });
  const w = await writeWithAdditions(input, byPlace, placed, unlisted, step('writing', options.attestations), name, target);
  const report = w.report;
  const added = [...byPlace.values()].reduce((s, l) => s + l.length, 0);
  const discard = async () => { if (options.discard) for (const o of w.outputs || []) { try { await options.discard(o); } catch { /* gone already */ } } };
  // Found only in the writing (the caller knew the place, not its record): the file written is not offered.
  if (unlisted.size) { await discard(); for (const [k, rec] of unlisted) refuse(rep, k, rec); return fail(); }
  if (w.incomplete) { await discard(); return { report, outputs: [], mneme: null, incomplete: true }; }
  // A file that does not hold what was read: refused now, not after the version check has read it all.
  const notKept = refusalOf(report);
  if (notKept.length) {
    await discard();
    refuseNotKept(rep, notKept);
    const r = rep.toJSON();
    return { report: { ...report, errors: report.errors + r.errors, items: [...r.items, ...report.items] }, outputs: [], mneme: null, incomplete: true };
  }
  for (const k of byPlace.keys()) if (!placed.has(k)) { report.items.push({ severity: 'error', kind: 'chora-not-placed', message: CHORA_TEXT['chora-not-placed'], count: 1, examples: [k] }); report.errors++; }
  report.counts['attestations added'] = added;

  if (!options.reopen) throw new Error('save() needs options.reopen to read the saved file back for the version check');
  const earlier = report.counts.attestations;
  progress({ save: 'checking', version: 'earlier', phase: 'reading', attestations: 0, ...(earlier ? { total: earlier } : {}), elapsedMs: Date.now() - t0 });
  // The version check reads the dataset, then the file written, which has the additions besides.
  const checking = { ...env, progress: (p) => progress({ ...p, save: 'checking', ...(earlier ? { total: p.version === 'later' ? earlier + added : earlier } : {}), elapsedMs: Date.now() - t0 }) };
  const mneme = await verify(input, await options.reopen(w.outputs[0]), added, checking);
  return { report, outputs: w.outputs, mneme };
}
