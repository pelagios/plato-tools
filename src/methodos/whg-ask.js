// Methodos: the World Historical Gazetteer, asked for as a workflow is begun, not first at the step that needs it.
//
// The page's Content Security Policy is written as the page loads, from the permissions allowed in this browser
// (src/lib/csp-head.js), and cannot be widened afterwards: a site allowed while the page is running can be used only
// from the next load. A workflow that looks places up in WHG used to meet that at its lookup, three or four steps in,
// with a file chosen and work done: allow, then reload. So the question is put at the start instead, when a reload
// costs nothing: a card says which step will ask the gazetteer and what it will see, and "Allow, and load the page
// again" records the permission (src/lib/permissions.js set, as the Permissions panel does) and loads the page again
// at once, so that the policy written at that load already holds the gazetteer's site. The policy's design is as it
// was: nothing is allowed without that click, nothing is sent by it, and the choice is in Permissions, to be changed
// there. "Decide later" leaves it to the step, as before.
//
// Pure: what to ask, and its words. src/methodos/page.js draws the card (index.html, #whg-ask) and src/app.js allows
// and reloads.

/** The operations that ask the World Historical Gazetteer. */
export const WHG_OPS = new Set(['lookup', 'lookup.levels']);

/**
 * What to put to the user of a workflow, or null: `steps` are its steps in order, each { op, title, st } ('done',
 * 'current', 'todo', 'unavailable'); `state` is the gazetteer's permission ('allowed', 'never', 'undecided') and
 * `inPolicy` whether this load's policy holds its sites; `enforced` false where the page's protection was not shown
 * to work (nothing is asked of any site then); `later`: the user said "Decide later" of this workflow; `justAllowed`:
 * the page was loaded again for this, a moment ago.
 *   { kind: 'allow' | 'reload' | 'allowed', n, title }   (n: the number of the first step that asks WHG, from 1)
 * Asked only while that step is still to come: at the step itself the lookup's own panel says what is needed. Never
 * asked of a permission set to Never: the user has answered.
 */
export function whgAsk({ steps = [], state = 'undecided', inPolicy = false, enforced = true, later = false, justAllowed = false } = {}) {
  const followed = steps.filter((s) => s.st !== 'unavailable');
  const i = followed.findIndex((s) => WHG_OPS.has(s.op));
  if (i < 0 || followed[i].st !== 'todo' || enforced === false) return null;
  const at = { n: i + 1, title: followed[i].title };
  if (state === 'allowed' && inPolicy) return justAllowed ? { kind: 'allowed', ...at } : null;
  if (later) return null;
  if (state === 'undecided') return { kind: 'allow', ...at };
  if (state === 'allowed') return { kind: 'reload', ...at };
  return null;
}

/** The card's words, by kind. */
export const WHG_ASK = {
  allow: {
    heading: 'Allow the World Historical Gazetteer now?',
    why: ({ n, title }) => `Step ${n} of this workflow, “${title}”, looks your places up in the World Historical Gazetteer, which is another site. A page can only be allowed to reach another site as it loads, so this is best settled now, before you begin: say yes, and the page loads again once, with your workflow kept.`,
    what: 'Nothing is sent by allowing it. At that step you are shown exactly what would be sent, and you send it yourself; the gazetteer then sees the names you look up, and their language where one is sent with them. You can change your mind at any time, in Permissions.',
    yes: 'Allow, and load the page again',
    later: 'Decide later',
  },
  reload: {
    heading: 'Load the page again now?',
    why: ({ n, title }) => `The World Historical Gazetteer is allowed, and step ${n}, “${title}”, can use it once the page has loaded again. Now is the easy moment, before you have begun: your workflow is kept.`,
    what: 'Nothing is sent by loading the page again. You can change your mind at any time, in Permissions.',
    yes: 'Load the page again',
    later: 'Later',
  },
  allowed: {
    heading: 'The World Historical Gazetteer is allowed',
    why: ({ n, title }) => `Step ${n}, “${title}”, can now look your places up without another reload. Nothing has been sent: at that step you are shown exactly what would be sent, and you send it yourself.`,
    what: 'You can change this at any time, in Permissions.',
    yes: 'Carry on',
  },
  laterSaid: 'You will be asked at the step that looks your places up. Allowed then, the page has to load again before the gazetteer can be used.',
};
