// The worker's memory for tracing with assistance (the design's budget: 64 MB), measured in Node on the
// worker's own code (src/engine/chora/ink/step.js), since a worker busy with a trace cannot be asked from
// outside until it has finished. Each case runs in a process of its own; what is reported is the most
// resident memory it reached above what it held once its tiles were made (the tiles, as the worker keeps
// them, are reported beside). Resident memory counts garbage not yet collected too: an upper bound.
//
//     node e2e/ink_memory.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CASES = [['line', 2048, 2048], ['line', 2049, 1537], ['area', 1024, 1024], ['area', 2048, 2048]];

if (process.argv[2] !== 'case') {
  const me = fileURLToPath(import.meta.url);
  for (const c of CASES) {
    const r = spawnSync(process.execPath, ['--expose-gc', me, 'case', ...c.map(String)], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    console.log(`${out.mode} ${out.W} x ${out.H}: tiles ${out.tilesMB} MB, peak above them ${out.peakAboveTilesMB} MB, in all ${(out.tilesMB + out.peakAboveTilesMB).toFixed(1)} MB`);
  }
} else {
  const { Raster, INK, rng } = await import('../test/ink-synth.js');
  const { traceStep, createPrepCache } = await import('../src/engine/chora/ink/step.js');
  const [mode, W, H] = [process.argv[3], +process.argv[4], +process.argv[5]];
  // A map of linework and a winding line, and an area, cut into 512-pixel tiles of RGBA.
  const r = new Raster(W, H); const g = rng(2);
  for (let k = 0; k < 120; k++) { const x = g() * W, y = g() * H; r.stroke([[x, y], [x + (g() - 0.5) * 500, y + (g() - 0.5) * 500]], 2 + g() * 2, INK); }
  r.stroke(Array.from({ length: W - 200 }, (_, k) => [100 + k, H / 2 + (H / 3) * Math.sin(k / 160)]), 3, INK);
  r.polygon([[200, 200], [800, 220], [820, 800], [230, 760]], [176, 198, 150]);
  const tiles = [];
  for (let y = 0; y < H; y += 512) for (let x = 0; x < W; x += 512) {
    const w = Math.min(512, W - x), h = Math.min(512, H - y), data = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j++) data.set(r.rgba.subarray(((y + j) * W + x) * 4, ((y + j) * W + x + w) * 4), j * w * 4);
    tiles.push({ region: { x, y, width: w, height: h }, width: w, height: h, data });
  }
  r.rgba = null; globalThis.gc();
  const before = process.resourceUsage().maxRSS;
  const frame = { x0: 0, y0: 0, s: 1, w: W, h: H };
  traceStep({ frame, tiles, seed: mode === 'line' ? [101, Math.round(H / 2)] : [500, 500], mode, params: mode === 'line' ? { seedRadius: 3 } : {} }, createPrepCache());
  const after = process.resourceUsage().maxRSS;
  console.log(JSON.stringify({ mode, W, H, tilesMB: +(tiles.reduce((s, t) => s + t.data.length, 0) / 2 ** 20).toFixed(1), peakAboveTilesMB: +((after - before) / 1024).toFixed(1) }));
}
