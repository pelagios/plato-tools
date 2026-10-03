// Hermes, on the page: "Group similar spellings…" for a table of places (CSV, plain GeoJSON, a sheet
// of a workbook), under the Reading options (Methodos #28, stage 1). The user chooses a column and a
// way of grouping; the worker reads the column and proposes the groups (src/engine/hermes/cluster.js);
// each is shown UNTICKED, with its spellings and their counts and an editable spelling to look it up
// by. Only ticked groups are ever sent with a run or a preview (confirmedGroups), and they never
// change the source's spellings: each grouped row gets a lookup spelling beside its record, and a
// note. The groups ticked are saved with the matching ({ columns, clusters }) and loaded with it.
// Kept apart from src/app.js, which calls the few functions exported here, so that the page's own
// file changes little. Words in src/engine/words.js (CLUSTER_WORDS); hints are data-tip, never title.
import { CLUSTER_WORDS as W } from './engine/words.js';
import { CLUSTER_METHODS, DEFAULT_METHOD, confirmedGroups, checkClusters } from './engine/hermes/cluster.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The panel, in `box` (an element of the page). `ask(message)` posts to the worker; `changed()` is
 * called whenever what a run would be given changes (the preview is then cleared); `publish(state)`
 * gives the panel's state for the page's window.__plato.
 */
