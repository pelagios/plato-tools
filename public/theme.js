// The colour theme of both pages (index.html, chora.html): Auto, which follows the device's setting
// (prefers-color-scheme), Light or Dark, chosen in the header (#theme-switch, a group of three radio
// buttons) and remembered by this browser (localStorage, 'plato-tools.theme' = 'light' | 'dark';
// nothing for Auto). A classic script loaded from <head>, before the stylesheet, so that it runs before
// the page is first painted and a chosen theme never flashes the other; served from this site, not
// inline, so that a Content-Security-Policy of script-src 'self' allows it. It only sets
// data-theme="light|dark" on <html>, or removes it for Auto (styles.css chooses the colours by it);
// once the page is parsed, it keeps the radio buttons in step and handles them. A choice made in
// another tab of this site is taken up here too (the storage event).
// Storage may be refused (a private window, blocked site data): the page then starts in Auto, and a
// choice still applies for as long as the page is open.
(function () {
  var KEY = 'plato-tools.theme', root = document.documentElement, current = 'auto';
  var valid = function (v) { return v === 'light' || v === 'dark' ? v : 'auto'; };
  try { current = valid(localStorage.getItem(KEY)); } catch (e) { /* storage refused: Auto */ }
  function sync() {
    var inputs = document.querySelectorAll('#theme-switch input[name="plato-theme"]');
    for (var i = 0; i < inputs.length; i++) inputs[i].checked = inputs[i].value === current;
  }
  function apply(theme) {
    current = valid(theme);
    if (current === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', current);
    sync();
  }
  apply(current);
  function start() {
    sync();
    var group = document.getElementById('theme-switch');
    if (!group) return;
    group.addEventListener('change', function (e) {
      var input = e.target;
      if (!input || input.name !== 'plato-theme' || !input.checked) return;
      apply(input.value);
      try { if (current === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, current); } catch (e2) { /* not remembered */ }
    });
  }
  // Another tab of this site chose a theme (or cleared it, for Auto).
  window.addEventListener('storage', function (e) {
    if (e.key === KEY || e.key === null) { var v = null; try { v = localStorage.getItem(KEY); } catch (e2) { /* refused */ } apply(v); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
