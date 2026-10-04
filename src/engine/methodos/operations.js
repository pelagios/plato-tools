// Methodos: the operations a recipe's steps may name. Each is one call the tools already make
// (docs/plans/methodos.md, section 4.1), described here, not implemented again: the adapters in
// adapters.js make the calls. Every operation declares
//   kind        'automatic' (the runner calls it) or 'interactive' (the user does it, and the step
//               waits until they have); whether a step runs at all is the step's `when`, in the recipe;
//   takes       its inputs, each a list of the hand-off types it accepts (handoffs.js), and whether
//               it may be left out;
//   gives       its outputs, each of one type;
//   permissions the (category, subject) pairs of src/lib/permissions.js it needs, if any;
//   cancel      'keeps-partial' when what it had done when cancelled is kept, else 'all-or-nothing':
//               the runner then names what it had written (`discarded`), and removing it is the
//               host's (the page's, as it removes a stopped conversion's file now); stopping the
//               engine's call is the host's too (the worker's run cancellation), as only the lookup
//               takes a signal;
//   available   true, or the reason it is not available yet: a step naming an operation that is
//               not available is skipped when the workflow starts (refused only if the runner is asked to), never run as something else.
const ANY = ['files', 'dataset'];
const op = (o) => ({ kind: 'automatic', networked: false, permissions: [], takes: {}, gives: {}, cancel: 'all-or-nothing', available: true, ...o });

export const OPERATIONS = Object.fromEntries([
  op({ key: 'detect', title: 'Recognise the files', tool: null, takes: { files: { types: ANY } } }),
  op({ key: 'read.columns', title: 'Match the columns to PLATO', tool: 'Hermes', kind: 'interactive',
    waitsFor: "the table's columns to be matched to PLATO, in the Columns panel",
    takes: { files: { types: ['files'] } }, gives: { mapping: 'mapping' } }),
  op({ key: 'check', title: 'Check the data', tool: 'Elenchos', takes: { files: { types: ANY }, mapping: { types: ['mapping'], optional: true } } }),
  op({ key: 'convert', title: 'Convert the data', tool: 'Metaphrasis',
    takes: { files: { types: ANY }, mapping: { types: ['mapping'], optional: true } }, gives: { dataset: 'dataset' } }),
  op({ key: 'compare', title: 'Compare two versions', tool: 'Mneme', takes: { earlier: { types: ANY }, later: { types: ANY } } }),
  op({ key: 'publish.report', title: 'Write the FAIR report', tool: 'Agora',
    takes: { dataset: { types: ANY }, previous: { types: ANY, optional: true } }, gives: { deposit: 'deposit' } }),
  op({ key: 'publish.mint', title: 'Give every place and source a permanent address', tool: 'Agora',
    takes: { dataset: { types: ANY }, previous: { types: ANY, optional: true } }, gives: { dataset: 'dataset' } }),
  op({ key: 'publish.site', title: 'Build the web site', tool: 'Agora', takes: { dataset: { types: ANY } }, gives: { site: 'site' } }),
  op({ key: 'publish.w3id', title: 'Write the permanent-address rules', tool: 'Agora', takes: { dataset: { types: ANY } }, gives: { w3id: 'w3id' } }),
  op({ key: 'match', title: 'Find matching places in another dataset', tool: 'Krisis',
    takes: { subjects: { types: ANY }, others: { types: ANY } }, gives: { work: 'work.krisis' } }),
  op({ key: 'lookup', title: 'Look the places up in a gazetteer', tool: 'Krisis', networked: true, permissions: [['gazetteer', 'whg']],
    cancel: 'keeps-partial', takes: { subjects: { types: ANY }, work: { types: ['work.krisis'], optional: true } }, gives: { work: 'work.krisis' } }),
  op({ key: 'review', title: 'Decide which candidates are the same place', tool: 'Krisis', kind: 'interactive', cancel: 'keeps-partial',
    waitsFor: 'the candidates to be reviewed, in step 5', takes: { work: { types: ['work.krisis'] } }, gives: { work: 'work.krisis' } }),
  op({ key: 'apply', title: 'Record the decisions in the dataset', tool: 'Krisis',
    takes: { subjects: { types: ANY }, work: { types: ['work.krisis'] } }, gives: { dataset: 'dataset' } }),
  // Chora hands the dataset saved there back to this step (src/chora/handback.js): a reference, which
  // the page checks against the file chosen here again (refsDiffer) before it completes the step.
  op({ key: 'place', title: 'Draw or trace the places on a map', tool: 'Chora', kind: 'interactive',
    waitsFor: 'the places to be drawn or traced in Chora, and the dataset saved there to be handed back ("Back to the workflow") and chosen here again',
    takes: { dataset: { types: ANY } }, gives: { dataset: 'dataset' } }),
  // The regions a table's places lie in (Hermes's "within" columns, minted as regions of their own when
  // the table is converted under a base address), identified level by level, the widest first, each
  // level looked up within the match of the level above (Krisis's region review, src/engine/krisis/
  // regions.js). The reviewer settles every region; the step is done with the work file that holds them.
  op({ key: 'lookup.levels', title: 'Identify the containing regions, level by level', tool: 'Krisis', kind: 'interactive', networked: true, permissions: [['gazetteer', 'whg']],
    cancel: 'keeps-partial',
    waitsFor: 'the regions to be identified level by level, the widest first, in the region review of step 5 ("Review the regions level by level"), until every region is settled',
    takes: { subjects: { types: ANY } }, gives: { work: 'work.krisis' } }),
  // PLATO #23, option B: the source's half (each place ContainedIn the region minted from its row) is
  // Hermes's, written when the table is converted; this step writes the reviewer's half, an
  // IdentityRelation from each minted region to the authority's record, promotedFrom the candidate it
  // answers (so the review's candidates are exported first), with the places' own identities. On the
  // page it is Krisis's Finish run.
  op({ key: 'relate.containment', title: 'Record the decisions, with the region each place is in', tool: 'Krisis',
    takes: { subjects: { types: ANY }, work: { types: ['work.krisis'] } }, gives: { dataset: 'dataset' } }),
  // Not yet: each declared, with its reason, so that a recipe can name it and the runner can say why
  // it cannot start, rather than doing something else under its name.
  op({ key: 'adopt', title: "Take each identified place's location from its match", tool: 'Chora',
    takes: { dataset: { types: ANY } }, gives: { dataset: 'dataset' },
    available: "Adopting a match's location is done by hand on Chora's page (\"Find in a gazetteer…\", then \"Adopt: this place is that record, located there\"), within the step that draws or traces the places: it is not a step of its own." }),
  op({ key: 'text.find', title: 'Find the places named in a text', tool: 'Hermes', networked: true, cancel: 'keeps-partial',
    takes: { files: { types: ['files'] } }, gives: { work: 'work.hermes-text' },
    available: 'Finding places in a text is deferred (the llm-extract branch).' }),
  op({ key: 'text.review', title: 'Confirm the places found in a text', tool: 'Hermes', kind: 'interactive', cancel: 'keeps-partial',
    takes: { work: { types: ['work.hermes-text'] } }, gives: { work: 'work.hermes-text' },
    available: 'Finding places in a text is deferred (the llm-extract branch).' }),
].map((o) => [o.key, Object.freeze(o)]));

/** Whether an operation can be run now: its declaration says `available: true`. */
export const isAvailable = (key) => OPERATIONS[key]?.available === true;
