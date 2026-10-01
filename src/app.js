// The page: choose files, check or convert them, or compare them with an earlier version; show
// progress and the report, save the output.
// The work happens in a worker (src/engine/worker.js). The page publishes its own state on
// window.__plato for automated tests; nothing else reads it.
import { fmtBytes, formatName, progressText, summary, groups, draftNote, explainedLines } from './engine/words.js';
import { COLUMN_CHOICES, COLUMN_WORDS, columnWarnings, columnProblem } from './engine/words.js';
import { review as W, POOL_BUSY, POOL_STUCK } from './engine/words.js';
const REVIEW_WORDS = W;   // the review's words, where W names the words for the columns
import { readable } from './engine/input.js';
import { readWork, serialiseWork, decide, reviewPlaces, candidatesOf, isReviewed, reviewProgress, filesDiffer, checkReviewer, checkMatchOptions } from './engine/krisis/work.js';
import { stash as stashForChora, dropStale as dropStaleHandoff } from './chora/handoff.js';
import { storageNeed } from './engine/storage.js';
import * as permissions from './lib/permissions.js';
import { RELOAD_LOSES } from './lib/permission-words.js';
// Krisis: gazetteer lookup, run on this thread (never the worker), with the token from its one keeper.
import { LOOKUP_WORDS, lookupPage as LW } from './engine/words.js';
import * as whgToken from './lib/whg-token.js';
import { createLookup, WHG_ENDPOINT, isWhg } from './engine/gazetteer/index.js';
import { runLookup, planLookup, serviceOf, iriFromTemplate, iriVia, manifestSettings, newWork, defaultChoice, licenceOf, PLACE_CHOICES, WHG_REQUESTS_A_DAY } from './engine/krisis/lookup.js';
import { candidateSource } from './engine/krisis/identity.js';
const $ = (id) => document.getElementById(id);
const state = (window.__plato = { phase: 'loading' });
let worker, files = [], input = null, targets = {}, busy = false;

// The commit of PLATO tools this page was built from (scripts/build-info.mjs writes it before the
// build), for the site's workflow to run the same; absent from a build made without it.
const BUILD = Object.values(import.meta.glob('./build-info.json', { eager: true, import: 'default' }))[0] || {};
const INPUT_TO_TARGET = { tables: 'tables', 'plato-json': 'plato-json', 'plato-jsonl': 'plato-jsonl', ntriples: 'ntriples', lpf: 'lpf', 'lpf-seq': 'lpf-seq' };

function startWorker() {
  worker = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onMessage;
  worker.onerror = (e) => fail(`The engine stopped: ${e.message || 'unknown error'}`);
  worker.postMessage({ cmd: 'init', base: new URL('./', location.href).href });
}
function onMessage({ data }) {
  if (data.type === 'ready') {
    const v = data.version;
    $('plato-version').innerHTML = `${v.versionInfo} at <a href="${v.repository}/tree/${v.commit}">${v.commit.slice(0, 7)}</a>`
      // A pin to a branch other than main is a draft of PLATO, and says so wherever the pin is shown.
      + (v.draft ? ` <strong class="draft">${draftNote(v)}</strong>` : '');
    Object.assign(state, { phase: 'ready', platoCommit: v.commit, platoDraft: v.draft ? v.ref : null });
  } else if (data.type === 'detected') onDetected(data);
  else if (data.type === 'progress') onProgress(data);
  else if (data.type === 'done') onDone(data);
  else if (data.type === 'columns') onColumns(data);
  else if (data.type === 'places') onPlaces(data);   // Krisis: gazetteer lookup
  else if (data.type === 'error' && placesWaiting) onPlaces({ subjects: null, places: null, reason: data.message });
  // Another tab of the main page is running: said in words, and the run may be tried again.
  else if (data.type === 'error' && data.kind === 'pool-busy') fail(data.message, POOL_BUSY);
  // This tab could not let go of the working files: no other tab is to blame, and a reload frees them.
  else if (data.type === 'error' && data.kind === 'pool-stuck') fail(data.message, POOL_STUCK);
  else if (data.type === 'error') fail(data.message);
}

function choose(list) {
  files = [...list];
  if (!files.length) return;
  // A previous release chosen for another dataset is not this one's: it is chosen again, or not.
  $('previous').value = '';
  $('only').value = '';   // and so is a list of its places to publish
  const c = $('chosen'); c.hidden = false;
  c.innerHTML = `<ul>${files.map((f) => `<li><span class="name">${escapeHtml(f.name)}</span> <span class="count">${fmtBytes(f.size)}</span></li>`).join('')}</ul><p>Looking at it…</p>`;
  $('action').hidden = true; $('result').hidden = true; $('review').hidden = true;
  Object.assign(state, { phase: 'detecting' });
  worker.postMessage({ cmd: 'detect', files });
}
function onDetected({ input: inp, targets: t }) {
  input = inp; targets = t;
  const p = $('chosen').querySelector('p');
  // Not recognised, or recognised and refused with a reason (a IIIF Georeference Annotation): input.js, readable().
  if (!inp.format || inp.reason !== undefined) { p.innerHTML = `<span class="warn">${escapeHtml(inp.reason)}</span>`; Object.assign(state, { phase: 'unrecognised', reason: inp.reason }); return; }
  const what = formatName(inp);
  p.innerHTML = `This looks like <span class="detected">${what}</span>.`;
  const sel = $('target'); sel.innerHTML = '';
  for (const [k, v] of Object.entries(t)) {
    if (k === INPUT_TO_TARGET[inp.format]) continue;
    const o = document.createElement('option'); o.value = k; o.textContent = v.label; sel.appendChild(o);
  }
  if (tool) chooseTool(tool);   // a tool chosen first: narrowed again for this file (Arithmos: N-Triples, now that it is offered)
  document.querySelector('[data-for="tables-input"]').hidden = inp.format !== 'tables';
  // Hermes: a table of places shows which column holds what before it is run, and the web address
  // its place ids are made under.
  document.querySelector('[data-for="generic-input"]').hidden = !isTable(inp);
  // Every detection makes any answer about the columns of an earlier file stale, a table or not.
  columns = null; state.columns = null; columnsAsked++;
  if (isTable(inp)) { document.querySelector('[data-for="tables-input"]').hidden = false; requestColumns(); }
  gateOnColumns();
  $('action').hidden = false;
  Object.assign(state, { phase: 'detected', format: inp.format, profile: inp.profile || null });
  storageCheck();
  if ($('lookup').open) refreshPreview();   // Krisis: gazetteer lookup
}
async function storageCheck() {
  const w = $('storage-warning');
  try {
    const { quota } = await navigator.storage.estimate();
    const need = storageNeed(input, files);   // room for the working database and the output, generously
    w.hidden = quota > need;
    if (!w.hidden) w.textContent = `This browser allows the page only ${fmtBytes(quota)} of storage, which may not be enough for this file. A private window keeps its storage in memory and allows very little; for large files, use an ordinary window.`;
  } catch { w.hidden = true; }
}

