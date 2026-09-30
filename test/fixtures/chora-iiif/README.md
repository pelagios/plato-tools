# Chora's historical-map fixtures

Fixtures for Chora's IIIF overlays and tracing: `test/chora-iiif.test.js` and the browser checks.
**Everything here is synthetic**, made for these tests on 2026-09-30; nothing was copied from a real
collection, so there is no third-party licence to state. Where a file imitates the shape of a real
service's response, the real response it was modelled on is named below.

## Addresses

The files use two placeholder origins, which a test server replaces, as text, with its own:

- `https://iiif.example.org`: the image server the user agreed to (origin A);
- `https://elsewhere.example.org`: another server, which must never be asked for anything (origin B).

Replacing the origin changes the image service's address, so the Allmaps id of the service (and the
name of `allmaps-images-*.json`) is the one for the placeholder address. A test that looks the image
up by its served address must match the request by path, not by that id.

## The files

| File | What it is | Made from |
|---|---|---|
| `grid.jpg` | 512 × 512 JPEG: a line every 64 pixels (every 128 heavier), each 128-pixel cell labelled `column,row`, a red ring at each control point | `make-grid.py` (Pillow 10.4.0); running it again gives the same bytes (sha256 `b9d2df4c…797feb`) |
| `info-v2.json` | IIIF Image API 2 `info.json` of `grid.jpg`: level 0, one 512-pixel tile, scale factor 1 | written by hand |
| `info-v3.json` | The same as Image API 3 (`ImageService3`), at `/iiif3/grid` | written by hand |
| `info-foreign-id.json` | `info-v2.json` with its `@id` on origin B, same path: the image-information document that points the tiles somewhere else, which admission must refuse | written by hand |
| `annotation.json` | A IIIF Georeference Annotation in the form Allmaps publishes (compare `test/fixtures/georef/`): four control points at the pixels (64,64), (448,64), (448,448), (64,448), polynomial order 1, a mask inset 16 pixels. It lays the grid over Cambridge (`https://whgazetteer.org/example/entity/cambridge` in `test/fixtures/chora/attestation-centric-survey.json`), 0.10° to 0.15° E, 52.19° to 52.22° N | written by hand; the id `https://annotations.allmaps.org/maps/0000000000000001` is made up |
| `manifest-rumsey-shaped.json` | IIIF Presentation 2.1 manifest of one canvas (512 × 512) painted with the grid, shaped as David Rumsey's are: `attribution` (a credit) but no `license`, no `rights` and no `requiredStatement`; `logo`, `related`, a search `service`, `otherContent`, canvas `metadata` | modelled on `https://www.davidrumsey.com/luna/servlet/iiif/m/RUMSEY~8~1~200375~3001080/manifest` (fetched 2026-09-30), keeping its keys and replacing every value |
| `allmaps-images-e564650581f5f6bb.json` | What `https://annotations.allmaps.org/images/<id>` answers: an `AnnotationPage` whose one item is `annotation.json` | the shape of `test/fixtures/georef/loc-chesapeake-annotationpage.json`; the id is `allmapsLookupUrl('https://iiif.example.org/iiif/grid')` (agrees with `@allmaps/id` 1.0.0-beta.39's `generateId`) |

## Why a rectangle of control points

Allmaps fits the transformation between pixels and Web Mercator metres. Four control points at the
corners of a rectangle, on the image and on the ground, have two values of each coordinate, so an
affine transformation passes through all four exactly, and each control point comes back to its own
longitude and latitude (the test asks for 1e-9°). A point between them does not come back halfway in
latitude, since Web Mercator is not linear in latitude: the test checks the centre pixel against
Web Mercator written out independently, which is what shows the comparison can fail.
