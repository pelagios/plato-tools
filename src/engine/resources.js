// The PLATO files the tools check against (vendored from a pinned commit), and what is derived from
// them: the set of declared terms, and each property's single named domain and range class.
import { Parser } from 'n3';
const P = 'https://w3id.org/plato#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

export async function loadResources(readText) {
  const [ttl, context, core, pc, ac, cs, csvMeta, version] = await Promise.all([
    readText('ontology.ttl'), readText('plato.context.jsonld'), readText('plato.schema.json'), readText('place-centric.schema.json'),
    readText('attestation-centric.schema.json'), readText('candidate-set.schema.json'), readText('csv-metadata.json'), readText('VERSION.json')]);
  const quads = new Parser({ format: 'text/turtle' }).parse(ttl);
  const terms = new Set(), domain = new Map(), range = new Map();
  for (const q of quads) {
    if (q.subject.termType === 'NamedNode' && q.subject.value.startsWith(P)) terms.add(q.subject.value);
    if (q.predicate.value === RDFS + 'domain' && q.object.termType === 'NamedNode' && q.object.value.startsWith(P)) domain.set(q.subject.value, q.object.value);
    if (q.predicate.value === RDFS + 'range' && q.object.termType === 'NamedNode' && q.object.value.startsWith(P)) range.set(q.subject.value, q.object.value);
  }
  return {
    context: JSON.parse(context), core: JSON.parse(core), csvMeta: JSON.parse(csvMeta), version: JSON.parse(version),
    // The two dataset profiles, and the candidate set (PLATO 53c5a40): matches software suggested for a
    // dataset's places, published apart from it.
    profiles: { 'place-centric': JSON.parse(pc), 'attestation-centric': JSON.parse(ac), 'candidate-set': JSON.parse(cs) },
    terms, types: { domain, range },
  };
}