export function spellingsPanel({ box, ask, changed = () => {}, publish = () => {} }) {
  let headers = [], nameColumn, on = false, open = false, asked = 0, waiting = false, message = '', loadedNote = '';
  // What is shown for each column: { method, rows: [{ members: [{ value, count }], chosen, ticked,
  // saved?, notFound? }] }: saved for a group loaded with a matching, notFound for a ticked group kept
  // although the last "Find groups" did not find it.
  let shown = Object.create(null);
  let column, method = DEFAULT_METHOD;

  const confirmed = () => {
    let out = Object.create(null);
    for (const [c, s] of Object.entries(shown)) out = confirmedGroups(c, s.method, s.rows, out);
    return out;
  };
  const tickedCount = () => Object.values(shown).reduce((n, s) => n + s.rows.filter((r) => r.ticked && r.chosen.trim()).length, 0);
  const emptyTicked = () => Object.values(shown).some((s) => s.rows.some((r) => r.ticked && !r.chosen.trim()));

  function state() {
    const s = shown[column];
    publish({
      shown: on, open, column: column ?? null, method, waiting, message: box.querySelector('#spellings-message')?.textContent || '',
      rows: s ? s.rows.map((r) => ({ members: r.members.map((m) => ({ ...m })), chosen: r.chosen, ticked: r.ticked, ...(r.notFound ? { notFound: true, saved: !!r.saved } : {}) })) : [],
      confirmed: JSON.parse(JSON.stringify(confirmed())), ticked: tickedCount(),
    });
  }

  function render() {
    box.hidden = !on;
    if (!on) { box.innerHTML = ''; state(); return; }
    if (!open) {
      box.innerHTML = `<button type="button" id="spellings-open" data-tip="${esc(W.tip)}">${esc(W.button)}</button>`
        + `<span id="spellings-ticked" class="spellings-ticked" aria-live="polite">${tickedCount() ? ` ${esc(W.ticked(tickedCount()))}` : ''}</span>`
        + (loadedNote ? `<p class="spellings-loaded">${esc(loadedNote)}</p>` : '');
      state();
      return;
    }
    const s = shown[column];
    const columnOptions = headers.map((h) => `<option value="${esc(h)}"${h === column ? ' selected' : ''}>${esc(h)}</option>`).join('');
    const methodOptions = CLUSTER_METHODS.map((m) => `<option value="${m}"${m === method ? ' selected' : ''}>${esc(W.methods[m])}</option>`).join('');
    const rows = s ? s.rows.map((r, i) => `<tr><td><input type="checkbox" id="spellings-use-${i}" data-spellings-use="${i}"${r.ticked ? ' checked' : ''} aria-label="${esc(W.useLabel(r.chosen))}"></td>`
      + `<td><ul class="examples">${r.members.map((m) => `<li><code>${esc(m.value)}</code>${m.count === null || m.count === undefined ? '' : ` (${m.count.toLocaleString('en-GB')})`}</li>`).join('')}</ul>`
      + `${r.notFound ? `<p class="spellings-not-found">${esc(r.saved ? W.savedNotFound : W.tickedNotFound)}</p>` : ''}</td>`
      + `<td><input type="text" id="spellings-chosen-${i}" data-spellings-chosen="${i}" value="${esc(r.chosen)}" size="24" spellcheck="false" autocomplete="off" aria-label="${esc(W.chosenLabel(r.members[0]?.value ?? ''))}"></td></tr>`).join('') : '';
    box.innerHTML = `<fieldset class="reading spellings-box"><legend>${esc(W.legend)}</legend><p>${esc(W.intro)}</p>`
      + `<p class="spellings-choice"><label for="spellings-column">${esc(W.columnLabel)}</label> <select id="spellings-column">${columnOptions}</select> `
      + `<label for="spellings-method">${esc(W.methodLabel)}</label> <select id="spellings-method">${methodOptions}</select> `
      + `<button type="button" id="spellings-find"${waiting ? ' disabled' : ''}>${esc(W.find)}</button> <button type="button" id="spellings-close">${esc(W.close)}</button></p>`
      + `<div id="spellings-message" aria-live="polite">${message ? `<p>${esc(message)}</p>` : ''}</div>`
      + (s && s.rows.length ? `<div class="columns-scroll"><table class="columns-table spellings-table"><caption>${esc(W.caption(column))}</caption>`
        + `<thead><tr><th scope="col">${esc(W.use)}</th><th scope="col">${esc(W.spellings)}</th><th scope="col">${esc(W.chosen)}</th></tr></thead><tbody>${rows}</tbody></table></div>` : '')
      + `<p id="spellings-ticked" class="spellings-ticked" aria-live="polite">${esc(emptyTicked() ? W.chosenEmpty : W.ticked(tickedCount()))}</p></fieldset>`;
    state();
  }

  function find() {
    if (!column || waiting) return;
    waiting = true; message = W.finding;
    render();
    ask({ cmd: 'cluster', id: ++asked, column, method });
  }

  box.addEventListener('click', (e) => {
    if (e.target.id === 'spellings-open') { open = true; render(); }
    else if (e.target.id === 'spellings-close') { open = false; render(); }
    else if (e.target.id === 'spellings-find') find();
  });
  box.addEventListener('change', (e) => {
    // A new column or way of grouping: an answer still to come for the old one is set aside (asked).
    if (e.target.id === 'spellings-column') { column = e.target.value; method = shown[column]?.method || method; asked++; waiting = false; message = ''; render(); }
    else if (e.target.id === 'spellings-method') { method = e.target.value; asked++; waiting = false; message = ''; render(); }
    else if (e.target.matches('input[data-spellings-use]')) {
      const r = shown[column]?.rows[Number(e.target.dataset.spellingsUse)];
      if (r) { r.ticked = e.target.checked; changed(); }
      const t = box.querySelector('#spellings-ticked'); if (t) t.textContent = emptyTicked() ? W.chosenEmpty : W.ticked(tickedCount());
      state();
    }
  });
  box.addEventListener('input', (e) => {
    if (!e.target.matches('input[data-spellings-chosen]')) return;
    const r = shown[column]?.rows[Number(e.target.dataset.spellingsChosen)];
    if (!r) return;
    r.chosen = e.target.value;
    if (r.ticked) changed();
    const t = box.querySelector('#spellings-ticked'); if (t) t.textContent = emptyTicked() ? W.chosenEmpty : W.ticked(tickedCount());
    state();
  });

  return {
    /** A new file: shown only for a table of places, with nothing grouped. */
    reset(table) {
      on = !!table; open = false; asked++; waiting = false; message = ''; loadedNote = '';
      shown = Object.create(null); headers = []; column = undefined; method = DEFAULT_METHOD;
      render();
    },
    /** The columns as read (and which is the name), each time the matching is read again. */
    columns(hs, name) {
      headers = [...hs]; nameColumn = name;
      if (!column || !headers.includes(column)) column = nameColumn && headers.includes(nameColumn) ? nameColumn : headers[0];
      render();
    },
    /**
     * The worker's answer: the groups proposed, each unticked, unless the same group was already
     * ticked (or loaded). A ticked group not found again this way is kept, still ticked, after them,
     * marked as not found, and the message says how many: a "Find groups" never drops a tick.
     */
    answer(d) {
      if (d.id !== asked) return;
      waiting = false;
      if (d.error) { message = W.cannotRead(d.error); render(); return; }
      const before = shown[d.column]?.rows || [];
      const refound = new Set();
      const rows = d.clusters.map((c) => {
        const values = c.members.map((m) => m.value);
        const kept = before.find((r) => r.ticked && !refound.has(r) && sameSet(r.members.map((m) => m.value), values));
        if (kept) refound.add(kept);
        return { members: c.members.map((m) => ({ value: m.value, count: m.count })), chosen: kept ? kept.chosen : c.suggested, ticked: !!kept };
      });
      const carried = before.filter((r) => r.ticked && !refound.has(r)).map((r) => ({ ...r, members: r.members.map((m) => ({ ...m })), notFound: true }));
      const wasTicked = before.some((r) => r.ticked);
      shown[d.column] = { method: d.method, rows: [...rows, ...carried] };
      message = (rows.length ? W.found(rows.length, d.column, d.distinct) : W.none(d.column, d.distinct)) + (carried.length ? ` ${W.carried(carried.length)}` : '');
      if (wasTicked) changed();
      render();
    },
    /** Groups loaded with a saved matching: shown ticked, as they were saved. Throws a DataError for groups that cannot be used. */
    load(clusters) {
      const checked = checkClusters(clusters);
      shown = Object.create(null);
      let n = 0;
      for (const [c, { method: m, groups }] of Object.entries(checked)) {
        shown[c] = { method: m, rows: groups.map((g) => ({ members: g.members.map((value) => ({ value, count: null })), chosen: g.chosen, ticked: true, saved: true })) };
        n += groups.length;
      }
      loadedNote = n ? W.loaded(n, Object.keys(checked)) : '';
      changed();
      render();
    },
    /** What a run or a preview is given: { clusters } with the ticked groups only, or nothing. */
    options() { const c = confirmed(); return Object.keys(c).length ? { clusters: c } : {}; },
    /** The ticked groups, to save with the matching. */
    confirmed,
    /** Why a run cannot be given the groups (a ticked group with no spelling), or null. */
    problem() { return emptyTicked() ? W.chosenEmpty : null; },
  };
}
