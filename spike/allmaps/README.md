# Spike: can Allmaps' requests be put behind a page-side guard?

**Question.** Chora's privacy guard is in code (`transformRequest` in `src/chora/map.js`). A
historical map drawn by `@allmaps/maplibre` is a MapLibre custom layer, so `transformRequest` never
sees its requests. Can a guard see them, and can a map admitted for origin A make any request to
another origin B?

**Harness.** `python3 spike/allmaps/run_spike.py` starts `vite` (the page, `index.html` +
`main.js`, not wired into `chora.html`) and `fixture_server.py`, which serves
`test/fixtures/chora-iiif/` on two ports of 127.0.0.1, so A and B are really different origins,
and logs every request it receives: that log is the census. Each case runs in a fresh context of
Playwright's bundled Chromium (147.0.7727.15), and the page reads back one pixel of what it drew
(green is the background; cream is the map). `--prove-it-fails` points every case at a page with no
map: nothing is requested and nothing drawn. `--no-gl-flags` gives the same results as the default.
Measured 2026-09-30 with @allmaps/maplibre 1.0.0-beta.44 (@allmaps/render 1.0.0-beta.84,
@allmaps/transform 1.0.0-beta.53).

## Results

| Case | Requests that reached a server (census) | Drawn |
|---|---|---|
| plain: the layer fetches everything itself | A info.json; A tile `/iiif/grid/0,0,512,512/512,/0/default.jpg` | yes |
| `fetchFn` option that records and fetches | A info.json (through fetchFn); **no tile request at all** | **no** |
| page fetches info.json, gives it with `addImageInfos`, then adds the annotation | A info.json?by=guard (the page's); A tile | yes |
| Image API 3 | A info.json; A tile `/iiif3/grid/0,0,512,512/512,512/0/default.jpg` | yes |
| info.json on A gives an `@id` on B | A info.json; **B tile** | yes |
| A's info.json honest; A answers the tile with 302 to B | A info.json; A tile (302); **B tile** (`Origin: null`) | yes |
| plain, with a `<meta>` CSP `connect-src 'self' A` put in before the map | A info.json; A tile | yes |
| 302 to B, with that CSP | A info.json; A tile (302); nothing on B | no |
| plain, with a Service Worker that refuses redirects | A info.json; A tile | yes |
| 302 to B, with that Service Worker | A info.json; A tile (302); nothing on B | no |

1. **`fetchFn` sees info.json only, and breaks the tiles.** Tiles are fetched in a pool of five
   `blob:` workers; the layer posts `fetchFn` to them, and a function cannot be cloned:
   `DataCloneError: Failed to execute 'postMessage' on 'Worker': (input, init) => {…} could not be
   cloned`. The error is only logged to the console; no Allmaps event reports it.
2. **The workers' requests do appear to Playwright** (`context.on('request')`, type `fetch`), one
   for one with the census. But Playwright also lists the redirect's hop to B when a CSP or the
   Service Worker stopped it and B's log has nothing: its request events count requests that never
   left the browser. The server's log is the census; Playwright's events are not.
3. **Yes, a map admitted for A can reach B**, two ways: an info.json whose id is on B (the tiles are
   built from that id), and a redirect from A at tile time, which the worker follows. The page can
   prevent the first (fetch info.json itself, check the id, give it with `addImageInfos`) but not
   the second: it happens inside the worker, after admission.
4. **Both hard blocks stop the redirect, and neither stops an honest map.** The CSP's violation is
   raised in the worker, not the document, so the page's `securitypolicyviolation` listener hears
   nothing. The Service Worker saw every request, the workers' tiles included, and reported them.

Throwaway: delete this folder once the slice has its own tests.
