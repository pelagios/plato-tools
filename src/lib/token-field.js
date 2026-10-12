// The World Historical Gazetteer token's field, as the main page's lookup panel (src/app.js) and Chora's
// adopt panel (src/chora/adopt-ui.js) both show it (Issue #33). Drawn from the token's one keeper
// (permissions.token), which says whether there is a token and where it is kept (scope()), never what it
// is: the field is always empty once a token is given (the token is never put back into the page), with a
// masked placeholder and where it is kept beside it. "Remember my token" while it is not remembered,
// "Forget the token" only while there is one. Forgetting needs no confirmation and says nothing: the empty
// field says it, and that forgetting does not revoke a token is the field's static help.
//
// A password field invites the browser's password manager, which `autocomplete="new-password"` (and no
// <form> to submit) discourages but cannot forbid: a password the browser saved for any pelagios.org site
// could be filled into it. So only what was typed or pasted into the field is taken (noteInput, called
// on every input event of the field): a value that arrives any other way (an autofill's input event has
// no inputType, or insertReplacementText) marks the field untyped, and is emptied, never sent.
import { TOKEN_FIELD as TF } from '../engine/words.js';

const TYPED = new Set(['insertText', 'insertFromPaste', 'insertFromDrop', 'insertCompositionText', 'insertLineBreak']);

/**
 * Called with each input event of a token field (delegated by the page). Typing or pasting marks the field
 * typed, and a deletion keeps what was so (an emptied field is untyped again); anything else (autofill) is
 * emptied and marked untyped.
 */
export function noteInput(e) {
  const f = e.target;
  if (TYPED.has(e.inputType)) f.dataset.typed = 'yes';
  else if (typeof e.inputType === 'string' && e.inputType.startsWith('delete')) { if (!f.value) delete f.dataset.typed; }
  else { f.value = ''; delete f.dataset.typed; }
}

/** What was typed or pasted in the field, or '' (a value that arrived otherwise is never taken). */
const typedIn = (field) => (field.dataset?.typed === 'yes' ? field.value : '');
/** Empty the field and forget whether it was typed in. */
const clear = (field) => { field.value = ''; if (field.dataset) delete field.dataset.typed; };

/** What the field shows for the keeper's token now: { has, kept, placeholder, state, remember, forget }. */
export function tokenView(token) {
  const scope = token.scope(), has = scope !== null, kept = scope === 'browser';
  return { has, kept, placeholder: has ? TF.mask : TF.placeholder, state: has ? (kept ? TF.remembered : TF.forTab) : '', remember: !kept, forget: has };
}

/** Give the keeper what was typed in `field` (for the tab, or as the keeper's choice to remember stands), and empty the field. */
export function giveToken(token, field) {
  // Emptied first: the keeper's onChange, which may draw the panel again (Chora's keeps what is half typed in
  // the field), runs within set(), and must find the field empty. The token is kept by its keeper only.
  const typed = typedIn(field);
  clear(field);
  if (typed.trim()) token.set(typed);
}

/** "Remember my token": the token typed, or the one kept for the tab, is kept in this browser too. False when there is neither. */
export function rememberToken(token, field) {
  const typed = typedIn(field);
  clear(field);
  if (!typed.trim() && token.get() === null) return false;
  // As giveToken, the field is emptied before the keeper is told anything (remember() draws Chora's panel again too).
  token.remember(true);
  if (typed.trim()) token.set(typed);
  return true;
}

/** "Forget the token": the shared lookup sends none from its next request, and the keeper forgets it (this tab's and the remembered copy) and the choice to remember it. */
export function forgetToken(token, lookup, field) {
  if (field) clear(field);
  lookup.clearToken();
  token.remember(false);
  token.forget();
}

/** Draw an existing field's state (the main page's markup): its placeholder, its buttons, and the line beside it. */
export function showTokenView(token, { field, remember, forget, state }) {
  const v = tokenView(token);
  field.placeholder = v.placeholder;
  remember.hidden = !v.remember;
  forget.hidden = !v.forget;
  state.textContent = v.state;
  return v;
}

/** The field as HTML (Chora's panel is drawn as a whole), its ids made from `id`: `${id}`, `${id}-remember`, `${id}-forget`, `${id}-state`, `${id}-help`. */
export function tokenFieldHtml(token, id, esc) {
  const v = tokenView(token);
  return `<label for="${id}">${esc(TF.label)}</label>
    <span class="token-row"><input id="${id}" type="password" autocomplete="new-password" spellcheck="false" placeholder="${esc(v.placeholder)}" aria-describedby="${id}-state ${id}-help">
    <button type="button" id="${id}-remember"${v.remember ? '' : ' hidden'}>${esc(TF.remember)}</button>
    <button type="button" id="${id}-forget"${v.forget ? '' : ' hidden'}>${esc(TF.forget)}</button>
    <span id="${id}-state" class="token-state" role="status">${esc(v.state)}</span></span>
    <small id="${id}-help" class="token-help">${esc(TF.help)}</small>`;
}
