# Detection fixtures (Hermes)

Files that `detect()` (src/engine/input.js) must tell apart from the inputs the tools read, used by
test/hermes-generic.test.js.

## IIIF Georeference Annotations (Allmaps)

Copied unchanged from the georeference fixtures of issue #5's georeference step
(`test/fixtures/georef/` on the `issue-5-georef` branch, whose README records the same provenance),
which fetched them from Allmaps on 2026-09-30. Allmaps states that "georeference data published
through the Allmaps project is licensed under the [CC0](https://creativecommons.org/publicdomain/zero/1.0/)
license" (the Licence section of the
[allmaps/allmaps README](https://github.com/allmaps/allmaps/blob/1586076d772139a4f15219a6672a2014160609ca/README.md),
commit `1586076d772139a4f15219a6672a2014160609ca`, read 2026-09-30). The annotations themselves
carry no rights statement.

| File | Where it comes from | Licence | What it exercises |
|---|---|---|---|
| `bpl-rocque-annotation.json` | <https://annotations.allmaps.org/maps/56425c69f9cd4f1b>. John Rocque, Mary Ann Rocque and Andrew Dury, *A general map of North America* ([ca. 1764]), MacLean Collection Map Library, via Digital Commonwealth. | CC0 (Allmaps, above) | One Georeference Annotation on its own: the georeference extension's context and the Presentation 3 context, motivation "georeferencing", no Web Annotation context |
| `loc-chesapeake-annotationpage.json` | <https://annotations.allmaps.org/images/7f2494dd1ad9ed7a>. *Chesapeake and Ohio Canal … official map and guide*, Library of Congress. | CC0 (Allmaps, above) | An AnnotationPage in the Web Annotation context holding two Georeference Annotations of one image service: read as W3C annotations before it was told apart |
