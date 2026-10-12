// Scope's bundled data (Issue #33, points 2 and 8), so that Scope works with nothing fetched. Made by hand from
// WHG's own answers, fetched anonymously on 12 October 2026: the AAT ids and their labels from GET /types/vocab/
// (a flat map, {"byId": {"aat:<id>": {label, desc}}}, of 1,084 concepts that day), each type's narrower ones from
// GET /types/expand/?ids=<id> ({"ids": [...]}, the type itself among them), and the sources from GET /api/sources/.
// WHG's gateway is reported not to match a type hierarchically (its aat_paths are empty), so a type is sent with
// every narrower one (scope.js typeIds); these expansions stand in when /types/expand/ cannot be asked.
// test/scope.test.js checks the shape, and that every id is an AAT id.

/** The AAT place types offered first: { id, label (as Scope shows it), aat (AAT's own label), narrower (ids, the type not among them) }. */
export const TYPE_SHORTLIST = [
  { id: 'aat:300008347', label: "Inhabited places (settlements of every kind)", aat: "inhabited places", narrower: ["aat:300000681", "aat:300000686", "aat:300000751", "aat:300000874", "aat:300000879", "aat:300000880", "aat:300007915", "aat:300007917", "aat:300007918", "aat:300007919", "aat:300008350", "aat:300008356", "aat:300008369", "aat:300008372", "aat:300008375", "aat:300008384", "aat:300008389", "aat:300008394", "aat:300008396", "aat:300008397", "aat:300008400", "aat:300008401", "aat:300008402", "aat:300008404", "aat:300008407", "aat:300008410", "aat:300008415", "aat:300008416", "aat:300008419", "aat:300008420", "aat:300008423", "aat:300008429", "aat:300008430", "aat:300008432", "aat:300008436", "aat:300008450", "aat:300008454", "aat:300008455", "aat:300008458", "aat:300008461", "aat:300008464", "aat:300008467", "aat:300008475", "aat:300008479", "aat:300008482", "aat:300008483", "aat:300008485", "aat:300008486", "aat:300008487", "aat:300008488", "aat:300008489", "aat:300008490", "aat:300008502", "aat:300008503", "aat:300008506", "aat:300008509", "aat:300008511", "aat:300008522", "aat:300008523", "aat:300008526", "aat:300008527", "aat:300008537", "aat:300008542", "aat:300008544", "aat:300008545", "aat:300008547", "aat:300008549", "aat:300108349", "aat:300113278", "aat:300120579", "aat:300120583", "aat:300120590", "aat:300120599", "aat:300120707", "aat:300122715", "aat:300132618", "aat:300155228", "aat:300155914", "aat:300155931", "aat:300155942", "aat:300167671", "aat:300178894", "aat:300249169", "aat:300257104", "aat:300259605", "aat:300262891", "aat:300263194", "aat:300263210", "aat:300263222", "aat:300265593", "aat:300265612", "aat:300266395", "aat:300311237", "aat:300379492", "aat:300386139", "aat:300387066", "aat:300387067", "aat:300387068", "aat:300387069", "aat:300387203", "aat:300387205", "aat:300387210", "aat:300387212", "aat:300387213", "aat:300387216", "aat:300387218", "aat:300387219", "aat:300387220", "aat:300387221", "aat:300387222", "aat:300387223", "aat:300387225", "aat:300387226", "aat:300387231", "aat:300387232", "aat:300387233", "aat:300387234", "aat:300387235", "aat:300387236", "aat:300387237", "aat:300387238", "aat:300387239", "aat:300387240", "aat:300387241", "aat:300387242", "aat:300387243", "aat:300387246", "aat:300387247", "aat:300387249", "aat:300387250", "aat:300387253", "aat:300387254", "aat:300387255", "aat:300387256", "aat:300387257", "aat:300387264", "aat:300387265", "aat:300387266", "aat:300387267", "aat:300387269", "aat:300387270", "aat:300387271", "aat:300387272", "aat:300387273", "aat:300387275", "aat:300387276", "aat:300387277", "aat:300387278", "aat:300387279", "aat:300387280", "aat:300387281", "aat:300387282", "aat:300387283", "aat:300387284", "aat:300387285", "aat:300387286", "aat:300387287", "aat:300387288", "aat:300387290", "aat:300387291", "aat:300387292", "aat:300387293", "aat:300387294", "aat:300387295", "aat:300387296", "aat:300387298", "aat:300387299", "aat:300387300", "aat:300387302", "aat:300387303", "aat:300387304", "aat:300387305", "aat:300387306", "aat:300387308", "aat:300387309", "aat:300387310", "aat:300387311", "aat:300387312", "aat:300387313", "aat:300387314", "aat:300387315", "aat:300387316", "aat:300387317", "aat:300387318", "aat:300387319", "aat:300387320", "aat:300387321", "aat:300387323", "aat:300387325", "aat:300387326", "aat:300387327", "aat:300387330", "aat:300387508", "aat:300387509", "aat:300387510", "aat:300387511", "aat:300387512", "aat:300387527", "aat:300387528", "aat:300387529", "aat:300387531", "aat:300387650", "aat:300387651", "aat:300387659", "aat:300387662", "aat:300387668", "aat:300387669", "aat:300387716", "aat:300389983", "aat:300391424", "aat:300391436", "aat:300391480", "aat:300391482", "aat:300391496", "aat:300391509", "aat:300404010", "aat:300404130", "aat:300411435", "aat:300411530", "aat:300412053", "aat:300412063", "aat:300435537", "aat:300443501", "aat:300443507", "aat:300443764", "aat:300443773", "aat:300443856", "aat:300443971", "aat:300444153", "aat:300444930", "aat:300449004", "aat:300449005", "aat:300450681", "aat:300451775", "aat:300456579", "aat:300456761", "aat:300457691", "aat:300458712", "aat:300458713", "aat:300458828", "aat:300458829"] },
  { id: 'aat:300008389', label: "Cities", aat: "cities", narrower: ["aat:300000751", "aat:300008394", "aat:300008397", "aat:300008401"] },
  { id: 'aat:300008375', label: "Towns", aat: "towns", narrower: ["aat:300008396", "aat:300265593", "aat:300379492", "aat:300387212"] },
  { id: 'aat:300008372', label: "Villages", aat: "villages", narrower: ["aat:300108349", "aat:300262891", "aat:300389983"] },
  { id: 'aat:300008369', label: "Hamlets", aat: "hamlets", narrower: [] },
  { id: 'aat:300167671', label: "Deserted settlements", aat: "deserted settlements", narrower: ["aat:300266395"] },
  { id: 'aat:300120599', label: "Ports", aat: "ports (settlements)", narrower: ["aat:300000681", "aat:300000686", "aat:300007915", "aat:300007917", "aat:300007918", "aat:300007919", "aat:300387253", "aat:300387254", "aat:300387255", "aat:300387256", "aat:300387257", "aat:300387511", "aat:300411435"] },
  { id: 'aat:300387092', label: "Parishes", aat: "parishes", narrower: [] },
  { id: 'aat:300000773', label: "Parishes (religious divisions)", aat: "parishes (religious divisions)", narrower: [] },
  { id: 'aat:300000792', label: "Townships", aat: "townships", narrower: [] },
  { id: 'aat:300000771', label: "Counties", aat: "counties", narrower: ["aat:300391481"] },
  { id: 'aat:300000799', label: "Dioceses", aat: "dioceses", narrower: [] },
  { id: 'aat:300000238', label: "Manors", aat: "manors (agricultural complexes)", narrower: [] },
  { id: 'aat:300000206', label: "Farms", aat: "farms", narrower: ["aat:300000208", "aat:300000210", "aat:300000213", "aat:300000214", "aat:300000218", "aat:300000222", "aat:300000228", "aat:300000246", "aat:300000248", "aat:300000340", "aat:300008528", "aat:300008633", "aat:300008890", "aat:300045490", "aat:300199033", "aat:300248842", "aat:300265732", "aat:300411503", "aat:300411558", "aat:300445652"] },
  { id: 'aat:300008707', label: "Rivers", aat: "rivers", narrower: [] },
  { id: 'aat:300008699', label: "Streams", aat: "streams", narrower: ["aat:300266560", "aat:300387056"] },
  { id: 'aat:300008791', label: "Islands", aat: "islands (landforms)", narrower: ["aat:300008793", "aat:300386828", "aat:300386851", "aat:300386852", "aat:300386853", "aat:300386854", "aat:300386881", "aat:300391533", "aat:300458843"] },
  { id: 'aat:300006891', label: "Castles", aat: "castles (fortifications)", narrower: ["aat:300005656", "aat:300005740", "aat:300006893", "aat:300400701"] },
  { id: 'aat:300000641', label: "Monasteries", aat: "monasteries (built complexes)", narrower: ["aat:300000642", "aat:300000643", "aat:300000645", "aat:300000650", "aat:300000667", "aat:300386092", "aat:300446181", "aat:300446529", "aat:300446897"] },
];

