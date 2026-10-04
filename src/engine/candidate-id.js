// A candidate's address, as the candidate set specification (section 5) mints it: one function for
// the tools, so that what Krisis mints (krisis/candidates.js) and what Elenchos checks (candidates.js)
// cannot drift apart. Its @id is its candidate set's IRI without any fragment, "#c-", and the first
// 8 hex digits (or 12, 16 … where 8 would begin like another candidate's hash) of
//   SHA-256(UTF-8(JCS([subject, object, algorithmVersion, matchParameters ?? ''])))
// in the JSON Canonicalization Scheme (RFC 8785; json2rdf's jcs, the tools' one canonicaliser), with
// no Unicode normalisation. generatedAt, similarityScore and status are not hashed: the four inputs
// are what make one candidate the same as another, so a rerun that scores a pair anew changes nothing.
// Kept light (no pipeline, no schema library), so that the page can import it directly.
import { sha256 } from '../lib/sha256.js';
import { jcs } from '../formats/json2rdf.js';

/** The four inputs that make a candidate what it is; an absent matchParameters is "", never null. */
export const candidateInputs = (c) => [c.subject, c.object, c.algorithmVersion, c.matchParameters ?? ''];
/** The text a candidate's hash is taken of: the JCS form of its four inputs. */
export const candidateText = (c) => jcs(candidateInputs(c));
/** The full hash (64 lower-case hex digits) of a candidate's text. */
export const candidateHash = (text) => sha256(text);
