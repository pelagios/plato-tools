// What the permissions panel and the "Needs permission" lines say, in one place: plain British
// English. The panel itself is src/lib/permissions-panel.js; what a permission is, permissions-core.js.

/** The promise, said once on the main page and as the panel's opening sentence. */
export const PROMISE = 'Your files stay on your computer, and nothing is sent to any other site unless you allow it.';

/** Each category: its heading, and what a site of that kind learns. */
export const CATEGORY_WORDS = {
  basemap: { heading: 'Basemaps', learns: 'A basemap’s provider sees which part of the world you look at, and your address on the internet, as any website does.' },
  iiif: { heading: 'Historical maps', learns: 'A historical map’s server sees which map you view, and which parts of it; so does the site its description (its manifest) or its georeference is on. Tracing from a map asks its server for the part you click, in more detail.' },
  allmaps: { heading: 'Georeferences', learns: 'Allmaps learns which map a georeference was looked for. Opening a map in the Allmaps Editor sends Allmaps the map’s address.' },
  gazetteer: { heading: 'Gazetteers', learns: 'A gazetteer sees the names you look up in it.' },
  linked: { heading: 'Linked sites', learns: 'A site your data links to sees which of its pages you open.' },
};

/** The services the tools know by name. */
export const SERVICE_NAMES = {
  'basemap:openfreemap': 'OpenFreeMap',
  'basemap:osm': 'OpenStreetMap',
  'basemap:carto': 'CARTO',
  'allmaps:allmaps': 'Allmaps',
  'gazetteer:whg': 'World Historical Gazetteer',
};

/** How a service on more than two sites is named in short. */
export const SITES_IN_SHORT = {
  'basemap:carto': 'CARTO’s map servers (basemaps.cartocdn.com and its tile servers)',
};

/** A permission's name for people: a known service's, else its site's host. */
export function nameOf(cat, subj) {
  const k = `${cat}:${subj}`;
  if (SERVICE_NAMES[k]) return SERVICE_NAMES[k];
  try { return new URL(subj).host; } catch { return subj; }
}

