// Krisis × Methodos (#28): a note half-typed in the review is kept when the place is drawn again (a flag,
// a row state, a lookup's batch), as the find query and the basis are (src/lib/typed-notes.js). The
// page's elements are stood in for by plain objects with the few properties the two functions read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepNotes, restoreNotes } from '../src/lib/typed-notes.js';

function draw(notes) {
  const inputs = Object.entries(notes).map(([id, saved]) => ({
    value: saved, defaultValue: saved, selectionStart: 0, selectionEnd: 0, form: { dataset: { id } }, focused: false,
    focus() { box.active = this; }, setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
  }));
  const box = { active: null, inputs, querySelectorAll: (sel) => (sel === 'form.note input[name="note"]' ? inputs : []) };
  return box;
}
const byId = (box, id) => box.inputs.find((i) => i.form.dataset.id === id);

test('a note typed but not saved is drawn again with its text, the cursor and the focus; one not typed in is drawn as saved', () => {
  const before = draw({ c1: '', c2: 'saved' });
  const typing = byId(before, 'c1');
  typing.value = 'check the par'; typing.selectionStart = typing.selectionEnd = 13; typing.focus();
  const kept = keepNotes(before, before.active);
  const after = draw({ c1: '', c2: 'saved' });   // render() draws every note from the work file again
  assert.equal(byId(after, 'c1').value, '', 'control: drawn again, the typing is gone');
  restoreNotes(after, kept);
  assert.equal(byId(after, 'c1').value, 'check the par', 'the half-typed note is back');
  assert.equal(after.active, byId(after, 'c1'), 'with the focus');
  assert.deepEqual([byId(after, 'c1').selectionStart, byId(after, 'c1').selectionEnd], [13, 13], 'and the cursor where it was');
  assert.equal(byId(after, 'c2').value, 'saved', 'a note not typed in is as saved');
  // Typed without the focus (the Flag button pressed before the note was kept): kept, the focus not moved.
  const b2 = draw({ c1: '' }); byId(b2, 'c1').value = 'later';
  const a2 = draw({ c1: '' }); restoreNotes(a2, keepNotes(b2, null));
  assert.deepEqual([byId(a2, 'c1').value, a2.active], ['later', null]);
  // A candidate not drawn again (another place): nothing is put anywhere else.
  const a3 = draw({ c9: '' }); restoreNotes(a3, kept);
  assert.equal(byId(a3, 'c9').value, '');
});
