// Makes allmaps-render-reference.json: where Allmaps' own renderer puts points of the fixture maps.
// @allmaps/render builds, for each map, a ProjectedGcpTransformer from @allmaps/project with the
// annotation's control points and its default options (internal projection and projection both
// EPSG:3857, as WarpedMap does when the annotation names no resourceCrs), and draws with its
// forward transformation. This does the same, and records transformToGeo (WGS84) at every control
// point and at a 5 x 5 grid inside each image, for each transformation type.
//
// @allmaps/project is not a dependency of plato-tools, so give the path to its dist/index.js:
//   npm install --prefix /tmp/x @allmaps/project@1.0.0-beta.10 @allmaps/transform@1.0.0-beta.53
//   node test/fixtures/georef/make-allmaps-render-reference.mjs /tmp/x/node_modules/@allmaps/project/dist/index.js
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectPath = process.argv[2];
const { ProjectedGcpTransformer } = await import(projectPath);
const version = (pkg) => JSON.parse(readFileSync(join(dirname(projectPath), '..', '..', '..', pkg, 'package.json'), 'utf8')).version;
const CASES = [
  ['bpl-rocque-annotation.json', 0],
  ['bpl-british-dominions-annotation.json', 0],
  ['lynn-atlas-annotationpage.json', 7],
];
const TYPES = ['polynomial', 'polynomial2', 'polynomial3', 'thinPlateSpline', 'projective', 'helmert'];
const out = {
  made: new Date().toISOString().slice(0, 10),
  software: { '@allmaps/project': version('@allmaps/project'), '@allmaps/transform': version('@allmaps/transform'), proj4: version('proj4') },
  cases: [],
};
for (const [file, index] of CASES) {
  const doc = JSON.parse(readFileSync(join(here, file), 'utf8'));
  const a = doc.type === 'AnnotationPage' ? doc.items[index] : doc;
  const gcps = a.body.features.map((f) => ({ resource: f.properties.resourceCoords, geo: f.geometry.coordinates }));
  const { width, height } = a.target.source;
  const points = gcps.map((g) => g.resource);
  for (let i = 1; i <= 5; i++) for (let k = 1; k <= 5; k++) points.push([Math.round((width * i) / 6), Math.round((height * k) / 6)]);
  for (const type of TYPES) {
    const t = new ProjectedGcpTransformer(gcps, type);
    const results = [];
    for (const p of points) {
      const w = t.transformToGeo(p);
      if (w.every(Number.isFinite) && Math.abs(w[1]) < 85) results.push({ pixel: p, lonLat: w });
    }
    out.cases.push({ file, index, annotationId: a.id, type, results });
  }
}
writeFileSync(join(here, 'allmaps-render-reference.json'), JSON.stringify(out, null, 0) + '\n');
console.log(out.cases.map((c) => `${c.file} ${c.type}: ${c.results.length}`).join('\n'));
