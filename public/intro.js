// The introduction on the main page (index.html, #intro): the opening paragraph and the drawing of
// Plato, which a reader can hide, and which stays hidden on their next visit (localStorage,
// 'plato-tools.intro' = 'hidden'). A classic script loaded from <head>, so that it runs before the
// page is first painted and a hidden introduction never flashes; served from this site, not inline,
// so that a Content-Security-Policy of script-src 'self' allows it. It only sets a class on <html>
// (styles.css hides #intro and swaps the button's words by it); once the page is parsed, it keeps
// #intro's hidden and the button's aria-expanded in step, and handles the button.
// Storage may be refused (a private window, blocked site data): the introduction is then shown, and
// the button still hides it for as long as the page is open.
(function () {
  var KEY = 'plato-tools.intro', CLASS = 'intro-hidden', root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { /* storage refused: shown */ }
  if (stored === 'hidden') root.classList.add(CLASS);
  function sync() {
    var intro = document.getElementById('intro'), button = document.getElementById('intro-toggle');
    if (!intro || !button) return;
    var hidden = root.classList.contains(CLASS);
    intro.hidden = hidden;
    button.setAttribute('aria-expanded', String(!hidden));
  }
  function start() {
    sync();
    var button = document.getElementById('intro-toggle');
    if (!button) return;
    button.addEventListener('click', function () {
      var hide = !root.classList.contains(CLASS);
      root.classList.toggle(CLASS, hide);
      sync();
      try { if (hide) localStorage.setItem(KEY, 'hidden'); else localStorage.removeItem(KEY); } catch (e) { /* not remembered */ }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
