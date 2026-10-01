// The page's side of the hard block (the policy itself is written by the first script in the <head>
// of index.html and chora.html, src/lib/csp-head.js, and published on window.__platoCsp).
//
// - canary(): proof, at startup, of two things, and only both count as enforced.
//   1. That a policy is enforced at all in a worker made from a blob: (as MapLibre's is): the worker
//      fetches a data: address, which nothing but a policy can refuse (connect-src does not list
//      data:), and, as the control, a blob: address of its own, which the policy allows. No network
//      is involved. This replaced waiting for a securitypolicyviolation event, which WebKit never
//      raises. It proves enforcement, NOT what the policy allows: a policy widened to `*` also
//      refuses data:.
//   2. That the policy in force is the one written from the permissions (checkPolicy): exactly one
//      Content Security Policy <meta>, its text exactly policyFor() of the sites published with it,
//      each a plain site, and connect-src and img-src made of nothing but 'self', blob:, data: (images
//      only) and those sites. A policy changed or added by anything else fails it.
//   Anything else (no policy written, the data: fetched, the control refused, a policy not the one
//   written, a worker that cannot start, no answer in time) counts as NOT enforced, and
//   src/lib/permissions.js then asks no other site at all (it fails closed). Measured 2026-10-01
//   (Playwright 1.62: Chromium 151, Firefox 153, WebKit 26.5; scripts/canary-engines.mjs): with the
//   policy, all three refuse the data: fetch and fetch the blob:; without it, all three fetch both.
// - blobWorkerUrl(url): a blob: address for a module worker that imports `url`. A worker made from
//   a same-origin address takes its policy from its own response, not from the page's <meta>; one made
//   from a blob: takes the page's. MapLibre's worker is made this way, so its requests are under the
//   policy too.
// - inPolicy(origin): whether the policy in force lets the page reach that site. A permission allowed
//   since the page loaded is not in it until the next load.

import { policyFor, isOrigin } from './permissions-core.js';

/** The policy written at load ({policy, origins}), or null when there is none (the block is missing). */
export const policy = () => (typeof window !== 'undefined' && window.__platoCsp) || globalThis.__platoCsp || null;
/** Whether the policy in force lets the page connect to `origin`. */
export const inPolicy = (origin) => !!policy()?.origins?.includes(origin);

const ALLOWED_SOURCES = { 'connect-src': ["'self'", 'blob:'], 'img-src': ["'self'", 'data:', 'blob:'] };
/**
 * Whether the policy in force in `doc` is exactly the one written from the permissions: {ok: true} or
 * {ok: false, why}. Reads the <meta> itself, not only what was published beside it.
 */
export function checkPolicy(doc = globalThis.document, written = policy()) {
  if (!written) return { ok: false, why: 'no policy was written' };
  const metas = [...(doc?.querySelectorAll('meta[http-equiv]') || [])].filter((m) => m.getAttribute('http-equiv').toLowerCase() === 'content-security-policy');
  if (metas.length !== 1) return { ok: false, why: `the page has ${metas.length} policies, not the one written` };
  const origins = Array.isArray(written.origins) ? written.origins : [];
  if (!origins.every(isOrigin)) return { ok: false, why: 'the policy names something that is not a plain site' };
  const text = metas[0].getAttribute('content') || '';
  if (text !== policyFor(origins) || text !== written.policy) return { ok: false, why: 'the policy in force is not the one written from the permissions' };
  for (const part of text.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!ALLOWED_SOURCES[name]) continue;
    const bad = sources.filter((x) => !ALLOWED_SOURCES[name].includes(x) && !origins.includes(x));
    if (bad.length) return { ok: false, why: `${name} allows more than the permissions do` };
  }
  return { ok: true };
}

/** Resolves {enforced: true} or {enforced: false, why}. Never rejects. */
export function canary({ timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!policy()) { resolve({ enforced: false, why: 'no policy was written' }); return; }
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') { resolve({ enforced: false, why: 'there are no workers here' }); return; }
    let worker = null, url = null, done = false, timer = null;
    const finish = (r) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { worker?.terminate(); } catch {}
      if (url) URL.revokeObjectURL(url);
      resolve(r);
    };
    timer = setTimeout(() => finish({ enforced: false, why: 'no answer from the test worker' }), timeout);
    const code = `const t = (p) => p.then(() => true, () => false);
(async () => {
  const data = await t(fetch('data:text/plain,canary'));
  const own = URL.createObjectURL(new Blob(['control']));
  const blob = await t(fetch(own));
  postMessage({ data, blob });
})();`;
    try {
      url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (e) { finish({ enforced: false, why: `the test worker could not start (${e?.message || e})` }); return; }
    worker.onmessage = ({ data }) => {
      if (data?.data === false && data?.blob === true) {
        const c = checkPolicy();
        finish(c.ok ? { enforced: true } : { enforced: false, why: c.why });
      }
      else if (data?.data) finish({ enforced: false, why: 'the test request was not stopped' });
      else finish({ enforced: false, why: 'the test worker could fetch nothing, so the test proves nothing' });
    };
    worker.onerror = () => finish({ enforced: false, why: 'the test worker could not run' });
  });
}

/** A blob: address of a module worker that imports the worker at `url` (made absolute against the page). */
export function blobWorkerUrl(url) {
  const abs = new URL(url, location.href).href;
  return URL.createObjectURL(new Blob([`import ${JSON.stringify(abs)};`], { type: 'text/javascript' }));
}
