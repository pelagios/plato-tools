// Krisis: the typeahead of the lookup panel's language field (#lookup-lang), a small combobox in the
// manner of WAI-ARIA's "list autocomplete" (the field stays a text field, and what is typed is kept
// unless a suggestion is chosen). A native <datalist> was not used: its options cannot show the code as
// code, and each browser matches them its own way. The suggestions are src/lib/languages.js's, matched
// by code and by name (matchLanguages); each is shown as "<code>ang</code> · Old English".
// The keys: Up and Down move through them (opening the list), Home and End go to the first and the last
// while it is open, Enter or a click chooses, Escape closes the list, or, closed, empties the field. The
// pointer moves the active suggestion as it does the keys. How many are offered is said, politely, in a
// visually hidden live region. Choosing puts the code in the field and sends it an input event, so that
// whatever listens to the field (the check of the code, the preview) hears it as typed.
import { matchLanguages } from '../lib/languages.js';
import { lookupPage as LW } from '../engine/words.js';

/** Make `input` a combobox suggesting language codes; `onClose` is called whenever its list closes. Returns { close }. */
export function languageCombobox(input, { limit = 10, onClose = () => {} } = {}) {
  const doc = input.ownerDocument;
  const list = doc.createElement('ul');
  list.id = `${input.id}-options`;
  list.className = 'lang-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', LW.langList);
  list.hidden = true;
  const said = doc.createElement('span');
  said.id = `${input.id}-offered`;
  said.className = 'visually-hidden';
  said.setAttribute('role', 'status');
  said.setAttribute('aria-live', 'polite');
  input.after(list, said);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  let shown = [], active = -1;

  const optionId = (i) => `${list.id}-${i}`;
  function setActive(i, scroll = true) {
    active = i;
    [...list.children].forEach((li, j) => li.setAttribute('aria-selected', j === i ? 'true' : 'false'));
    if (i < 0) input.removeAttribute('aria-activedescendant');
    else { input.setAttribute('aria-activedescendant', optionId(i)); if (scroll) list.children[i].scrollIntoView({ block: 'nearest' }); }
  }
  function close() {
    const was = !list.hidden;
    list.hidden = true; shown = []; list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
    if (was) onClose();
  }
  function open(text) {
    shown = matchLanguages(text, { limit });
    // Said whenever what is typed is looked up: how many are offered, or none (nothing for an empty field).
    said.textContent = String(text ?? '').trim() ? LW.langOffered(shown.length) : '';
    if (!shown.length) return close();
    list.replaceChildren(...shown.map((l, i) => {
      const li = doc.createElement('li'), code = doc.createElement('code');
      li.id = optionId(i); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
      li.dataset.code = l.code;
      code.className = 'code-chip'; code.textContent = l.code;
      li.append(code, ` · ${l.name}`);
      return li;
    }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  }
  function choose(i) {
    const l = shown[i];
    if (!l) return;
    input.value = l.code;
    close();
    said.textContent = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  input.addEventListener('input', (e) => { if (e.isTrusted) open(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    const n = shown.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden) { open(input.value || ''); if (list.hidden) return; }
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1, m = shown.length;
      setActive(active < 0 ? (step > 0 ? 0 : m - 1) : (active + step + m) % m);
    } else if ((e.key === 'Home' || e.key === 'End') && !list.hidden && n) {
      e.preventDefault(); setActive(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
      e.preventDefault(); choose(active);
    } else if (e.key === 'Escape') {
      if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (input.value) {
        // Closed: Escape empties the field, heard as typed (the check of the code and the preview follow).
        e.preventDefault(); e.stopPropagation();
        input.value = ''; said.textContent = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
  // A click chooses; mousedown keeps the focus in the field, so the list is not closed under the click.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('li[role=option]');
    if (li) { const i = [...list.children].indexOf(li); if (i !== active) setActive(i, false); }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[role=option]');
    if (li) { choose([...list.children].indexOf(li)); input.focus(); }
  });
  input.addEventListener('blur', () => close());
  return { close };
}