const buttons = (disabled) => { for (const id of ['check', 'convert', 'compare', 'publish', 'match', 'resume', 'finish']) $(id).disabled = disabled; if (!disabled) gateOnColumns(); };
// Krisis: a table of places is matched, and its review finished, by the matching of its columns: until
// the worker's answer about them arrives, Match and Finish wait, or the table would be read by the guess.
const columnsPending = () => isTable(input) && !columns && !state.columns?.error;
function gateOnColumns() { if (busy) return; const wait = columnsPending(); $('match').disabled = wait; $('finish').disabled = wait; state.columnsPending = wait; }
function start(action, earlier) {
  if (busy || looking || !input?.format || input.reason !== undefined) return;   // Krisis: nor while a lookup runs
  busy = true;
  const target = action === 'convert' ? $('target').value : null;
  $('progress').hidden = false; $('result').hidden = true;
  buttons(true);
  $('phase').textContent = 'Starting…';
  Object.assign(state, { phase: 'running', action, target, report: null, outputs: null, error: null, said: null });
  const base = $('base').value.trim() || undefined;
  // Krisis: a review on the page is put away (and its keys with it) while anything but its own finishing runs.
  if (action !== 'apply') { $('review').hidden = true; lockColumns(); }
  // The version check: the files chosen are the later version, and `earlier` the one it is compared with.
  if (action === 'compare') worker.postMessage({ cmd: 'compare', earlier, later: files, options: { base } });
  else if (action === 'publish') onlyKeys().then(
    (only) => worker.postMessage({ cmd: 'publish', part: $('part').value, files, previous: [...$('previous').files], options: { base, ...publishOptions(), only } }),
    (e) => fail(`the list of places to include could not be read (${e.message || e}).`));
  // Match review (Krisis): the files chosen are the subjects, and `earlier` the other dataset; to finish, the review is applied to them.
  // A table of places is matched by the matching of its columns shown, as chosen (Hermes), which the work file keeps for finishing.
  else if (action === 'match') worker.postMessage({ cmd: 'match', subjects: files, others: earlier, options: { ...matchOptions(), base, ...(isTable(input) && columns ? { columns: { ...columns.mapping } } : {}) } });
  // The title in the options is cited only when the review has none but a file's name: one left there from an earlier match must not replace the review's own.
  else if (action === 'apply') worker.postMessage({ cmd: 'apply', subjects: files, work, options: { output: earlier, reviewer: reviewer(), othersTitle: work.others?.titleFrom === 'file-name' ? matchOptions().othersTitle : undefined, base,
    // A table is finished by the review's own matching of its columns, unless another has been loaded since: that is sent, and said to differ.
    ...(isTable(input) && columns && reviewMapping !== undefined && mappingText(columns.mapping) !== reviewMapping ? { columns: { ...columns.mapping } } : {}) } });
  else worker.postMessage({ cmd: 'run', files, action, target, options: { base, typing: $('typing').checked, cube: target === 'ntriples' && $('cube').checked,
    // Hermes: the matching of columns shown, as chosen (the same JSON as the command line's --columns).
    ...(isTable(input) && columns ? { columns: { ...columns.mapping } } : {}) } });
}
// Agora's options, from the Options panel: only those given are sent.
function publishOptions() {
  const v = (id) => $(id).value.trim() || undefined;
  const maintainers = (v('maintainers') || '').split(/[\s,]+/).map((m) => m.replace(/^@/, '')).filter(Boolean);
  return { release: v('release'), conceptDoi: v('concept-doi'), repo: v('repo'), siteUrl: v('site-url'), maintainers, turtle: $('turtle').checked, name: tablesFolder(), toolsCommit: BUILD.commit || undefined };
}
// The subset of places for the site (Options, "Only these places"): a text file of place keys, one
// to a line, read as the command line reads --only (each line trimmed, blank ones skipped), so the
// engine is given the same array from either. No file chosen is no subset: undefined, not [].
async function onlyKeys() {
  const f = $('only').files[0];
  if (!f) return undefined;
  return (await f.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
// Spreadsheet tables chosen as a folder (or dropped as one) know its name, as the command line
// does: the site's zip and the workflow's path are named after it. Chosen file by file they do
// not, and the site names them after the dataset's short name instead, and says so.
function tablesFolder() {
  if (input?.format !== 'tables' || input.container !== 'csv') return undefined;
  const dirs = new Set(files.map((f) => (f.webkitRelativePath || '').split('/').slice(0, -1).join('/')));
  const [dir] = dirs;
  return dirs.size === 1 && dir ? dir.split('/').pop() : undefined;
}
function onProgress(p) {
  $('phase').textContent = progressText(p);
  Object.assign(state, { progress: p });
}
function onDone({ report, outputs, work: found }) {
  busy = false;
  buttons(false);
  $('progress').hidden = true; $('result').hidden = false;
  const { problems, counted } = summary(report, state.action);
  $('summary').innerHTML = `<span class="${report.errors ? 'warn' : 'good'}">${problems}</span> ` + escapeHtml(counted);
  const saves = $('saves'); saves.innerHTML = '';
  for (const o of outputs || []) {
    const b = document.createElement('button'); b.className = 'primary';
    b.textContent = `Save ${o.name} (${fmtBytes(o.size)})`;
    b.onclick = () => save(o.name);
    saves.appendChild(b);
  }
  renderReport(report);
  Object.assign(state, { phase: 'done', report, outputs });
  if (state.action === 'match' && found) beginReview(found, outputs?.find((o) => /\.krisis\.json$/.test(o.name))?.name);
}
function renderReport(report) {
  const out = [];
  for (const { severity: sev, title, intro } of groups(state.action)) {
    const items = report.items.filter((i) => i.severity === sev);
    if (!items.length) continue;
    out.push(`<div class="report-group ${sev}"><h3>${title}</h3><p>${intro}</p>` + items.map((i) =>
      `<details class="item"><summary>${escapeHtml(i.message)}<span class="count">× ${i.count.toLocaleString('en-GB')}</span></summary>${i.examples.length ? `<ul>${i.examples.map((e) => `<li>${escapeHtml(String(e))}${explained(i, e)}</li>`).join('')}</ul>` : ''}</details>`).join('') + '</div>');
  }
  $('report').innerHTML = out.join('');
}
// What changed in an example of a version check: the statements only one version makes.
function explained(item, example) {
  const lines = (item.explained || []).filter((x) => x.example === example).flatMap(explainedLines);
  return lines.length ? `<ul class="changes">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '';
}
async function save(name) {
  const root = await navigator.storage.getDirectory();
  const file = await (await (await root.getDirectoryHandle('outputs')).getFileHandle(name)).getFile();
  if (window.showSaveFilePicker && !window.__plato_forceDownload) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      await file.stream().pipeTo(await h.createWritable());   // disk to disk, nothing held in memory
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
window.__plato_save = save;
function fail(message, words) {
  busy = false;
  buttons(false);
  $('progress').hidden = true; $('result').hidden = false;
  $('summary').innerHTML = `<span class="warn">${escapeHtml(words || `Something went wrong: ${message}`)}</span>`;
  $('saves').innerHTML = ''; $('report').innerHTML = '';
  Object.assign(state, { phase: 'error', error: message, said: words || null });
}
// ---- Hermes: which column of a table of places holds what -------------------------------------------
// The worker reads the columns and guesses (src/engine/hermes/columns.js); the page shows the guess,
// one choice for each column, with three examples and the reason for the guess, and the run is given
// the matching as it stands. The matching can be saved as JSON and loaded again.
let columns = null, columnsAsked = 0, columnsFrom, columnsSaved;
// Krisis: the request for the columns of a resumed review, and the matching the review was made with, as text (undefined: not known yet).
let reviewColumnsAsked = 0, reviewMapping;
// A matching as text, in the file's order, to compare two by.
const mappingText = (m) => JSON.stringify(columns.headers.map((h) => [h, m[h]]));
const isTable = (inp) => inp?.format === 'csv' || inp?.format === 'geojson';
function requestColumns(saved, from) {
  const id = ++columnsAsked;
  if (saved === undefined) $('columns').innerHTML = `<h3 id="columns-h">${COLUMN_WORDS.heading}</h3><p>${COLUMN_WORDS.looking}</p>`;
  columnsFrom = from; columnsSaved = saved;
  worker.postMessage({ cmd: 'columns', id, files, saved });
}
function onColumns(d) {
  if (d.id !== columnsAsked) return;                    // an answer about a file no longer chosen
  const W = COLUMN_WORDS;
  if (d.error) {
    $('columns').innerHTML = `<h3 id="columns-h">${W.heading}</h3><p class="warn">${escapeHtml(W.cannotRead(d.error))}</p>`;
    state.columns = { error: d.error };
    gateOnColumns();
    return;
  }
  // With no prototype, so that a column called "__proto__" is a column like any other (columns.js).
  const own = (o) => Object.assign(Object.create(null), o);
  columns = { headers: d.headers, examples: own(d.examples), fields: d.fields, mapping: own(d.mapping), reasons: own(d.reasons), gazetteer: d.gazetteer || [] };
  // A column the saved matching gives, and the engine took as given, says so in the page's words;
  // one it could not take keeps the engine's reason.
  if (d.saved) for (const h of d.headers) if (d.reasons[h] && d.problems.every((p) => p.example !== h && !String(p.example).startsWith(`${h}: `))) columns.reasons[h] = W.saved;
  columns.messages = d.saved ? [W.loaded(columnsFrom || ''), ...d.problems.map(columnProblem)] : [];
  renderColumns();
  // Krisis: the matching a resumed review was made with, as read for the file chosen, is the one its Finish compares with.
  if (d.id === reviewColumnsAsked) { reviewMapping = mappingText(columns.mapping); state.reviewColumns = Object.assign(Object.create(null), columns.mapping); }
  gateOnColumns();
}
function choiceOptions(chosen) {
  const keys = [...Object.keys(COLUMN_CHOICES).filter((k) => columns.fields[k] || k === 'note' || k === 'skip'),
    ...Object.keys(columns.fields).filter((k) => !COLUMN_CHOICES[k])];     // a field these words do not yet name
  return keys.map((k) => `<option value="${k}"${k === chosen ? ' selected' : ''}>${escapeHtml(COLUMN_CHOICES[k] || k)}</option>`).join('');
}
function renderColumns() {
  const W = COLUMN_WORDS, c = columns, geojson = input.format === 'geojson';
  const rows = c.headers.map((h, i) => {
    const ex = c.examples[h] || [];
    return `<tr><th scope="row"><code>${escapeHtml(h)}</code></th>`
      + `<td>${ex.length ? `<ul class="examples">${ex.map((v) => `<li>${escapeHtml(v.length > 60 ? v.slice(0, 59) + '…' : v)}</li>`).join('')}</ul>` : `<em>${W.noExamples}</em>`}</td>`
      + `<td><label for="column-${i}" class="visually-hidden">${escapeHtml(W.selectLabel(h))}</label><select id="column-${i}" data-column="${i}" aria-describedby="column-why-${i}">${choiceOptions(c.mapping[h])}</select></td>`
      + `<td id="column-why-${i}" class="why-guess">${escapeHtml(c.reasons[h] || '')}</td></tr>`;
  }).join('');
  $('columns').innerHTML = `<h3 id="columns-h">${W.heading}</h3><p>${escapeHtml(W.intro(geojson))} ${escapeHtml(W.base)}</p>`
    + `<p id="columns-locked" class="columns-locked" hidden>${escapeHtml(REVIEW_WORDS.columnsLocked)}</p>`
    + `<div class="columns-scroll"><table class="columns-table"><caption>${escapeHtml(W.caption(files[0]?.name || '', geojson))}</caption>`
    + `<thead><tr><th scope="col">${W.column}</th><th scope="col">${W.examples}</th><th scope="col">${W.readAs}</th><th scope="col">${W.why}</th></tr></thead><tbody>${rows}</tbody></table></div>`
    + `<div id="columns-messages" aria-live="polite">${c.messages.map((m) => `<p>${escapeHtml(m)}</p>`).join('')}</div>`
    + `<div id="columns-warnings" aria-live="polite"></div>`
    + `<div class="actions columns-files"><button type="button" id="columns-save">${W.save}</button><button type="button" id="columns-load">${W.load}</button>`
    + `<input type="file" id="columns-file" accept=".json,application/json" hidden aria-label="${W.loadLabel}"><small>${escapeHtml(W.saveNote)}</small></div>`;
  $('columns-save').onclick = saveMatching;
  $('columns-load').onclick = () => $('columns-file').click();
  $('columns-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadMatching(f); };
  renderColumnWarnings();
  lockColumns();
}
// Krisis: while a review is shown, the columns are read as the review was made, and cannot be chosen
// one by one; a saved matching can still be loaded, and Finish then sends it, and says it differs.
function lockColumns() {
  const reviewing = !!work && !$('review').hidden;
  const selects = document.querySelectorAll('#columns select[data-column]');
  for (const sel of selects) sel.disabled = reviewing;
  // and says why, exactly when they are locked.
  const note = $('columns-locked'); if (note) note.hidden = !(reviewing && selects.length);
  state.columnsLocked = reviewing;
}
function renderColumnWarnings() {
  const warnings = columnWarnings(columns.mapping, columns.gazetteer);
  $('columns-warnings').innerHTML = warnings.map((w) => `<p class="warn">${escapeHtml(w)}</p>`).join('');
  state.columns = { headers: [...columns.headers], mapping: Object.assign(Object.create(null), columns.mapping), reasons: Object.assign(Object.create(null), columns.reasons), examples: columns.examples, warnings, messages: [...columns.messages] };
}
// A choice for one column. A field one column only can be (the name, the id…) is taken from the
// column that had it, which is then kept as a note, and says why.
function chooseColumn(i, field) {
  const W = COLUMN_WORDS, h = columns.headers[i];
  if (columns.fields[field]?.single) {
    columns.headers.forEach((other, j) => {
      if (j === i || columns.mapping[other] !== field) return;
      columns.mapping[other] = 'note'; columns.reasons[other] = W.movedTo(COLUMN_CHOICES[field] || field, h);
      $(`column-${j}`).value = 'note'; $(`column-why-${j}`).textContent = columns.reasons[other];
    });
  }
  columns.mapping[h] = field; columns.reasons[h] = W.youChose;
  $(`column-why-${i}`).textContent = W.youChose;
  renderColumnWarnings();
}
function saveMatching() {
  const a = document.createElement('a');
  // In the file's order, which an object would not keep for a column whose heading is a number.
  const text = `{\n${columns.headers.map((h) => `  ${JSON.stringify(h)}: ${JSON.stringify(columns.mapping[h])}`).join(',\n')}\n}\n`;
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = (files[0]?.name || 'table').replace(/\.gz$/i, '').replace(/\.[^.]+$/, '') + '-columns.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function loadMatching(file) {
  let saved;
  try { saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())); } catch { saved = undefined; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    $('columns-messages').innerHTML = `<p class="warn">${escapeHtml(COLUMN_WORDS.notJson(file.name))}</p>`;
    state.columns = { ...state.columns, messages: [COLUMN_WORDS.notJson(file.name)] };
    return;
  }
  requestColumns(saved, file.name);
}
$('columns').addEventListener('change', (e) => { if (e.target.matches('select[data-column]')) chooseColumn(Number(e.target.dataset.column), e.target.value); });

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

// Cleared once read, so that choosing the same file again (after editing it) is a change too.
$('picker').onchange = (e) => { choose(e.target.files); e.target.value = ''; };
// Going to Chora's page with files chosen here hands them over (src/chora/handoff.js), and it offers
// to open them. Only then, not on every choice: the browser may keep a copy of a stored file, and
// the files here may be of any size.
document.addEventListener('click', async (e) => {
  if (e.defaultPrevented) return;   // a first tap that showed a tooltip, not a choice of the way
  const a = e.target.closest('a[href="./chora.html"]');
  if (!a || !files.length || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
  e.preventDefault();
  await stashForChora(files);
  location.href = a.href;
});
// Files handed over that Chora's page never took (the way taken, its page not started) are not left
// in the browser: let go here when this page starts, is shown again (back from Chora) or is left,
// once they are older than the hand-over allows. A fresh hand-over, on the way to Chora now, is kept.
dropStaleHandoff();
for (const ev of ['pageshow', 'pagehide']) window.addEventListener(ev, () => dropStaleHandoff());
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); choose(e.dataTransfer.files); };
$('check').onclick = () => start('check');
$('convert').onclick = () => start('convert');
// Comparing asks for one more file, the earlier version, and starts once it is chosen.
$('compare').onclick = () => $('earlier').click();
$('earlier').onchange = (e) => { const earlier = [...e.target.files]; e.target.value = ''; if (earlier.length) start('compare', earlier); };
$('publish').onclick = () => start('publish');
$('cancel').onclick = () => { worker.terminate(); busy = false; $('progress').hidden = true; buttons(false); Object.assign(state, { phase: 'cancelled' }); startWorker();
  // Krisis: an answer about the columns still being worked out went with the worker: it is asked for again, as it was
  // (for a resumed review, by the matching the review was made with), or Match and Finish would wait for it for ever.
  if (columnsPending()) { const forReview = reviewColumnsAsked === columnsAsked; requestColumns(columnsSaved, columnsFrom); if (forReview) reviewColumnsAsked = columnsAsked; } };
// Matching asks for the other dataset, and starts once it is chosen; resuming asks for a saved review.
// Options that matching would refuse are said plainly first, before the other dataset is asked for.
$('match').onclick = () => { const problem = matchProblem(); if (problem) return refuse(problem); $('others').click(); };
$('others').onchange = (e) => { const others = [...e.target.files]; e.target.value = ''; if (others.length) start('match', others); };
$('resume').onclick = () => $('workfile').click();
$('workfile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) resume(f); };
$('target').onchange = () => { document.querySelector('[data-for="ntriples-output"]').hidden = $('target').value !== 'ntriples'; };

// ---- The tools, chosen first or not at all -------------------------------------------------------
// The data can be chosen first, and step 2 then offers everything that can be done with it, Chora's
// map included; or a tool's card can be chosen, before the data or after, and step 2 is narrowed to
// what that tool does (each part of step 2 names, in data-tools, the tools it is for). The choice is
// kept in the address as #tool=<key>, replaced rather than added to the history, so that a reload or
// a link keeps it. The keys are not the ids of step 2's buttons (#check would scroll to the button,
// not choose the tool). Hermes, the readers, narrows nothing: its card goes to the drop zone. Chora's
// card is a link to its own page, which takes the chosen file with it (the click handler above).
const GUIDE = 'https://pelagios.org/place-attestation-ontology/guide/tools.html';
const TOOLS = {
  check: { name: 'Elenchos', what: 'the check', heading: 'Check it', guide: ['checking', 'What it checks'] },
  convert: { name: 'Metaphrasis', what: 'conversion', heading: 'Convert it', guide: ['converting', 'What each format keeps'] },
  figures: { name: 'Arithmos', what: 'statistical figures, converted to N-Triples with the RDF Data Cube option (ticked, under Options)', heading: 'Convert its figures to RDF Data Cube', guide: ['converting', 'Converting, in the guide'] },
  versions: { name: 'Mneme', what: 'the version check: choose the new version here, and you will be asked for the earlier one', heading: 'Compare it with the earlier version', guide: ['comparing-two-versions', 'What it reports'] },
  publish: { name: 'Agora', what: 'publishing', heading: 'Prepare it for publishing', guide: ['publishing-your-dataset', 'What publishing takes'] },
  match: { name: 'Krisis', what: 'match review', heading: 'Match it with another dataset', guide: ['match-review', 'How to review matches'] },
};
const EVERY_ACTION = $('action-what').textContent;
let tool = null;
const toolFromHash = () => { const m = /^#tool=([a-z]+)$/.exec(location.hash); return m && TOOLS[m[1]] ? m[1] : null; };
const reduceMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function chooseTool(key) {
  const was = tool;
  tool = TOOLS[key] ? key : null;
  if (was === 'figures' && tool !== 'figures') leaveFigures();
  // Arithmos with a file that is already N-Triples: there is nothing to convert it to that carries the
  // Data Cube, so the step offers the check instead, and says why.
  const asCheck = tool === 'figures' && input?.format === 'ntriples';
  const shownFor = asCheck ? 'check' : tool;
  for (const el of document.querySelectorAll('#action [data-tools]')) el.hidden = !!tool && !el.dataset.tools.split(' ').includes(shownFor);
  // Convert stands alone when Check is not shown, and is then the step's main button.
  $('convert').classList.toggle('primary', shownFor === 'convert' || shownFor === 'figures');
  $('action-what').textContent = asCheck ? 'Check it: it is already N-Triples' : tool ? TOOLS[tool].heading : EVERY_ACTION;
  $('action').classList.toggle('narrowed', !!tool);
  for (const a of document.querySelectorAll('#toolbox .tool-link[data-tool]')) {
    if (a.dataset.tool === tool) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
  }
  const note = $('for-tool');
  note.hidden = !tool;
  note.textContent = '';
  if (tool) {
    const [anchor, words] = TOOLS[tool].guide;
    note.innerHTML = `For <strong>${TOOLS[tool].name}</strong>, ${escapeHtml(TOOLS[tool].what)}. <a href="${GUIDE}#${anchor}">${words}</a>. `;
    const all = document.createElement('button');
    all.type = 'button'; all.className = 'link'; all.id = 'every-action'; all.textContent = 'Show every action';
    all.onclick = () => { chooseTool(null); setHash(null); focusStep1(); };
    note.appendChild(all);
    if (tool === 'figures' && !asCheck) presetFigures();
  }
  Object.assign(state, { tool });
}
// Arithmos: Convert to N-Triples, with the Data Cube option (in Options) ticked. Applied again when a
// file is detected, since the list of formats to convert to is made then. Leaving Arithmos for another
// tool, or for every action, undoes both: the format chosen before it (or the first offered) comes
// back, and the Data Cube option is cleared, so that a later conversion adds no Data Cube unasked.
let beforeFigures = null;
function presetFigures() {
  const sel = $('target');
  if (beforeFigures === null) beforeFigures = sel.value;
  if ([...sel.options].some((o) => o.value === 'ntriples')) { sel.value = 'ntriples'; sel.onchange(); }
  $('cube').checked = true;
}
function leaveFigures() {
  const sel = $('target');
  $('cube').checked = false;
  if (sel.options.length) {
    sel.value = [...sel.options].some((o) => o.value === beforeFigures) ? beforeFigures : sel.options[0].value;
    sel.onchange();
  }
  beforeFigures = null;
}
function setHash(key) {
  try { history.replaceState(history.state, '', location.pathname + location.search + (key ? `#tool=${key}` : '')); } catch {}
}
function focusStep1() {
  const h = $('files-h');
  h.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  h.focus({ preventScroll: true });
}
$('toolbox').addEventListener('click', (e) => {
  // A first tap on a card's name shows its tooltip, and goes no further (src/lib/tooltip.js).
  if (e.defaultPrevented) return;
  const a = e.target.closest('.tool-link[data-tool]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
  e.preventDefault();
  if (a.dataset.tool === 'read') {          // Hermes: to the drop zone, with every action still offered
    chooseTool(null); setHash(null);
    $('drop').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
    $('picker').focus({ preventScroll: true });
    return;
  }
  chooseTool(a.dataset.tool); setHash(a.dataset.tool); focusStep1();
});
window.addEventListener('hashchange', () => chooseTool(toolFromHash()));
chooseTool(toolFromHash());

// Krisis: match review. One subject place at a time, with its candidates; each decision is written
// into the work object at once (decide() in engine/krisis/work.js), which "Save the review" saves
// and Finish hands to the engine to make the attestations.
let work = null, workName = 'review.krisis.json', order = [], cursor = 0, current = 0, basisFor = null, allDone = false;
let unsaved = 0;   // decisions made since the review began or was last saved (a reload would lose them)
const REVIEWER_KEY = 'plato-tools.reviewer';
/**
 * The reviewer remembered, checked again on load by the engine's own rule (checkReviewer), as before a
 * save: a name, and an ORCID only if it is one. What is kept here can be written by any page of the
 * site's origin (DEVELOPERS.md, "The shared origin"), so an ORCID that is not one is dropped, not shown.
 */
function remembered() {
  let r;
  try { r = JSON.parse(localStorage.getItem(REVIEWER_KEY)); } catch { return {}; }
  if (!r || typeof r !== 'object' || typeof r.name !== 'string') return {};
  const out = { name: r.name };
  if (typeof r.orcid === 'string') { try { checkReviewer({ name: r.name, orcid: r.orcid }); out.orcid = r.orcid; } catch { /* not an ORCID: dropped */ } }
  return out;
}
function remember() {
  const r = reviewer() || {};
  if (r.orcid && reviewerProblem()) delete r.orcid;   // an ORCID that is not one is not remembered
  try { localStorage.setItem(REVIEWER_KEY, JSON.stringify(r)); } catch {}
}
/** The reviewer, as a PLATO contributor ({ name, orcid? }), or null until a name is given. */
function reviewer() {
  const name = $('reviewer').value.trim();
  // An ORCID is recorded in full, as a web address; one given as its sixteen digits is written so.
  let orcid = $('orcid').value.trim();
  if (/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid)) orcid = 'https://orcid.org/' + orcid;
  return name ? { name, ...(orcid ? { orcid } : {}) } : null;
}
/** What is wrong with the reviewer given, in words, or null: the engine's own rule (checkReviewer), so the page never saves what a resumed review would refuse. */
function reviewerProblem() {
  const r = reviewer();
  if (!r) return null;
  try { checkReviewer(r); return null; } catch { return W.badOrcid; }
}
function matchOptions() {
  const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : undefined; };
  return { threshold: num('threshold'), maxDistanceKm: num('max-distance'), othersTitle: $('others-title').value.trim() || undefined };
}
/** What is wrong with the matching options, in the engine's own words (checkMatchOptions), or null. */
function matchProblem() { try { checkMatchOptions(matchOptions()); return null; } catch (e) { return e.message; } }
/** Say plainly why something cannot be done, where results are shown. */
function refuse(message) {
  $('result').hidden = false; $('saves').innerHTML = ''; $('report').innerHTML = '';
  $('summary').innerHTML = `<span class="warn">${escapeHtml(message)}</span>`;
  Object.assign(state, { phase: 'error', error: message });
}
async function resume(file) {
  let w;
  try { w = readWork(await file.text()); } catch (e) { refuse(e.message); return; }
  $('result').hidden = true;
  // The other dataset's title typed for an earlier match is not this review's: put away, it cannot be taken for this one's at finishing.
  $('others-title').value = '';
  beginReview(w, file.name);
  // A review made from other files than those chosen now is still opened, with a warning; with none chosen, it says so.
  if (!files.length) { showWarning(W.noDatasetYet); return; }
  if (!readable(input)) { showWarning(W.notRecognisedYet); return; }
  // A table of places is shown as the review read it, by the matching kept in the work file (or by the guess, if it keeps none).
  if (isTable(input)) { columns = null; state.columns = null; gateOnColumns(); requestColumns(w.match_parameters.columns, workName); reviewColumnsAsked = columnsAsked; }
  try { const differ = await filesDiffer(w.subjects, files); showWarning(differ.length ? W.differs(differ) : ''); } catch { showWarning(''); }
}
function beginReview(w, name, { focus = true } = {}) {
  work = w; workName = name || workName; basisFor = null; findFor = null; allDone = false; unsaved = 0;
  order = reviewPlaces(work);
  cursor = Math.min(Math.max(0, work.cursor || 0), Math.max(0, order.length - 1));
  // A place with no candidates has nothing to review: start at the first that has some.
  if (order.length && !candidatesOf(work, order[cursor]).length) cursor = Math.max(0, order.findIndex((iri) => candidatesOf(work, iri).length));
  if (!work.reviewer?.name && !reviewer()) { const r = remembered(); $('reviewer').value = r.name || ''; $('orcid').value = r.orcid || ''; }
  if (work.reviewer?.name && !reviewer()) { $('reviewer').value = work.reviewer.name; $('orcid').value = work.reviewer.orcid || ''; }
  $('review').hidden = false; showWarning('');
  // The matching of columns a review is finished by is the one shown when it begins: after Match, the one it was matched by.
  reviewColumnsAsked = 0; reviewMapping = isTable(input) && columns ? mappingText(columns.mapping) : undefined;
  lockColumns();
  askName(!reviewer() && order.length > 0);
  goTo(cursor, focus);
}
function showWarning(text) { $('review-warning').textContent = text; $('review-warning').hidden = !text; }
function askName(show, why) {
  const f = $('review-who'); f.hidden = !show;
  if (show) { $('review-name').value = $('reviewer').value; if (why) showWarning(why); $('review-name').focus(); }
}
const undecided = (iri) => candidatesOf(work, iri).findIndex((c) => !c.decision);
// A place still to decide has candidates, none of them decided; one with no candidates has nothing to decide.
const toDecide = (iri) => !isReviewed(work, iri) && candidatesOf(work, iri).length > 0;
function goTo(i, focus = true) {
  cursor = i; basisFor = null; findFor = null;
  const u = order.length ? undecided(order[cursor]) : -1;
  current = u < 0 ? 0 : u;
  render(focus);
}
/** The next (step 1) or previous (step -1) place the filter shows, or null. */
function step(dir) {
  const all = $('review-filter').value === 'all';
  for (let i = cursor + dir; i >= 0 && i < order.length; i += dir) if (all || toDecide(order[i])) return i;
  return null;
}
function move(dir) {
  const i = step(dir);
  allDone = i === null && dir > 0 && $('review-filter').value !== 'all' && !order.some(toDecide);
  if (i !== null) goTo(i); else render(true);
}
function decideOn(id, kind, basis) {
  const cands = candidatesOf(work, order[cursor]);
  decide(work, id, kind, { identityType: kind === 'distinct' ? 'exactMatch' : $('identity-type').value, basis });
  unsaved++;
  basisFor = null;
  const u = undecided(order[cursor]);
  if (kind && u < 0) return move(1);   // every candidate of this place decided: on to the next
  current = kind ? u : Math.max(0, cands.findIndex((c) => c.id === id));
  render(true);
}
function render(focus) {
  const box = $('review-place');
  const p = reviewProgress(work);
  $('review-progress').textContent = W.progress(p, order.length ? cursor + 1 : 0);
  $('review-prev').disabled = step(-1) === null; $('review-next').disabled = $('review-skip').disabled = step(1) === null;
  Object.assign(state, { phase: 'reviewing', work, review: { cursor, subject: order[cursor] || null, current, filter: $('review-filter').value, ...p } });
  $('finish-cites').textContent = LW.cites(citedSources());   // Krisis: gazetteer lookup, one attestation per source
  if (!order.length) { box.innerHTML = `<p>${escapeHtml(W.none)}</p>`; return; }
  const iri = order[cursor], place = work.places[iri] || {}, cands = candidatesOf(work, iri);
  const typed = keepTyped(iri);
  box.innerHTML = (allDone ? `<p class="good">${escapeHtml(W.allDone)}</p>` : '')
    + `<div class="subject"><h3 id="review-subject">${escapeHtml(place.label || iri)}</h3>`
    + (W.names(place.label, place.names) ? `<p>${escapeHtml(W.names(place.label, place.names))}</p>` : '')
    + `<p>${escapeHtml(W.point(place.point))}</p><p class="iri">${escapeHtml(iri)}</p>` + lookupPlaceHtml(iri, place) + '</div>'
    + (hasLookups() ? groupedHtml(cands)
      : `<p>${escapeHtml(W.candidates(cands.length))}</p><ol class="candidates">` + cands.map((c, i) => candidateHtml(c, i)).join('') + '</ol>');
  restoreTyped(typed);
  // A form newly opened takes the focus; one redrawn (by a lookup's batch) has it back only if it had it.
  if (findFor === iri) { if (!typed.find || typed.find.focused) $('find-query')?.focus(); return; }
  if (basisFor) { if (!typed.basis || typed.basis.focused) $('basis-input')?.focus(); return; }
  if (!$('review-who').hidden) { $('review-name').focus(); return; }   // while the name is asked, it keeps the focus
  if (focus) box.focus({ preventScroll: false });
}
/**
 * What is typed in the find form or the basis field that render() is about to draw again (each batch
 * of a lookup redraws the place): its text, where the cursor is, and whether it has the focus, kept
 * only when the same form is drawn again (the same place's find, the same candidate's basis).
 */
function keepTyped(iri) {
  const one = (el, same) => (el && same ? { value: el.value, start: el.selectionStart, end: el.selectionEnd, focused: document.activeElement === el } : null);
  const f = $('find-query'), b = $('basis-input');
  return { find: one(f, findFor === iri && f?.form?.dataset.for === iri), basis: one(b, basisFor && b?.form?.dataset.id === basisFor) };
}
function restoreTyped(typed) {
  for (const [id, t] of [['find-query', typed.find], ['basis-input', typed.basis]]) {
    const el = $(id);
    if (!el || !t) continue;
    el.value = t.value;
    if (t.focused) { el.focus({ preventScroll: true }); try { el.setSelectionRange(t.start, t.end); } catch {} }
  }
}
function candidateHtml(c, i) {
  const o = c.other || (Object.hasOwn(work.places, c.candidate_candidate) ? work.places[c.candidate_candidate] : {}), d = c.decision, id = escapeHtml(c.id);
  const btn = (act, text, key) => `<button type="button" data-act="${act}" data-id="${id}" aria-pressed="${d?.kind === act}">${text}${i === current && key ? ` <kbd>${key}</kbd>` : ''}</button>`;
  return `<li class="candidate${i === current ? ' current' : ''}${d ? ' decided' : ''}" data-id="${id}" tabindex="-1"${i === current ? ' aria-current="true"' : ''}>`
    + `<h4><span class="n">${i + 1}</span>${escapeHtml(o.label || c.candidate_candidate)}</h4>`
    + (W.names(o.label, o.names) ? `<p>${escapeHtml(W.names(o.label, o.names))}</p>` : '')
    + `<p class="facts">${escapeHtml(W.facts(c))}; ${escapeHtml(W.point(o.point))}</p>`
    + (c.lookup ? gazetteerHtml(c) : '')
    + `<p class="iri">${escapeHtml(c.candidate_candidate)}</p>`
    + `<p class="decision">${escapeHtml(W.decision(d))}</p>`
    + `<div class="acts">${btn('match', 'Same place', 'a')}${btn('not-this', 'Not this one', 'n')}${btn('distinct', 'Different places', 'd')}`
    + (d ? `<button type="button" data-act="undo" data-id="${id}">Undo</button>` : '') + '</div>'
    + (basisFor === c.id ? `<form class="basis" data-id="${id}"><label for="basis-input">${escapeHtml(W.basisLabel)}</label>`
      + `<input id="basis-input" type="text" value="${escapeHtml(d?.basis || '')}" autocomplete="off">`
      + `<button type="submit" class="primary">Record as different places</button><button type="button" data-act="cancel-basis">Cancel</button>`
      + `<p class="warn" id="basis-warn" hidden>${escapeHtml(W.basisNeeded)}</p></form>` : '')
    + '</li>';
}
function openBasis(id) { basisFor = id; current = Math.max(0, candidatesOf(work, order[cursor]).findIndex((c) => c.id === id)); render(); }
$('review-place').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b || busy) return;
  const { act, id } = b.dataset;
  if (act === 'match' || act === 'not-this') decideOn(id, act);
  else if (act === 'distinct') openBasis(id);
  else if (act === 'undo') decideOn(id, null);
  else if (act === 'cancel-basis') { basisFor = null; render(true); }
});
$('review-place').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!e.target.matches('form.basis')) return;   // Krisis: gazetteer lookup has a form of its own here
  const basis = $('basis-input').value.trim();
  if (!basis) { $('basis-warn').hidden = false; $('basis-input').focus(); return; }
  decideOn(e.target.dataset.id, 'distinct', basis);
});
$('review-place').addEventListener('keydown', (e) => { if (e.key === 'Escape' && basisFor) { basisFor = null; render(true); } else if (e.key === 'Escape' && findFor) { findFor = null; render(true); } });
// The keys act only while the review is shown, and never while typing (or choosing from a list).
document.addEventListener('keydown', (e) => {
  if ($('review').hidden || busy || !work || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.target.closest?.('#lookup, form.find-form')) return;   // Krisis: nor in the lookup panel, token field and all
  const cands = order.length ? candidatesOf(work, order[cursor]) : [], c = cands[current];
  const k = e.key;
  if (k === 'j' || k === 's') move(1);
  else if (k === 'k') move(-1);
  else if (k === 'a' && c) decideOn(c.id, 'match');
  else if (/^[1-9]$/.test(k) && cands[+k - 1]) { current = +k - 1; decideOn(cands[current].id, 'match'); }
  else if (k === 'n' && c) decideOn(c.id, 'not-this');
  else if (k === 'd' && c) openBasis(c.id);
  else return;
  e.preventDefault();
});
$('review-prev').onclick = () => move(-1);
$('review-next').onclick = $('review-skip').onclick = () => move(1);
$('review-filter').onchange = () => { allDone = false; render(); };
$('review-who').onsubmit = (e) => {
  e.preventDefault();
  const name = $('review-name').value.trim(); if (!name) return;
  $('reviewer').value = name; remember(); askName(false); showWarning(''); render(true);
};
for (const id of ['reviewer', 'orcid']) $(id).addEventListener('change', remember);
{ const r = remembered(); $('reviewer').value = r.name || ''; $('orcid').value = r.orcid || '';
  // Written back as checked (remembered), so that an ORCID that is not one is not kept, nor listed in the panel; nothing usable, nothing kept.
  try { if (localStorage.getItem(REVIEWER_KEY) !== null) { if (r.name) localStorage.setItem(REVIEWER_KEY, JSON.stringify(r)); else localStorage.removeItem(REVIEWER_KEY); } } catch {} }
