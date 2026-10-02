// Who is saving (decision D4): {name, orcid?}, asked for before the first save and remembered in this
// browser only (localStorage 'chora-contributor'). Never taken from the dataset's own contributor:
// the person drawing is not necessarily the person who made the gazetteer.
const KEY = 'chora-contributor';

/**
 * Who was remembered, checked again as the form checks it: a name, and an ORCID only if it is one
 * (orcidUri, check digit and all). What is kept here can be written by any page of the site's origin
 * (DEVELOPERS.md, "The shared origin"), so an ORCID that is not one is dropped, not shown or saved.
 */
export function load() {
  let c;
  try { c = JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name.trim()) return null;
  const out = { name: c.name };
  if (c.orcid !== undefined && c.orcid !== null) { const uri = orcidUri(c.orcid); if (uri) out.orcid = uri; }
  return out;
}
export function remember(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {} }
export function forget() { try { localStorage.removeItem(KEY); } catch {} }

/**
 * An ORCID iD as PLATO wants it, the full address (https://orcid.org/0000-0002-1825-0097), from what
 * was typed, with or without the address; null if it is not one. The last character is a check digit
 * (ISO 7064 11,2), so a mistyped digit is caught here rather than published.
 */
export function orcidUri(typed) {
  const m = String(typed).trim().match(/^(?:https?:\/\/(?:www\.)?orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i);
  if (!m) return null;
  const id = m[1].toUpperCase(), digits = id.replace(/-/g, '');
  let total = 0;
  for (const d of digits.slice(0, -1)) total = (total + Number(d)) * 2;
  const check = (12 - (total % 11)) % 11;
  return (check === 10 ? 'X' : String(check)) === digits.at(-1) ? `https://orcid.org/${id}` : null;
}

/** A contributor from the form's two fields, or {error} saying what is wrong, in words. */
export function fromForm(name, orcid) {
  name = String(name).trim();
  if (!name) return { error: 'Please give your name.' };
  if (!String(orcid).trim()) return { name };
  const uri = orcidUri(orcid);
  return uri ? { name, orcid: uri } : { error: 'That is not an ORCID iD: it should be sixteen digits in four groups (the last may be X), such as 0000-0002-1825-0097, and its last digit is a check on the others.' };
}
