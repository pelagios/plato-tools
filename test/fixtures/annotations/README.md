# W3C Web Annotation fixtures

Test fixtures for reading W3C Web Annotations as Recogito exports them
(`src/formats/annotations.js`, `test/annotations.test.js`). Four are real exports from Recogito v1
(recogito.pelagios.org), copied unchanged; two are constructed, and say so.

## Real exports (Recogito v1)

| File | Where it comes from | Licence | What it exercises |
|---|---|---|---|
| `recogito-v1-islandia-map.jsonld` | [britishlibrary/peripleo-lanc](https://github.com/britishlibrary/peripleo-lanc), `public/data/recogito-sample.jsonld`, commit `920b264f9b1155fe2e052010050425f511102c46`. Two annotations on Abraham Ortelius's map of Iceland, by Rainer Simon, exported 2022-06-14. | MIT, Copyright (c) 2022 The British Library (the repository's `LICENSE`) | An image target with a media-fragment region; a `transcribing` body as the name; GeoNames links; the `georeferencing` Feature bodies |
| `recogito-v1-pliny-text.jsonld` | [laurensmile/PlinyPeripleo](https://github.com/laurensmile/PlinyPeripleo), `docs/data/pebte0ekynp6qc-2.jsonld`, commit `0680c19dc81d558baab2e8f6ce3252435eec1ac9`. 55 annotations on a plain-text passage of Pliny, exported 2024-12-08. | MIT, Copyright (c) 2022 The British Library (the repository's `LICENSE`) | A plain-text target (`TextPositionSelector` + `TextQuoteSelector`); links to Pleiades, GeoNames, DARE and geo-kima; Feature bodies with and without a geometry |
| `recogito-v1-paulinus-csv.jsonld` | [MapLLP/MapLLP](https://github.com/MapLLP/MapLLP), `docs/data/es2pnhiybcd4xj.jsonld`, commit `b20e81bdaa0887b2d34a06ff3e37d8d006926832`. 42 annotations on the rows of a CSV table of places in Paulinus of Nola, *Carmen* 14, exported 2026-06-16. | MIT, Copyright (c) 2022 The British Library (the repository's `LICENSE`) | A `Dataset` target with an RFC 7111 row selector; free tags; one annotation with a place link and an unlinked `PLACE` body |
| `recogito-v1-linked-traces-readme.json` | The two Recogito examples in the [Linked Traces README](https://github.com/LinkedPasts/linked-traces-format/blob/41fed996ed31ecb2654def1f5309953d7d1a732f/README.md) ("Example 1: Annotations on text", "Example 2: Annotations on a digitized old map"), commit `41fed996ed31ecb2654def1f5309953d7d1a732f`, put in one JSON array as Recogito exports them. Exported 2019-10-21. | The repository states no licence; the two examples are quoted for testing, with this attribution | A TEI target with a `RangeSelector` of XPaths; a 2019 export, which writes no target `label` |

Recogito v1 names itself as the `generator` of each annotation. Its serialiser is
`app/controllers/document/downloads/serializers/annotations/webannotation/` in
[pelagios/recogito2](https://github.com/pelagios/recogito2) (Apache-2.0).

## Constructed

No Recogito Studio export and no Recogito v1 export with every case in it was found published, so
these two are constructed. Neither is real data: the places, passages and people are invented or
illustrative, and the identifiers are made up.

- `recogito-v1-constructed.jsonld`: built to the shape of Recogito v1's serialiser (above) and of
  the real exports here. It has what the real ones lack: a link made by named-entity recognition
  and never confirmed (a place link and a Feature body with no `creator`, as v1 writes a body no
  person has saved; the pattern is seen in real exports: of the 263 annotations in
  [dh-tech/DH2022-workshop](https://github.com/dh-tech/DH2022-workshop)'s
  `notebooks/ingest/recogito-genesis-annotations.jsonld`, 218 have an identifying body with no
  creator: 17 place links, 16 unlinked `PLACE` and 185 `PERSON`; that repository states no licence,
  so the file is not copied here); a mention marked `PLACE` and never linked; a `PERSON`; an `EVENT` (a
  SpecificResource with no purpose); a comment; a place body with a `note`; a tag from a
  vocabulary (the body's `id` the concept's address, its `value` the label) and a free tag; an
  image target with an `SvgSelector`; and a TEI range whose start and end differ.
- `recogito-studio-constructed.json`: built to the shape of Recogito Studio's W3C export,
  `src/util/export/w3c/w3cExporter.ts` in [recogito/recogito-client](https://github.com/recogito/recogito-client)
  (commit `b211f751c19497d37e01e819d47511ed0ed71dac`, AGPL-3.0), with the serialisers it calls in
  [recogito/text-annotator-js](https://github.com/recogito/text-annotator-js) and
  [annotorious/annotorious](https://github.com/annotorious/annotorious), and the geotag bodies of
  [recogito/plugin-geotagging](https://github.com/recogito/plugin-geotagging) (`EditorExtension.tsx`
  and its gazetteer connectors). As Studio writes them: `visibility: false` and
  `motivation: "commenting"` on every annotation; the target's `source` the project's id; each
  target's `id` a selector id; the creator a user object with an internal id; a geotag's `value` a
  GeoJSON Feature (Wikidata, WHG, and a Core Data record whose id is not a web address); a geotag
  flagged as having no match (no value); a rich-text comment as HTML; a tag from a vocabulary as
  `{ label, id }`; a PDF target with a `page=` fragment; an image target with a media-fragment
  region; and an annotation with only a tag.

## The mapping

How `src/formats/annotations.js` reads an annotation, key by key. The PLATO guide explains the same
for the people who made the annotations:
[Annotations from Recogito](https://pelagios.org/place-attestation-ontology/guide/annotations.html).
Each link from a passage to a place becomes one attestation-centric attestation about that place.

| In the annotation | In PLATO | Notes |
|---|---|---|
| The place link: Recogito's `identifying` body (the address in its `value`), Studio's `geotagging` body (the `id` of its GeoJSON Feature), or a W3C `identifying` or `linking` body's `source` | `about` | Only a web address; a gazetteer's own id is reported. One passage linked to several places gives one attestation each |
| The words marked (`TextQuoteSelector` `exact`); for an image, a `transcribing` body | `names[].toponym`, with `formStatus` `plato:Attested` | A transcription beside a quote is a note |
| The annotated document (the target's `source`, and its `label` as the title) | `citations[].source` | Recogito Studio writes its project's id here: kept as the title, with a warning |
| The selectors | `citations[].locator`, in words | "characters 1083 to 1092", "region at x 2948, y 4087, 197 by 173 pixels", "row 2" |
| The link body's `creator` (else the annotation's) | `contributor` | A web address, or a name; an internal user id is reported |
| `created`, `modified` (of the link body, else the annotation) | `created`, `modified` | Recogito v1 writes only `modified` |
| The annotation's `id` | `notes` ("From annotation …") | Never the attestation's `@id`: an annotation can be edited and exported again under the same address. A Studio UUID is written as `urn:uuid:` |
| Comments (`commenting`, `replying`), a place body's `note`, free tags | `notes` | |
| A tag that is the address of a vocabulary concept | `types[]` | |

A place link with no `creator` was made by Recogito's own name recognition and never saved by a
person, so it is left out and reported. A `status` on a body (`VERIFIED`, `UNVERIFIED`,
`NOT_IDENTIFIABLE`) is honoured.
