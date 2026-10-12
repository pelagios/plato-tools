// The digest the version check and Agora's addresses rest on (src/lib/sha256.js), against Node's own.
// It encodes into a buffer it keeps between calls, so a short text after a long one must not see the
// long one's bytes: each length that puts the padding at a block boundary is checked fresh and again
// after a long text, whose bytes are not the padding's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256 } from '../src/lib/sha256.js';

const node = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const EDGES = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128];

test('sha256 gives the standard digests', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256 agrees with Node at every block boundary, beyond ASCII, and at length', () => {
  for (const n of EDGES) assert.equal(sha256('a'.repeat(n)), node('a'.repeat(n)), `length ${n}`);
  for (const s of ['é', 'Ἑρμῆς χώρα 𝄞', '\uD800 lone', 'x'.repeat(70000), 'Ἑ'.repeat(30000)]) assert.equal(sha256(s), node(s), s.slice(0, 12));
  // Two bytes, three and four, at each boundary.
  for (const n of EDGES) for (const c of ['é', '€', '𝄞']) {
    const s = 'a'.repeat(n) + c;
    assert.equal(sha256(s), node(s), `length ${n} then ${c}`);
  }
});

test('a short text after a long one gives its own digest, not one with the long text\'s bytes in it', () => {
  // The long text's bytes are 0xff-free but never 0: a padding left unzeroed would hold them.
  const long = 'z'.repeat(5000), longer = '€'.repeat(400000); // the second is past what the buffer keeps
  for (const before of [long, longer, 'x'.repeat(70000)]) {
    for (const n of EDGES) {
      sha256(before);
      const s = 'a'.repeat(n);
      assert.equal(sha256(s), node(s), `length ${n} after ${before.length} characters`);
    }
  }
  // Random texts in random order, long and short mixed.
  for (let i = 0; i < 400; i++) {
    const s = randomBytes((i * 37) % 700).toString('base64') + 'é'.repeat(i % 5);
    assert.equal(sha256(s), node(s));
  }
  // Control: the digests differ where the texts do.
  assert.notEqual(sha256('a'), sha256('b'));
});

test('a value that is not a string is refused, not hashed as some string', () => {
  // Refused by the digest itself, in its words: Node's encoder refuses a number too, but the
  // browser's makes '123' of it, so a refusal left to the encoder would hold here and not there.
  for (const bad of [undefined, null, 123, {}, ['a'], new String('a')]) assert.throws(() => sha256(bad), /The digest is of a string/);
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');   // control
});
