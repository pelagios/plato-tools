// Chora's hard block. This runs as the FIRST script in chora.html's <head>: vite.config.js puts it
// there inline (scripts/vite-chora-csp.mjs), before anything on the page is requested. It writes a
// Content Security Policy in a <meta> tag that lets the page, and every worker made from a blob:
// (the historical maps' tile workers among them), connect to this site and to the sites the user has
// agreed to in this browser, and to no other. CSP Level 3 checks each hop of a redirect, and a blob:
// worker takes the policy of the page that made it, so a map server that answers a tile with a
// redirect elsewhere is stopped by the browser itself. Nothing in the page's own code has to see it.
//
// The policy cannot be widened once the page is running, so a site agreed to afterwards is in it only
// from the next load: Chora reloads the page once for each set of sites agreed to (src/chora/consent.js).
//
// A CLASSIC script with no imports, since it must run while the <head> is still being read. The
// consents are read from localStorage exactly as src/chora/consent.js keeps them: 'chora-consent', a
// list of {origin, kind}; and the list of origins 'chora-basemap-consent' kept before there were
// other kinds. An origin is used only if it is a plain http(s) origin in lower case, so nothing kept
// in storage can add a directive or a wildcard. Storage that cannot be read gives the policy of
// nothing agreed to. What was written is published on window.__choraCsp: {policy, origins}.
(function () {
  'use strict';
  var ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;
  function read(key) {
    try { var v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  var origins = [];
  function add(o) { if (typeof o === 'string' && ORIGIN.test(o) && origins.indexOf(o) < 0) origins.push(o); }
  read('chora-consent').forEach(function (c) { if (c && typeof c === 'object') add(c.origin); });
  read('chora-basemap-consent').forEach(add);
  var sites = origins.length ? ' ' + origins.join(' ') : '';
  var policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:" + sites,
    "connect-src 'self' data: blob:" + sites,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  var meta = document.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', policy);
  document.head.prepend(meta);
  window.__choraCsp = { policy: policy, origins: origins };
})();