/** WHG's authority sources (GET /api/sources/), for when they cannot be fetched: { namespace, name, core, records }. */
export const BUNDLED_SOURCES = [
  { namespace: "gn", name: "GeoNames", core: true, records: 13454817 },
  { namespace: "wd", name: "Wikidata", core: true, records: 11459393 },
  { namespace: "tgn", name: "Getty TGN", core: true, records: 2991143 },
  { namespace: "osm", name: "OpenStreetMap", core: false, records: 20622228 },
  { namespace: "gb", name: "GB1900", core: false, records: 1174449 },
  { namespace: "ohm", name: "OpenHistoricalMap", core: false, records: 945156 },
  { namespace: "chgis", name: "China Historical GIS (CHGIS)", core: false, records: 81292 },
  { namespace: "tm", name: "Trismegistos", core: false, records: 64196 },
  { namespace: "pl", name: "Pleiades", core: false, records: 25561 },
  { namespace: "iv", name: "Index Villaris", core: false, records: 24000 },
  { namespace: "kain_par", name: "Ancient Parishes & Places of England & Wales (pre-1850)", core: false, records: 23177 },
  { namespace: "alc", name: "Alcedo", core: false, records: 18223 },
  { namespace: "ofs", name: "Ottoman NFS Gazetteer", core: false, records: 16296 },
  { namespace: "clio", name: "Cliopatria", core: false, records: 15690 },
  { namespace: "hgis", name: "HGIS de las Indias", core: false, records: 14105 },
  { namespace: "po", name: "PeriodO", core: false, records: 9017 },
  { namespace: "og", name: "Ottoman Gazetteer (ottgaz)", core: false, records: 6260 },
  { namespace: "nl", name: "Native Land", core: false, records: 4363 },
  { namespace: "dgsd", name: "Digital Gazetteer of the Song Dynasty", core: false, records: 3828 },
  { namespace: "dp", name: "D-PLACE", core: false, records: 2599 },
  { namespace: "vob_lgd", name: "GBHGIS Local Government Districts of England & Wales, 1911\u20131971", core: false, records: 2056 },
  { namespace: "vob_rd", name: "GBHGIS Registration Districts of England & Wales, 1851\u20131911", core: false, records: 674 },
  { namespace: "un", name: "UN Countries", core: false, records: 247 },
  { namespace: "ukhc", name: "UK Historic Counties", core: false, records: 92 },
  { namespace: "vob_cty", name: "GBHGIS Administrative Counties of England & Wales, 1911\u20131971", core: false, records: 65 },
  { namespace: "vob_rc", name: "GBHGIS Registration Counties of England & Wales, 1851\u20131911", core: false, records: 55 },
  { namespace: "osm_misc", name: "OSM/OHM (Miscellaneous)", core: false, records: 0 },
  { namespace: "whg", name: "Specialist Gazetteers", core: false, records: 0 },
];

/** ISO 3166-1 alpha-2 codes, all 249 assigned; their names are the browser's own (Intl.DisplayNames). */
export const COUNTRY_CODES = ["AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI", "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW"];
