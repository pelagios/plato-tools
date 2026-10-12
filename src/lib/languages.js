// Language codes with their English names, for the typeahead of the lookup panel's language field
// (#lookup-lang). Every ISO 639-1 code that names one language, then the historical languages a
// gazetteer's names are often in: the four with ISO 639-1 codes (sa, pi, ae, cu), and ISO 639-3 (and
// 639-2) codes. A language with a two-letter code is listed by
// that code only, as whgLang() sends it (eng as en, lat as la). Every code is one that WHG takes
// (^[a-z]{2,3}$) and that whgLang() sends as itself; test/languages.test.js checks both. The names are
// ISO's English reference names, shortened where ISO adds dates or qualifiers.
// This is a list of suggestions, not of what may be typed: the field takes any tag whgLang() reads.

const MODERN = (
  'aa Afar|ab Abkhazian|af Afrikaans|ak Akan|am Amharic|an Aragonese|ar Arabic|as Assamese|' +
  'av Avaric|ay Aymara|az Azerbaijani|ba Bashkir|be Belarusian|bg Bulgarian|bi Bislama|bm Bambara|bn Bengali|' +
  'bo Tibetan|br Breton|bs Bosnian|ca Catalan|ce Chechen|ch Chamorro|co Corsican|cr Cree|cs Czech|' +
  'cv Chuvash|cy Welsh|da Danish|de German|dv Dhivehi|dz Dzongkha|ee Ewe|el Modern Greek|' +
  'en English|eo Esperanto|es Spanish|et Estonian|eu Basque|fa Persian|ff Fulah|fi Finnish|fj Fijian|' +
  'fo Faroese|fr French|fy Western Frisian|ga Irish|gd Scottish Gaelic|gl Galician|gn Guarani|gu Gujarati|' +
  'gv Manx|ha Hausa|he Hebrew|hi Hindi|ho Hiri Motu|hr Croatian|ht Haitian Creole|hu Hungarian|hy Armenian|' +
  'hz Herero|ia Interlingua|id Indonesian|ie Interlingue|ig Igbo|ii Sichuan Yi|ik Inupiaq|io Ido|' +
  'is Icelandic|it Italian|iu Inuktitut|ja Japanese|jv Javanese|ka Georgian|kg Kongo|ki Kikuyu|kj Kuanyama|' +
  'kk Kazakh|kl Kalaallisut|km Khmer|kn Kannada|ko Korean|kr Kanuri|ks Kashmiri|ku Kurdish|kv Komi|' +
  'kw Cornish|ky Kyrgyz|la Latin|lb Luxembourgish|lg Ganda|li Limburgish|ln Lingala|lo Lao|lt Lithuanian|' +
  'lu Luba-Katanga|lv Latvian|mg Malagasy|mh Marshallese|mi Maori|mk Macedonian|ml Malayalam|mn Mongolian|' +
  'mr Marathi|ms Malay|mt Maltese|my Burmese|na Nauru|nb Norwegian Bokmål|nd North Ndebele|ne Nepali|' +
  'ng Ndonga|nl Dutch|nn Norwegian Nynorsk|no Norwegian|nr South Ndebele|nv Navajo|ny Chichewa|oc Occitan|' +
  'oj Ojibwa|om Oromo|or Odia|os Ossetian|pa Punjabi|pl Polish|ps Pashto|pt Portuguese|qu Quechua|' +
  'rm Romansh|rn Rundi|ro Romanian|ru Russian|rw Kinyarwanda|sc Sardinian|sd Sindhi|' +
  'se Northern Sami|sg Sango|sh Serbo-Croatian|si Sinhala|sk Slovak|sl Slovenian|sm Samoan|sn Shona|' +
  'so Somali|sq Albanian|sr Serbian|ss Swati|st Southern Sotho|su Sundanese|sv Swedish|sw Swahili|ta Tamil|' +
  'te Telugu|tg Tajik|th Thai|ti Tigrinya|tk Turkmen|tl Tagalog|tn Tswana|to Tongan|tr Turkish|ts Tsonga|' +
  'tt Tatar|tw Twi|ty Tahitian|ug Uyghur|uk Ukrainian|ur Urdu|uz Uzbek|ve Venda|vi Vietnamese|vo Volapük|' +
  'wa Walloon|wo Wolof|xh Xhosa|yi Yiddish|yo Yoruba|za Zhuang|zh Chinese|zu Zulu|' +
  'lad Ladino|nds Low German|sco Scots|yue Cantonese|cmn Mandarin Chinese|arb Standard Arabic'
);
const HISTORICAL = (
  'sa Sanskrit|pi Pali|ae Avestan|cu Church Slavonic|' +
  'grc Ancient Greek|gmy Mycenaean Greek|xmk Ancient Macedonian|ang Old English|enm Middle English|xno Anglo-Norman|fro Old French|' +
  'frm Middle French|pro Old Occitan|osp Old Spanish|mxi Mozarabic|goh Old High German|gmh Middle High German|' +
  'osx Old Saxon|gml Middle Low German|odt Old Dutch|dum Middle Dutch|ofs Old Frisian|frk Frankish|' +
  'non Old Norse|got Gothic|sga Old Irish|mga Middle Irish|pgl Primitive Irish|owl Old Welsh|wlm Middle Welsh|' +
  'obt Old Breton|oco Old Cornish|cnx Middle Cornish|xcb Cumbric|xpi Pictish|xtg Transalpine Gaulish|xcg Cisalpine Gaulish|' +
  'ett Etruscan|osc Oscan|xum Umbrian|xve Venetic|orv Old Russian|prg Old Prussian|xcl Classical Armenian|oge Old Georgian|' +
  'ota Ottoman Turkish|otk Old Turkic|chg Chagatai|peo Old Persian|pal Pahlavi|sog Sogdian|xbc Bactrian|' +
  'txb Tocharian B|xto Tocharian A|akk Akkadian|sux Sumerian|hit Hittite|xlu Cuneiform Luwian|hlu Hieroglyphic Luwian|xld Lydian|' +
  'xlc Lycian|xcr Carian|xpg Phrygian|uga Ugaritic|phn Phoenician|xpu Punic|egy Ancient Egyptian|cop Coptic|' +
  'gez Geez|syc Classical Syriac|oar Old Aramaic|arc Imperial Aramaic|hbo Ancient Hebrew|xct Classical Tibetan|' +
  'lzh Literary Chinese|och Old Chinese|ltc Late Middle Chinese|ojp Old Japanese|oko Old Korean|okm Middle Korean|' +
  'kaw Old Javanese|omr Old Marathi|nci Classical Nahuatl'
);
const parse = (text, historical) => text.split('|').map((p) => {
  const i = p.indexOf(' ');
  return Object.freeze({ code: p.slice(0, i), name: p.slice(i + 1), historical });
});

