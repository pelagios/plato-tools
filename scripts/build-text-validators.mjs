// Compile the schemas a language model's reply is checked against (src/engine/hermes/text/
// reply-schemas.js) into plain functions, with Ajv in strict mode, and write them to
// src/engine/hermes/text/reply-validators.js. Run after changing the schemas; the tests fail until
// the file written agrees with them. The page cannot compile them itself: Ajv compiles with
// `new Function`, which the page's Content Security Policy refuses.
//   node scripts/build-text-validators.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { REPLY_SCHEMA, MENTION_SCHEMA } from '../src/engine/hermes/text/reply-schemas.js';

export const OUT = fileURLToPath(new URL('../src/engine/hermes/text/reply-validators.js', import.meta.url));

/** The module's text, as this script writes it. */
export function validatorSource() {
  const ajv = new Ajv({ strict: true, allErrors: true, code: { source: true, esm: true }, schemas: [REPLY_SCHEMA, MENTION_SCHEMA] });
  const code = standaloneCode(ajv, { reply: REPLY_SCHEMA.$id, mention: MENTION_SCHEMA.$id });
  return '// Written by scripts/build-text-validators.mjs from reply-schemas.js: do not edit.\n' + code + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUT, validatorSource());
  console.log(`build-text-validators: wrote ${OUT}`);
}
