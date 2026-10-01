// What the permissions panel and the "Needs permission" lines say, in one place: plain British
// English. The panel itself is src/lib/permissions-panel.js; what a permission is, permissions-core.js.

/** The promise, said once on the main page and as the panel's opening sentence. */
export const PROMISE = 'Your files stay on your computer, and nothing is sent to any other site unless you allow it.';

/** Each category: its heading, and what a site of that kind learns. */
export const CATEGORY_WORDS = {
  basemap: { heading: 'Basemaps', learns: 'A basemap’s provider sees which part of the world you look at, and your address on the internet, as any website does.' },
  iiif: { heading: 'Historical maps', learns: 'A historical map’s server sees which map you view, and which parts of it.' },
  allmaps: { heading: 'Georeferences', learns: 'Allmaps learns which map a georeference was looked for.' },
  gazetteer: { heading: 'Gazetteers', learns: 'A gazetteer sees the names you look up in it.' },
  linked: { heading: 'Linked sites', learns: 'A site your data links to sees which of its pages you open.' },
};

/** The services the tools know by name. */
export const SERVICE_NAMES = {
  'basemap:openfreemap': 'OpenFreeMap',
  'basemap:osm': 'OpenStreetMap',
  'basemap:carto': 'CARTO',
  'allmaps:allmaps': 'Allmaps',
  'gazetteer:whg': 'the World Historical Gazetteer',
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
  added: (date) => `You added this${date ? ` on ${date}` : ''}.`,
  sitesOf: (origins) => `Asks ${listOf(origins.map((o) => o.replace(/^https:\/\//, '')))}.`,
  reloadNote: 'Allowed: it can be used once the page is reloaded.',
  reload: 'Reload the page now',
  reloadKept: 'What you have open is kept.',
  forgetAll: 'Forget all permissions',
  forgotAll: 'All permissions are forgotten.',
  none: 'No other site has been allowed.',
  close: 'Close',
  tokenHeading: 'World Historical Gazetteer token',
  tokenHeld: 'A token is held for this tab. It is never shown, and is sent only to the World Historical Gazetteer.',
  tokenNone: 'No token is held.',
  tokenRemember: 'Remember my token in this browser',
  tokenRememberNote: 'Remembered, it stays after the tab is closed, and any Pelagios site open on this computer could read it. Not remembered, it is forgotten when the tab is closed.',
  tokenForget: 'Forget the token',
  rememberedHeading: 'Remembered in this browser',
  rememberedNone: 'Nothing else is remembered.',
  forget: 'Forget',
  workHeading: 'Your working data',
  keepWork: 'Keep my working data between visits',
  keepWorkNote: 'Chora keeps the dataset you opened, your drawings not yet saved, and the file it last wrote, in this browser, so that you can carry on next time. Turned off, they are cleared when you next open Chora, and the file it wrote is cleared once you have saved it: save your drawings before you leave.',
  count: (n) => (n ? `${n} allowed` : 'none allowed'),
  notProtected: 'This browser did not show that it enforces the page’s protection, so no other site is asked from this page, whatever is allowed.',
};

/** What is remembered in this browser, besides permissions: each key's description. */
export const REMEMBERED = {
  'plato-tools.reviewer': { label: 'Your name and ORCID, as the reviewer of matches (Krisis)' },
  'chora-contributor': { label: 'Your name and ORCID, as the one drawing (Chora)' },
  'chora-basemaps': { label: 'The basemaps you pasted (Chora). Their addresses may hold an API key.' },
};

/** The one line a feature shows while it waits for a permission. */
export const NEEDS = {
  line: (name) => `Needs permission: ${name}`,
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
  moved: (site, landed) => `${site} sent the request on to ${landed}, another site, so its answer was not used.`,
  network: (site) => `${site} could not be reached; it may not allow other sites to read it.`,
};
