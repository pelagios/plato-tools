// The font a map made from Chora's view (#37) is drawn in, in the page: Noto Sans (SIL Open Font Licence 1.1,
// public/fonts/NotoSans-OFL.txt), Fontsource's subsets of it for Latin, Latin extended, Greek and polytonic
// Greek, upright and italic, served from this site. Two uses, one font:
//   - the labels are measured in it (labels.js places them by their widths), so that the PNG, drawn in it, has
//     them where they were placed;
//   - the PNG is drawn from the map's SVG with these inlined (cssWithData): an image drawn from an SVG may load
//     nothing of its own, so a font it names but does not carry would fall back to another of other widths.
// The SVG for Commons names the fonts only (svg.js FONT_STACK): Commons ignores web fonts, and has Noto Sans.
import latin from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2?url';
import latinExt from '@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff2?url';
import greek from '@fontsource/noto-sans/files/noto-sans-greek-400-normal.woff2?url';
import greekExt from '@fontsource/noto-sans/files/noto-sans-greek-ext-400-normal.woff2?url';
import latinI from '@fontsource/noto-sans/files/noto-sans-latin-400-italic.woff2?url';
import latinExtI from '@fontsource/noto-sans/files/noto-sans-latin-ext-400-italic.woff2?url';
import greekI from '@fontsource/noto-sans/files/noto-sans-greek-400-italic.woff2?url';
import greekExtI from '@fontsource/noto-sans/files/noto-sans-greek-ext-400-italic.woff2?url';

/** The family the map's labels are measured and drawn in, in the page: Noto Sans under a name of its own. */
export const FAMILY = 'PLATO Map Noto Sans';
// Fontsource's ranges for each subset (its 400.css).
const RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  latinExt: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  greek: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
  greekExt: 'U+1F00-1FFF',
};
const FILES = [
  ['normal', latin, RANGES.latin], ['normal', latinExt, RANGES.latinExt], ['normal', greek, RANGES.greek], ['normal', greekExt, RANGES.greekExt],
  ['italic', latinI, RANGES.latin], ['italic', latinExtI, RANGES.latinExt], ['italic', greekI, RANGES.greek], ['italic', greekExtI, RANGES.greekExt],
];

let loaded = null;
/** The font, added to the page and loaded (both styles): resolves once text can be measured in it. */
export function loadFonts() {
  loaded ??= (async () => {
    for (const [style, url, unicodeRange] of FILES) document.fonts.add(new FontFace(FAMILY, `url(${url}) format('woff2')`, { style, weight: '400', unicodeRange }));
    await Promise.all(['normal', 'italic'].map((s) => document.fonts.load(`${s} 16px "${FAMILY}"`, 'AaΑα Ἀἀ')));
  })().catch((e) => { loaded = null; throw e; });
  return loaded;
}

let ctx = null;
/** A text's width in pixels, in the map's font (loadFonts first). */
export function measure(text, { size, italic = false }) {
  ctx ??= new OffscreenCanvas(8, 8).getContext('2d');
  ctx.font = `${italic ? 'italic ' : ''}400 ${size}px "${FAMILY}"`;
  return ctx.measureText(String(text)).width;
}

let css = null;
/**
 * @font-face rules for the PNG's SVG: the same files as data: addresses, under the names the SVG gives (Noto Sans,
 * as FONT_STACK names it first), so that the picture drawn from it uses them.
 */
export function cssWithData() {
  css ??= Promise.all(FILES.map(async ([style, url, range]) => {
    const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return `@font-face { font-family: "Noto Sans"; font-style: ${style}; font-weight: 400; unicode-range: ${range}; src: url(data:font/woff2;base64,${btoa(s)}) format("woff2"); }`;
  })).then((rules) => rules.join('\n')).catch((e) => { css = null; throw e; });
  return css;
}
