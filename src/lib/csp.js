// The page's side of the hard block (the policy itself is written by the first script in the <head>
// of index.html and chora.html, src/lib/csp-head.js, and published on window.__platoCsp).
//
// - canary(): proof, at startup, that the policy is enforced where it matters, in a worker made from a
//   blob: (as MapLibre's is). The worker fetches a data: address, which nothing but a policy can refuse
//   (connect-src does not list data:), and, as the control, a blob: address of its own, which the
//   policy allows: enforced means the first refused and the second fetched. No network is involved.
//   Anything else (no policy written, the data: fetched, the control refused, a worker that cannot
//   start, no answer in time) counts as NOT enforced, and src/lib/permissions.js then asks no other site
//   at all (it fails closed). This replaced waiting for a securitypolicyviolation event, which WebKit
//   never raises. Measured 2026-10-01 (Playwright 1.62: Chromium 151, Firefox 153, WebKit 26.5): with
//   the policy, all three refuse the data: fetch in the worker and fetch the blob:; without it (the
//   spike page), all three fetch both.
// - blobWorkerUrl(url): a blob: address for a module worker that imports `url`. A worker made from
//   a same-origin address takes its policy from its own response, not from the page's <meta>; one made
//   from a blob: takes the page's. MapLibre's worker is made this way, so its requests are under the
//   policy too.
// - inPolicy(origin): whether the policy in force lets the page reach that site. A permission allowed
//   since the page loaded is not in it until the next load.

/** The policy written at load ({policy, origins}), or null when there is none (the block is missing). */
export const policy = () => (typeof window !== 'undefined' && window.__platoCsp) || globalThis.__platoCsp || null;
/** Whether the policy in force lets the page connect to `origin`. */
export const inPolicy = (origin) => !!policy()?.origins?.includes(origin);

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
      if (data?.data === false && data?.blob === true) finish({ enforced: true });
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
