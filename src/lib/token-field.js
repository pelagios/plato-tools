// The World Historical Gazetteer token's field, as the main page's lookup panel (src/app.js) and Chora's
// adopt panel (src/chora/adopt-ui.js) both show it (Issue #33). Drawn from the token's one keeper
// (permissions.token), which says whether there is a token and whether it is remembered, never what it
// is: the field is always empty once a token is given (the token is never put back into the page), with a
// masked placeholder and where it is kept beside it. "Remember my token" while it is not remembered,
// "Forget the token" only while there is one. Forgetting needs no confirmation and says nothing: the empty
// field says it, and that forgetting does not revoke a token is the field's static help.
import { TOKEN_FIELD as TF } from '../engine/words.js';

/** What the field shows for the keeper's token now: { has, kept, placeholder, state, remember, forget }. */
export function tokenView(token) {
  const has = token.get() !== null, kept = has && token.remembered();
  return { has, kept, placeholder: has ? TF.mask : TF.placeholder, state: has ? (kept ? TF.remembered : TF.forTab) : '', remember: !kept, forget: has };
}

/** Give the keeper what is typed in `field` (for the tab, or as the keeper's choice to remember stands), and empty the field. */
export function giveToken(token, field) {
  // Emptied first: the keeper's onChange, which may draw the panel again (Chora's keeps what is half typed in
  // the field), runs within set(), and must find the field empty. The token is kept by its keeper only.
  const typed = field.value;
  field.value = '';
  if (typed.trim()) token.set(typed);
}

/** "Remember my token": the token typed, or the one kept for the tab, is kept in this browser too. */
export function rememberToken(token, field) {
  if (!field.value.trim() && token.get() === null) return false;
  // As giveToken, the field is emptied before the keeper is told anything (remember() draws Chora's panel again too).
  const typed = field.value;
  field.value = '';
  token.remember(true);
  if (typed.trim()) token.set(typed);
  return true;
}

/** "Forget the token": the shared lookup sends none from its next request, and the keeper forgets it and the choice to remember it. */
export function forgetToken(token, lookup, field) {
  if (field) field.value = '';
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
    <span class="token-row"><input id="${id}" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(v.placeholder)}" aria-describedby="${id}-state ${id}-help">
    <button type="button" id="${id}-remember"${v.remember ? '' : ' hidden'}>${esc(TF.remember)}</button>
    <button type="button" id="${id}-forget"${v.forget ? '' : ' hidden'}>${esc(TF.forget)}</button>
    <span id="${id}-state" class="token-state" role="status">${esc(v.state)}</span></span>
    <small id="${id}-help" class="token-help">${esc(TF.help)}</small>`;
}
