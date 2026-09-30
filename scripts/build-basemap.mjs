// Build Chora's default basemap, public/basemap/, from Natural Earth and one glyph font, both
// fetched from pinned commits and checked against the sha256 recorded here. The outputs are
// committed: this script is their provenance, and running it again must reproduce them byte for
// byte (it checks the style's references too). Nothing it writes is fetched by a page from anywhere
// but the page's own origin.
//   node scripts/build-basemap.mjs            fetch (into .scratch/basemap-src/), check, build
//   node scripts/build-basemap.mjs --hashes   print the sha256 of what is fetched, to re-pin
// Simplification is by mapshaper, run through npx at a pinned version, so it is not a dependency.
import { mkdir, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Natural Earth (public domain), from the official mirror; the geojson/ folder there is Natural
// Earth's own conversion of its shapefiles.
const NE_REPO = 'nvkelso/natural-earth-vector';
const NE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const NE = {
  ne_50m_land: 'e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b',
  ne_50m_admin_0_countries: '3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb',
  ne_50m_admin_0_map_units: 'b8d421aca6e9e08e8cdf09cc26af111cc3e0deba4fe915611d58ade71e8a4db0',
  ne_50m_admin_0_boundary_lines_land: '2faac4f6b34386f3d21b6e018cf151f241f00e5c936d44dd17d7d9bfb147fa48',
  ne_50m_admin_1_states_provinces_lines: '72cca93c850d412628a5da4bc5ebfe21ba4d376eb34611bde6b623ee73f0fdcf',
  ne_50m_lakes: 'd350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52',
  ne_50m_rivers_lake_centerlines: 'f286e0ce978fde999ca2d7a78c764be08542e19b63cded52b05c12d5173ccc51',
  ne_10m_populated_places_simple: 'fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f',
};
// Glyphs: OpenMapTiles' build of Noto Sans (SIL OFL 1.1), Klokan Technologies' patched Noto Sans,
// which unlike Open Sans has polytonic Greek (7936-8191). The PBFs are on the gh-pages branch; the
// licence is beside the font sources on master.
const FONT_REPO = 'openmaptiles/fonts';
const FONT_PBF_COMMIT = '025ff2b2f84cc0fdf11f7b1d74b3a784595fe7a4';
const FONT_LICENCE_COMMIT = 'd48c5fce2fc58b55c98d353558d807cac45e7262';
const FONT_UPSTREAM = 'Klokantech Noto Sans Regular';
const FONT = 'Noto Sans Regular'; // the fontstack name the style uses, and the folder's name
const GLYPHS = {
  '0-255': '2b5324d3fcaa58f93c71d4e6ee70eba532f15585401d764daf99efc427a62693', // Basic Latin, Latin-1
  '256-511': '052e7e11d0420e7a6772478413f5d2bb910d150f76830bdf17dfabcabe87aaf1', // Latin Extended-A, -B
  '512-767': '521d978d95db4d0d0339c8412e74af218218ae8a5967a15dbab8b3aa59b32e5c', // Latin Extended-B, IPA, modifiers
  '768-1023': 'fc704a0ce14b2d2fbbc67faa588f9653a933930b852c62f643199a89e7bad134', // combining marks, Greek
  '1024-1279': 'f7777f998395744d9164e46ef1ae8b451bc79938c146daa9ff891590062766cf', // Cyrillic
  '7680-7935': 'ef53e5a0534cef3b320ceb0708422be1b67b97f04860a2c76e86cebad727c142', // Latin Extended Additional
  '7936-8191': 'dc77455acc58cc930bef8f5e2bc647ef31f928fe579b74e6d0fce55021cbd9a7', // Greek Extended
  '8192-8447': 'a62e17817c512a5991bdc2167f952d90633570d1bdf7e76d80a456cfff7fd67a', // punctuation
};
const FONT_LICENCE_SHA = '6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2';
const MAPSHAPER = 'mapshaper@0.7.71';

const CACHE = '.scratch/basemap-src';
const OUT = 'public/basemap';
const PRINT = process.argv.includes('--hashes');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchPinned(url, file, expected) {
  if (!existsSync(file)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
  }
  const buf = await readFile(file);
  const got = sha256(buf);
  if (PRINT) console.log(`${got}  ${url}`);
  else if (got !== expected) throw new Error(`${file}: sha256 ${got}, expected ${expected} (${url})`);
  return buf;
}

await mkdir(`${CACHE}/glyphs`, { recursive: true });
const src = {};
for (const [name, hash] of Object.entries(NE)) {
  const url = `https://raw.githubusercontent.com/${NE_REPO}/${NE_COMMIT}/geojson/${name}.geojson`;
  src[name] = JSON.parse(await fetchPinned(url, `${CACHE}/${name}.geojson`, hash));
}
const glyphs = {};
for (const [range, hash] of Object.entries(GLYPHS)) {
  const url = `https://raw.githubusercontent.com/${FONT_REPO}/${FONT_PBF_COMMIT}/${encodeURIComponent(FONT_UPSTREAM)}/${range}.pbf`;
  glyphs[range] = await fetchPinned(url, `${CACHE}/glyphs/${range}.pbf`, hash);
}
const licence = await fetchPinned(`https://raw.githubusercontent.com/${FONT_REPO}/${FONT_LICENCE_COMMIT}/noto-sans/LICENSE`,
  `${CACHE}/glyphs/LICENSE`, FONT_LICENCE_SHA);
if (PRINT) process.exit(0);

// --- Helpers ---------------------------------------------------------------------------------

const r4 = (x) => Math.round(x * 1e4) / 1e4; // about 11 m at the equator: far below 50m's detail
const fc = (features) => ({ type: 'FeatureCollection', features });
// One feature per line: small diffs when Natural Earth is re-pinned, and still compact.
const dump = (col) => '{"type":"FeatureCollection","features":[\n'
  + col.features.map((f) => JSON.stringify({ type: 'Feature', properties: f.properties ?? {}, geometry: f.geometry })).join(',\n') + '\n]}\n';
const ne2 = (p) => (p.ISO_A2 && p.ISO_A2 !== '-99' ? p.ISO_A2 : p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : null);
const minZoom = (p) => Math.round(Number(p.min_zoom ?? p.MIN_ZOOM ?? 0) * 10) / 10;

// Reduce a layer to the properties the style uses, before mapshaper sees it.
function pick(col, fn) {
  return fc(col.features.filter((f) => f.geometry).map((f) => ({ type: 'Feature', properties: fn(f.properties), geometry: f.geometry })));
}
const BOUNDARY = {
  'International boundary (verify)': 'international', 'Disputed (please verify)': 'disputed',
  'Line of control (please verify)': 'control', 'Indefinite (please verify)': 'indefinite',
  'Indeterminant frontier': 'indefinite',
};
const layers = {
  land: pick(src.ne_50m_land, () => ({})),
  countries: pick(src.ne_50m_admin_0_countries, (p) => ({ iso: ne2(p), name: p.NAME, tint: p.MAPCOLOR7 })),
  boundaries: pick(src.ne_50m_admin_0_boundary_lines_land, (p) => {
    const kind = BOUNDARY[p.FEATURECLA];
    if (!kind) throw new Error(`unknown boundary class ${p.FEATURECLA}`);
    return { kind, min_zoom: minZoom(p) };
  }),
  admin1: pick(src.ne_50m_admin_1_states_provinces_lines, (p) => ({ min_zoom: minZoom(p) })),
  lakes: pick(src.ne_50m_lakes, (p) => ({ name: p.name || '', min_zoom: minZoom(p) })),
  rivers: pick(src.ne_50m_rivers_lake_centerlines, (p) => ({ name: p.name || '', rank: p.scalerank, min_zoom: minZoom(p) })),
};

// Simplify each layer with mapshaper: Visvalingam keeping 60% of the vertices, keeping every shape
// however small (islands), repairing the intersections simplification makes, with coordinates
// rounded to 4 decimals. Each layer alone: Natural Earth's land and its countries do not share
// coastline vertices exactly, so simplifying them together makes their edges cross thousands of
// times, which mapshaper cannot repair. The country tint is drawn over the land in a near-identical
// colour, so the coasts' small differences do not show.
const work = `${CACHE}/work`;
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const names = Object.keys(layers);
for (const name of names) {
  await writeFile(`${work}/${name}.json`, JSON.stringify(layers[name]));
  execFileSync('npx', ['-y', MAPSHAPER, `${work}/${name}.json`, '-simplify', '60%', 'keep-shapes',
    '-o', `${work}/${name}.out.json`, 'format=geojson', 'geojson-type=FeatureCollection', 'precision=0.0001'],
  { stdio: ['ignore', 'inherit', 'pipe'] });
}

// --- Places: points, so no simplification; the 10m set, because 50m has too few for zoom 6+.
const places = fc(src.ne_10m_populated_places_simple.features.map((f) => {
  const p = f.properties;
  return {
    type: 'Feature',
    properties: {
      name: p.name, min_zoom: minZoom(p), rank: p.scalerank, cap: p.adm0cap ? 1 : 0, iso: p.iso_a2 === '-99' ? null : p.iso_a2,
    },
    geometry: { type: 'Point', coordinates: f.geometry.coordinates.map(r4) },
  };
}).sort((a, b) => a.properties.rank - b.properties.rank || a.properties.name.localeCompare(b.properties.name, 'en')));

// --- Country labels: Natural Earth's own label points, and its zoom range for each.
const countryLabels = fc(src.ne_50m_admin_0_countries.features.map((f) => {
  const p = f.properties;
  return {
    type: 'Feature',
    properties: { name: p.NAME, iso: ne2(p), min_zoom: p.MIN_LABEL, max_zoom: p.MAX_LABEL },
    geometry: { type: 'Point', coordinates: [r4(p.LABEL_X), r4(p.LABEL_Y)] },
  };
}));

// --- ccodes.json: a bounding box for each ISO 3166-1 alpha-2 code, from the unsimplified 50m
// countries, plus the territories Natural Earth's 50m countries fold into another (from its map
// units). The box fits the country's main landmass: the largest polygon, and every other polygon
// within GAP degrees of the box as it grows. So France is European France, not France with
// Guiana and Réunion, and the United States is the contiguous states. Longitudes are unwrapped
// around the largest polygon first, so a country across the antimeridian (Russia, Fiji) gets
// west > east, as RFC 7946 (GeoJSON) writes such a box. Rounded outwards to 0.01 degree.
const GAP = 3;
const MAP_UNITS = { 'Svalbard Is.': 'SJ', Tokelau: 'TK', 'Caribbean Netherlands': 'BQ', Mayotte: 'YT', 'Réunion': 'RE',
  Martinique: 'MQ', Guadeloupe: 'GP', 'French Guiana': 'GF', 'Christmas I.': 'CX', 'Cocos Is.': 'CC' };
function parts(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.map((poly) => {
    const ring = poly[0];
    let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity; let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = ring[i]; const [x2, y2] = ring[(i + 1) % ring.length];
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
      a += x * y2 - x2 * y;
    }
    return { w, s, e, n, area: Math.abs(a / 2) * Math.cos(((s + n) / 2) * Math.PI / 180) };
  });
}
function mainBox(ps) {
  ps.sort((a, b) => b.area - a.area);
  const box = { ...ps[0] };
  const c0 = (box.w + box.e) / 2;
  const rest = ps.slice(1).map((p) => {
    const shift = Math.round((c0 - (p.w + p.e) / 2) / 360) * 360;
    return { ...p, w: p.w + shift, e: p.e + shift };
  });
  for (let grew = true; grew;) {
    grew = false;
    for (let i = rest.length - 1; i >= 0; i--) {
      const p = rest[i];
      if (p.w <= box.e + GAP && p.e >= box.w - GAP && p.s <= box.n + GAP && p.n >= box.s - GAP) {
        box.w = Math.min(box.w, p.w); box.e = Math.max(box.e, p.e);
        box.s = Math.min(box.s, p.s); box.n = Math.max(box.n, p.n);
        rest.splice(i, 1); grew = true;
      }
    }
  }
  const down = (x) => Math.floor(x * 100) / 100; const up = (x) => Math.ceil(x * 100) / 100;
  if (box.e - box.w >= 359.99) return [-180, down(box.s), 180, up(box.n)];
  const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
  let w = wrap(box.w); let e = wrap(box.e);
  if (box.e === 180 || (box.e > 180 && e === -180)) e = 180; // keep a box that ends on 180 from wrapping
  if (box.w === -180) w = -180;
  return [down(w), down(box.s), up(e), up(box.n)];
}
const byCode = new Map();
const add = (code, geom) => { if (code) byCode.set(code, [...(byCode.get(code) || []), ...parts(geom)]); };
for (const f of src.ne_50m_admin_0_countries.features) add(ne2(f.properties), f.geometry);
for (const f of src.ne_50m_admin_0_map_units.features) {
  const code = MAP_UNITS[f.properties.NAME];
  if (code && !byCode.has(code)) add(code, f.geometry);
}
for (const code of Object.values(MAP_UNITS)) if (!byCode.has(code)) throw new Error(`map unit ${code} not found`);
const ccodes = Object.fromEntries([...byCode.keys()].sort().map((c) => [c, mainBox(byCode.get(c))]));

