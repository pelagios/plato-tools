// Will Wikimedia Commons draw a map made from Chora's view (#37) as it should? Commons renders an SVG with
// librsvg (2.60 since August 2026) and the fonts installed there, and ignores web fonts, so a label is drawn
// in whichever of the fonts named (svg.js FONT_STACK) Commons has: Noto Sans or DejaVu Sans, both there, both
// with polytonic Greek. This renders with rsvg-convert (librsvg's own command), seeing only those two fonts
// (a fontconfig of its own, written here, naming their folders and nothing else), and asserts:
//   - that the whole golden map is read and drawn, at its size;
//   - that every character of its labels, the polytonic Greek among them, is drawn as a glyph, not as the box
//     that librsvg draws for a character no font has ("tofu": a frame round the character's code in hex).
// It doubles as the proof that the check can fail: a character no font has (U+10FFFD) must be found and named,
// and a Latin A must not. rsvg-convert is needed (Debian/Ubuntu: librsvg2-bin; fonts-dejavu-core and
// fonts-noto-core for the fonts), and its absence fails the test rather than skipping it: a check that cannot
// run must not read as one that passed. The gates install them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng } from './png-decode.js';
import { svgDocument, el, FONT_STACK } from '../src/engine/chora/export/svg.js';
import { goldenMap } from './chora-export-fixture.js';

const FONT_DIRS = ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/truetype/noto'];
const dir = mkdtempSync(join(tmpdir(), 'plato-rsvg-'));
const conf = join(dir, 'fonts.conf');
writeFileSync(conf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n${FONT_DIRS.map((d) => `  <dir>${d}</dir>`).join('\n')}\n  <cachedir>${join(dir, 'cache')}</cachedir>\n</fontconfig>\n`);
let n = 0;
/** An SVG drawn by rsvg-convert with only DejaVu and Noto to hand: its pixels. */
function render(svg) {
  const src = join(dir, `${++n}.svg`), out = join(dir, `${n}.png`);
  writeFileSync(src, svg);
  execFileSync('rsvg-convert', ['-o', out, src], { env: { ...process.env, FONTCONFIG_FILE: conf }, stdio: ['ignore', 'ignore', 'pipe'] });
  return decodePng(readFileSync(out));
}
/** Whether a character is drawn by librsvg as its missing-glyph box: alone and large, its ink framed on all four sides. */
function tofu(ch) {
  const { width, height, rgba } = render(svgDocument({ width: 220, height: 220, body: [el('rect', { width: 220, height: 220, fill: '#ffffff' }),
    el('text', { x: 30, y: 160, 'font-family': FONT_STACK, 'font-size': 140, fill: '#000000' }, ch)] }));
  const ink = (x, y) => rgba[(y * width + x) * 4] < 128;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (ink(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return { drawn: false, tofu: false };
  // A side is framed when nearly all of it is ink, within two pixels of the ink's edge.
  const side = (pts) => pts.filter(([x, y]) => ink(x, y)).length / pts.length;
  const span = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const near = (fn) => Math.max(...[0, 1, 2].map(fn));
  const top = near((d) => side(span(x0, x1).map((x) => [x, y0 + d]))), bottom = near((d) => side(span(x0, x1).map((x) => [x, y1 - d])));
  const left = near((d) => side(span(y0, y1).map((y) => [x0 + d, y]))), right = near((d) => side(span(y0, y1).map((y) => [x1 - d, y])));
  // And hollow: a frame with the code inside, not a bar of ink (an l, an i, which are inked to their edges too).
  let inked = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ink(x, y)) inked++;
  const filled = inked / ((x1 - x0 + 1) * (y1 - y0 + 1));
  return { drawn: true, tofu: [top, bottom, left, right].every((f) => f > 0.85) && filled < 0.6, frame: [top, bottom, left, right].map((f) => Math.round(f * 100) / 100), filled };
}
const missing = (text) => [...new Set([...text].filter((c) => c.trim()))].filter((c) => tofu(c).tofu);

test('rsvg-convert is here, with DejaVu Sans and Noto Sans, as Commons has them', () => {
  let version = '';
  try { version = execFileSync('rsvg-convert', ['--version'], { encoding: 'utf8' }); } catch (e) { assert.fail(`rsvg-convert could not be run (${e.message.split('\n')[0]}): install librsvg2-bin`); }
  assert.match(version, /rsvg-convert version \d+\.\d+/);
  for (const d of FONT_DIRS) assert.ok(existsSync(d), `${d} is not here: install fonts-dejavu-core and fonts-noto-core`);
  const fonts = execFileSync('fc-list', [':', 'family'], { env: { ...process.env, FONTCONFIG_FILE: conf }, encoding: 'utf8' });
  assert.match(fonts, /DejaVu Sans/); assert.match(fonts, /Noto Sans/);
});

test('the detector: a character no font has is found and named; a Latin A is not', () => {
  assert.deepEqual(tofu('A').tofu, false, JSON.stringify(tofu('A')));
  const t = tofu('\u{10FFFD}');
  assert.ok(t.drawn && t.tofu, JSON.stringify(t));
  assert.deepEqual(missing('Ἀθῆναι \u{10FFFD}'), ['\u{10FFFD}']);
});

test('Commons\' renderer draws the golden map at its size, and every character of its labels as a glyph, polytonic Greek among them', () => {
  const r = goldenMap();
  const png = render(r.svg);
  assert.deepEqual([png.width, png.height], [r.width, r.height]);
  // Not blank: the ocean's colour and the land's are both there.
  const colours = new Set();
  for (let i = 0; i < png.rgba.length; i += 4 * 97) colours.add(`${png.rgba[i]},${png.rgba[i + 1]},${png.rgba[i + 2]}`);
  assert.ok(colours.has('213,227,234') && colours.has('244,242,236'), [...colours].slice(0, 12).join(' '));
  const labels = r.labels.flatMap((l) => l.lines.map((x) => x.text)).join(' ');
  assert.match(labels, /Ἀθῆναι/);
  assert.deepEqual(missing(`${labels} ῥόδον ᾠδή Ἑλλάς ἐν Ἀθήναις`), []);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
