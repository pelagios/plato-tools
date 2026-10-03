// Grid references of the Ordnance Survey's National Grid (Great Britain, OSGB36) and of the Irish
// Grid (TM65), read as WGS 84 longitude and latitude, for a column of a table of places read as
// `gridref` (columns.js).
//
// A reference is letters naming a 100 km square, then an even number of digits, half eastings and
// half northings within it ("TQ 33760 80560", "SU1234", "TQ3380"; Irish "O 15 34"). n digits per axis
// name a square of 10^(5-n) m: letters alone 100 km, two figures 10 km, four 1 km, six 100 m, eight
// 10 m, ten 1 m. The point given is the CENTRE of that square, not its south-west corner, and its
// precision is the square's half diagonal (the farthest any point of the square is from the centre),
// or the transformation's own accuracy where that is larger.
//
// The conversion, "done properly", in three steps:
//   1. letters and digits -> eastings and northings (the 500 km and 100 km squares);
//   2. eastings and northings -> latitude and longitude on the grid's own datum: the inverse
//      Transverse Mercator of Ordnance Survey, "A Guide to Coordinate Systems in Great Britain"
//      (v3.6, 2020), annex C (equations C6-C9), on Airy 1830 (National Grid) or Airy 1830 modified
//      (Irish Grid), with the projection constants of its table A.2;
//   3. that datum -> WGS 84, by a 7-parameter Helmert transformation (position vector convention,
//      the guide's equation 3 and annex B for the Cartesian steps):
//        - OSGB36: the guide's table 4 (section 6.6), WGS 84 -> OSGB36, reversed by changing the
//          sign of every parameter as section 6.2 says; error up to 3.5 m (95%), and not for use
//          outside Britain;
//        - TM65 (Irish Grid): EPSG transformation 1641, "TM65 to WGS 84 (2)", whose values are
//          Ordnance Survey Ireland's TM75 to ETRS89 (EPSG 1953); accuracy 1 m as EPSG states it.
// OSTN15, the OS's definitive grid transformation (about 0.1 m), would replace step 3 for Great
// Britain; it is not used (its grid file is about 15 MB), and each location's note says so.

/** Ellipsoids, as the OS guide's table A.1 gives them (b of Airy 1830 to its corrected .9091). */
const AIRY_1830 = { a: 6377563.396, b: 6356256.9091 };
const AIRY_MODIFIED = { a: 6377340.189, b: 6356034.447 };
const GRS80 = { a: 6378137, b: 6356752.3141 };
const RAD = Math.PI / 180, SEC = RAD / 3600;

/** The two grids: projection (table A.2), letters, extent, and the Helmert transformation to WGS 84. */
export const GRIDS = {
  osgb: {
    name: 'Ordnance Survey National Grid (OSGB36)', ellipsoid: AIRY_1830,
    F0: 0.9996012717, phi0: 49 * RAD, lambda0: -2 * RAD, E0: 400000, N0: -100000,
    maxE: 700000, maxN: 1300000,
    // OS guide table 4 is WGS 84 -> OSGB36; reversed by changing every sign (section 6.2).
    helmert: { tx: 446.448, ty: -125.157, tz: 542.060, s: -20.4894, rx: 0.1502, ry: 0.2470, rz: 0.8421 },
    accuracyM: 3.5,
    transformation: "Ordnance Survey's 7-parameter Helmert transformation from OSGB36 to WGS 84 (A Guide to Coordinate Systems in Great Britain, section 6.6, reversed), whose error is up to 3.5 m (95%)",
  },
  irish: {
    name: 'Irish Grid (TM65)', ellipsoid: AIRY_MODIFIED,
    F0: 1.000035, phi0: 53.5 * RAD, lambda0: -8 * RAD, E0: 200000, N0: 250000,
    maxE: 500000, maxN: 500000,
    // EPSG 1641, TM65 to WGS 84 (2), position vector: Ordnance Survey Ireland's parameters.
    helmert: { tx: 482.5, ty: -130.6, tz: 564.6, s: 8.15, rx: -1.042, ry: -0.214, rz: -0.631 },
    accuracyM: 1,
    transformation: "the 7-parameter Helmert transformation from TM65 to WGS 84 (EPSG 1641, from Ordnance Survey Ireland's parameters), accurate to about 1 m",
  },
};

const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';   // 25: I is not used
// A letter's column (west to east) and row (south to north) in a 5 x 5 block of squares, A at the north-west.
const cell = (l) => { const i = LETTERS.indexOf(l); return [i % 5, 4 - Math.floor(i / 5)]; };

/** Two letters and digits, or one letter and digits, as a value of a grid reference column might hold. */
const SHAPE = /^([A-Z]{1,2})((?:\s*\d+){0,2})$/;

