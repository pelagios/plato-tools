// Read relief.pmtiles over HTTP range requests with the pmtiles JS library.
// usage: node jscheck.mjs <url>   (run with NODE_PATH-free import from jscheck/)
import { PMTiles } from "pmtiles";
const url = process.argv[2];
const p = new PMTiles(url);
const h = await p.getHeader();
const m = await p.getMetadata();
console.log("header", { minZoom: h.minZoom, maxZoom: h.maxZoom, tileType: h.tileType, tiles: h.numAddressedTiles,
  bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat] });
console.log("metadata.attribution:", m.attribution);
const probes = [[0,0,0],[3,4,3],[8,143,98],[10,575,395],[11,1165,808],[11,0,0]];
let bad = 0;
for (const [z,x,y] of probes) {
  const t = await p.getZxy(z,x,y);
  const riff = t && Buffer.from(t.data.slice(0,4)).toString() === "RIFF" && Buffer.from(t.data.slice(8,12)).toString() === "WEBP";
  console.log(`z${z}/${x}/${y}`, t ? `${t.data.byteLength} B ${riff ? "webp" : "NOT WEBP"}` : "absent");
  if ((z === 11 && x === 0) ? t : !(t && riff)) bad++;
}
if (bad) { console.error("FAIL", bad); process.exit(1); } else console.log("OK");
