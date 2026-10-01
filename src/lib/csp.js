// The page's side of the hard block (the policy itself is written by the first script in the <head>
// of index.html and chora.html, src/lib/csp-head.js, and published on window.__platoCsp).
//
// - canary(): proof, at startup, that the policy is enforced where it matters: a worker made from a
//   blob: (as MapLibre's is) asks for https://canary.invalid/, and the policy must stop it, raising a
//   securitypolicyviolation in that worker. Anything else (no policy written, no violation, a worker
//   that cannot start, no answer in time) counts as NOT enforced, and src/lib/permissions.js then
//   asks no other site at all (it fails closed). Measured 2026-10-01 on Chora's branch: Chromium 147
//   and Firefox (Playwright's build 1538) raise it in the worker; WebKit (Playwright's build 2336)
//   enforces the policy but raises no event, so there no other site is asked.
// - blobWorkerUrl(url): a blob: address for a module worker that imports `url`. A worker made from
//   a same-origin address takes its policy from its own response, not from the page's <meta>; one made
//   from a blob: takes the page's. MapLibre's worker is made this way, so its requests are under the
//   policy too.
// - inPolicy(origin): whether the policy in force lets the page reach that site. A permission allowed
//   since the page loaded is not in it until the next load.
const CANARY = 'https://canary.invalid/';

/** The policy written at load ({policy, origins}), or null when there is none (the block is missing). */
export const policy = () => (typeof window !== 'undefined' && window.__platoCsp) || globalThis.__platoCsp || null;
/** Whether the policy in force lets the page connect to `origin`. */
export const inPolicy = (origin) => !!policy()?.origins?.includes(origin);

/** Resolves {enforced: true, directive} or {enforced: false, why}. Never rejects. */
export function canary({ timeout = 5000, settle = 1000 } = {}) {
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
    // Nothing on the page but the test worker ever asks canary.invalid (a name that cannot exist); a
    // browser may report only the site of what it blocked, so the site is what is matched.
    const ours = (u) => String(u || '').startsWith(CANARY.slice(0, -1));
    const code = `self.addEventListener('securitypolicyviolation', (e) => postMessage({ violated: String(e.blockedURI || ''), directive: e.effectiveDirective }));
fetch(${JSON.stringify(CANARY)}).then(() => postMessage({ fetched: true }), () => postMessage({ failed: true }));`;
    try {
      url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (e) { finish({ enforced: false, why: `the test worker could not start (${e?.message || e})` }); return; }
    worker.onmessage = ({ data }) => {
      if (ours(data?.violated)) finish({ enforced: true, directive: data.directive });
      else if (data?.fetched) finish({ enforced: false, why: 'the test request was not stopped' });
      // The violation may be reported just after the request fails: it is waited for, a little.
      else if (data?.failed) setTimeout(() => finish({ enforced: false, why: 'the test request failed, but not because the policy stopped it' }), settle);
    };
    worker.onerror = () => finish({ enforced: false, why: 'the test worker could not run' });
  });
}

/** A blob: address of a module worker that imports the worker at `url` (made absolute against the page). */
export function blobWorkerUrl(url) {
  const abs = new URL(url, location.href).href;
  return URL.createObjectURL(new Blob([`import ${JSON.stringify(abs)};`], { type: 'text/javascript' }));
}
