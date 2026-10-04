// Krisis × Methodos (#28): a note half-typed in the review, kept across render(), which draws every
// note again from the work file (a flag, a row state, a lookup's batch). As keepTyped/restoreTyped in
// app.js do for the find query and the basis: the text, the cursor, and whether it had the focus.

const NOTES = 'form.note input[name="note"]';

/**
 * The note inputs under `box` worth keeping: each one whose text is not what was drawn (not yet kept
 * in the work file), or that has the focus (`active`, the page's focused element). Keyed by the
 * candidate's id (its form's data-id).
 */
export function keepNotes(box, active) {
  const out = [];
  for (const el of box?.querySelectorAll(NOTES) || []) {
    const id = el.form?.dataset?.id;
    if (!id || (el.value === el.defaultValue && el !== active)) continue;
    out.push({ id, value: el.value, start: el.selectionStart, end: el.selectionEnd, focused: el === active });
  }
  return out;
}

/** Put kept notes back into the inputs drawn again for the same candidates; one not drawn again is dropped. */
export function restoreNotes(box, kept) {
  if (!kept?.length) return;
  const byId = new Map(kept.map((k) => [k.id, k]));
  for (const el of box?.querySelectorAll(NOTES) || []) {
    const k = byId.get(el.form?.dataset?.id);
    if (!k) continue;
    el.value = k.value;
    if (k.focused) { el.focus({ preventScroll: true }); try { el.setSelectionRange(k.start, k.end); } catch {} }
  }
}
