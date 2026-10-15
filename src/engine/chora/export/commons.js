// What a map made from Chora's view (#37) says of itself for Wikimedia Commons: its file page, ready to paste,
// filled in by Commons' {{Map}} template (title, description, legend, author, date, map date, projection,
// scale, latitude and longitude, source, warp status and address, permission, other versions), then the
// licence and the templates of what it is made from; and a link to Commons' Special:Upload with the file's
// name, that description and the licence filled in, which the user follows themselves.
//
// The author is the Chora contributor's name, with their ORCID iD where they gave one; NEVER an email address:
// nothing here is given one, and authorWords refuses a name that looks like one. Pure.
import { PROJECTION_NAMES } from './project.js';

/** What the upload link says it sends, in words, as the Allmaps Editor's link does (overlays.js EDITOR_LINK_TEXT). */
export const UPLOAD_LINK_TEXT = "Upload to Wikimedia Commons ↗ (sends the file's name and its description, below, to Wikimedia Commons in the link; you choose the file itself there)";
/** Commons' upload form. */
export const UPLOAD_PAGE = 'https://commons.wikimedia.org/wiki/Special:Upload';
/** A link longer than this is not offered (browsers and servers may cut it short): the description is copied instead. */
export const MAX_LINK = 7000;

const ORCID = /^(?:https?:\/\/orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/;
/** A wiki link to the author: their name, linked to their ORCID iD where given. An address with @ in it is never written. */
export function authorWords({ name, orcid } = {}) {
  const n = String(name || '').trim();
  if (!n || /@/.test(n)) return 'Unknown author';
  const m = ORCID.exec(String(orcid || '').trim());
  return m ? `[https://orcid.org/${m[1]} ${n}] (ORCID ${m[1]})` : n;
}
/** A value as a wiki template's parameter may hold it: no "|" or "}}" to end it early, no newline. */
const param = (s) => String(s ?? '').replace(/\|/g, '{{!}}').replace(/\}\}/g, '} }').replace(/\s*\n\s*/g, ' ').trim();
/** Words in a language, as Commons writes them: {{en|1=…}}. */
const inLang = (lang, s) => (s ? `{{${String(lang || 'en').toLowerCase().split('-')[0]}|1=${param(s)}}}` : '');
const deg = (v, pos, neg) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;

/**
 * The file page. `map`: { title, description, lang, legend, author: { name, orcid }, date (YYYY-MM-DD, the
 * day it was made), mapDate (a historical background's, else null), projection ('mercator' |
 * 'equirectangular'), bounds: [w, s, e, n], scaleWords, sources: [words] (the background, the relief, the
 * gazetteer records the places are identified with, a manifest), residuals: [words] (a georeference's misfit,
 * said in the description, not on the map), warp: { url } | null, licence: composeLicence's result, format:
 * 'svg' | 'png', rasterInSvg (an SVG that is mostly a picture), otherVersions: [file names] }.
 * `forUpload`: the licence is left out, as Special:Upload's own licence field adds it.
 */
export function filePage(map, { forUpload = false } = {}) {
  const L = map.licence;
  const desc = [map.description, ...(map.residuals || [])].filter(Boolean).join(' ');
  const permission = [L.words, ...(L.statements || [])].filter(Boolean).join(' ');
  const [w, s, e, n] = map.bounds;
  const rows = [
    ['title', inLang(map.lang, map.title)],
    ['description', inLang(map.lang, desc)],
    ['legend', inLang(map.lang, map.legend)],
    ['author', authorWords(map.author)],
    ['date', map.date],
    ['map date', map.mapDate || ''],
    ['projection', PROJECTION_NAMES[map.projection] || map.projection],
    ['scale', map.scaleWords || ''],
    ['latitude', `${deg(s, 'N', 'S')} to ${deg(n, 'N', 'S')}`],
    ['longitude', `${deg(w, 'E', 'W')} to ${deg(e, 'E', 'W')}`],
    ['source', (map.sources || []).map(param).join('; ')],
    ['warp status', map.warp ? 'warped' : ''],
    ['warp url', map.warp?.url || ''],
    ['permission', param(permission)],
    ['other versions', (map.otherVersions || []).map((f) => `[[:File:${f}]]`).join(' ')],
  ];
  const lines = ['{{Map', ...rows.map(([k, v]) => ` |${k} =${v ? ` ${v}` : ''}`), '}}'];
  const licensing = [...(forUpload ? [] : [`{{self|${L.licence.template}}}`]), ...L.templates];
  if (map.format === 'svg' && map.rasterInSvg) licensing.push('{{SVG with raster elements}}');
  return [...lines, '', '=={{int:license-header}}==', ...licensing].join('\n') + '\n';
}

/**
 * The link to Commons' upload form with `fileName`, the description (filePage's, for the upload) and the
 * licence filled in: the user's own navigation, which sends those in its address, and nothing else. Null when
 * it would be longer than MAX_LINK, or the map cannot go to Commons (licence.ok false): the page then offers
 * to copy the description instead.
 */
export function uploadUrl(map, fileName) {
  if (!map.licence?.ok) return null;
  const q = new URLSearchParams({ wpDestFile: fileName, wpUploadDescription: filePage(map, { forUpload: true }), wpLicense: `self|${map.licence.licence.template}` });
  const url = `${UPLOAD_PAGE}?${q.toString().replace(/\+/g, '%20')}`;
  return url.length > MAX_LINK ? null : url;
}

/** A file name for Commons: the title's words, with what Commons refuses in a name (# < > [ ] | { } / : and the like) taken out. */
export function commonsName(title, ext) {
  const t = String(title || 'Map').normalize('NFC').replace(/[#<>[\]|{}/\\:*?"~%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || 'Map';
  return `${t}.${ext}`;
}
