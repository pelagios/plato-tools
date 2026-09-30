// The site's pages, for people: a page for each place and source, the landing page, the lists of
// places, and the page GitHub Pages serves for an address it has no file for. Plain HTML with its
// style inline: no script, no map, no font or file from anywhere else, so a page works as saved,
// offline, and for as long as the files are kept, and nothing is fetched from a third party.
//
// Every link inside the site is relative (from place/<key>/index.html the landing page is ../../),
// so the same files work at the base address and at a GitHub Pages address under a repository's
// name. The 404 page is the exception: Pages serves it at whatever address was missed, so its
// links must start from the site's own address, which the caller gives it.
//
// Everything that comes from the data is escaped. A link is made only of an http(s) address:
// anything else (javascript:, data:) is shown as text.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isWeb = (s) => typeof s === 'string' && /^https?:\/\/[^\s]+$/i.test(s);
/** A link, or the text alone when the address is not a web address. `href` may be relative when `internal`. */
export function a(href, text, { internal = false, cls } = {}) {
  if (!internal && !isWeb(href)) return esc(text ?? href);
  return `<a href="${esc(href)}"${cls ? ` class="${cls}"` : ''}>${esc(text ?? href)}</a>`;
}
/** The last part of an address, for a vocabulary term shown by name: plato#StanceReported -> StanceReported. */
export const localName = (iri) => (typeof iri === 'string' ? iri.replace(/[#/]+$/, '').split(/[#/]/).pop() : '');
const words = (name) => name.replace(/^(Type|Stance|Role|Name|Attribution)(?=[A-Z])/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
/** A term from a vocabulary: its name, linked to its address. */
const term = (iri) => (typeof iri === 'string' ? a(iri, words(localName(iri))) : '');
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const join = (parts, sep = ', ') => parts.filter((x) => x !== '' && x !== undefined && x !== null).join(sep);

// The style sheet, one file at the site's root (SITE_CSS) that every page links to: inline, it
// would be written again in every page, some 2 KB each, which at a million places is 2 GB.
export const CSS_FILE = 'site.css';
export const CSS = `:root{--fg:#1d1d1f;--bg:#fbfaf7;--muted:#5d5d63;--line:#dcd8cf;--accent:#7a3b12;--warn-bg:#fff1c2;--warn-fg:#5c4000;--gone-bg:#f3e3e3;--gone-fg:#7a1f1f}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe8;--bg:#17171a;--muted:#a6a5a0;--line:#3a3935;--accent:#f0a36b;--warn-bg:#4a3a00;--warn-fg:#ffe7a0;--gone-bg:#4a2323;--gone-fg:#ffd0d0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main,header.site,footer{max-width:52rem;margin:0 auto;padding:0 16px}header.site{padding-top:1rem;color:var(--muted);font-size:.9rem}
h1{font-size:1.7rem;line-height:1.25;margin:.6rem 0 .2rem}h2{font-size:1.2rem;margin:2rem 0 .5rem;border-bottom:1px solid var(--line)}h3{font-size:1rem;margin:0 0 .3rem}
a{color:var(--accent)}code,.iri{font:.85rem/1.4 ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}.muted{color:var(--muted)}
ul{padding-left:1.2rem}li{margin:.15rem 0}dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.draft{background:var(--warn-bg);color:var(--warn-fg);padding:.7rem 16px;text-align:center;font-weight:600}
article.att{border:1px solid var(--line);border-radius:6px;padding:.7rem .9rem;margin:.8rem 0}article.att:target{outline:3px solid var(--accent)}
article.withdrawn{background:var(--gone-bg)}.label{display:inline-block;font-size:.8rem;font-weight:600;padding:0 .4rem;border-radius:3px;margin-right:.3rem;background:var(--gone-fg);color:var(--gone-bg)}
.label.denied{background:var(--muted);color:var(--bg)}footer{margin-top:3rem;padding-bottom:2rem;border-top:1px solid var(--line);font-size:.9rem;color:var(--muted)}
nav.pages a{margin-right:.6rem}`;

/**
 * A whole page. `root` is the relative way back to the site's root ('', '../', '../../'); `draft`
 * adds the banner and keeps search engines away (E1); `head` is more for the <head> (alternates).
 */
export function page({ title, root, draft, head = '', body, footer = '', dataset, cssRoot }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${draft ? '<meta name="robots" content="noindex">\n' : ''}<title>${esc(title)}</title>
${head}<link rel="stylesheet" href="${esc((cssRoot ?? root ?? '') + CSS_FILE)}">
</head>
<body>
${draft ? '<div class="draft" role="note">DRAFT, not citable: this dataset is not yet published, and what it says may still change or be removed.</div>\n' : ''}<header class="site"><a href="${esc(root || './')}">${esc(dataset || 'Gazetteer')}</a></header>
<main>
${body}
</main>
<footer>${footer}</footer>
</body>
</html>
`;
}

// ---- what an attestation says -------------------------------------------------------------------
function timespan(t) {
  if (!t || typeof t !== 'object') return '';
  const start = t.startEarliest ?? t.startLatest, end = t.endLatest ?? t.endEarliest;
  const range = start !== undefined && end !== undefined ? (start === end ? String(start) : `${start} to ${end}`) : start !== undefined ? `from ${start}` : end !== undefined ? `until ${end}` : '';
  const said = t.label || t.sourceLabel;
  // Each part escaped on its own: the PeriodO link is HTML already, and escaping it again would show its tags.
  return join([esc(range), said && said !== range ? esc(`“${said}”`) : '', t.periodoUri ? a(t.periodoUri, 'PeriodO') : '', t.edtfString ? esc(`EDTF ${t.edtfString}`) : '']);
}
function geometry(g) {
  if (!g || typeof g !== 'object') return '';
  const bits = [];
  if (Array.isArray(g.reprPoint) && g.reprPoint.length === 2) bits.push(`longitude ${esc(g.reprPoint[0])}, latitude ${esc(g.reprPoint[1])}`);
  if (typeof g.wkt === 'string') bits.push(`<code>${esc(g.wkt.length > 400 ? g.wkt.slice(0, 400) + ' …' : g.wkt)}</code>`);
  if (g.geojson && typeof g.geojson === 'object') {
    const t = JSON.stringify(g.geojson);
    bits.push(`<code>${esc(t.length > 400 ? t.slice(0, 400) + ' …' : t)}</code>`);
  }
  if (g.role) bits.push(`as ${term(g.role)}`);
  if (g.precisionKm !== undefined) bits.push(`to within ${esc(g.precisionKm)} km`);
  if (g.spatialPrecision) bits.push(`precision ${esc(localName(g.spatialPrecision))}`);
  if (g.sourceLabel) bits.push(`“${esc(g.sourceLabel)}”`);
  return bits.join('; ');
}
function name(n) {
  if (!n || typeof n !== 'object') return '';
  const lang = join([n.language, n.script]);
  return `<strong>${esc(n.toponym)}</strong>${lang ? ` <span class="muted">(${esc(lang)})</span>` : ''}` +
    esc(join([n.romanized ? ` romanised ${n.romanized}` : '', n.transliterationSystem ? ` (${n.transliterationSystem})` : ''], '')) +
    (n.nameType ? ` <span class="muted">${esc(list(n.nameType).map((x) => localName(x)).join(', '))}</span>` : '') +
    (n.sourceLabel ? ` <span class="muted">as written “${esc(n.sourceLabel)}”</span>` : '');
}
const type = (t) => (t && typeof t === 'object' ? a(t.identifier, t.label || localName(t.identifier)) + (t.sourceLabel ? ` <span class="muted">“${esc(t.sourceLabel)}”</span>` : '') : '');
function property(p) {
  if (!p || typeof p !== 'object') return '';
  const v = p.value !== undefined && typeof p.value === 'object' ? JSON.stringify(p.value) : p.value;
  return `${a(p.property, p.label || localName(p.property))}: ${esc(v ?? '(no value)')}${p.unit ? ' ' + term(p.unit) : ''}${p.sourceLabel ? ` <span class="muted">“${esc(p.sourceLabel)}”</span>` : ''}`;
}

/**
 * The HTML of one attestation. `ctx` gives: href(iri) -> a link inside the site or null; withdrawn
 * (target -> 'retracted' | 'superseded'); by (target -> [{ by, kind }]); anchor(att) -> the
 * element id, or null.
 */
export function attestation(att, ctx) {
  const id = typeof att['@id'] === 'string' ? att['@id'] : null;
  const anchor = ctx.anchor(att);
  const status = id ? ctx.withdrawn.get(id) : null;
  const link = (iri, text) => { const h = ctx.href(iri); return h ? a(h, text === iri || text === undefined ? localName(iri.split('#')[0]) + (iri.includes('#') ? '#' + iri.split('#').pop() : '') : text, { internal: true }) : a(iri, text); };
  const rows = [];
  const row = (label, items) => { const html = items.filter(Boolean); if (html.length) rows.push(`<dt>${label}</dt><dd>${html.length === 1 ? html[0] : '<ul>' + html.map((h) => `<li>${h}</li>`).join('') + '</ul>'}</dd>`); };
  row('Name', list(att.names).map(name));
  row('Location', list(att.geometries).map(geometry));
  row('Type', list(att.types).map(type));
  row('Property', list(att.properties).map(property));
  row('Relation', list(att.relations).map((r) => r && join([term(r.relationType) || esc(r.relationLabel), r.relatesTo ? link(r.relatesTo, r.relatedLabel || r.relatesTo) : esc(r.relatedLabel), r.sequence !== undefined ? `(stop ${esc(r.sequence)})` : ''], ' ')));
  row('Identity', list(att.identities).map((i) => i && join([esc(localName(i.identityType) || 'match'), link(i.object)], ' ')));
  row('Comments on', list(att.meta).map((m) => m && join([term(m.metaType), link(m.targetAttestation)], ' ')));
  row('When', list(att.timespans).map(timespan));
  const src = (s) => (typeof s === 'string' ? link(s) : s && typeof s === 'object' ? (s['@id'] ? link(s['@id'], s.title || s['@id']) : esc(s.title || s.citation || 'a source')) : '');
  row('Source', [...list(att.sources).map(src), ...list(att.citations).map((c) => c && join([src(c.source), c.locator ? esc(c.locator) : '', c.citationFunction ? `<span class="muted">${esc(words(localName(c.citationFunction)))}</span>` : ''], ', '))]);
  row('Certainty', [join([att.certainty !== undefined ? esc(att.certainty) : '', att.certaintyLevel ? term(att.certaintyLevel) : '', att.certaintyNote ? esc(att.certaintyNote) : ''], '; ')]);
  row('Stance', [att.sourceStance ? term(att.sourceStance) : '']);
  row('Recorded', [join([att.created ? `made ${esc(att.created)}` : '', att.modified ? `changed ${esc(att.modified)}` : '', att.contributor ? `by ${typeof att.contributor === 'string' ? link(att.contributor) : esc(att.contributor.name || att.contributor['@id'])}` : ''], ', ')]);
  row('Notes', [att.notes ? esc(att.notes) : '']);
  const labels = [];
  if (status) {
    const who = (ctx.by.get(id) || []).filter((e) => e.kind === status && e.by).map((e) => link(e.by, 'by ' + (e.by.includes('#') ? e.by.split('#').pop() : e.by)));
    labels.push(`<span class="label">${status === 'retracted' ? 'Retracted' : 'Superseded'}</span>${who.length ? `<span class="muted">${who.join(', ')}</span> ` : ''}`);
  }
  if (att.negated !== undefined && att.negated !== null && att.negated !== false) labels.push('<span class="label denied">Denied</span><span class="muted">the source says this is not so</span> ');
  const heading = `<h3>${labels.join('')}${id ? `<span class="iri">${a(id, anchor ? '#' + anchor : id)}</span>` : '<span class="muted">An attestation with no address of its own</span>'}</h3>`;
  const note = status ? `<p class="muted">Kept, as a published attestation always is, so that its address still leads here; the dataset no longer holds it to be so.</p>` : '';
  return `<article class="att${status ? ' withdrawn' : ''}"${anchor ? ` id="${esc(anchor)}"` : ''}>${heading}${note}<dl>${rows.join('')}</dl></article>`;
}

/**
 * A place's page. `ctx` as for attestation(), and: iri, key, gazetteer, draft, turtle, idrs (identity
 * matches the dataset lists apart from the place), cite (how to cite it).
 */
export function placePage(rec, ctx) {
  const atts = list(rec.attestations).filter((x) => x && typeof x === 'object');
  const current = atts.filter((x) => !(typeof x['@id'] === 'string' && ctx.withdrawn.has(x['@id'])) && !(x.negated !== undefined && x.negated !== null && x.negated !== false));
  const title = rec.label || current.flatMap((x) => list(x.names)).find((n) => n?.toponym)?.toponym || ctx.key;
  const to = (x) => { const an = ctx.anchor(x); return (html) => (an ? `${html} <a class="muted" href="#${esc(an)}">→</a>` : html); };
  const gather = (key, f) => current.flatMap((x) => list(x[key]).map((v) => to(x)(f(v)))).filter(Boolean);
  const section = (h, items) => (items.length ? `<h2>${h}</h2><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '');
  // A place or source of this site is named by its key rather than its whole address.
  const ref = (iri, text) => { const h = ctx.href(iri); return h ? a(h, text === iri || text === undefined ? localName(iri.split('#')[0]) : text, { internal: true }) : a(iri, text); };
  const idrs = [...list(rec.identityRelations), ...(ctx.idrs || [])].filter((i) => i && typeof i === 'object');
  const body = `<h1>${esc(title)}</h1>
<p class="iri">${esc(ctx.iri)}</p>
${rec.ccodes ? `<p class="muted">${esc(list(rec.ccodes).join(', '))}</p>` : ''}
<p class="muted">What the dataset says of this place, attestation by attestation, with the sources for each. Also as ${a('../' + ctx.key + '.jsonld', 'JSON-LD', { internal: true })}${ctx.turtle ? ` and ${a('../' + ctx.key + '.ttl', 'Turtle', { internal: true })}` : ''}.</p>
${section('Names', gather('names', name))}
${section('Locations', gather('geometries', geometry))}
${section('Types', gather('types', type))}
${section('Relations', gather('relations', (r) => r && join([term(r.relationType) || esc(r.relationLabel), r.relatesTo ? ref(r.relatesTo, r.relatedLabel || r.relatesTo) : esc(r.relatedLabel)], ' ')))}
${section('Identity matches', idrs.map((i) => join([esc(localName(i.identityType) || 'match'), a(i.object), i.certainty !== undefined ? `certainty ${esc(i.certainty)}` : '', i.basis ? `<span class="muted">${esc(i.basis)}</span>` : ''], ' ')))}
<h2>Attestations</h2>
${atts.length ? atts.map((x) => attestation(x, ctx)).join('\n') : '<p class="muted">None.</p>'}`;
  return page({
    title: `${title} · ${ctx.gazetteer.title || 'Gazetteer'}`, root: '../../', draft: ctx.draft, dataset: ctx.gazetteer.title,
    head: `<link rel="alternate" type="application/ld+json" href="../${esc(ctx.key)}.jsonld">\n${ctx.turtle ? `<link rel="alternate" type="text/turtle" href="../${esc(ctx.key)}.ttl">\n` : ''}`,
    body, footer: footer(ctx, '../../'),
  });
}

/** A source's page: what it is, and which places cite it (the first few, and how many in all). */
export function sourcePage(src, ctx) {
  const s = src.obj && typeof src.obj === 'object' ? src.obj : {};
  const title = s.title || s.citation || ctx.key;
  const ref = (v) => { const iri = typeof v === 'string' ? v : v && v['@id']; const text = typeof v === 'object' && v ? v.title || iri : iri; if (!iri) return esc(text || ''); const h = ctx.href(iri); return h ? a(h, text, { internal: true }) : a(iri, text); };
  const rows = [];
  const row = (l, v) => { if (v) rows.push(`<dt>${l}</dt><dd>${v}</dd>`); };
  row('Citation', s.citation ? esc(s.citation) : '');
  row('Online', s.uri ? a(s.uri) : '');
  row('Date', timespan(s.timespan));
  row('Derived from', list(s.derivedFrom).map(ref).join(', '));
  row('Licence', s.licence ? a(s.licence) : '');
  row('Kind', s.authorityType ? esc(s.authorityType) : '');
  const shown = src.places.map((p) => `<li>${p.served ? a(`../../place/${p.key}/`, p.label || p.key, { internal: true }) : esc(p.label || p.key)}</li>`).join('');
  const more = src.n > src.places.length ? `<p class="muted">and ${(src.n - src.places.length).toLocaleString('en-GB')} more; the dataset's downloads list them all.</p>` : '';
  const body = `<h1>${esc(title)}</h1>
<p class="iri">${esc(ctx.iri)}</p>
<p class="muted">A source the dataset's attestations cite. Also as ${a('../' + ctx.key + '.jsonld', 'JSON-LD', { internal: true })}${ctx.turtle ? ` and ${a('../' + ctx.key + '.ttl', 'Turtle', { internal: true })}` : ''}.</p>
${rows.length ? `<dl>${rows.join('')}</dl>` : '<p class="muted">The dataset cites this source by its address only, and says nothing more of it.</p>'}
<h2>Cited for ${src.n.toLocaleString('en-GB')} place${src.n === 1 ? '' : 's'}</h2>
<ul>${shown}</ul>${more}`;
  return page({
    title: `${title} · ${ctx.gazetteer.title || 'Gazetteer'}`, root: '../../', draft: ctx.draft, dataset: ctx.gazetteer.title,
    head: `<link rel="alternate" type="application/ld+json" href="../${esc(ctx.key)}.jsonld">\n${ctx.turtle ? `<link rel="alternate" type="text/turtle" href="../${esc(ctx.key)}.ttl">\n` : ''}`,
    body, footer: footer(ctx, '../../'),
  });
}

/** The foot of every place and source page: whose data it is, under what licence, how to cite it. */
function footer(ctx, root) {
  const g = ctx.gazetteer;
  return `<p>From ${a(root, g.title || 'the dataset', { internal: true })}${g.version ? `, version ${esc(g.version)}` : ''}${g.licence ? `, under ${a(g.licence, licenceName(g.licence))}` : ''}.</p>
<p>${ctx.draft ? 'Not to be cited: this is a draft.' : `To cite: ${esc(ctx.cite)}`}</p>`;
}
const licenceName = (l) => {
  const m = typeof l === 'string' && l.match(/creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/(\d\.\d)/i);
  return m ? (m[1] === 'publicdomain' ? (m[2] === 'zero' ? 'CC0 ' : 'Public Domain Mark ') + m[3] : `CC ${m[2].toUpperCase()} ${m[3]}`) : l;
};
/** How to cite a place: its address and the dataset's version (PLATO's docs/linked-data.md). */
export const citation = (label, iri, g) => `${label ? label + '. ' : ''}${g.title || 'Gazetteer'}${g.version ? `, version ${g.version}` : ''}. ${iri}`;

// ---- the landing page, the lists of places, the 404 page -------------------------------------------
/**
 * The landing page. `ctx`: gazetteer, scheme, draft, conceptDoi, downloads [{ file, format, size }],
 * places { inline: [{ key, label }] | null, pages: number, total, served, leftOut }, jsonld (the
 * schema.org object), turtle.
 */
export function landingPage(ctx) {
  const g = ctx.gazetteer;
  const creators = list(g.creator).map((c) => {
    if (typeof c === 'string') return a(c);
    const id = c && c['@id'];
    const orcid = typeof id === 'string' && /orcid\.org\//.test(id);
    return join([c?.name ? esc(c.name) : '', id ? a(id, orcid ? `ORCID ${id.split('/').pop()}` : id) : ''], ' ');
  });
  const rows = [];
  const row = (l, v) => { if (v) rows.push(`<dt>${l}</dt><dd>${v}</dd>`); };
  row('Address', `<span class="iri">${esc(ctx.scheme.dataset)}</span>`);
  row('Made by', creators.join('; '));
  row('Contributors', list(g.contributor).map((c) => (typeof c === 'string' ? a(c) : esc(c?.name))).join('; '));
  row('Licence', g.licence ? a(g.licence, licenceName(g.licence)) : '');
  row('Version', esc(join([g.version, g.status])));
  row('Keywords', esc(list(g.keywords).join(', ')));
  row('Covers', join([list(g.spatial).map((s) => a(s)).join(', '), g.temporal ? esc(join([g.temporal.startDate, g.temporal.endDate], ' to ')) : ''], '; '));
  const doi = ctx.conceptDoi ? String(ctx.conceptDoi).replace(/^https?:\/\/(dx\.)?doi\.org\//, '') : null;
  const cite = `${list(g.creator).map((c) => (typeof c === 'string' ? '' : c?.name)).filter(Boolean).join(', ')}${list(g.creator).some((c) => c?.name) ? '. ' : ''}${g.title || 'Gazetteer'}${g.version ? `, version ${g.version}` : ''}. ${doi ? 'https://doi.org/' + doi : ctx.scheme.dataset}`;
  const dl = ctx.downloads.map((d) => `<li>${a('download/' + d.file, d.file, { internal: true })} <span class="muted">${esc(d.format)}, ${esc(d.sizeText)}</span></li>`).join('');
  const p = ctx.places;
  const placeList = p.inline ? `<ul>${p.inline.map((x) => `<li>${a(`place/${x.key}/`, x.label || x.key, { internal: true })}</li>`).join('')}</ul>`
    : `<nav class="pages">${Array.from({ length: p.pages }, (_, i) => a(`places/${i + 1}.html`, `${(i * PAGE + 1).toLocaleString('en-GB')}–${Math.min((i + 1) * PAGE, p.served).toLocaleString('en-GB')}`, { internal: true })).join(' ')}</nav>`;
  const body = `<h1>${esc(g.title || 'Gazetteer')}</h1>
${g.description ? `<p>${esc(g.description)}</p>` : ''}
<dl>${rows.join('')}</dl>
<h2>How to cite</h2>
${ctx.draft ? '<p>This is a draft: do not cite it yet.</p>' : `<p>${esc(cite)}</p>
<p class="muted">Cite a place by its address and this version: the place's page shows how.</p>`}
<h2 id="downloads">Downloads</h2>
<p class="muted">The whole dataset${p.leftOut ? `, including the ${p.leftOut.toLocaleString('en-GB')} places this site has no page for` : ''}.</p>
<ul>${dl || '<li class="muted">None were made.</li>'}</ul>
<p class="muted">Its description for machines: ${a('index.jsonld', 'JSON-LD', { internal: true })}${ctx.turtle ? `, ${a('index.ttl', 'Turtle', { internal: true })}` : ''}.</p>
<h2>Places</h2>
<p class="muted">${p.served.toLocaleString('en-GB')} place${p.served === 1 ? '' : 's'}${p.leftOut ? ` of ${p.total.toLocaleString('en-GB')}` : ''}.</p>
${placeList}${duplicatedList(ctx.duplicated)}${unservableList(ctx.unservable, '')}`;
  return page({
    title: g.title || 'Gazetteer', root: './', draft: ctx.draft, dataset: g.title,
    head: `<link rel="alternate" type="application/ld+json" href="index.jsonld">\n<script type="application/ld+json">${JSON.stringify(ctx.jsonld).replace(/</g, '\\u003c')}</script>\n`,
    body, footer: `<p>Made with ${a('https://github.com/pelagios/plato-tools', 'PLATO tools')}.</p>`,
  });
}
/**
 * The places whose addresses the site cannot serve as files (an identifier with characters a file
 * name cannot hold, or two differing only in case): listed by address, since they have no page, and
 * sent to the downloads, which hold them. `root` leads back to the site's root.
 */
function unservableList(u, root) {
  if (!u || !u.n) return '';
  const more = u.n - u.list.length;
  return `
<h3 id="not-served">Places held only in the downloads</h3>
<p class="muted">${u.n.toLocaleString('en-GB')} place${u.n === 1 ? ' has an address' : 's have addresses'} this site cannot serve as ${u.n === 1 ? 'a file' : 'files'}, so ${u.n === 1 ? 'it has' : 'they have'} no page here: ${u.n === 1 ? 'it is' : 'they are'} in the ${a(root + '#downloads', 'downloads', { internal: true })}, with every other place.</p>
<ul>${u.list.map((x) => `<li>${x.label ? esc(x.label) + ' ' : ''}<span class="iri">${esc(x.iri)}</span></li>`).join('')}</ul>${more > 0 ? `<p class="muted">and ${more.toLocaleString('en-GB')} more.</p>` : ''}`;
}
/**
 * The places given by more than one record (the same address, or differing only after '#'): each
 * has the first record's page, and the downloads hold all the records, which the site does not.
 */
function duplicatedList(d) {
  if (!d || !d.n) return '';
  const more = d.n - d.list.length;
  const one = d.n === 1;
  return `
<h3 id="duplicated">Places given by more than one record</h3>
<p class="muted">${d.n.toLocaleString('en-GB')} place${one ? ' is' : 's are'} given by more than one record in the dataset. ${one ? 'Its page shows' : 'Their pages show'} the first record only; the ${a('#downloads', 'downloads', { internal: true })} hold all the records.</p>
<ul>${d.list.map((x) => `<li>${x.key ? a(`place/${x.key}/`, x.label || x.key, { internal: true }) + ' ' : x.label ? esc(x.label) + ' ' : ''}<span class="iri">${esc(x.iri)}</span></li>`).join('')}</ul>${more > 0 ? `<p class="muted">and ${more.toLocaleString('en-GB')} more.</p>` : ''}`;
}
/** How many links a page of the list of places holds. */
export const PAGE = 1000;
/** One page of the list of places: places/<n>.html. */
export function placesPage(n, pages, entries, ctx) {
  const nav = `<nav class="pages">${n > 1 ? a(`${n - 1}.html`, '← previous', { internal: true }) : ''}${n < pages ? a(`${n + 1}.html`, 'next →', { internal: true }) : ''}</nav>`;
  return page({
    title: `Places ${n} of ${pages} · ${ctx.gazetteer.title || 'Gazetteer'}`, root: '../', draft: ctx.draft, dataset: ctx.gazetteer.title,
    body: `<h1>Places, page ${n} of ${pages}</h1>${nav}<ul>${entries.map((x) => `<li>${a(`../place/${x.key}/`, x.label || x.key, { internal: true })}</li>`).join('')}</ul>${nav}`,
  });
}
/**
 * The page Pages serves for any address it has no file for. `root` is the site's own address when it
 * is known (so the links work from any depth), or '/' as a guess.
 */
export function notFoundPage(ctx) {
  const r = ctx.root;
  return page({
    title: `Not found · ${ctx.gazetteer.title || 'Gazetteer'}`, root: r, draft: ctx.draft, dataset: ctx.gazetteer.title,
    body: `<h1>Nothing here</h1>
<p>This site has no page at this address. Either:</p>
<ul><li>it is the address of a place or source that the dataset holds but this site has no page for${ctx.leftOut ? ` (it leaves out ${ctx.leftOut.toLocaleString('en-GB')} of the dataset's places, to stay within what GitHub Pages will serve)` : ''}: the dataset's downloads hold every one of them; or</li>
<li>there is no such place: check the address.</li></ul>${unservableList(ctx.unservable, r)}
<h2>Downloads</h2>
<ul>${ctx.downloads.map((d) => `<li>${a(r + 'download/' + d.file, d.file, { internal: true })} <span class="muted">${esc(d.format)}</span></li>`).join('')}</ul>
<p>${a(r, 'The dataset’s home page', { internal: true })}</p>`,
  });
}
