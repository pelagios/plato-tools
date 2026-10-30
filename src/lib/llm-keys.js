// The keys of language-model services, kept in this tab's memory and nowhere else: not localStorage,
// sessionStorage, IndexedDB, OPFS, a cookie, a file the tools write, or an address. A key that opens
// a billing account is not the WHG token (permissions.js, token): that one may be remembered, this one
// never is, and a reload or a closed tab forgets it.
//
// A key is bound to the site it was typed for. It is given out only for an address on that site
// (keyFor), so a request to any other cannot be built with it; the one way to ask for a key names where
// it is to go. The keeper lists what it holds without the keys (held), and says nothing of a key's
// length or any part of it. `secrets()` is for the one caller that must search for them, a project file
// that must not hold one, and for redaction.
import * as core from './permissions-core.js';
import { nameOf } from './permission-words.js';

// Printable ASCII, no space: what a key is, and what can be put in a header without breaking it.
const KEY_SHAPE = /^[\x21-\x7e]{8,}$/;

/**
 * A keeper. `onChange(heldCount)` is called after each change. The keys are in this closure, in a Map
 * nothing else can reach: not on the returned object, which JSON turns into `{}`.
 */
export function createKeyKeeper({ onChange } = {}) {
  const held = new Map();   // 'llm:subj' -> { key, origins, at }
  const changed = () => { try { onChange?.(held.size); } catch (e) { console.warn('Permissions: a listener failed', e); } };
  const need = (subj) => {
    const p = core.parse('llm', subj);
    if (!p) throw new TypeError(`${JSON.stringify(subj)} is not a language-model service: a service known by name (anthropic) or a site such as https://llm.example.org or http://localhost:11434`);
    return p;
  };
  const keeper = {
    /** Keep a key (trimmed) for a service; an empty one is forget(). A key of other than printable characters is refused. */
    set(subj, key) {
      const p = need(subj), v = typeof key === 'string' ? key.trim() : '';
      if (!v) return keeper.forget(subj);
      if (!KEY_SHAPE.test(v)) throw new TypeError('That is not a key: a key is at least 8 letters, digits or signs, with no space or line break.');
      held.set(core.keyOf(p.cat, p.subj), { key: v, origins: core.originsFor(p.cat, p.subj), at: new Date().toISOString() });
      changed();
    },
    has(subj) { const p = core.parse('llm', subj); return !!p && held.has(core.keyOf(p.cat, p.subj)); },
    /** The key for a service, for a request to `url`: only if `url` is on a site the key was typed for, else null. */
    keyFor(subj, url) {
      const p = core.parse('llm', subj), h = p ? held.get(core.keyOf(p.cat, p.subj)) : null, o = core.originOf(url);
      return h && o && h.origins.includes(o) ? h.key : null;
    },
    /** What is held, without the keys: [{ key ('llm:subj'), subj, name, origins, at }]. */
    held() {
      return [...held].map(([k, h]) => { const p = core.parse(k); return { key: k, subj: p.subj, name: nameOf('llm', p.subj), origins: h.origins.slice(), at: h.at }; })
        .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
    },
    /** Every key held: for a search of a project for what it must not hold, and for redaction. Nothing else asks. */
    secrets() { return [...held.values()].map((h) => h.key); },
    forget(subj) { const p = core.parse('llm', subj); if (p && held.delete(core.keyOf(p.cat, p.subj))) changed(); },
    forgetAll() { if (held.size) { held.clear(); changed(); } },
  };
  return Object.freeze(keeper);
}
