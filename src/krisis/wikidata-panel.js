// Krisis: the panel "Wikidata items for the places no gazetteer knows" under the review (Issue #36;
// src/engine/krisis/wikidata.js, wikidata-search.js; the words are words.js WIKIDATA_WORDS). Five parts, in
// the order the user goes through them: the search in Wikidata (through the permissions module, under
// gazetteer:wikidata; its hits go into the review on screen), the licence gate (the consent statement, kept
// in the work file), the items (the statements ticked, each item's description and kind editable, a place
// left out), the batch (the volume, the QuickStatements text downloaded, the how-to), and the Q-ids back
// (pasted, or the user's own new items read; each checked in Wikidata before it is recorded as a decision).
// Everything it records goes into the work object (work.mint, the lookups, the candidates), which "Save the
// review" saves and Finish writes.
//
// Mounted by src/app.js with what it needs of the page: the work object and its name, the dataset's files
// and places (gather()'s, through the worker), the collector run in the worker, the reviewer, the fetch
// every request goes through (lookup.js permittedFetch over permissions.fetch), and the page's own words
// for a permission's line. It runs on the page's thread, as the lookup does, never in the worker.
import { WIKIDATA_WORDS as T } from '../engine/words.js';
import {
  qualifying, planItems, quickStatementsV1, consentRecord, mintOf, recordBatch, readPastedQids, pairPasted, verifyItem, matchItems, recordMinted,
  batchName, CLASSES, STATEMENTS, MAX_ITEMS, WIKIDATA_SERVICE, QUICKSTATEMENTS, BOT_REQUESTS, WIKIPROJECT, EDIT_GROUPS, wdLang,
} from '../engine/krisis/wikidata.js';
import { searchPreview, runWikidataSearch, readContribs, readEntities } from '../engine/krisis/wikidata-search.js';
import { sha256 } from '../lib/sha256.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * host: { el (the <details>), work(), workName(), places() -> Promise<{ places, subjects } | null> (gather()'s), collect(places)
 *   -> Promise<{ gazetteer, records: Map } | null> (the worker's wikidata-collect), reviewer() -> { name, orcid? } | null,
 *   askName(), fetch (permittedFetch's), needsLine(el, svc), mayAsk(svc), base() -> string | undefined, saveBlob(blob, name),
 *   changed() (the work changed: unsaved++ and render), rerender() (the review's render, after a search adds candidates),
 *   state (window.__plato; `wikidata` is written there for the tests), busy() -> whether a run is in hand }.
 */
export function mountWikidata(host) {
  const { el } = host;
  const q = (id) => el.querySelector(`#wikidata-${id}`);
  const svc = { service: WIKIDATA_SERVICE, whg: false };
  let searching = null, plan = null, planKey = null, collected = null, checked = [], note = { search: '', ids: '', batch: '' }, batchFor = null;
  const state = (more) => { host.state.wikidata = { ...(host.state.wikidata || {}), ...more }; };

  // ---- the static words, once ----
  q('intro').textContent = T.intro;
  q('search-h').textContent = T.searchHeading; q('gate-h').textContent = T.gateHeading; q('items-h').textContent = T.itemsHeading; q('batch-h').textContent = T.batchHeading; q('ids-h').textContent = T.idsHeading;
  q('consent-text').textContent = T.consentLabel;
  q('statements').innerHTML = `<legend>${escapeHtml('Statements to write')}</legend>` + STATEMENTS.map((k) => `<label><input type="checkbox" data-statement="${k}" checked> ${escapeHtml(T.statements[k])}</label>`).join('');
  q('lang-label').textContent = T.langLabel;
  q('download').textContent = T.download;
  q('howto').innerHTML = T.howTo.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
  q('links').innerHTML = [[QUICKSTATEMENTS, 'QuickStatements'], [EDIT_GROUPS, 'Edit groups'], [BOT_REQUESTS, 'Bot approval'], [WIKIPROJECT, 'WikiProject Historical Place']].map(([u, t]) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t} ↗</a>`).join(' · ');
  q('paste-label').textContent = T.pasteLabel; q('check').textContent = T.check; q('user-label').textContent = T.userLabel; q('read').textContent = T.readMine;
  q('record').textContent = T.record(0);

  // ---- what the work file holds ----
  const work = () => host.work();
  const mint = () => (work() ? mintOf(work()) : null);
  const options = () => { const m = mint(); return m ? { statements: m.options.statements, lang: m.options.lang ?? null } : { statements: {}, lang: null }; };
  /** The places with no match, as the search takes them: ready, never searched, or searched without an answer. */
  const toSearch = (places) => { const s = qualifying(work(), places); return new Set([...s.ready, ...s.leftOut.notSearched, ...s.leftOut.unanswered]); };

  // ---- the plan: computed when the panel is open, cached until the work changes ----
  const keyOf = () => { const w = work(); return w ? `${w.candidates.length}|${(w.lookups || []).length}|${JSON.stringify(w.mint || null)}|${w.candidates.filter((c) => c.decision).length}|${host.workName()}` : null; };
  async function thePlan() {
    const w = work();
    if (!w) return null;
    const g = await host.places();
    const key = `${keyOf()}|${g ? 'g' : '-'}`;
    if (plan && planKey === key) return plan;
    if (!collected || collected.for !== g) collected = { for: g, records: g ? await host.collect(null) : null };
    const o = options();
    plan = planItems({ work: w, places: g?.places ?? null, records: collected.records, options: { statements: o.statements, lang: o.lang, base: host.base() || collected.records?.gazetteer?.uriSpace || null } });
    planKey = key;
    return plan;
  }
  const invalidate = () => { plan = null; planKey = null; };

  // ---- drawing ----
  let drawing = 0;
  async function draw() {
    const n = ++drawing;
    const w = work();
    el.hidden = !w;
    // Closed, the panel asks nothing: reading the places (the worker's gather) makes the page busy, and the review's
    // keys do nothing while it is (the match review's e2e found a key lost that way, 15 October 2026).
    if (!w || !el.open) return;
    const g = await host.places();
    if (n !== drawing) return;
    // 1. The search.
    const want = toSearch(g?.places ?? null);
    const chosen = (g?.places ?? Object.entries(w.places).map(([iri, p]) => ({ iri, ...p }))).filter((p) => want.has(p.iri));
    const preview = searchPreview(chosen, { lang: options().lang, nearKm: 5 });
    const sb = q('search');
    host.needsLine(q('permission'), svc);
    const may = host.mayAsk(svc);
    sb.hidden = !may || !!searching; q('stop').hidden = !searching;
    sb.textContent = T.search(preview.places); sb.disabled = !preview.places || host.busy();
    q('search-status').textContent = note.search || (preview.places ? T.searchPreview(preview) : T.searchNone);
    const undecided = qualifying(w, g?.places ?? null).leftOut.undecided.length;
    q('hits').textContent = undecided ? T.hitsToDecide(undecided) : '';
    // 2. The licence, and 3. the items, from the plan (the records read in the worker).
    const p = el.open ? await thePlan() : null;
    if (n !== drawing) return;
    const gate = p?.gate ?? null;
    q('gate').textContent = T.gate(gate);
    const m = mintOf(w);
    const row = q('consent-row');
    row.hidden = gate?.kind !== 'consent';
    q('consent').checked = !!m.consent;
    q('consented').textContent = m.consent ? T.consented(m.consent) : '';
    for (const box of el.querySelectorAll('[data-statement]')) box.checked = m.options.statements[box.dataset.statement] !== false;
    if (document.activeElement !== q('lang')) q('lang').value = m.options.lang || '';
    drawItems(p);
    // 4. The batch.
    const ok = p && gate && gate.kind !== 'refused' && p.items.length > 0 && p.items.length <= MAX_ITEMS && (gate.kind === 'free' || !!m.consent);
    q('download').disabled = !ok || host.busy();
    const warn = [];
    if (p && p.items.length > MAX_ITEMS) warn.push(T.tooMany(p.items.length, MAX_ITEMS));
    if (p && gate?.kind === 'consent' && !m.consent && p.items.length) warn.push(T.consentNeeded);
    if (p && collected?.records?.gazetteer && collected.records.gazetteer.status !== 'published' && p.items.length) warn.push(T.unpublished);
    const notFree = p ? p.items.reduce((k, it) => k + it.leftOut.length, 0) : 0;
    if (notFree) warn.push(T.notFree(notFree));
    if (p?.whgNotSearched) warn.push(T.whgNotSearched(p.whgNotSearched));
    q('volume').textContent = p ? T.volume(p.count) : '';
    q('warnings').textContent = warn.join(' '); q('warnings').hidden = !warn.length;
    q('batches').textContent = note.batch || m.batches.map((b) => T.written(b)).join(' ');
    // 5. The Q-ids back.
    const last = m.batches.at(-1);
    q('ids-status').textContent = note.ids || (last ? '' : T.noBatch);
    q('check').disabled = !last || host.busy(); q('read').disabled = !last || !may || host.busy();
    q('user').value = q('user').value || m.user || '';
    drawChecked();
    state({ ready: p ? p.items.map((it) => it.iri) : null, left: p ? Object.fromEntries(Object.entries(p.left).filter(([, v]) => v.length)) : null, gate: gate?.kind ?? null, consent: !!m.consent, batches: m.batches.map((b) => b.id), qids: m.qids, searching: !!searching, searchable: preview.places });
  }
  function drawItems(p) {
    const box = q('items');
    if (!p) { box.innerHTML = ''; q('items-status').textContent = ''; return; }
    const left = T.leftOutLine(p.left);
    q('items-status').textContent = `${p.items.length ? T.ready(p.items.length) : T.noItems}${left ? ` Left out: ${left}.` : ''}`;
    const kinds = (chosen) => `<option value="">${escapeHtml(T.kindChoose)}</option>` + CLASSES.map((c) => `<option value="${c.qid}"${chosen === c.qid ? ' selected' : ''}>${escapeHtml(c.word)} (${c.qid})</option>`).join('');
    const rows = p.items.map((it) => `<li data-iri="${escapeHtml(it.iri)}"><strong>${escapeHtml(it.label)}</strong> <span class="iri">${escapeHtml(it.iri)}</span>`
      + `<label>${escapeHtml(T.descriptionLabel)} <input type="text" data-description value="${escapeHtml(it.description)}" size="60"></label>`
      + `<label>${escapeHtml(T.kindLabel)} <select data-kind>${kinds(it.class?.qid)}</select> <small>${escapeHtml(it.class ? `${it.class.word} (${it.class.how === 'chosen' ? 'chosen' : it.class.how === 'dataset-class' ? 'the dataset\'s own class' : it.class.how === 'facet' ? 'a settlement of no listed kind' : 'from its kind'})` : '')}</small></label>`
      + (it.warnings.length ? `<p class="warn">${escapeHtml(it.warnings.map((k) => T.warnings[k] || k).join('; '))}.</p>` : '')
      + (it.leftOut.length ? `<p class="warn">${escapeHtml(T.notFree(it.leftOut.length))}</p>` : '')
      + `<button type="button" data-exclude>${escapeHtml(T.exclude)}</button></li>`);
    // Places left out for want of a kind, with the choice; and those the user left out, with the way back.
    const noKind = p.left.noKind.map((iri) => `<li data-iri="${escapeHtml(iri)}" class="no-kind"><strong>${escapeHtml(work().places[iri]?.label || iri)}</strong> <span class="iri">${escapeHtml(iri)}</span><label>${escapeHtml(T.kindLabel)} <select data-kind>${kinds(null)}</select></label> <small>${escapeHtml(T.leftOut.noKind)}</small></li>`);
    const excluded = p.left.excluded.map((iri) => `<li data-iri="${escapeHtml(iri)}" class="excluded"><strong>${escapeHtml(work().places[iri]?.label || iri)}</strong> <span class="iri">${escapeHtml(iri)}</span> <small>${escapeHtml(T.leftOut.excluded)}</small> <button type="button" data-include>${escapeHtml(T.include)}</button></li>`);
    box.innerHTML = `<ul>${[...rows, ...noKind, ...excluded].join('')}</ul>`;
  }
  function drawChecked() {
    const list = q('ids');
    list.innerHTML = checked.map((c) => `<li><span class="iri">${escapeHtml(c.iri)}</span>: <strong>${escapeHtml(c.qid)}</strong> ${escapeHtml(c.missing ? 'Not recorded: there is no such item in Wikidata.' : c.verified.ok ? T.verified(c.verified) : T.notVerified(c.verified))}${c.recorded ? ' Recorded.' : ''}</li>`).join('');
    const n = checked.filter((c) => c.verified?.ok && !c.recorded).length;
    q('record').hidden = !n; q('record').textContent = T.record(n); q('record').disabled = host.busy();
  }

  // ---- edits: the statements, the language, a description, a kind, a place left out ----
  el.addEventListener('change', (e) => {
    const m = mint(); if (!m) return;
    const t = e.target;
    if (t.matches('[data-statement]')) { m.options.statements = { ...m.options.statements, [t.dataset.statement]: t.checked }; invalidate(); host.changed(); }
    else if (t.id === 'wikidata-lang') { const v = t.value.trim(); m.options.lang = v && wdLang(v) ? wdLang(v) : null; t.value = m.options.lang || ''; invalidate(); host.changed(); }
    else if (t.id === 'wikidata-consent') {
      if (t.checked) {
        const who = host.reviewer();
        if (!who) { t.checked = false; host.askName(); note.batch = T.needName; draw(); return; }
        try { m.consent = consentRecord({ by: who, licence: plan?.gate?.licence ?? null }); } catch (err) { t.checked = false; note.batch = err.message; draw(); return; }
      } else m.consent = null;
      note.batch = ''; host.changed();
    } else if (t.matches('[data-description]')) { const iri = t.closest('li').dataset.iri; m.items[iri] = { ...(m.items[iri] || {}), description: t.value }; if (!t.value.trim()) delete m.items[iri].description; invalidate(); host.changed(); }
    else if (t.matches('[data-kind]')) { const iri = t.closest('li').dataset.iri; m.items[iri] = { ...(m.items[iri] || {}) }; if (t.value) m.items[iri].kind = t.value; else delete m.items[iri].kind; invalidate(); host.changed(); }
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); const m = mint(); if (!b || !m) return;
    if (b.matches('[data-exclude]') || b.matches('[data-include]')) {
      const iri = b.closest('li').dataset.iri;
      m.items[iri] = { ...(m.items[iri] || {}) };
      if (b.matches('[data-exclude]')) m.items[iri].excluded = true; else delete m.items[iri].excluded;
      invalidate(); host.changed();
    }
  });

  // ---- 1. the search ----
  q('search').addEventListener('click', async () => {
    const w = work();
    if (!w || searching || host.busy()) return;
    if (!host.mayAsk(svc)) return draw();
    const g = await host.places();
    if (!g?.places) { note.search = T.noDataset; return draw(); }
    const want = toSearch(g.places);
    const chosen = g.places.filter((p) => want.has(p.iri));
    if (!chosen.length) { note.search = T.searchNone; return draw(); }
    searching = new AbortController();
    note.search = T.searching({ done: 0, total: chosen.length });
    state({ searching: true, stopped: null });
    draw();
    let result = null, fault = null;
    try {
      result = await runWikidataSearch({ fetch: host.fetch(searching), work: w, places: chosen, options: { lang: options().lang }, reviewer: host.reviewer(), signal: searching.signal,
        onBatch: ({ done, total }) => { note.search = T.searching({ done, total }); q('search-status').textContent = note.search; host.rerender(); } });
    } catch (e) { fault = e; console.error('Krisis, Wikidata search:', e?.stack || e); }
    finally { searching = null; }
    invalidate();
    const stopped = fault ? { kind: 'fault', message: null } : result.stopped;
    note.search = `${result ? T.searched(result.record.counts) : ''}${stopped ? ` ${T.stopped(stopped)}` : ''}`.trim();
    state({ searching: false, stopped: stopped?.kind ?? null, searched: result ? result.record.counts : null });
    host.changed();
  });
  q('stop').addEventListener('click', () => searching?.abort());

  // ---- 4. the batch ----
  q('download').addEventListener('click', async () => {
    const w = work(); if (!w || host.busy()) return;
    const p = await thePlan();
    const m = mintOf(w);
    if (!p || p.gate?.kind === 'refused' || !p.items.length) return draw();
    if (p.items.length > MAX_ITEMS) { note.batch = T.tooMany(p.items.length, MAX_ITEMS); return draw(); }
    if (p.gate?.kind === 'consent' && !m.consent) { note.batch = T.consentNeeded; return draw(); }
    const date = new Date().toISOString().slice(0, 10);
    const text = quickStatementsV1(p.items, { date, title: collected?.records?.gazetteer?.title ?? null, statements: m.options.statements });
    const name = batchName(host.workName());
    const b = recordBatch(w, { items: p.items, name, sha256: await sha256(text), statements: m.options.statements });
    batchFor = b.id;
    host.saveBlob(new Blob([text], { type: 'text/plain' }), name);
    note.batch = `${T.written(b)} Save the review as well: it records the batch.`;
    state({ batchText: text, batch: b.id });
    host.changed();
  });

  // ---- 5. the Q-ids back ----
  const rowsOf = async (b) => { const p = await thePlan(); return (p?.items || []).filter((it) => b.places.includes(it.iri)).sort((x, y) => b.places.indexOf(x.iri) - b.places.indexOf(y.iri)); };
  /** The items of a batch again, for the rows: a place left out or decided since is no longer in the plan, so its row comes from the batch's record and the work file. */
  async function batchRows(b) {
    const rows = await rowsOf(b);
    const w = work();
    for (const iri of b.places) if (!rows.some((r) => r.iri === iri)) rows.push({ iri, labels: { und: w.places[iri]?.label || iri }, point: w.places[iri]?.point ?? null, fromWork: true });
    return rows.sort((x, y) => b.places.indexOf(x.iri) - b.places.indexOf(y.iri));
  }
  async function verifyPairs(pairs, b) {
    const ctl = new AbortController();
    const fetch = host.fetch(ctl);
    const rows = await batchRows(b);
    const { entities } = await readEntities({ fetch, ids: pairs.map((p) => p.qid), signal: ctl.signal });
    return pairs.map((p) => {
      const e = entities[p.qid], row = rows.find((r) => r.iri === p.iri);
      if (!e || e.missing !== undefined || !row) return { ...p, missing: true, verified: { ok: false } };
      return { ...p, verified: p.verified || verifyItem(e, row), label: e.labels?.en?.value ?? null };
    });
  }
  q('check').addEventListener('click', async () => {
    const w = work(); const m = mint(); const b = m?.batches.at(-1);
    if (!w || !b || host.busy()) return;
    if (!host.mayAsk(svc)) { note.ids = ''; host.needsLine(q('permission'), svc); return draw(); }
    const qids = readPastedQids(q('qids').value);
    const pairs = pairPasted(qids, await batchRows(b));
    note.ids = `${T.pastedCounts(pairs)} ${T.checking}`; draw();
    try { checked = await verifyPairs(pairs.pairs.map((p) => ({ ...p, how: 'pasted' })), b); note.ids = T.pastedCounts(pairs); }
    catch (e) { note.ids = e?.name === 'PermissionError' || e?.name === 'WikidataError' ? e.message : T.stopped({ kind: 'fault' }); console.error('Krisis, Wikidata ids:', e?.stack || e); }
    batchFor = b.id;
    state({ checked: checked.map((c) => ({ qid: c.qid, iri: c.iri, ok: !!c.verified?.ok })) });
    draw();
  });
  q('read').addEventListener('click', async () => {
    const w = work(); const m = mint(); const b = m?.batches.at(-1);
    if (!w || !b || host.busy()) return;
    if (!host.mayAsk(svc)) { host.needsLine(q('permission'), svc); return draw(); }
    const user = q('user').value.trim();
    if (!user || /@/.test(user)) { note.ids = 'Give your Wikidata user name (never an address with @ in it).'; return draw(); }
    m.user = user;
    note.ids = T.checking; draw();
    try {
      const ctl = new AbortController(), fetch = host.fetch(ctl);
      const contribs = await readContribs({ fetch, user, since: b.at, signal: ctl.signal });
      const { entities } = await readEntities({ fetch, ids: contribs.items.map((x) => x.qid), signal: ctl.signal });
      const rows = await batchRows(b);
      const matched = matchItems(entities, rows);
      checked = matched.matched.map((x) => ({ qid: x.qid, iri: x.iri, how: 'contribs', verified: x.verified }));
      note.ids = T.readCounts({ items: contribs.items.length, matched: matched.matched.length, twice: matched.twice.length });
    } catch (e) { note.ids = e?.name === 'PermissionError' || e?.name === 'WikidataError' ? e.message : T.stopped({ kind: 'fault' }); console.error('Krisis, Wikidata ids:', e?.stack || e); }
    batchFor = b.id;
    state({ checked: checked.map((c) => ({ qid: c.qid, iri: c.iri, ok: !!c.verified?.ok })) });
    host.changed();
  });
  q('record').addEventListener('click', () => {
    const w = work(); const m = mint(); if (!w || !m || host.busy()) return;
    const who = host.reviewer();
    if (!who) { host.askName(); note.ids = T.needName; return draw(); }
    const b = m.batches.find((x) => x.id === batchFor) || m.batches.at(-1);
    let n = 0;
    for (const c of checked) {
      if (!c.verified?.ok || c.recorded) continue;
      try { recordMinted(w, c.iri, c.qid, { batch: b, reviewer: who, how: c.how, verified: c.verified, label: c.label ?? null }); c.recorded = true; n++; }
      catch (e) { note.ids = e.message; }
    }
    note.ids = n ? T.recorded(n) : T.nothingVerified;
    state({ recorded: Object.keys(m.qids).length });
    invalidate();
    host.changed();
  });

  el.addEventListener('toggle', () => { if (el.open) draw(); });
  return {
    /** Drawn again: on every render of the review (cheap unless the panel is open), and when the review begins or changes. */
    refresh() { draw(); },
    /** A new review: nothing of the last one's notes or checks is kept. */
    reset() { searching?.abort(); searching = null; plan = null; planKey = null; collected = null; checked = []; note = { search: '', ids: '', batch: '' }; batchFor = null; q('qids').value = ''; draw(); },
    searching: () => !!searching,
  };
}
