// The page: choose files, check or convert them, or compare them with an earlier version; show
// progress and the report, save the output.
// The work happens in a worker (src/engine/worker.js). The page publishes its own state on
// window.__plato for automated tests; nothing else reads it.
import { fmtBytes, formatName, progressText, summary, groups, draftNote, explainedLines } from './engine/words.js';
import { COLUMN_CHOICES, COLUMN_WORDS, columnWarnings, columnProblem } from './engine/words.js';
import { review as W } from './engine/words.js';
import { readable } from './engine/input.js';
import { readWork, serialiseWork, decide, reviewPlaces, candidatesOf, isReviewed, reviewProgress, filesDiffer, checkReviewer, checkMatchOptions } from './engine/krisis/work.js';
import { stash as stashForChora } from './chora/handoff.js';
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
  document.querySelector('[data-for="tables-input"]').hidden = inp.format !== 'tables';
  // Hermes: a table of places shows which column holds what before it is run, and the web address
  // its place ids are made under.
  document.querySelector('[data-for="generic-input"]').hidden = !isTable(inp);
  // Every detection makes any answer about the columns of an earlier file stale, a table or not.
  columns = null; state.columns = null; columnsAsked++;
  if (isTable(inp)) { document.querySelector('[data-for="tables-input"]').hidden = false; requestColumns(); }
  $('action').hidden = false;
  Object.assign(state, { phase: 'detected', format: inp.format, profile: inp.profile || null });
  storageCheck();
}
async function storageCheck() {
  const w = $('storage-warning');
  try {
    const { quota } = await navigator.storage.estimate();
    const size = files.reduce((n, f) => n + f.size, 0);
    const gz = /\.gz$/i.test(files[0]?.name || '');
    const need = size * (gz ? 40 : 4);   // room for the working database and the output, generously
    w.hidden = quota > need;
    if (!w.hidden) w.textContent = `This browser allows the page only ${fmtBytes(quota)} of storage, which may not be enough for this file. A private window keeps its storage in memory and allows very little; for large files, use an ordinary window.`;
  } catch { w.hidden = true; }
}

