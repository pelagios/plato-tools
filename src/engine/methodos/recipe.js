// Methodos: the shape of a recipe, its check, and its digest.
//
// A recipe is a plain object (recipes/<key>.js):
//   key, title, version   a key, a plain-English title, and a whole number raised when its steps change;
//   files                 the files the user chooses at the start, each { words, types, optional? };
//   asks                  the questions it asks, each { question, kind: 'yes-no' | 'text' | 'list' | 'choice',
//                         choices? (for 'choice'), optional? };
//   steps                 in order, each { id, op, title?, from, options?, when? }:
//     from      each input of the operation, from a file chosen at the start ('$files') or an earlier
//               step's output ('mint.dataset'); 'a.x ?? b.y' takes the first of those that was made;
//     options   the operation's options, literal or from an answer ('$release'; left out if not given);
//     when      the yes-no question under which the step runs ('will-publish'), or '!' and one under
//               which it does not; a step whose condition fails is skipped.
// The recipe is data: check() walks it, the runner copies what it needs of it into the workflow's
// state, and digest() hashes it, so that a workflow says exactly which recipe it followed.
import { sha256 } from '../../lib/sha256.js';
import { OPERATIONS } from './operations.js';
import { TYPES, typeWords } from './handoffs.js';

export class RecipeError extends Error {
  constructor(message) { super(message); this.name = 'RecipeError'; }
}

const KINDS = ['yes-no', 'text', 'list', 'choice'];

/** The alternatives of one `from` value: 'place.dataset ?? apply.dataset' -> ['place.dataset', 'apply.dataset']. */
export const alternatives = (ref) => String(ref).split('??').map((s) => s.trim());

/** Whether a step runs under the answers given. */
export function applies(step, answers) {
  if (!step.when) return true;
  const not = step.when.startsWith('!');
  const v = answers[not ? step.when.slice(1) : step.when] === true;
  return not ? !v : v;
}

/**
 * Throw, in words, if the recipe is not well formed: every operation known, every input given by a
 * file chosen at the start or produced by an earlier step, of a type the operation takes, and never
 * taken only from a step that may have been skipped; every answer it uses asked.
 */
export function check(recipe) {
  const r = recipe || {};
  const say = (s) => { throw new RecipeError(`The recipe "${r.title || r.key || '?'}": ${s}`); };
  if (typeof r.key !== 'string' || !/^[a-z][a-z0-9-]*$/.test(r.key)) say('its key must be lower-case words joined by hyphens.');
  if (typeof r.title !== 'string' || !r.title.trim()) say('it has no title.');
  if (!Number.isSafeInteger(r.version) || r.version < 1) say('its version must be a whole number from 1.');
  const files = r.files || {}, asks = r.asks || {};
  for (const [k, f] of Object.entries(files)) {
    if (!f.words) say(`the files "${k}" are not described.`);
    for (const t of [].concat(f.types || [])) if (!Object.hasOwn(TYPES, t)) say(`the files "${k}" have an unknown type "${t}".`);
  }
  for (const [k, q] of Object.entries(asks)) {
    if (!q.question) say(`the question "${k}" has no words.`);
    if (!KINDS.includes(q.kind)) say(`the question "${k}" is of no known kind (${KINDS.join(', ')}).`);
    if (q.kind === 'choice' && !(Array.isArray(q.choices) && q.choices.length)) say(`the question "${k}" has no choices.`);
  }
  if (!Array.isArray(r.steps) || !r.steps.length) say('it has no steps.');
  const seen = new Map();
  for (const s of r.steps) {
    if (typeof s.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(s.id)) say(`a step's id "${s.id}" is not lower-case words joined by hyphens.`);
    if (seen.has(s.id)) say(`two steps are called "${s.id}".`);
    const op = OPERATIONS[s.op];
    if (!op) say(`the step "${s.id}" names an operation that does not exist, "${s.op}".`);
    if (s.when !== undefined) {
      const q = String(s.when).replace(/^!/, '');
      if (asks[q]?.kind !== 'yes-no') say(`the step "${s.id}" runs when "${q}", which is not a yes-or-no question it asks.`);
    }
    const from = s.from || {};
    for (const slot of Object.keys(from)) if (!Object.hasOwn(op.takes, slot)) say(`the step "${s.id}" gives ${op.title} an input "${slot}" that it does not take.`);
    for (const [slot, take] of Object.entries(op.takes)) {
      if (from[slot] === undefined) { if (!take.optional) say(`the step "${s.id}" does not say where ${op.title} takes its "${slot}" from.`); continue; }
      const alts = alternatives(from[slot]);
      let sure = false;
      for (const a of alts) {
        let type, conditional;
        if (a.startsWith('$')) {
          const f = files[a.slice(1)];
          if (!f) say(`the step "${s.id}" takes "${slot}" from "${a}", which are not files the recipe asks for.`);
          type = [].concat(f.types || ['files']); conditional = !!f.optional;
        } else {
          const [id, out] = a.split('.');
          const p = seen.get(id);
          if (!p) say(`the step "${s.id}" takes "${slot}" from "${a}", but no earlier step is called "${id}": every input must be produced before it is used.`);
          const given = OPERATIONS[p.op].gives[out];
          if (!given) say(`the step "${s.id}" takes "${slot}" from "${a}", but ${OPERATIONS[p.op].title} gives no "${out}".`);
          type = [given]; conditional = p.when !== undefined && p.when !== s.when;
        }
        const wrong = type.filter((t) => !take.types.includes(t));
        if (wrong.length) say(`the step "${s.id}" hands ${typeWords(wrong)} ("${a}") to ${op.title} as "${slot}", which takes ${typeWords(take.types)}.`);
        if (!conditional) sure = true;
      }
      if (!sure && !take.optional) say(`the step "${s.id}" takes "${slot}" only from a step that may be skipped (${alts.join(', ')}), so it may be used before it is produced.`);
    }
    for (const [k, v] of Object.entries(s.options || {}))
      if (typeof v === 'string' && v.startsWith('$') && !Object.hasOwn(asks, v.slice(1))) say(`the step "${s.id}" sets "${k}" from the answer "${v}", a question it does not ask.`);
    seen.set(s.id, s);
  }
  return recipe;
}

/** The recipe as text with its keys in order, so that the digest does not depend on how it was written. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The recipe's SHA-256, over every word of it: a workflow record names the recipe it followed by this. */
export const digest = (recipe) => sha256(canonical({ ...recipe, digest: undefined }));
