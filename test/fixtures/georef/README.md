# Georeference fixtures

Test fixtures for the shared georeference module (`src/engine/georef/`, `test/georef.test.js`).
IIIF Georeference Annotations made with Allmaps and the IIIF manifests of the maps they georeference,
real and copied unchanged (fetched on 2026-09-30); one IIIF Presentation 3 manifest constructed from a
real one; and reference values computed with Allmaps' own code.

Allmaps states that "georeference data published through the Allmaps project is licensed under the
[CC0](https://creativecommons.org/publicdomain/zero/1.0/) license" (the Licence section of the
[allmaps/allmaps README](https://github.com/allmaps/allmaps/blob/1586076d772139a4f15219a6672a2014160609ca/README.md),
commit `1586076d772139a4f15219a6672a2014160609ca`, read 2026-09-30). The annotations themselves
carry no rights statement.

## Georeference Annotations (Allmaps)

| File | Where it comes from | Licence | What it exercises |
|---|---|---|---|
| `bpl-rocque-annotation.json` | <https://annotations.allmaps.org/maps/56425c69f9cd4f1b>. John Rocque, Mary Ann Rocque and Andrew Dury, *A general map of North America* ([ca. 1764]), MacLean Collection Map Library, via Digital Commonwealth. | CC0 (Allmaps, above) | 22 control points, a thin plate spline, a four-point mask; the only annotation on its image. The exact control-point and round-trip tests |
| `bpl-british-dominions-annotation.json` | <https://annotations.allmaps.org/maps/f551eca65c4c0f82>. Thomas Kitchin and Andrew Dury, *British dominions in America agreeable to the treaty of 1763* (1777), MacLean Collection Map Library, via Digital Commonwealth. | CC0 (Allmaps, above) | 12 control points, polynomial order 1, on an eighteenth-century map whose control points fit an affine transformation only to about 3.3° |
| `lynn-atlas-annotationpage.json` | <https://annotations.allmaps.org/manifests/23379602e8187445>, the AnnotationPage Allmaps gives for the manifest below. L.J. Richards & Co., *Atlas of the city of Lynn, Massachusetts* (1905), Boston Public Library, via Digital Commonwealth. | CC0 (Allmaps, above) | 31 annotations on the canvases of one manifest, up to three on one canvas: choosing by canvas, and a canvas that cannot choose; the polynomial tolerance test (annotation 7, 23 control points on one city plate) |
| `loc-chesapeake-annotationpage.json` | <https://annotations.allmaps.org/images/7f2494dd1ad9ed7a>. *Chesapeake and Ohio Canal … official map and guide*, Library of Congress (image service `https://tile.loc.gov/image-services/iiif/service:gmd:gmd384:g3842:g3842c:ct008615`). | CC0 (Allmaps, above) | Two annotations, with masks side by side, on the same image and canvas, three control points each: a page that cannot be narrowed by canvas; `containsRegion`; no manifest (the Library of Congress's manifest could not be fetched without a browser) |

## IIIF manifests

| File | Where it comes from | Licence | What it exercises |
|---|---|---|---|
| `bpl-rocque-manifest.json` | <https://ark.digitalcommonwealth.org/ark:/50959/ks65px29g/manifest> | "Public Domain/No known restrictions on use" (the manifest's `attribution` and Terms of Use) | IIIF Presentation 2, two canvases; the georeferenced one is the first (11436 × 6268, the size of the image) |
| `bpl-british-dominions-manifest.json` | <https://ark.digitalcommonwealth.org/ark:/50959/66833p58x/manifest> | "Public Domain/No known restrictions on use" (the manifest's `attribution` and Terms of Use) | IIIF Presentation 2, one canvas (7306 × 5949) |
| `lynn-atlas-manifest.json` | <https://ark.digitalcommonwealth.org/ark:/50959/dj530101x/manifest> | "No known copyright restrictions. No known restrictions on use." (the manifest's `attribution` and Terms of Use); published in the United States in 1905, so in the public domain there | IIIF Presentation 2, 31 canvases |

## Constructed

- `bpl-rocque-manifest-v3-constructed.json`: `bpl-rocque-manifest.json` rewritten as IIIF
  Presentation 3 (same ids, labels as language maps, image services as an array under
  `body.service`), for the Presentation 3 path. No public IIIF 3 manifest with a clear licence
  and an Allmaps georeference was found: the Internet Archive's master highway plan, used at
  first, states no licence (its item metadata has no `licenseurl` or `rights`), so it was dropped.

## Reference values from Allmaps

- `allmaps-render-reference.json`: where Allmaps' renderer puts the control points and a 5 × 5
  grid of interior points of three of the maps above, for each transformation type, computed by
  `make-allmaps-render-reference.mjs` with @allmaps/project 1.0.0-beta.10's
  ProjectedGcpTransformer (as @allmaps/render's WarpedMap builds it), @allmaps/transform
  1.0.0-beta.53 and proj4 2.22.0, on 2026-09-30. The script says how to run it again.

The file names say `bpl` because Digital Commonwealth is run by the Boston Public Library.

## Made in the tests, not stored

The canvas-scaling tests make a copy of `bpl-rocque-manifest.json` in memory with the first
canvas at half (and, for the control, a third) of the image's size. The too-few-control-points
test removes control points from a copy of a real annotation. The not-a-georeference test uses
`test/fixtures/annotations/recogito-v1-islandia-map.jsonld`.