const buttons = (disabled) => { for (const id of ['check', 'convert', 'compare', 'publish', 'match', 'resume', 'finish']) $(id).disabled = disabled; };
function start(action, earlier) {
  if (busy || !input?.format || input.reason !== undefined) return;
  busy = true;
  const target = action === 'convert' ? $('target').value : null;
  $('progress').hidden = false; $('result').hidden = true;
  buttons(true);
  $('phase').textContent = 'Starting…';
  Object.assign(state, { phase: 'running', action, target, report: null, outputs: null, error: null });
  const base = $('base').value.trim() || undefined;
  // Krisis: a review on the page is put away (and its keys with it) while anything but its own finishing runs.
  if (action !== 'apply') $('review').hidden = true;
  // The version check: the files chosen are the later version, and `earlier` the one it is compared with.
  if (action === 'compare') worker.postMessage({ cmd: 'compare', earlier, later: files, options: { base } });
  else if (action === 'publish') onlyKeys().then(
    (only) => worker.postMessage({ cmd: 'publish', part: $('part').value, files, previous: [...$('previous').files], options: { base, ...publishOptions(), only } }),
    (e) => fail(`the list of places to include could not be read (${e.message || e}).`));
  // Match review (Krisis): the files chosen are the subjects, and `earlier` the other dataset; to finish, the review is applied to them.
  // A table of places is matched by the matching of its columns shown, as chosen (Hermes), which the work file keeps for finishing.
  else if (action === 'match') worker.postMessage({ cmd: 'match', subjects: files, others: earlier, options: { ...matchOptions(), base, ...(isTable(input) && columns ? { columns: { ...columns.mapping } } : {}) } });
  // The title in the options is cited only when the review has none but a file's name: one left there from an earlier match must not replace the review's own.
  else if (action === 'apply') worker.postMessage({ cmd: 'apply', subjects: files, work, options: { output: earlier, reviewer: reviewer(), othersTitle: work.others?.titleFrom === 'file-name' ? matchOptions().othersTitle : undefined, base } });
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
function fail(message) {
  busy = false;
  buttons(false);
  $('progress').hidden = true; $('result').hidden = false;
  $('summary').innerHTML = `<span class="warn">Something went wrong: ${escapeHtml(message)}</span>`;
  $('saves').innerHTML = ''; $('report').innerHTML = '';
  Object.assign(state, { phase: 'error', error: message });
}
// ---- Hermes: which column of a table of places holds what -------------------------------------------
// The worker reads the columns and guesses (src/engine/hermes/columns.js); the page shows the guess,
// one choice for each column, with three examples and the reason for the guess, and the run is given
// the matching as it stands. The matching can be saved as JSON and loaded again.
let columns = null, columnsAsked = 0, columnsFrom;
const isTable = (inp) => inp?.format === 'csv' || inp?.format === 'geojson';
function requestColumns(saved, from) {
  const id = ++columnsAsked;
  if (saved === undefined) $('columns').innerHTML = `<h3 id="columns-h">${COLUMN_WORDS.heading}</h3><p>${COLUMN_WORDS.looking}</p>`;
  columnsFrom = from;
  worker.postMessage({ cmd: 'columns', id, files, saved });
}
function onColumns(d) {
  if (d.id !== columnsAsked) return;                    // an answer about a file no longer chosen
  const W = COLUMN_WORDS;
  if (d.error) {
    $('columns').innerHTML = `<h3 id="columns-h">${W.heading}</h3><p class="warn">${escapeHtml(W.cannotRead(d.error))}</p>`;
    state.columns = { error: d.error };
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
  const a = e.target.closest('a[href="./chora.html"]');
  if (!a || !files.length || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
  e.preventDefault();
  await stashForChora(files);
  location.href = a.href;
});
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
$('cancel').onclick = () => { worker.terminate(); busy = false; $('progress').hidden = true; buttons(false); Object.assign(state, { phase: 'cancelled' }); startWorker(); };
// Matching asks for the other dataset, and starts once it is chosen; resuming asks for a saved review.
// Options that matching would refuse are said plainly first, before the other dataset is asked for.
$('match').onclick = () => { const problem = matchProblem(); if (problem) return refuse(problem); $('others').click(); };
$('others').onchange = (e) => { const others = [...e.target.files]; e.target.value = ''; if (others.length) start('match', others); };
$('resume').onclick = () => $('workfile').click();
$('workfile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) resume(f); };
$('target').onchange = () => { document.querySelector('[data-for="ntriples-output"]').hidden = $('target').value !== 'ntriples'; };

// Krisis: match review. One subject place at a time, with its candidates; each decision is written
// into the work object at once (decide() in engine/krisis/work.js), which "Save the review" saves
// and Finish hands to the engine to make the attestations.
let work = null, workName = 'review.krisis.json', order = [], cursor = 0, current = 0, basisFor = null, allDone = false;
const REVIEWER_KEY = 'plato-tools.reviewer';
function remembered() { try { return JSON.parse(localStorage.getItem(REVIEWER_KEY)) || {}; } catch { return {}; } }
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
  try { const differ = await filesDiffer(w.subjects, files); showWarning(differ.length ? W.differs(differ) : ''); } catch { showWarning(''); }
}
function beginReview(w, name) {
  work = w; workName = name || workName; basisFor = null; allDone = false;
  order = reviewPlaces(work);
  cursor = Math.min(Math.max(0, work.cursor || 0), Math.max(0, order.length - 1));
  // A place with no candidates has nothing to review: start at the first that has some.
  if (order.length && !candidatesOf(work, order[cursor]).length) cursor = Math.max(0, order.findIndex((iri) => candidatesOf(work, iri).length));
  if (!work.reviewer?.name && !reviewer()) { const r = remembered(); $('reviewer').value = r.name || ''; $('orcid').value = r.orcid || ''; }
  if (work.reviewer?.name && !reviewer()) { $('reviewer').value = work.reviewer.name; $('orcid').value = work.reviewer.orcid || ''; }
  $('review').hidden = false; showWarning('');
  askName(!reviewer() && order.length > 0);
  goTo(cursor);
}
function showWarning(text) { $('review-warning').textContent = text; $('review-warning').hidden = !text; }
function askName(show, why) {
  const f = $('review-who'); f.hidden = !show;
  if (show) { $('review-name').value = $('reviewer').value; if (why) showWarning(why); $('review-name').focus(); }
}
const undecided = (iri) => candidatesOf(work, iri).findIndex((c) => !c.decision);
// A place still to decide has candidates, none of them decided; one with no candidates has nothing to decide.
const toDecide = (iri) => !isReviewed(work, iri) && candidatesOf(work, iri).length > 0;
function goTo(i) {
  cursor = i; basisFor = null;
  const u = order.length ? undecided(order[cursor]) : -1;
  current = u < 0 ? 0 : u;
  render(true);
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
  if (!order.length) { box.innerHTML = `<p>${escapeHtml(W.none)}</p>`; return; }
  const iri = order[cursor], place = work.places[iri] || {}, cands = candidatesOf(work, iri);
  box.innerHTML = (allDone ? `<p class="good">${escapeHtml(W.allDone)}</p>` : '')
    + `<div class="subject"><h3 id="review-subject">${escapeHtml(place.label || iri)}</h3>`
    + (W.names(place.label, place.names) ? `<p>${escapeHtml(W.names(place.label, place.names))}</p>` : '')
    + `<p>${escapeHtml(W.point(place.point))}</p><p class="iri">${escapeHtml(iri)}</p></div>`
    + `<p>${escapeHtml(W.candidates(cands.length))}</p><ol class="candidates">`
    + cands.map((c, i) => candidateHtml(c, i)).join('') + '</ol>';
  if (basisFor) { $('basis-input')?.focus(); return; }
  if (!$('review-who').hidden) { $('review-name').focus(); return; }   // while the name is asked, it keeps the focus
  if (focus) box.focus({ preventScroll: false });
}
function candidateHtml(c, i) {
  const o = c.other || (Object.hasOwn(work.places, c.candidate_candidate) ? work.places[c.candidate_candidate] : {}), d = c.decision, id = escapeHtml(c.id);
  const btn = (act, text, key) => `<button type="button" data-act="${act}" data-id="${id}" aria-pressed="${d?.kind === act}">${text}${i === current && key ? ` <kbd>${key}</kbd>` : ''}</button>`;
  return `<li class="candidate${i === current ? ' current' : ''}${d ? ' decided' : ''}" data-id="${id}"${i === current ? ' aria-current="true"' : ''}>`
    + `<h4><span class="n">${i + 1}</span>${escapeHtml(o.label || c.candidate_candidate)}</h4>`
    + (W.names(o.label, o.names) ? `<p>${escapeHtml(W.names(o.label, o.names))}</p>` : '')
    + `<p class="facts">${escapeHtml(W.facts(c))}; ${escapeHtml(W.point(o.point))}</p>`
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
  const basis = $('basis-input').value.trim();
  if (!basis) { $('basis-warn').hidden = false; $('basis-input').focus(); return; }
  decideOn(e.target.dataset.id, 'distinct', basis);
});
$('review-place').addEventListener('keydown', (e) => { if (e.key === 'Escape' && basisFor) { basisFor = null; render(true); } });
// The keys act only while the review is shown, and never while typing (or choosing from a list).
document.addEventListener('keydown', (e) => {
  if ($('review').hidden || busy || !work || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
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
{ const r = remembered(); $('reviewer').value = r.name || ''; $('orcid').value = r.orcid || ''; }
$('save-review').onclick = () => {
  if (!work) return;
  const problem = reviewerProblem(); if (problem) return showWarning(problem);
  work.cursor = cursor;
  const who = reviewer(); if (who) work.reviewer = who;
  saveBlob(new Blob([serialiseWork(work)], { type: 'application/json' }), workName);
  Object.assign(state, { reviewSaved: workName });
};
$('finish').onclick = () => {
  if (!work) return;
  if (!readable(input)) return showWarning(files.length ? W.notRecognisedYet : W.noDataset);
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
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
startWorker();
