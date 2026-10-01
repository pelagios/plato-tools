// The hard block. scripts/vite-csp.mjs puts this, after the pure core of the permissions
// (src/lib/permissions-core.js, its `export`s removed), inline as the FIRST script in the <head> of
// index.html and chora.html, before anything on the page is requested. It writes a Content Security
// Policy in a <meta> tag that lets the page, and every worker it makes from a blob: (MapLibre's among
// them), connect to and show images from this site and the sites of the permissions allowed in this
// browser, and no other. CSP Level 3 checks each hop of a redirect, so a server that answers with a
// redirect elsewhere is stopped by the browser itself.
//
// The policy cannot be widened once the page is running, so a permission allowed afterwards takes
// effect from the next load (src/lib/permissions.js offers the reload). It CAN be narrowed in code: a
// permission withdrawn is refused at once by the module's fetch and transformRequest.
//
// A CLASSIC script, since it must run while the <head> is still being read; it reads storage as
// src/lib/permissions.js keeps it ('plato-tools.permissions' in localStorage, the tab's own in
// sessionStorage) and carries Chora's old basemap consents over once, as the module would. Every site
// passes the core's strict origin rule twice (normalise, then policyFor). Storage that cannot be read
// gives the policy of nothing allowed: it fails closed. What was written is published on
// window.__platoCsp: {policy, origins}.
var origins = [];
try {
  var read = function (store, key) { try { return JSON.parse(store.getItem(key)); } catch (e) { return null; } };
  var kept = read(localStorage, 'plato-tools.permissions') || {};
  var grants = normalise(kept.grants);
  var legacy = null;
  try { legacy = localStorage.getItem('chora-basemap-consent'); } catch (e) { legacy = null; }
  if (legacy !== null) {
    grants = normalise(migrateBasemapConsent(grants, read(localStorage, 'chora-basemap-consent')));
    try {
      localStorage.setItem('plato-tools.permissions', JSON.stringify({ version: 1, grants: grants }));
      localStorage.removeItem('chora-basemap-consent');
    } catch (e) { /* kept as it was: carried over again next time */ }
  }
  var tab = read(sessionStorage, 'plato-tools.permissions.tab');
  origins = allowedOrigins(grants, Array.isArray(tab) ? tab.filter(function (k) { return typeof k === 'string'; }) : []);
} catch (e) { origins = []; }
var policy = policyFor(origins);
var meta = document.createElement('meta');
meta.setAttribute('http-equiv', 'Content-Security-Policy');
meta.setAttribute('content', policy);
document.head.prepend(meta);
window.__platoCsp = { policy: policy, origins: origins.filter(isOrigin) };
