// Hermes, place names in a text: the schemas a model's reply is checked against, by the tools
// (validate.js). Not the schema the model is given (prompt.js's OUTPUT_SCHEMA): there `kind` is one of
// KINDS, and here any string, because an unknown kind is read as "other" and counted, not refused.
// Lengths are checked by the tools' own code, in code points, which JSON Schema cannot count alike in
// every library.
//
// The validators are compiled ahead of time (scripts/build-text-validators.mjs writes
// reply-validators.js), never in the page: Ajv compiles with `new Function`, which the page's Content
// Security Policy refuses. test/hermes-text.test.js fails if the file written is not what these
// schemas compile to now.

/** The reply: one object, holding only a list of mentions. */
export const REPLY_SCHEMA = {
  $id: 'hermes-text-reply',
  type: 'object',
  required: ['mentions'],
  additionalProperties: false,
  properties: { mentions: { type: 'array' } },
};

/** One mention, checked on its own, so that one bad mention costs only itself. */
export const MENTION_SCHEMA = {
  $id: 'hermes-text-mention',
  type: 'object',
  required: ['text', 'prefix', 'suffix', 'start', 'kind'],
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    prefix: { type: 'string' },
    suffix: { type: 'string' },
    start: { type: 'integer' },
    kind: { type: 'string' },
  },
};