// --- Write -----------------------------------------------------------------------------------

await mkdir(`${OUT}/glyphs/${FONT}`, { recursive: true });
const written = {};
const put = async (rel, data) => { await writeFile(join(OUT, rel), data); written[rel] = data; };
for (const name of names) {
  const col = JSON.parse(await readFile(`${work}/${name}.out.json`, 'utf8'));
  await put(`${name}.geojson`, dump(col));
}
await put('places.geojson', dump(places));
await put('country-labels.geojson', dump(countryLabels));
await put('ccodes.json', '{\n' + Object.entries(ccodes).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n') + '\n}\n');
for (const [range, buf] of Object.entries(glyphs)) await put(`glyphs/${FONT}/${range}.pbf`, buf);
await put(`glyphs/${FONT}/OFL.txt`, licence);
const sources = {
  note: 'Written by scripts/build-basemap.mjs. Inputs fetched from pinned commits and checked by sha256.',
  naturalEarth: { repository: `https://github.com/${NE_REPO}`, commit: NE_COMMIT, licence: 'public domain',
    files: Object.fromEntries(Object.entries(NE).map(([k, v]) => [`geojson/${k}.geojson`, v])) },
  glyphs: { repository: `https://github.com/${FONT_REPO}`, font: FONT_UPSTREAM, pbfCommit: FONT_PBF_COMMIT,
    licenceCommit: FONT_LICENCE_COMMIT, licence: 'SIL Open Font License 1.1',
    files: { ...Object.fromEntries(Object.entries(GLYPHS).map(([k, v]) => [`${FONT_UPSTREAM}/${k}.pbf`, v])), 'noto-sans/LICENSE': FONT_LICENCE_SHA } },
  mapshaper: MAPSHAPER,
  outputs: Object.fromEntries(Object.entries(written).map(([k, v]) => [k, sha256(v)])),
};
await put('sources.json', JSON.stringify(sources, null, 2) + '\n');

// --- Check the style: every source and glyph range it names must be here --------------------

const style = JSON.parse(await readFile(`${OUT}/style.json`, 'utf8'));
const local = (u) => {
  if (!u.startsWith('{base}/')) throw new Error(`style.json: ${u} is not under {base}/`);
  return join(OUT, u.slice('{base}/'.length));
};
for (const [id, s] of Object.entries(style.sources)) {
  if (typeof s.data !== 'string' || !existsSync(local(s.data))) throw new Error(`style.json: source ${id} has no file here`);
}
const fonts = new Set(style.layers.flatMap((l) => l.layout?.['text-font'] || []));
for (const font of fonts) {
  for (const range of Object.keys(GLYPHS)) {
    const f = local(style.glyphs.replace('{fontstack}', font).replace('{range}', range));
    if (!existsSync(f)) throw new Error(`style.json: glyphs ${f} missing`);
  }
}
let total = 0;
for (const f of (await readdir(OUT, { recursive: true }))) {
  const st = await stat(join(OUT, f));
  if (st.isFile()) { total += st.size; console.log(`${String(st.size).padStart(9)}  ${f}`); }
}
console.log(`${String(total).padStart(9)}  total, ${Object.keys(ccodes).length} country codes`);