$('save-review').onclick = () => {
  if (!work) return;
  const problem = reviewerProblem(); if (problem) return showWarning(problem);
  work.cursor = cursor;
  const who = reviewer(); if (who) work.reviewer = who;
  saveBlob(new Blob([serialiseWork(work)], { type: 'application/json' }), workName);
  Object.assign(state, { reviewSaved: workName });
  unsaved = 0;
};
$('finish').onclick = () => {
  if (!work) return;
  if (!readable(input)) return showWarning(files.length ? W.notRecognisedAtFinish : W.noDataset);
  if (!reviewer()) return askName(true, W.nameNeeded);
  const problem = reviewerProblem(); if (problem) return showWarning(problem);
  work.cursor = cursor; work.reviewer = reviewer();
  start('apply', document.querySelector('input[name="review-output"]:checked').value);
};
/** Save something made in the page, not by the engine: as save() does, to disk or as a download. */
async function saveBlob(blob, name) {
  if (window.showSaveFilePicker && !window.__plato_forceDownload) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
// The Permissions panel, from the header's button; and the proof that the page's policy is enforced
// (state.canary), without which no other site is asked from this page.
permissions.mount({ state });
// A reload for a permission cannot keep the files chosen here (the browser gives a page no way back to
// a file without the user choosing it again): it says so in the panel first, and may be cancelled.
// A tool that keeps more (Krisis's review) says what it would lose the same way, with onBeforeReload.
permissions.onBeforeReload(() => {}, { loses: () => (files.length ? RELOAD_LOSES.files(files.map((f) => f.name)) : null) });
permissions.onBeforeReload(() => {}, { loses: () => (busy ? RELOAD_LOSES.running : null) });
permissions.onBeforeReload(() => {}, { loses: () => (work && unsaved ? RELOAD_LOSES.review(unsaved) : null) });
// Krisis: gazetteer lookup (online, optional). The places of the dataset are looked up in WHG, or
// another reconciliation service, and what is found is added to the review on screen (or begins one).
// It runs HERE, on the page's thread, never in the worker, so that the token (src/lib/whg-token.js,
// its one keeper; the page holds no copy) goes nowhere but the Authorization header of a request to
// WHG: not into window.__plato, a work file, an address, the console or the words of an error. The
// page hands it to the shared WHG lookup when it changes (setToken; Forget calls clearToken), and
// never passes it anywhere else. The answers are merged into the work object after each batch, so
// "Save the review" works at any moment.
let gathered = null, placesWaiting = null, looking = null, findFor = null, afterStop = null;
// What another service's manifest said (manifestSettings), by its address, once a lookup has read it: the preview then shows its type.
const manifests = new Map();
/** WHG's lookup: the one shared in the page with Chora (one request in flight, whoever asks). */
const whgLookup = () => createLookup({ endpoint: WHG_ENDPOINT });
/** The shared lookup takes the keeper's token, or none: at start (a token kept in this tab from before) and on every change. */
const passToken = () => { const t = whgToken.get(); if (t) whgLookup().setToken(t); else whgLookup().clearToken(); };
const showTokenState = () => { $('whg-token-state').textContent = whgToken.get() ? LW.tokenGiven : LW.tokenNone; };
/** The review on screen, which a lookup adds to; null when none is (a lookup then begins one). */
const reviewWork = () => (work && !$('review').hidden ? work : null);
const hasLookups = () => !!work && ((work.lookups || []).length > 0 || work.others === null);
const shortName = (service) => (isWhg(service.endpoint) ? LW.whg : service.title);
const lookupOf = (id) => (work.lookups || []).find((l) => l.id === id);
/** Text cleaned of the token, for what the gazetteer module does not word itself (a fault's stack). The module cleans its own errors and a query's. */
const scrub = (text) => { const t = whgToken.get(); return t ? String(text).split(t).join('[token]') : String(text); };
function lookupSay(text, warn = false) { const p = $('lookup-progress'); p.textContent = text; p.classList.toggle('warn', warn); }
function lookupState(more) { state.lookup = { ...(state.lookup || {}), ...more }; }

// The places of the dataset, with the links it states, read by the worker (gather()); once per choice of files.
function gatherPlaces() {
  const base = $('base').value.trim() || undefined;
  if (gathered && gathered.files === files && gathered.base === base) return Promise.resolve(gathered);
  if (placesWaiting) return placesWaiting.promise;
  if (busy || !input?.format) return Promise.resolve(null);
  busy = true; buttons(true);
  lookupSay(LW.reading);
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  placesWaiting = { promise, resolve, files, base };
  worker.postMessage({ cmd: 'places', subjects: files, options: { base } });
  return promise;
}
function onPlaces(data) {
  const w = placesWaiting; placesWaiting = null;
  busy = false; buttons(!!looking);   // a lookup running keeps them disabled
  gathered = { files: w.files, base: w.base, subjects: data.subjects || null, places: data.places || null };
  lookupSay('');
  w.resolve(gathered);
}

/** The service chosen: WHG's, or another's by its address (and a template for its candidates' addresses). */
function lookupService() {
  if (document.querySelector('input[name="lookup-service"]:checked')?.value !== 'other') return { service: serviceOf(WHG_ENDPOINT), whg: true };
  const endpoint = $('lookup-endpoint').value.trim();
  let service;
  try { if (!/^https:\/\//i.test(endpoint)) throw new Error(); service = serviceOf(endpoint); } catch { return { problem: LW.badEndpoint }; }
  if (isWhg(endpoint)) return { service: serviceOf(WHG_ENDPOINT), whg: true };
  const t = $('lookup-iri').value.trim();
  if (t) { try { iriFromTemplate(t); } catch { return { problem: LW.badTemplate }; } }
  return { service, whg: false, template: t || null };
}
function lookupOptions(extra = {}) {
  const km = parseFloat($('lookup-near-km').value);
  return { places: $('lookup-places').value, allNames: $('lookup-all-names').checked, countries: $('lookup-countries').checked,
    nearKm: $('lookup-near').checked && km > 0 ? km : null, maxDistanceKm: matchOptions().maxDistanceKm, ...extra };
}
/**
 * The places a lookup would take and what it would send, planned by runLookup()'s own planLookup, in
 * requests of the size of the lookup that would send them: WHG's shared one (whose size is the first
 * caller's, Chora's perhaps), or for another service the module's default, as lookUp() makes it.
 */
function planFor(svc, opts, places) {
  return planLookup({ lookup: svc.whg ? whgLookup() : null, work: reviewWork(), places,
    options: { ...opts, service: svc.service, type: svc.whg ? undefined : manifests.get(svc.service.endpoint)?.type || undefined } });
}

// The choice of places: after a match, those it found nothing for; once a lookup has run, those not answered.
function fillChoices() {
  const sel = $('lookup-places'), want = defaultChoice(reviewWork());
  sel.innerHTML = PLACE_CHOICES.map((k) => `<option value="${k}"${k === want ? ' selected' : ''}>${escapeHtml(LOOKUP_WORDS.choices[k])}</option>`).join('');
}
/** The preview: places, queries, requests, the share of WHG's allowance, and the first queries exactly as sent. */
async function refreshPreview() {
  const box = $('lookup-preview'), send = $('lookup-send');
  if (!$('lookup').open) return;
  const svc = lookupService();
  send.disabled = true;
  if (svc.problem) { box.innerHTML = `<p class="warn">${escapeHtml(svc.problem)}</p>`; return; }
  if (!input?.format && !reviewWork()) { box.innerHTML = `<p>${escapeHtml(LW.noDataset)}</p>`; return; }
  const g = await gatherPlaces();
  const places = g?.places ?? null;
  if (!places && !reviewWork()) { box.innerHTML = `<p class="warn">${escapeHtml(busy ? LW.busy : LW.placesNotRead)}</p>`; return; }
  const p = planFor(svc, lookupOptions(), places).preview;
  const lines = LOOKUP_WORDS.preview(p);
  if (svc.whg) lines.splice(1, 0, LW.share(p.requests, WHG_REQUESTS_A_DAY));
  if (!places) lines.push(LOOKUP_WORDS.linksUnknown);
  box.innerHTML = `<p>${lines.map(escapeHtml).join(' ')}</p>`
    + (p.first.length ? `<ol class="lookup-queries">${p.first.map((q) => `<li><code>${escapeHtml(JSON.stringify(q))}</code></li>`).join('')}</ol>` : `<p>${escapeHtml(LOOKUP_WORDS.noPlaces)}</p>`);
  send.textContent = LW.send(p.queries, shortName(svc.service));
  send.disabled = !p.queries || !!looking;
  lookupState({ preview: { places: p.places, queries: p.queries, requests: p.requests, first: p.first } });
}

/**
 * Look places up. With nothing given, as the panel says; `only` (IRIs) for one place from the review
 * screen, with `query` the name to send instead of its label, or `allNames` to send its other names.
 */
async function lookUp({ only = null, query = null, allNames, which } = {}) {
  if (looking) return;
  if ($('whg-token').value.trim()) commitToken();
  const svc = lookupService();
  if (svc.problem) { $('lookup').open = true; return lookupSay(svc.problem, true); }
  if (svc.whg && !whgToken.get()) { $('lookup').open = true; lookupSay(LW.needToken, true); $('whg-token').focus(); return; }
  const g = await gatherPlaces();
  const places = g?.places ?? null;
  const existing = reviewWork();
  if (!existing && !g?.subjects) return lookupSay(input?.format ? LW.placesNotRead : LW.noDataset, true);
  // A name typed for one place is sent instead of its label, and what it finds is added beside the place's candidates (runLookup's query).
  const opts = lookupOptions({ ...(which ? { places: which } : {}), ...(only ? { places: 'all', only } : {}), ...(allNames !== undefined ? { allNames } : {}), ...(only && query ? { query } : {}) });
  let lookup;
  // Another service's candidates' addresses: by the template given, else by its manifest's view.url (read below).
  const template = { template: svc.template ?? null };
  try {
    // WHG's is the shared lookup, which already has the token (passToken); another service is sent none.
    lookup = svc.whg ? whgLookup() : createLookup({ endpoint: svc.service.endpoint, token: null, shared: false, iri: iriVia(template) });
  } catch (e) { return lookupSay(scrub(e.message), true); }
  const w = existing || newWork(g.subjects, { reviewer: reviewer() });
  const name = existing ? workName : `${(files[0]?.name || 'review').replace(/\.gz$/i, '').replace(/\.[^.]+$/, '')}.krisis.json`;
  const before = new Set(w.candidates.map((c) => c.id));
  const service = shortName(svc.service);
  looking = new AbortController();
  afterStop = null;
  $('lookup-send').disabled = true; $('lookup-stop').hidden = false; $('lookup-resume').hidden = true;
  buttons(true);   // as while the worker runs: Match, Check, Resume and the rest would take the review away under the lookup
  lookupSay(LW.sending(service));
  lookupState({ running: true, done: 0, total: null, stopped: null, summary: null, single: !!only });
  const show = () => { if (work !== w || $('review').hidden) beginReview(w, name, { focus: false }); else { order = reviewPlaces(work); render(false); } };
  let result = null, fault = false, settings = null;
  if (!svc.whg) {
    // Its type, and its address template unless one was given, from its manifest (asked for without a token).
    try { settings = await manifestSettings(lookup, { signal: looking.signal }); } catch { settings = null; }
    if (settings?.read) manifests.set(svc.service.endpoint, settings);
    if (settings?.template && !template.template) template.template = settings.template;
  }
  try {
    result = await runLookup({ lookup, work: w, places, options: { ...opts, service: svc.service, ...(settings?.type ? { type: settings.type } : {}) }, signal: looking.signal,
      onBatch: ({ done, total }) => { lookupSay(LW.progress({ done, total }, service)); lookupState({ done, total }); show(); } });
  } catch (e) {
    fault = true;
    console.error('Krisis lookup:', scrub(e?.stack || e?.message || e));
  } finally {
    looking = null;
    $('lookup-stop').hidden = true;
    buttons(busy);
  }
  show();
  const stopped = fault ? { kind: 'fault', message: null } : result.stopped;
  const said = [];
  if (settings && !settings.read) said.push(LOOKUP_WORDS.noManifest);
  if (result) { const sum = LOOKUP_WORDS.summary(result.record.counts, svc.service.title); said.push(sum.problems, sum.counted); }
  // A stop's message is the gazetteer module's, which it has cleaned of the token.
  if (stopped) said.push(LOOKUP_WORDS.stopped(stopped), LW.kept);
  lookupSay(said.join(' '), !!stopped);
  lookupState({ running: false, stopped: stopped?.kind || null, summary: said.join(' '), counts: result?.record.counts || null });
  fillChoices();
  if (stopped && stopped.kind !== 'fault') offerResume(svc);
  await refreshPreview();
  if (stopped?.kind === 'auth') { $('lookup').open = true; $('whg-token').focus(); }   // a field in a closed panel cannot take the focus
  // After one place's lookup, the focus goes to the first new candidate, if any.
  if (only && order[cursor] && only.includes(order[cursor])) {
    const fresh = candidatesOf(work, order[cursor]).findIndex((c) => !before.has(c.id));
    if (fresh >= 0) { current = fresh; render(false); $('review-place').querySelector(`li.candidate[data-id="${CSS.escape(candidatesOf(work, order[cursor])[fresh].id)}"]`)?.focus(); }
  }
}
/** After a stop: Resume takes the places not yet answered, with the same settings. */
async function offerResume(svc) {
  const g = await gatherPlaces();
  const p = planFor(svc, lookupOptions({ places: 'pending' }), g?.places ?? null).preview;
  if (!p.queries) return;
  afterStop = true;
  const b = $('lookup-resume'); b.textContent = LW.resume(p.queries); b.hidden = false;
}
function commitToken() {
  const f = $('whg-token');
  if (!f.value.trim()) return;
  whgToken.set(f.value);
  f.value = '';   // the token is kept by its keeper only, not in the field
}

// Places and candidates on the review screen.
/** The latest lookup's word on a place, or null if it was never looked up. */
function lastQuery(iri) {
  let found = null;
  for (const l of work.lookups || []) if (l.queries[iri]) found = { l, q: l.queries[iri] };
  return found;
}
function lookupPlaceHtml(iri, place) {
  const svc = lookupService(), service = svc.problem ? LW.whg : shortName(svc.service), last = lastQuery(iri);
  const cands = candidatesOf(work, iri).filter((c) => c.lookup && lookupOf(c.lookup)?.service.endpoint === last?.l.service.endpoint);
  let out = '';
  if (last && !(last.q.state === 'answered' && cands.length)) {
    out += `<p class="lookup-state${last.q.state === 'answered' ? '' : ' warn'}">${escapeHtml(LW.state(shortName(last.l.service), last.q))}</p>`;
    const others = [...new Set((place.names || []).filter((n) => n && n.trim().toLowerCase() !== (place.label || '').trim().toLowerCase()))];
    if (last.q.state === 'answered' && !last.q.found && last.q.sent.length === 1 && others.length) out += `<button type="button" data-look="names">${escapeHtml(LW.tryNames(1 + others.length))}</button> `;
    if (last.q.state !== 'answered') out += `<button type="button" data-look="again">${escapeHtml(LW.again)}</button> `;
  }
  out += `<button type="button" data-look="find">${escapeHtml(LW.find(service))}</button>`;
  if (findFor === iri) {
    out += `<form class="find-form" data-for="${escapeHtml(iri)}"><label for="find-query">${escapeHtml(LW.findLabel)}</label>`
      + `<input id="find-query" type="text" value="${escapeHtml(place.label || '')}" autocomplete="off" spellcheck="false">`
      + `<button type="submit" class="primary">${escapeHtml(LW.findSend)}</button><button type="button" data-look="cancel">Cancel</button></form>`;
  }
  return `<div class="find">${out}</div>`;
}
/** Candidates grouped by where they came from, each group in the order it was ranked in (never by name). */
function groupedHtml(cands) {
  const groups = [];
  cands.forEach((c, i) => {
    const l = c.lookup ? lookupOf(c.lookup) : null, key = l ? l.service.endpoint : '';
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, title: l ? LW.from(l.service.title) : LW.fromOthers(work.others?.title || c.other?.source?.title || ''), items: [] });
    g.items.push(candidateHtml(c, i));
  });
  // A place with none, that a lookup has had its word on (not found, not answered), says only that.
  if (!cands.length && lastQuery(order[cursor])) return '';
  return `<p>${escapeHtml(LW.candidates(cands.length))}</p>`
    + groups.map((g) => `<section class="source-group" aria-label="${escapeHtml(g.title)}"><h4 class="source">${escapeHtml(g.title)}</h4><ol class="candidates">${g.items.join('')}</ol></section>`).join('');
}
/** What a looked-up candidate adds: far or not, the service's own figures (as its own), and its source's licence. */
function gazetteerHtml(c) {
  const l = lookupOf(c.lookup), g = c.gazetteer || {}, service = l ? shortName(l.service) : LW.whg;
  const km = l?.parameters?.maxDistanceKm ?? 50;
  const lic = licenceOf(l?.attribution ?? null, g.namespace ?? null);
  return (c.far ? `<p class="far">${escapeHtml(LW.far(km))}</p>` : '')
    + (LW.figures(g, service) ? `<p class="gazetteer">${escapeHtml(LW.figures(g, service))}</p>` : '')
    + (g.description ? `<p class="gazetteer">${escapeHtml(LW.described(service, g.description))}</p>` : '')
    + `<p class="licence${LW.licenceWarns(lic) ? ' warn' : ''}">${escapeHtml(LW.licence(lic))}</p>`;
}
/** The sources the attestations would cite, one per source (identity.js candidateSource, as Finish uses). */
function citedSources() {
  const out = new Map();
  for (const c of work.candidates) {
    if (!c.decision || c.decision.kind === 'not-this') continue;
    const s = candidateSource(work, c);
    out.set(s.title + '\n' + (s['@id'] || ''), s);
  }
  return [...out.values()];
}

$('review-place').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-look]'); if (!b) return;
  const iri = order[cursor], look = b.dataset.look;
  if (look === 'find') { findFor = iri; basisFor = null; render(); }
  else if (look === 'cancel') { findFor = null; render(true); }
  else if (look === 'names') lookUp({ only: [iri], allNames: true });
  else if (look === 'again') lookUp({ only: [iri] });
});
$('review-place').addEventListener('submit', (e) => {
  if (!e.target.matches('form.find-form')) return;
  e.preventDefault();
  const query = $('find-query').value.trim(), iri = order[cursor];
  if (!query) return $('find-query').focus();
  findFor = null;
  lookUp({ only: [iri], query });
});
$('lookup').addEventListener('toggle', () => { if ($('lookup').open) { fillChoices(); refreshPreview(); } });
$('lookup').addEventListener('change', (e) => {
  if (e.target.id === 'whg-token') return commitToken();
  if (e.target.name === 'lookup-service') document.querySelector('.lookup-other').hidden = e.target.value !== 'other';
  refreshPreview();
});
$('lookup').addEventListener('input', (e) => { if (e.target.type === 'number' || e.target.type === 'url' || e.target.id === 'lookup-iri') refreshPreview(); });
// Forget: the shared lookup sends no token from its next request, and the keeper forgets it.
$('whg-forget').onclick = () => { $('whg-token').value = ''; whgLookup().clearToken(); whgToken.forget(); lookupSay(LW.forgotten); };
// A token given or forgotten (here, or by Chora through the same keeper) goes to the shared lookup.
whgToken.onChange(() => { showTokenState(); passToken(); });
showTokenState();
passToken();
$('lookup-send').onclick = () => lookUp();
$('lookup-stop').onclick = () => looking?.abort();
$('lookup-resume').onclick = () => { $('lookup-resume').hidden = true; if (afterStop) lookUp({ which: 'pending' }); };
startWorker();