const listOf = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export const PANEL = {
  title: 'Permissions',
  shared: 'These tools are on pelagios.org, which other Pelagios sites share. So what this browser keeps for them (your permissions, your choices, keys such as a pasted basemap’s or the World Historical Gazetteer token if you remember it, and your working data) can be read, on this computer only, by any Pelagios site.',
  sitesHeading: 'Sites these tools may ask',
  sitesIntro: 'Each is asked only once you allow it. “Not decided” means a tool will ask you first; “Never” means the tool does without it, and does not ask again.',
  allowed: 'Allowed',
  undecided: 'Not decided',
  never: 'Never',
  allowTab: 'Allow for this tab',
  forTab: 'Allowed for this tab only.',
  added: (date) => (date ? `Added on ${date}.` : 'Added in this browser.'),
  sitesOf: (origins) => `Asks ${listOf(origins.map((o) => o.replace(/^https:\/\//, '')))}.`,
  // A service on many sites is named in short, with the whole list on request.
  sitesShort: (key, origins) => `Asks ${SITES_IN_SHORT[key] || `${origins[0].replace(/^https:\/\//, '')} and ${origins.length - 1} more of its servers`}.`,
  allSites: (n) => `All ${n} sites`,
  keyHeld: 'its address may hold a key',
  reloadNote: 'Allowed: it can be used once the page is reloaded.',
  reload: 'Reload the page now',
  reloadKept: 'What you have open is kept.',
  reloadAsks: 'Something you have open would be lost: you will be asked first.',
  reloadLoses: 'Reloading the page now would lose:',
  reloadAnyway: 'Reload anyway',
  reloadCancel: 'Cancel',
  forgetAll: 'Forget all permissions',
  forgotAll: 'All permissions are forgotten.',
  none: 'No other site has been allowed.',
  close: 'Close',
  tokenHeading: 'World Historical Gazetteer token',
  tokenHeld: (remembered) => (remembered
    ? 'A token is remembered in this browser, and stays after the tab is closed. It is never shown, and is sent only to the World Historical Gazetteer.'
    : 'A token is held for this tab, and is forgotten when the tab is closed. It is never shown, and is sent only to the World Historical Gazetteer.'),
  tokenRevoke: 'Forgetting it here does not revoke it: only regenerating it in the World Historical Gazetteer does, and then every copy of the old one stops working.',
  tokenNone: 'No token is held.',
  tokenRemember: 'Remember my token in this browser',
  tokenRememberNote: 'Remembered, it stays after the tab is closed, and any Pelagios site open on this computer could read it. Not remembered, it is forgotten when the tab is closed.',
  tokenForget: 'Forget the token',
  rememberedHeading: 'Remembered in this browser',
  rememberedNone: 'Nothing else is remembered.',
  forget: 'Forget',
  workHeading: 'Your working data',
  keepWork: 'Keep my working data between visits',
  keepWorkNote: 'Chora keeps the dataset you opened, your drawings not yet saved, the historical maps you showed, and the file it last wrote, in this browser, so that you can carry on next time. Turned off, they are cleared when you next open Chora, and the file it wrote is cleared once you have saved it: save your drawings before you leave.',
  persist: 'Keep large datasets’ working files (ask the browser for persistent storage)',
  persistNote: 'A browser short of space may clear a site’s files, the working copy of a large dataset among them. Ticked, the browser is asked once to keep them; some browsers ask you, some decide for themselves. The answer cannot be undone from here: clearing this site’s data in the browser does that.',
  persistResult: {
    granted: 'The browser agreed: it will not clear these files to make room.',
    refused: 'The browser did not agree: it may still clear these files when it runs short of space.',
    unsupported: 'This browser cannot be asked to keep them.',
  },
  count: (n) => (n ? `${n} allowed` : 'none allowed'),
  notProtected: 'This browser did not show that it enforces the page’s protection, so no other site is asked from this page, whatever is allowed.',
};

/** What is remembered in this browser, besides permissions: each key's description. */
export const REMEMBERED = {
  'plato-tools.reviewer': { label: 'Your name and ORCID, as the reviewer of matches (Krisis)' },
  'chora-contributor': { label: 'Your name and ORCID, as the one drawing (Chora)' },
  'chora-basemaps': { label: 'The basemaps you pasted (Chora). Their addresses may hold an API key.' },
};

/**
 * What the page says in the console about the canary, once per load: the browser itself reports the
 * test request it refused ("Connecting to 'data:text/plain,canary' violates … connect-src"), which
 * looks alarming and which no page can silence.
 */
export const CANARY_LOG = {
  enforced: 'PLATO tools: the blocked request to data:text/plain,canary above is a deliberate test that this page’s protection is switched on. It was blocked, as it should be.',
  notEnforced: (why) => `PLATO tools: ${PANEL.notProtected}${why ? ` (${why})` : ''}`,
};

/** What a reload would lose on the main page, said in the panel before it reloads. */
export const RELOAD_LOSES = {
  files: (names) => `The file${names.length === 1 ? '' : 's'} you chose (${names.join(', ')}): you would choose ${names.length === 1 ? 'it' : 'them'} again.`,
  running: 'The check, conversion or comparison running now, and its result.',
  review: (n) => `${n} decision${n === 1 ? '' : 's'} in your match review not yet saved: save the review first.`,
  drawing: 'The line or area you are drawing, not yet finished.',
  pasted: 'The address in the box for pasting a basemap, not yet added.',
  saving: 'The save running now.',
  tracing: 'The trace being proposed now, not yet accepted.',
};

/** The one line a feature shows while it waits for a permission. */
export const NEEDS = {
  line: (name) => `Needs permission: ${name}`,
  names: (names) => listOf(names),
  open: 'Permissions…',
  reload: (name) => `${name} is allowed, and can be used once the page is reloaded.`,
};

/** Why a request was not made (PermissionError), in words. Never the address itself: it may hold a key. */
export const REFUSED = {
  address: (site) => `${site || 'That address'} is not a site this permission covers.`,
  undecided: (name) => `${name} has not been allowed: see Permissions.`,
  never: (name) => `${name} is set to Never in Permissions.`,
  reload: (name) => `${name} was allowed after this page loaded: it can be reached once the page is reloaded.`,
  unprotected: () => 'This browser did not show that it enforces the page’s protection, so no other site is asked from this page.',
  insecure: (site) => `${String(site).replace(/^http:\/\//, '')} is reached only over plain http, which these tools do not use: ask for its https address, or its holder for one.`,
  redirect: (site) => `${site} answered by sending the request elsewhere, which is not followed, so its answer was not used.`,
  moved: (site, landed) => `${site} sent the request on to ${landed}, another site, so its answer was not used.`,
  network: (site) => `${site} could not be reached; it may not allow other sites to read it.`,
};
