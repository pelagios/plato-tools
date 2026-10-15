// The shaded relief over Natural Earth (#37; Stephen's decision of 14 October 2026), as Chora shows it and as a
// map made from Chora's view embeds it: one file built for these tools (scripts/relief/), served from this
// site's own address (basemap/relief.pmtiles, put there at build time from a GitHub release asset, checked
// against public/basemap/relief.pmtiles.sha256; not in the repository: it is 322 MB), read a tile at a time by
// HTTP range requests (pmtiles 4.3.0, src/chora/relief.js).
//
// The file's tiles are grey: flat land and sea at grey 181 (182 once WebP has decoded it), slopes lit from the
// north-west lighter, those turned from it darker. Drawn as they are, at any opacity, they would darken all flat
// ground as much as a hillside's light side lightens it. So each tile is toned (toneRelief) into a shade and a
// light of their own, with transparency: flat ground (within TOLERANCE of FLAT) is wholly transparent and keeps
// the basemap's own colour, a shadow is a warm dark at up to SHADE_MAX opacity, a lit slope white at up to
// LIGHT_MAX. The screen and the file draw the same toned tiles, so their relief is the same. Pure.

/** What is drawn here. */
export const RELIEF = Object.freeze({
  path: 'basemap/relief.pmtiles',
  attribution: 'Shaded relief from NASA SRTM (public domain); USGS GMTED2010 (public domain)',
  // Its own licence, in the shape a basemap's export field has (basemaps.js): public domain.
  licence: { iri: 'https://creativecommons.org/publicdomain/mark/1.0/', credit: 'Shaded relief from NASA SRTM and USGS GMTED2010 (public domain)', confirmed: true },
  templates: ['{{PD-USGov-NASA-SRTM}}', '{{PD-USGov-USGS}}'],
  // Where it is: zooms 0 to 10 over 15° W to 60° E and 15° N to 62° N, and zoom 11 over the Mediterranean.
  bounds: [-15, 15, 60, 62], minzoom: 0, maxzoom: 11, detail: { bounds: [-10, 28, 45, 47], zoom: 11 },
  coverage: 'Europe, North Africa and the Near East (15° W to 60° E, 15° N to 62° N), finest over the Mediterranean',
});
/** The grey of flat ground in the file, and how far from it a grey is still flat (WebP's rounding). */
export const FLAT = 181, TOLERANCE = 2;
/** The colours and greatest opacities of a shadow and of a lit slope. */
export const SHADE = [52, 44, 34], LIGHT = [255, 255, 255], SHADE_MAX = 0.6, LIGHT_MAX = 0.45;

/** The colour and opacity (0 to 255) a grey of the file is drawn as: [r, g, b, a]. */
export function toneOf(grey) {
  const d = grey - FLAT;
  if (Math.abs(d) <= TOLERANCE) return [0, 0, 0, 0];
  if (d < 0) return [...SHADE, Math.round(Math.min(1, (-d - TOLERANCE) / (FLAT - TOLERANCE)) * SHADE_MAX * 255)];
  return [...LIGHT, Math.round(Math.min(1, (d - TOLERANCE) / (255 - FLAT - TOLERANCE)) * LIGHT_MAX * 255)];
}
let table = null;
/** A tile's pixels (RGBA bytes, as a canvas gives them) toned in place: each pixel by its red channel's grey. A pixel already transparent stays so. */
export function toneRelief(rgba) {
  table ??= Array.from({ length: 256 }, (_, g) => toneOf(g));
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const t = table[rgba[i]];
    rgba[i] = t[0]; rgba[i + 1] = t[1]; rgba[i + 2] = t[2]; rgba[i + 3] = t[3];
  }
  return rgba;
}
