// Hermes, place names in a text: asking leave to send the text to a language-model service. The page
// plans a send (planSend), shows what the plan says (its words, its estimate, its ceiling), and, when the
// user has agreed, confirms it into the provider that runExtraction is given.
//
// Nothing here owns a permission or a key: the permissions module (src/lib/permissions.js) is GIVEN, as
// the fetch is to an adapter, so that this stays testable and the command line can give its own. What it
// needs of it: state, waitsForReload, allowed, fetch, and llmKeys (src/lib/llm-keys.js).
//
// Three things stand between the text and the service, and any one of them stops a send:
// - the permission for that service (`llm`, a site or anthropic), allowed and in this load's policy;
// - the user's agreement to THIS run (consent.js), with its ceiling;
// - the key, kept in memory for the tab and bound to the site it was typed for: it is looked up by the
//   address it is to go to (llmKeys.keyFor), and guardKey, beneath the permissions module's fetch, refuses
//   a request that carries it to any site but those the keeper says it was typed for (llmKeys.boundTo:
//   not the plan's own idea of where it goes), however the request came to be.
// The provider confirm() gives asks `permitted()` before every part, so a permission withdrawn or a key
// forgotten while a run goes stops it at the next part, with what was done kept.
import * as core from '../../../lib/permissions-core.js';
import { nameOf, REFUSED } from '../../../lib/permission-words.js';
import { anthropic, DEFAULT_EFFORT } from './providers/anthropic.js';
import { openaiCompatible } from './providers/openai-compatible.js';
import { estimateRun } from './prices.js';
import { assessRun, consentWords, giveConsent, limitProvider, ConsentError } from './consent.js';

/** A key was about to be sent to a site it was not typed for. */
export class KeyError extends Error {
  constructor(message, { kind = 'misdirected' } = {}) { super(message); this.name = 'KeyError'; this.kind = kind; }
}

const headerValues = (h) => (!h ? [] : typeof Headers !== 'undefined' && h instanceof Headers ? [...h.values()] : Array.isArray(h) ? h.map((p) => p?.[1]) : Object.values(h));

/**
 * A fetch that refuses, before calling `fetchFn`, any request that carries `key` (in its address, a
 * header or its body) to a site that is not one of `origins`. A request that does not carry the key is
 * none of its business. The message names the site, never the address, which may hold the key.
 */
export function guardKey(fetchFn, key, origins) {
  return async (url, init = {}) => {
    const dest = core.originOf(url);
    if (key && !origins.includes(dest) && [url, init.body, ...headerValues(init.headers)].some((v) => typeof v === 'string' && v.includes(key))) {
      throw new KeyError(`A key was about to be sent to ${dest || 'a site that is not one'}, which it was not typed for, so the request was not made.`);
    }
    return fetchFn(url, init);
  };
}

/**
 * Whether a send to `service` ('anthropic', or a site such as http://localhost:11434) may be made now:
 * { ok, why: null | 'never' | 'undecided' | 'reload' | 'no-key', words }.
 */
export function readiness({ service, permissions }) {
  const p = core.parse('llm', service);
  if (!p) throw new TypeError(`${JSON.stringify(service)} is not a language-model service: anthropic, or a site such as https://llm.example.org or http://localhost:11434`);
  const name = nameOf('llm', p.subj), st = permissions.state('llm', p.subj);
  const no = (why, words) => ({ ok: false, why, words });
  if (st === 'never') return no('never', REFUSED.never(name));
  if (st !== 'allowed') return no('undecided', REFUSED.undecided(name));
  if (permissions.waitsForReload('llm', p.subj)) return no('reload', REFUSED.reload(name));
  if (p.subj === 'anthropic' && !permissions.llmKeys.has(p.subj)) return no('no-key', REFUSED.noKey(name));
  return { ok: true, why: null, words: '' };
}

/**
 * A plan to send `chunks` (chunkText's) to `service` with `model`: shown first, confirmed after.
 * { service, origin, name, estimate, assessment, ready, words, confirm({ confirmedAgain }) }.
 * `confirm()` is the user's agreement to this run: it throws a ConsentError (its `kind` is the
 * readiness's `why`, or over-ceiling, no-price, second-confirmation) unless everything holds, and
 * returns the provider for runExtraction. `ceilingUsd`: the user's, else $2. `adapter`: options for the
 * adapter (effort, thinking, timeoutMs, maxTries, sleep). The plan holds no key.
 */
export function planSend({ service, permissions, model, chunks, ceilingUsd, now, table, adapter = {} }) {
  const p = core.parse('llm', service);
  if (!p) throw new TypeError(`${JSON.stringify(service)} is not a language-model service: anthropic, or a site such as https://llm.example.org or http://localhost:11434`);
  const origin = core.originsFor('llm', p.subj)[0], name = nameOf('llm', p.subj), hosted = p.subj === 'anthropic';
  const provider = hosted ? 'anthropic' : 'openai-compatible';
  const estimate = estimateRun(chunks, { effort: hosted ? (adapter.effort === undefined ? DEFAULT_EFFORT : adapter.effort) : null });
  const assessment = assessRun({ provider, model, origin, estimate, ceilingUsd, now, table });
  return {
    service: p.subj, origin, name, estimate, assessment,
    ready: readiness({ service: p.subj, permissions }),
    words: consentWords({ name, origin, estimate, assessment }),
    confirm({ confirmedAgain = false } = {}) {
      const ready = readiness({ service: p.subj, permissions });
      if (!ready.ok) throw new ConsentError(ready.words, { kind: ready.why });
      const consent = giveConsent({ provider, model, origin, estimate, assessment, confirmedAgain });
      const key = permissions.llmKeys.keyFor(p.subj, origin);
      const fetch = guardKey(permissions.fetch, key, permissions.llmKeys.boundTo(p.subj));
      const built = hosted
        ? anthropic({ ...adapter, key, fetch })
        : openaiCompatible({ ...adapter, base: origin, key, fetch, name });
      const permitted = () => permissions.allowed('llm', p.subj) && (!hosted || permissions.llmKeys.has(p.subj));
      return limitProvider(built, consent, { now: now ?? new Date(), permitted, table });
    },
  };
}