/** [{ code, name, historical }]: the modern languages, then the historical. */
export const LANGUAGES = Object.freeze([...parse(MODERN, false), ...parse(HISTORICAL, true)]);

/** Lower case, without accents, for matching ("Bokmål" is found by "bokmal"). */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const wordsOf = (s) => s.split(/[\s\-–,()·]+/).filter(Boolean);

/**
 * The languages a typed text may mean, best first, at most `limit`: by code (exactly, then beginning
 * with it: "an" finds an and ang), then by name (beginning with it, then every typed word beginning a
 * word of the name, in any order: "old eng" and "eng old" find Old English). Never a word's middle, so that
 * a text that is no code and begins no name ("und") is offered nothing. Within each, shorter codes first,
 * then by name. Nothing for an empty text.
 */
export function matchLanguages(query, { limit = 10, list = LANGUAGES } = {}) {
  const q = fold(query);
  if (!q) return [];
  const typed = wordsOf(q);
  const found = [];
  for (const l of list) {
    const name = fold(l.name), words = wordsOf(name);
    let rank;
    if (l.code === q) rank = 0;
    else if (l.code.startsWith(q)) rank = 1;
    else if (name.startsWith(q)) rank = 2;
    else if (typed.length && typed.every((t) => words.some((w) => w.startsWith(t)))) rank = 3;
    else continue;
    found.push({ rank, l });
  }
  found.sort((a, b) => a.rank - b.rank || a.l.code.length - b.l.code.length || a.l.name.localeCompare(b.l.name, 'en'));
  return found.slice(0, limit).map((f) => f.l);
}
