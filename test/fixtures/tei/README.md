# TEI fixtures

Test fixtures for reading TEI XML editions (`src/engine/hermes/tei.js`, `test/hermes-tei.test.js`).
One is a real EpiDoc edition, copied unchanged; four are constructed, and say so.

| File | Where it comes from | Licence | What it exercises |
|---|---|---|---|
| `isicily-ISic000934.xml` | [ISicily/ISicily](https://github.com/ISicily/ISicily), `inscriptions/ISic000934.xml`, commit `d3ebc63ff30b3b3b7359513292a5e7b01a05af7c`. I.Sicily's EpiDoc edition of the epitaph of Zodoros (Syracuse, 4th to 6th century CE), edited by Jonathan Prag. Copied unchanged. | CC BY 4.0 (the repository's `licence.txt`, and the file's own `<licence>`) | A real EpiDoc file: a Greek place name broken over three lines within words (`lb break="no"`); a place name in the English commentary; place names with a ref in the teiHeader (where the stone was made and found), which are not converted; the edition's URI, DOI, editor, licence, and the museum and inventory number of the stone |
| `prose-constructed.xml` | Constructed | Constructed for these tests; no licence needed | A prose edition: `div type="book"`, `div type="chapter"`, `pb n`, `milestone unit="section"`; a main title after a subtitle; author, publisher, date, a DOI as the only address, a licence, a `sourceDesc/bibl`; a place name with a key and a note inside it; a ref with two web addresses; a place name with no ref; a `<settlement>` inside a referenced `<placeName>`; a place name in a note; an `xml:id` |
| `verse-constructed.xml` | Constructed | As above | A verse edition: `l n`; `<rs type="place">`, `<name type="place">`, `<region ref>`; `<rs type="person">`, which is not read; `xml:lang` inherited from `<text>`, and an `xml:lang="Latin"` that is not a language tag; no address for the edition; a licence in words only |
| `pointers-constructed.xml` | Constructed | As above | Every kind of ref: a `prefixDef` that expands to a web address, one that expands to a `urn:`, a prefix with no `prefixDef`, a `urn:`; local refs to a `<listPlace>` in the header (one web address; two, which is ambiguous; none) and to one in `<back>`, after the place name; a ref to an id that is not there; a ref into another file; place names with no ref, with and without a key; `<choice>` (`orig`/`reg`, `abbr`/`expan`, `sic`/`corr`) and `<app>` (`lem`/`rdg`); two originals in the `sourceDesc` |
| `whg-constructed.xml` | Constructed | As above | World Historical Gazetteer addresses (`src/engine/hermes/addresses.js`): a reconciliation id `place:gn:…` and an entity page, both rewritten to `https://w3id.org/whg/id/place:…`; a cluster address in the range of whg_ids, kept; a database-record address and a staging address, refused; a `<listPlace>` idno in the `place:gn:…` form and one on staging; `@cert`, `@type`, `@resp` on place names and `@type` on a place; a place's `<desc>` and `<note>` |

Other openly licensed EpiDoc corpora were looked at for a place name with a ref in the text itself:
of I.Sicily's 5,138 inscriptions, 5,128 have a `placeName` with a ref, but nearly all of those are
in the teiHeader (where the stone came from); only three files have one in the text, and
ISic000934 is the one with both a name in the inscription and one in the commentary.

## The mapping

How `src/engine/hermes/tei.js` reads a TEI edition. Each place name in the text, for each place
address its ref points to, becomes one attestation-centric attestation about that place.

| In TEI | In PLATO | Notes |
|---|---|---|
| `<placeName>`, `<settlement>`, `<region>`, `<country>`, `<bloc>`, `<district>`, `<geogName>`, `<rs type="place">`, `<name type="place">`, in `<text>` | one attestation for each address in its ref | Notes, commentary and translations included: the source is the edition. In the teiHeader, a standOff or a facsimile, a place name is the edition's description of the document, and is reported, not converted; so is one in a `<listPerson>`, `<listOrg>`, `<listEvent>`, `<listBibl>`, `<person>`, `<org>`, `<event>` or `<bibl>` (`tei-place-in-record`, with its path), which describes that. One with a ref and no words (`tei-place-empty`), or of `type="ethnic"` (`tei-place-ethnic`, a people, not a place), is reported, not converted |
| `@ref`: a web address | `about` | Several addresses give one attestation each, with a note naming them, and a warning; two forms of one address (http and https) are one. Pleiades, GeoNames and Wikidata addresses are put into each gazetteer's one form (DEVELOPERS.md, "Address rules"), with a note ("Place address given as … (rule …, hermes-addresses 1)"); part of a Pleiades place's record (`/places/<n>/<slug>`, `/json`, `#this`) is carried as given and reported |
| `@ref`: a prefixed pointer (`pl:579885`) | `about`, expanded through the header's `<prefixDef>` | The pattern must match everything after the prefix. No `prefixDef`, or one that gives no web address: reported |
| `@ref`: a local pointer (`#athens`) | `about`: the one web-address `<idno>` of the `<place xml:id="athens">` in the same file | Several web addresses: ambiguous, reported, nothing converted. None, or no such place: reported. A place later in the file is waited for |
| `@ref`: another file (`places.xml#x`), or a `urn:` | | Reported |
| The element's text, whitespace made single, notes left out, words broken over a line (`break="no"`) joined, a `<g>` whose ref or type names punctuation (`#interpunct`, a middle dot, a hedera) read as a space | `names[].toponym`, with `formStatus` `plato:Attested` | In a `<choice>`, `reg`, `expan`, `corr`; in an `<app>`, the `lem` |
| The form as printed, where a `<choice>` changed it (`orig`, `abbr`, `sic`) | `names[].sourceLabel` | Also where the place name is inside the `<choice>`, one in each part with the same ref: the part taken is the attestation, the printed one its `sourceLabel` |
| A place name wholly inside an `<rdg>`, or inside the part of a `<choice>` not taken (`orig`, `abbr`, `sic` beside `reg`, `expan`, `corr`) | | A variant reading: reported (`tei-variant`), not converted. A `<choice>` with one part takes it |
| An entity declared with its text in the file's own DOCTYPE (`<!ENTITY nbsp "&#160;">`) | its text | One whose text holds markup is refused where it is used. An external entity (`SYSTEM`, `PUBLIC`) is never fetched or read: using one stops the file |
| The nearest `xml:lang`, inherited | `names[].language` | Only a language tag of two or three letters and its subtags; anything else is reported |
| `@key` | `notes` ("Key: …") | With no ref, the key is given in the report's example |
| `<div type n>` (for `type="textpart"`, its subtype), `<milestone unit n>`, `<pb n>`, `<l n>` or `<lb n>`, a `<note>`, `@xml:id` | `citations[].locator`, in words | "book 2, chapter 1, section 1, page 12", "edition, lines 2 to 4", "line 6", "commentary" |
| The element and its line in the file | `notes` ("From TEI element <placeName> on line 180 of …") | The `xml:id` is never the attestation's `@id`: an edition can be revised under the same ids |
| teiHeader `titleStmt/title` (the `type="main"` one, else the first) | `citations[].source.title`, and the gazetteer's title ("Place names in …") | |
| `publicationStmt/idno type="URI"` (or `URL`), else `type="DOI"` | `citations[].source.@id` | None: a warning, and the source has only its title |
| `titleStmt/author` (else `editor`, with "(ed.)"), title, `publicationStmt/publisher`, `date` | `citations[].source.citation` | |
| `publicationStmt/availability/licence/@target` | `citations[].source.licence` | A licence in words only is reported |
| `sourceDesc/bibl` (or `biblStruct`, `biblFull`, `listBibl/bibl`), or `sourceDesc/msDesc/msIdentifier` | `citations[].source.derivedFrom`, by title | The original the edition was made from. Only the first; others are reported. A `sourceDesc/p` is not read |
| `<listPlace>/<place>`: its names, its `<location>` | | Reported once per place |
| `<listPlace>/<place>`: a `<desc>`, a `<note>`, an idno that is not an address, any other child | | Reported, once for each place and part |
| A WHG address: `place:<ns>:<id>` (with no `prefixDef` for `place`), `whgazetteer.org/entity/place:…` | `about`: `https://w3id.org/whg/id/place:<ns>:<id>`, and `notes` ("Place address given as … (rule whg-record-id, hermes-addresses 1)") | Also for an address from a `prefixDef` or a listPlace idno. A declared `prefixDef` for `place` wins. A `/places/<n>/portal` address with n below 12,345,678, or one on dev.whgazetteer.org, is reported, not converted |
| Any other attribute of a place name (`@cert`, `@type` on `<placeName>`, `@resp`, …) or of a `<place>` | | Reported, once for each attribute and value. `@cert` is not taken for certaintyLevel: TEI does not say what it is certain of |
