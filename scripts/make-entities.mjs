// Build src/vendor/iso-entities.json and src/vendor/iso-entities.NOTICE from the W3C's "XML Entity
// Definitions for Characters" (https://www.w3.org/2003/entities/2007/): the ISO 8879 and ISO TR 9573
// entity sets as XML (isolat1.ent, isogrk1.ent and the rest; no hyphen in the names), each name with
// the characters it stands for. The TEI reader (src/engine/hermes/tei.js) loads the JSON, lazily,
// only for a file whose DOCTYPE names an outside DTD (TEI P4's tei2.dtd, an <!ENTITY % ISOgrk1
// PUBLIC …> in its internal subset), whose entities such a file relies on and which are never fetched.
//
//   node scripts/make-entities.mjs             fetch the files from the W3C
//   node scripts/make-entities.mjs --from DIR  read local copies of them (DIR/isolat1.ent …)
//
// Not the WHATWG's entities.json (it lacks ISOgrk1's transliterations, agr for alpha, and adds names
// ISO never had), and not ISO 8879's own files (licensed only for conforming SGML systems). The W3C
// files are under the W3C Software Notice and License (or the WHATWG licence), and name ISO's
// notices: both are kept, verbatim, in the NOTICE, and in the JSON's `licence`, so that the notice
// travels with the table into the built site.
import { readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://www.w3.org/2003/entities/2007/';
// The sets, in the order a name found in two of them is taken from (none differs at present: the
// build checks, and stops if one does).
const SETS = ['isolat1', 'isolat2', 'isogrk1', 'isogrk2', 'isogrk3', 'isogrk4', 'isocyr1', 'isocyr2', 'isodia', 'isonum', 'isopub', 'isobox',
  'isotech', 'isoamsa', 'isoamsb', 'isoamsc', 'isoamsn', 'isoamso', 'isoamsr', 'isomfrk', 'isomopf', 'isomscr'];
// XML's own five are XML's: the files' amp and lt are escaped for an SGML parser, and never needed.
const XML_FIVE = new Set(['amp', 'lt', 'gt', 'apos', 'quot']);
const argv = process.argv.slice(2);
const from = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : null;

async function get(name) {
  if (from) return readFile(`${from}/${name}.ent`, 'utf8');
  // A generic User-Agent, and nothing else about whoever runs the build.
  const r = await fetch(BASE + name + '.ent', { headers: { 'User-Agent': 'PLATO-tools-build/1.0' } });
  if (!r.ok) throw new Error(`${BASE}${name}.ent: ${r.status}`);
  return r.text();
}
const chars = (s) => s.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (_, n) => String.fromCodePoint(n[0] === 'x' ? parseInt(n.slice(1), 16) : parseInt(n, 10)));

const sets = {}, taken = new Map(), notices = new Map();
for (const name of SETS) {
  const text = await get(name);
  // The licence comment, from its copyright line to the end of ISO's notice, verbatim.
  const m = /^[ \t]*Copyright 1998 - 2011 W3C\.[\s\S]*?provided this notice is included in all copies\.$/m.exec(text);
  if (!m) throw new Error(`${name}.ent: its licence notice was not found`);
  const notice = m[0];
  if (!notices.has(notice)) notices.set(notice, []);
  notices.get(notice).push(`${name}.ent`);
  const set = {};
  for (const [, ent, value] of text.matchAll(/<!ENTITY\s+([A-Za-z][\w.]*)\s+"([^"]*)"\s*>/g)) {
    if (XML_FIVE.has(ent)) continue;
    // Twice: nvlt is "&#38;#x0003C;&#x020D2;", escaped for SGML, which is "<" and U+20D2.
    const v = chars(chars(value));
    if (taken.has(ent) && taken.get(ent).value !== v) throw new Error(`&${ent}; is ${JSON.stringify(taken.get(ent).value)} in ${taken.get(ent).set} and ${JSON.stringify(v)} in ${name}`);
    if (!taken.has(ent)) taken.set(ent, { set: name, value: v });
    set[ent] = v;
  }
  if (!Object.keys(set).length) throw new Error(`${name}.ent: no entities read`);
  sets[name] = set;
}

// The W3C Software Notice and License (2002), which the files name, verbatim from
// https://www.w3.org/copyright/software-license-2002/ (formerly
// http://www.w3.org/Consortium/Legal/2002/copyright-software-20021231.html).
const W3C_LICENCE = `W3C Software Notice and License (2002 version)
https://www.w3.org/copyright/software-license-2002/

This work (and included software, documentation such as READMEs, or other related items) is being provided by the copyright holders under the following license.

License

By obtaining, using and/or copying this work, you (the licensee) agree that you have read, understood, and will comply with the following terms and conditions.

Permission to copy, modify, and distribute this software and its documentation, with or without modification, for any purpose and without fee or royalty is hereby granted, provided that you include the following on ALL copies of the software and documentation or portions thereof, including modifications:

- The full text of this NOTICE in a location viewable to users of the redistributed or derivative work.
- Any pre-existing intellectual property disclaimers, notices, or terms and conditions. If none exist, the W3C Software Short Notice should be included (hypertext is preferred, text is permitted) within the body of any redistributed or derivative code.
- Notice of any changes or modifications to the files, including the date changes were made. (We recommend you provide URIs to the location from which the code is derived.)

Disclaimers

THIS SOFTWARE AND DOCUMENTATION IS PROVIDED "AS IS," AND COPYRIGHT HOLDERS MAKE NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO, WARRANTIES OF MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE SOFTWARE OR DOCUMENTATION WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.

COPYRIGHT HOLDERS WILL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF ANY USE OF THE SOFTWARE OR DOCUMENTATION.

The name and trademarks of copyright holders may NOT be used in advertising or publicity pertaining to the software without specific, written prior permission. Title to copyright in this software and any associated documentation will at all times remain with copyright holders.`;

const NOTICE = [
  'src/vendor/iso-entities.json: ISO entity sets, from the W3C',
  '',
  `src/vendor/iso-entities.json is derived from the W3C's "XML Entity Definitions for Characters", the files ${SETS.map((s) => s + '.ent').join(', ')} at ${BASE}. It was made by scripts/make-entities.mjs, which keeps each entity's name and the characters it stands for, and nothing else: the files' comments and parameter entities are left out, the character references are written as the characters themselves, and XML's own five entities (amp, lt, gt, apos, quot) are left out. The table was generated on ${new Date().toISOString().slice(0, 10)}, and is generated again only by that script.`,
  '',
  'Use and distribution of these files are permitted under the terms of either of two licences, the W3C Software Notice and License or the licence used for the WHATWG HTML specification; PLATO tools uses them under the first. The notices the files carry, verbatim:',
  '',
  ...[...notices].flatMap(([text, files]) => [`---- the notice in ${files.join(', ')} ----`, '', text, '']),
  '---- the licence those notices name (1) ----',
  '',
  W3C_LICENCE,
  '',
].join('\n');

const json = { source: BASE, licence: NOTICE, sets };
await writeFile('src/vendor/iso-entities.json', JSON.stringify(json) + '\n');
await writeFile('src/vendor/iso-entities.NOTICE', NOTICE);
const total = Object.values(sets).reduce((n, s) => n + Object.keys(s).length, 0);
console.log(`src/vendor/iso-entities.json: ${Object.keys(sets).length} sets, ${total} entities (${taken.size} names), ${notices.size} forms of the notice`);
