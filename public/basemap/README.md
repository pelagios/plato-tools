# Chora's default basemap

A quiet map of the world served from the page's own origin, so that opening Chora sends nothing to
anyone: coast, countries and their borders, larger first-level divisions, lakes, rivers, and
places labelled by importance as the map zooms in. Everything here except `style.json` and this
file is written by `scripts/build-basemap.mjs` from pinned sources, and is committed.

## The URL convention: `{base}`

Every URL in `style.json` (the GeoJSON sources and the glyphs) begins with the literal text
`{base}/`. **The page must replace `{base}` with the absolute URL of this folder, with no trailing
slash, before handing the style to MapLibre**:

```js
const styleUrl = new URL('basemap/style.json', document.baseURI).href;
const base = new URL('.', styleUrl).href.replace(/\/$/, '');
const style = JSON.parse((await (await fetch(styleUrl)).text()).replaceAll('{base}', base));
new maplibregl.Map({ container, style });
```

Why not plain relative URLs: MapLibre resolves a relative source or glyph URL against the page,
not against the style, and resolving them against the style with `new URL()` would percent-encode
the braces of `{fontstack}` and `{range}` in the glyph template and break it. A plain text
replacement has neither problem, and leaves every request an absolute same-origin URL, which is
what Chora's `transformRequest` allows by default. The font folder's name has spaces
(`Noto Sans Regular`); MapLibre encodes them in the request, and any static host serves them.

## Files

| File | Size (bytes) | What it is |
|---|---:|---|
| `style.json` | 5,546 | the MapLibre style (hand-written; see below) |
| `land.geojson` | 837,144 | land polygons (Natural Earth 50m land) |
| `countries.geojson` | 1,154,081 | countries, for a faint tint: `iso`, `name`, `tint` (1–7, Natural Earth's MAPCOLOR7) |
| `boundaries.geojson` | 266,156 | country borders on land: `kind` (`international`, `disputed`, `control`, `indefinite`), `min_zoom` |
| `admin1.geojson` | 250,001 | first-level division borders (50m: large countries only), `min_zoom` |
| `lakes.geojson` | 261,908 | lakes: `name`, `min_zoom` |
| `rivers.geojson` | 358,297 | rivers and lake centre-lines: `name`, `rank`, `min_zoom` |
| `places.geojson` | 1,134,070 | 7,342 populated places (10m): `name`, `min_zoom`, `rank` (scalerank, 0 most important), `cap` (1 for a national capital), `iso` |
| `country-labels.geojson` | 36,882 | Natural Earth's label point per country: `name`, `iso`, `min_zoom`, `max_zoom` |
| `ccodes.json` | 8,010 | a bounding box for each ISO 3166-1 alpha-2 code (below) |
| `glyphs/Noto Sans Regular/*.pbf` | 781,564 | glyphs for 8 ranges: 0-255, 256-511, 512-767, 768-1023, 1024-1279, 7680-7935, 7936-8191, 8192-8447 (Latin, Latin Extended, Greek with polytonic, Cyrillic, punctuation) |
| `glyphs/Noto Sans Regular/OFL.txt` | 4,301 | the font's licence |
| `sources.json` | 4,512 | what was fetched (commit, sha256) and the sha256 of every file written |

About 5.1 MB in all, uncompressed; GitHub Pages sends the GeoJSON gzipped, at roughly a quarter of
that. Places come from the 10m set because 50m has too few for zoom 6 and beyond; geometry is 50m,
simplified (Visvalingam, 60% of vertices kept, no shape dropped) with coordinates to 4 decimals
(about 11 m, far finer than 50m's detail).

## `ccodes.json`

`{"GB":[w,s,e,n], ...}`: 247 codes, from `ISO_A2` of Natural Earth's 50m countries, else
`ISO_A2_EH` where `ISO_A2` is `-99` (France, Norway, Kosovo as `XK`), plus ten territories the 50m
countries fold into another, taken from the 50m map units (`SJ TK BQ YT RE MQ GP GF CX CC`). Areas
with no code at all (Somaliland, Northern Cyprus, Siachen Glacier) are left out.

- **The box fits the main landmass**, not every island: the largest polygon, plus every other
  polygon within 3 degrees of the box as it grows. So `FR` is European France (Guiana and Réunion
  have their own codes), `US` is the contiguous states (not Alaska or Hawaii), `NO` is mainland
  Norway. It is a view to fit a map to, not a test of whether a point is in the country.
- **Across the antimeridian, west > east**, as RFC 7946 writes such a box: at present `RU`
  (`[27.35,41.19,-169.72,81.86]`) and `FJ`. To fit the map to one, add 360 to east when east < west
  (`[w, s, e + 360, n]`); MapLibre's `fitBounds` accepts a longitude beyond 180. `AQ` is
  `[-180,-90,180,-60.52]`.
- Rounded outwards to 0.01 degree.

## Sources and licences

- **Natural Earth**, public domain: <https://www.naturalearthdata.com/>, from the official mirror
  [nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector) at commit
  `ca96624a56bd078437bca8184e78163e5039ad19`, its `geojson/` folder: `ne_50m_land`,
  `ne_50m_admin_0_countries`, `ne_50m_admin_0_map_units`, `ne_50m_admin_0_boundary_lines_land`,
  `ne_50m_admin_1_states_provinces_lines`, `ne_50m_lakes`, `ne_50m_rivers_lake_centerlines`,
  `ne_10m_populated_places_simple`. The sha256 of each is in the script and in `sources.json`.
- **Noto Sans**, SIL Open Font License 1.1 (`glyphs/Noto Sans Regular/OFL.txt`): OpenMapTiles'
  glyph build of Klokan Technologies' patched Noto Sans ("Klokantech Noto Sans Regular"), from
  [openmaptiles/fonts](https://github.com/openmaptiles/fonts), PBFs from the `gh-pages` branch at
  `025ff2b2f84cc0fdf11f7b1d74b3a784595fe7a4`, licence from `master` at
  `d48c5fce2fc58b55c98d353558d807cac45e7262` (`noto-sans/LICENSE`). Served here under the fontstack
  name `Noto Sans Regular`. Chosen over Open Sans, whose build has no polytonic Greek.

The map's attribution, carried by the `land` source: *Natural Earth (public domain). Borders are
Natural Earth's de-facto boundaries, not a statement on any dispute.* Disputed, indefinite and
line-of-control borders are drawn dashed.

## Rebuilding

```
node scripts/build-basemap.mjs
```

It fetches the pinned files into `.scratch/basemap-src/` (ignored by git; a second run uses them),
refuses any whose sha256 differs from the one recorded, simplifies with mapshaper (through
`npx`, at a pinned version, so it is not a dependency), writes this folder, and then checks that
every source and glyph range `style.json` names exists here. Run on the same pins, it reproduces
the committed files byte for byte (compare `sources.json`). To move to a newer Natural Earth or
font commit, change the commit in the script, run it with `--hashes` to print the new sha256s,
put them in the script, and run it again.

`style.json` is written by hand, not by the script: edit it freely, then run the script (or at
least check it) so that a reference to a file that is not here is caught.

## Limits

- 50m is a world-scale dataset: coasts are coarse beyond about zoom 7, and small islands are
  simplified to a few points. It is a reference to find a place by, not to trace a coast from.
- First-level divisions at 50m exist only for some large countries.
- Place names are Natural Earth's (mostly English or the common Latin form).