/**
 * A grid reference read, or why it cannot be: { grid: 'osgb' | 'irish', letters, digits (per axis),
 * sizeM (the square's side), easting, northing (its south-west corner), text } or { error }.
 */
export function parseGridRef(text) {
  const t = String(text ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  const m = SHAPE.exec(t);
  if (!m) return { error: 'it is not a grid reference (two letters and digits, such as TQ 33760 80560, or for the Irish Grid one letter and digits, such as O 15 34)' };
  const letters = m[1], groups = m[2].trim() ? m[2].trim().split(' ') : [];
  if (letters.includes('I')) return { error: 'the letter I is not used in grid references' };
  let east, north;
  if (groups.length === 2) {
    if (groups[0].length !== groups[1].length) return { error: `its two groups of digits differ in length (${groups[0].length} and ${groups[1].length}), so the eastings and northings are not to the same precision` };
    [east, north] = groups;
  } else {
    const d = groups[0] || '';
    if (d.length % 2) return { error: `it has an odd number of digits (${d.length}), so its eastings and northings cannot be told apart` };
    [east, north] = [d.slice(0, d.length / 2), d.slice(d.length / 2)];
  }
  const digits = east.length;
  if (digits > 5) return { error: `it has ${2 * digits} digits, more than the ten (to 1 m) a grid reference has` };
  const sizeM = 10 ** (5 - digits);
  const within = (s) => (digits ? Number(s) * sizeM : 0);
  let grid, E, N;
  if (letters.length === 2) {
    grid = 'osgb';
    const [c1, r1] = cell(letters[0]), [c2, r2] = cell(letters[1]);
    // The false origin is the south-west corner of the 500 km square S.
    E = (c1 - 2) * 500000 + c2 * 100000; N = (r1 - 1) * 500000 + r2 * 100000;
    if (E < 0 || N < 0 || E >= GRIDS.osgb.maxE || N >= GRIDS.osgb.maxN) return { error: `${letters} is not a 100 km square of the National Grid` };
  } else {
    grid = 'irish';
    const [c, r] = cell(letters);
    E = c * 100000; N = r * 100000;   // V is the false origin's square
  }
  return { grid, letters, digits, sizeM, easting: E + within(east), northing: N + within(north), text: t };
}

// ---- the projection (OS guide, annex C) ----------------------------------------------------------
function meridional(g, phi) {
  const { a, b } = g.ellipsoid, n = (a - b) / (a + b), n2 = n * n, n3 = n2 * n;
  const d = phi - g.phi0, s = phi + g.phi0;
  return b * g.F0 * ((1 + n + 5 / 4 * n2 + 5 / 4 * n3) * d - (3 * n + 3 * n2 + 21 / 8 * n3) * Math.sin(d) * Math.cos(s)
    + (15 / 8 * n2 + 15 / 8 * n3) * Math.sin(2 * d) * Math.cos(2 * s) - 35 / 24 * n3 * Math.sin(3 * d) * Math.cos(3 * s));
}
function radii(g, phi) {
  const { a, b } = g.ellipsoid, e2 = (a * a - b * b) / (a * a), sin2 = Math.sin(phi) ** 2;
  const nu = a * g.F0 / Math.sqrt(1 - e2 * sin2), rho = a * g.F0 * (1 - e2) / (1 - e2 * sin2) ** 1.5;
  return { nu, rho, eta2: nu / rho - 1 };
}

/** Eastings and northings -> [latitude, longitude] in degrees on the grid's own datum (C6-C9). */
export function gridToLatLon(gridName, E, N) {
  const g = GRIDS[gridName], { a } = g.ellipsoid;
  let phi = (N - g.N0) / (a * g.F0) + g.phi0, M = meridional(g, phi);
  for (let i = 0; i < 20 && Math.abs(N - g.N0 - M) >= 1e-5; i++) { phi += (N - g.N0 - M) / (a * g.F0); M = meridional(g, phi); }
  const { nu, rho, eta2 } = radii(g, phi), t = Math.tan(phi), t2 = t * t, t4 = t2 * t2, t6 = t4 * t2, sec = 1 / Math.cos(phi);
  const VII = t / (2 * rho * nu), VIII = t / (24 * rho * nu ** 3) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2), IX = t / (720 * rho * nu ** 5) * (61 + 90 * t2 + 45 * t4);
  const X = sec / nu, XI = sec / (6 * nu ** 3) * (nu / rho + 2 * t2), XII = sec / (120 * nu ** 5) * (5 + 28 * t2 + 24 * t4), XIIA = sec / (5040 * nu ** 7) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
  const dE = E - g.E0;
  return [(phi - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6) / RAD, (g.lambda0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7) / RAD];
}

