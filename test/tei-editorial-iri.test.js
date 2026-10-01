// The editors' form status (src/engine/hermes/tei.js EDITORIAL_IRI) is plato:Editorial exactly as the
// vendored ontology (public/plato/ontology.ttl, the pinned PLATO's) writes it: read from there, never a
// second copy typed here. The pin (package.json's plato.commit, 7720890 or later) defines
// plato:Editorial, so a vendored ontology without it fails, naming the pin; a control test first shows
// the same file is read: its plato: prefix and its plato:Attested form status found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EDITORIAL_IRI } from '../src/engine/hermes/tei.js';

const TTL = readFileSync(new URL('../public/plato/ontology.ttl', import.meta.url), 'utf8');
const PIN = JSON.parse(readFileSync(new URL('../public/plato/VERSION.json', import.meta.url), 'utf8')).commit;

/** The namespace the ontology binds to the prefix "plato:". */
const platoNamespace = (ttl) => /^@prefix\s+plato:\s*<([^>]+)>\s*\.\s*$/m.exec(ttl)?.[1];
/** Whether the ontology defines plato:<name> as a form status: a subject at the start of a line, a concept in the form status scheme. */
function formStatus(ttl, name) {
  const block = new RegExp(`^plato:${name}\\s*\\n([\\s\\S]*?)\\.\\s*$`, 'm').exec(ttl);
  return !!block && /\ba\s+skos:Concept\b/.test(block[1]) && /skos:inScheme\s+plato:FormStatusScheme\b/.test(block[1]);
}

const NS = platoNamespace(TTL);
const HAS_EDITORIAL = formStatus(TTL, 'Editorial');

test('the vendored ontology is read: its plato: namespace and its plato:Attested form status are found (the control for the test below)', () => {
  assert.equal(typeof NS, 'string', 'no @prefix plato: in public/plato/ontology.ttl');
  assert.ok(formStatus(TTL, 'Attested'), 'plato:Attested is not found as a form status: the reading of the ontology is broken');
  assert.ok(!formStatus(TTL, 'NoSuchStatus'), 'a form status that does not exist is found: the reading cannot tell');
});

test('EDITORIAL_IRI is plato:Editorial\'s full IRI as the vendored ontology writes it', () => {
  assert.ok(HAS_EDITORIAL, `the vendored ontology (PLATO ${PIN.slice(0, 7)}) has no plato:Editorial form status, which PLATO defines from 05cf78a`);
  assert.equal(EDITORIAL_IRI, `${NS}Editorial`);
});
