// Make src/vendor/iso-countries.json: each ISO 3166-1 alpha-2 code with the Wikidata item that carries
// it (P297) and the item's English label, for the country statement (P17) of an item made from a
// place (src/engine/krisis/wikidata.js), and for reading a found item's country back as a code.
//   node scripts/make-iso-countries.mjs              ask the Wikidata Query Service (one request)
//   node scripts/make-iso-countries.mjs --from FILE  read the same query's CSV answer from a file
// A code carried by two items (AQ: Antarctica and the Antarctic Treaty area; CY: Cyprus twice) keeps
// the item with the lower number, the older item. The table is data (CC0, Wikidata's licence), and is
// generated again only by this script: src/vendor/iso-countries.NOTICE says where it came from and when.
import { readFile, writeFile } from 'node:fs/promises';

const QUERY = 'SELECT ?code ?item ?itemLabel WHERE { ?item wdt:P297 ?code . FILTER NOT EXISTS { ?item wdt:P576 ?d } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } ORDER BY ?code';
const at = process.argv.indexOf('--from');
let csv;
if (at >= 0) csv = await readFile(process.argv[at + 1], 'utf8');
else {
  const r = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(QUERY)}`, { headers: { Accept: 'text/csv', 'User-Agent': 'plato-tools-build/0.1 (https://github.com/pelagios/plato-tools)' } });
  if (!r.ok) throw new Error(`query.wikidata.org answered ${r.status}`);
  csv = await r.text();
}
const rows = csv.trim().split(/\r?\n/).slice(1).map((line) => {
  const m = /^([A-Z]{2}),http:\/\/www\.wikidata\.org\/entity\/(Q\d+),(.*)$/.exec(line);
  if (!m) throw new Error(`not a row of the query's answer: ${line}`);
  return { code: m[1], q: m[2], name: m[3].replace(/^"(.*)"$/, '$1').replace(/""/g, '"') };
});
const table = {};
for (const { code, q, name } of rows) {
  if (!table[code] || Number(q.slice(1)) < Number(table[code].q.slice(1))) table[code] = { q, name };
}
const out = Object.fromEntries(Object.keys(table).sort().map((k) => [k, table[k]]));
await writeFile(new URL('../src/vendor/iso-countries.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`${Object.keys(out).length} codes written to src/vendor/iso-countries.json`);
