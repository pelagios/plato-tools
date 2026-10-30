// Hermes, place names in a text: a text file's bytes as the text, and what shifts offsets.
//
// Every offset the tools record counts code points of the decoded text from 0. Three things in a file
// would make that count differ from the one a reader of the file makes, so each is settled here, in
// words, and not left to chance:
//   - a UTF-8 byte order mark (EF BB BF) is not a character: it is dropped, and noted (`bom`), so
//     that the offsets count from the first character after it. A second U+FEFF is a character of the
//     text and stays;
//   - CRLF is kept as it is (two code points); it is the model that is sent line feeds (normalise.js);
//   - a file that is not UTF-8 is refused, never decoded leniently: replacement characters, or one
//     character for each byte of UTF-16, would put every later offset out and say nothing. UTF-16 is
//     named as such; any other encoding is the tools' usual refusal, saying where the first bad byte is.
import { DataError, decodeUtf8 } from '../../input.js';

/**
 * The text of a file's `bytes` (named `name` in the words): { text, bom }. Throws a DataError for an
 * empty file, UTF-16 (or UTF-32), a file with NUL characters (UTF-16 without a mark), and bytes that
 * are not UTF-8.
 */
export function decodeText(bytes, name = 'The text') {
  if (!bytes?.length) throw new DataError(`${name} is empty: there is no text to look in.`);
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  const refuse = () => new DataError(`${name} is encoded as UTF-16 (or UTF-32), which would put every position in it out. Save it as UTF-8 (in a text editor, “Save As” and choose “UTF-8”) and try again.`);
  if (utf16) throw refuse();
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  // decodeUtf8 drops a leading U+FEFF of its own: put back one that was the text's.
  let text = decodeUtf8(body, name);
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) text = '\ufeff' + text;
  if (text.includes('\u0000')) throw refuse();
  return { text, bom };
}