/** [latitude, longitude] in degrees on the grid's datum -> [easting, northing] (C1-C5); the tests' check of the inverse. */
export function latLonToGrid(gridName, lat, lon) {
  const g = GRIDS[gridName], phi = lat * RAD, { nu, rho, eta2 } = radii(g, phi);
  const s = Math.sin(phi), c = Math.cos(phi), t2 = Math.tan(phi) ** 2, t4 = t2 * t2, L = lon * RAD - g.lambda0;
  const I = meridional(g, phi) + g.N0, II = nu / 2 * s * c, III = nu / 24 * s * c ** 3 * (5 - t2 + 9 * eta2), IIIA = nu / 720 * s * c ** 5 * (61 - 58 * t2 + t4);
  const IV = nu * c, V = nu / 6 * c ** 3 * (nu / rho - t2), VI = nu / 120 * c ** 5 * (5 - 18 * t2 + t4 + 14 * eta2 - 58 * t2 * eta2);
  return [g.E0 + IV * L + V * L ** 3 + VI * L ** 5, I + II * L ** 2 + III * L ** 4 + IIIA * L ** 6];
}

// ---- the datum (OS guide, annex B and equation 3) ------------------------------------------------
function toCartesian({ a, b }, lat, lon, h = 0) {
  const e2 = (a * a - b * b) / (a * a), phi = lat * RAD, lam = lon * RAD, nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return [(nu + h) * Math.cos(phi) * Math.cos(lam), (nu + h) * Math.cos(phi) * Math.sin(lam), ((1 - e2) * nu + h) * Math.sin(phi)];
}
function fromCartesian({ a, b }, [x, y, z]) {
  const e2 = (a * a - b * b) / (a * a), p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e2)), prev = Infinity;
  for (let i = 0; i < 20 && Math.abs(phi - prev) >= 1e-12; i++) { prev = phi; const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2); phi = Math.atan2(z + e2 * nu * Math.sin(phi), p); }
  return [phi / RAD, Math.atan2(y, x) / RAD];
}
/** A Helmert transformation of Cartesian coordinates, position vector convention (the OS guide's D2). */
export function helmert([x, y, z], { tx, ty, tz, s, rx, ry, rz }) {
  const k = 1 + s * 1e-6, X = rx * SEC, Y = ry * SEC, Z = rz * SEC;
  return [tx + k * x - Z * y + Y * z, ty + Z * x + k * y - X * z, tz - Y * x + X * y + k * z];
}
/** [latitude, longitude] on the grid's datum -> WGS 84 [latitude, longitude], through its Helmert. */
export function datumToWgs84(gridName, lat, lon) {
  const g = GRIDS[gridName];
  return fromCartesian(GRS80, helmert(toCartesian(g.ellipsoid, lat, lon), g.helmert));
}
/** WGS 84 [latitude, longitude] -> the grid's datum, by the parameters with every sign changed; for the tests. */
export function wgs84ToDatum(gridName, lat, lon, h = 0) {
  const g = GRIDS[gridName], p = Object.fromEntries(Object.entries(g.helmert).map(([k, v]) => [k, -v]));
  return fromCartesian(g.ellipsoid, helmert(toCartesian(GRS80, lat, lon, h), p));
}

// ---- a reference as a PLATO location ---------------------------------------------------------------
const round = (x, places) => Math.round(x * 10 ** places) / 10 ** places;
const SQUARE_WORDS = { 100000: '100 km', 10000: '10 km', 1000: '1 km', 100: '100 m', 10: '10 m', 1: '1 m' };

/**
 * A grid reference as WGS 84: { lon, lat, precisionKm, approximate, sizeM, grid, note } or { error }.
 * The point is the centre of the reference's square; precisionKm the larger of the square's half
 * diagonal and the transformation's accuracy; `approximate` for a square of 1 km or more.
 */
export function gridRefToWgs84(text) {
  const r = parseGridRef(text);
  if (r.error) return r;
  const g = GRIDS[r.grid], half = r.sizeM / 2;
  const [phi, lam] = gridToLatLon(r.grid, r.easting + half, r.northing + half);
  const [lat, lon] = datumToWgs84(r.grid, phi, lam);
  const precisionM = Math.max(half * Math.SQRT2, g.accuracyM);
  const note = `Location from the grid reference ${String(text).trim()} (${g.name}): the centre of its ${SQUARE_WORDS[r.sizeM]} square, `
    + `easting ${r.easting + half} m, northing ${r.northing + half} m, converted to WGS 84 by ${g.transformation}; `
    + `to within ${round(precisionM / 1000, 4)} km (the square's half diagonal, or the transformation's accuracy where that is larger)`;
  return { lon: round(lon, 7), lat: round(lat, 7), precisionKm: round(precisionM / 1000, 6), approximate: r.sizeM >= 1000, sizeM: r.sizeM, grid: r.grid, note };
}

/** Whether a value has the shape of a grid reference with digits (for guessing a column from its values). */
export const looksLikeGridRef = (v) => /\d/.test(String(v)) && !parseGridRef(v).error;
