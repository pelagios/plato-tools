// Methodos's save and resume, as the page (src/methodos/page.js) calls it: a STUB, kept in memory for
// the life of the tab. Its calls are named as phase 2's store's are (branch methodos-save,
// src/methodos/store.js, workflowStore()), so that joining the two changes what is kept, not the calls:
//
//   pageStore() -> {
//     list():         Promise<record[]>                the records kept, newest first;
//     save(record):   Promise<{ record, kept: 'tab' }>  keep it (called at every change of step);
//     remove(id):     Promise<void>                    let it go (the user left the workflow);
//   }
//
// What differs, and is the join's to settle: phase 2 keeps the runner's state (runner.start, which
// needs the user's files as references), while the page keeps its place before any file is chosen,
// since the interview comes first. The page's record (format 1) is plain JSON, never a file:
//   { id, methodos: 1,
//     recipe: { key, version, digest },  the recipe followed (RECIPES[key]);
//     answers: { ... },                  the recipe's answers, as runner.start takes them;
//     at: stepId | null,                 the step the user is at (null: every step is done);
//     done: [stepId, ...] }              the steps the user has said are done, in order.
// The page resumes only a record whose recipe and digest are the ones it ships; phase 2's version rule
// (src/engine/methodos/record.js, reconcile()) replaces that test when the two are joined.
export function pageStore() {
  const kept = new Map();
  const copy = (r) => JSON.parse(JSON.stringify(r));
  return {
    async list() { return [...kept.values()].reverse().map(copy); },
    async save(record) { kept.delete(record.id); kept.set(record.id, copy(record)); return { record: copy(record), kept: 'tab' }; },
    async remove(id) { kept.delete(id); },
  };
}
