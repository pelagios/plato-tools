// Which keys are the proposal's (tracing with assistance, src/chora/ink.js): Enter accepts it and Esc lets
// it go, but only where nothing else on the page has a use for the key. Enter on a button, a link, a select,
// a summary, any field, or anything in a dialog is that control's (Save must save); Esc in a dialog is the
// dialog's to close. Kept apart from ink.js, reading only tag names, attributes and parents, so that it can
// be tested without a browser.

const CONTROLS = new Set(['BUTTON', 'SELECT', 'SUMMARY', 'INPUT', 'TEXTAREA', 'DIALOG', 'OPTION']);
const attr = (n, k) => (n.getAttribute ? n.getAttribute(k) : null);
const isDialog = (n) => n.tagName === 'DIALOG' || ['dialog', 'alertdialog'].includes(attr(n, 'role'));
const isControl = (n) => CONTROLS.has(n.tagName) || (n.tagName === 'A' && n.hasAttribute?.('href'))
  || n.isContentEditable || n.hasAttribute?.('contenteditable') || isDialog(n)
  || ['button', 'link', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'tab', 'combobox', 'textbox', 'slider'].includes(attr(n, 'role'));
const isTyping = (t) => t.tagName === 'TEXTAREA' || t.isContentEditable
  || (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(t.type));
/** `el` or the nearest of its parents for which `pred` holds, else null. */
function closest(el, pred) { for (let n = el; n; n = n.parentElement) if (pred(n)) return n; return null; }

/**
 * What a keydown `e` does to the proposal: { action: 'accept' | 'discard' | null, prevent } (whether its
 * default is to be prevented). `panel` is the ink panel, `mapContainer` the map's; `mode` the tracing mode
 * (or null), `proposal` whether there is one (being traced or proposed), `proposed` whether it has a shape to
 * accept, `dialogOpen` whether a modal dialog is open (the focus then belongs to it, wherever it is).
 */
export function keyAction(e, { panel, mapContainer, mode, proposal, proposed, dialogOpen = false }) {
  const none = { action: null, prevent: false };
  if ((!mode && !proposal) || (e.key !== 'Enter' && e.key !== 'Escape') || e.isComposing) return none;
  const t = e.target && e.target.nodeType === 1 ? e.target : null;   // the document itself: no element
  if (dialogOpen || (t && closest(t, isDialog))) return none;
  if (t && isTyping(t)) return none;
  if (e.key === 'Escape') return { action: 'discard', prevent: !!proposal };
  if (!proposed) return none;
  if (t && closest(t, isControl)) return none;
  // The map, the page itself (nothing focused), or the ink panel's own text: the key is the proposal's.
  const ours = !t || t.tagName === 'BODY' || t.tagName === 'HTML'
    || (mapContainer && closest(t, (n) => n === mapContainer)) || (panel && closest(t, (n) => n === panel));
  return ours ? { action: 'accept', prevent: true } : none;
}
